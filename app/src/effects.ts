/**
 * Layer effects — the `fx` badge on a layer row.
 *
 * Photoshop separates what a layer *is* from what is *done to* it. Opacity is
 * the first: how much of the layer you let through, and it lives in the layer
 * panel. Blur is the second: it is not a property of the pixels, it is
 * something applied to them afterwards.
 *
 * So an effect is a *record on the layer* rather than a field that means
 * "some blur". That is what lets a layer carry several, what lets one be
 * switched off while keeping the number it was tuned to, and what makes "add
 * an effect" an action instead of a slider appearing.
 *
 * Pure, so it is testable without a browser — and mirrors
 * `engine::effect::LayerEffect` field for field.
 */

export type EffectKind = 'blur';

export interface LayerEffect {
  kind: EffectKind;
  /** Off keeps the settings, so you can A/B an effect without losing it. */
  enabled: boolean;
  /** Strength in the effect's own units — a blur radius in canvas pixels. */
  amount: number;
}

export const FX_META: Record<EffectKind, {
  label: string;
  min: number;
  max: number;
  step: number;
  title: string;
}> = {
  blur: {
    label: '模糊',
    min: 0,
    max: 64,
    step: 1,
    title: '柔和这一层自己的像素，边缘不再生硬。改的是「怎么呈现」，不动内容本身。',
  },
};

/** Kinds that can be added from the toolbar, in the order they are offered. */
export const ADDABLE: EffectKind[] = ['blur'];

export function makeEffect(kind: EffectKind): LayerEffect {
  return { kind, enabled: true, amount: kind === 'blur' ? 12 : 0 };
}

/**
 * The blur radius these effects ask for, `0` for none.
 *
 * Two blur effects is a mistake rather than a feature, so the larger wins
 * instead of the two stacking — compounding them would give a radius neither
 * slider says, which is worse than picking one.
 */
export function blurRadius(fx: LayerEffect[]): number {
  let r = 0;
  for (const e of fx) if (e.enabled && e.kind === 'blur' && e.amount > r) r = e.amount;
  return r;
}

export function addEffect(fx: LayerEffect[], kind: EffectKind): LayerEffect[] {
  return [...fx, makeEffect(kind)];
}

export function setEffectEnabled(fx: LayerEffect[], i: number, on: boolean): LayerEffect[] {
  return fx.map((e, j) => (j === i ? { ...e, enabled: on } : e));
}

export function setEffectAmount(fx: LayerEffect[], i: number, v: number): LayerEffect[] {
  return fx.map((e, j) => (j === i ? { ...e, amount: v } : e));
}

export function removeEffect(fx: LayerEffect[], i: number): LayerEffect[] {
  return fx.filter((_, j) => j !== i);
}
