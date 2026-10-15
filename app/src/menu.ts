/**
 * The native menu bar.
 *
 * Everything that happens *once per session* lives here, not in the panel
 * column: file operations, layer creation, view toggles. Photoshop keeps its
 * right-hand panels for the state you keep touching while you work and puts
 * "open / save / export / new layer" in the menu bar. Having both is how this
 * app ended up with six panel sections, three of which duplicated the toolbar
 * buttons — 图片源 duplicated 导入天空图, 导出 duplicated 导出贴图, and 最近打开
 * is File > Open Recent in any program that has a File menu.
 *
 * No accelerators are registered, on purpose. The keyboard is already owned by
 * `shortcuts.ts`; binding the same chord here would fire the action twice,
 * because the WebView still sees the keydown. The menu is a mouse affordance
 * that documents what the app can do; the keys keep working exactly as before.
 */
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';

export type MenuCmd =
  // 文件
  | 'file.new' | 'file.open' | 'file.save' | 'file.saveAs' | 'file.import' | 'file.export'
  // 编辑
  | 'edit.undo' | 'edit.redo' | 'edit.clear'
  // 视图
  | 'view.reference' | 'view.flowmap' | 'view.arrows' | 'view.anim' | 'view.panels'
  | 'view.2d' | 'view.split' | 'view.3d'
  // 图层
  | 'layer.paint' | 'layer.wind' | 'layer.obstacle'
  | 'layer.up' | 'layer.down' | 'layer.delete'
  // 帮助
  | 'help.shortcuts';

/** Everything the menu draws a tick next to. */
export interface MenuState {
  reference: boolean;
  flowmap: boolean;
  arrows: boolean;
  anim: boolean;
  /** Tab: the toolbox, panels and options bar are hidden. */
  panels: boolean;
  mode: '2d' | 'split' | '3d';
}

export interface MenuHandle {
  /** Push current state into the tick marks. Safe to call every render. */
  sync(s: MenuState): void;
}

/** Ids of the check items, in the order `MenuState` describes them. */
const CHECK_KEYS = ['reference', 'flowmap', 'arrows', 'anim', 'panels',
  'mode2d', 'modeSplit', 'mode3d'] as const;
type CheckKey = typeof CHECK_KEYS[number];

export async function installMenu(opts: {
  run: (cmd: MenuCmd) => void;
  recent: string[];
  openRecent: (path: string) => void;
  state: MenuState;
}): Promise<MenuHandle> {
  const { run, recent, openRecent, state } = opts;
  const checks = new Map<CheckKey, CheckMenuItem>();

  const item = (text: string, cmd: MenuCmd) =>
    MenuItem.new({ text, action: () => run(cmd) });

  const check = async (key: CheckKey, text: string, cmd: MenuCmd, on: boolean) => {
    const m = await CheckMenuItem.new({ text, checked: on, action: () => run(cmd) });
    checks.set(key, m);
    return m;
  };

  const sep = () => PredefinedMenuItem.new({ item: 'Separator' });

  // ---- 文件 ------------------------------------------------------------
  const recentItems = await Promise.all(
    recent.slice(0, 8).map((p) =>
      MenuItem.new({ text: p.split(/[\\/]/).pop() || p, action: () => openRecent(p) })),
  );
  const file = await Submenu.new({
    text: '文件',
    items: [
      await item('新建', 'file.new'),
      await item('打开…', 'file.open'),
      await Submenu.new({
        text: '打开最近',
        items: recentItems.length ? recentItems : [await item('（无）', 'file.open')],
        enabled: recentItems.length > 0,
      }),
      await sep(),
      await item('保存', 'file.save'),
      await item('另存为…', 'file.saveAs'),
      await sep(),
      await item('导入天空图…', 'file.import'),
      await item('导出 Flowmap…', 'file.export'),
    ],
  });

  // ---- 编辑 ------------------------------------------------------------
  const edit = await Submenu.new({
    text: '编辑',
    items: [
      await item('撤销', 'edit.undo'),
      await item('重做', 'edit.redo'),
      await sep(),
      await item('清空当前图层', 'edit.clear'),
    ],
  });

  // ---- 视图 ------------------------------------------------------------
  // These are the four toggles that used to float over the canvas. PS reaches
  // them from View > Show; the tick mark is what tells you the current state
  // once the floating bar is gone.
  const view = await Submenu.new({
    text: '视图',
    items: [
      await check('reference', '显示天空贴图', 'view.reference', state.reference),
      await check('flowmap', '叠加 Flowmap', 'view.flowmap', state.flowmap),
      await check('arrows', '流向箭头', 'view.arrows', state.arrows),
      await check('anim', '播放动画', 'view.anim', state.anim),
      await sep(),
      await check('mode2d', '2D 绘制', 'view.2d', state.mode === '2d'),
      await check('modeSplit', '分屏', 'view.split', state.mode === 'split'),
      await check('mode3d', '3D 预览', 'view.3d', state.mode === '3d'),
      await sep(),
      await check('panels', '隐藏全部面板', 'view.panels', state.panels),
    ],
  });

  // ---- 图层 ------------------------------------------------------------
  const layer = await Submenu.new({
    text: '图层',
    items: [
      await item('新建流向图层', 'layer.paint'),
      await item('新建风向图层', 'layer.wind'),
      await item('新建障碍图层', 'layer.obstacle'),
      await sep(),
      await item('上移一层', 'layer.up'),
      await item('下移一层', 'layer.down'),
      await sep(),
      await item('删除图层', 'layer.delete'),
    ],
  });

  // ---- 帮助 ------------------------------------------------------------
  const help = await Submenu.new({
    text: '帮助',
    items: [await item('快捷键', 'help.shortcuts')],
  });

  const menu = await Menu.new({ items: [file, edit, view, layer, help] });
  await menu.setAsAppMenu();

  return {
    sync(s) {
      const wanted: Record<CheckKey, boolean> = {
        reference: s.reference,
        flowmap: s.flowmap,
        arrows: s.arrows,
        anim: s.anim,
        panels: s.panels,
        mode2d: s.mode === '2d',
        modeSplit: s.mode === 'split',
        mode3d: s.mode === '3d',
      };
      for (const key of CHECK_KEYS) {
        const m = checks.get(key);
        if (m) void m.setChecked(wanted[key]);
      }
    },
  };
}
