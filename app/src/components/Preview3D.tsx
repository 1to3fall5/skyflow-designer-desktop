import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createSkyMaterial, createArrowMaterial } from './FlowShader';
import { nextCursor, shouldClearOnLeave, type CursorUV } from '../cursor';
import { NON_PAINTING_TOOLS, type Tool } from '../shortcuts';
import { ARROW_DASH_CELLS_PER_SEC, ARROW_DASH_PERIOD_CELLS } from '../arrows';

/**
 * 3D preview. Port of the original R3F `PreviewScene` without React Three
 * Fiber: same geometry, same OrbitControls button mapping, same UE-style
 * right-drag camera.
 */

export type Projection = 'equirectangular' | 'polar' | 'planar';

/**
 * Everything that differs between the three projection modes.
 *
 * Kept as a single pure table so "switching mode changes nothing" cannot
 * happen silently: `applyProjection` and the render loop both read from here,
 * and the unit tests assert the three rows really are different.
 *
 * Mirrors the original R3F `PreviewScene`: sphere for equirectangular/polar,
 * a ground plane viewed from outside for planar, and a -90° group rotation so
 * the polar disc's theta=0 seam faces the camera.
 */
export interface PreviewPlan {
  /** Which mesh carries the sky shader. */
  mesh: 'sphere' | 'plane';
  /** Y rotation applied to the whole group. */
  groupRotationY: number;
  /** Shader `uProjectionType`: 0 equirect, 1 polar, 2 planar. */
  projectionId: 0 | 1 | 2;
  /** OrbitControls rotateSpeed (negative = panorama seen from inside). */
  rotateSpeed: number;
  camera: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

export function previewPlan(projection: Projection): PreviewPlan {
  switch (projection) {
    case 'planar':
      return {
        mesh: 'plane',
        groupRotationY: 0,
        projectionId: 2,
        rotateSpeed: 0.5,
        camera: { x: 0, y: 0, z: 10 },
        target: { x: 0, y: -5, z: 0 },
      };
    case 'polar':
      return {
        mesh: 'sphere',
        groupRotationY: -Math.PI / 2,
        projectionId: 1,
        rotateSpeed: -0.5,
        camera: { x: 0, y: 0, z: 0.1 },
        target: { x: 0, y: 0, z: 0 },
      };
    case 'equirectangular':
    default:
      return {
        mesh: 'sphere',
        groupRotationY: 0,
        projectionId: 0,
        rotateSpeed: -0.5,
        camera: { x: 0, y: 0, z: 0.1 },
        target: { x: 0, y: 0, z: 0 },
      };
  }
}

export interface Preview3DProps {
  /** Shared 2D flow canvas; read lazily so it can be attached after mount. */
  flowCanvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  /** Bumped (no React re-render) whenever the flow canvas has new pixels. */
  flowVersionRef: React.MutableRefObject<number>;
  skyUrl: string | null;
  speed: number;
  distortion: number;
  showFlowMap: boolean;
  flowMapOpacity: number;
  showArrows: boolean;
  arrowDensity: number;
  brushSize: number;
  /** Working resolution of the flowmap, so the 3D ring matches the 2D one. */
  canvasSize: number;
  brushStrength: number;
  /** Drives the cursor's inner plateau, so the 3D ring shows hardness too. */
  brushHardness: number;
  /** Shared cursor in canvas coordinates (v measured from the top). The 2D view
   *  takes precedence, but this view publishes its own hover so the brush ring
   *  follows the pointer here too. */
  cursorUV: React.MutableRefObject<CursorUV | null>;
  /** True while a brush parameter is being scrubbed — freezes the ring. */
  adjusting: React.MutableRefObject<boolean>;
  /** Alt + right-drag scrub: `dx` is diameter, `dy` is hardness (down = harder). */
  onBrushScrub?: (dx: number, dy: number) => void;
  projection: Projection;
  polarAngle: number;
  paintEnabled: boolean;
  tool: Tool;
  /**
   * One frame's worth of stroke points, tail first.
   *
   * A batch, not a segment: pointermove fires far more often than the
   * frame does, and one IPC per event meant the 3D view spent a brush
   * stroke's worth of Rust work per *mouse report* — visibly stuttering
   * on a high-polling mouse. The 2D view has always coalesced to one per
   * frame; this is the same rule.
   */
  onPaint?: (pts: Array<[number, number]>) => void;
  onFill?: (u: number, v: number) => void;
  onPaintEnd?: () => void;
  /** Eyedropper: read the flow strength at this UV. */
  onPick?: (u: number, v: number) => void;
}

export interface Preview3DHandle {
  resetCamera: () => void;
}

/**
 * Sphere UV -> flowmap texture UV (mirrors getSamplingUV() in the shader).
 * Only polar remaps; equirectangular and planar are identity.
 */
export function samplingUV(u: number, v: number, projection: Projection, polarAngleDeg: number) {
  if (projection !== 'polar') return { u, v };
  const phi = (1 - v) * Math.PI;
  const theta = u * 2 * Math.PI;
  const polar = (polarAngleDeg * Math.PI) / 180;
  const r = (phi / polar) * 0.5;
  return { u: 0.5 + r * Math.sin(theta), v: 0.5 + r * Math.cos(theta) };
}

const NO_MOUSE = -1 as unknown as THREE.MOUSE;
const FLY_KEYS = ['w', 'a', 's', 'd', 'q', 'e'];

/**
 * Brush radius in UV space: half the brush diameter expressed in texels, so the
 * 3D ring covers exactly the same patch of flowmap as the 2D ring
 * (`brushSize / canvasSize` of the canvas, i.e. half of that as a radius).
 *
 * The original hard-coded 1024 here; with a project whose canvas is 2048 the 3D
 * ring would have been twice the 2D one.
 */
export function brushRadiusUV(brushSize: number, canvasSize: number): number {
  const n = canvasSize > 0 ? canvasSize : 1024;
  return brushSize / (2 * n);
}

/**
 * Biggest UV gap that still counts as one mouse move.
 *
 * Beyond this the two points are not neighbours on the surface — it is the
 * u = 0/1 seam, or the pointer appearing on the other side of a pole — and the
 * segment between them would run the width of the canvas.
 */
const SEAM_JUMP = 0.25;

/** Arrow grid (cells across, cells down) for a projection. */
export function arrowGrid(
  density: number,
  projection: Projection,
  planeAspect: number,
): [number, number] {
  return [
    density,
    projection === 'planar' ? Math.round(density / planeAspect) : Math.round(density / 2),
  ];
}

/** Grey checkerboard shown when no sky texture is loaded. */
function makeFallbackTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#444';
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = '#666';
  const g = 16;
  for (let y = 0; y < 256; y += g) {
    for (let x = 0; x < 512; x += g) {
      if ((x / g + y / g) % 2 === 0) ctx.fillRect(x, y, g, g);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const Preview3D = React.forwardRef<Preview3DHandle, Preview3DProps>((props, fref) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const threeRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    group: THREE.Group;
    skySphere: THREE.Mesh;
    skyPlane: THREE.Mesh;
    arrowSphere: THREE.Mesh;
    arrowPlane: THREE.Mesh;
    skyMat: THREE.ShaderMaterial;
    arrowMat: THREE.ShaderMaterial;
    flowTex: THREE.CanvasTexture | null;
    skyTex: THREE.Texture | null;
    fallbackTex: THREE.CanvasTexture;
    gizmo: THREE.Group;
    gizmoCamera: THREE.PerspectiveCamera;
    raycaster: THREE.Raycaster;
    clock: THREE.Clock;
    raf: number;
    seenVersion: number;
    planeAspect: number;
    dragging: boolean;
    rightDown: boolean;
    /** How far the arrow dashes have marched, in dash periods. */
    arrowDash: number;
    /** Stroke points waiting for the next frame. */
    paintQ: Array<[number, number]>;
    /** Last point already sent, so the next batch starts where it ended. */
    paintLast: [number, number] | null;
    /** Alt + right drag — the brush HUD. Also what keeps `rightDown` off. */
    brushScrub: { x: number; y: number } | null;
    keys: Record<string, boolean>;
    localHover: boolean;
    lastProj: Projection | null;
    resetCamera: () => void;
  } | null>(null);

  const paintingRef = useRef(false);
  const pickingRef = useRef(false);
  const pickStickyRef = useRef(false);
  const lastUV = useRef<{ u: number; v: number } | null>(null);

  const activeMesh = () => {
    const c = threeRef.current;
    if (!c) return null;
    return c.skySphere.visible ? c.skySphere : c.skyPlane;
  };

  // -- init ---------------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0a0a0a, 1);
    renderer.toneMapping = THREE.NoToneMapping; // R3F `flat`
    mount.appendChild(renderer.domElement);
    const el = renderer.domElement;
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.touchAction = 'none';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 2000);
    camera.position.set(0, 0, 0.1);

    const controls = new OrbitControls(camera, el);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.rotateSpeed = -0.5;
    controls.minPolarAngle = 0.01;
    controls.maxPolarAngle = Math.PI - 0.01;
    // Left is reserved for painting, right for the UE-style look; only the
    // middle button drives OrbitControls.
    controls.mouseButtons = { LEFT: NO_MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: NO_MOUSE };

    const group = new THREE.Group();
    scene.add(group);

    const skyMat = createSkyMaterial();
    const arrowMat = createArrowMaterial();

    // -- sphere variant (equirectangular / polar) --------------------------
    const skySphere = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 64), skyMat);
    skySphere.scale.x = -1; // un-mirror panoramas seen from inside
    skySphere.frustumCulled = false;
    group.add(skySphere);

    const arrowSphere = new THREE.Mesh(new THREE.SphereGeometry(9.8, 64, 32), arrowMat);
    arrowSphere.scale.x = -1;
    arrowSphere.frustumCulled = false;
    arrowSphere.raycast = () => {};
    group.add(arrowSphere);

    // -- plane variant (planar) --------------------------------------------
    const skyPlane = new THREE.Mesh(new THREE.PlaneGeometry(20, 10), skyMat);
    skyPlane.position.set(0, -5, 0);
    skyPlane.rotation.set(-Math.PI / 2, 0, 0);
    skyPlane.scale.set(1, -1, 1);
    skyPlane.visible = false;
    group.add(skyPlane);

    const arrowPlane = new THREE.Mesh(new THREE.PlaneGeometry(20, 10), arrowMat);
    arrowPlane.position.set(0, -4.99, 0);
    arrowPlane.rotation.set(-Math.PI / 2, 0, 0);
    arrowPlane.scale.set(1, -1, 1);
    arrowPlane.visible = false;
    arrowPlane.raycast = () => {};
    group.add(arrowPlane);

    const gizmo = new THREE.Group();
    gizmo.add(new THREE.AxesHelper(1));
    const gizmoCamera = new THREE.PerspectiveCamera(50, 1, 0.01, 10);

    const fallbackTex = makeFallbackTexture();
    skyMat.uniforms.uTexture.value = fallbackTex;

    const ctx = {
      renderer, scene, camera, controls, group,
      skySphere, skyPlane, arrowSphere, arrowPlane,
      skyMat, arrowMat, gizmo, gizmoCamera,
      flowTex: null as THREE.CanvasTexture | null,
      skyTex: null as THREE.Texture | null,
      fallbackTex,
      raycaster: new THREE.Raycaster(),
      clock: new THREE.Clock(),
      raf: 0,
      seenVersion: -1,
      planeAspect: 2,
      dragging: false,
      rightDown: false,
      arrowDash: 0,
      paintQ: [] as Array<[number, number]>,
      paintLast: null as [number, number] | null,
      brushScrub: null as { x: number; y: number } | null,
      keys: {} as Record<string, boolean>,
      localHover: false,
      lastProj: null as Projection | null,
      resetCamera: () => {},
    };
    threeRef.current = ctx;

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const applyProjection = (proj: Projection) => {
      if (ctx.lastProj === proj) return;
      ctx.lastProj = proj;
      const plan = previewPlan(proj);
      const planar = plan.mesh === 'plane';
      skySphere.visible = !planar;
      arrowSphere.visible = !planar;
      skyPlane.visible = planar;
      arrowPlane.visible = planar;
      controls.rotateSpeed = plan.rotateSpeed;
      camera.position.set(plan.camera.x, plan.camera.y, plan.camera.z);
      controls.target.set(plan.target.x, plan.target.y, plan.target.z);
      controls.update();
    };

    ctx.resetCamera = () => {
      const plan = previewPlan(ctx.lastProj ?? 'equirectangular');
      if (plan.mesh === 'plane') {
        camera.position.set(plan.camera.x, plan.camera.y, plan.camera.z);
        controls.target.set(plan.target.x, plan.target.y, plan.target.z);
      } else {
        // Re-centre inside the sphere but keep the current view direction.
        const offset = new THREE.Vector3().subVectors(controls.target, camera.position);
        camera.position.set(plan.camera.x, plan.camera.y, plan.camera.z);
        controls.target.copy(camera.position).add(offset);
      }
      controls.update();
    };

    const setPlaneAspect = (aspect: number) => {
      if (!isFinite(aspect) || aspect <= 0) return;
      ctx.planeAspect = aspect;
      const g = new THREE.PlaneGeometry(20, 20 / aspect);
      skyPlane.geometry.dispose();
      skyPlane.geometry = g;
      arrowPlane.geometry.dispose();
      arrowPlane.geometry = g.clone();
    };
    (mount as unknown as { __setPlaneAspect?: (a: number) => void }).__setPlaneAspect = setPlaneAspect;

    // -- pointer -----------------------------------------------------------
    const ndc = new THREE.Vector2();
    const toUV = (e: PointerEvent | MouseEvent): THREE.Vector2 | null => {
      const mesh = activeMesh();
      if (!mesh) return null;
      const rect = el.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ctx.raycaster.setFromCamera(ndc, camera);
      const hits = ctx.raycaster.intersectObject(mesh, false);
      return hits.length && hits[0].uv ? hits[0].uv.clone() : null;
    };

    /** Geometry UV -> canvas UV (shader space is bottom-up, canvas top-down). */
    const canvasUV = (uv: THREE.Vector2) => {
      const p = propsRef.current;
      const t = samplingUV(uv.x, uv.y, p.projection, p.polarAngle);
      return { u: t.u, v: 1 - t.v };
    };

    /**
     * Send this frame's stroke points as one call.
     *
     * Runs at the top of the render loop, so the most the engine can be asked
     * for is one stroke per frame — and the points arrive as one polyline
     * instead of a dozen separate segments.
     */
    const flushPaint = () => {
      const q = ctx.paintQ;
      if (q.length === 0) return;
      const pts = ctx.paintLast ? [ctx.paintLast, ...q] : q.slice();
      ctx.paintLast = pts[pts.length - 1];
      ctx.paintQ = [];
      propsRef.current.onPaint?.(pts);
    };

    const onDown = (e: PointerEvent) => {
      const p = propsRef.current;
      // Alt + right drag = the brush HUD, same as the 2D view. It has to win
      // over the UE-style right-drag look: Alt is the eyedropper on the left
      // button, so the scrub lives on the right one. `onWinMouseDown` below
      // checks `brushScrub` and leaves the camera alone for the duration.
      if (e.button === 2 && e.altKey && p.paintEnabled) {
        p.adjusting.current = true;
        document.body.classList.add('adjusting');
        ctx.brushScrub = { x: e.clientX, y: e.clientY };
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        return;
      }
      if (e.button === 2) { ctx.rightDown = true; return; }
      if (!p.paintEnabled || e.button !== 0) return;
      const uv = toUV(e);
      if (!uv) return;
      const c = canvasUV(uv);
      // Alt = eyedropper, same as the 2D view. Alt is free here: the camera is
      // on the right and middle buttons.
      if (e.altKey || p.tool === 'eyedropper') {
        pickingRef.current = true;
        // Same sticky/temporary split as the 2D view: Alt releases on key-up,
        // the tool stays for the whole drag.
        pickStickyRef.current = p.tool === 'eyedropper';
        p.onPick?.(c.u, c.v);
        return;
      }
      // The hand and eyedropper tools have no 3D painting meaning; the camera
      // controls are already on the right and middle buttons.
      if (p.tool === 'pan') return;
      paintingRef.current = true;
      ctx.dragging = true;
      lastUV.current = c;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (p.tool === 'magic_wand') p.onFill?.(c.u, c.v);
      else { ctx.paintQ = [[c.u, c.v]]; ctx.paintLast = null; }
    };

    const onMove = (e: PointerEvent) => {
      const p = propsRef.current;
      const uv = toUV(e);
      ctx.localHover = !!uv && p.paintEnabled;
      // Alt + right drag: diameter on X, hardness on Y (down is harder). Read
      // before the eyedropper, which would otherwise claim every frame of it.
      if (ctx.brushScrub) {
        const dx = e.clientX - ctx.brushScrub.x;
        const dy = e.clientY - ctx.brushScrub.y;
        ctx.brushScrub.x = e.clientX;
        ctx.brushScrub.y = e.clientY;
        if (dx || dy) p.onBrushScrub?.(dx, dy);
        return;
      }
      if (uv) {
        const c = canvasUV(uv);
        p.cursorUV.current = nextCursor(p.adjusting.current, c, p.cursorUV.current);
      }
      if (!uv) return;
      const c = canvasUV(uv);
      // Dragging with Alt keeps sampling, the way Photoshop's eyedropper does.
      if (pickingRef.current) {
        if (e.altKey || pickStickyRef.current) p.onPick?.(c.u, c.v);
        return;
      }
      if (!paintingRef.current) return;
      if (p.tool !== 'magic_wand') {
        // A jump this big is the u = 0/1 seam or the far side of a pole, not a
        // mouse move: connecting the two would stamp a brush stroke clean
        // across the whole flowmap, which is both wrong and the most expensive
        // thing the engine can be asked to do. End the run instead.
        const prev = ctx.paintQ.length
          ? ctx.paintQ[ctx.paintQ.length - 1]
          : ctx.paintLast;
        if (prev && Math.hypot(c.u - prev[0], c.v - prev[1]) > SEAM_JUMP) {
          flushPaint();
          ctx.paintLast = null;
        }
        ctx.paintQ.push([c.u, c.v]);
      }
      lastUV.current = c;
    };

    const onUp = (e: PointerEvent) => {
      const p = propsRef.current;
      if (ctx.brushScrub) {
        ctx.brushScrub = null;
        p.adjusting.current = false;
        document.body.classList.remove('adjusting');
        try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        return;
      }
      if (e.button === 2) { ctx.rightDown = false; return; }
      if (pickingRef.current) { pickingRef.current = false; return; }
      if (!paintingRef.current) return;
      paintingRef.current = false;
      ctx.dragging = false;
      lastUV.current = null;
      // The gesture is over, so whatever is still queued goes now rather than
      // waiting for a frame that may never come.
      flushPaint();
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      propsRef.current.onPaintEnd?.();
    };
    const onLeave = () => {
      ctx.localHover = false;
      const p = propsRef.current;
      if (shouldClearOnLeave(p.adjusting.current)) p.cursorUV.current = null;
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointerleave', onLeave);

    // -- UE-style right-drag look + WASDQE fly -----------------------------
    const onWinMouseDown = (e: MouseEvent) => {
      // A right press that is already scrubbing the brush must not also turn
      // the camera. Pointerdown lands first, so `brushScrub` is set by now.
      if (e.button === 2 && !ctx.brushScrub) ctx.rightDown = true;
    };
    const onWinMouseUp = (e: MouseEvent) => { if (e.button === 2) ctx.rightDown = false; };
    const onWinMouseMove = (e: MouseEvent) => {
      if (!ctx.rightDown) return;
      const sensitivity = 0.002;
      const target = controls.target;
      const vector = new THREE.Vector3().subVectors(target, camera.position);
      vector.applyAxisAngle(new THREE.Vector3(0, 1, 0), -e.movementX * sensitivity);
      const worldUp = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(vector, worldUp).normalize();
      if (right.lengthSq() > 0.001) {
        const original = vector.clone();
        vector.applyAxisAngle(right, -e.movementY * sensitivity);
        const angleToUp = vector.angleTo(worldUp);
        const limit = 0.01;
        if (angleToUp < limit || angleToUp > Math.PI - limit) vector.copy(original);
      }
      target.copy(camera.position).add(vector);
      controls.update();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (FLY_KEYS.includes(k)) ctx.keys[k] = true;
      // Ctrl/Cmd + middle button dollies instead of rotating.
      if (e.ctrlKey || e.metaKey) {
        controls.mouseButtons = { LEFT: NO_MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: NO_MOUSE };
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (FLY_KEYS.includes(k)) ctx.keys[k] = false;
      controls.mouseButtons = { LEFT: NO_MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: NO_MOUSE };
    };
    window.addEventListener('mousedown', onWinMouseDown);
    window.addEventListener('mouseup', onWinMouseUp);
    window.addEventListener('mousemove', onWinMouseMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // -- render loop -------------------------------------------------------
    const WORLD_UP = new THREE.Vector3(0, 1, 0);
    const forward = new THREE.Vector3();
    const camRight = new THREE.Vector3();
    const moveDir = new THREE.Vector3();

    const loop = () => {
      ctx.raf = requestAnimationFrame(loop);
      const p = propsRef.current;
      const dt = Math.min(ctx.clock.getDelta(), 0.1);
      flushPaint();
      applyProjection(p.projection);

      if (ctx.rightDown) {
        const k = ctx.keys;
        if (FLY_KEYS.some((key) => k[key])) {
          camera.getWorldDirection(forward);
          camRight.crossVectors(forward, camera.up).normalize();
          moveDir.set(0, 0, 0);
          if (k.w) moveDir.add(forward);
          if (k.s) moveDir.sub(forward);
          if (k.d) moveDir.add(camRight);
          if (k.a) moveDir.sub(camRight);
          if (k.e) moveDir.add(WORLD_UP);
          if (k.q) moveDir.sub(WORLD_UP);
          if (moveDir.lengthSq() > 0) {
            moveDir.normalize().multiplyScalar(10 * dt);
            camera.position.add(moveDir);
            controls.target.add(moveDir);
          }
        }
      }

      const plan = previewPlan(p.projection);
      const projId = plan.projectionId;
      const u = skyMat.uniforms;
      u.uTime.value = ctx.clock.elapsedTime;
      u.uSpeed.value = p.speed;
      u.uDistortionStrength.value = p.distortion;
      u.uShowFlowMap.value = p.showFlowMap ? 1 : 0;
      u.uFlowMapOpacity.value = p.flowMapOpacity;
      // Brush radius in UV. The original divides by the 1024 working size.
      u.uBrushSize.value = brushRadiusUV(p.brushSize, p.canvasSize);
      u.uBrushStrength.value = p.brushStrength;
      u.uBrushHardness.value = p.brushHardness;
      u.uProjectionType.value = projId;
      u.uPolarAngle.value = (p.polarAngle * Math.PI) / 180;

      // The 2D view's cursor wins; otherwise fall back to local hover.
      const ext = p.cursorUV.current;
      if (ext) u.uCursor.value.set(ext.u, 1 - ext.v);
      u.uShowCursor.value = ext || ctx.localHover ? 1 : 0;

      const au = arrowMat.uniforms;
      au.uProjectionType.value = projId;
      au.uPolarAngle.value = (p.polarAngle * Math.PI) / 180;
      const [gx, gy] = arrowGrid(p.arrowDensity, p.projection, ctx.planeAspect);
      au.uGridSize.value.set(gx, gy);
      // The dash travels a fixed number of *cells* per second, the same rule the
      // 2D canvas uses, so the two halves of a split march in step. Paused is
      // not "phase 0": the shader draws solid shafts instead.
      if (p.speed > 0) {
        ctx.arrowDash += (dt * p.speed * ARROW_DASH_CELLS_PER_SEC) / ARROW_DASH_PERIOD_CELLS;
        au.uDash.value = ctx.arrowDash;
      } else {
        au.uDash.value = -1;
      }

      arrowSphere.visible = p.showArrows && skySphere.visible;
      arrowPlane.visible = p.showArrows && skyPlane.visible;

      // Polar mode rotates the disc so theta=0 faces the camera's forward axis.
      group.rotation.y = plan.groupRotationY;

      const fc = p.flowCanvasRef.current;
      if (fc && ctx.flowTex?.image !== fc) {
        ctx.flowTex?.dispose();
        const t = new THREE.CanvasTexture(fc);
        t.colorSpace = THREE.NoColorSpace;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.generateMipmaps = false;
        ctx.flowTex = t;
        u.uFlowMap.value = t;
        au.uFlowMap.value = t;
        ctx.seenVersion = -1;
      }
      // Every pixel change bumps the version (applySnap does it on the same
      // tick as the canvas write), so `dragging` here only bought a 4 MB
      // upload on every frame of a stroke, most of them unchanged.
      if (ctx.flowTex && ctx.seenVersion !== p.flowVersionRef.current) {
        ctx.seenVersion = p.flowVersionRef.current;
        ctx.flowTex.needsUpdate = true;
      }

      controls.update();
      renderer.render(scene, camera);

      // Orientation gizmo in the bottom-right corner.
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        // Top-right with an 80px inset — matches drei's
        // `<GizmoHelper alignment="top-right" margin={[80, 80]}>`.
        const size = 76;
        const margin = 80;
        const left = w - size - margin;
        const top = h - size - margin;
        renderer.setScissorTest(true);
        renderer.setViewport(left, top, size, size);
        renderer.setScissor(left, top, size, size);
        gizmoCamera.position.copy(camera.position).sub(controls.target).normalize().multiplyScalar(4.2);
        gizmoCamera.lookAt(0, 0, 0);
        renderer.render(gizmo, gizmoCamera);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
      }
    };
    loop();

    return () => {
      cancelAnimationFrame(ctx.raf);
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('mousedown', onWinMouseDown);
      window.removeEventListener('mouseup', onWinMouseUp);
      window.removeEventListener('mousemove', onWinMouseMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      controls.dispose();
      [skySphere, skyPlane, arrowSphere, arrowPlane].forEach((m) => m.geometry.dispose());
      skyMat.dispose();
      arrowMat.dispose();
      fallbackTex.dispose();
      renderer.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
      threeRef.current = null;
    };
  }, []);

  // -- cursor: the brush ring is the pointer, so hide the OS arrow ---------
  // (matches the original, which sets this from `activeTool`).
  useEffect(() => {
    const ctx = threeRef.current;
    if (!ctx) return;
    ctx.renderer.domElement.style.cursor = NON_PAINTING_TOOLS.has(props.tool) ? 'default' : 'none';
  }, [props.tool]);

  // -- sky texture ---------------------------------------------------------
  useEffect(() => {
    const ctx = threeRef.current;
    if (!ctx) return;
    if (!props.skyUrl) {
      ctx.skyMat.uniforms.uTexture.value = ctx.fallbackTex;
      ctx.planeAspect = 2;
      return;
    }
    new THREE.TextureLoader().load(props.skyUrl, (tex) => {
      if (!threeRef.current) return;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      const img = tex.image as { width?: number; height?: number } | undefined;
      if (img?.width && img?.height) {
        const m = mountRef.current as unknown as { __setPlaneAspect?: (a: number) => void } | null;
        m?.__setPlaneAspect?.(img.width / img.height);
      }
      threeRef.current.skyTex?.dispose();
      threeRef.current.skyTex = tex;
      threeRef.current.skyMat.uniforms.uTexture.value = tex;
    });
  }, [props.skyUrl]);

  React.useImperativeHandle(fref, () => ({
    resetCamera: () => { threeRef.current?.resetCamera(); },
  }), []);

  return <div ref={mountRef} className="preview3d" />;
});

export default Preview3D;
