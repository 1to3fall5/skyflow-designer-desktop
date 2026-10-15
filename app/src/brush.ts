/**
 * Brush coverage profile — the TypeScript half of the contract.
 *
 * The pixel engine (`src-tauri/src/engine/ops.rs`) owns the authoritative
 * profile; this file only reproduces it so the 2D cursor ring and the 3D shader
 * *show the truth* about what the brush is about to do. If you change one, change
 * all three (ops.rs, here, FlowShader.ts) together — a preview that lies about
 * the falloff is worse than no preview.
 */

/** Fraction of the radius that stays at full strength when hardness = 0. */
export const CORE_MIN = 0.4;
/** ...and when hardness = 1 (never quite 1, or the rim stops being antialiased). */
export const CORE_MAX = 0.99;

/** Plateau radius as a fraction of the brush radius. */
export function coreFraction(hardness: number): number {
  const h = Math.max(0, Math.min(1, hardness));
  return CORE_MIN + (CORE_MAX - CORE_MIN) * h;
}

/** smootherstep: zero first *and* second derivative at both ends. */
export function smootherstep(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Coverage at normalized distance from the centre. `t` is 0 at the centre and
 * 1 at the rim, so this is directly usable against `dist / brushRadius`.
 */
export function coverageAt(t: number, hardness: number): number {
  const core = coreFraction(hardness);
  const k = (1 - t) / Math.max(1 - core, 1e-4);
  return smootherstep(k);
}

/** Peak alpha of the 2D ring's inner gradient (`.paint-cursor-inner`). */
export const RING_PEAK_ALPHA = 0.92;

/**
 * A CSS radial-gradient that mirrors the engine's falloff, so scrubbing
 * Shift+F shows the real shoulder width instead of a stand-in linear ramp.
 *
 * A multi-stop approximation is needed because CSS gradients interpolate
 * linearly between stops and cannot express a smootherstep.
 */
export function brushGradient(hardness: number, peakAlpha = RING_PEAK_ALPHA, steps = 12): string {
  const core = coreFraction(hardness);
  const stops = [`rgba(255,255,255,${peakAlpha}) 0%`];
  for (let i = 0; i <= steps; i++) {
    const t = core + (1 - core) * (i / steps);
    const a = coverageAt(t, hardness) * peakAlpha;
    stops.push(`rgba(255,255,255,${a.toFixed(3)}) ${(t * 100).toFixed(2)}%`);
  }
  return `radial-gradient(circle closest-side, ${stops.join(', ')})`;
}
