/**
 * Zooming about a point that is not the centre.
 *
 * The whole point of the change: Ctrl + middle drag used to scale about the
 * middle of the image, so the thing you were aiming at slid out from under the
 * cursor. These are the two ways that can still be wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  ZOOM_MAX, ZOOM_MIN, clampScale, project, stageCentre, unproject, zoomAbout,
  type ViewTransform,
} from './view';

const C = { x: 400, y: 300 };

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y];

/** Round-trip a screen point through the transform, so both are exercised. */
const roundTrip = (t: ViewTransform, m: { x: number; y: number }) => {
  const p = unproject(t, C.x, C.y, m.x, m.y);
  return project(t, C.x, C.y, p.x, p.y);
};

describe('project / unproject', () => {
  it('are inverses', () => {
    for (const t of [{ x: 0, y: 0, scale: 1 }, { x: -37, y: 88, scale: 2.5 }]) {
      const m = roundTrip(t, { x: 513, y: 247 });
      expect(m.x).toBeCloseTo(513, 6);
      expect(m.y).toBeCloseTo(247, 6);
    }
  });

  it('leaves the centre alone, whatever the scale', () => {
    // Scaling is about the centre, so the centre only ever moves by `T`.
    for (const s of [0.25, 1, 7]) {
      const p = project({ x: 0, y: 0, scale: s }, C.x, C.y, C.x, C.y);
      expect(p).toEqual({ x: C.x, y: C.y });
    }
  });
});

describe('zoomAbout', () => {
  it('keeps the point under the cursor fixed', () => {
    // Any cursor position, any starting transform: the artwork that was under
    // the pointer must still be under the pointer afterwards.
    const starts: ViewTransform[] = [
      { x: 0, y: 0, scale: 1 },
      { x: 120, y: -60, scale: 3.2 },
      { x: -250, y: 410, scale: 0.4 },
    ];
    for (const t0 of starts) {
      for (const m of [{ x: 400, y: 300 }, { x: 517, y: 122 }, { x: 96, y: 640 }]) {
        for (const next of [0.5, 1, 2, 8]) {
          const t1 = zoomAbout(t0, next, C.x, C.y, m.x, m.y);
          const before = unproject(t0, C.x, C.y, m.x, m.y);
          const after = project(t1, C.x, C.y, before.x, before.y);
          expect(after.x, `x at scale ${next}`).toBeCloseTo(m.x, 4);
          expect(after.y, `y at scale ${next}`).toBeCloseTo(m.y, 4);
        }
      }
    }
  });

  it('does not drag the view when the cursor is on the artwork centre', () => {
    // The artwork's centre is currently at `C + T`, not at `C` — aiming at C
    // itself is aiming at a point off to one side, and holding *that* fixed
    // legitimately moves the view. Only the centre leaves it alone, which is
    // the old behaviour surviving exactly where it is asked for.
    const t = { x: 30, y: -15, scale: 1 };
    const m = project(t, C.x, C.y, C.x, C.y);
    expect(zoomAbout(t, 4, C.x, C.y, m.x, m.y)).toEqual({ ...t, scale: 4 });
  });

  it('is idempotent, so one pointer move cannot be applied twice', () => {
    // The canvas and the pane around it both see the same move; the second
    // call has to find `k == 1`.
    const t0 = { x: 0, y: 0, scale: 1 };
    const t1 = zoomAbout(t0, 3, C.x, C.y, 500, 350);
    const t2 = zoomAbout(t1, 3, C.x, C.y, 500, 350);
    expect(t2).toEqual(t1);
  });

  it('clamps the scale, and still holds the point while it clamps', () => {
    const t = { x: 12, y: 34, scale: 1 };
    const lo = zoomAbout(t, 0.0001, C.x, C.y, 500, 350);
    expect(lo.scale).toBe(ZOOM_MIN);
    // Hitting the limit must not quietly lose the anchor: a clamped step that
    // still moved the view would be drift you cannot undo.
    const held = project(lo, C.x, C.y, ...xy(unproject(t, C.x, C.y, 500, 350)));
    expect(held.x).toBeCloseTo(500, 4);
    expect(held.y).toBeCloseTo(350, 4);
    // Already at the limit: nothing moves at all.
    const at = { x: 12, y: 34, scale: ZOOM_MAX };
    expect(zoomAbout(at, 9999, C.x, C.y, 500, 350)).toEqual(at);
  });

  it('clamps the scale on its own', () => {
    expect(clampScale(-1)).toBe(ZOOM_MIN);
    expect(clampScale(1e9)).toBe(ZOOM_MAX);
    expect(clampScale(2)).toBe(2);
  });
});

describe('stageCentre', () => {
  it('recovers the centre from a box that is already scaled and moved', () => {
    // A 200px stage centred at (400,300), after translate(50,-20) scale(2):
    // it measures 400 across and is centred on C + T = (450, 280), so it
    // starts at (250, 80).
    const t = { x: 50, y: -20, scale: 2 };
    const box = { left: 250, top: 80, width: 400, height: 400 };
    const c = stageCentre(box, t);
    expect(c.x).toBeCloseTo(C.x, 6);
    expect(c.y).toBeCloseTo(C.y, 6);
  });
});
