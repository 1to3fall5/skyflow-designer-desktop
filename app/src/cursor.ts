/**
 * Shared brush-cursor position between the 2D canvas and the 3D preview.
 *
 * Both views publish into the same ref; whichever one the pointer is over wins.
 */

export interface CursorUV {
  u: number;
  v: number;
}

/**
 * Next cursor position for a pointer move.
 *
 * While a brush parameter is being scrubbed (F / Shift+F / Ctrl+F drag) the ring
 * must **stay put and only change size**. If it chased the pointer you could not
 * judge the size you were dialling in — the reference circle would be moving
 * while it grows, and it would end up parked wherever the mouse stopped.
 *
 * Returns the previous position unchanged while adjusting — except when there
 * is no previous position yet, in which case the current one is adopted so the
 * ring actually appears (the OS cursor is hidden during a scrub, so an unplaced
 * ring would leave you with no pointer at all).
 */
export function nextCursor(adjusting: boolean, uv: CursorUV, prev: CursorUV | null): CursorUV | null {
  if (!adjusting) return uv;
  return prev ?? uv;
}

/**
 * Whether to clear the cursor when the pointer leaves a view.
 * Leaving mid-scrub must not make the ring disappear.
 */
export function shouldClearOnLeave(adjusting: boolean): boolean {
  return !adjusting;
}
