//! Pixel operations: seamless blur, brush stamping, wind field generation,
//! obstacle disturbance and flood fill. All heavy loops are rayon-parallel.

use rayon::prelude::*;
use crate::engine::buf::{wrap_i, Buf, NEUTRAL};

// ---------------------------------------------------------------------------
// Seamless blur (wrap in X, clamp in Y) — 3 box passes ≈ Gaussian.
// ---------------------------------------------------------------------------

/// Elements per rayon task. Small enough to load-balance, big enough that the
/// per-task overhead does not dominate.
const GRAN: usize = 512;

/// Below this many rows, rayon costs more than the loop it is parallelising.
///
/// A brush rectangle is a few dozen rows; handing that to the thread pool is
/// pure scheduling — measured at ~0.8 ms of overhead for ~16k pixels of work.
pub const PAR_MIN_ROWS: usize = 96;

fn box_pass(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, horizontal: bool) {
    let win = (2 * r + 1) as i32;
    let half = win / 2;
    if horizontal {
        dst.par_chunks_mut(w * 4)
            .zip(src.par_chunks(w * 4))
            .for_each(|(drow, srow)| {
                for c in 0..4usize {
                    // initial window centred on x = 0
                    let mut sum = 0i32;
                    for k in -(r as i32)..=(r as i32) {
                        sum += srow[wrap_i(k as isize, w) * 4 + c] as i32;
                    }
                    for x in 0..w {
                        // round, not truncate: six passes of truncation bias the
                        // whole buffer downwards, and the unpremultiply at the
                        // end of `blur` multiplies that bias back up.
                        drow[x * 4 + c] = ((sum + half) / win) as u8;
                        let out = srow[wrap_i(x as isize - r as isize, w) * 4 + c] as i32;
                        let inc = srow[wrap_i(x as isize + r as isize + 1, w) * 4 + c] as i32;
                        sum += inc - out;
                    }
                }
            });
    } else {
        // Vertical pass. The sliding window runs down the *columns*, so the
        // accumulator has to advance with y — which means the row loop is
        // sequential and only the columns are parallel.
        //
        // (Sliding it with x instead, as this used to do, writes
        // `mean(rows y-r+x .. y+r+x)` into column x: a diagonal smear that
        // turns every blurred layer and every obstacle disturbance into noise.)
        let stride = w * 4;
        let mut sum = vec![0i32; stride];
        for k in -(r as i32)..=(r as i32) {
            let sy = (k).clamp(0, h as i32 - 1) as usize;
            let srow = &src[sy * stride..(sy + 1) * stride];
            sum.par_chunks_mut(GRAN).zip(srow.par_chunks(GRAN)).for_each(|(d, s)| {
                for i in 0..d.len() {
                    d[i] += s[i] as i32;
                }
            });
        }
        for y in 0..h {
            {
                let drow = &mut dst[y * stride..(y + 1) * stride];
                drow.par_chunks_mut(GRAN).zip(sum.par_chunks(GRAN)).for_each(|(d, s)| {
                    for i in 0..d.len() {
                        d[i] = ((s[i] + half) / win) as u8;
                    }
                });
            }
            let y_out = (y as i32 - r as i32).clamp(0, h as i32 - 1) as usize;
            let y_in = (y as i32 + r as i32 + 1).clamp(0, h as i32 - 1) as usize;
            if y_in != y_out {
                let rout = &src[y_out * stride..(y_out + 1) * stride];
                let rin = &src[y_in * stride..(y_in + 1) * stride];
                sum.par_chunks_mut(GRAN)
                    .zip(rout.par_chunks(GRAN))
                    .zip(rin.par_chunks(GRAN))
                    .for_each(|((d, o), n)| {
                        for i in 0..d.len() {
                            d[i] += n[i] as i32 - o[i] as i32;
                        }
                    });
            }
        }
    }
}

/// Blur a layer buffer. Radius is in pixels.
///
/// Layer buffers are **straight** (non-premultiplied) RGBA — see `buf::Buf` and
/// `blend_over`. Blurring straight data directly drags the RGB of fully
/// transparent pixels (zero, i.e. black) into the semi-transparent fringe, which
/// is exactly what produces a dark halo round a stroke. So: premultiply once,
/// box-blur, unpremultiply once.
/// How far a pixel's blurred value can reach, in pixels.
///
/// `blur` is three box passes of `br`, so a source pixel can influence
/// `3 * br` of its neighbours. The compositor needs this to grow the region it
/// rebuilds: `blend` is pointwise but `blur` is not.
pub fn blur_influence(radius: f32) -> usize {
    let br = ((radius * 0.62).max(1.0)).round() as usize;
    3 * br + 2
}

