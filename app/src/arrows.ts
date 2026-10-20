/**
 * The arrow overlay's dash — shared by the 2D canvas and the 3D shader.
 *
 * There is no arrowhead any more. What says which way the field runs is the
 * dash marching downstream, not a triangle on the end: in a dense field a head
 * on every segment turns the picture into a picket fence, and it is the one
 * part that cannot animate without looking like the field is sliding.
 *
 * Both views have to agree on the dash, so the numbers live here rather than in
 * either renderer. Everything is in *grid cells*, never in pixels: the 2D grid
 * is measured in canvas pixels and the 3D one in UV, and a rate in pixels made
 * the dashes four times faster at 4096² than at 1024².
 */

/** Ink length of one dash, in cells. A shaft (≤ 0.8 cells) holds about two. */
export const ARROW_DASH_CELLS = 0.16;
/** Gap after each dash, also in cells. */
export const ARROW_DASH_GAP_CELLS = ARROW_DASH_CELLS * 1.15;
/** One dash plus its gap — the distance the pattern repeats over. */
export const ARROW_DASH_PERIOD_CELLS = ARROW_DASH_CELLS + ARROW_DASH_GAP_CELLS;
/** Fraction of a period that is ink. */
export const ARROW_DASH_DUTY = ARROW_DASH_CELLS / ARROW_DASH_PERIOD_CELLS;
/** How far the dashes travel: cells per second at 速度 1. */
export const ARROW_DASH_CELLS_PER_SEC = 2;
