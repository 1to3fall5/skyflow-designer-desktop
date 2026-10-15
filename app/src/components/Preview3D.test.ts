/**
 * Geometry-level checks for the 3D preview. No WebGL required — three.js
 * raycasting is pure maths, which is enough to catch orientation bugs.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { samplingUV, brushRadiusUV, arrowGrid, previewPlan } from './Preview3D';
import { SKY_FRAG, createSkyMaterial } from './FlowShader';
import type { Projection } from './Preview3D';

const ALL: Projection[] = ['equirectangular', 'polar', 'planar'];

function makeSky(mirrorX: boolean) {
  const geo = new THREE.SphereGeometry(500, 96, 64);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  if (mirrorX) mesh.scale.x = -1;
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** UV under the given horizontal screen position (ndc x) for a camera at the origin. */
function uvAtNdcX(mesh: THREE.Mesh, ndcX: number): THREE.Vector2 | null {
  const cam = new THREE.PerspectiveCamera(75, 1, 0.1, 2000);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(ndcX, 0), cam);
  const hits = rc.intersectObject(mesh, false);
  return hits.length ? (hits[0].uv ?? null) : null;
}

describe('sky sphere orientation', () => {
  it('mirrored sphere reads u left-to-right like the 2D canvas', () => {
    const mesh = makeSky(true);
    const left = uvAtNdcX(mesh, -0.5);
    const right = uvAtNdcX(mesh, +0.5);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    // The 2D canvas puts u=0 on the left, so the preview must agree,
    // otherwise painting in 3D lands mirrored relative to the flow canvas.
    expect(right!.x).toBeGreaterThan(left!.x);
  });

  it('an unmirrored sphere would be flipped (regression guard)', () => {
    const mesh = makeSky(false);
    const left = uvAtNdcX(mesh, -0.5);
    const right = uvAtNdcX(mesh, +0.5);
    expect(right!.x).toBeLessThan(left!.x);
  });
});

describe('previewPlan — the three modes must actually differ', () => {
  const plans = new Map(ALL.map((p) => [p, previewPlan(p)]));

  it('every mode produces a distinct plan', () => {
    // The bug this guards: switching mode changed nothing, because the props
    // never reached the scene and each branch collapsed to the same values.
    const json = ALL.map((p) => JSON.stringify(plans.get(p)));
    expect(new Set(json).size).toBe(3);
  });

  it('planar is the only mode on a plane, viewed from outside', () => {
    expect(plans.get('planar')!.mesh).toBe('plane');
    expect(plans.get('equirectangular')!.mesh).toBe('sphere');
    expect(plans.get('polar')!.mesh).toBe('sphere');
    // Outside the sphere: camera pulled back and target dropped to the plane.
    expect(plans.get('planar')!.camera.z).toBeGreaterThan(1);
    expect(plans.get('planar')!.target.y).toBeLessThan(0);
  });

  it('spherical modes put the camera at the sphere centre', () => {
    for (const p of ['equirectangular', 'polar'] as Projection[]) {
      const plan = plans.get(p)!;
      expect(Math.hypot(plan.camera.x, plan.camera.y, plan.camera.z)).toBeLessThan(1);
      expect(plan.target).toEqual({ x: 0, y: 0, z: 0 });
    }
  });

  it('rotateSpeed flips sign between panorama and plane', () => {
    expect(plans.get('equirectangular')!.rotateSpeed).toBeLessThan(0);
    expect(plans.get('polar')!.rotateSpeed).toBeLessThan(0);
    expect(plans.get('planar')!.rotateSpeed).toBeGreaterThan(0);
  });

  it('shader projection ids are 0/1/2 and unique', () => {
    const ids = ALL.map((p) => plans.get(p)!.projectionId);
    expect(ids).toEqual([0, 1, 2]);
  });

  it('only polar rotates the group', () => {
    expect(plans.get('polar')!.groupRotationY).toBeCloseTo(-Math.PI / 2, 8);
    expect(plans.get('equirectangular')!.groupRotationY).toBe(0);
    expect(plans.get('planar')!.groupRotationY).toBe(0);
  });

  it('unknown input falls back to equirectangular', () => {
    expect(previewPlan('nonsense' as Projection)).toEqual(previewPlan('equirectangular'));
  });
});