pub fn blur(src: &Buf, radius: f32) -> Buf {
    let r = radius.round() as usize;
    let (w, h) = (src.w, src.h);
    if r == 0 {
        return src.clone();
    }
    // 3 box passes ≈ gaussian with sigma ≈ r * sqrt(3)/2 ≈ 0.87r
    let br = ((r as f32) * 0.62).max(1.0).round() as usize;

    let n = w * h;
    let mut a = vec![0u8; n * 4];
    a.par_chunks_mut(4).zip(src.data.par_chunks(4)).for_each(|(d, s)| {
        let k = s[3] as f32 / 255.0;
        // round, not truncate: the unpremultiply below divides by alpha, so
        // truncation error would be amplified in the faint outer fringe.
        d[0] = (s[0] as f32 * k + 0.5) as u8;
        d[1] = (s[1] as f32 * k + 0.5) as u8;
        d[2] = (s[2] as f32 * k + 0.5) as u8;
        d[3] = s[3];
    });

    let mut b = vec![0u8; n * 4];
    let mut c = vec![0u8; n * 4];
    for _ in 0..3 {
        box_pass(&a, &mut b, w, h, br, true);
        box_pass(&b, &mut c, w, h, br, false);
        a.copy_from_slice(&c);
    }

    a.par_chunks_mut(4).for_each(|d| {
        let al = d[3] as f32;
        if al > 0.0 {
            let inv = 255.0 / al;
            d[0] = (d[0] as f32 * inv).min(255.0) as u8;
            d[1] = (d[1] as f32 * inv).min(255.0) as u8;
            d[2] = (d[2] as f32 * inv).min(255.0) as u8;
        }
    });
    Buf { w, h, data: a }
}

// ---------------------------------------------------------------------------
// Brush stamping
// ---------------------------------------------------------------------------

pub struct StampStyle {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub erase: bool,
    /// Kept for call-site readability: mask painting writes opaque white.
    /// Both branches behave identically at the pixel level, since the mask's
    /// alpha *is* the payload.
    pub opaque: bool,
    /// Deposit rate: the fraction of the remaining distance to the target that
    /// one full-coverage pass covers. Only used when a stroke accumulator is
    /// supplied — with `None` the stamp writes its own coverage outright.
    pub flow: f32,
}

/// Write `a` as a coverage union with a continuous colour blend. Used for masks
/// (where coverage *is* the payload) and for stamps with no stroke accumulator.
///
/// Taking the max instead of `1-(1-a)^n` is what keeps a stroke smooth: source-
/// over would let the rim ripple with the pointer sampling period, the "string
/// of beads" look. The max makes the finished stroke equal to a single distance
/// field evaluation over the whole polyline.
///
/// RGB is stored straight (unpremultiplied) — the colour is the direction, the
/// alpha is how strongly it applies. Storing `colour * a` here would make
/// `blend_over` apply the alpha twice and darken the fringe below the neutral
/// 128.
///
/// The colour blend is **continuous**, not winner-take-all. Writing
/// `if a >= prev_a { RGB = colour }` made the winner depend on which side of a
/// 1/255 bucket each stamp landed in, so wherever two stamps had nearly equal
/// coverage the seam shattered into scattered single pixels — the dotted line of
/// saturated specks along a stroke. Weighting the incoming colour by `a` and the
/// existing one by `prev_a * (1 - a)` keeps every case that matters:
///   * empty pixel         -> exactly the colour (no dark fringe)
///   * full-coverage stamp -> exactly the colour (repainting still replaces)
///   * light grazing       -> barely disturbs what is there
/// ...and is smooth in both inputs, which is the point.
#[inline]
fn write_union(d4: &mut [u8], a: f32, style: &StampStyle) {
    let prev_a = d4[3] as f32 / 255.0;
    let w_new = a;
    let w_old = prev_a * (1.0 - a);
    let denom = w_new + w_old;
    if denom > 1e-6 {
        let inv = 1.0 / denom;
        for c in 0..3usize {
            let src = match c {
                0 => style.r,
                1 => style.g,
                _ => style.b,
            } as f32;
            d4[c] = ((src * w_new + d4[c] as f32 * w_old) * inv + 0.5) as u8;
        }
    }
    d4[3] = (a.max(prev_a) * 255.0) as u8;
}

