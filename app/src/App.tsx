import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open, save, message } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { api, nextStrokeId, AppState, LayerInfo, LayerKind, Snapshot } from './api';
import type { PathData, PathBrush } from './pen';
import {
  FX_META, addEffect, setEffectEnabled, setEffectAmount, removeEffect,
  type LayerEffect,
} from './effects';
import { resolveShortcut, shouldPrevent, SHORTCUT_HELP, type BrushParam, type Tool } from './shortcuts';
import type { CursorUV } from './cursor';
import PaintView, { PaintViewHandle, type PenInfo } from './components/PaintView';
import Preview3D, { Preview3DHandle } from './components/Preview3D';
import { ToolIcon } from './icons';
import AppBar from './AppBar';
import type { MenuCmd } from './menu';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type ViewMode = '2d' | 'split' | '3d';

/** Toolbox entries. `key` is also the shortcut, so the two cannot drift. */
const TOOLS: Array<{ tool: Tool; icon: string; label: string; key: string }> = [
  { tool: 'brush', icon: 'brush', label: '画笔', key: 'B' },
  { tool: 'pen', icon: 'pen', label: '钢笔', key: 'P' },
  { tool: 'eraser', icon: 'eraser', label: '橡皮擦', key: 'E' },
  { tool: 'magic_wand', icon: 'wand', label: '魔棒', key: 'M' },
  { tool: 'eyedropper', icon: 'pipette', label: '吸管', key: 'I' },
  { tool: 'pan', icon: 'hand', label: '平移', key: 'H' },
];

/**
 * Right-hand panel ids, in display order.
 *
 * Four questions decided this list:
 *   * is it state you keep touching while painting? -> panel (属性, 图层, 视图)
 *
 * 属性 sits above 图层 the way it does in Photoshop: it is contextual to the
 * selected layer, so it belongs next to the top of the column where you are
 * already looking, not below the list it describes.
 *   * is it something you set once per document?    -> panel, folded (文档, 导出)
 *   * is it a file operation?                       -> menu bar
 *   * is it a list of files?                        -> menu bar (打开最近)
 * `projection` and `source` used to be their own panels and `recent` too; all
 * three are one-time things, so they are now either folded into 文档 or in the
 * 文件 menu.
 */
/**
 * Default dock order. It is only a *starting* point: the column is a dock, so
 * the order is state and you drag it into whatever arrangement you are working
 * with — see `panelOrder`.
 */
const PANEL_IDS = ['props', 'layers', 'view', 'document', 'export'] as const;
type PanelId = typeof PANEL_IDS[number];

/**
 * Pointer travel before a press becomes a drag, px.
 *
 * Below this the press is a click and does what the click does — fold the
 * panel, select the layer. Without the threshold, moving the mouse 1px while
 * clicking a panel header would silently cancel the fold.
 */
const DRAG_MIN_PX = 4;

/**
 * Reorder something by dragging it, using pointer events.
 *
 * HTML5 drag-and-drop is what this used to rely on, and it does not fire in
 * this WebView2 — `dragstart` never arrives, so both the panel dock and the
 * layer list looked like they were never wired up. Pointer events are what the
 * rest of the app already runs on (the 2D/3D splitter, every brush stroke, the
 * brush-parameter scrubber), and those demonstrably work, so reordering runs
 * on them too.
 *
 * `hit` maps a viewport Y to the id of the row/panel under it. `on` is called
 * with the current target while moving and once more on release — `'cancel'` if
 * the pointer was cancelled. It is not called at all if the pointer never
 * passed the threshold, which is what keeps a plain click a click.
 */
function beginPointerReorder(
  e: React.PointerEvent<HTMLElement>,
  hit: (y: number) => string | null,
  on: (over: string | null, phase: 'move' | 'end' | 'cancel') => void,
) {
  if (e.button !== 0) return;
  const el = e.currentTarget;
  const startY = e.clientY;
  let started = false;
  let over: string | null = null;

  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.abs(ev.clientY - startY) < DRAG_MIN_PX) return;
      started = true;
    }
    over = hit(ev.clientY);
    on(over, 'move');
  };
  const finish = (phase: 'end' | 'cancel') => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    // Capture is released on pointerup anyway; this is the cancel path.
    try { el.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    if (started) on(over, phase);
  };
  const up = () => finish('end');
  const cancel = () => finish('cancel');

  // Capture, so the moves keep coming even once the pointer has left the
  // 28px-tall header — which it will, immediately.
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
}

/**
 * Panels that start folded. Document setup and export are set once and then
 * ignored for the rest of the session; an open panel for them is just a scroll
 * you have to get past to reach 图层.
 */
const START_COLLAPSED: Record<string, boolean> = { document: true, export: true };

const KIND_META: Record<LayerKind, { label: string; color: string }> = {
  paint: { label: '流向', color: '#10b981' },
  path: { label: '路径', color: '#378ef0' },
  wind: { label: '风向', color: '#8b5cf6' },
  obstacle: { label: '障碍物', color: '#f43f5e' },
};

/**
 * Title of the kind-specific section of the 属性 panel.
 *
 * Not `KIND_META[kind].label`: that is already the panel's own title, and a
 * section called 流向 2 inches under a header called 流向属性 is noise. What
 * the section actually holds is the generator or the brush record.
 */
const PARAM_SECT: Record<LayerKind, string> = {
  paint: '笔迹',
  path: '路径',
  wind: '风场',
  obstacle: '绕流',
};

/** Kinds whose pixels come from parameters, so painting one edits its mask. */
const GENERATED: ReadonlySet<LayerKind> = new Set<LayerKind>(['wind', 'obstacle']);

/**
 * Kinds that cannot take an effect.
 *
 * An obstacle layer contributes a mask and a disturbance plane, not a pixel
 * buffer, so there is nothing for a blur to act on — and it already has its
 * own softening dial (范围). Offering an effect here would be a control that
 * moves and does nothing, which is worse than a disabled button.
 */
const NO_FX: ReadonlySet<LayerKind> = new Set<LayerKind>(['obstacle']);

const RESOLUTIONS = [512, 1024, 2048, 4096];

