import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, nextStrokeId, decodeBase64, toImageData, Snapshot } from '../api';
import { nextCursor, shouldClearOnLeave, type CursorUV } from '../cursor';
import { brushGradient } from '../brush';
import {
  CLOSE_PX, PEN_FLOW, flattenPath, uvDistPx,
  type Anchor,
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
}

/** What the options bar needs to say about the path in progress. */
export interface PenInfo {
  anchors: number;
  closed: boolean;
}

export interface PaintViewProps {
  size: number;
  tool: Tool;
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
  /** Pen path changed, so the options bar can say how many anchors are down. */
  onPenInfo?: (info: PenInfo) => void;
}

const ARROW_SAMPLE = 128;

const NO_PATH: { a: Anchor[]; closed: boolean } = { a: [], closed: false };

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
   * The path overlay: curve, anchors, and the handles you can still grab.
   *
   * Drawn on its own canvas at the flowmap's resolution rather than as SVG over
   * the stage, so it shares one coordinate space with the pixels it is about to
   * become — and so it pans and zooms with them for free, exactly like the
   * arrow overlay next to it.
   */
  const drawPen = useCallback(() => {
    const c = penCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const n = c.width;
    ctx.clearRect(0, 0, n, n);
    const { a, closed } = penRef.current;
    if (a.length === 0) return;

    const X = (x: number) => x * n;
    const lw = Math.max(1, n / 700);

    const pts = flattenPath(a, closed, n);
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(X(pts[0][0]), X(pts[0][1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), X(pts[i][1]));
      if (closed) ctx.closePath();
      ctx.lineWidth = lw;
      ctx.strokeStyle = '#378ef0';
      ctx.stroke();
    }

    // Handles first, so the anchors sit on top of them.
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(236,236,236,.55)';
    ctx.fillStyle = '#ececec';
    for (const p of a) {
      if (p.hx === 0 && p.hy === 0) continue;
      ctx.beginPath();
      ctx.moveTo(X(p.x - p.hx), X(p.y - p.hy));
      ctx.lineTo(X(p.x + p.hx), X(p.y + p.hy));
      ctx.stroke();
      for (const [hx, hy] of [[p.hx, p.hy], [-p.hx, -p.hy]]) {
        ctx.beginPath();
        ctx.arc(X(p.x + hx), X(p.y + hy), Math.max(1.5, n / 400), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const sq = Math.max(3, n / 300);
    a.forEach((p, i) => {
      // The first anchor is ringed: clicking it closes the path, and an
      // affordance you cannot see is an affordance you will not find.
      ctx.fillStyle = i === 0 ? '#7cc4ff' : '#ffffff';
      ctx.fillRect(X(p.x) - sq / 2, X(p.y) - sq / 2, sq, sq);
      if (i === 0 && a.length > 1) {
        ctx.lineWidth = lw;
        ctx.strokeStyle = '#7cc4ff';
        ctx.strokeRect(X(p.x) - sq, X(p.y) - sq, sq * 2, sq * 2);
      }
    });
  }, []);

  useEffect(() => {
    drawPen();
    propsRef.current.onPenInfo?.({ anchors: pen.a.length, closed: pen.closed });
  }, [pen, props.size, drawPen]);

  // A path belongs to the pen. Switching tools abandons it rather than leaving
  // an invisible one that the next Enter would stamp somewhere you forgot.
  useEffect(() => {
    penDrag.current = null;
    setPen(NO_PATH);
  }, [props.tool]);

  const scheduleArrows = useCallback(() => {
    if (arrowTimer.current) return;
    arrowTimer.current = window.setTimeout(() => {
      arrowTimer.current = 0;
      refreshArrows();
    }, 80);
  }, [refreshArrows]);

  const commitPen = useCallback(() => {
    const p = propsRef.current;
    const { a, closed } = penRef.current;
    penDrag.current = null;
    setPen(NO_PATH);
    if (a.length < 2) return false;

    const pts = flattenPath(a, closed, p.size);
    if (pts.length < 2) return false;

    // One path, one stroke id, one undo step: the engine resets its deposit
    // record when the id changes, so a path that crosses itself does not
    // compound where it overlaps — the same rule a single drag gets.
    strokeId.current = nextStrokeId();
    api.stroke(pts, p.brushSize, p.brushHardness, p.brushStrength, false,
      p.editTarget, strokeId.current, PEN_FLOW)
      .then((s) => {
        applySnapshot(s);
        scheduleArrows();
        // Same accounting as finishing a brush drag: one history entry, one
        // thumbnail refresh.
        propsRef.current.onStrokeEnd();
      });
    return true;
  }, [applySnapshot, scheduleArrows]);

  const cancelPen = useCallback(() => {
    if (penRef.current.a.length === 0) return false;
    penDrag.current = null;
    setPen(NO_PATH);
    return true;
  }, []);

  const popPen = useCallback(() => {
    const cur = penRef.current;
    if (cur.a.length === 0) return false;
    penDrag.current = null;
    setPen({ a: cur.a.slice(0, -1), closed: cur.a.length > 2 ? cur.closed : false });
    return true;
  }, []);

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
  }), [applySnapshot, refreshArrows, applyTransform, commitPen, cancelPen, popPen]);

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
    // The pen never sets `drawing`: it places anchors instead of dragging ink,
    // and a path stays editable until you commit it.
    if (p.tool === 'pen') {
      const cur = penRef.current;
      const rect = canvasRef.current!.getBoundingClientRect();
      // Clicking the first anchor closes the loop. Measured in screen pixels,
      // not canvas ones, because it is a click — it has to feel the same
      // whether the view is zoomed in or out.
      if (cur.a.length >= 2 && uvDistPx(u, v, cur.a[0].x, cur.a[0].y, rect.width) <= CLOSE_PX) {
        setPen({ a: cur.a, closed: !cur.closed });
        return;
      }
      const a = [...cur.a, { x: u, y: v, hx: 0, hy: 0 }];
      penDrag.current = a.length - 1;
      setPen({ a, closed: cur.closed });
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