/// Plateau radius as a fraction of the brush radius, for a hardness of 0 and 1.
///
/// The non-zero floor is the point. Blender's paint brushes read as *soft* while
/// still having a solid body: most of the brush is at full strength and only the
/// outer shoulder fades. Mapping hardness straight onto the plateau
/// (`core = radius * hardness`, which is what this used to do) instead turns
/// everything outside `radius * hardness` into a long haze — at hardness 0 the
/// brush never exceeded ~10% opacity anywhere except dead centre.
///
/// In a vector field that is worse than ugly. Where two strokes' haze bands
/// overlap, the 8-bit RG ends up holding a direction that belongs to neither
/// stroke, so the 3D preview shows it as speckled mush along the stroke edges.
pub const CORE_MIN: f32 = 0.40;
const CORE_MAX: f32 = 0.99;

#[inline]
fn core_fraction(hardness: f32) -> f32 {
    CORE_MIN + (CORE_MAX - CORE_MIN) * hardness.clamp(0.0, 1.0)
}

/// Shoulder falloff. `k` is 0 at the rim and 1 at the edge of the full-strength
/// core.
///
/// smootherstep rather than smoothstep: zero first *and* second derivative at
/// both ends, so the shoulder joins the plateau and the untouched background
/// without a Mach band at either seam. A linear ramp is the worst of all — it
/// leaves a visible "dab ring" wherever two stamps overlap.
#[inline]
fn brush_falloff(k: f32) -> f32 {
    let x = k.clamp(0.0, 1.0);
    x * x * x * (x * (x * 6.0 - 15.0) + 10.0)
}

