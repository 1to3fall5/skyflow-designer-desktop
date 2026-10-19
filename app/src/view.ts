/**
 * The 2D view transform — pan and zoom of the flowmap square.
 *
 * Pure, because the one piece of arithmetic here that is easy to get wrong is
 * *zooming about a point that is not the centre*, and that is arithmetic, not
 * DOM. Kept next to `cursor.ts` for the same reason that one exists: both are
 * the geometry of how the artwork sits on the screen.
 *
 * The stage is transformed as `translate(x, y) scale(s)`, in that order, about
 * its own centre — so a point `P` of the artwork lands at
 *
 * ```text
 * screen = C + T + s * (P - C)
 * ```
 *
 * where `C` is the centre the stage would have with no transform at all.
 */

export interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

/** View-scale limits, shared by the wheel and the middle-drag zoom. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 12;

export function clampScale(s: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, s));
}

/** Where a point of the artwork lands on the screen. */
export function project(
  t: ViewTransform, cx: number, cy: number, px: number, py: number,
): { x: number; y: number } {
  return {
    x: cx + t.x + t.scale * (px - cx),
    y: cy + t.y + t.scale * (py - cy),
  };
}

/** Which point of the artwork is under a screen point — the inverse. */
export function unproject(
  t: ViewTransform, cx: number, cy: number, mx: number, my: number,
): { x: number; y: number } {
  return {
    x: cx + (mx - cx - t.x) / t.scale,
    y: cy + (my - cy - t.y) / t.scale,
  };
}

/**
 * The stage's *untransformed* centre, recovered from the box you can measure.
 *
 * A box scaled about its own centre keeps that centre, so what you measure is
 * `C + T` — subtract the translation and there it is. Walking `offsetParent`
 * instead would have to be redone every time the layout changes, and would
 * break the moment the pane moved.
 */
export function stageCentre(
  box: { left: number; top: number; width: number; height: number }, t: ViewTransform,
): { x: number; y: number } {
  return { x: box.left + box.width / 2 - t.x, y: box.top + box.height / 2 - t.y };
}

/**
 * Zoom to `next`, keeping whatever is under `(mx, my)` under `(mx, my)`.
 *
 * Holding the screen point `M` fixed while `s` changes is one line of algebra:
 *
 * ```text
 * T1 = (M - C) * (1 - k) + k * T0        where k = s1 / s0
 * ```
 *
 * `next` is an *absolute* target, not a step from the current scale. That is
 * what makes this idempotent: calling it twice with the same pointer leaves
 * the second call with `k == 1` and so a no-op — which in turn is what lets
 * both the canvas and the pane around it handle the same pointer move without
 * the two compounding.
 */
export function zoomAbout(
  t: ViewTransform, next: number, cx: number, cy: number, mx: number, my: number,
): ViewTransform {
  const s1 = clampScale(next);
  if (Math.abs(s1 - t.scale) < 1e-6) return t;
  const k = s1 / t.scale;
  return {
    x: (mx - cx) * (1 - k) + k * t.x,
    y: (my - cy) * (1 - k) + k * t.y,
    scale: s1,
  };
}
