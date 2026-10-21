//! Pixel operations: seamless blur, brush stamping, wind field generation,
//! obstacle disturbance and flood fill. All heavy loops are rayon-parallel.

use rayon::prelude::*;
use crate::engine::buf::{wrap_i, Buf, NEUTRAL};

// ---------------------------------------------------------------------------
// Seamless blur (wrap in X, clamp in Y) — 3 box passes ≈ Gaussian.
// ---------------------------------------------------------------------------

/// Below this many rows, rayon costs more than the loop it is parallelising.
///
/// A brush rectangle is a few dozen rows; handing that to the thread pool is
/// pure scheduling — measured at ~0.8 ms of overhead for ~16k pixels of work.
pub const PAR_MIN_ROWS: usize = 96;

/**
 * A `*mut u8` that is `Send` + `Sync`, so one `&mut [u8]` can be shared by the
 * column-strip tasks of the vertical box pass.
 *
 * Sound because each task writes a *disjoint* byte range of every row —
 * `x0*4 .. x1*4` at `y*stride` — so no two tasks touch the same byte. The
 * borrow checker just cannot express "these columns of every row" as a slice,
 * which is the only reason this is a pointer instead of a `&mut`.
 */
#[derive(Copy, Clone)]
struct StripPtr(*mut u8);
unsafe impl Send for StripPtr {}
unsafe impl Sync for StripPtr {}
impl StripPtr {
    unsafe fn row(&self, off: usize, len: usize) -> &mut [u8] {
        std::slice::from_raw_parts_mut(self.0.add(off), len)
    }
}

/**
 * Wrap into `0..w` without a division.
 *
 * `wrap_i` is `rem_euclid` — an `idiv` — and the horizontal pass calls it
 * twice per pixel *per channel*, which is eight divisions per pixel. Loops
 * rather than one branch because the downsampled obstacle plane can be
 * narrower than the blur radius, so a single add/sub would not always land
 * inside the row; on a real canvas both loops fall straight through.
 */
#[inline]
fn wrap1(v: i32, w: i32) -> usize {
    let mut x = v;
    while x < 0 {
        x += w;
    }
    while x >= w {
        x -= w;
    }
    x as usize
}