/// Stamp the capsule (lx,ly) -> (x,y) with `radius`.
///
/// Distance-to-segment rather than a train of round dabs, and coverage is a
/// union (see the write-back below), so a finished stroke has the same smooth
/// falloff as one dab no matter how coarsely the pointer was sampled. With dab
/// accumulation the effective alpha would be `1-(1-a)^n`, which sharpens the
/// falloff and makes the spacing between pointer samples show up as scalloped
/// edges.
///
/// `accum` is one byte per pixel, holding the highest weight already deposited
/// **during the current stroke**. Supplying it switches the write-back to
/// Photoshop-style flow: each pass covers a fraction of the remaining distance
/// to the target, so a low-strength brush builds up over repeated strokes
/// instead of capping out at its own value. The engine clears it whenever a new
/// stroke starts, which is what keeps overlap *within* one stroke from
/// compounding — otherwise the middle of a drag would saturate while its ends
/// stayed faint, i.e. the beading problem all over again.
pub fn stamp(
    buf: &mut Buf,
    x: f32, y: f32, lx: f32, ly: f32,
    size: f32, hardness: f32, style: &StampStyle,
    mut accum: Option<&mut [u8]>,
) -> (usize, usize, usize, usize) {
    let w = buf.w as i32;
    let h = buf.h as i32;
    let radius = (size / 2.0).max(0.5);
    // Full-strength core. Capped at `radius - 1` so there is always at least a
    // one-pixel shoulder: a completely hard brush is what produced the
    // hard-edged look in the first place.
    let core = (radius * core_fraction(hardness)).min((radius - 1.0).max(0.0));
    // Never wider than the radius, or a sub-pixel brush would land at half
    // opacity instead of full.
    let span = (radius - core).max(1.0).min(radius);

    let sx = lx;
    let sy = ly;
    let dxs = x - lx;
    let dys = y - ly;
    let len2 = dxs * dxs + dys * dys;

    let pad = radius.ceil() as i32 + 2;
    let bx0 = (lx.min(x)).floor() as i32 - pad;
    let bx1 = (lx.max(x)).ceil() as i32 + pad;
    let by0 = (ly.min(y)).floor() as i32 - pad;
    let by1 = (ly.max(y)).ceil() as i32 + pad;

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    for py in by0..=by1 {
        if py < 0 || py >= h {
            continue;
        }
        let fy = py as f32 + 0.5;
        let drow = py as usize * buf.w * 4;
        for px in bx0..=bx1 {
            let wx = wrap_i(px as isize, buf.w);
            if wx as i32 >= w {
                continue;
            }
            let fx = px as f32 + 0.5;
            let t = if len2 < 1e-9 {
                0.0
            } else {
                (((fx - sx) * dxs + (fy - sy) * dys) / len2).clamp(0.0, 1.0)
            };
            let qx = fx - (sx + dxs * t);
            let qy = fy - (sy + dys * t);
            let d = (qx * qx + qy * qy).sqrt();
            if d > radius {
                continue;
            }
            let a = brush_falloff((radius - d) / span);
            if a <= 0.0 {
                continue;
            }
            let i = drow + wx * 4;
            let aidx = py as usize * buf.w + wx;
            let d4 = &mut buf.data[i..i + 4];

            // What this stamp is aiming at. Erasing is painting towards
            // "nothing": no coverage. The colour is left alone, exactly as
            // canvas `destination-out` does it — and for the same reason the
            // build-up avoids the colour: fading both would square the decay,
            // so erasing would crawl at half the rate painting builds.
            let tgt_a: f32 = if style.erase { 0.0 } else { 255.0 };

            if style.opaque {
                // ---- mask payload -----------------------------------------
                // Coverage *is* the content, so there is nothing to build up
                // towards; fall through to the plain union write below.
                write_union(d4, a, style);
            } else if let Some(acc) = accum.as_deref_mut() {
                // ---- flow deposit (Photoshop-style) ------------------------
                let w_new = (style.flow * a).clamp(0.0, 1.0);
                let w_prev = acc[aidx] as f32 / 255.0;
                if w_new > w_prev {
                    // The pixel has already been pushed `w_prev` of the way to
                    // the target. `k` is the extra push that lands it at
                    // `w_new`, so the number of times a stroke sweeps a pixel
                    // does not change where it ends up.
                    let k = (w_new - w_prev) / (1.0 - w_prev);
                    let back = 1.0 - k;
                    // Snapshot before the colour write: `write_union` sets alpha
                    // to the coverage union, and lerping *from* that would pin
                    // coverage at the brush's own value however low the flow.
                    let prev_a = d4[3];

                    if !style.erase {
                        // All of the build-up lives in **coverage**, and the
                        // colour is written at its final value straight away.
                        //
                        // Fading the colour towards its target as well would
                        // multiply the two, so the visible strength would go
                        // as `(1-(1-flow)^n)^2`: at flow 0.25 the first pass
                        // lands at ~6% instead of 25%, and you have to scribble
                        // eight times before anything is visible.
                        //
                        // Keeping the direction at full strength does not make
                        // it switch abruptly, because what you see is the
                        // *composite*: `alpha * mine + (1-alpha) * wind`. The
                        // vector rotates from the wind towards the stroke as
                        // coverage builds, which is the whole point.
                        write_union(d4, a, style);
                    }
                    d4[3] = (tgt_a + (prev_a as f32 - tgt_a) * back + 0.5) as u8;
                    acc[aidx] = (w_new * 255.0 + 0.5) as u8;
                }
            } else if style.erase {
                // Straight alpha: the eraser only lowers coverage. Leaving RGB
                // untouched is what canvas `destination-out` amounts to.
                let inv = 1.0 - a;
                d4[3] = (d4[3] as f32 * inv) as u8;
            } else {
                write_union(d4, a, style);
            }
            if px < min_x { min_x = px; }
            if px > max_x { max_x = px; }
            if py < min_y { min_y = py; }
            if py > max_y { max_y = py; }
        }
    }

    if min_x == i32::MAX {
        return (0, 0, 0, 0);
    }
    let cx0 = min_x.max(0) as usize;
    let cy0 = min_y.max(0) as usize;
    let cx1 = (max_x + 1).min(w).max(0) as usize;
    let cy1 = (max_y + 1).min(h).max(0) as usize;
    (cx0, cy0, cx1.saturating_sub(cx0), cy1.saturating_sub(cy0))
}

// ---------------------------------------------------------------------------
// Wind field generation
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Projection {
    Equirectangular,
    Polar,
    Planar,
}

