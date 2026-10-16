import { describe, it, expect } from 'vitest';
import {
  autoHandle, outHandle, controlPoints, segments, cubicAt, flattenPath, uvDistPx,
  hitPath, nearestOnPath, translatePath, withAnchor, insertAnchor, removeAnchor,
  withBrush, PICK_PX,
  type Anchor, type PathData,
} from './pen';

const a = (x: number, y: number, hx = 0, hy = 0): Anchor => ({ x, y, hx, hy });

const path = (anchors: Anchor[], closed = false, size = 12): PathData =>
  ({ anchors, closed, size, hardness: 0.5, strength: 0.8 });

describe('pen handles', () => {
  it('derives the end tangent from the only neighbour it has', () => {
    // A centred difference at an end would need a point that does not exist,
    // and faking one as the anchor itself would make the curve double back.
    const p = [a(0.2, 0.5), a(0.5, 0.5), a(0.8, 0.5)];
    const h = autoHandle(p, 0, false);
    expect(h.hx).toBeCloseTo(0.1, 6); // (0.5 - 0.2) / 3
    expect(h.hy).toBeCloseTo(0, 6);
    const last = autoHandle(p, 2, false);
    expect(last.hx).toBeCloseTo(0.1, 6); // (0.8 - 0.5) / 3
  });

  it('derives an interior tangent from both neighbours', () => {
    const p = [a(0.0, 0.0), a(0.5, 0.5), a(1.0, 0.0)];
    const h = autoHandle(p, 1, false);
    expect(h.hx).toBeCloseTo(1 / 6, 6); // (1.0 - 0.0) / 6
    expect(h.hy).toBeCloseTo(0, 6); // the two ends share a height
  });

  it('wraps the neighbours on a closed path', () => {
    const p = [a(0.0, 0.0), a(1.0, 0.0), a(1.0, 1.0)];
    // Anchor 0's "previous" is anchor 2, so the tangent is not the chord to 1.
    const h = autoHandle(p, 0, true);
    expect(h.hx).toBeCloseTo(0, 6); // next.x - prev.x = 1.0 - 1.0
    expect(h.hy).toBeCloseTo(-1 / 6, 6); // next.y - prev.y = 0.0 - 1.0
  });

  it('prefers an explicit handle over a derived one', () => {
    const p = [a(0.0, 0.0), a(0.5, 0.5, 0.1, 0.2), a(1.0, 0.0)];
    expect(outHandle(p, 1, false)).toEqual({ hx: 0.1, hy: 0.2 });
    // ...and an untouched anchor still gets a derived one.
    expect(outHandle(p, 0, false).hx).toBeCloseTo(1 / 6, 6);
  });

  it('treats a zero handle as "smooth", not as "corner"', () => {
    // A click with no drag must still give a curve. If (0,0) meant "no
    // handles", every plain click would produce a polyline and the tool would
    // only be usable by people who already know to drag.
    const p = [a(0.0, 0.0), a(0.5, 0.5), a(1.0, 0.0)];
    const c = controlPoints(p, 0, 1, false);
    expect(c[1][0]).toBeGreaterThan(c[0][0]);
  });
});

describe('pen segments', () => {
  it('mirrors the incoming control around the anchor', () => {
    // Dragging one handle bends both sides of its anchor, which is the whole
    // gesture everyone who has used a pen tool expects.
    const p = [a(0.0, 0.0), a(1.0, 0.0, 0.25, 0)];
    const c = controlPoints(p, 0, 1, false);
    expect(c[2][0]).toBeCloseTo(1.0 - 0.25, 6);
    expect(c[2][1]).toBeCloseTo(0, 6);
  });

  it('gives an open path one segment fewer than its anchors', () => {
    expect(segments([a(0, 0), a(1, 0), a(1, 1)], false)).toHaveLength(2);
  });

  it('closes the loop back to the first anchor', () => {
    const s = segments([a(0, 0), a(1, 0), a(1, 1)], true);
    expect(s).toHaveLength(3);
    expect(s[2][3][0]).toBeCloseTo(0, 6);
    expect(s[2][3][1]).toBeCloseTo(0, 6);
  });

  it('has no segments until there are two anchors', () => {
    expect(segments([a(0, 0)], false)).toHaveLength(0);
    expect(segments([], false)).toHaveLength(0);
  });
});

