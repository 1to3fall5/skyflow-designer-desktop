/**
 * Pen tool geometry — a path whose tangent becomes the flow direction.
 *
 * A brush stroke's direction is whatever your hand happened to do. That is
 * right for dabbing and wrong for the thing a flowmap needs most: a long, even
 * sweep across a sky, with the flow turning gradually along it. Dragging that
 * out by hand is the hardest stroke there is, and it is the one the pen makes
 * trivial — you place a few anchors and the curve is exact.
 *
 * Nothing here talks to the engine. The path is flattened to a polyline of UV
 * samples and handed to the *same* `stroke` command the brush uses, because a
 * polyline is already the engine's unit of work: it derives the flow vector
 * from each segment's direction of travel, so a path's tangent needs no new
 * plumbing at all.
 *
 * Everything is pure and in UV space (0..1, v down) — the space the engine's
 * `stroke` takes and the space the 2D canvas reports. No DOM, so it is testable
 * without a browser.
 */

/**
 * A committed path.
 *
 * The whole point of the pen: *this* is the object, and the pixels are only a
 * rendering of it. Keeping the anchors (and the brush they were drawn with)
 * around after the path is stamped is what makes it revisable — move an anchor
 * a week later and the flow re-renders, instead of you having to erase and
 * draw it again by hand and hope the second attempt matches.
 *
 * Mirrors `engine::path::PathData` field for field; the engine rasterises from
 * its copy and this one draws the overlay, so they must not drift.
 */
export interface PathData {
  anchors: Anchor[];
  closed: boolean;
  /** Brush radius in canvas pixels. */
  size: number;
  hardness: number;
  strength: number;
}

/** The brush part of a path — what you can still change after committing. */
export type PathBrush = Pick<PathData, 'size' | 'hardness' | 'strength'>;

/** An anchor, plus the offset of its outgoing handle. */
export interface Anchor {
  x: number;
  y: number;
  /**
   * Outgoing handle, as an *offset* from the anchor. `(0, 0)` means "smooth":
   * the tangent is derived from the neighbours, so the curve re-flows as you
   * add points instead of committing to a shape you cannot revise.
   *
   * The incoming handle is the mirror of this one. That is what makes dragging
   * one handle bend both sides of the anchor, which is the gesture everyone
   * who has used a pen tool expects.
   */
  hx: number;
  hy: number;
}

/** Four control points: P0, P1, P2, P3. */
export type Cubic = [[number, number], [number, number], [number, number], [number, number]];

/** How close, in screen pixels, a click has to be to the first anchor to close. */
export const CLOSE_PX = 10;

/** Samples are this far apart on a path of ordinary length. */
const STEP_PX = 1.5;

/**
 * Ceiling on the samples one path may produce.
 *
 * A path all the way around a 2048 canvas at 1.5px is ~4000 points, which is a
 * needlessly large IPC payload for a shape that has not got any more detail in
 * it. Past this the step simply gets coarser: the *shape* is unchanged, only
 * the spacing of the stamps along it.
 */
const MAX_POINTS = 2400;