pub fn generate_wind(
    out: &mut Buf,
    direction_deg: f32,
    strength: f32,
    proj: Projection,
    polar_angle_deg: f32,
) {
    let w = out.w;
    let h = out.h;
    let rad = direction_deg.to_radians();
    let wx = rad.sin();
    let wz = rad.cos();
    let step = 0.05f32;
    let s = 15.0 * strength;

    if proj == Projection::Planar {
        let du = wx * step;
        let dv = wz * step;
        let r = (128.0 + (-du * s * 127.0)).clamp(0.0, 255.0).round() as u8;
        let g = (128.0 + (-dv * s * 127.0)).clamp(0.0, 255.0).round() as u8;
        for px in out.data.chunks_exact_mut(4) {
            px[0] = r; px[1] = g; px[2] = 255; px[3] = 255;
        }
        return;
    }

    let polar_rad = polar_angle_deg.to_radians();
    let wf = w as f32;
    let hf = h as f32;

    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        let v = 1.0 - ((y as f32 + 0.5) / hf);
        let phi_pre = ((y as f32 + 0.5) / hf) * std::f32::consts::PI;

        for x in 0..w {
            let u = (x as f32 + 0.5) / wf;
            let i = x * 4;

            let (du, dv) = if proj == Projection::Polar {
                let uc = u - 0.5;
                let vc = v - 0.5;
                let r2 = (uc * uc + vc * vc).sqrt();
                if r2 > 0.5 {
                    row[i] = 128; row[i + 1] = 128; row[i + 2] = 255; row[i + 3] = 255;
                    continue;
                }
                let theta = uc.atan2(vc);
                let phi = (r2 / 0.5) * polar_rad;
                let (sp, cp) = phi.sin_cos();
                let px = sp * theta.sin();
                let py = cp;
                let pz = sp * theta.cos();
                let nx = px + wx * step;
                let ny = py;
                let nz = pz + wz * step;
                let len = (nx * nx + ny * ny + nz * nz).sqrt();
                let (nx, ny, nz) = (nx / len, ny / len, nz / len);
                let n_theta = nx.atan2(nz);
                let nr = (ny.clamp(-1.0, 1.0).acos() / polar_rad) * 0.5;
                ((0.5 + nr * n_theta.sin()) - u, (0.5 + nr * n_theta.cos()) - v)
            } else {
                let (sp, cp) = phi_pre.sin_cos();
                let theta = ((x as f32 + 0.5) / wf) * 2.0 * std::f32::consts::PI;
                let px = sp * theta.sin();
                let py = cp;
                let pz = sp * theta.cos();
                let nx = px + wx * step;
                let ny = py;
                let nz = pz + wz * step;
                let len = (nx * nx + ny * ny + nz * nz).sqrt();
                let (nx, ny, nz) = (nx / len, ny / len, nz / len);
                let next_v = 1.0 - (ny.clamp(-1.0, 1.0).acos() / std::f32::consts::PI);
                let mut n_theta = nx.atan2(nz);
                if n_theta < 0.0 {
                    n_theta += 2.0 * std::f32::consts::PI;
                }
                let mut du = (n_theta / (2.0 * std::f32::consts::PI)) - u;
                if du > 0.5 { du -= 1.0; } else if du < -0.5 { du += 1.0; }
                (du, next_v - v)
            };

            row[i] = (128.0 + (-du * s * 127.0)).clamp(0.0, 255.0).round() as u8;
            row[i + 1] = (128.0 + (-dv * s * 127.0)).clamp(0.0, 255.0).round() as u8;
            row[i + 2] = 255;
            row[i + 3] = 255;
        }
    });
}

// ---------------------------------------------------------------------------
// Obstacle disturbance
// ---------------------------------------------------------------------------