describe('flattening', () => {
  it('starts and ends exactly on the anchors', () => {
    const p = [a(0.1, 0.5), a(0.5, 0.2), a(0.9, 0.5)];
    const pts = flattenPath(p, false, 1024);
    expect(pts[0][0]).toBeCloseTo(0.1, 6);
    expect(pts[pts.length - 1][0]).toBeCloseTo(0.9, 6);
  });

  it('spaces samples close enough that the engine never sees a zero step', () => {
    // The engine skips any segment under half a pixel, because a sample with
    // no direction to it is what used to stamp a hard-right speck. Coarse
    // sampling would silently drop most of the path.
    const p = [a(0.1, 0.1), a(0.9, 0.9)];
    const pts = flattenPath(p, false, 1024);
    let min = Infinity;
    for (let i = 1; i < pts.length; i++) {
      min = Math.min(min, uvDistPx(pts[i][0], pts[i][1], pts[i - 1][0], pts[i - 1][1], 1024));
    }
    expect(min).toBeGreaterThan(0.5);
    expect(min).toBeLessThan(4);
  });

  it('caps the sample count so a huge path cannot bloat the IPC payload', () => {
    // Around a 4096 canvas twice over: the shape is unchanged, only the
    // spacing of the stamps along it gets coarser.
    const ring: Anchor[] = [];
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      ring.push(a(0.5 + 0.45 * Math.cos(t), 0.5 + 0.45 * Math.sin(t)));
    }
    const pts = flattenPath(ring, true, 4096);
    expect(pts.length).toBeLessThanOrEqual(2400 + 64);
    expect(pts.length).toBeGreaterThan(500);
  });

  it('follows the curve, not the chord', () => {
    // Anchors at the corners of a right angle with a pulled handle: the
    // midpoint must leave the straight line, or the bezier is not being
    // evaluated at all.
    const p = [a(0.0, 0.0, 0.5, 0), a(1.0, 1.0)];
    const pts = flattenPath(p, false, 1024);
    const mid = pts[Math.floor(pts.length / 2)];
    // The straight line from (0,0) to (1,1) has x === y everywhere.
    expect(Math.abs(mid[0] - mid[1])).toBeGreaterThan(0.001);
  });

  it('returns nothing for a path the engine could not draw', () => {
    expect(flattenPath([a(0.1, 0.1)], false, 1024)).toHaveLength(0);
    expect(flattenPath([], false, 1024)).toHaveLength(0);
  });
});

describe('cubicAt', () => {
  it('pins the endpoints', () => {
    const c = controlPoints([a(0, 0), a(1, 1, 0.2, 0)], 0, 1, false);
    const [x0, y0] = cubicAt(c, 0);
    const [x1, y1] = cubicAt(c, 1);
    expect(x0).toBeCloseTo(0, 6);
    expect(y0).toBeCloseTo(0, 6);
    expect(x1).toBeCloseTo(1, 6);
    expect(y1).toBeCloseTo(1, 6);
  });
});

describe('uvDistPx', () => {
  it('measures in display pixels, not UV', () => {
    // Closing a path is a click, so the radius has to feel the same whether
    // the view is zoomed in or out.
    expect(uvDistPx(0, 0, 1, 0, 800)).toBeCloseTo(800, 6);
    expect(uvDistPx(0, 0, 0.5, 0, 800)).toBeCloseTo(400, 6);
  });
});

// ---------------------------------------------------------------------------
// Picking. Everything a committed path can still be asked to do starts here:
// if the wrong part is under the pointer, editing the path is guesswork.
// ---------------------------------------------------------------------------

describe('hitPath', () => {
  /** A 512-wide view: 7 screen pixels is ~0.0137 UV. */
  const N = 512;

  it('finds an anchor under the pointer', () => {
    const p = path([a(0.2, 0.2), a(0.8, 0.2)]);
    const hit = hitPath([p], 0.2, 0.2, N);
    expect(hit).toEqual({ pi: 0, part: 'anchor', ai: 0 });
  });

  it('misses an anchor just outside the grab radius', () => {
    const p = path([a(0.2, 0.2), a(0.8, 0.2)]);
    // Off the line as well as along it, or the curve between the two anchors
    // would still be under the pointer and the miss would not be a miss.
    expect(hitPath([p], 0.2 + 0.02, 0.2 + 0.05, N)).toBeNull();
  });

  it('prefers the anchor over the curve it sits on', () => {
    // The small, specific target first — otherwise an anchor lying on its own
    // curve could never be grabbed.
    const p = path([a(0.2, 0.5), a(0.8, 0.5)]);
    const hit = hitPath([p], 0.5, 0.5, N);
    expect(hit?.part).toBe('body');
    const onAnchor = hitPath([p], 0.2, 0.5, N);
    expect(onAnchor).toEqual({ pi: 0, part: 'anchor', ai: 0 });
  });

  it('finds the outgoing handle, and knows it from the mirrored one', () => {
    const p = path([a(0.3, 0.5, 0.1, 0), a(0.7, 0.5)]);
    expect(hitPath([p], 0.4, 0.5, N)).toEqual({ pi: 0, part: 'handle', ai: 0, sign: 1 });
    expect(hitPath([p], 0.2, 0.5, N)).toEqual({ pi: 0, part: 'handle', ai: 0, sign: -1 });
  });

  it('reports which segment a body hit landed on, and where', () => {
    // That is what Alt+click needs to insert an anchor in the right place
    // rather than at the end of the list.
    const p = path([a(0.1, 0.5), a(0.5, 0.5), a(0.9, 0.5)]);
    const hit = hitPath([p], 0.7, 0.5, N);
    expect(hit?.part).toBe('body');
    expect(hit && hit.part === 'body' && hit.seg).toBe(1);
    expect(hit && hit.part === 'body' && hit.x).toBeCloseTo(0.7, 2);
  });

  it('takes the later path when two overlap', () => {
    // Later means drawn later, which means on top, which is the one you meant.
    const under = path([a(0.2, 0.5), a(0.8, 0.5)]);
    const over = path([a(0.2, 0.5), a(0.8, 0.5)]);
    expect(hitPath([under, over], 0.5, 0.5, N)?.pi).toBe(1);
  });

  it('returns nothing on empty space', () => {
    expect(hitPath([path([a(0.2, 0.2), a(0.8, 0.2)])], 0.5, 0.9, N)).toBeNull();
    expect(hitPath([], 0.5, 0.5, N)).toBeNull();
  });
});