function len(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/**
 * Catmull-Rom tangent at `i`, divided by 3 so it can be used directly as a
 * Bezier control offset.
 *
 * The /6 (not /2) is the point: Catmull-Rom velocity is `(next - prev) / 2`,
 * and the Bezier control point sits a third of that away from the anchor.
 * Doing the division once here keeps `controlPoints` a one-liner.
 */
export function autoHandle(a: Anchor[], i: number, closed: boolean): { hx: number; hy: number } {
  const n = a.length;
  const p = a[i];
  if (n < 2) return { hx: 0, hy: 0 };
  if (!closed) {
    // Ends have only one neighbour, so they get the full chord rather than a
    // centred difference — otherwise the curve would start by doubling back.
    if (i === 0) return { hx: (a[1].x - p.x) / 3, hy: (a[1].y - p.y) / 3 };
    if (i === n - 1) return { hx: (p.x - a[n - 2].x) / 3, hy: (p.y - a[n - 2].y) / 3 };
  }
  const prev = a[(i - 1 + n) % n];
  const next = a[(i + 1) % n];
  return { hx: (next.x - prev.x) / 6, hy: (next.y - prev.y) / 6 };
}

/** The handle actually used: explicit if the anchor has one, else derived. */
export function outHandle(a: Anchor[], i: number, closed: boolean): { hx: number; hy: number } {
  const p = a[i];
  if (p.hx !== 0 || p.hy !== 0) return { hx: p.hx, hy: p.hy };
  return autoHandle(a, i, closed);
}

/** Cubic Bezier for the segment leaving anchor `i` towards anchor `j`. */
export function controlPoints(a: Anchor[], i: number, j: number, closed: boolean): Cubic {
  const p0 = a[i];
  const p3 = a[j];
  const h0 = outHandle(a, i, closed);
  const h1 = outHandle(a, j, closed);
  return [
    [p0.x, p0.y],
    [p0.x + h0.hx, p0.y + h0.hy],
    // Incoming control is the mirror of `j`'s outgoing one, so a dragged
    // handle bends the curve on both sides of its anchor.
    [p3.x - h1.hx, p3.y - h1.hy],
    [p3.x, p3.y],
  ];
}

/** Every segment of the path, in order. */
export function segments(a: Anchor[], closed: boolean): Cubic[] {
  const n = a.length;
  if (n < 2) return [];
  const count = closed ? n : n - 1;
  const out: Cubic[] = [];
  for (let s = 0; s < count; s++) out.push(controlPoints(a, s, (s + 1) % n, closed));
  return out;
}

export function cubicAt(c: Cubic, t: number): [number, number] {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [
    c[0][0] * w0 + c[1][0] * w1 + c[2][0] * w2 + c[3][0] * w3,
    c[0][1] * w0 + c[1][1] * w1 + c[2][1] * w2 + c[3][1] * w3,
  ];
}

/** Sum of the control polygon's legs — a cheap upper bound on arc length. */
function polyLength(c: Cubic): number {
  return (
    len(c[0][0], c[0][1], c[1][0], c[1][1]) +
    len(c[1][0], c[1][1], c[2][0], c[2][1]) +
    len(c[2][0], c[2][1], c[3][0], c[3][1])
  );
}

/**
 * The path as a polyline of UV samples, densest where the curve is busiest.
 *
 * `size` is the canvas edge in pixels, which is what turns a UV step into a
 * pixel step — the engine stamps along these samples, so their spacing is the
 * spacing of the dabs, and a step much bigger than the brush would bead.
 */
export function flattenPath(a: Anchor[], closed: boolean, size: number): Array<[number, number]> {
  const segs = segments(a, closed);
  if (segs.length === 0) return [];

  let total = 0;
  for (const c of segs) total += polyLength(c);
  const stepPx = Math.max(STEP_PX, (total * size) / MAX_POINTS);

  const out: Array<[number, number]> = [];
  for (let s = 0; s < segs.length; s++) {
    const c = segs[s];
    const steps = Math.max(4, Math.min(900, Math.ceil((polyLength(c) * size) / stepPx)));
    // Skip t=0 on every segment but the first: it is the previous segment's
    // end, and a repeated sample would be a zero-length step.
    for (let k = s === 0 ? 0 : 1; k <= steps; k++) out.push(cubicAt(c, k / steps));
  }
  return out;
}

/** Distance between two UV points in pixels, on a view `sizePx` wide. */
export function uvDistPx(ax: number, ay: number, bx: number, by: number, sizePx: number): number {
  return Math.hypot((ax - bx) * sizePx, (ay - by) * sizePx);
}

// ---------------------------------------------------------------------------
// Picking — which part of which path is under the pointer
// ---------------------------------------------------------------------------

/**
 * How close, in screen pixels, the pointer has to be to grab something.
 *
 * Screen, not canvas: an anchor has to be as easy to hit zoomed out as zoomed
 * in, and it is a click target like any other.
 */
export const PICK_PX = 7;

export type PathHit =
  | { pi: number; part: 'anchor'; ai: number }
  /** `sign` is which of the anchor's two handles: +1 the outgoing one. */
  | { pi: number; part: 'handle'; ai: number; sign: 1 | -1 }
  | { pi: number; part: 'body'; seg: number; x: number; y: number };

/** Where a UV point is relative to a path: distance, segment, nearest point. */
export function nearestOnPath(
  p: PathData, u: number, v: number,
): { d: number; seg: number; x: number; y: number } {
  const segs = segments(p.anchors, p.closed);
  let best = { d: Infinity, seg: 0, x: u, y: v };
  if (segs.length === 0) return best;
  // Hit-testing resolution is fixed: the question "is the pointer on this
  // curve" does not get more accurate on a bigger canvas, and flattening at
  // 4096 for every pointer move would be absurd.
  for (let s = 0; s < segs.length; s++) {
    const c = segs[s];
    const steps = 48;
    let px = c[0][0];
    let py = c[0][1];
    for (let k = 1; k <= steps; k++) {
      const [x, y] = cubicAt(c, k / steps);
      const d = segDist(u, v, px, py, x, y);
      if (d < best.d) best = { d, seg: s, x, y };
      px = x;
      py = y;
    }
  }
  return best;
}

/** Distance from a point to a segment, in UV. */
function segDist(ux: number, uy: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(ux - ax, uy - ay);
  let t = ((ux - ax) * dx + (uy - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ux - (ax + t * dx), uy - (ay + t * dy));
}

/**
 * What is under the pointer, if anything.
 *
 * Later paths win: they are drawn last, so they are the ones on top and the
 * ones you meant to grab when two overlap. Within a path, anchors beat handles
 * beat the body — the small, specific target first, or you could never grab an
 * anchor that sits on its own curve.
 */
export function hitPath(paths: PathData[], u: number, v: number, sizePx: number): PathHit | null {
  for (let pi = paths.length - 1; pi >= 0; pi--) {
    const p = paths[pi];
    for (let ai = 0; ai < p.anchors.length; ai++) {
      const a = p.anchors[ai];
      if (uvDistPx(u, v, a.x, a.y, sizePx) <= PICK_PX) return { pi, part: 'anchor', ai };
      if (a.hx !== 0 || a.hy !== 0) {
        if (uvDistPx(u, v, a.x + a.hx, a.y + a.hy, sizePx) <= PICK_PX) {
          return { pi, part: 'handle', ai, sign: 1 };
        }
        if (uvDistPx(u, v, a.x - a.hx, a.y - a.hy, sizePx) <= PICK_PX) {
          return { pi, part: 'handle', ai, sign: -1 };
        }
      }
    }
    const near = nearestOnPath(p, u, v);
    if (near.d * sizePx <= PICK_PX) {
      return { pi, part: 'body', seg: near.seg, x: near.x, y: near.y };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** The same path, every anchor moved by the same UV delta. */
export function translatePath(p: PathData, du: number, dv: number): PathData {
  return {
    ...p,
    anchors: p.anchors.map((a) => ({ ...a, x: a.x + du, y: a.y + dv })),
  };
}

export function withAnchor(p: PathData, ai: number, a: Anchor): PathData {
  const anchors = p.anchors.slice();
  anchors[ai] = a;
  return { ...p, anchors };
}

/**
 * The same path with an anchor inserted after segment `seg`.
 *
 * The new anchor starts with a zero handle — "smooth", so the curve through it
 * is derived from its neighbours. Dropping it in at the point you clicked
 * therefore does not kink the path; it only gives you something to grab.
 */
export function insertAnchor(p: PathData, seg: number, x: number, y: number): PathData {
  const at = Math.min(seg + 1, p.anchors.length);
  const anchors = p.anchors.slice();
  anchors.splice(at, 0, { x, y, hx: 0, hy: 0 });
  return { ...p, anchors };
}

export function removeAnchor(p: PathData, ai: number): PathData {
  if (p.anchors.length <= 2) return p;
  return { ...p, anchors: p.anchors.filter((_, i) => i !== ai) };
}

export function withBrush(p: PathData, brush: Partial<PathBrush>): PathData {
  return { ...p, ...brush };
}