/// `obs_alpha` is a half-resolution alpha plane (lw * lh) of the blurred mask.
///
/// Only `[x0, x1) x [y0, y1)` is touched. The disturbance is a **pointwise**
/// function of the pixel: the gradient and the influence come from the plane,
/// which depends on the mask alone, never on neighbouring output pixels. So a
/// restricted rectangle gives byte-identical results to a full-canvas pass,
/// and the compositor can get away with rebuilding only what changed.
pub fn apply_disturbance(
    target: &mut Buf,
    obs_alpha: &[u8],
    lw: usize,
    lh: usize,
    sample_step: usize,
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
) {
    let w = target.w;
    let ds = w / lw;
    let _ = lh;
    let stride = w * 4;

    let get = |tx: i32, ty: i32| -> f32 {
        let cx = tx.clamp(0, lw as i32 - 1) as usize;
        let cy = ty.clamp(0, lh as i32 - 1) as usize;
        obs_alpha[cy * lw + cx] as f32
    };

    let body = |y: usize, row: &mut [u8]| {
        let ly = (y / ds) as i32;
        for x in x0..x1 {
            let i = x * 4;
            let lx = (x / ds) as i32;
            let alpha = get(lx, ly);
            if alpha < 2.0 {
                continue;
            }
            let cur_r = row[i] as f32;
            let cur_g = row[i + 1] as f32;
            let vx = (128.0 - cur_r) / 128.0;
            let vy = (cur_g - 128.0) / 128.0;
            let speed = (vx * vx + vy * vy).sqrt();
            if speed < 0.01 {
                continue;
            }
            let ss = sample_step as i32;
            let gx = get(lx + ss, ly) - get(lx - ss, ly);
            let gy = get(lx, ly + ss) - get(lx, ly - ss);
            let gl = (gx * gx + gy * gy).sqrt();
            if gl < 0.1 {
                continue;
            }
            let nx = gx / gl;
            let ny = gy / gl;
            let t1x = -ny;
            let t1y = nx;
            let tangent_dot = vx * t1x + vy * t1y;
            let dot_n = vx * nx + vy * ny;
            let slip_vx = vx - dot_n * nx;
            let slip_vy = vy - dot_n * ny;
            let (tx, ty) = if tangent_dot >= 0.0 { (t1x, t1y) } else { (-t1x, -t1y) };
            let forced_vx = tx * speed;
            let forced_vy = ty * speed;
            let alignment = tangent_dot.abs() / speed;
            let split = alignment * alignment;
            let tgt_vx = slip_vx + (forced_vx - slip_vx) * split;
            let tgt_vy = slip_vy + (forced_vy - slip_vy) * split;
            let na = alpha / 255.0;
            let mut influence = (na * 5.0).min(1.0);
            influence = influence * influence * (3.0 - 2.0 * influence);
            let impact = dot_n / speed;
            let mut blend = if impact > 0.0 {
                influence * (1.0 + impact * 0.5)
            } else {
                influence * 0.8
            };
            blend = blend.min(1.0);
            let mut fvx = vx + (tgt_vx - vx) * blend;
            let mut fvy = vy + (tgt_vy - vy) * blend;
            let new_speed = (fvx * fvx + fvy * fvy).sqrt();
            if new_speed > 0.001 {
                let final_speed = new_speed + (speed - new_speed) * split;
                fvx = (fvx / new_speed) * final_speed;
                fvy = (fvy / new_speed) * final_speed;
            }
            row[i] = (128.0 - fvx * 128.0).clamp(0.0, 255.0) as u8;
            row[i + 1] = (128.0 + fvy * 128.0).clamp(0.0, 255.0) as u8;
        }
    };

    let band = &mut target.data[y0 * stride..y1 * stride];
    if y1 - y0 >= PAR_MIN_ROWS {
        band.par_chunks_mut(stride).enumerate().for_each(|(dy, row)| body(y0 + dy, row));
    } else {
        band.chunks_mut(stride).enumerate().for_each(|(dy, row)| body(y0 + dy, row));
    }
}

/// Build the half-resolution blurred alpha plane used by `apply_disturbance`.
pub fn obstacle_alpha_plane(mask: &Buf, dist_factor: f32) -> (Vec<u8>, usize, usize, usize) {
    let ds = 2usize;
    let lw = mask.w / ds;
    let lh = mask.h / ds;

    // downsample alpha with wrap in x
    let mut small = Buf::filled(lw, lh, [0, 0, 0, 0]);
    small.data.par_chunks_mut(lw * 4).enumerate().for_each(|(y, row)| {
        for x in 0..lw {
            let mut acc = 0u32;
            for dy in 0..ds {
                for dx in 0..ds {
                    let sx = wrap_i((x * ds + dx) as isize, mask.w);
                    let sy = (y * ds + dy).min(mask.h - 1);
                    acc += mask.data[(sy * mask.w + sx) * 4 + 3] as u32;
                }
            }
            row[x * 4 + 3] = (acc / (ds * ds) as u32) as u8;
        }
    });

    let radius = (20.0 + dist_factor * 280.0) / ds as f32;
    let blurred = blur(&small, radius);

    let mut plane = vec![0u8; lw * lh];
    plane.par_iter_mut().enumerate().for_each(|(i, p)| {
        *p = blurred.data[i * 4 + 3];
    });
    let sample_step = (radius * 0.2).floor().max(2.0) as usize;
    (plane, lw, lh, sample_step)
}

