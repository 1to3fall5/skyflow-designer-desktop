/**
 * The menu bar's structure.
 *
 * This used to *build a native Tauri menu*. It cannot any more: the title bar
 * and the menu bar are one bar now (`decorations: false` in tauri.conf.json),
 * which is what Photoshop does on Windows — 文件 编辑 图像 图层 down the left of
 * a single chrome row, window buttons down the right. A native menu can only
 * live in the native frame, and there is no native frame.
 *
 * So this file is now the *model*, and `AppBar.tsx` renders it. Keeping the
 * model separate matters for the same reason it did before: the structure, the
 * command ids and the tick-mark state are testable without mounting React.
 *
 * No accelerators are listed, on purpose. The keyboard is owned by
 * `shortcuts.ts`; binding the same chord in two places fires it twice.
 */

export type MenuCmd =
  // 文件
  | 'file.new' | 'file.open' | 'file.save' | 'file.saveAs' | 'file.import' | 'file.export'
  | 'file.importFlowmap'
  // 编辑
  | 'edit.undo' | 'edit.redo' | 'edit.clear'
  // 视图
  | 'view.reference' | 'view.flowmap' | 'view.arrows' | 'view.anim' | 'view.panels'
  | 'view.2d' | 'view.split' | 'view.3d'
  // 图层
  | 'layer.paint' | 'layer.path' | 'layer.wind' | 'layer.obstacle'
  | 'layer.up' | 'layer.down' | 'layer.delete'
  // 帮助
  | 'help.shortcuts';

/** Menu rows that carry a tick. */
export type CheckKey =
  | 'reference' | 'flowmap' | 'arrows' | 'anim' | 'panels'
  | 'mode2d' | 'modeSplit' | 'mode3d';

export interface MenuState {
  reference: boolean;
  flowmap: boolean;
  arrows: boolean;
  anim: boolean;
  /** Tab: the toolbox, panels and options bar are hidden. */
  panels: boolean;
  mode: '2d' | 'split' | '3d';
}

export type MenuEntry =
  | { kind: 'item'; label: string; cmd: MenuCmd }
  | { kind: 'check'; label: string; cmd: MenuCmd; key: CheckKey }
  | { kind: 'path'; label: string; path: string }
  | { kind: 'sep' }
  | { kind: 'submenu'; label: string; items: MenuEntry[] };

export interface MenuSpec {
  label: string;
  items: MenuEntry[];
}

const item = (label: string, cmd: MenuCmd): MenuEntry => ({ kind: 'item', label, cmd });
const check = (label: string, cmd: MenuCmd, key: CheckKey): MenuEntry =>
  ({ kind: 'check', label, cmd, key });
const sep: MenuEntry = { kind: 'sep' };

/** How many entries 文件 > 打开最近 holds. */
export const RECENT_MAX = 8;

/**
 * Is this row ticked? Kept here rather than in the component because the three
 * screen-mode rows all read the same `mode` field, so `MenuState[CheckKey]`
 * does not typecheck — and a lookup written twice drifts.
 */
export function isChecked(key: CheckKey, s: MenuState): boolean {
  switch (key) {
    case 'reference': return s.reference;
    case 'flowmap': return s.flowmap;
    case 'arrows': return s.arrows;
    case 'anim': return s.anim;
    case 'panels': return s.panels;
    case 'mode2d': return s.mode === '2d';
    case 'modeSplit': return s.mode === 'split';
    case 'mode3d': return s.mode === '3d';
  }
}

export function buildMenus(recent: string[]): MenuSpec[] {
  const recentItems: MenuEntry[] = recent.length
    ? recent.slice(0, RECENT_MAX).map((p) => ({
        kind: 'path' as const,
        label: p.split(/[\\/]/).pop() || p,
        path: p,
      }))
    : [item('（无）', 'file.open')];

  return [
    {
      label: '文件',
      items: [
        item('新建', 'file.new'),
        item('打开…', 'file.open'),
        { kind: 'submenu', label: '打开最近', items: recentItems },
        sep,
        item('保存', 'file.save'),
        item('另存为…', 'file.saveAs'),
        sep,
        item('导入天空图…', 'file.import'),
        item('导入 Flowmap 为图层…', 'file.importFlowmap'),
        item('导出 Flowmap…', 'file.export'),
      ],
    },
    {
      label: '编辑',
      items: [
        item('撤销', 'edit.undo'),
        item('重做', 'edit.redo'),
        sep,
        item('清空当前图层', 'edit.clear'),
      ],
    },
    {
      label: '视图',
      items: [
        check('显示天空贴图', 'view.reference', 'reference'),
        check('叠加 Flowmap', 'view.flowmap', 'flowmap'),
        check('流向箭头', 'view.arrows', 'arrows'),
        check('播放动画', 'view.anim', 'anim'),
        sep,
        check('2D 绘制', 'view.2d', 'mode2d'),
        check('分屏', 'view.split', 'modeSplit'),
        check('3D 预览', 'view.3d', 'mode3d'),
        sep,
        check('隐藏全部面板', 'view.panels', 'panels'),
      ],
    },
    {
      label: '图层',
      items: [
        item('新建流向图层', 'layer.paint'),
        item('新建路径图层', 'layer.path'),
        item('新建风向图层', 'layer.wind'),
        item('新建障碍图层', 'layer.obstacle'),
        sep,
        item('上移一层', 'layer.up'),
        item('下移一层', 'layer.down'),
        sep,
        item('删除图层', 'layer.delete'),
      ],
    },
    {
      label: '帮助',
      items: [item('快捷键', 'help.shortcuts')],
    },
  ];
}
