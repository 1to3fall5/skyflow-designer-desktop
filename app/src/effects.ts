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

import type { LayerKind } from './api';

export type EffectKind = 'blur' | 'disturbance';

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
  /** How the amount reads. A radius is a number of pixels; a reach is a %. */
  unit: 'px' | '%';
  title: string;
}> = {
  blur: {
    label: '模糊',
    min: 0,
    max: 64,
    step: 1,
    unit: 'px',
    title: '柔和这一层自己的像素，边缘不再生硬。改的是「怎么呈现」，不动内容本身。',
  },
  disturbance: {
    label: '绕流',
    min: 0,
    max: 1,
    step: 0.05,
    unit: '%',
    title: '让下方的流沿着这一层的遮罩边缘分开、绕着走，而不是直直撞上去。' +
      '范围越大，拐弯发生得越早、越远。',
  },
};

/**
 * What can be added to a layer of this kind, in the order it is offered.
 *
 * The disturbance is the one effect that is not about pixels: it is about
 * *this layer's mask*, which only an obstacle layer has. Offering it on a
 * paint layer would be a dial that does nothing.
 */
export const ADDABLE_BY_KIND: Record<LayerKind, EffectKind[]> = {
  paint: ['blur'],
  path: ['blur'],
  wind: ['blur'],
  obstacle: ['disturbance'],
};

/** The kind's default strength, so a new effect is visible the moment it lands. */
export function makeEffect(kind: EffectKind): LayerEffect {
  return { kind, enabled: true, amount: kind === 'blur' ? 12 : 0.5 };
}

/** Read an amount the way the user sees it: a radius in px, a reach in %. */
export function formatAmount(kind: EffectKind, amount: number): string {
  return FX_META[kind].unit === '%'
    ? `${Math.round(amount * 100)}%`
    : `${amount | 0}`;
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

/**
 * Why a layer's effects cannot be baked into its pixels, or `null` if they can.
 *
 * A menu item has no way to grey itself out, so the rule has to live somewhere
 * that can *say* it — the same reason `mergeBlocker` exists. Silently doing
 * nothing is indistinguishable from being broken.
 */
export function bakeBlocker(kind: LayerKind, fx: LayerEffect[]): string | null {
  // Wind regenerates its buffer from two dials on every composite, so anything
  // written into it would be overwritten the moment one of them moved.
  if (kind === 'wind') return '风向层的像素是由「方向 / 强度」生成的，写进去也会被下一次生成覆盖';
  // An obstacle's effect bends the field *underneath* the mask; there is
  // nothing on the layer itself it could be written into.
  if (kind === 'obstacle') return '障碍层的绕流作用于下方的流场，没有可以写进这一层的像素';
  if (blurRadius(fx) <= 0) return '这一层没有开启的模糊效果（只有模糊能烘焙）';
  return null;
}
