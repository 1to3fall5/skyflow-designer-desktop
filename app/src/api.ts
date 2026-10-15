import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

export type LayerKind = 'paint' | 'wind' | 'obstacle';

export interface LayerInfo {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  opacity: number;
  blur: number;
  direction: number;
  strength: number;
  disturbance_enabled: boolean;
  disturbance: number;
  has_mask: boolean;
}

export interface AppState {
  size: number;
  active: string;
  projection: 'equirectangular' | 'polar' | 'planar';
  polar_angle: number;
  layers: LayerInfo[];
  reference_path: string | null;
  project_path: string | null;
}

export interface Snapshot {
  x: number;
  y: number;
  w: number;
  h: number;
  data: string;
  full: boolean;
  ms: number;
  /**
   * Fresh engine state returned alongside the pixels. Every mutating command
   * carries it, so callers must push it into React state — otherwise
   * `projection` / `polar_angle` / the layer list silently go stale and the
   * 3D preview never switches geometry.
   */
  state: AppState;
}

export interface LayerPatch {
  id: string;
  name?: string;
  visible?: boolean;
  opacity?: number;
  blur?: number;
  direction?: number;
  strength?: number;
  disturbance_enabled?: boolean;
  disturbance?: number;
}

const EMPTY_STATE: AppState = {
  size: 0,
  active: '',
  projection: 'equirectangular',
  polar_angle: 90,
  layers: [],
  reference_path: null,
  project_path: null,
};
const EMPTY: Snapshot = { x: 0, y: 0, w: 0, h: 0, data: '', full: false, ms: 0, state: EMPTY_STATE };

export const api = {
  getState: () => invoke<AppState>('get_state'),
  refresh: () => invoke<Snapshot>('refresh'),
  setSize: (size: number) => invoke<Snapshot>('set_size', { size }),
  loadReference: (path: string) => invoke<AppState>('load_reference', { path }),
  /** PNG data URL for display — the WebView cannot decode TGA itself. */
  getReferencePng: () => invoke<string | null>('get_reference_png'),
  clearReference: () => invoke<AppState>('clear_reference'),
  saveHistory: () => invoke<void>('save_history'),
  undo: () => invoke<Snapshot>('undo'),
  redo: () => invoke<Snapshot>('redo'),
  updateLayer: (patch: LayerPatch) => invoke<Snapshot>('update_layer', { patch }),
  addLayer: (kind: LayerKind) => invoke<Snapshot>('add_layer', { kind }),
  removeLayer: (id: string) => invoke<Snapshot>('remove_layer', { id }),
  reorder: (from: number, to: number) => invoke<Snapshot>('reorder', { from, to }),
  setActive: (id: string) => invoke<AppState>('set_active', { id }),
  clearLayer: (id: string) => invoke<Snapshot>('clear_layer', { id }),
  setProjection: (projection: string, polarAngle: number) =>
    invoke<Snapshot>('set_projection', { projection, polarAngle }),
  export: (path: string, invertX: boolean, invertY: boolean, size?: number) =>
    invoke<void>('export_flowmap', { req: { path, invert_x: invertX, invert_y: invertY, size } }),
  saveProject: (path: string) => invoke<void>('save_project', { path }),
  loadProject: (path: string) => invoke<Snapshot>('load_project', { path }),
  newProject: (size: number) => invoke<Snapshot>('new_project', { size }),
  pushRecent: (path: string) => invoke<void>('push_recent', { path }),
  getRecent: () => invoke<string[]>('get_recent'),
  bench: () => invoke<number[]>('bench'),

  // `strokeId` identifies the pointer stroke this batch belongs to. The engine
  // uses it to tell "more of the same drag" from "another pass over the same
  // spot", which is what lets a low-strength brush build up over repeated
  // strokes instead of capping out at its own value.
  // `strength` is the ceiling (the flow vector length you are aiming at);
  // `flow` is how much of the remaining distance one stroke covers.
  stroke: (points: [number, number][], size: number, hardness: number,
          strength: number, erase: boolean, target: string, strokeId: number,
          flow: number) =>
    invoke<Snapshot>('stroke', {
      req: { points, size, hardness, strength, erase, target, stroke_id: strokeId, flow },
    }).catch(() => EMPTY),

  /** Eyedropper: the flow strength under a UV point, 0..1. */
  sampleStrength: (u: number, v: number, source: 'layer' | 'composite') =>
    invoke<number>('sample_strength', { req: { u, v, source } }).catch(() => 0),

  floodFill: (u: number, v: number, threshold: number, target: string) =>
    invoke<Snapshot>('flood_fill', { req: { u, v, threshold, target } }).catch(() => EMPTY),
};

export { convertFileSrc };

// ---------------------------------------------------------------------------
// Pointer-stroke identity
// ---------------------------------------------------------------------------

// Shared by the 2D and 3D painters: the engine compares against the id it last
// saw, so the two views must not hand out the same number. Bump once per
// pointer-down; everything else about a drag reuses it.
let strokeSeq = 0;
export const nextStrokeId = (): number => (strokeSeq += 1);

// ---------------------------------------------------------------------------
// base64 -> ImageData (reused buffers, no per-frame allocation)
// ---------------------------------------------------------------------------

let binBuf: ArrayBuffer = new ArrayBuffer(0);
let binView: Uint8Array = new Uint8Array(0);

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  if (binView.length < len) {
    binBuf = new ArrayBuffer(len);
    binView = new Uint8Array(binBuf);
  }
  const v = binView;
  for (let i = 0; i < len; i++) v[i] = bin.charCodeAt(i);
  return v.subarray(0, len);
}

const imgDataCache = new Map<string, ImageData>();

/** Build an ImageData of w*h reusing a cached object when possible. */
export function toImageData(bytes: Uint8Array, w: number, h: number): ImageData {
  const key = `${w}x${h}`;
  let img = imgDataCache.get(key);
  if (!img) {
    img = new ImageData(w, h);
    imgDataCache.set(key, img);
  }
  new Uint8ClampedArray(img.data.buffer).set(bytes);
  return img;
}
