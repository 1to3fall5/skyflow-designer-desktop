import React, { useCallback, useEffect, useRef, useState } from 'react';
import { open, save, message } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { api, nextStrokeId, AppState, LayerInfo, LayerKind, Snapshot } from './api';
import { resolveShortcut, shouldPrevent, SHORTCUT_HELP, type BrushParam, type Tool } from './shortcuts';
import type { CursorUV } from './cursor';
import PaintView, { PaintViewHandle } from './components/PaintView';
import Preview3D, { Preview3DHandle } from './components/Preview3D';
import { ToolIcon } from './icons';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type ViewMode = '2d' | 'split' | '3d';

/** Toolbox entries. `key` is also the shortcut, so the two cannot drift. */
const TOOLS: Array<{ tool: Tool; icon: string; label: string; key: string }> = [
  { tool: 'brush', icon: 'brush', label: '画笔', key: 'B' },
  { tool: 'eraser', icon: 'eraser', label: '橡皮擦', key: 'E' },
  { tool: 'magic_wand', icon: 'wand', label: '魔棒', key: 'M' },
  { tool: 'eyedropper', icon: 'pipette', label: '吸管', key: 'I' },
  { tool: 'pan', icon: 'hand', label: '平移', key: 'H' },
];

/** Right-hand panel ids, in display order. */
const PANEL_IDS = ['layers', 'props', 'projection', 'source', 'export', 'recent'] as const;
type PanelId = typeof PANEL_IDS[number];

const KIND_META: Record<LayerKind, { label: string; color: string }> = {
  paint: { label: '流向', color: '#10b981' },
  wind: { label: '风向', color: '#8b5cf6' },
  obstacle: { label: '障碍物', color: '#f43f5e' },
};

