import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, nextStrokeId, decodeBase64, toImageData, Snapshot } from '../api';
import { nextCursor, shouldClearOnLeave, type CursorUV } from '../cursor';
import { brushGradient } from '../brush';
import { stageCentre, zoomAbout } from '../view';
import {
  CLOSE_PX, flattenPath, uvDistPx, hitPath,
  translatePath, withAnchor, insertAnchor, removeAnchor, withBrush,
  type Anchor, type PathData, type PathBrush, type PathHit,
} from '../pen';
import { NON_PAINTING_TOOLS, type Tool } from '../shortcuts';
import { createFlowWarp, type FlowWarp } from '../flowWarp';
import {
  ARROW_DASH_CELLS, ARROW_DASH_GAP_CELLS, ARROW_DASH_CELLS_PER_SEC,
} from '../arrows';

export interface PaintViewHandle {
  applySnapshot: (s: Snapshot) => void;
  getCanvas: () => HTMLCanvasElement | null;
  refreshArrows: () => void;
  resetView: () => void;
  /** Current view scale, for the status bar. */
  getZoom: () => number;
  /**
   * Pen path control, driven by Enter / Esc / Backspace. Each returns whether
   * it actually had a path to act on, so the caller can decide whether the key
   * was "used up" — Esc with no path must still close the help panel.
   */
  penCommit: () => boolean;
  penCancel: () => boolean;
  penPop: () => boolean;
  /** Retune the selected path's brush. No-op with nothing selected. */
  setPathBrush: (patch: Partial<PathBrush>) => void;
}

/** What the options bar needs to say about the path in progress. */
export interface PenInfo {
  anchors: number;
  closed: boolean;
  /** Index of the selected committed path, or -1 for none. */
  sel: number;
  /** Brush of the selected path, so the sliders can show *its* values. */
  brush: PathBrush | null;
}

export interface PaintViewProps {
  size: number;
  tool: Tool;
  /**
   * The active layer's committed paths, and the layer they belong to.
   *
   * The overlay draws them and hit-tests against them, so they have to live
   * here — but they are not authoritative: the engine owns them, and every edit
   * goes out through `onPathsChange` and comes back as fresh state. `layerId`
   * is what tells this view the layer was swapped underneath it, which is the
   * only moment a selection can silently become wrong.
   */
  paths: PathData[];
  layerId: string;
  /** Fired whenever the view scale changes, so the status bar can show it. */
  onZoom?: (scale: number) => void;
  brushSize: number;
  brushHardness: number;
  /** How much of the remaining distance to `brushStrength` one stroke covers. */
  brushFlow: number;
  brushStrength: number;
  /** Where the eyedropper reads from: this layer's own field, or everything. */
  sampleSource: 'layer' | 'composite';
  onPickStrength: (strength: number) => void;
  editTarget: 'content' | 'mask';
  magicThreshold: number;
  showReference: boolean;
  referenceOpacity: number;
  /** PNG data URL produced by the backend (works for TGA too). */
  referenceSrc: string | null;
  showArrows: boolean;
  arrowDensity: number;
  /**
   * Flow animation, in the same units the 3D preview uses. 0 is paused.
   *
   * Two different things move in 2D: the 贴图 is pushed around by the field
   * (see `flowWarp.ts`, the same maths as the 3D shader), and the arrows get a
   * marching dash. Without this the 播放开关 did nothing at all in 2D, while
   * `animating` starts out true.
   */
  animSpeed: number;
  /**
   * False when the 2D pane is hidden (3D-only view). The animation loops are
   * the whole cost of a hidden view — a dashed stroke over the field's Path2D
   * every frame, plus a flow texture upload — and none of it is on screen.
   */
  visible: boolean;
  /**
   * How far the field carries 天空贴图, in UV. The 3D shader's
   * `uDistortionStrength` — the same number, so the split agrees.
   */
  distortion: number;
  wrap: boolean;
  /** Shared cursor published to the 3D view (canvas coordinates). */
  cursorUV: React.MutableRefObject<CursorUV | null>;
  /**
   * True while a brush parameter is being scrubbed (F / Shift+F / Ctrl+F drag).
   * A ref, not state: it is read inside pointer handlers that must not re-render.
   */
  adjusting: React.MutableRefObject<boolean>;
  /**
   * Alt + right-drag scrub — Photoshop's brush HUD.
   *
   * `dx` / `dy` are screen px since the previous frame. X is diameter, Y is
   * hardness, and **down is harder**: the HUD's Y axis reads like a slider
   * being pushed down, not like a value going up.
   */
  onBrushScrub?: (dx: number, dy: number) => void;
  onStrokeEnd: () => void;
  onFillEnd: () => void;
  /**
   * Commit a new path list. `done` marks the end of a gesture: false on every
   * frame of a drag, true once on release, which is when the caller takes a
   * history entry and refreshes thumbnails.
   */
  onPathsChange?: (paths: PathData[], done: boolean) => void;
  /** Pen path changed, so the options bar can say how many anchors are down. */
  onPenInfo?: (info: PenInfo) => void;
}

const ARROW_SAMPLE = 128;

const NO_PATH: { a: Anchor[]; closed: boolean } = { a: [], closed: false };

/** A drag on a committed path. See the `edit` ref. */
interface Edit {
  /** Working copy; replaces `props.paths` in the overlay while dragging. */
  paths: PathData[];
  pi: number;
  part: PathHit['part'];
  ai: number;
  sign: 1 | -1;
  /** Pointer-down position, for absolute deltas. */
  u0: number;
  v0: number;
  /** The path as it was, so every frame starts from it. */
  orig: PathData;
  /** Whether it actually moved — a bare click selects, it does not edit. */
  moved: boolean;
}

/** Replace one entry of a path list. */
function withPath(paths: PathData[], pi: number, p: PathData): PathData[] {
  const out = paths.slice();
  out[pi] = p;
  return out;
}

// -- overlay painting -------------------------------------------------------

