/**
 * Declarative keyboard shortcut resolution.
 *
 * Pure and side-effect free so it can be unit tested — the DOM layer only
 * dispatches the returned action.
 */

export type Tool = 'brush' | 'eraser' | 'magic_wand' | 'eyedropper' | 'pan';
export type ViewMode = '2d' | 'split' | '3d';
export type BrushParam = 'size' | 'strength' | 'hardness';

/**
 * Tools that never put pixels down. The brush ring is hidden for these and the
 * OS cursor comes back, otherwise an eyedropper with no visible pointer is
 * unusable.
 */
export const NON_PAINTING_TOOLS: ReadonlySet<Tool> =
  new Set<Tool>(['magic_wand', 'eyedropper', 'pan']);

export type Action =
  | { type: 'none' }
  | { type: 'tool'; tool: Tool }
  | { type: 'view'; mode: ViewMode }
  | { type: 'toggle'; what: 'arrows' | 'anim' | 'reference' | 'flowmap' | 'help' }
  /** Tab: collapse every panel so the canvas gets the whole window. */
  | { type: 'togglePanels' }
  | { type: 'closeHelp' }
  | { type: 'resetView' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'file'; op: 'new' | 'open' | 'save' | 'saveAs' | 'export' }
  | { type: 'brushSize'; delta: number }
  /** F / Ctrl+F held: enter drag-to-adjust mode for a brush parameter. */
  | { type: 'brushAdjust'; param: BrushParam };

export const NONE: Action = { type: 'none' };

export interface KeyEventLike {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Upper-case tag name of `event.target`, if any. */
  targetTag?: string | null;
  /** True when the target is contentEditable. */
  editing?: boolean;
}

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Typing in a form control must never trigger a shortcut. */
export function isTextEntry(targetTag?: string | null, editing?: boolean): boolean {
  if (editing) return true;
  if (!targetTag) return false;
  return TEXT_ENTRY_TAGS.has(targetTag.toUpperCase());
}

/**
 * `e.key` is affected by Shift (e.g. "Z" vs "z"), so single characters are
 * lower-cased; named keys such as "Escape" are kept verbatim.
 */
function normalise(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function resolveShortcut(e: KeyEventLike): Action {
  if (isTextEntry(e.targetTag, e.editing)) return NONE;

  const mod = (e.ctrl ?? false) || (e.meta ?? false);
  const k = normalise(e.key);

  // ---- modifier combos --------------------------------------------------
  if (mod) {
    if (e.alt) return NONE; // AltGr etc. — leave to the OS
    switch (k) {
      case 'n': return { type: 'file', op: 'new' };
      case 'o': return { type: 'file', op: 'open' };
      case 's': return { type: 'file', op: e.shift ? 'saveAs' : 'save' };
      case 'e': return { type: 'file', op: 'export' };
      case 'z': return e.shift ? { type: 'redo' } : { type: 'undo' };
      case 'y': return { type: 'redo' };
      case 'f': return { type: 'brushAdjust', param: 'strength' };
      default: return NONE;
    }
  }

  if (e.alt) return NONE; // Alt-drag pans the 2D view

  // ---- bare keys --------------------------------------------------------
  if (k === 'Escape') return { type: 'closeHelp' };

  if (k === 'Tab') return { type: 'togglePanels' };

  switch (k) {
    case 'b': return { type: 'tool', tool: 'brush' };
    case 'e': return { type: 'tool', tool: 'eraser' };
    case 'm': return { type: 'tool', tool: 'magic_wand' };
    // Photoshop's letters for these two, so the muscle memory carries over.
    case 'i': return { type: 'tool', tool: 'eyedropper' };
    case 'h': return { type: 'tool', tool: 'pan' };

    case '1': return { type: 'view', mode: '2d' };
    case '2': return { type: 'view', mode: 'split' };
    case '3': return { type: 'view', mode: '3d' };

    case 'a': return { type: 'toggle', what: 'arrows' };
    case 'r': return { type: 'toggle', what: 'reference' };
    case 'o': return { type: 'toggle', what: 'flowmap' };

    case 'f': return { type: 'brushAdjust', param: e.shift ? 'hardness' : 'size' };

    case ' ': return { type: 'toggle', what: 'anim' };

    case '?':
    case '/': return { type: 'toggle', what: 'help' };

    case '[': return { type: 'brushSize', delta: -4 };
    case ']': return { type: 'brushSize', delta: 4 };
    case '-': return { type: 'brushSize', delta: -4 };
    case '=':
    case '+': return { type: 'brushSize', delta: 4 };
  }

  return NONE;
}

/** Keys we must preventDefault on so the WebView doesn't also act on them. */
export function shouldPrevent(e: KeyEventLike): boolean {
  const mod = (e.ctrl ?? false) || (e.meta ?? false);
  if (mod) return true;
  // Tab must be swallowed or the WebView walks focus into the toolbar instead
  // of hiding the panels — and focus would then eat every later shortcut.
  return e.key === ' ' || e.key === '?' || e.key === '/' || e.key === 'Tab';
}

/** Human-readable table shared by the in-app help panel and the docs. */
export const SHORTCUT_HELP: Array<[string, string]> = [
  ['画笔 / 橡皮擦 / 魔棒', 'B / E / M'],
  ['吸管 / 平移视图', 'I / H'],
  ['隐藏 / 显示全部面板', 'Tab'],
  ['2D 绘制 / 分屏 / 3D 预览', '1 / 2 / 3'],
  ['显示流向箭头', 'A'],
  ['显示/隐藏天空贴图', 'R'],
  ['叠加 Flowmap', 'O'],
  ['播放 / 暂停动画', 'Space'],
  ['重置 2D 视图（轻按）', 'F'],
  ['按住 F 左右拖动', '调整笔刷大小'],
  ['按住 Shift+F 左右拖动', '调整笔刷硬度'],
  ['按住 Ctrl+F 左右拖动', '调整笔刷强度'],
  ['笔刷大小微调', '[ / ]'],
  ['撤销 / 重做', 'Ctrl+Z / Ctrl+Shift+Z'],
  ['重做', 'Ctrl+Y'],
  ['新建 / 打开', 'Ctrl+N / Ctrl+O'],
  ['保存 / 另存为', 'Ctrl+S / Ctrl+Shift+S'],
  ['导出贴图', 'Ctrl+E'],
  ['关闭帮助', 'Esc'],
  ['显示/隐藏本面板', '?'],
  // --- mouse ---
  ['3D：中键拖动', '旋转视角'],
  ['3D：Ctrl + 中键拖动', '缩放'],
  ['3D：右键拖动', '转动镜头'],
  ['3D：右键 + W/A/S/D/Q/E', '飞行移动'],
  ['3D：左键', '绘制'],
  ['按住 Alt 点击 / 拖动', '吸管：吸取流动强度'],
  ['2D：中键拖动', '平移'],
  ['2D：Ctrl + 中键拖动', '缩放'],
  ['滚轮', '缩放视图'],
];
