import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, nextStrokeId, decodeBase64, toImageData, Snapshot } from '../api';
import { nextCursor, shouldClearOnLeave, type CursorUV } from '../cursor';
import { brushGradient } from '../brush';
import {
  CLOSE_PX, flattenPath, uvDistPx, hitPath,
  translatePath, withAnchor, insertAnchor, removeAnchor, withBrush,
  type Anchor, type PathData, type PathBrush, type PathHit,
} from '../pen';
import { NON_PAINTING_TOOLS, type Tool } from '../shortcuts';

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
  wrap: boolean;
  /** Shared cursor published to the 3D view (canvas coordinates). */
  cursorUV: React.MutableRefObject<CursorUV | null>;
  /**
   * True while a brush parameter is being scrubbed (F / Shift+F / Ctrl+F drag).
   * A ref, not state: it is read inside pointer handlers that must not re-render.
   */
  adjusting: React.MutableRefObject<boolean>;
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
  const panStart = useRef<{ x: number; y: number } | null>(null);
  const zoomStart = useRef<{ y: number; startScale: number } | null>(null);
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
  /** One round trip in flight, so a slow frame cannot land out of order. */
  const editBusy = useRef(false);

  const applyTransform = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const t = transform.current;
    el.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
    propsRef.current.onZoom?.(t.scale);
  }, []);

  const applySnapshot = useCallback((s: Snapshot) => {
    const canvas = canvasRef.current;
    if (!canvas || s.w === 0 || s.h === 0) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const bytes = decodeBase64(s.data);
    ctx.putImageData(toImageData(bytes, s.w, s.h), s.x, s.y);
  }, []);

  const refreshArrows = useCallback(() => {
    const ac = arrowRef.current;
    const src = canvasRef.current;
    const p = propsRef.current;
    if (!ac || !src) return;
    const ctx = ac.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, ac.width, ac.height);
    if (!p.showArrows) return;

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
    const head = new Path2D();
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
        head.moveTo(x + half * cos, y + half * sin);
        head.lineTo(x + (half - 4) * cos + 3 * sin, y + (half - 4) * sin - 3 * cos);
        head.lineTo(x + (half - 4) * cos - 3 * sin, y + (half - 4) * sin + 3 * cos);
        head.closePath();
      }
    }
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)';
    ctx.fillStyle = 'rgba(251, 191, 36, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke(shaft);
    ctx.fill(head);
  }, []);

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
  useEffect(() => {
    const set = (on: boolean) => {
      cursorRef.current?.classList.toggle('picking', on);
    };
    const down = (e: KeyboardEvent) => { if (e.key === 'Alt') set(true); };
    const up = (e: KeyboardEvent) => { if (e.key === 'Alt') set(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

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
   */
  const penDown = useCallback((u: number, v: number, alt: boolean) => {
    const p = propsRef.current;
    // Screen pixels, so the grab radius feels the same zoomed in or out.
    const sizePx = canvasRef.current?.getBoundingClientRect().width ?? p.size;
    const cur = penRef.current;

    if (cur.a.length >= 2 && uvDistPx(u, v, cur.a[0].x, cur.a[0].y, sizePx) <= CLOSE_PX) {
      penRef.current = { a: cur.a, closed: !cur.closed };
      setPen(penRef.current);
      drawPen();
      publishPen();
      return;
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
        return;
      }
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
  }, [drawPen, publishPen, pushPaths]);

  const onPointerDown = (e: React.PointerEvent) => {
    const p = propsRef.current;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Ctrl/Cmd + middle drag = zoom (vertical drag), matching the original.
    if (e.ctrlKey && e.button === 1) {
      zooming.current = true;
      zoomStart.current = { y: e.clientY, startScale: transform.current.scale };
      return;
    }
    // Panning is the middle button, in both views. Alt used to be an alias for
    // it (the original web app did that), but it now belongs to the eyedropper,
    // which is what Alt means in Photoshop.
    if (e.button === 1) {
      panning.current = true;
      panStart.current = { x: e.clientX - transform.current.x, y: e.clientY - transform.current.y };
      return;
    }
    if (e.button !== 0) return;
    const { u, v } = getUV(e);
    // The pen is tested *before* the Alt eyedropper, because with a pen Alt
    // means "this anchor, here" — add or remove one — which is what Alt does to
    // a path in Photoshop. The eyedropper is one key away and stickier, so
    // losing the modifier here costs nothing.
    if (p.tool === 'pen') {
      penDown(u, v, e.altKey);
      return;
    }
    // Alt = eyedropper, whatever tool is selected. Temporary: it is a modifier,
    // so releasing it returns to the tool on its own. Selecting the eyedropper
    // itself makes it stick for the whole drag.
    if (e.altKey || p.tool === 'eyedropper') {
      picking.current = true;
      pickSticky.current = p.tool === 'eyedropper';
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
    if (zooming.current && zoomStart.current) {
      const zs = zoomStart.current;
      const s = Math.max(0.1, Math.min(10, zs.startScale * (1 - (e.clientY - zs.y) * 0.005)));
      transform.current.scale = s;
      applyTransform();
      return;
    }
    if (panning.current && panStart.current) {
      transform.current.x = e.clientX - panStart.current.x;
      transform.current.y = e.clientY - panStart.current.y;
      applyTransform();
      return;
    }
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
    if (picking.current) {
      picking.current = false;
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
    const t = transform.current;
    t.scale = Math.max(0.1, Math.min(12, t.scale - e.deltaY * 0.0015));
    applyTransform();
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

  return (
    <div className="paint-view" onWheel={onWheel}>
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
            style={{ opacity: props.referenceOpacity }}
            draggable={false}
          />
        )}
        {/* Last, so it sits above the reference overlay: a sky texture across
            the path you are drawing is exactly the thing you cannot draw
            against. */}
        <canvas ref={penCanvasRef} width={props.size} height={props.size} className="paint-pen" />
      </div>
    </div>
  );
});

export default PaintView;
