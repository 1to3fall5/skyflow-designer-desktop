/**
 * When 向下合并 is allowed — and what the button says when it is not.
 *
 * The engine enforces the same rules, so these tests are about the half the
 * engine cannot do: a grey button that explains itself. A disabled control
 * with no reason is a dead end; the user is left guessing whether the app is
 * broken or the operation is not allowed.
 */

import { describe, expect, it } from 'vitest';
import { mergeBlocker, mergeTitle } from './merge';
import type { LayerInfo } from './api';
import type { LayerEffect } from './effects';

const layer = (over: Partial<LayerInfo> & { id: string }): LayerInfo => ({
  name: over.id,
  kind: 'paint',
  visible: true,
  opacity: 1,
  effects: [],
  direction: 45,
  strength: 0.5,
  has_mask: false,
  paths: [],
  ...over,
});

const blur = (amount: number): LayerEffect => ({ kind: 'blur', enabled: true, amount });

describe('mergeBlocker', () => {
  it('allows two content layers of the same kind', () => {
    const rows = [layer({ id: 'a', kind: 'paint' }), layer({ id: 'b', kind: 'paint' })];
    expect(mergeBlocker(rows, 'a')).toBeNull();
  });

  it('allows two obstacle layers and two path layers', () => {
    expect(mergeBlocker([layer({ id: 'a', kind: 'obstacle' }), layer({ id: 'b', kind: 'obstacle' })], 'a')).toBeNull();
    expect(mergeBlocker([layer({ id: 'a', kind: 'path' }), layer({ id: 'b', kind: 'path' })], 'a')).toBeNull();
  });

  it('refuses the bottom layer — there is nothing under it', () => {
    const rows = [layer({ id: 'a' }), layer({ id: 'b' })];
    expect(mergeBlocker(rows, 'b')).toMatch(/下面没有图层/);
  });

  it('refuses mismatched kinds, naming the layer below', () => {
    // A mask and a pixel buffer are not the same kind of thing; there is no
    // honest way to add one to the other.
    const rows = [layer({ id: 'a', kind: 'paint' }), layer({ id: 'b', kind: 'obstacle', name: '障碍物' })];
    expect(mergeBlocker(rows, 'a')).toMatch(/障碍物.*障碍层/);
  });

  it('refuses wind, because a wind layer is its two dials', () => {
    // Merging two would keep one direction / strength pair and throw the other
    // away — and that pair is the thing you spent time tuning.
    const rows = [layer({ id: 'a', kind: 'wind' }), layer({ id: 'b', kind: 'wind' })];
    expect(mergeBlocker(rows, 'a')).toMatch(/旋钮/);
  });

  it('refuses unequal blur radii and says what they are', () => {
    const rows = [
      layer({ id: 'a', effects: [blur(8)] }),
      layer({ id: 'b', effects: [blur(20)] }),
    ];
    expect(mergeBlocker(rows, 'a')).toMatch(/模糊.*8 \/ 20/);
    // Equal radii are fine: the merge happens before the blur.
    expect(mergeBlocker([layer({ id: 'a', effects: [blur(8)] }), layer({ id: 'b', effects: [blur(8)] })], 'a')).toBeNull();
  });

  it('ignores a switched-off blur, the way the composite does', () => {
    const off: LayerEffect = { kind: 'blur', enabled: false, amount: 30 };
    const rows = [layer({ id: 'a', effects: [off] }), layer({ id: 'b' })];
    expect(mergeBlocker(rows, 'a')).toBeNull();
  });

  it('refuses paths whose opacity differs', () => {
    const rows = [
      layer({ id: 'a', kind: 'path', opacity: 1 }),
      layer({ id: 'b', kind: 'path', opacity: 0.5 }),
    ];
    expect(mergeBlocker(rows, 'a')).toMatch(/不透明度/);
    // ...but paint layers fold opacity into their alpha, so they are fine.
    expect(mergeBlocker([layer({ id: 'a', opacity: 1 }), layer({ id: 'b', opacity: 0.5 })], 'a')).toBeNull();
  });

  it('refuses nothing being selected', () => {
    expect(mergeBlocker([layer({ id: 'a' }), layer({ id: 'b' })], null)).toMatch(/没有选中/);
  });
});

describe('mergeTitle', () => {
  it('names the layer it would merge into, not just the verb', () => {
    const rows = [layer({ id: 'a' }), layer({ id: 'b', name: '流向 1' })];
    expect(mergeTitle(rows, 'a')).toMatch(/流向 1/);
  });

  it('is the reason when it is refused, so the tooltip is never empty', () => {
    const rows = [layer({ id: 'a', kind: 'wind' }), layer({ id: 'b', kind: 'wind' })];
    expect(mergeTitle(rows, 'a')).toMatch(/旋钮/);
  });
});
