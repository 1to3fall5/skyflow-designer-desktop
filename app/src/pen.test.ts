import { describe, it, expect } from 'vitest';
import {
  autoHandle, outHandle, controlPoints, segments, cubicAt, flattenPath, uvDistPx,
  type Anchor,
} from './pen';

const a = (x: number, y: number, hx = 0, hy = 0): Anchor => ({ x, y, hx, hy });

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
