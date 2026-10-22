/**
 * Whether the selected layer can be merged into the one below it, and if not,
 * why — in words, because the reason is what the tooltip has to say.
 *
 * The engine refuses the same cases (`Engine::merge_down`), so this is a
 * second statement of the rule, kept next to the button that needs it. That is
 * worth the duplication: a button that is always enabled and silently does
 * nothing is worse than one that is grey and tells you why.
 *
 * What it will not do is approximate. Merging two layers has to be invisible —
 * one layer that paints exactly what the two painted — and every refusal here
 * is a case where that cannot be arranged:
 *
 * - different kinds: a mask and a pixel buffer are not the same kind of thing
 * - wind: a wind layer *is* its two dials; merging keeps one pair and throws
 *   the other away, and the thrown-away pair is the thing you tuned
 * - unequal blur radii: one radius cannot express two
 * - a path layer whose opacity differs from the one below: opacity multiplies
 *   coverage, and a path has no per-path coverage to fold it into
 */

import type { LayerInfo } from './api';
import { blurRadius } from './effects';

const KIND_NAME: Record<string, string> = {
  paint: '流向',
  path: '路径',
  wind: '风向',
  obstacle: '障碍',
};

/**
 * `null` when the merge is allowed, otherwise the reason it is not.
 *
 * `rows` is the visible order — top row first, the way the panel lists them.
 */
export function mergeBlocker(rows: LayerInfo[], activeId: string | null): string | null {
  if (!activeId) return '没有选中的图层';
  const i = rows.findIndex((l) => l.id === activeId);
  if (i < 0) return '没有选中的图层';
  if (i >= rows.length - 1) return '它下面没有图层了';

  const top = rows[i];
  const below = rows[i + 1];

  if (top.kind !== below.kind) {
    return `下面的「${below.name}」是${KIND_NAME[below.kind]}层，只有同类型的图层才能合并`;
  }
  if (top.kind === 'wind') {
    return '风向层是它的两个旋钮本身，合并会丢掉其中一组方向 / 强度';
  }
  const rTop = blurRadius(top.effects);
  const rBelow = blurRadius(below.effects);
  if (Math.abs(rTop - rBelow) > 0.01) {
    // Say what to do about it. "A radius cannot express two" is a true sentence
    // and a useless instruction — and baking only one of them is not enough,
    // because having no blur at all is a radius too.
    return `两层的模糊不一样（${rTop} / ${rBelow}），一个半径表达不了两个。` +
      `对两层各用一次「图层 ▸ 应用图层效果」把模糊烘焙进像素，就能合并了`;
  }
  if (top.kind === 'path' && Math.abs(top.opacity - below.opacity) > 1e-4) {
    return '两条路径层的不透明度不一样，合并会改变结果；先把它们调成一样';
  }
  return null;
}

/** What the button says when it is live. */
export function mergeTitle(rows: LayerInfo[], activeId: string | null): string {
  const why = mergeBlocker(rows, activeId);
  if (why) return why;
  const i = rows.findIndex((l) => l.id === activeId);
  return `向下合并到「${rows[i + 1].name}」（Ctrl+E）`;
}