fn box_pass(
    src: &[u8],
    dst: &mut [u8],
    w: usize,
    h: usize,
    r: usize,
    horizontal: bool,
    chs: usize,
) {
    let win = (2 * r + 1) as i32;
    let half = win / 2;
    if horizontal {
        // One rayon task per *strip of rows*, not per row. The window slides
        // along x, so rows are the independent unit — but a task per row is
        // ~500 dispatches of a couple of kB each, which is the same scheduler
        // overhead the vertical pass used to pay (see below). At 512² (the
        // obstacle plane) the horizontal passes were most of a plane rebuild.
        // The inner loop is untouched, so the output is byte-identical.
        let rows = ((h / 64).max(4)).min(64);
        let block = rows * w * chs;
        dst.par_chunks_mut(block)
            .zip(src.par_chunks(block))
            .for_each(|(dblk, sblk)| {
                let wi = w as i32;
                let ri = r as i32;
                for (drow, srow) in dblk.chunks_mut(w * chs).zip(sblk.chunks(w * chs)) {
                    for c in 0..chs {
                        // initial window centred on x = 0
                        let mut sum = 0i32;
                        for k in -ri..=ri {
                            sum += srow[wrap1(k, wi) * chs + c] as i32;
                        }
                        for x in 0..w {
                            // round, not truncate: six passes of truncation bias
                            // the whole buffer downwards, and the unpremultiply
                            // at the end of `blur` multiplies that bias back up.
                            drow[x * chs + c] = ((sum + half) / win) as u8;
                            let xi = x as i32;
                            let out = srow[wrap1(xi - ri, wi) * chs + c] as i32;
                            let inc = srow[wrap1(xi + ri + 1, wi) * chs + c] as i32;
                            sum += inc - out;
                        }
                    }
                }
            });
    } else {
        // Vertical pass. The sliding window runs down the *columns*, so the
        // accumulator has to advance with y — which makes each column a
        // sequential chain and means the parallelism has to come from
        // *splitting the columns*, not the rows.
        //
        // (Sliding it with x instead, as this used to do, writes
        // `mean(rows y-r+x .. y+r+x)` into column x: a diagonal smear that
        // turns every blurred layer and every obstacle disturbance into noise.)
        //
        // Cutting by column rather than by row is not cosmetic. The previous
        // version kept one accumulator for the whole row and dispatched a
        // rayon job *per row* — and nested three more inside it — so a 1024²
        // canvas paid ~25k scheduler round trips per pass: measured 20 ms per
        // vertical pass against 1.7 ms for the horizontal one, 90 ms for a
        // blur, which is the whole reason dragging the 模糊 slider crawled.
        // A strip owns `cols × 4` bytes of accumulator, walks all of y once,
        // and costs one dispatch: 0.85 ms at 1024², byte-identical output.
        let stride = w * chs;
        // ~64 strips whatever the canvas, each big enough to be worth a task
        // and small enough that its accumulator stays in L1.
        let strip = ((w / 64).max(8)).min(128);
        let nstrips = (w + strip - 1) / strip;
        let out = StripPtr(dst.as_mut_ptr());
        (0..nstrips).into_par_iter().for_each(|s| {
            let x0 = s * strip;
            let x1 = (x0 + strip).min(w);
            let off = x0 * chs;
            let len = (x1 - x0) * chs;
            let mut sum = vec![0i32; len];
            for k in -(r as i32)..=(r as i32) {
                let sy = (k).clamp(0, h as i32 - 1) as usize;
                let srow = &src[sy * stride + off..sy * stride + off + len];
                for i in 0..len {
                    sum[i] += srow[i] as i32;
                }
            }
            for y in 0..h {
                let drow = unsafe { out.row(y * stride + off, len) };
                for i in 0..len {
                    drow[i] = ((sum[i] + half) / win) as u8;
                }
                let y_out = (y as i32 - r as i32).clamp(0, h as i32 - 1) as usize;
                let y_in = (y as i32 + r as i32 + 1).clamp(0, h as i32 - 1) as usize;
                if y_in != y_out {
                    let ro = &src[y_out * stride + off..y_out * stride + off + len];
                    let ri = &src[y_in * stride + off..y_in * stride + off + len];
                    for i in 0..len {
                        sum[i] += ri[i] as i32 - ro[i] as i32;
                    }
                }
            }
        });
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

// One scratch buffer, recycled across `blur` calls.
//
// `blur` runs every time the 模糊 slider moves, and at 4096² the scratch is
// 67 MB — allocating and zeroing a fresh one per frame cost more than a box
// pass. It is fully overwritten before it is read, so it goes back dirty and
// is reused without being cleared.
thread_local! {
    static SCRATCH: std::cell::RefCell<Vec<u8>> = std::cell::RefCell::new(Vec::new());
}

fn take_scratch(len: usize) -> Vec<u8> {
    SCRATCH.with(|s| {
        let mut v = s.borrow_mut();
        if v.len() < len {
            // Zeroing here is the price of a safe buffer, and it is paid once:
            // every later call finds one already big enough and reuses it.
            *v = vec![0u8; len];
        }
        std::mem::replace(&mut *v, Vec::new())
    })
}

fn give_scratch(v: Vec<u8>) {
    SCRATCH.with(|s| *s.borrow_mut() = v);
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

    // Ping-pong between two buffers. The vertical pass writes straight back
    // into `a`, which is what the next horizontal pass reads — so the result
    // needs no copying and only one scratch buffer exists. The previous
    // version used three and copied the whole image back once per pass: at
    // 4096² that was 3 × 67 MB of pure memcpy on top of the blur itself.
    let mut b = take_scratch(n * 4);
    for _ in 0..3 {
        box_pass(&a, &mut b, w, h, br, true, 4);
        box_pass(&b, &mut a, w, h, br, false, 4);
    }
    give_scratch(b);

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

/// The flowmap encoding of a direction, as a stamp colour.
///
/// One function, because three places write it — the brush, the pen path, and
/// the obstacle disturbance — and a drift between them would mean the same
/// angle reads as a different flow depending on which tool put it there.
///
/// `vx` / `vy` are a *unit* direction of travel in canvas pixels (v down).
/// `strength` is the ceiling: how long the flow vector you are aiming at is,
/// the same job the foreground colour does in Photoshop.
pub fn flow_style(vx: f32, vy: f32, strength: f32) -> StampStyle {
    let range = 127.0 * strength;
    StampStyle {
        r: (128.0 - vx * range).clamp(0.0, 255.0) as u8,
        g: (128.0 + vy * range).clamp(0.0, 255.0) as u8,
        b: 255,
        erase: false,
        opaque: false,
        flow: 1.0,
    }
}

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
fn write_union(d4: &mut [u8], a: f32, style: &StampStyle, erase_acc: Option<&mut u8>) {
    if style.erase {
        erase_union(d4, a, erase_acc);
        return;
    }
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

/// What the eraser does to a mask.
///
/// Two things have to be true at once, and they pull in opposite directions:
///
/// * **Within one stroke, idempotent.** A stroke is a dense row of stamps, so
///   how many of them land on a pixel is a function of pointer sampling rate,
///   not of what the user drew. Counting them would scrub the middle of a slow
///   drag bare while leaving its edges barely touched.
/// * **Across strokes, cumulative.** Going over a spot again has to erase more,
///   or a soft eraser could never finish the job.
///
/// So the stroke's *own* progress is kept in `erase_acc` — the largest coverage
/// this stroke has reached here — and the pixel is moved to
/// `before * (1 - largest) / (1 - previous largest)`, which needs no memory of
/// what the pixel started at because the two ratios cancel. One stroke sweeps
/// a pixel once no matter how densely it is sampled; the next stroke starts
/// from zero and takes it down again.
///
/// A plain `prev * (1 - a)` is the obvious decay and the wrong one: it compounds
/// inside a single stroke. A plain `min(prev, 1 - a)` is idempotent but sticks
/// — after one pass the pixel sits exactly at `1 - a` and no later stroke can
/// move it.
///
/// RGB is left alone, exactly as canvas `destination-out` does it.
#[inline]
fn erase_union(d4: &mut [u8], a: f32, acc: Option<&mut u8>) {
    let prev = d4[3] as f32;
    let Some(slot) = acc else {
        // No per-stroke state: the caller cannot keep this idempotent, so take
        // the plain decay rather than pretending otherwise.
        d4[3] = (prev * (1.0 - a).max(0.0)) as u8;
        return;
    };
    let e_prev = *slot as f32 / 255.0;
    let e = a.max(e_prev);
    *slot = (e * 255.0).min(255.0) as u8;
    let next = if e_prev >= 1.0 {
        0.0
    } else {
        prev * (1.0 - e) / (1.0 - e_prev)
    };
    d4[3] = next.clamp(0.0, 255.0) as u8;
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
                // towards; fall through to the plain union write below, which
                // erases when the style says to.
                //
                // The eraser used to fall through to the *union* write here —
                // which is a `max`, i.e. paint-only — so erasing an obstacle
                // mask painted it instead. The union path has no erase case of
                // its own because it never needed one: this is the branch that
                // handles masks.
                write_union(d4, a, style, accum.as_deref_mut().map(|acc| &mut acc[aidx]));
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
                        write_union(d4, a, style, None);
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
                write_union(d4, a, style, None);
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
/// Downsample factor of the obstacle plane. The mask is blurred at half
/// resolution: the plane is a soft field, and the full-resolution blur cost
/// four times as much for a difference nobody can see.
const OBS_DS: usize = 2;

/// Blur radius of the plane, in *plane* pixels.
fn obs_radius(dist_factor: f32) -> f32 {
    (20.0 + dist_factor * 280.0) / OBS_DS as f32
}

/// How far a change to the mask reaches in the finished plane, in *canvas*
/// pixels.
///
/// An edit moves the plane by the blur's own reach, and `apply_disturbance`
/// then reads the plane one `sample_step` either side of each pixel. Both live
/// in plane pixels, hence the scale back up. This is what lets a mask stroke
/// dirty a rectangle instead of the whole canvas.
pub fn obstacle_influence(dist_factor: f32) -> usize {
    let r = obs_radius(dist_factor);
    let step = (r * 0.2).floor().max(2.0) as usize;
    (blur_influence(r) + step + 1) * OBS_DS
}

pub fn obstacle_alpha_plane(mask: &Buf, dist_factor: f32) -> (Vec<u8>, usize, usize, usize) {
    let ds = OBS_DS;
    let lw = mask.w / ds;
    let lh = mask.h / ds;

    // Downsample alpha with wrap in x. One channel, because the plane is a
    // single number per texel — going through `blur` blurred RGB as well and
    // then threw it away, which is four times the work for nothing.
    let mut small = vec![0u8; lw * lh];
    // Same rule as the horizontal box pass: a strip of rows per task, not one
    // row per task.
    let per_task = ((lh / 64).max(4)).min(64);
    let block = per_task * lw;
    small.par_chunks_mut(block).enumerate().for_each(|(bi, blk)| {
        for (ri, row) in blk.chunks_mut(lw).enumerate() {
            let y = bi * per_task + ri;
            for x in 0..lw {
                let mut acc = 0u32;
                for dy in 0..ds {
                    for dx in 0..ds {
                        let sx = wrap_i((x * ds + dx) as isize, mask.w);
                        let sy = (y * ds + dy).min(mask.h - 1);
                        acc += mask.data[(sy * mask.w + sx) * 4 + 3] as u32;
                    }
                }
                row[x] = (acc / (ds * ds) as u32) as u8;
            }
        }
    });

    let radius = obs_radius(dist_factor);
    let plane = blur_plane(&small, lw, lh, radius);
    let sample_step = (radius * 0.2).floor().max(2.0) as usize;
    (plane, lw, lh, sample_step)
}

/// Three box passes over a single channel — `blur` without the other three.
///
/// The alpha channel of `blur()` is exactly this: the box passes are separable
/// and per-channel, so blurring alpha alone gives byte-identical alpha. The
/// plane only ever reads alpha.
fn blur_plane(src: &[u8], w: usize, h: usize, radius: f32) -> Vec<u8> {
    let r = radius.round() as usize;
    if r == 0 {
        return src.to_vec();
    }
    let br = ((r as f32) * 0.62).max(1.0).round() as usize;
    let mut a = src.to_vec();
    let mut b = vec![0u8; w * h];
    for _ in 0..3 {
        box_pass(&a, &mut b, w, h, br, true, 1);
        box_pass(&b, &mut a, w, h, br, false, 1);
    }
    a
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

/// Box-filter downscale, for layer thumbnails.
///
/// `upscale` point-samples, which is fine when the GPU is going to resample the
/// result anyway, but wrong for a 32px thumbnail of a 1024px canvas: it reads
/// one pixel out of every 1024, so a 4px stroke either disappears entirely or
/// comes out as a dotted line depending on where it lands. Averaging the whole
/// source block is what makes the thumbnail look like the layer.
///
/// Averaged in premultiplied space and un-premultiplied on the way out. The
/// layer-buffer contract is *straight* alpha, and the unpainted area of a paint
/// layer is (0,0,0,0) — averaging straight channels would drag that black into
/// every stroke edge and grey the whole thumbnail out.
pub fn downscale(src: &Buf, tw: usize, th: usize) -> Buf {
    // Nothing to average when the target is not smaller; let the bilinear path
    // handle it rather than dividing by an empty source block.
    if src.w <= tw || src.h <= th {
        return upscale(src, tw, th);
    }
    let mut out = Buf::new(tw, th);
    let sx = src.w as f32 / tw as f32;
    let sy = src.h as f32 / th as f32;
    out.data.par_chunks_mut(tw * 4).enumerate().for_each(|(y, row)| {
        let y0 = (y as f32 * sy) as usize;
        let y1 = ((((y + 1) as f32 * sy) as usize).max(y0 + 1)).min(src.h);
        for x in 0..tw {
            let x0 = (x as f32 * sx) as usize;
            let x1 = ((((x + 1) as f32 * sx) as usize).max(x0 + 1)).min(src.w);
            let (mut r, mut g, mut b, mut a, mut n) = (0f32, 0f32, 0f32, 0f32, 0f32);
            for yy in y0..y1 {
                let base = yy * src.w * 4;
                for xx in x0..x1 {
                    let i = base + xx * 4;
                    let al = src.data[i + 3] as f32 / 255.0;
                    r += src.data[i] as f32 * al;
                    g += src.data[i + 1] as f32 * al;
                    b += src.data[i + 2] as f32 * al;
                    a += al;
                    n += 1.0;
                }
            }
            // Fully transparent output stays (0,0,0,0) — the panel draws a
            // checkerboard behind it, exactly like Photoshop's empty layers.
            if a <= 1e-6 {
                continue;
            }
            let inv = 1.0 / a;
            row[x * 4] = (r * inv).clamp(0.0, 255.0) as u8;
            row[x * 4 + 1] = (g * inv).clamp(0.0, 255.0) as u8;
            row[x * 4 + 2] = (b * inv).clamp(0.0, 255.0) as u8;
            row[x * 4 + 3] = ((a / n) * 255.0).clamp(0.0, 255.0) as u8;
        }
    });
    out
}

pub fn neutral(w: usize, h: usize) -> Buf {
    Buf::filled(w, h, NEUTRAL)
}