describe('samplingUV', () => {
  it('is identity for equirectangular and planar', () => {
    expect(samplingUV(0.25, 0.75, 'equirectangular', 90)).toEqual({ u: 0.25, v: 0.75 });
    expect(samplingUV(0.25, 0.75, 'planar', 90)).toEqual({ u: 0.25, v: 0.75 });
  });

  it('maps the zenith to the centre of a polar image', () => {
    const c = samplingUV(0.37, 1.0, 'polar', 90);
    expect(c.u).toBeCloseTo(0.5, 5);
    expect(c.v).toBeCloseTo(0.5, 5);
  });

  it('maps the equator to the rim of the disc', () => {
    const r = samplingUV(0, 0.5, 'polar', 90);
    expect(Math.hypot(r.u - 0.5, r.v - 0.5)).toBeCloseTo(0.5, 5);
  });

  it('maps theta=0 to the top of the image', () => {
    const p = samplingUV(0, 0.5, 'polar', 90);
    expect(p.u).toBeCloseTo(0.5, 5);
    expect(p.v).toBeCloseTo(1.0, 5); // straight up in texture space
  });

  it('quarter turn lands a quarter way round', () => {
    const p = samplingUV(0.25, 0.5, 'polar', 90);
    expect(p.u).toBeCloseTo(1.0, 5);
    expect(p.v).toBeCloseTo(0.5, 5);
  });

  it('is independent of the polar angle for non-polar modes', () => {
    expect(samplingUV(0.3, 0.6, 'equirectangular', 180))
      .toEqual(samplingUV(0.3, 0.6, 'equirectangular', 45));
  });

  it('a wider polar angle pulls the equator inward', () => {
    const narrow = samplingUV(0, 0.5, 'polar', 90);
    const wide = samplingUV(0, 0.5, 'polar', 180);
    const rn = Math.hypot(narrow.u - 0.5, narrow.v - 0.5);
    const rw = Math.hypot(wide.u - 0.5, wide.v - 0.5);
    expect(rw).toBeLessThan(rn);
  });
});

describe('brush radius in UV', () => {
  it('is half the brush diameter expressed in texels', () => {
    // A regression here makes the 3D ring wildly larger or smaller than the 2D
    // one. The 2D ring is `brushSize / canvasSize` of the canvas across.
    expect(brushRadiusUV(24, 1024)).toBeCloseTo(12 / 1024, 8);
    expect(brushRadiusUV(200, 1024)).toBeCloseTo(100 / 1024, 8);
  });

  it('tracks the live canvas size, not a hard-coded 1024', () => {
    // The original hard-coded 1024; on a 2048 project the 3D ring would have
    // been twice the size of the 2D one.
    expect(brushRadiusUV(24, 2048)).toBeCloseTo(brushRadiusUV(24, 1024) / 2, 8);
    expect(brushRadiusUV(24, 512)).toBeCloseTo(brushRadiusUV(24, 1024) * 2, 8);
  });

  it('falls back to 1024 rather than dividing by zero', () => {
    expect(brushRadiusUV(24, 0)).toBeCloseTo(12 / 1024, 8);
  });

  it('stays inside UV space for the largest brush', () => {
    expect(brushRadiusUV(200, 1024)).toBeLessThan(0.5);
    expect(brushRadiusUV(200, 512)).toBeLessThan(0.5);
  });
});

describe('brush ring is 1 screen pixel, like the 2D border', () => {
  it('derives the width from fwidth instead of a fixed UV constant', () => {
    // A fixed UV width is thin when zoomed out and fat when zoomed in.
    expect(SKY_FRAG).toMatch(/fwidth\(dist\)/);
    expect(SKY_FRAG).not.toMatch(/ringWidth\s*=\s*0\./);
  });

  it('matches the 2D ring opacity', () => {
    expect(SKY_FRAG).toMatch(/ringAlpha \* 0\.85/);
  });
});

describe('3D cursor shows strength and hardness, like the 2D ring', () => {
  it('drives the fill from the brush strength', () => {
    // Was a fixed `uBrushStrength * 0.5` capped at 50%: scrubbing strength in
    // the 3D view had no visible effect at all.
    expect(SKY_FRAG).not.toMatch(/uBrushStrength \* 0\.5\b/);
    expect(SKY_FRAG).toMatch(/uBrushStrength \* 0\.8/);
  });

  it('takes hardness as a uniform', () => {
    expect(SKY_FRAG).toMatch(/uniform float uBrushHardness;/);
    expect(createSkyMaterial().uniforms.uBrushHardness).toBeDefined();
  });

  it('reproduces the engine profile, not a stand-in ramp', () => {
    // Same constants as engine/ops.rs CORE_MIN / CORE_MAX and src/brush.ts.
    expect(SKY_FRAG).toMatch(/0\.40 \+ 0\.59 \* clamp\(uBrushHardness/);
    expect(SKY_FRAG).toMatch(/k \* k \* k \* \(k \* \(k \* 6\.0 - 15\.0\) \+ 10\.0\)/);
  });

  it('layers the 10% wash under the profile, again like the 2D ring', () => {
    expect(SKY_FRAG).toMatch(/innerAlpha \* 0\.10/);
    expect(SKY_FRAG).toMatch(/fillAlpha = wash \+ paint \* \(1\.0 - wash\)/);
  });
});

describe('arrow grid', () => {
  it('halves vertically on spherical projections', () => {
    expect(arrowGrid(48, 'equirectangular', 2)).toEqual([48, 24]);
    expect(arrowGrid(48, 'polar', 2)).toEqual([48, 24]);
  });

  it('uses the image aspect on planar', () => {
    expect(arrowGrid(48, 'planar', 2)).toEqual([48, 24]);
    expect(arrowGrid(48, 'planar', 4)).toEqual([48, 12]);
  });
});
