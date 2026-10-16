//! Pen paths: the geometry, and the rasterisation that turns one into flow.
//!
//! A path layer's pixels are *generated* from its paths, the way a wind layer's
//! are generated from a direction and a strength. That is what makes a path
//! non-destructive: the anchors are the object, the pixels are a rendering of
//! them, and re-rendering is a pure function of the anchors. Move an anchor and
//! only the pixels that path covered are recomputed — even months later, even
//! after a save and a reload.
//!
//! The geometry mirrors `app/src/pen.ts` exactly, because the frontend draws
//! the preview from that copy and the engine draws the pixels from this one.
//! If the two ever disagreed the path you see would not be the flow you get,
//! which is a worse bug than either one being slightly wrong.

use serde::{Deserialize, Serialize};

use super::buf::Buf;
use super::ops::stamp;

/// One anchor, plus the offset of its outgoing handle. All in UV (0..1, v down).
#[derive(Clone, Copy, Serialize, Deserialize, Debug, PartialEq)]
pub struct PathAnchor {
    pub x: f32,
    pub y: f32,
    /// `(0, 0)` means "smooth": derive the tangent from the neighbours, so the
    /// curve re-flows as anchors move instead of committing to a shape.
    pub hx: f32,
    pub hy: f32,
}

/// A path and the brush it is drawn with.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct PathData {
    pub anchors: Vec<PathAnchor>,
    pub closed: bool,
    pub size: f32,
    pub hardness: f32,
    pub strength: f32,
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// Samples are this far apart, in canvas pixels, on a path of ordinary length.
const STEP_PX: f32 = 1.5;

/// Ceiling on the samples one path produces. Past this the step just gets
/// coarser: the shape is unchanged, only the spacing of the stamps along it.
const MAX_POINTS: usize = 2400;

fn dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    (dx * dx + dy * dy).sqrt()
}

/// Catmull-Rom tangent at `i`, divided by 3 so it can be used directly as a
/// Bezier control offset.
fn auto_handle(a: &[PathAnchor], i: usize, closed: bool) -> (f32, f32) {
    let n = a.len();
    if n < 2 {
        return (0.0, 0.0);
    }
    let p = a[i];
    if !closed {
        // Ends have one neighbour, so they take the full chord rather than a
        // centred difference — otherwise the curve would start by doubling back.
        if i == 0 {
            return ((a[1].x - p.x) / 3.0, (a[1].y - p.y) / 3.0);
        }
        if i == n - 1 {
            return ((p.x - a[n - 2].x) / 3.0, (p.y - a[n - 2].y) / 3.0);
        }
    }
    let prev = &a[(i + n - 1) % n];
    let next = &a[(i + 1) % n];
    ((next.x - prev.x) / 6.0, (next.y - prev.y) / 6.0)
}

/// The handle actually used: explicit if the anchor has one, else derived.
fn out_handle(a: &[PathAnchor], i: usize, closed: bool) -> (f32, f32) {
    let p = a[i];
    if p.hx != 0.0 || p.hy != 0.0 {
        return (p.hx, p.hy);
    }
    auto_handle(a, i, closed)
}

fn control_points(a: &[PathAnchor], i: usize, j: usize, closed: bool) -> [(f32, f32); 4] {
    let p0 = (a[i].x, a[i].y);
    let p3 = (a[j].x, a[j].y);
    let h0 = out_handle(a, i, closed);
    let h1 = out_handle(a, j, closed);
    // The incoming control is the mirror of `j`'s outgoing one, so dragging a
    // handle bends the curve on both sides of its anchor.
    [
        p0,
        (p0.0 + h0.0, p0.1 + h0.1),
        (p3.0 - h1.0, p3.1 - h1.1),
        p3,
    ]
}