// ---------------------------------------------------------------------------
// Flood fill (magic wand) against a reference image
// ---------------------------------------------------------------------------

pub fn flood_fill(
    target: &mut Buf,
    reference: &Buf,
    start_x: usize,
    start_y: usize,
    threshold: f32,
    fill: [u8; 3],
    wrap: bool,
) -> (usize, usize, usize, usize) {
    let w = target.w;
    let h = target.h;
    if start_x >= w || start_y >= h {
        return (0, 0, 0, 0);
    }
    let si = (start_y * w + start_x) * 4;
    let tc = [reference.data[si], reference.data[si + 1], reference.data[si + 2]];
    let max_dist = (threshold / 100.0) * 441.0;
    let max_sq = max_dist * max_dist;

    let mut visited = vec![0u8; w * h];
    let mut stack: Vec<usize> = Vec::with_capacity(4096);
    stack.push(si / 4);

    let mut min_x = usize::MAX;
    let mut min_y = usize::MAX;
    let mut max_x = 0usize;
    let mut max_y = 0usize;

    while let Some(p) = stack.pop() {
        if visited[p] != 0 {
            continue;
        }
        visited[p] = 1;
        let idx = p * 4;
        let dr = reference.data[idx] as f32 - tc[0] as f32;
        let dg = reference.data[idx + 1] as f32 - tc[1] as f32;
        let db = reference.data[idx + 2] as f32 - tc[2] as f32;
        if dr * dr + dg * dg + db * db > max_sq {
            continue;
        }
        target.data[idx] = fill[0];
        target.data[idx + 1] = fill[1];
        target.data[idx + 2] = fill[2];
        target.data[idx + 3] = 255;
        let x = p % w;
        let y = p / w;
        if x < min_x { min_x = x; }
        if y < min_y { min_y = y; }
        if x > max_x { max_x = x; }
        if y > max_y { max_y = y; }

        if x > 0 { stack.push(p - 1); } else if wrap { stack.push(p + (w - 1)); }
        if x < w - 1 { stack.push(p + 1); } else if wrap { stack.push(p - (w - 1)); }
        if y > 0 { stack.push(p - w); }
        if y < h - 1 { stack.push(p + w); }
    }

    if min_x == usize::MAX {
        return (0, 0, 0, 0);
    }
    (min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)
}

/// Bilinear upscale used for high-resolution export.
pub fn upscale(src: &Buf, tw: usize, th: usize) -> Buf {
    let mut out = Buf::new(tw, th);
    let sx = src.w as f32 / tw as f32;
    let sy = src.h as f32 / th as f32;
    out.data.par_chunks_mut(tw * 4).enumerate().for_each(|(y, row)| {
        let fy = (y as f32 + 0.5) * sy - 0.5;
        let y0 = fy.floor().clamp(0.0, src.h as f32 - 1.0) as usize;
        let y1 = (y0 + 1).min(src.h - 1);
        let wy = (fy - y0 as f32).clamp(0.0, 1.0);
        for x in 0..tw {
            let fx = (x as f32 + 0.5) * sx - 0.5;
            let x0 = fx.floor().clamp(0.0, src.w as f32 - 1.0) as usize;
            let x1 = (x0 + 1).min(src.w - 1);
            let wx = (fx - x0 as f32).clamp(0.0, 1.0);
            let a = (y0 * src.w + x0) * 4;
            let b = (y0 * src.w + x1) * 4;
            let c = (y1 * src.w + x0) * 4;
            let d = (y1 * src.w + x1) * 4;
            for ch in 0..4 {
                let top = src.data[a + ch] as f32 * (1.0 - wx) + src.data[b + ch] as f32 * wx;
                let bot = src.data[c + ch] as f32 * (1.0 - wx) + src.data[d + ch] as f32 * wx;
                row[x * 4 + ch] = (top * (1.0 - wy) + bot * wy) as u8;
            }
        }
    });
    out
}

pub fn neutral(w: usize, h: usize) -> Buf {
    Buf::filled(w, h, NEUTRAL)
}