describe('nearestOnPath', () => {
  it('measures from the curve, not from the chord', () => {
    // A bowed segment whose middle sits at y = 0.375 but whose chord runs along
    // y = 0. Measuring against the chord would put the midpoint of the bow half
    // a UV away from where it actually is.
    const p = path([a(0.0, 0.0, 0.0, 0.5), a(1.0, 0.0, 0.0, -0.5)]);
    const near = nearestOnPath(p, 0.5, 0.5);
    expect(near.y).toBeCloseTo(0.375, 2);
    expect(near.d).toBeCloseTo(0.125, 2);
  });
});

describe('editing a committed path', () => {
  it('translates every anchor by the same delta', () => {
    const p = path([a(0.2, 0.2, 0.05, 0), a(0.8, 0.4)]);
    const moved = translatePath(p, 0.1, -0.05);
    expect(moved.anchors[0].x).toBeCloseTo(0.3, 6);
    expect(moved.anchors[0].y).toBeCloseTo(0.15, 6);
    expect(moved.anchors[1].x).toBeCloseTo(0.9, 6);
    // Handles are offsets, so they travel with the anchor untouched.
    expect(moved.anchors[0].hx).toBeCloseTo(0.05, 6);
    expect(moved.closed).toBe(p.closed);
  });

  it('replaces one anchor without touching its neighbours', () => {
    const p = path([a(0.2, 0.2), a(0.5, 0.5), a(0.8, 0.2)]);
    const next = withAnchor(p, 1, { x: 0.5, y: 0.9, hx: 0.1, hy: 0 });
    expect(next.anchors[1].y).toBeCloseTo(0.9, 6);
    expect(next.anchors[0]).toEqual(p.anchors[0]);
    expect(next.anchors[2]).toEqual(p.anchors[2]);
  });

  it('inserts after the segment you clicked, not at the end', () => {
    const p = path([a(0.1, 0.5), a(0.5, 0.5), a(0.9, 0.5)]);
    const next = insertAnchor(p, 0, 0.3, 0.5);
    expect(next.anchors).toHaveLength(4);
    expect(next.anchors[1].x).toBeCloseTo(0.3, 6);
    // Smooth by default: the new anchor derives its tangent from its
    // neighbours, so dropping it in does not kink the curve.
    expect(next.anchors[1].hx).toBe(0);
    expect(next.anchors[1].hy).toBe(0);
  });

  it('will not shorten a path below two anchors', () => {
    // One anchor is not a path — it has no direction to flow along.
    const p = path([a(0.2, 0.2), a(0.8, 0.2)]);
    expect(removeAnchor(p, 0).anchors).toHaveLength(2);
    const three = path([a(0.2, 0.2), a(0.5, 0.5), a(0.8, 0.2)]);
    expect(removeAnchor(three, 1).anchors.map((n) => n.x)).toEqual([0.2, 0.8]);
  });

  it('retunes the brush without moving a single anchor', () => {
    // The whole point of keeping the brush on the path: one stroke gets wider
    // and the nineteen next to it do not.
    const p = path([a(0.2, 0.2), a(0.8, 0.2)], false, 12);
    const next = withBrush(p, { size: 60, strength: 0.4 });
    expect(next.size).toBe(60);
    expect(next.strength).toBeCloseTo(0.4, 6);
    expect(next.hardness).toBeCloseTo(0.5, 6);
    expect(next.anchors).toEqual(p.anchors);
  });

  it('grabs within PICK_PX regardless of how far the view is zoomed', () => {
    // A click target has to feel the same at 256 as at 4096.
    const p = path([a(0.2, 0.2), a(0.8, 0.2)]);
    const off = (PICK_PX * 0.9) / 1024; // just inside the radius when zoomed in
    expect(hitPath([p], 0.2, 0.2 + off, 1024)?.part).toBe('anchor');
    expect(hitPath([p], 0.2, 0.2 + off * 4, 1024)).toBeNull();
  });
});