/** Shared empty path list, so "no paths" keeps one identity across renders. */
const EMPTY_PATHS: PathData[] = [];

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  // 3D on purpose: the flowmap only makes sense once you see it moving on a
  // sky, and that is what a new user opens the app to look at. The 2D view is
  // where you *work*, so it is one key away (1) rather than the default.
  const [viewMode, setViewMode] = useState<ViewMode>('3d');
  const [tool, setTool] = useState<Tool>('brush');
  const [brushSize, setBrushSize] = useState(24);
  const [brushStrength, setBrushStrength] = useState(0.5);
  // Soft by default: a hard tip shows every pointer sample as a scalloped edge.
  const [brushHardness, setBrushHardness] = useState(0.25);
  // How much of the remaining distance to `brushStrength` one stroke covers.
  // 1 = a stroke lands its strength outright; lower = build up over passes.
  const [brushFlow, setBrushFlow] = useState(1.0);
  // Where the Alt eyedropper reads from. 'layer' matches Photoshop's default
  // of sampling the layer you are on; 'composite' is what you actually see.
  const [sampleSource, setSampleSource] = useState<'layer' | 'composite'>('layer');
  const [magicThreshold, setMagicThreshold] = useState(20);
  /** Mirrors the pen path down in PaintView, so the options bar can count it. */
  const [penInfo, setPenInfo] = useState<PenInfo>({ anchors: 0, closed: false, sel: -1, brush: null });

  const [showArrows, setShowArrows] = useState(true);
  const [showFlowMap, setShowFlowMap] = useState(false);
  const [showReference, setShowReference] = useState(false);
  const [referenceOpacity, setReferenceOpacity] = useState(0.25);
  const [arrowDensity, setArrowDensity] = useState(48);
  const [flowMapOpacity, setFlowMapOpacity] = useState(0.6);

  const [speed, setSpeed] = useState(0.2);
  const [distortion, setDistortion] = useState(0.1);
  const [animating, setAnimating] = useState(true);

  const [invertX, setInvertX] = useState(false);
  const [invertY, setInvertY] = useState(true);
  const [exportRes, setExportRes] = useState(1024);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  /**
   * Set when a pointer drag finishes on the element it started from. The
   * browser turns that into a click too, and the click is what folds a panel or
   * selects a layer — so a drag has to swallow exactly one.
   */
  const swallowClick = useRef(false);
  /** Backend-encoded PNG of the reference image (TGA-safe display path). */
  const [refSrc, setRefSrc] = useState<string | null>(null);
  /**
   * Layer thumbnails as data URLs, keyed by layer id.
   *
   * Deliberately outside `AppState`: a thumbnail is a *rendering* of the
   * pixels, not part of the document, so nothing that saves or diffs state
   * should have to carry it.
   */
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // ---- shell layout (Photoshop-style) ----
  /** Which right-hand panels are folded. See `START_COLLAPSED`. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(START_COLLAPSED);
  /**
   * Dock order of the right-hand panels.
   *
   * Photoshop's panel column is a dock: you drag a panel by its title bar and
   * it lands where you dropped it. A fixed order is a fixed opinion about what
   * you are about to do, and it is wrong whenever you are doing something else
   * — moving 导出 to the top while you are iterating on exports is the whole
   * point.
   */
  const [panelOrder, setPanelOrder] = useState<PanelId[]>([...PANEL_IDS]);
  /**
   * Dock drag in progress: which panel is being moved, and which one it would
   * land on. Both are for feedback only — without the accent line a reorder is
   * invisible until it is already done.
   */
  const [dockDrag, setDockDrag] = useState<{ id: PanelId; over: PanelId | null } | null>(null);
  /** Layer row drag in progress, by layer id. */
  const [rowDrag, setRowDrag] = useState<{ id: string; over: string | null } | null>(null);
  /** Tab: hide the toolbox, the panels and the options bar. PS calls this
   *  "collapse all panels" and it is the single most useful key when painting. */
  const [shellHidden, setShellHidden] = useState(false);
  /** 2D pane share of the workspace in split view. */
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [zoom2d, setZoom2d] = useState(1);
  const togglePanel = (id: PanelId) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  /** Move `from` to sit where `to` currently sits. Dropping on your own
   *  panel is a no-op, and so is dropping on the panel you came from. */
  const reorderPanel = (from: string, to: string) => {
    if (from === to) return;
    setPanelOrder((o) => {
      const next = o.filter((id) => id !== from);
      const at = next.indexOf(to as PanelId);
      // `to` was `from`'s own slot, so `indexOf` can come back -1.
      if (at < 0) return o;
      next.splice(at, 0, from as PanelId);
      return next;
    });
  };

  const paintRef = useRef<PaintViewHandle>(null);
  /** The dock and the layer list, for hit-testing during a reorder drag. */
  const dockRef = useRef<HTMLElement | null>(null);
  const layerListRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<Preview3DHandle>(null);
  /** Cursor shared between the 2D view and the 3D preview (canvas coords). */
  const sharedCursor = useRef<CursorUV | null>(null);
  /** Set while F / Shift+F / Ctrl+F is being dragged to scrub a brush param. */
  const adjusting = useRef(false);
  const flowCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const flowVersionRef = useRef(0);
  const cursorUVRef = useRef<{ u: number; v: number } | null>(null);
  const stateRef = useRef<AppState | null>(null);
  stateRef.current = state;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  // Pointer-stroke identity for the 3D painter. Retired on every paint-end, so
  // one drag counts as one stroke no matter how many segments it spans.
  const stroke3d = useRef(nextStrokeId());

  // ---------------------------------------------------------------------
  /**
   * Menu commands reach the app through this ref, reassigned on every render.
   * The menu model in `menu.ts` is rebuilt each render too (it is a plain
   * array), so nothing here can go stale — which is the whole reason this is a
   * ref rather than a captured closure.
   */
  const menuCmd = useRef<(cmd: MenuCmd) => void>(() => {});

  // ---------------------------------------------------------------------
  const perfRef = useRef<HTMLSpanElement>(null);

  /** Hot path: pixels only. Used by strokes, where a React re-render per
   *  frame would cost more than the paint itself. */
  const applySnap = useCallback((s: Snapshot) => {
    if (!s || s.w === 0) return;
    paintRef.current?.applySnapshot(s);
    flowVersionRef.current += 1;
    if (perfRef.current) perfRef.current.textContent = `合成 ${s.ms.toFixed(2)} ms`;
  }, []);

  /** Cold path: pixels + engine state. Required for anything that changes
   *  projection, polar angle, size, or the layer list. */
  const applyUpdate = useCallback((s: Snapshot) => {
    if (!s) return;
    if (s.state && s.state.size > 0) setState(s.state);
    if (s.w > 0) applySnap(s);
  }, [applySnap]);

  /** Re-fetch the display copy of the reference image from the engine. */
  const reloadRef = useCallback(async () => {
    const png = await api.getReferencePng().catch(() => null);
    setRefSrc(png ? `data:image/png;base64,${png}` : null);
  }, []);

  /**
   * Re-fetch every layer thumbnail.
   *
   * Only ever called where layer *pixels* can have changed — stroke end, fill
   * end, clear, undo/redo, and structural edits. Parameter changes do not call
   * it: Photoshop's thumbnails show content, so dragging 不透明度 leaves them
   * alone, and a round trip per slider frame would buy nothing.
   */
  const refreshThumbs = useCallback(async () => {
    const list = await api.layerThumbs();
    const next: Record<string, string> = {};
    for (const t of list) next[t.id] = `data:image/png;base64,${t.png}`;
    setThumbs(next);
  }, []);

  useEffect(() => {
    (async () => {
      const s = await api.getState();
      setState(s);
      await reloadRef();
      // wait a frame so the canvas exists before pushing pixels
      requestAnimationFrame(async () => {
        const snap = await api.refresh();
        applySnap(snap);
        flowCanvasRef.current = paintRef.current?.getCanvas() ?? null;
        paintRef.current?.refreshArrows();
      });
      await refreshThumbs();
      setRecent(await api.getRecent());
    })();
  }, [applySnap, reloadRef, refreshThumbs]);

  // file drop
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const e = event.payload;
        if (e.type !== 'drop') return;
        const p = e.paths[0];
        if (p) handleDropped(p);
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  const handleDropped = async (p: string) => {
    const lower = p.toLowerCase();
    if (lower.endsWith('.skyflow')) {
      await doOpen(p);
    } else if (/\.(png|jpg|jpeg|bmp|tga|tiff|webp|exr|hdr)$/.test(lower)) {
      await importImage(p);
    }
  };

  // ---------------------------------------------------------------------
  const importImage = async (path?: string) => {
    // Only list formats the backend actually decodes: PNG/JPEG/BMP/TIFF/WEBP
    // via the image crate, plus TGA via the built-in decoder.
    const p = path ?? (await open({
      multiple: false,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tga', 'tif', 'tiff', 'webp'] }],
    }) as string | null);
    if (!p) return;
    setBusy(true);
    try {
      const s = await api.loadReference(p);
      setState(s);
      await reloadRef();
      setShowReference(true);
    } catch (e) {
      await message(`${e}\n\n支持：PNG / JPEG / BMP / TIFF / WEBP / TGA（含 RLE、16/24/32 位）`,
        { title: '导入失败', kind: 'error' });
    }
    setBusy(false);
  };

  const doExport = async () => {
    const p = await save({
      filters: [{ name: 'Flowmap', extensions: ['png', 'tga'] }],
      defaultPath: 'flowmap.png',
    });
    if (!p) return;
    setBusy(true);
    try {
      await api.export(p, invertX, invertY, exportRes);
      await message(`已导出到 ${p}`, { title: '导出完成', kind: 'info' });
    } catch (e) {
      await message(String(e), { title: '导出失败', kind: 'error' });
    }
    setBusy(false);
  };

  const doSave = async (asNew: boolean) => {
    const cur = stateRef.current;
    let p = asNew ? null : cur?.project_path ?? null;
    if (!p) {
      p = await save({ filters: [{ name: 'SkyFlow 工程', extensions: ['skyflow'] }], defaultPath: 'untitled.skyflow' });
      if (!p) return;
    }
    setBusy(true);
    try {
      await api.saveProject(p);
      await api.pushRecent(p);
      setRecent(await api.getRecent());
      setState((s) => (s ? { ...s, project_path: p! } : s));
    } catch (e) {
      await message(String(e), { title: '保存失败', kind: 'error' });
    }
    setBusy(false);
  };

  const doOpen = async (path?: string) => {
    const p = path ?? (await open({
      multiple: false,
      filters: [{ name: 'SkyFlow 工程', extensions: ['skyflow'] }],
    }) as string | null);
    if (!p) return;
    setBusy(true);
    try {
      const snap = await api.loadProject(p);
      applyUpdate(snap);
      await reloadRef();
      requestAnimationFrame(() => {
        applySnap(snap);
        paintRef.current?.refreshArrows();
      });
      await api.pushRecent(p);
      setRecent(await api.getRecent());
      await refreshThumbs();
    } catch (e) {
      await message(String(e), { title: '打开失败', kind: 'error' });
    }
    setBusy(false);
  };

  const doNew = async () => {
    const snap = await api.newProject(stateRef.current?.size ?? 1024);
    applyUpdate(snap);
    setRefSrc(null);
    paintRef.current?.refreshArrows();
    void refreshThumbs();
  };

  // ---------------------------------------------------------------------
  const updateLayer = useCallback(async (id: string, patch: Partial<LayerInfo>) => {
    applyUpdate(await api.updateLayer({ id, ...patch } as never));
  }, [applyUpdate]);

  const structural = useCallback(async (promise: Promise<Snapshot>) => {
    const snap = await promise;
    applyUpdate(snap);
    paintRef.current?.refreshArrows();
    // Every structural edit is also a pixel edit: add/remove/reorder changes
    // which thumbnail belongs to which row, clear and undo rewrite pixels.
    void refreshThumbs();
  }, [applyUpdate, refreshThumbs]);

  /**
   * Replace the active path layer's geometry.
   *
   * `done` is the gesture boundary. Dragging an anchor calls this every frame
   * with false — the engine re-renders just the paths that moved, so it keeps
   * up — and once with true on release, which is the only moment that earns a
   * history entry and a thumbnail.
   */
  const changePaths = useCallback(async (paths: PathData[], done: boolean) => {
    const st = stateRef.current;
    if (!st) return;
    const cur = st.layers.find((l) => l.id === st.active);
    let id = st.active;
    // Guard, not a switch you have to remember: if the pen ends up aimed at a
    // layer that stores pixels, the edit lands on a path layer anyway. Silently
    // dropping it — the alternative — is a tool that stops working for a reason
    // nothing on screen explains.
    if (!cur || cur.kind !== 'path') {
      const top = [...st.layers].reverse().find((l) => l.kind === 'path');
      if (top) {
        id = top.id;
        setState(await api.setActive(id));
      } else {
        const snap = await api.addLayer('path');
        applyUpdate(snap);
        id = snap.state.active;
      }
    }
    applyUpdate(await api.setPaths(id, paths));
    if (done) {
      api.saveHistory();
      void refreshThumbs();
    }
  }, [applyUpdate, refreshThumbs]);

  /**
   * The pen brings its own layer.
   *
   * A path cannot live on a paint layer — those store pixels, and pixels are
   * the one thing a path must not be reduced to, because then it stops being
   * editable. Rather than refuse to draw (or bake it in and call it done), the
   * pen reuses the topmost path layer, or makes one. Substance Painter does the
   * same: the tool you pick decides what kind of layer you get.
   */
  useEffect(() => {
    if (tool !== 'pen') return;
    const st = stateRef.current;
    if (!st) return;
    const cur = st.layers.find((l) => l.id === st.active);
    if (cur?.kind === 'path') return;
    const top = [...st.layers].reverse().find((l) => l.kind === 'path');
    if (top) void api.setActive(top.id).then(setState);
    else void structural(api.addLayer('path'));
  }, [tool, structural]);

  /**
   * Replace the active layer's effects.
   *
   * No `done == false` case: an effect is set by a discrete click or a slider
   * release, and unlike dragging an anchor there is no gesture to coalesce —
   * one change, one history entry.
   */
  const changeEffects = useCallback(async (effects: LayerEffect[]) => {
    const id = stateRef.current?.active;
    if (!id) return;
    applyUpdate(await api.setEffects(id, effects));
    api.saveHistory();
  }, [applyUpdate]);

  /**
   * One pen slider.
   *
   * With a path selected it retunes that path; with nothing selected it sets
   * the brush the *next* path will be drawn with. Same three sliders, two
   * targets — decided by what is selected rather than by a mode, because a mode
   * is a thing you have to remember to leave.
   */
  const tunePen = (key: keyof PathBrush, v: number) => {
    if (penInfo.sel >= 0) {
      paintRef.current?.setPathBrush({ [key]: v } as Partial<PathBrush>);
      return;
    }
    if (key === 'size') setBrushSize(v);
    else if (key === 'strength') setBrushStrength(v);
    else setBrushHardness(v);
  };

  // ---------------------------------------------------------------------
  // shortcuts
  const brushAdjust = useRef<{ param: BrushParam; x: number; moved: number; t: number } | null>(null);
  const mouseX = useRef(0);

  useEffect(() => {
    // A clicked button keeps DOM focus, so Space/Enter would re-trigger it
    // instead of reaching the shortcut handler. Drop focus on mouse-up.
    const onMouseUp = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      // SELECT counts as text entry, so a drop-down left focused after a
      // choice would swallow every shortcut afterwards.
      if (el && (el.tagName === 'BUTTON' || el.tagName === 'SELECT')) el.blur();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const ev = {
        key: e.key,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
        targetTag: t?.tagName ?? null,
        editing: !!t?.isContentEditable,
      };
      const action = resolveShortcut(ev);
      if (action.type === 'none') return;
      if (shouldPrevent(ev)) e.preventDefault();

      switch (action.type) {
        case 'tool': setTool(action.tool); break;
        case 'view': setViewMode(action.mode); break;
        case 'toggle':
          if (action.what === 'arrows') setShowArrows((v) => !v);
          else if (action.what === 'anim') setAnimating((v) => !v);
          else if (action.what === 'reference') setShowReference((v) => !v);
          else if (action.what === 'flowmap') setShowFlowMap((v) => !v);
          else setShowShortcuts((v) => !v);
          break;
        // Esc drops a pen path first. With nothing down it goes back to
        // closing the help panel, so the key is never swallowed by a tool that
        // is not even selected.
        case 'closeHelp':
          if (!paintRef.current?.penCancel()) setShowShortcuts(false);
          break;
        case 'togglePanels': setShellHidden((v) => !v); break;
        case 'resetView': paintRef.current?.resetView(); break;
        case 'pen':
          if (action.op === 'commit') paintRef.current?.penCommit();
          else paintRef.current?.penPop();
          break;
        case 'undo': structural(api.undo()); break;
        case 'redo': structural(api.redo()); break;
        case 'brushSize': setBrushSize((s) => clamp(s + action.delta, 1, 200)); break;
        case 'brushAdjust':
          // Ignore key auto-repeat. Holding F fires keydown again every ~30 ms;
          // re-arming the scrub each time would zero `moved` and refresh the
          // timestamp a few ms before the key comes up, so the release would
          // always look like a "tap" — and a tap resets both views (see
          // onKeyUp). That is what made scrubbing the brush reset the 2D view.
          if (brushAdjust.current) break;
          brushAdjust.current = { param: action.param, x: mouseX.current, moved: 0, t: Date.now() };
          adjusting.current = true;
          // Deliberately NO requestPointerLock(): it makes Chromium/WebView2
          // draw its "要显示光标，请按 Esc" bubble over the canvas, complete with
          // the page origin, which instantly reads as "this is a website".
          // Raw clientX deltas below are enough to drive the adjust.
          document.body.classList.add('adjusting');
          break;
        case 'file':
          if (action.op === 'new') void doNew();
          else if (action.op === 'open') void doOpen();
          else if (action.op === 'save') void doSave(false);
          else if (action.op === 'saveAs') void doSave(true);
          else void doExport();
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'f') return;
      const st = brushAdjust.current;
      brushAdjust.current = null;
      adjusting.current = false;
      document.body.classList.remove('adjusting');
      // F tapped (short press, no drag) resets both views — the original
      // resets the 2D transform and re-centres the 3D camera.
      // Both guards matter: `moved` must be 0 modulo pointer jitter, and the
      // press must have been brief. Without the auto-repeat guard above, the
      // first guard could never fail.
      if (st && st.moved < 6 && Date.now() - st.t < 250) {
        paintRef.current?.resetView();
        previewRef.current?.resetCamera();
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const st = brushAdjust.current;
      if (!st) { mouseX.current = e.clientX; return; }
      const dx = e.clientX - st.x;
      st.moved += Math.abs(dx);
      st.x = e.clientX;
      if (st.param === 'size') setBrushSize((s) => clamp(s + dx * 0.5, 1, 200));
      else if (st.param === 'hardness') setBrushHardness((s) => clamp(s + dx * 0.005, 0, 1));
      else setBrushStrength((s) => clamp(s + dx * 0.005, 0.01, 1));
      mouseX.current = e.clientX;
    };

    // Losing focus mid-scrub would otherwise leave the ring frozen forever.
    const onBlur = () => {
      brushAdjust.current = null;
      adjusting.current = false;
      document.body.classList.remove('adjusting');
    };

    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('blur', onBlur);
    };
  }, [structural]);

  // ---------------------------------------------------------------------
  // Row 0 of the list is the top of the stack: composited last, so it covers
  // everything below it. `state.layers` is stored the other way round, hence
  // the reverse — every index used here is a *visual* index.
  const layers = state?.layers ? [...state.layers].reverse() : [];
  const activeLayer = state?.layers.find((l) => l.id === state.active);
  /**
   * The active layer's paths, identity-stable.
   *
   * Not `activeLayer?.paths ?? []` inline: that is a fresh array on every
   * render, and PaintView redraws whenever this identity changes — which would
   * mean a redraw (and a message back up here) on every render, forever.
   */
  const activePaths = useMemo(() => activeLayer?.paths ?? EMPTY_PATHS, [activeLayer]);
  const activeRow = layers.findIndex((l) => l.id === state?.active);
  const canMoveUp = activeRow > 0;
  const canMoveDown = activeRow >= 0 && activeRow < layers.length - 1;
  const moveActive = (dir: -1 | 1) => {
    if (activeRow < 0) return;
    const to = activeRow + dir;
    if (to < 0 || to >= layers.length) return;
    structural(api.reorder(activeRow, to));
  };

  const skyUrl = refSrc;
  // A path layer is painted *onto* like a paint layer — it just happens to
  // remember the geometry instead of the pixels. Only the generated kinds
  // (wind / obstacle) have no content of their own to paint into.
  const isAdj = activeLayer ? GENERATED.has(activeLayer.kind) : false;
  const canFx = activeLayer ? !NO_FX.has(activeLayer.kind) : false;

  // ---- workspace split ----
  const workspaceRef = useRef<HTMLDivElement>(null);
  const draggingSplit = useRef(false);
  const startSplit = (e: React.PointerEvent) => {
    draggingSplit.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const moveSplit = (e: React.PointerEvent) => {
    if (!draggingSplit.current) return;
    const el = workspaceRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSplitRatio(clamp((e.clientX - r.left) / r.width, 0.15, 0.85));
  };
  const endSplit = (e: React.PointerEvent) => {
    draggingSplit.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };
  /** `flex` shorthand for a pane. Only meaningful in split view. */
  const paneFlex = (which: '2d' | '3d') =>
    viewMode === 'split'
      ? `${which === '2d' ? splitRatio : 1 - splitRatio} 1 0`
      : '1 1 0';
  // Adjustment layers (wind / obstacle) have no paintable content of their own —
  // their pixels come from parameters. Painting one always edits its mask, so
  // this is forced rather than left to a UI toggle that can silently no-op.
  const effTarget: 'content' | 'mask' = isAdj ? 'mask' : 'content';
  const canPaint = true;

  if (!state) return <div className="loading">加载中…</div>;

  /** One entry point for every menu action. */
  menuCmd.current = (cmd: MenuCmd) => {
    switch (cmd) {
      case 'file.new': void doNew(); break;
      case 'file.open': void doOpen(); break;
      case 'file.save': void doSave(false); break;
      case 'file.saveAs': void doSave(true); break;
      case 'file.import': void importImage(); break;
      case 'file.export': void doExport(); break;

      case 'edit.undo': structural(api.undo()); break;
      case 'edit.redo': structural(api.redo()); break;
      case 'edit.clear':
        if (activeLayer) structural(api.clearLayer(activeLayer.id));
        break;

      case 'view.reference': setShowReference((v) => !v); break;
      case 'view.flowmap': setShowFlowMap((v) => !v); break;
      case 'view.arrows': setShowArrows((v) => !v); break;
      case 'view.anim': setAnimating((v) => !v); break;
      case 'view.panels': setShellHidden((v) => !v); break;
      case 'view.2d': setViewMode('2d'); break;
      case 'view.split': setViewMode('split'); break;
      case 'view.3d': setViewMode('3d'); break;

      case 'layer.paint': structural(api.addLayer('paint')); break;
      case 'layer.path': structural(api.addLayer('path')); break;
      case 'layer.wind': structural(api.addLayer('wind')); break;
      case 'layer.obstacle': structural(api.addLayer('obstacle')); break;
      case 'layer.up': moveActive(-1); break;
      case 'layer.down': moveActive(1); break;
      case 'layer.delete':
        if (activeLayer && state.layers.length > 1) structural(api.removeLayer(activeLayer.id));
        break;

      case 'help.shortcuts': setShowShortcuts((v) => !v); break;
    }
  };

  // -- dock -----------------------------------------------------------------
  /**
   * Which panel a viewport Y is closest to.
   *
   * Nearest rather than "contains": the 4px gaps between cards are dead space,
   * and a pointer that lands in one should still resolve to a panel instead of
   * silently dropping the reorder.
   */
  const hitDockPanel = (y: number): string | null => {
    const nodes = dockRef.current?.querySelectorAll<HTMLElement>('.panel[data-panel]');
    if (!nodes?.length) return null;
    let best: { id: string; d: number } | null = null;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (!best || d < best.d) best = { id: n.dataset.panel!, d };
    }
    return best?.id ?? null;
  };

  /** Which layer row a viewport Y is closest to. Same reasoning as above. */
  const hitLayerRow = (y: number): string | null => {
    const rows = layerListRef.current?.querySelectorAll<HTMLElement>('.layer[data-lid]');
    if (!rows?.length) return null;
    let best: { id: string; d: number } | null = null;
    for (const n of rows) {
      const r = n.getBoundingClientRect();
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (!best || d < best.d) best = { id: n.dataset.lid!, d };
    }
    return best?.id ?? null;
  };

  /** Grab a panel by its title bar. */
  const beginDockDrag = (id: PanelId) => (e: React.PointerEvent<HTMLElement>) => {
    // Clear first: a flag left over from a drag that never produced a click
    // would eat the next real one. Safe to clear here — the click we care
    // about arrives after pointerup, not before.
    swallowClick.current = false;
    beginPointerReorder(e, hitDockPanel, (over, phase) => {
      if (phase === 'move') { setDockDrag({ id, over: over as PanelId | null }); return; }
      setDockDrag(null);
      if (phase !== 'end') return;
      swallowClick.current = true;
      if (over && over !== id) reorderPanel(id, over);
    });
  };

  /** Grab a layer row. */
  const beginRowDrag = (lid: string) => (e: React.PointerEvent<HTMLElement>) => {
    swallowClick.current = false;
    beginPointerReorder(e, hitLayerRow, (over, phase) => {
      if (phase === 'move') { setRowDrag({ id: lid, over }); return; }
      setRowDrag(null);
      if (phase !== 'end') return;
      swallowClick.current = true;
      if (!over || over === lid) return;
      const from = layers.findIndex((l) => l.id === lid);
      const to = layers.findIndex((l) => l.id === over);
      if (from >= 0 && to >= 0) structural(api.reorder(from, to));
    });
  };

  /**
   * Panel bodies, keyed so the dock can render them in `panelOrder` rather
   * than in whatever order they happen to be written in.
   *
   * `props` is null while there is no active layer: it describes the selected
   * layer, so with nothing selected there is nothing to show.
   */
  const panels: Record<PanelId, React.ReactNode> = {
    props: activeLayer ? (
      <>
        <Section title={PARAM_SECT[activeLayer.kind]}>
          {activeLayer.kind === 'paint' && (
            <p className="note">
              这一层的像素是笔迹本身。大小、强度、流量、硬度都在顶部选项栏里，
              画到下层遮罩上就会在遮罩处盖住下面的图层。
            </p>
          )}
          {activeLayer.kind === 'path' && (
            <p className="note">
              这一层的像素是由路径算出来的，不是笔迹：锚点可以随时拖动、手柄可以随时
              弯、整条路径可以随时挪走，像素跟着重算。选中一条路径后，顶部选项栏的
              大小 / 强度 / 硬度就是它自己的笔刷。
            </p>
          )}
          {activeLayer.kind === 'wind' && (
            <>
              <Row label="方向" value={`${activeLayer.direction | 0}°`}>
                <Range min={0} max={360} step={1} value={activeLayer.direction}
                  onChange={(v) => updateLayer(activeLayer.id, { direction: v })} />
              </Row>
              <Row label="强度" value={`${Math.round(activeLayer.strength * 100)}%`}>
                <Range min={0} max={1} value={activeLayer.strength}
                  onChange={(v) => updateLayer(activeLayer.id, { strength: v })} />
              </Row>
            </>
          )}
          {activeLayer.kind === 'obstacle' && (
            <>
              <Toggle label="绕开障碍物流动"
                on={activeLayer.disturbance_enabled}
                onChange={(v) => updateLayer(activeLayer.id, { disturbance_enabled: v })}>
                {/* Dimmed, not removed: ticking the switch used to grow the
                    panel by a row and by that much push 边缘 and 混合 down
                    under the pointer. */}
                <Row label="范围" off={!activeLayer.disturbance_enabled}
                  value={`${Math.round(activeLayer.disturbance * 100)}%`}>
                  <Range min={0} max={1} step={0.05} value={activeLayer.disturbance}
                    onChange={(v) => updateLayer(activeLayer.id, { disturbance: v })}
                    disabled={!activeLayer.disturbance_enabled} />
                </Row>
              </Toggle>
            </>
          )}
        </Section>
        {/* 不透明度 and 模糊 are deliberately *not* here. The first is in the
            图层 panel, where Photoshop keeps it — it says how much of the layer
            you let through, which is a question about the stack, not about this
            layer's content. The second became an effect: see the `fx` badge on
            the layer row. What is left is what the layer actually *is*. */}
      </>
    ) : null,

    layers: (
      <>
        {/* An icon strip, the way PS's layer panel is built: create, reorder
            and delete are glyph buttons in one row, so the width goes to the
            thumbnails and the names instead of to six two-character labels.
            Every one carries a `title`, because a glyph with no label is a
            guess. */}
        <div className="layer-bar bleed">
          <IconBtn icon="brush" title="新建流向图层" onClick={() => structural(api.addLayer('paint'))} />
          {/* Second, right after 流向: a path layer is what the pen draws on,
              and the toolbar is where you go looking for one. */}
          <IconBtn icon="pen" title="新建路径图层（钢笔画的锚点存在这里，可反复调整）"
            onClick={() => structural(api.addLayer('path'))} />
          <IconBtn icon="wind" title="新建风向图层" onClick={() => structural(api.addLayer('wind'))} />
          <IconBtn icon="box" title="新建障碍图层" onClick={() => structural(api.addLayer('obstacle'))} />
          <span className="bar-sep" />
          {/* PS's "add a layer style" button lives in this strip, and so does
              this one: an effect is not a property of the layer, it is
              something you hang on it, so it gets an action rather than a
              slider. */}
          <IconBtn icon="fx" title={canFx ? '添加图层效果：模糊' : '障碍层由遮罩决定边缘，它没有可加的效果'}
            disabled={!canFx}
            onClick={() => activeLayer && changeEffects(addEffect(activeLayer.effects, 'blur'))} />
          <span className="bar-sep" />
          {/* Keyboard- and pointer-reachable reordering. Drag and drop works
              too, but it is undiscoverable on its own. */}
          <IconBtn icon="up" title="上移一层（越靠上越晚合成，即覆盖下方图层）"
            disabled={!canMoveUp} onClick={() => moveActive(-1)} />
          <IconBtn icon="down" title="下移一层（越靠下越早合成，即被上方图层覆盖）"
            disabled={!canMoveDown} onClick={() => moveActive(1)} />
          <span className="bar-sep" />
          <IconBtn icon="trash" danger title="删除图层"
            disabled={state.layers.length <= 1}
            onClick={() => activeLayer && structural(api.removeLayer(activeLayer.id))} />
        </div>

        {/* 不透明度 sits here, above the list, exactly where Photoshop puts it
            — not in the 属性 panel. It is not a fact about this layer's
            content; it is how much of the stack below you let through, which
            is a question about the stack. 属性 is left holding what the layer
            actually *is*. */}
        {activeLayer && (
          <Row label="不透明度" value={`${Math.round(activeLayer.opacity * 100)}%`}>
            <Range min={0} max={1} value={activeLayer.opacity}
              title="这一层透下去多少。整条图层栈每一层的这个数共同决定最终画面。"
              onChange={(v) => updateLayer(activeLayer.id, { opacity: v })} />
          </Row>
        )}

        <div className="layer-list bleed" ref={layerListRef}>
          {layers.map((l) => {
            const meta = KIND_META[l.kind];
            const active = l.id === state.active;
            return (
              <div
                key={l.id}
                data-lid={l.id}
                onPointerDown={beginRowDrag(l.id)}
                className={`layer ${active ? 'active' : ''} ${
                  rowDrag && rowDrag.over === l.id && rowDrag.id !== l.id ? 'drop-target' : ''
                } ${rowDrag?.id === l.id ? 'dragging' : ''}`}
                title={`${meta.label} · ${l.name}`}
                onClick={async () => {
                  if (swallowClick.current) { swallowClick.current = false; return; }
                  setState(await api.setActive(l.id));
                }}
              >
                {/* The visibility column sits in its own fixed width so every
                    glyph lines up down the list, which is the whole reason the
                    column reads as a column. PS shows an eye for a visible
                    layer and a hollow square for a hidden one — scanning a
                    column of eyes against boxes answers "which of these are
                    on" without reading a single row. */}
                <button className={`eye ${l.visible ? 'shown' : ''}`}
                  title={l.visible ? '隐藏图层' : '显示图层'}
                  aria-label={l.visible ? '隐藏图层' : '显示图层'}
                  onClick={(e) => { e.stopPropagation(); updateLayer(l.id, { visible: !l.visible }); }}>
                  <ToolIcon name={l.visible ? 'eye' : 'sq'} size={15} />
                </button>

                {/* Thumbnail of the layer's own pixels, on a checkerboard when
                    it is empty — Photoshop's language for "nothing here yet".
                    The plate takes the kind colour so the row still says what
                    it is once the name is elided. */}
                <span className="layer-thumb" style={{ borderColor: `${meta.color}66` }}>
                  {thumbs[l.id] && <img src={thumbs[l.id]} alt="" />}
                </span>

                <span className="ellipsis name">{l.name}</span>

                {GENERATED.has(l.kind) && active && (
                  // Not a toggle: painting an adjustment layer always edits its
                  // mask. A "参数/遮罩" switch here could silently eat brush
                  // strokes, which is exactly the bug it caused.
                  <span className="chip hint" title="绘制即编辑遮罩">遮罩</span>
                )}

                {/* The `fx` badge. Carried by every layer that has effects, not
                    only the selected one: it has to be visible for a layer you
                    are not on, or you cannot tell which layers are doing
                    something to their pixels. */}
                {l.effects.length > 0 && (
                  <span className="chip fx-badge"
                    title={l.effects.map((e) => FX_META[e.kind].label).join('、')}>
                    fx
                  </span>
                )}

                {/* Reordering handle. The whole row is draggable, so this is an
                    affordance rather than the only target — it fades in on
                    hover so it does not read as a column of its own. */}
                <span className="grip" title="拖动调整图层顺序">⋮⋮</span>
              </div>
            );
          })}
        </div>

        {/* Effects of the selected layer, listed under its row the way PS
            indents them under the layer they hang on. Only the selected one:
            every layer's effects at once would be a wall of sliders, and you
            can only edit one layer's at a time anyway. */}
        {activeLayer && activeLayer.effects.length > 0 && (
          <div className="fx-list">
            {activeLayer.effects.map((e, ei) => {
              const m = FX_META[e.kind];
              return (
                <div key={ei} className={`fx-row ${e.enabled ? '' : 'off'}`}>
                  <button className={`eye ${e.enabled ? 'shown' : ''}`}
                    title={e.enabled ? `停用${m.label}` : `启用${m.label}`}
                    aria-label={e.enabled ? `停用${m.label}` : `启用${m.label}`}
                    onClick={() =>
                      changeEffects(setEffectEnabled(activeLayer.effects, ei, !e.enabled))}>
                    <ToolIcon name={e.enabled ? 'eye' : 'sq'} size={13} />
                  </button>
                  <span className="fx-name ellipsis">{m.label}</span>
                  <Range min={m.min} max={m.max} step={m.step} value={e.amount}
                    title={m.title} disabled={!e.enabled}
                    onChange={(v) =>
                      changeEffects(setEffectAmount(activeLayer.effects, ei, v))} />
                  <span className="fx-val">{e.amount | 0}</span>
                  <button className="fx-del" title={`删除${m.label}`}
                    aria-label={`删除${m.label}`}
                    onClick={() => changeEffects(removeEffect(activeLayer.effects, ei))}>
                    <ToolIcon name="x" size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </>
    ),

    /* Everything that used to hang over the canvas, each switch sitting on the
       parameters it governs — see <Toggle>. */
    view: (
      <>
        <Section title="叠加">
          <Toggle label="天空贴图" on={showReference} onChange={setShowReference}>
            <Row label="不透明度" off={!showReference}
              value={`${Math.round(referenceOpacity * 100)}%`}>
              <Range min={0} max={1} value={referenceOpacity}
                onChange={setReferenceOpacity} disabled={!showReference} />
            </Row>
          </Toggle>
          <Toggle label="叠加 Flowmap" on={showFlowMap} onChange={setShowFlowMap}>
            <Row label="不透明度" off={!showFlowMap}
              value={`${Math.round(flowMapOpacity * 100)}%`}>
              <Range min={0} max={1} value={flowMapOpacity}
                onChange={setFlowMapOpacity} disabled={!showFlowMap} />
            </Row>
          </Toggle>
          <Toggle label="流向箭头" on={showArrows} onChange={setShowArrows}>
            <Row label="密度" off={!showArrows} value={String(arrowDensity)}>
              <Range min={16} max={128} step={4} value={arrowDensity}
                onChange={setArrowDensity} disabled={!showArrows} />
            </Row>
          </Toggle>
        </Section>

        {/* 速度 and 强度 both answer to 播放动画, which is the case a flat list
            cannot express: two rows, one switch. */}
        <Section title="动画">
          <Toggle label="播放动画" on={animating} onChange={setAnimating}>
            <Row label="速度" off={!animating} value={speed.toFixed(2)}>
              <Range min={0} max={2} step={0.05} value={speed}
                onChange={setSpeed} disabled={!animating} />
            </Row>
            <Row label="强度" off={!animating} value={distortion.toFixed(2)}>
              <Range min={0} max={0.5} value={distortion}
                onChange={setDistortion} disabled={!animating} />
            </Row>
          </Toggle>
        </Section>
      </>
    ),

    /* 投影 and 图片源 are both "what kind of document is this": set once, then
       never touched again while painting. One folded panel instead of two. */
    document: (
      <>
        <Section title="投影">
          <div className="seg">
            {([['equirectangular', '球面'], ['polar', '极坐标'], ['planar', '平面']] as const).map(([k, label]) => (
              <button key={k} className={state.projection === k ? 'on' : ''}
                onClick={async () => applyUpdate(await api.setProjection(k, state.polar_angle))}>
                {label}
              </button>
            ))}
          </div>
          {/* 张角 only means something for 极坐标, but it still lives here
              permanently — switching projection used to shift 天空贴图 up and
              down by a row. Dimmed, it also advertises that 极坐标 has an
              extra parameter. */}
          <Row label="张角" off={state.projection !== 'polar'}
            value={`${state.polar_angle | 0}°`}>
            <Range min={45} max={180} step={1} value={state.polar_angle}
              disabled={state.projection !== 'polar'}
              onChange={async (v) => {
                applyUpdate(await api.setProjection('polar', v));
              }} />
          </Row>
        </Section>

        <Section title="天空贴图">
          <button className="dropzone" onClick={() => importImage()}>
            <span>点击选择天空贴图</span>
            <small>等距柱状投影 2:1 / 极坐标 / 平面</small>
          </button>
          {state.reference_path && (
            <div className="thumb-row">
              {refSrc && <img src={refSrc} alt="" className="thumb" />}
              <div className="thumb-meta">
                <div className="ellipsis">{state.reference_path.split(/[\\/]/).pop()}</div>
                <button className="link" onClick={async () => {
                  setState(await api.clearReference());
                  setRefSrc(null);
                }}>移除</button>
              </div>
            </div>
          )}
        </Section>
      </>
    ),

    export: (
      <>
        <Section title="输出">
          <Row label="分辨率">
            <select value={exportRes} onChange={(e) => setExportRes(Number(e.target.value))}>
              {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}²</option>)}
            </select>
          </Row>
          <div className="checks">
            <label><input type="checkbox" checked={invertX} onChange={(e) => setInvertX(e.target.checked)} /> 反转 R</label>
            <label><input type="checkbox" checked={invertY} onChange={(e) => setInvertY(e.target.checked)} /> 反转 G</label>
          </div>
        </Section>
        <button className="primary wide" onClick={doExport}>导出 Flowmap</button>
      </>
    ),
  };

  /** Titles. 属性's is contextual, so it cannot be a constant. */
  const panelTitle: Record<PanelId, string> = {
    props: activeLayer ? `${KIND_META[activeLayer.kind].label}属性` : '属性',
    layers: '图层',
    view: '视图',
    document: '文档',
    export: '导出',
  };

  return (
    <div className="app">
      {/* Title bar and menu bar are one row: `decorations` is off, so the
          window has no frame of its own and this bar carries both the menus
          and the minimise / maximise / close buttons. Always visible — Tab
          hides the tool chrome, not the window controls. */}
      <AppBar
        recent={recent}
        docName={state.project_path ? state.project_path.split(/[\\/]/).pop()! : '未命名工程'}
        dirty={!state.project_path}
        state={{
          reference: showReference,
          flowmap: showFlowMap,
          arrows: showArrows,
          anim: animating,
          panels: shellHidden,
          mode: viewMode,
        }}
        run={(cmd) => menuCmd.current(cmd)}
        openPath={(p) => void doOpen(p)}
      />

      {!shellHidden && (
        <div className="optionsbar">
          <span className="ob-tool">{TOOLS.find((t) => t.tool === tool)?.label ?? tool}</span>
          <span className="ob-sep" />

          {(tool === 'brush' || tool === 'eraser') && (
            <>
              <Slider label="大小" value={brushSize} min={1} max={200} step={1} onChange={setBrushSize} display={String(brushSize | 0)} />
              <Slider label="强度" value={brushStrength} min={0.01} max={1} step={0.01} onChange={setBrushStrength}
                title="想画到的流动强度上限（类似 Photoshop 的前景色）。反复涂抹只会趋近这个值，不会越涂越强。" />
              <Slider label="流量" value={brushFlow} min={0.01} max={1} step={0.01} onChange={setBrushFlow}
                title="每一笔走完「到强度上限的剩余距离」的比例（类似 Photoshop 的流量）。流量 1 一笔到位；流量 0.25 要涂七八笔才接近上限，中间会把下层风向平滑地掰过来。" />
              <Slider label="硬度" value={brushHardness} min={0} max={1} step={0.01} onChange={setBrushHardness} />
            </>
          )}

          {tool === 'pen' && (
            <>
              {/* With a path selected these three describe *that path*, not the
                  brush you would draw the next one with — which is the whole
                  substance of "non-destructive": the stroke keeps its own
                  settings and you can retune it after the fact. */}
              <Slider label="大小" value={penInfo.brush?.size ?? brushSize} min={1} max={200} step={1}
                onChange={(v) => tunePen('size', v)} display={String((penInfo.brush?.size ?? brushSize) | 0)} />
              <Slider label="强度" value={penInfo.brush?.strength ?? brushStrength} min={0.01} max={1} step={0.01}
                onChange={(v) => tunePen('strength', v)}
                title="这条路径想画到的流动强度上限。路径只画一遍，所以一笔就是到位，流量对钢笔没有意义。" />
              <Slider label="硬度" value={penInfo.brush?.hardness ?? brushHardness} min={0} max={1} step={0.01}
                onChange={(v) => tunePen('hardness', v)} />
              {penInfo.sel >= 0 && (
                <button className="ob-btn" title="删除选中的路径（Backspace）"
                  onClick={() => paintRef.current?.penPop()}>删除路径</button>
              )}
              <span className="ob-hint">
                {penInfo.anchors > 0
                  ? `${penInfo.anchors} 个锚点${penInfo.closed ? ' · 已闭合' : ''} · Enter 落笔 · Backspace 退一个 · Esc 放弃`
                  : penInfo.sel >= 0
                    ? '拖动锚点改形状 · 拖手柄改弧度 · 拖线身整体移动 · Alt+锚点删除 · Alt+线身加锚点'
                    : '点击放置锚点 · 拖动调弧度 · 点首个锚点闭合 · Enter 落笔 · 点已有路径可选中重编'}
              </span>
              {/* The 3D view has no path overlay — see paintEnabled below. */}
              {viewMode === '3d' && (
                <span className="ob-hint warn">钢笔目前只在 2D / 分屏视图可用（按 1 或 2）</span>
              )}
            </>
          )}

          {tool === 'magic_wand' && (
            <Slider label="容差" value={magicThreshold} min={1} max={100} step={1} onChange={setMagicThreshold} display={String(magicThreshold)} />
          )}

          {tool === 'eyedropper' && (
            <span className="ob-hint">在 2D 或 3D 视图中点击，把该处的流动强度设为笔刷强度</span>
          )}

          {tool === 'pan' && (
            <span className="ob-hint">拖动平移 2D 视图（3D 视角用右键 / 中键）</span>
          )}

          <div className="spacer" />

          <div className="slider" title="吸管取样范围，和 Photoshop 的取样选项一致。">
            <span>取样</span>
            <select value={sampleSource}
              onChange={(e) => setSampleSource(e.target.value as 'layer' | 'composite')}>
              <option value="layer">当前图层</option>
              <option value="composite">合成结果</option>
            </select>
          </div>

          <div className="spacer" />

          {/* Far right end of the options bar is where PS puts the screen-mode
              switch. It used to sit in the HTML title bar, which is gone. */}
          <div className="menu-group segmented">
            {(['2d', 'split', '3d'] as ViewMode[]).map((m) => (
              <button key={m} className={viewMode === m ? 'on' : ''} onClick={() => setViewMode(m)}>
                {m === '2d' ? '2D 绘制' : m === 'split' ? '分屏' : '3D 预览'}
              </button>
            ))}
          </div>
        </div>
      )}

      <main className="body">
        {!shellHidden && (
          <nav className="toolbox">
            {TOOLS.map((t) => (
              <button
                key={t.tool}
                className={`tool ${tool === t.tool ? 'on' : ''}`}
                title={`${t.label}（${t.key}）`}
                onClick={() => setTool(t.tool)}
              >
                <ToolIcon name={t.icon} />
                <span className="tool-key">{t.key}</span>
              </button>
            ))}
          </nav>
        )}

        {/* Nothing floats over the canvas any more. The four view toggles and
            their five sliders moved into the 视图 panel — Photoshop never hangs
            controls over the artwork, and a bar down the middle of a skybox is
            exactly the thing you are trying to look at. */}
        <div className="workspace" ref={workspaceRef}>
          <div className={`pane ${viewMode === '3d' ? 'hidden' : ''}`} style={{ flex: paneFlex('2d') }}>
            <PaintView
              ref={paintRef}
              size={state.size}
              tool={tool}
              paths={activePaths}
              layerId={state.active}
              onPathsChange={changePaths}
              brushSize={brushSize}
              brushHardness={brushHardness}
              brushStrength={brushStrength}
              brushFlow={brushFlow}
              sampleSource={sampleSource}
              onPickStrength={setBrushStrength}
              onZoom={setZoom2d}
              editTarget={effTarget}
              magicThreshold={magicThreshold}
              showReference={showReference}
              referenceOpacity={referenceOpacity}
              referenceSrc={refSrc}
              showArrows={showArrows}
              arrowDensity={arrowDensity}
              wrap={state.projection !== 'planar'}
              cursorUV={sharedCursor}
              adjusting={adjusting}
              onStrokeEnd={() => { api.saveHistory(); void refreshThumbs(); }}
              onFillEnd={() => { api.saveHistory(); void refreshThumbs(); }}
              onPenInfo={setPenInfo}
            />
          </div>

          {viewMode === 'split' && (
            <div
              className="splitter"
              title="拖动调整 2D / 3D 的占比"
              onPointerDown={startSplit}
              onPointerMove={moveSplit}
              onPointerUp={endSplit}
              onPointerCancel={endSplit}
            >
              <span className="splitter-grip" />
            </div>
          )}

          <div className={`pane ${viewMode === '2d' ? 'hidden' : ''}`} style={{ flex: paneFlex('3d') }}>
            <Preview3D
              ref={previewRef}
              flowCanvasRef={flowCanvasRef}
              flowVersionRef={flowVersionRef}
              skyUrl={skyUrl}
              speed={animating ? speed : 0}
              distortion={distortion}
              showFlowMap={showFlowMap}
              flowMapOpacity={flowMapOpacity}
              showArrows={showArrows}
              arrowDensity={arrowDensity}
              brushSize={brushSize}
              canvasSize={state.size}
              brushStrength={brushStrength}
              brushHardness={brushHardness}
              cursorUV={sharedCursor}
              adjusting={adjusting}
              projection={state.projection}
              polarAngle={state.polar_angle}
              tool={tool}
              // The pen is off in the 3D view: a path needs an overlay drawn in
              // the same space as the pixels it will become, and the 3D view
              // has no such layer — it would fall through to `onPaint`'s
              // catch-all and behave as a brush, which is worse than nothing.
              paintEnabled={canPaint && viewMode !== '2d' && tool !== 'pen'}
              onPaint={(u, v, lu, lv) => {
                api.stroke([[lu, lv], [u, v]], brushSize, brushHardness, brushStrength,
                  toolRef.current === 'eraser', effTarget, stroke3d.current, brushFlow).then(applySnap);
              }}
              onFill={(u, v) => {
                api.floodFill(u, v, magicThreshold, effTarget)
                  .then((s) => { applySnap(s); api.saveHistory(); void refreshThumbs(); });
              }}
              onPick={(u, v) => {
                api.sampleStrength(u, v, sampleSource).then((s) => {
                  if (s > 0) setBrushStrength(s);
                });
              }}
              onPaintEnd={() => {
                // One drag in the 3D view is one stroke, however many segments
                // it took. Retire the id here so the next drag deposits again.
                stroke3d.current = nextStrokeId();
                api.saveHistory();
                void refreshThumbs();
              }}
            />
          </div>
        </div>

        {!shellHidden && (
          <aside className="panels" ref={dockRef}>
            {panelOrder.filter((pid) => panels[pid] !== null).map((pid) => (
              <Panel
                key={pid}
                id={pid}
                title={panelTitle[pid]}
                grow={pid === 'layers'}
                collapsed={!!collapsed[pid]}
                onToggle={() => {
                  // A drag ends with a click on the header it started from;
                  // that click must not also fold the panel.
                  if (swallowClick.current) { swallowClick.current = false; return; }
                  togglePanel(pid);
                }}
                onHeadDown={beginDockDrag(pid)}
                cls={[
                  dockDrag?.id === pid ? 'dragging' : '',
                  // PS marks the drop slot with a blue rule on the edge the
                  // panel will land against. Without it a reorder is invisible
                  // until it is already done.
                  dockDrag && dockDrag.over === pid && dockDrag.id !== pid ? 'drop-above' : '',
                ].filter(Boolean).join(' ')}
              >
                {panels[pid]}
              </Panel>
            ))}
            {/* 最近打开 is gone from here on purpose: it is 文件 > 打开最近 now,
                which is where every program with a File menu puts it. A list of
                file paths is not document state and does not belong in the
                panel column. */}
          </aside>
        )}
      </main>

      <footer className="statusbar">
        {/* The document name moved up to the app bar (PS puts it on the title
            bar / document tab); this row is measurements only. */}
        <span className="st-item">{state.size}²</span>
        <span className="st-item">缩放 {Math.round(zoom2d * 100)}%</span>
        <span className="st-item" ref={perfRef} title="单次全图层合成耗时">合成 —</span>
        <div className="spacer" />
        {activeLayer && (
          <span className="st-item target-chip" style={{ color: KIND_META[activeLayer.kind].color }}>
            {isAdj ? `${activeLayer.name} · 遮罩` : activeLayer.name}
          </span>
        )}
        {busy && <span className="st-item busy">处理中…</span>}
        {shellHidden && <span className="st-item dim">Tab 恢复面板</span>}
      </footer>

      {showShortcuts && (
        <div className="shortcuts">
          <b>快捷键</b>
          {SHORTCUT_HELP.map(([n, k]) => (<div key={n}><span>{n}</span><kbd>{k}</kbd></div>))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * A right-hand panel. Photoshop's panels fold to a title bar only, which is
 * what makes the panel column usable: you keep the layers open and shut
 * everything you are not touching. The same title bar is the drag handle for
 * reordering the dock, which is why `onHeadDown` lands on it and not on the
 * section wrapper — the wrapper would make every slider in the panel body a
 * drag source too.
 *
 * The header is a real button so it is keyboard reachable; `data-panel` is
 * there for the tests (and for the hit-test during a drag) to latch onto.
 */
function Panel({ id, title, children, collapsed, onToggle, grow, cls, onHeadDown }:
  { id: string; title: string; children: React.ReactNode; collapsed: boolean;
    onToggle: () => void; grow?: boolean; cls?: string;
    onHeadDown: (e: React.PointerEvent<HTMLElement>) => void }) {
  return (
    <section
      className={`panel ${collapsed ? 'collapsed' : ''} ${grow ? 'grow' : ''} ${cls ?? ''}`}
      data-panel={id}
    >
      <button className="panel-head" onClick={onToggle} onPointerDown={onHeadDown}
        aria-expanded={!collapsed}
        title={`${title} · 点击折叠，拖动标题栏可重排`}>
        <span className="chev"><ToolIcon name={collapsed ? 'right' : 'down'} size={12} /></span>
        <span className="ellipsis">{title}</span>
      </button>
      {!collapsed && <div className="panel-body">{children}</div>}
    </section>
  );
}

/**
 * A titled group inside a panel, and the single biggest reason the panels now
 * read as Photoshop's: PS's 属性 panel is three of these (变换 / 对齐并分布 /
 * 快速操作) divided by full-bleed rules, not one flat list of controls. The rule
 * spans the whole panel width while the header text stays inset, which is what
 * makes a section boundary legible without a border around every group.
 *
 * Groups also give conditional controls somewhere to live. A 视图 panel whose
 * 参数 section appears only when at least one overlay is on is one panel and
 * one rule, instead of six rows that come and go inside a flat list.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="sect">
      <button className="sect-head" aria-expanded={open}
        onClick={() => setOpen((v) => !v)} title={title}>
        <span className="chev"><ToolIcon name={open ? 'down' : 'right'} size={12} /></span>
        <span className="ellipsis">{title}</span>
      </button>
      {open && <div className="sect-body">{children}</div>}
    </section>
  );
}

/**
 * A labelled control row.
 *
 * Photoshop's panel fields are three columns: a small label, the control, and a
 * *boxed* number on the right. The box is the part that carries the "this is a
 * value, not a caption" reading, so `value` renders as a real inset field
 * rather than coloured text floating on the panel.
 *
 * The field is not editable. Every one of these rows already has a slider, and
 * a text input here would mean the global shortcut handler has to keep
 * swallowing keystrokes it currently only inspects — typing "B" into 角度 must
 * not switch to the brush. Arrow keys on the focused slider already do the job.
 *
 * `off` dims the row instead of unmounting it. Conditional controls are what
 * make a panel *jump*: ticking one checkbox in 视图 used to insert a whole
 * section plus a row, pushing everything below it down by ~60px, and the
 * pointer that was about to land on the next control landed on nothing. PS
 * keeps such controls in place and greys them out, so the panel's height is a
 * function of the panel, not of the current state.
 */
function Row({ label, value, children, off }:
  { label: string; value?: string; children?: React.ReactNode; off?: boolean }) {
  return (
    <div className={`row ${off ? 'off' : ''}`} aria-disabled={off ? true : undefined}>
      <span className="row-label">{label}</span>
      {children}
      {value !== undefined && <span className="row-value" title="拖动左侧滑块调节">{value}</span>}
    </div>
  );
}

/**
 * Panel slider: a recessed groove with a filled track.
 *
 * The fill is a CSS gradient driven by `--p` rather than a separate element,
 * because a range input's track *is* its background — one custom property gets
 * PS's filled track with no wrapper between the pointer and the control. That
 * matters: a wrapper with `overflow: hidden` would clip the thumb.
 */
function Range({ value, min, max, step = 0.01, onChange, title, disabled }:
  { value: number; min: number; max: number; step?: number;
    onChange: (v: number) => void; title?: string; disabled?: boolean }) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      className="rng"
      type="range"
      min={min} max={max} step={step} value={value}
      title={title}
      disabled={disabled}
      style={{ '--p': `${pct}%` } as React.CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

/**
 * A switch, with the parameters it governs nested underneath it.
 *
 * 视图 used to be a grid of four checkboxes in one section and five sliders in
 * another, labelled 贴图 / 叠加 / 密度 / 速度 / 强度. Nothing said which switch
 * went with which slider, and 速度 / 强度 both answered to 播放动画 while only
 * one of them was anywhere near it. This is PS's 图层样式 grammar instead:
 * ticking an effect reveals that effect's own settings, indented under it, so
 * ownership is a matter of geometry rather than of remembering.
 *
 * The switch is a real `<label>`, so its text is part of the hit target — a
 * 13px checkbox alone is a fiddly click, and the name is what you are aiming
 * at anyway.
 *
 * The switch stays lit even when what it governs is dimmed. It is the control
 * you use to switch those parameters back on; a greyed-out control you are
 * supposed to click is a contradiction.
 */
function Toggle({ label, on, onChange, children }:
  { label: string; on: boolean; onChange: (v: boolean) => void;
    children?: React.ReactNode }) {
  return (
    <div className="tog-group">
      <label className="tog" title={`${on ? '关闭' : '开启'}${label}`}>
        <input type="checkbox" checked={on}
          onChange={(e) => onChange(e.target.checked)} />
        <span className="ellipsis">{label}</span>
      </label>
      {/* 19px = the checkbox plus its gap, so the parameters line up with the
          switch's text rather than with the box. */}
      {children && <div className="tog-body">{children}</div>}
    </div>
  );
}

/** A square glyph button, the way PS builds a panel's own toolbar. */
function IconBtn({ icon, title, onClick, disabled, danger }:
  { icon: string; title: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      className={`pbtn ${danger ? 'danger' : ''}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      <ToolIcon name={icon} size={15} />
    </button>
  );
}

function Slider({ label, value, min = 0, max = 1, step = 0.01, onChange, display, title }:
  { label: string; value: number; min?: number; max?: number; step?: number;
    onChange: (v: number) => void; display?: string; title?: string }) {
  return (
    <div className="slider" title={title}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
      <b>{display ?? value.toFixed(2)}</b>
    </div>
  );
}