/** Units are fractions of the canvas edge, so one set works at any size. */
function strokeCurve(
  ctx: CanvasRenderingContext2D, a: Anchor[], closed: boolean,
  n: number, color: string, lw: number,
) {
  const pts = flattenPath(a, closed, n);
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * n, pts[0][1] * n);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * n, pts[i][1] * n);
  if (closed) ctx.closePath();
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function paintHandles(ctx: CanvasRenderingContext2D, a: Anchor[], n: number, lw: number) {
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(236,236,236,.55)';
  ctx.fillStyle = '#ececec';
  const r = Math.max(1.5, n / 400);
  for (const p of a) {
    if (p.hx === 0 && p.hy === 0) continue;
    ctx.beginPath();
    ctx.moveTo((p.x - p.hx) * n, (p.y - p.hy) * n);
    ctx.lineTo((p.x + p.hx) * n, (p.y + p.hy) * n);
    ctx.stroke();
    for (const [hx, hy] of [[p.hx, p.hy], [-p.hx, -p.hy]] as const) {
      ctx.beginPath();
      ctx.arc((p.x + hx) * n, (p.y + hy) * n, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function paintAnchors(
  ctx: CanvasRenderingContext2D, a: Anchor[], n: number, lw: number, ringFirst: boolean,
) {
  const sq = Math.max(3, n / 300);
  a.forEach((p, i) => {
    // The first anchor of an open draft is ringed: clicking it closes the
    // path, and an affordance you cannot see is one you will not find.
    ctx.fillStyle = ringFirst && i === 0 ? '#7cc4ff' : '#ffffff';
    ctx.fillRect(p.x * n - sq / 2, p.y * n - sq / 2, sq, sq);
    if (ringFirst && i === 0 && a.length > 1) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = '#7cc4ff';
      ctx.strokeRect(p.x * n - sq, p.y * n - sq, sq * 2, sq * 2);
    }
  });
}

/**
 * Ring geometry, sized imperatively so a stroke frame never re-renders React.
 *
 * `--fill` is the inner gradient, rebuilt from the engine's real falloff (see
 * src/brush.ts): a wide plateau means a hard brush, a long shoulder means a soft
 * one. Without it, scrubbing hardness with Shift+F would have no visible
 * feedback at all, because hardness does not change the radius.
 *
 * The gradient string is only rebuilt when hardness actually changes — this
 * runs on every pointer move.
 */
function syncRingSize(el: HTMLElement, brushSize: number, size: number, hardness: number) {
  const pct = (brushSize / size) * 100;
  el.style.width = `${pct}%`;
  el.style.height = `${pct}%`;
  const key = hardness.toFixed(3);
  if (el.dataset.fill !== key) {
    el.dataset.fill = key;
    el.style.setProperty('--fill', brushGradient(hardness));
  }
}


const PaintView = forwardRef<PaintViewHandle, PaintViewProps>((props, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arrowRef = useRef<HTMLCanvasElement>(null);
  const penCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);

  const propsRef = useRef(props);
  propsRef.current = props;

  const transform = useRef({ x: 0, y: 0, scale: 1 });
  const pending = useRef<[number, number][]>([]);
  const lastSent = useRef<[number, number] | null>(null);
  // Bumped on every pointer-down. The engine resets its per-stroke deposit
  // record whenever this changes, so a new drag starts from zero and overlap
  // *within* a drag does not compound.
  const strokeId = useRef(nextStrokeId());
  const drawing = useRef(false);
  const panning = useRef(false);
  const zooming = useRef(false);
  const picking = useRef(false);
  // Alt gives you a *temporary* eyedropper; picking the tool makes it stick.
  // Without this distinction, releasing Alt mid-drag would keep sampling.
  const pickSticky = useRef(false);
  /**
   * Alt + right drag in progress — Photoshop's brush HUD. Holds the last
   * pointer position, because the gesture is incremental: every frame adds
   * however far the pointer has moved since the last one.
   */
  const brushScrub = useRef<{ x: number; y: number } | null>(null);
  /**
   * Whether Alt is down, as far as the *ring's appearance* is concerned.
   *
   * `.paint-cursor.picking` forces the ring to a 14px crosshair with
   * `!important`, so it overrides the brush size outright — which means a
   * class that outlives its Alt key pins the ring at crosshair size for good:
   * 大小, F and `[` `]` all look dead, while the 3D ring, which has no such
   * class, keeps working. Alt+Tab or a click on another window eats the
   * `keyup`, and that is exactly what happens.
   *
   * So the key is recorded here and reconciled against `e.altKey` on every
   * pointer move, and dropped when the window loses focus. Either one alone
   * still has a hole; together no stuck state survives a mouse move.
   */
  const altHeld = useRef(false);
  const panStart = useRef<{ x: number; y: number } | null>(null);
  /** `x`/`y` are where the gesture started: the point that must stay put. */
  const zoomStart = useRef<{ x: number; y: number; startScale: number } | null>(null);
  const rafId = useRef(0);
  const arrowTimer = useRef(0);

  /**
   * The pen path. State, not a ref: it is small and it drives an overlay, which
   * has to repaint. The imperative handle needs to read it from event handlers
   * that were created in an earlier render, hence the mirror below.
   */
  const [pen, setPen] = useState(NO_PATH);
  const penRef = useRef(pen);
  penRef.current = pen;
  /** Index of the anchor whose handle is being dragged, if any. */
  const penDrag = useRef<number | null>(null);
  /** Index of the selected committed path, or -1. A ref: it only drives canvas. */
  const sel = useRef(-1);
  /**
   * The gesture in progress on a *committed* path — anchor, handle, or the
   * whole path. Holding the pre-drag copy is what makes dragging absolute
   * rather than incremental: every frame recomputes from the original, so the
   * path cannot drift away from where you grabbed it.
   */
  const edit = useRef<Edit | null>(null);
  /** Set when `edit` moved and the engine has not seen it yet. */
  const editDirty = useRef(false);
  /** How far the arrow dashes have marched. Kept so a re-sample lands in phase. */
  const animDash = useRef<number | null>(null);
  /** One round trip in flight, so a slow frame cannot land out of order. */
  const editBusy = useRef(false);

  /*
   * 天空贴图, animated.
   *
   * The warp is a GPU job (see `flowWarp.ts`): the offset differs per pixel, so
   * canvas 2D cannot express it. It runs only while the animation is playing —
   * paused, the plain `<img>` is the correct picture and costs nothing.
   */
  const warpRef = useRef<HTMLCanvasElement | null>(null);
  const warp = useRef<FlowWarp | null>(null);
  /** Decoded sky image, ready to upload whenever the context comes up. */
  const skyImg = useRef<HTMLImageElement | null>(null);
  /** The composite moved, so the flow texture is stale. */
  const flowDirty = useRef(true);
  /** Animation phase in cycles — the 3D shader's `uTime * uSpeed`. */
  const warpPhase = useRef(0);
  /** Whether the warped copy is on screen, which decides which layer shows. */
  const [warpLive, setWarpLive] = useState(false);

  const applyTransform = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const t = transform.current;
    el.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
    propsRef.current.onZoom?.(t.scale);
  }, []);

  /**
   * Zoom about a screen point, so whatever is under the cursor stays there.
   *
   * `.paint-stage` is transformed `translate` then `scale`, about its own
   * centre, so a point X lands at `C + T + s * (X - C)`. Holding the cursor `M`
   * fixed while `s` changes is one line of algebra:
   *
   * ```text
   * T1 = (M - C) * (1 - k) + k * T0        where k = s1 / s0
   * ```
   *
   * `C`, the *untransformed* centre, comes out of the current box for free:
   * the centre of a box scaled about its centre is exactly `C + T`.
   *
   * The target scale is absolute, not a step from the current one, so calling
   * this twice with the same pointer does nothing the second time — which is
   * what lets both the canvas and the pane around it handle the same move
   * without the two compounding.
   */
  const zoomAt = useCallback((next: number, mx: number, my: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const t = transform.current;
    const c = stageCentre(el.getBoundingClientRect(), t);
    transform.current = zoomAbout(t, next, c.x, c.y, mx, my);
    applyTransform();
  }, [applyTransform]);

  /** Ctrl + middle drag = zoom, plain middle drag = pan. */
  const beginView = (e: React.PointerEvent) => {
    if (e.ctrlKey) {
      zooming.current = true;
      zoomStart.current = { x: e.clientX, y: e.clientY, startScale: transform.current.scale };
    } else {
      panning.current = true;
      panStart.current = { x: e.clientX - transform.current.x, y: e.clientY - transform.current.y };
    }
  };

  /**
   * One frame of a zoom / pan drag. Returns whether it consumed the move.
   *
   * Lives on its own because the gesture can start *outside* the artwork — see
   * `onViewDown` — and then no pointer event ever reaches the canvas.
   */
  const moveView = useCallback((e: React.PointerEvent) => {
    if (zooming.current && zoomStart.current) {
      const zs = zoomStart.current;
      // Anchored on where the gesture started, not on where the pointer is
      // now. The point you aimed at when you pressed is the one that has to
      // stay put; anchoring on the live cursor makes the whole view slide
      // sideways while you zoom.
      zoomAt(zs.startScale * (1 - (e.clientY - zs.y) * 0.005), zs.x, zs.y);
      return true;
    }
    if (panning.current && panStart.current) {
      transform.current.x = e.clientX - panStart.current.x;
      transform.current.y = e.clientY - panStart.current.y;
      applyTransform();
      return true;
    }
    return false;
  }, [applyTransform, zoomAt]);

  const applySnapshot = useCallback((s: Snapshot) => {
    const canvas = canvasRef.current;
    if (!canvas || s.w === 0 || s.h === 0) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const bytes = decodeBase64(s.data);
    ctx.putImageData(toImageData(bytes, s.w, s.h), s.x, s.y);
    // The field changed, so the copy the warp is sampling from is stale. Flagging
    // it here beats re-uploading 4 MB every frame: this is the only place the
    // composite's pixels move on the hot path.
    flowDirty.current = true;
  }, []);

  /**
   * The arrow geometry, kept so animation frames never re-read the canvas.
   *
   * Re-sampling means a `drawImage` down to 128² plus a `getImageData` — far
   * too much to do 60 times a second, and it only changes when the pixels do.
   * The shafts are built once too, so a frame is: clear, one dashed stroke.
   */
  const arrowGeom = useRef<{ shaft: Path2D; step: number } | null>(null);

  /** Draw the cached arrows. `dash` is the marching offset, or null for solid. */
  const drawArrows = useCallback((dash: number | null) => {
    const ac = arrowRef.current;
    const g = arrowGeom.current;
    if (!ac) return;
    const ctx = ac.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, ac.width, ac.height);
    if (!g) return;
    // Dash and gap come from src/arrows.ts so the 3D shader marches at exactly
    // the same rhythm. The 3px floor keeps them visible when 密度 packs the grid
    // tight; the shader needs no such floor, it works in cells.
    const d = Math.max(3, g.step * ARROW_DASH_CELLS);
    if (dash !== null) {
      // The shafts run tail -> downstream, so a *decreasing* offset carries the
      // dashes that way. Increasing it would make the field flow backwards,
      // which is worse than not animating at all.
      ctx.setLineDash([d, d * (ARROW_DASH_GAP_CELLS / ARROW_DASH_CELLS)]);
      ctx.lineDashOffset = -dash;
    } else {
      ctx.setLineDash([]);
    }
    // No arrowhead, and no fill: what says which way the field runs is the dash
    // marching downstream, not a triangle on the end.
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke(g.shaft);
    ctx.setLineDash([]);
  }, []);

  const refreshArrows = useCallback(() => {
    const ac = arrowRef.current;
    const src = canvasRef.current;
    const p = propsRef.current;
    if (!ac || !src) return;
    const ctx = ac.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, ac.width, ac.height);
    if (!p.showArrows) { arrowGeom.current = null; return; }

    if (!sampleRef.current) {
      const s = document.createElement('canvas');
      s.width = ARROW_SAMPLE;
      s.height = ARROW_SAMPLE;
      sampleRef.current = s;
    }
    const sample = sampleRef.current;
    const sCtx = sample.getContext('2d', { willReadFrequently: true });
    if (!sCtx) return;
    sCtx.clearRect(0, 0, ARROW_SAMPLE, ARROW_SAMPLE);
    sCtx.drawImage(src, 0, 0, ARROW_SAMPLE, ARROW_SAMPLE);
    const data = sCtx.getImageData(0, 0, ARROW_SAMPLE, ARROW_SAMPLE).data;

    const size = ac.width;
    const scale = size / ARROW_SAMPLE;
    const step = Math.max(16, 128 - p.arrowDensity);
    const sStep = step / scale;
    const shaft = new Path2D();
    for (let sy = sStep / 2; sy < ARROW_SAMPLE; sy += sStep) {
      for (let sx = sStep / 2; sx < ARROW_SAMPLE; sx += sStep) {
        const i = ((sy | 0) * ARROW_SAMPLE + (sx | 0)) * 4;
        const r = data[i];
        const g = data[i + 1];
        if (r === 128 && g === 128) continue;
        const x = sx * scale;
        const y = sy * scale;
        const vx = (128 - r) / 127;
        const vy = (g - 128) / 127;
        const rawLen = Math.sqrt(vx * vx + vy * vy);
        const angle = Math.atan2(vy, vx);
        const len = Math.min(step * 0.8, rawLen * step * 2);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const half = len / 2;
        shaft.moveTo(x - half * cos, y - half * sin);
        shaft.lineTo(x + half * cos, y + half * sin);
      }
    }
    arrowGeom.current = { shaft, step };
    drawArrows(animDash.current);
  }, [drawArrows]);

  // -- flush loop: one IPC per animation frame, not per pointer event -----
  useEffect(() => {
    const flush = () => {
      rafId.current = requestAnimationFrame(flush);
      // Dragging a path is the same budget as dragging a brush: one round trip
      // per frame, and never two in flight, because a slow one landing after a
      // fast one would put last frame's anchor back on screen.
      if (editDirty.current && edit.current && !editBusy.current) {
        editDirty.current = false;
        editBusy.current = true;
        const next = edit.current.paths;
        void Promise.resolve(propsRef.current.onPathsChange?.(next, false))
          .finally(() => {
            editBusy.current = false;
            scheduleArrows();
          });
      }
      const q = pending.current;
      if (q.length === 0) return;
      const p = propsRef.current;
      const pts = lastSent.current ? [lastSent.current, ...q] : q.slice();
      lastSent.current = pts[pts.length - 1];
      pending.current = [];
      api.stroke(pts, p.brushSize, p.brushHardness, p.brushStrength, p.tool === 'eraser',
                 p.editTarget, strokeId.current, p.brushFlow)
        .then((s) => {
          applySnapshot(s);
          scheduleArrows();
        });
    };
    rafId.current = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(rafId.current);
  }, [applySnapshot]);

  // Alt has to show the eyedropper the moment it goes down, without waiting
  // for the pointer to move.
  const showPicking = useCallback((on: boolean) => {
    // A scrub outranks Alt. `.picking` is `14px !important`, so leaving the
    // crosshair on for the length of an Alt+right drag would pin the ring at
    // crosshair size — the one thing the gesture exists to change.
    const want = on && !propsRef.current.adjusting.current;
    if (altHeld.current === want) return;
    altHeld.current = want;
    cursorRef.current?.classList.toggle('picking', want);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') { showPicking(true); return; }
      // Any other key that arrives *without* Alt proves Alt is up, even if we
      // never saw its keyup. So scrubbing with F or nudging with `[` `]` heals
      // the ring on its own instead of doing nothing.
      if (!e.altKey) showPicking(false);
    };
    const up = (e: KeyboardEvent) => { if (e.key === 'Alt') showPicking(false); };
    // Alt+Tab, or a click on another window, delivers the keydown and never
    // the keyup. Without this the class — and with it the 14px crosshair —
    // stays until Alt is pressed again.
    const blur = () => showPicking(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [showPicking]);

  /**
   * The path overlay: committed paths, the draft, and whatever is grabbable.
   *
   * Drawn on its own canvas at the flowmap's resolution rather than as SVG over
   * the stage, so it shares one coordinate space with the pixels it came from —
   * and so it pans and zooms with them for free, exactly like the arrow overlay
   * next to it.
   *
   * Only the selected path shows its anchors. Every path showing all of its
   * anchors is a grid of squares you cannot see the curve through, and the
   * anchors are only editable one path at a time anyway.
   */
  const drawPen = useCallback(() => {
    const c = penCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const n = c.width;
    ctx.clearRect(0, 0, n, n);
    const lw = Math.max(1, n / 700);
    const s = sel.current;
    const paths = edit.current?.paths ?? propsRef.current.paths;

    // Committed paths underneath: the draft is the thing being worked on, so it
    // goes on top of them.
    paths.forEach((p, pi) => {
      const on = pi === s;
      strokeCurve(ctx, p.anchors, p.closed, n,
        on ? '#378ef0' : 'rgba(55,142,240,.45)', on ? lw * 1.4 : lw);
      if (!on) return;
      paintHandles(ctx, p.anchors, n, lw);
      paintAnchors(ctx, p.anchors, n, lw, false);
    });

    const { a, closed } = penRef.current;
    if (a.length === 0) return;
    strokeCurve(ctx, a, closed, n, '#378ef0', lw);
    paintHandles(ctx, a, n, lw);
    paintAnchors(ctx, a, n, lw, true);
  }, []);

  /** Tell the options bar what is down and what is selected. */
  const publishPen = useCallback((over?: PathData[]) => {
    const p = propsRef.current;
    const paths = over ?? edit.current?.paths ?? p.paths;
    const selPath = sel.current >= 0 ? paths[sel.current] : undefined;
    p.onPenInfo?.({
      anchors: penRef.current.a.length,
      closed: penRef.current.closed,
      sel: sel.current,
      brush: selPath
        ? { size: selPath.size, hardness: selPath.hardness, strength: selPath.strength }
        : null,
    });
  }, []);

  useEffect(() => {
    drawPen();
    publishPen();
  }, [pen, props.size, props.paths, drawPen, publishPen]);

  // A path belongs to the pen. Switching tools abandons it rather than leaving
  // an invisible one that the next Enter would stamp somewhere you forgot.
  useEffect(() => {
    penDrag.current = null;
    penRef.current = NO_PATH;
    setPen(NO_PATH);
    drawPen();
    publishPen();
  }, [props.tool, drawPen, publishPen]);

  // Switching layers invalidates the selection outright: index 3 of the old
  // layer is a different path on the new one, and silently keeping it would
  // move geometry you cannot see.
  useEffect(() => {
    sel.current = -1;
    edit.current = null;
    editDirty.current = false;
    penDrag.current = null;
    penRef.current = NO_PATH;
    setPen(NO_PATH);
    drawPen();
    publishPen();
  }, [props.layerId, drawPen, publishPen]);

  const scheduleArrows = useCallback(() => {
    if (arrowTimer.current) return;
    arrowTimer.current = window.setTimeout(() => {
      arrowTimer.current = 0;
      refreshArrows();
    }, 80);
  }, [refreshArrows]);

  /** Send a path list to the engine. `done` ends the gesture. */
  const pushPaths = useCallback((next: PathData[], done: boolean) => {
    propsRef.current.onPathsChange?.(next, done);
  }, []);

  /**
   * Move the grabbed part of a committed path.
   *
   * Absolute against the pre-drag copy, so the path cannot accumulate error
   * the way "add last frame's delta" would.
   */
  const applyEdit = useCallback((u: number, v: number) => {
    const e = edit.current;
    if (!e) return;
    const a = e.orig.anchors[e.ai];
    let next: PathData;
    if (e.part === 'body') {
      next = translatePath(e.orig, u - e.u0, v - e.v0);
    } else if (!a) {
      return;
    } else if (e.part === 'anchor') {
      next = withAnchor(e.orig, e.ai, { ...a, x: a.x + (u - e.u0), y: a.y + (v - e.v0) });
    } else if (e.sign > 0) {
      // The outgoing handle follows the pointer directly.
      next = withAnchor(e.orig, e.ai, { ...a, hx: u - a.x, hy: v - a.y });
    } else {
      // The incoming one is the mirror, so it follows it the other way round.
      next = withAnchor(e.orig, e.ai, { ...a, hx: a.x - u, hy: a.y - v });
    }
    e.paths = withPath(e.paths, e.pi, next);
    e.moved = true;
    editDirty.current = true;
    drawPen();
  }, [drawPen]);

  /**
   * Enter: the draft becomes a path on the layer.
   *
   * Nothing is stamped. The path is *added to the layer's geometry* and the
   * engine renders the pixels from it, which is the whole difference between
   * this and a brush stroke: from here on the anchors can be moved and the flow
   * follows, instead of the pixels being all that is left of your intent.
   */
  const commitPen = useCallback(() => {
    const p = propsRef.current;
    const { a, closed } = penRef.current;
    penDrag.current = null;
    penRef.current = NO_PATH;
    setPen(NO_PATH);
    if (a.length < 2) return false;

    // The brush travels with the path. That is what lets you come back to a
    // path later and retune *it*, and what lets one layer hold paths of twenty
    // different widths.
    const next = [...p.paths, {
      anchors: a,
      closed,
      size: p.brushSize,
      hardness: p.brushHardness,
      strength: p.brushStrength,
    }];
    // Selected straight away, so the options bar's sliders are already talking
    // to the thing you just made.
    sel.current = next.length - 1;
    drawPen();
    publishPen(next);
    pushPaths(next, true);
    scheduleArrows();
    return true;
  }, [drawPen, publishPen, pushPaths, scheduleArrows]);

  const cancelPen = useCallback(() => {
    if (penRef.current.a.length > 0) {
      penDrag.current = null;
      penRef.current = NO_PATH;
      setPen(NO_PATH);
      drawPen();
      publishPen();
      return true;
    }
    // Nothing being drawn: Esc drops the selection. It is the other thing that
    // reads as "get me out of this", and leaving anchors on screen after Esc
    // would say the opposite.
    if (sel.current >= 0) {
      sel.current = -1;
      drawPen();
      publishPen();
      return true;
    }
    return false;
  }, [drawPen, publishPen]);

  /**
   * Backspace: undo the last anchor, or — with nothing down — delete the
   * selected path.
   *
   * Which one it is depends on what there is to undo, not on a mode: you are
   * always removing the last thing you did, and the draft is more recent than
   * the selection.
   */
  const popPen = useCallback(() => {
    const cur = penRef.current;
    if (cur.a.length > 0) {
      penDrag.current = null;
      const a = cur.a.slice(0, -1);
      penRef.current = { a, closed: a.length > 2 ? cur.closed : false };
      setPen(penRef.current);
      drawPen();
      publishPen();
      return true;
    }
    const p = propsRef.current;
    if (sel.current >= 0 && sel.current < p.paths.length) {
      const next = p.paths.filter((_, i) => i !== sel.current);
      sel.current = -1;
      drawPen();
      publishPen(next);
      pushPaths(next, true);
      return true;
    }
    return false;
  }, [drawPen, publishPen, pushPaths]);

  const setPathBrush = useCallback((patch: Partial<PathBrush>) => {
    const p = propsRef.current;
    const i = sel.current;
    if (i < 0 || i >= p.paths.length) return;
    const next = withPath(p.paths, i, withBrush(p.paths[i], patch));
    publishPen(next);
    pushPaths(next, true);
  }, [publishPen, pushPaths]);

  useImperativeHandle(ref, () => ({
    applySnapshot,
    getCanvas: () => canvasRef.current,
    refreshArrows,
    resetView: () => {
      transform.current = { x: 0, y: 0, scale: 1 };
      applyTransform();
    },
    getZoom: () => transform.current.scale,
    penCommit: commitPen,
    penCancel: cancelPen,
    penPop: popPen,
    setPathBrush,
  }), [applySnapshot, refreshArrows, applyTransform, commitPen, cancelPen, popPen, setPathBrush]);

  const getUV = (e: React.PointerEvent | React.MouseEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      u: (e.clientX - rect.left) / rect.width,
      v: (e.clientY - rect.top) / rect.height,
    };
  };

  /** Eyedropper: read the flow strength here and make it the brush's strength. */
  const sample = useCallback((u: number, v: number) => {
    const p = propsRef.current;
    api.sampleStrength(u, v, p.sampleSource).then((s) => {
      if (s > 0) p.onPickStrength(s);
    });
  }, []);

  /**
   * A left press with the pen.
   *
   * Three different things can happen, and the order is the whole interaction:
   * a draft in progress owns the pointer; with no draft, whatever is already on
   * the layer is grabbed; only if neither applies does a click start a new
   * path. Getting that backwards would mean you could never select a path,
   * because every click would begin another one on top of it.
   *
   * Returns whether the press was consumed. Alt on empty space is *not*: Alt
   * is the eyedropper in every tool, so a press that would only have dropped
   * the first anchor of a new path falls through to it instead. Otherwise
   * Alt+click on the pen did the one thing it should never do — start a path —
   * and not the thing Alt is documented to do anywhere else.
   */
  const penDown = useCallback((u: number, v: number, alt: boolean): boolean => {
    const p = propsRef.current;
    // Screen pixels, so the grab radius feels the same zoomed in or out.
    const sizePx = canvasRef.current?.getBoundingClientRect().width ?? p.size;
    const cur = penRef.current;

    if (cur.a.length >= 2 && uvDistPx(u, v, cur.a[0].x, cur.a[0].y, sizePx) <= CLOSE_PX) {
      penRef.current = { a: cur.a, closed: !cur.closed };
      setPen(penRef.current);
      drawPen();
      publishPen();
      return true;
    }

    if (cur.a.length === 0) {
      const hit = hitPath(p.paths, u, v, sizePx);
      if (hit) {
        sel.current = hit.pi;
        const base = p.paths[hit.pi];
        if (alt && hit.part === 'anchor') {
          // Alt + anchor deletes it. The path stays smooth: the anchors either
          // side re-derive their tangents from their new neighbours.
          const next = withPath(p.paths, hit.pi, removeAnchor(base, hit.ai));
          publishPen(next);
          pushPaths(next, true);
        } else if (alt && hit.part === 'body') {
          // Alt + curve adds one, which is how "keep editing this" works once a
          // path is committed — the alternative is deleting it and starting
          // over, which throws away the shape you were trying to refine.
          const next = withPath(p.paths, hit.pi, insertAnchor(base, hit.seg, hit.x, hit.y));
          publishPen(next);
          pushPaths(next, true);
        } else {
          edit.current = {
            paths: p.paths,
            pi: hit.pi,
            part: hit.part,
            ai: hit.part === 'body' ? -1 : hit.ai,
            sign: hit.part === 'handle' ? hit.sign : 1,
            u0: u,
            v0: v,
            orig: base,
            moved: false,
          };
        }
        drawPen();
        publishPen();
        return true;
      }
      // Nothing under the pointer. Alt is not the pen's to spend here: there is
      // no anchor to add or remove, so let the eyedropper have the click.
      if (alt) return false;
      // Empty space with nothing drawn: start a path, and drop the selection —
      // clicking away from a path is how you say you are finished with it.
      sel.current = -1;
    }

    const a = [...cur.a, { x: u, y: v, hx: 0, hy: 0 }];
    penRef.current = { a, closed: cur.closed };
    setPen(penRef.current);
    penDrag.current = a.length - 1;
    drawPen();
    publishPen();
    return true;
  }, [drawPen, publishPen, pushPaths]);

  const onPointerDown = (e: React.PointerEvent) => {
    const p = propsRef.current;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Middle drag: Ctrl/Cmd + vertical drag = zoom, plain = pan. Both are
    // shared with the pane around the artwork, so they must go through the
    // same entry point whether they started on the canvas or beside it.
    if (e.button === 1) {
      beginView(e);
      return;
    }
    // Alt + right drag = the brush HUD. Before the `button !== 0` bail-out,
    // because a right press is otherwise nothing at all here.
    if (e.button === 2 && e.altKey && !NON_PAINTING_TOOLS.has(p.tool)) {
      beginScrub(e);
      return;
    }
    if (e.button !== 0) return;
    const { u, v } = getUV(e);
    // The pen is tested *before* the Alt eyedropper, because with a pen Alt
    // means "this anchor, here" — add or remove one — which is what Alt does to
    // a path in Photoshop. It hands the press back when there is no path under
    // the pointer, so Alt keeps meaning "pick up the strength" everywhere.
    if (p.tool === 'pen' && penDown(u, v, e.altKey)) return;
    // Alt = eyedropper, whatever tool is selected. Temporary: it is a modifier,
    // so releasing it returns to the tool on its own. Selecting the eyedropper
    // itself makes it stick for the whole drag.
    if (e.altKey || p.tool === 'eyedropper') {
      picking.current = true;
      pickSticky.current = p.tool === 'eyedropper';
      // The ring follows the *behaviour*, not just the key. A keyup that went
      // missing can leave the class off while a pick is in progress, which
      // reads as "Alt did nothing".
      showPicking(true);
      sample(u, v);
      return;
    }
    // The hand tool is just the middle-button pan, moved onto the left button
    // for people who do not have a middle button (trackpads, tablets).
    if (p.tool === 'pan') {
      panning.current = true;
      panStart.current = { x: e.clientX - transform.current.x, y: e.clientY - transform.current.y };
      return;
    }
    if (p.tool === 'magic_wand') {
      api.floodFill(u, v, p.magicThreshold, p.editTarget).then((s) => {
        applySnapshot(s);
        scheduleArrows();
        p.onFillEnd();
      });
      return;
    }
    drawing.current = true;
    // New pointer stroke: the engine clears its deposit record, so this drag
    // starts from zero no matter how many times it crosses its own path.
    strokeId.current = nextStrokeId();
    // Seed the "previous sample" instead of queueing a one-point batch. A lone
    // sample carries no direction, so sending it would just be a wasted IPC that
    // the engine has to reject; this way the first flush of the stroke already
    // carries a real segment from the press point.
    lastSent.current = [u, v];
    pending.current = [];
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = propsRef.current;
    const { u, v } = getUV(e);
    // The pointer event carries the truth about Alt, so reconcile the ring's
    // appearance against it. A `keyup` that went missing (lost focus, another
    // window) cannot survive one move of the mouse.
    if (e.altKey !== altHeld.current) showPicking(e.altKey);
    // Alt + right drag. Read *before* the eyedropper: Alt is down for the whole
    // gesture, so the eyedropper would otherwise claim every frame of it.
    if (brushScrub.current) {
      const s = brushScrub.current;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      s.x = e.clientX;
      s.y = e.clientY;
      if (dx || dy) p.onBrushScrub?.(dx, dy);
      return;
    }
    // Dragging with Alt keeps sampling, the way Photoshop's eyedropper does.
    if (picking.current) {
      if (e.altKey || pickSticky.current) sample(u, v);
      return;
    }
    // Scrubbing a parameter: hold the ring still, only let it grow/shrink.
    const frozen = p.adjusting.current;
    p.cursorUV.current = nextCursor(frozen, { u, v }, p.cursorUV.current);
    const cur = cursorRef.current;
    if (cur && !NON_PAINTING_TOOLS.has(p.tool)) {
      if (u < -0.1 || u > 1.1 || v < -0.1 || v > 1.1) {
        cur.style.display = 'none';
      } else {
        cur.style.display = 'block';
        if (!frozen) {
          cur.style.left = `${u * 100}%`;
          cur.style.top = `${v * 100}%`;
        }
        syncRingSize(cur, p.brushSize, p.size, p.brushHardness);
      }
    }
    // Zooming and panning are handled by `moveView`, shared with the pane
    // around the canvas so a middle drag can start off the artwork.
    if (moveView(e)) return;
    // A committed path is being dragged: an anchor, a handle, or the whole
    // thing. Comes first because it is the most specific thing a drag can mean.
    if (edit.current) {
      applyEdit(u, v);
      return;
    }
    // Dragging straight off a fresh anchor sets its handle, the way every pen
    // tool does: the further you pull, the longer the tangent. A click with no
    // drag leaves the handle at zero, which means "derive it from the
    // neighbours" — so a plain click still gives you a smooth curve.
    if (penDrag.current !== null) {
      const i = penDrag.current;
      setPen((cur) => {
        const a = cur.a.slice();
        const p0 = a[i];
        if (!p0) return cur;
        a[i] = { ...p0, hx: u - p0.x, hy: v - p0.y };
        return { a, closed: cur.closed };
      });
      return;
    }
    if (!drawing.current) return;
    pending.current.push([u, v]);
  };

  const endStroke = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    // Releasing the mouse is not the same as releasing Alt, so the ring goes
    // back to whatever Alt says *now* — still the crosshair if it is held.
    if (endScrub()) { showPicking(e.altKey); return; }
    if (picking.current) {
      picking.current = false;
      // Releasing the mouse is not the same as releasing Alt: keep the
      // crosshair while the key is still down.
      showPicking(e.altKey);
      return;
    }
    if (zooming.current) {
      zooming.current = false;
      zoomStart.current = null;
      return;
    }
    if (panning.current) {
      panning.current = false;
      panStart.current = null;
      return;
    }
    if (edit.current) {
      const e = edit.current;
      edit.current = null;
      editDirty.current = false;
      // A click that never moved only selected; sending it would be a history
      // entry and a thumbnail refresh for nothing.
      if (e.moved) pushPaths(e.paths, true);
      drawPen();
      return;
    }
    if (penDrag.current !== null) {
      penDrag.current = null;
      return;
    }
    if (!drawing.current) return;
    drawing.current = false;
    lastSent.current = null;
    propsRef.current.onStrokeEnd();
  };

  const onWheel = (e: React.WheelEvent) => {
    // About the pointer, like everywhere else — a wheel that zooms about the
    // middle of the image walks away from whatever you were looking at.
    zoomAt(transform.current.scale - e.deltaY * 0.0015, e.clientX, e.clientY);
  };

  /**
   * A middle press anywhere in the pane, artwork or not.
   *
   * The canvas cannot own this: a press in the dark surround never reaches it,
   * so zooming and panning used to die the moment the pointer left the square —
   * which is exactly when you most want to zoom out and see the whole thing.
   */
  const onViewDown = (e: React.PointerEvent) => {
    if (e.button !== 1) return;
    // Captured on the pane, so the drag survives crossing on and off the
    // artwork. Stopped before the canvas, which would otherwise read a UV off
    // a press that was never on the image.
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.stopPropagation();
    beginView(e);
  };

  /**
   * Alt + right press: start the brush HUD.
   *
   * It has to be the *right* button. Alt + left is the eyedropper in every
   * tool, and it stays that way — so the scrub takes the other one, exactly as
   * Photoshop does (and for the same reason: Alt is already spoken for).
   *
   * `adjusting` is set here rather than by App because this is the same
   * "the ring is being scrubbed" state the F keys produce: it freezes the ring
   * where it is and hands the ring back to the brush.
   */
  const beginScrub = (e: React.PointerEvent) => {
    propsRef.current.adjusting.current = true;
    document.body.classList.add('adjusting');
    brushScrub.current = { x: e.clientX, y: e.clientY };
    // Alt is down, so the ring is the crosshair right now. `showPicking` is
    // read through `adjusting`, so this also stops the next pointer move from
    // putting the crosshair back.
    showPicking(false);
  };

  const endScrub = (): boolean => {
    if (!brushScrub.current) return false;
    brushScrub.current = null;
    propsRef.current.adjusting.current = false;
    document.body.classList.remove('adjusting');
    return true;
  };

  const endView = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (zooming.current) {
      zooming.current = false;
      zoomStart.current = null;
    }
    if (panning.current) {
      panning.current = false;
      panStart.current = null;
    }
  };

  // The ring is sized imperatively, so slider edits (which never fire a pointer
  // move over the canvas) need their own sync.
  useEffect(() => {
    const cur = cursorRef.current;
    const p = propsRef.current;
    if (cur && !NON_PAINTING_TOOLS.has(p.tool)) syncRingSize(cur, p.brushSize, p.size, p.brushHardness);
  }, [props.brushSize, props.brushHardness, props.size, props.tool]);

  // Redraw arrows when density or visibility changes.
  useEffect(() => {
    refreshArrows();
  }, [props.showArrows, props.arrowDensity, props.size, refreshArrows]);

  /**
   * March the arrow dashes downstream.
   *
   * `animating` starts out true, so before this the 播放开关 was a switch that
   * moved nothing in the 2D view — the one place you most want to see which
   * way the field runs. The 3D preview pushes a texture around; there is no
   * texture here, so what moves is the thing that *is* the flow: the arrows.
   *
   * Paused is not "phase 0": it draws the solid arrows again, because solid
   * shafts are what you want when you are reading a still frame.
   */
  useEffect(() => {
    const p = propsRef.current;
    if (!p.visible) return;
    if (!p.showArrows || p.animSpeed <= 0) {
      animDash.current = null;
      drawArrows(null);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      // Dashes travel a fixed number of *cells* per second, the same rule the
      // 3D shader uses, so the two halves of a split march in step. Measured in
      // pixels it scaled with the canvas instead: 4096² ran four times faster
      // than 1024² at the same speed.
      const cell = arrowGeom.current?.step ?? p.size / 8;
      animDash.current =
        (animDash.current ?? 0) + dt * p.animSpeed * ARROW_DASH_CELLS_PER_SEC * cell;
      drawArrows(animDash.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [props.showArrows, props.animSpeed, props.arrowDensity, props.size, props.visible, drawArrows]);

  /**
   * Decode 天空贴图 once, so pausing and resuming does not re-decode a 4K
   * image every time. The upload happens whenever the context comes up.
   */
  useEffect(() => {
    const src = props.referenceSrc;
    if (!src) { skyImg.current = null; return; }
    const img = new Image();
    img.src = src;
    skyImg.current = img;
    const upload = () => {
      if (!img.naturalWidth) return;
      warp.current?.setSky(img, img.naturalWidth, img.naturalHeight);
      flowDirty.current = true;
    };
    if (img.complete) upload();
    else img.addEventListener('load', upload, { once: true });
  }, [props.referenceSrc]);

  /**
   * 天空贴图, carried along by the field.
   *
   * In a split, the 3D half flowed while the 2D half sat still — and the 2D
   * half is the one you are painting into, which is exactly where you want to
   * watch the sky move. Canvas 2D cannot do this (the offset differs per
   * pixel), so it goes through `flowWarp.ts`, which is the 3D shader's maths
   * on a flat quad.
   *
   * Paused is not "phase 0" here either: the still image comes back, because
   * the undistorted texture is what you read your flowmap against.
   */
  useEffect(() => {
    const p = propsRef.current;
    if (!p.visible || !p.showReference || !p.referenceSrc || p.animSpeed <= 0) {
      setWarpLive(false);
      return;
    }
    const cv = warpRef.current;
    if (!cv) return;
    if (!warp.current) {
      warp.current = createFlowWarp(cv);
      // No WebGL (headless, blacklisted driver): the plain <img> stays and
      // nothing else about the view changes.
      if (!warp.current) return;
      const img = skyImg.current;
      if (img && img.complete && img.naturalWidth) {
        warp.current.setSky(img, img.naturalWidth, img.naturalHeight);
      }
    }
    flowDirty.current = true;
    setWarpLive(true);
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      // The 3D shader's `uTime * uSpeed`: same units, so the two halves of a
      // split drift in step instead of slowly separating.
      warpPhase.current += dt * p.animSpeed;
      const w = warp.current;
      const field = canvasRef.current;
      if (w && field) {
        if (flowDirty.current) { w.setFlow(field); flowDirty.current = false; }
        w.draw(warpPhase.current, p.distortion);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); setWarpLive(false); };
  }, [props.showReference, props.referenceSrc, props.animSpeed, props.size, props.visible]);

  useEffect(() => () => {
    warp.current?.dispose();
    warp.current = null;
  }, []);

  return (
    <div className="paint-view" onWheel={onWheel}
      onPointerDownCapture={onViewDown}
      onPointerMove={(e) => moveView(e)}
      onPointerUp={endView}
      onPointerCancel={endView}>
      <div ref={wrapRef} className="paint-stage">
        <canvas
          ref={canvasRef}
          width={props.size}
          height={props.size}
          className={`paint-canvas ${NON_PAINTING_TOOLS.has(props.tool) ? 'cursor-default' : 'cursor-none'}`}
        style={{ imageRendering: 'pixelated' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={() => {
            const p = propsRef.current;
            if (!shouldClearOnLeave(p.adjusting.current)) return;
            p.cursorUV.current = null;
            if (cursorRef.current) cursorRef.current.style.display = 'none';
          }}
        />
        <canvas ref={arrowRef} width={props.size} height={props.size} className="paint-arrows" />
        <div ref={cursorRef} className="paint-cursor">
          <div className="paint-cursor-inner" style={{ opacity: props.brushStrength * 0.8 }} />
        </div>
        {props.showReference && props.referenceSrc && (
          <img
            src={props.referenceSrc}
            alt="reference"
            className="paint-reference"
            style={{ opacity: warpLive ? 0 : props.referenceOpacity }}
            draggable={false}
          />
        )}
        {/* Above the still image, below the pen overlay: once the field is
            carrying the texture, the still image is the wrong picture — but
            the path being drawn is still the thing you have to see. */}
        <canvas
          ref={warpRef}
          width={props.size}
          height={props.size}
          className="paint-reference-warp"
          style={{ opacity: warpLive ? props.referenceOpacity : 0 }}
        />
        {/* Last, so it sits above the reference overlay: a sky texture across
            the path you are drawing is exactly the thing you cannot draw
            against. */}
        <canvas ref={penCanvasRef} width={props.size} height={props.size} className="paint-pen" />
      </div>
    </div>
  );
});

export default PaintView;