fn cubic_at(c: &[(f32, f32); 4], t: f32) -> (f32, f32) {
    let u = 1.0 - t;
    let w0 = u * u * u;
    let w1 = 3.0 * u * u * t;
    let w2 = 3.0 * u * t * t;
    let w3 = t * t * t;
    (
        c[0].0 * w0 + c[1].0 * w1 + c[2].0 * w2 + c[3].0 * w3,
        c[0].1 * w0 + c[1].1 * w1 + c[2].1 * w2 + c[3].1 * w3,
    )
}

/// Sum of the control polygon's legs — a cheap upper bound on arc length.
fn poly_len(c: &[(f32, f32); 4]) -> f32 {
    dist(c[0], c[1]) + dist(c[1], c[2]) + dist(c[2], c[3])
}

/// The path as a polyline of UV samples.
pub fn flatten(path: &PathData, n: usize) -> Vec<(f32, f32)> {
    let a = &path.anchors;
    let count = if path.closed { a.len() } else { a.len().saturating_sub(1) };
    if a.len() < 2 || count == 0 {
        return Vec::new();
    }
    let segs: Vec<[(f32, f32); 4]> = (0..count)
        .map(|s| control_points(a, s, (s + 1) % a.len(), path.closed))
        .collect();

    let total: f32 = segs.iter().map(poly_len).sum();
    let step_px = STEP_PX.max((total * n as f32) / MAX_POINTS as f32);

    let mut out = Vec::with_capacity(MAX_POINTS);
    for (s, c) in segs.iter().enumerate() {
        let steps = ((poly_len(c) * n as f32) / step_px).ceil().max(4.0).min(900.0) as usize;
        // Skip t=0 on every segment but the first: it is the previous
        // segment's end, and a repeated sample would be a zero-length step.
        for k in (if s == 0 { 0 } else { 1 })..=steps {
            out.push(cubic_at(c, k as f32 / steps as f32));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

/// The bounding box a path covers, in pixels, padded by its own brush.
pub fn bounds(path: &PathData, n: usize) -> Option<(usize, usize, usize, usize)> {
    let pts = flatten(path, n);
    if pts.is_empty() {
        return None;
    }
    let pad = (path.size / 2.0).ceil() as i32 + 3;
    let mut x0 = f32::MAX;
    let mut y0 = f32::MAX;
    let mut x1 = f32::MIN;
    let mut y1 = f32::MIN;
    for (u, v) in &pts {
        x0 = x0.min(*u);
        y0 = y0.min(*v);
        x1 = x1.max(*u);
        y1 = y1.max(*v);
    }
    let x0 = ((x0 * n as f32) as i32 - pad).max(0) as usize;
    let y0 = ((y0 * n as f32) as i32 - pad).max(0) as usize;
    let x1 = (((x1 * n as f32) as i32 + pad).min(n as i32 - 1)).max(0) as usize;
    let y1 = (((y1 * n as f32) as i32 + pad).min(n as i32 - 1)).max(0) as usize;
    if x1 < x0 || y1 < y0 {
        return None;
    }
    Some((x0, y0, x1 - x0 + 1, y1 - y0 + 1))
}

/// Stamp one path into `dst`, returning the pixels it touched.
///
/// No accumulator: a path is drawn once, deliberately, so `flow` does not apply
/// and neither does the "don't compound where a stroke crosses itself" rule —
/// a path *is* one stroke, and `stamp`'s coverage union already handles
/// overlap within it.
pub fn stroke_path(dst: &mut Buf, path: &PathData) -> Option<(usize, usize, usize, usize)> {
    let n = dst.w as f32;
    let pts = flatten(path, dst.w);
    let last = pts.len().saturating_sub(1);
    if pts.len() < 2 {
        return None;
    }

    let mut out: Option<(usize, usize, usize, usize)> = None;
    let mut prev: Option<(f32, f32)> = None;
    for (i, &(u, v)) in pts.iter().enumerate() {
        let (x, y) = (u * n, v * n);
        let (lx, ly) = match prev {
            Some((lu, lv)) => (lu * n, lv * n),
            None => (x, y),
        };
        // Direction of travel. The first sample has none of its own, so look
        // *ahead* along the polyline rather than inventing one — that fake is
        // what used to stamp a saturated speck at the head of every batch.
        let (dx, dy) = match prev {
            Some(_) => (x - lx, y - ly),
            None if i < last => {
                let (nu, nv) = pts[i + 1];
                ((nu - u) * n, (nv - v) * n)
            }
            None => (0.0, 0.0),
        };
        let d = (dx * dx + dy * dy).sqrt();
        if d < 0.5 {
            prev = Some((u, v));
            continue;
        }
        let style = super::ops::flow_style(dx / d, dy / d, path.strength);
        let r = stamp(dst, x, y, lx, ly, path.size, path.hardness, &style, None);
        out = Some(match out {
            Some(o) => merge(o, r),
            None => r,
        });
        prev = Some((u, v));
    }
    out
}

/// Regenerate a path layer's whole buffer from its paths.
pub fn generate_paths(dst: &mut Buf, paths: &[PathData]) {
    dst.data.fill(0);
    for p in paths {
        stroke_path(dst, p);
    }
}

fn intersects(a: (usize, usize, usize, usize), b: (usize, usize, usize, usize)) -> bool {
    a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

/**
 * Re-render the paths that could have changed inside `rect`.
 *
 * Rebuilding the whole layer every frame would be simple, and it is also what
 * makes a drag stop feeling like a drag: twenty paths at 4096 is a 67 MB memset
 * plus twenty thousand stamps, sixty times a second. So start from the rectangle
 * that moved and re-stamp only what can have written to it.
 *
 * The subtlety is *overlap*. A path that misses `rect` can still cross one that
 * hits it, so its pixels sit inside the region being cleared — clearing them
 * without re-stamping it would erase part of a path you did not touch. Hence the
 * loop: the region grows to take in every path it touches, and every path inside
 * the finished region is re-stamped, in order, so later paths still cover
 * earlier ones. A path left out has bounds disjoint from the region, and bounds
 * contain all of a path's pixels, so leaving it out cannot lose any.
 */
pub fn regenerate(dst: &mut Buf, paths: &[PathData], rect: (usize, usize, usize, usize)) {
    let n = dst.w;
    let boxes: Vec<Option<(usize, usize, usize, usize)>> =
        paths.iter().map(|p| bounds(p, n)).collect();

    let mut region = rect;
    let mut keep = vec![false; paths.len()];
    loop {
        let mut grew = false;
        for i in 0..paths.len() {
            if keep[i] {
                continue;
            }
            let Some(b) = boxes[i] else { continue };
            if !intersects(b, region) {
                continue;
            }
            keep[i] = true;
            region = merge(region, b);
            grew = true;
        }
        // One pass can add a path whose own bounds pull in another, so keep
        // going until a pass adds nothing.
        if !grew {
            break;
        }
    }

    clear_rect(dst, region);
    for (p, k) in paths.iter().zip(&keep) {
        if *k {
            stroke_path(dst, p);
        }
    }
}

fn clear_rect(dst: &mut Buf, r: (usize, usize, usize, usize)) {
    let (x, y, w, h) = r;
    let n = dst.w;
    let x1 = (x + w).min(n);
    let y1 = (y + h).min(n);
    for row in y..y1 {
        let off = (row * n + x) * 4;
        dst.data[off..off + (x1 - x) * 4].fill(0);
    }
}

fn merge(
    a: (usize, usize, usize, usize),
    b: (usize, usize, usize, usize),
) -> (usize, usize, usize, usize) {
    if b.2 == 0 || b.3 == 0 {
        return a;
    }
    if a.2 == 0 || a.3 == 0 {
        return b;
    }
    let x0 = a.0.min(b.0);
    let y0 = a.1.min(b.1);
    let x1 = (a.0 + a.2).max(b.0 + b.2);
    let y1 = (a.1 + a.3).max(b.1 + b.3);
    (x0, y0, x1 - x0, y1 - y0)
}