const RESOLUTIONS = [512, 1024, 2048, 4096];

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('split');
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
  const [dragOver, setDragOver] = useState<number | null>(null);
  /** Backend-encoded PNG of the reference image (TGA-safe display path). */
  const [refSrc, setRefSrc] = useState<string | null>(null);

  // ---- shell layout (Photoshop-style) ----
  /** Which right-hand panels are folded. Nothing starts folded. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /** Tab: hide the toolbox, the panels and the options bar. PS calls this
   *  "collapse all panels" and it is the single most useful key when painting. */
  const [shellHidden, setShellHidden] = useState(false);
  /** 2D pane share of the workspace in split view. */
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [zoom2d, setZoom2d] = useState(1);
  const togglePanel = (id: PanelId) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const paintRef = useRef<PaintViewHandle>(null);
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
      setRecent(await api.getRecent());
    })();
  }, [applySnap, reloadRef]);

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
  };

  // ---------------------------------------------------------------------
  const updateLayer = useCallback(async (id: string, patch: Partial<LayerInfo>) => {
    applyUpdate(await api.updateLayer({ id, ...patch } as never));
  }, [applyUpdate]);

  const structural = useCallback(async (promise: Promise<Snapshot>) => {
    const snap = await promise;
    applyUpdate(snap);
    paintRef.current?.refreshArrows();
  }, [applyUpdate]);

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
        case 'closeHelp': setShowShortcuts(false); break;
        case 'togglePanels': setShellHidden((v) => !v); break;
        case 'resetView': paintRef.current?.resetView(); break;
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
  const isAdj = activeLayer ? activeLayer.kind !== 'paint' : false;

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

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark" />
          <b>SkyFlow</b><span className="brand-sub">Designer</span>
        </div>

        <div className="menu-group">
          <button onClick={doNew}>新建</button>
          <button onClick={() => doOpen()}>打开</button>
          <button onClick={() => doSave(false)}>保存</button>
          <button onClick={() => doSave(true)}>另存为</button>
        </div>
        <div className="menu-group">
          <button onClick={() => importImage()}>导入天空图</button>
          <button className="primary" onClick={doExport}>导出贴图</button>
        </div>

        <div className="spacer" />

        <div className="menu-group segmented">
          {(['2d', 'split', '3d'] as ViewMode[]).map((m) => (
            <button key={m} className={viewMode === m ? 'on' : ''} onClick={() => setViewMode(m)}>
              {m === '2d' ? '2D 绘制' : m === 'split' ? '分屏' : '3D 预览'}
            </button>
          ))}
        </div>
        <div className="project-name">
          {state.project_path ? state.project_path.split(/[\\/]/).pop() : '未命名工程'}
          {state.project_path ? '' : ' *'}
        </div>
      </header>

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

        <div className="workspace" ref={workspaceRef}>
          {/* ---- floating viewport toolbar ---- */}
          <div className="float-bar">
            <IconBtn on={showReference} onClick={() => setShowReference((v) => !v)} label="显示贴图">▤</IconBtn>
            <IconBtn on={showFlowMap} onClick={() => setShowFlowMap((v) => !v)} label="叠加 Flowmap">◫</IconBtn>
            <IconBtn on={animating} onClick={() => setAnimating((v) => !v)} label="播放动画">▶</IconBtn>
            <IconBtn on={showArrows} onClick={() => setShowArrows((v) => !v)} label="流向箭头">➤</IconBtn>
            {showReference && (
              <Slider label="贴图" value={referenceOpacity} onChange={setReferenceOpacity} />
            )}
            {showFlowMap && (
              <Slider label="叠加" value={flowMapOpacity} onChange={setFlowMapOpacity} />
            )}
            {animating && (
              <>
                <Slider label="速度" value={speed} min={0} max={2} step={0.05} onChange={setSpeed} />
                <Slider label="强度" value={distortion} min={0} max={0.5} step={0.01} onChange={setDistortion} />
              </>
            )}
            {showArrows && (
              <Slider label="密度" value={arrowDensity} min={16} max={128} step={4}
                onChange={setArrowDensity} display={String(arrowDensity)} />
            )}
          </div>

          <div className={`pane ${viewMode === '3d' ? 'hidden' : ''}`} style={{ flex: paneFlex('2d') }}>
            <PaintView
              ref={paintRef}
              size={state.size}
              tool={tool}
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
              onStrokeEnd={() => { api.saveHistory(); }}
              onFillEnd={() => { api.saveHistory(); }}
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
              paintEnabled={canPaint && viewMode !== '2d'}
              onPaint={(u, v, lu, lv) => {
                api.stroke([[lu, lv], [u, v]], brushSize, brushHardness, brushStrength,
                  toolRef.current === 'eraser', effTarget, stroke3d.current, brushFlow).then(applySnap);
              }}
              onFill={(u, v) => {
                api.floodFill(u, v, magicThreshold, effTarget)
                  .then((s) => { applySnap(s); api.saveHistory(); });
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
              }}
            />
          </div>
        </div>

        {!shellHidden && (
          <aside className="panels">
            <Panel id="layers" title="图层" grow
              collapsed={!!collapsed.layers} onToggle={() => togglePanel('layers')}>
              <div className="layer-tools">
                <button onClick={() => structural(api.addLayer('paint'))} title="新建流向图层">＋ 流向</button>
                <button onClick={() => structural(api.addLayer('wind'))} title="新建风向图层">＋ 风向</button>
                <button onClick={() => structural(api.addLayer('obstacle'))} title="新建障碍图层">＋ 障碍</button>
                <button className="danger"
                  onClick={() => activeLayer && state.layers.length > 1 && structural(api.removeLayer(activeLayer.id))}
                  title="删除图层">－</button>
                {/* Keyboard-reachable reordering. Drag and drop works too, but it
                    is undiscoverable and the row is mostly child elements. */}
                <button className="nudge" disabled={!canMoveUp} onClick={() => moveActive(-1)}
                  title="上移一层（越靠上越晚合成，即覆盖下方图层）">▲</button>
                <button className="nudge" disabled={!canMoveDown} onClick={() => moveActive(1)}
                  title="下移一层（越靠下越早合成，即被上方图层覆盖）">▼</button>
              </div>
              <div className="layer-list">
                {layers.map((l, i) => {
                  const meta = KIND_META[l.kind];
                  const active = l.id === state.active;
                  return (
                    <div
                      key={l.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', String(i));
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(i); }}
                      onDragLeave={() => setDragOver((d) => (d === i ? null : d))}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(null);
                        const from = Number(e.dataTransfer.getData('text/plain'));
                        if (from !== i) structural(api.reorder(from, i));
                      }}
                      onDragEnd={() => setDragOver(null)}
                      className={`layer ${active ? 'active' : ''} ${dragOver === i ? 'drop-target' : ''}`}
                      style={active ? { borderColor: meta.color, boxShadow: `0 0 0 1px ${meta.color}55` } : undefined}
                      onClick={async () => { setState(await api.setActive(l.id)); }}
                    >
                      <span className="grip" title="拖动调整图层顺序">⋮⋮</span>
                      <span className="badge" style={{ background: `${meta.color}22`, color: meta.color }}>{meta.label}</span>
                      <span className="ellipsis name">{l.name}</span>
                      {l.kind !== 'paint' && active && (
                        // Not a toggle: painting an adjustment layer always edits
                        // its mask. A "参数/遮罩" switch here could silently eat
                        // brush strokes, which is exactly the bug it caused.
                        <span className="chip hint" title="绘制即编辑遮罩">遮罩</span>
                      )}
                      <button className="eye" onClick={(e) => { e.stopPropagation(); updateLayer(l.id, { visible: !l.visible }); }}>
                        {l.visible ? '◉' : '○'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </Panel>

            {activeLayer && (
              <Panel id="props" title={`${KIND_META[activeLayer.kind].label}属性`}
                collapsed={!!collapsed.props} onToggle={() => togglePanel('props')}>
                {activeLayer.kind === 'wind' && (
                  <>
                    <Row label="方向" value={`${activeLayer.direction | 0}°`}>
                      <input type="range" min={0} max={360} value={activeLayer.direction}
                        onChange={(e) => updateLayer(activeLayer.id, { direction: Number(e.target.value) })} />
                    </Row>
                    <Row label="强度" value={`${Math.round(activeLayer.strength * 100)}%`}>
                      <input type="range" min={0} max={1} step={0.01} value={activeLayer.strength}
                        onChange={(e) => updateLayer(activeLayer.id, { strength: Number(e.target.value) })} />
                    </Row>
                  </>
                )}
                {activeLayer.kind === 'obstacle' && (
                  <>
                    <Row label="扰动">
                      <button className={activeLayer.disturbance_enabled ? 'toggle on' : 'toggle'}
                        onClick={() => updateLayer(activeLayer.id, { disturbance_enabled: !activeLayer.disturbance_enabled })}>
                        {activeLayer.disturbance_enabled ? '已启用' : '已关闭'}
                      </button>
                    </Row>
                    {activeLayer.disturbance_enabled && (
                      <Row label="范围" value={`${Math.round(activeLayer.disturbance * 100)}%`}>
                        <input type="range" min={0} max={1} step={0.05} value={activeLayer.disturbance}
                          onChange={(e) => updateLayer(activeLayer.id, { disturbance: Number(e.target.value) })} />
                      </Row>
                    )}
                  </>
                )}
                <Row label="模糊" value={String(activeLayer.blur | 0)}>
                  <input type="range" min={0} max={64} value={activeLayer.blur}
                    onChange={(e) => updateLayer(activeLayer.id, { blur: Number(e.target.value) })} />
                </Row>
                <Row label="不透明度" value={`${Math.round(activeLayer.opacity * 100)}%`}>
                  <input type="range" min={0} max={1} step={0.01} value={activeLayer.opacity}
                    onChange={(e) => updateLayer(activeLayer.id, { opacity: Number(e.target.value) })} />
                </Row>
              </Panel>
            )}

            <Panel id="projection" title="投影"
              collapsed={!!collapsed.projection} onToggle={() => togglePanel('projection')}>
              <div className="seg">
                {([['equirectangular', '球面'], ['polar', '极坐标'], ['planar', '平面']] as const).map(([k, label]) => (
                  <button key={k} className={state.projection === k ? 'on' : ''}
                    onClick={async () => applyUpdate(await api.setProjection(k, state.polar_angle))}>
                    {label}
                  </button>
                ))}
              </div>
              {state.projection === 'polar' && (
                <Row label="张角" value={`${state.polar_angle | 0}°`}>
                  <input type="range" min={45} max={180} value={state.polar_angle}
                    onChange={async (e) => {
                      applyUpdate(await api.setProjection('polar', Number(e.target.value)));
                    }} />
                </Row>
              )}
            </Panel>

            <Panel id="source" title="图片源"
              collapsed={!!collapsed.source} onToggle={() => togglePanel('source')}>
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
            </Panel>

            <Panel id="export" title="导出"
              collapsed={!!collapsed.export} onToggle={() => togglePanel('export')}>
              <Row label="分辨率">
                <select value={exportRes} onChange={(e) => setExportRes(Number(e.target.value))}>
                  {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}²</option>)}
                </select>
              </Row>
              <div className="checks">
                <label><input type="checkbox" checked={invertX} onChange={(e) => setInvertX(e.target.checked)} /> 反转 R</label>
                <label><input type="checkbox" checked={invertY} onChange={(e) => setInvertY(e.target.checked)} /> 反转 G</label>
              </div>
              <button className="primary wide" onClick={doExport}>导出 Flowmap</button>
            </Panel>

            {recent.length > 0 && (
              <Panel id="recent" title="最近打开"
                collapsed={!!collapsed.recent} onToggle={() => togglePanel('recent')}>
                <div className="recent">
                  {recent.map((p) => (
                    <button key={p} className="link ellipsis" title={p} onClick={() => doOpen(p)}>
                      {p.split(/[\\/]/).pop()}
                    </button>
                  ))}
                </div>
              </Panel>
            )}
          </aside>
        )}
      </main>

      <footer className="statusbar">
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
 * everything you are not touching.
 *
 * The header is a real button so it is keyboard reachable; `data-panel` is
 * there for the tests to latch onto.
 */
function Panel({ id, title, children, collapsed, onToggle, grow }:
  { id: string; title: string; children: React.ReactNode; collapsed: boolean;
    onToggle: () => void; grow?: boolean }) {
  return (
    <section
      className={`panel ${collapsed ? 'collapsed' : ''} ${grow ? 'grow' : ''}`}
      data-panel={id}
    >
      <button className="panel-head" onClick={onToggle} aria-expanded={!collapsed} title={title}>
        <span className="chev">{collapsed ? '▸' : '▾'}</span>
        <span className="ellipsis">{title}</span>
      </button>
      {!collapsed && <div className="panel-body">{children}</div>}
    </section>
  );
}

function Row({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      {children}
      {value !== undefined && <span className="row-value">{value}</span>}
    </div>
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

function IconBtn({ on, onClick, label, children }:
  { on: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return <button className={`icon-btn ${on ? 'on' : ''}`} title={label} onClick={onClick}>{children}</button>;
}
