/**
 * The `fx` model, tested on its own.
 *
 * These are the rules the UI is leaning on: an effect can be switched off
 * without losing its number, two blurs do not compound, and removing one
 * restores the layer exactly. None of that needs a browser, and none of it
 * should be re-derived by hand inside App.tsx.
 */

import { describe, expect, it } from 'vitest';
import {
  ADDABLE_BY_KIND,
  FX_META,
  addEffect,
  blurRadius,
  formatAmount,
  makeEffect,
  removeEffect,
  setEffectAmount,
  setEffectEnabled,
  type EffectKind,
  type LayerEffect,
} from './effects';

const blur = (amount: number, enabled = true): LayerEffect => ({ kind: 'blur', enabled, amount });

/** Every kind something somewhere can add — see `ADDABLE_BY_KIND`. */
const ALL_KINDS: EffectKind[] = [
  ...new Set(Object.values(ADDABLE_BY_KIND).flat()),
];

describe('blurRadius', () => {
  it('is 0 for no effects', () => {
    expect(blurRadius([])).toBe(0);
  });

  it('is 0 when the blur is switched off', () => {
    // The whole point of `enabled`: the value survives so you can A/B it.
    expect(blurRadius([blur(12, false)])).toBe(0);
  });

  it('takes the larger of two, rather than compounding', () => {
    // Two blur effects is a mistake, not a feature. Stacking them would give a
    // radius neither slider says, which is worse than picking one.
    expect(blurRadius([blur(8), blur(20)])).toBe(20);
    expect(blurRadius([blur(20), blur(8)])).toBe(20);
  });

  it('ignores a disabled one even when it is the larger', () => {
    expect(blurRadius([blur(30, false), blur(8)])).toBe(8);
  });

  it('never returns a negative radius', () => {
    // The engine floors it too, but a negative radius reaching the composite
    // would be a silent no-op that reads as a bug in the effect, not the value.
    expect(blurRadius([blur(-5)])).toBe(0);
  });
});

describe('editing the list', () => {
  it('adds at the end, so the rows keep their order', () => {
    expect(addEffect([blur(4)], 'blur')).toEqual([blur(4), blur(12)]);
  });

  it('does not mutate the list it was given', () => {
    // React compares by identity; an in-place edit would re-render a row that
    // looks unchanged and drop the one that did change.
    const fx = [blur(8)];
    setEffectAmount(fx, 0, 24);
    expect(fx[0].amount).toBe(8);
  });

  it('switches an effect off and back without touching its amount', () => {
    const off = setEffectEnabled([blur(17)], 0, false);
    expect(off[0]).toEqual({ kind: 'blur', enabled: false, amount: 17 });
    expect(setEffectEnabled(off, 0, true)[0].amount).toBe(17);
  });

  it('changes only the effect at that index', () => {
    const out = setEffectAmount([blur(4), blur(9)], 1, 30);
    expect(out.map((e) => e.amount)).toEqual([4, 30]);
  });

  it('removes by index, leaving the rest in place', () => {
    expect(removeEffect([blur(4), blur(9), blur(2)], 1).map((e) => e.amount)).toEqual([4, 2]);
  });

  it('removing the last effect restores a clean list', () => {
    // "Remove" has to be exact: a leftover entry would keep the `fx` badge lit
    // on a layer that no longer does anything.
    expect(removeEffect([blur(12)], 0)).toEqual([]);
    expect(blurRadius(removeEffect([blur(12)], 0))).toBe(0);
  });
});

describe('the catalogue', () => {
  it('gives every addable kind a label and a usable range', () => {
    for (const k of ALL_KINDS) {
      const m = FX_META[k];
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.min).toBeLessThan(m.max);
      expect(m.step).toBeGreaterThan(0);
      // A slider whose title is empty is a tooltip that never opens; the panel
      // passes this straight through.
      expect(m.title.length).toBeGreaterThan(10);
    }
  });

  it('starts a new effect inside its own range and switched on', () => {
    // Landing at 0 would add an effect that demonstrably does nothing, and
    // landing off would make the add button look broken.
    for (const k of ALL_KINDS) {
      const e = makeEffect(k);
      expect(e.enabled).toBe(true);
      expect(e.amount).toBeGreaterThan(FX_META[k].min);
      expect(e.amount).toBeLessThanOrEqual(FX_META[k].max);
    }
    expect(blurRadius([makeEffect('blur')])).toBeGreaterThan(0);
  });

  it('offers the disturbance only where there is a mask to bend around', () => {
    // It is the one effect that is not about a layer's pixels. On a paint
    // layer it would be a dial that moves and does nothing.
    expect(ADDABLE_BY_KIND.obstacle).toEqual(['disturbance']);
    for (const k of ['paint', 'wind', 'path'] as const) {
      expect(ADDABLE_BY_KIND[k]).not.toContain('disturbance');
      expect(ADDABLE_BY_KIND[k]).toContain('blur');
    }
  });

  it('reads a reach as a percentage and a radius as pixels', () => {
    // Both sliders print into the same narrow column. `amount | 0` on a 0..1
    // effect would read 0 at every position but the last.
    expect(formatAmount('disturbance', 0.5)).toBe('50%');
    expect(formatAmount('disturbance', 1)).toBe('100%');
    expect(formatAmount('blur', 12)).toBe('12');
  });
});
