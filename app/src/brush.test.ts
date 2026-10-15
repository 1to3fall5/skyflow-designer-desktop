/**
 * The brush profile exists three times: engine/ops.rs (authoritative),
 * src/brush.ts (this file), and FlowShader.ts (GLSL). These tests pin the
 * shape so at least the frontend half cannot drift silently.
 */
import { describe, it, expect } from 'vitest';
import {
  CORE_MIN,
  CORE_MAX,
  coreFraction,
  smootherstep,
  coverageAt,
  brushGradient,
  RING_PEAK_ALPHA,
} from './brush';

describe('core fraction', () => {
  it('never collapses to zero, even at hardness 0', () => {
    // `core = radius * hardness` was the old mapping: at hardness 0 the brush
    // had no solid body at all, just a long haze. Blender's soft brushes keep a
    // plateau.
    expect(coreFraction(0)).toBeCloseTo(CORE_MIN, 6);
    expect(CORE_MIN).toBeGreaterThanOrEqual(0.35);
  });

  it('stops just short of the rim at hardness 1', () => {
    // A full-radius plateau would leave no room for antialiasing.
    expect(coreFraction(1)).toBeCloseTo(CORE_MAX, 6);
    expect(CORE_MAX).toBeLessThan(1);
  });

  it('is monotonic and clamped', () => {
    let prev = -1;
    for (let h = 0; h <= 1.0001; h += 0.05) {
      const c = coreFraction(h);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
    expect(coreFraction(-5)).toBeCloseTo(CORE_MIN, 6);
    expect(coreFraction(5)).toBeCloseTo(CORE_MAX, 6);
  });
});

describe('smootherstep', () => {
  it('has zero first and second derivative at both ends', () => {
    // This is the whole reason for using it over smoothstep: a non-zero second
    // derivative at the seams shows up as a Mach band where the shoulder meets
    // the plateau and the background. (The absolute numbers below are
    // finite-difference estimates, so compare against smoothstep rather than
    // against a hand-computed zero.)
    const eps = 1e-3;
    const fd1 = (f: (x: number) => number, x: number) =>
      (f(x + eps) - f(x - eps)) / (2 * eps);
    const fd2 = (f: (x: number) => number, x: number) =>
      (f(x + eps) - 2 * f(x) + f(x - eps)) / (eps * eps);

    for (const x of [0.001, 0.999]) {
      expect(Math.abs(fd1(smootherstep, x))).toBeLessThan(1e-3);
      expect(Math.abs(fd2(smootherstep, x))).toBeLessThan(0.1);
    }

    // Contrast: smoothstep is 3x^2 - 2x^3, whose second derivative at 0 is 6 —
    // orders of magnitude bigger than smootherstep's, and exactly the seam
    // artefact we switched away from.
    const smoothstep = (x: number) => x * x * (3 - 2 * x);
    expect(Math.abs(fd2(smoothstep, 0.001))).toBeGreaterThan(1);
    // And the shoulder still curves, or it would be a straight ramp.
    // (Not x = 0.5: smootherstep is odd-symmetric about its centre, so the
    // symmetric second difference vanishes there even though f'' is 7.5.)
    expect(fd2(smootherstep, 0.25)).toBeGreaterThan(1);
  });

  it('is a clean 0..1 ramp', () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 6);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(-1)).toBe(0);
    expect(smootherstep(2)).toBe(1);
  });
});

describe('coverage profile', () => {
  it('is exactly full across the whole plateau', () => {
    for (const h of [0, 0.25, 0.5, 0.9, 1]) {
      const core = coreFraction(h);
      expect(coverageAt(0, h)).toBe(1);
      expect(coverageAt(core, h)).toBe(1);
      expect(coverageAt(core * 0.5, h)).toBe(1);
    }
  });

  it('reaches zero exactly at the rim', () => {
    for (const h of [0, 0.25, 0.5, 1]) expect(coverageAt(1, h)).toBe(0);
  });

  it('decreases monotonically from centre to rim', () => {
    let prev = 2;
    for (let i = 0; i <= 100; i++) {
      const c = coverageAt(i / 100, 0.3);
      expect(c).toBeLessThanOrEqual(prev + 1e-9);
      prev = c;
    }
  });

  it('gives a soft brush a real body, not a haze', () => {
    // The complaint this whole profile change answers: at low hardness the
    // stroke used to be washed out, because coverage fell off from the centre.
    // Blender-ish: still ~full at a third of the radius.
    expect(coverageAt(1 / 3, 0)).toBe(1);
    // ...and the 50% point sits in the outer third of the radius.
    let half = 1;
    for (let i = 100; i >= 0; i--) {
      if (coverageAt(i / 100, 0) >= 0.5) { half = i / 100; break; }
    }
    expect(half).toBeGreaterThan(0.6);
    expect(half).toBeLessThan(1);
  });

  it('a harder brush only moves the shoulder outward', () => {
    // Hardness must not rescale the plateau in a way that makes the soft brush
    // *wider* — the core should grow monotonically with hardness.
    const coreOf = (h: number) => coreFraction(h);
    expect(coreOf(0.8)).toBeGreaterThan(coreOf(0.2));
    // At a fixed distance, a harder brush covers at least as much.
    for (const t of [0.5, 0.7, 0.9]) {
      expect(coverageAt(t, 0.9)).toBeGreaterThanOrEqual(coverageAt(t, 0.1) - 1e-9);
    }
  });
});

describe('CSS gradient mirror', () => {
  it('emits a stop at the plateau edge and one at the rim', () => {
    const g = brushGradient(0.4, RING_PEAK_ALPHA, 8);
    expect(g.startsWith('radial-gradient(circle closest-side,')).toBe(true);
    const core = coreFraction(0.4);
    expect(g).toContain(`rgba(255,255,255,${RING_PEAK_ALPHA}) 0%`);
    expect(g).toContain(`${(core * 100).toFixed(2)}%`);
    expect(g).toContain('100.00%');
  });

  it('fades to fully transparent at the rim', () => {
    const g = brushGradient(0.25, 0.92, 8);
    expect(g).toMatch(/rgba\(255,255,255,0\.000\) 100\.00%\)$/);
  });

  it('fades monotonically, whatever the hardness', () => {
    const alphasOf = (h: number) =>
      brushGradient(h, 0.92, 12).split('rgba(255,255,255,').slice(1).map((s) => parseFloat(s));
    for (const h of [0, 0.25, 0.5, 1]) {
      const alphas = alphasOf(h);
      expect(alphas.length).toBe(14);
      for (let i = 1; i < alphas.length; i++) {
        expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1] + 1e-9);
      }
      expect(alphas[0]).toBeCloseTo(0.92, 6);
      expect(alphas[alphas.length - 1]).toBe(0);
    }
  });

  it('a hard brush reaches its shoulder later than a soft one', () => {
    const shoulderAt = (h: number) => {
      for (let i = 0; i <= 100; i++) {
        if (coverageAt(i / 100, h) < 0.5) return i / 100;
      }
      return 1;
    };
    expect(shoulderAt(0.9)).toBeGreaterThan(shoulderAt(0.1));
  });

  it('is deterministic', () => {
    expect(brushGradient(0.37)).toBe(brushGradient(0.37));
  });
});
