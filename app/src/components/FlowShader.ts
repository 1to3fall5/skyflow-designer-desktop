import * as THREE from 'three';

export const SKY_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SAMPLING_UV = /* glsl */ `
  vec2 getSamplingUV(vec2 sphereUV) {
      if (abs(uProjectionType - 1.0) < 0.1) {
          float phi = (1.0 - sphereUV.y) * 3.14159265;
          float theta = sphereUV.x * 2.0 * 3.14159265;
          float r = (phi / uPolarAngle) * 0.5;
          float x = r * sin(theta);
          float y = r * cos(theta);
          return vec2(0.5 + x, 0.5 + y);
      }
      return sphereUV;
  }
`;

export const SKY_FRAG = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uTexture;
  uniform sampler2D uFlowMap;
  uniform float uSpeed;
  uniform float uDistortionStrength;
  uniform vec2 uCursor;
  uniform float uBrushSize;
  uniform float uBrushStrength;
  uniform float uBrushHardness;
  uniform float uShowCursor;
  uniform float uProjectionType;
  uniform float uPolarAngle;
  uniform float uShowFlowMap;
  uniform float uFlowMapOpacity;

  varying vec2 vUv;

  ${SAMPLING_UV}

  void main() {
    vec2 baseUV = getSamplingUV(vUv);
    vec4 flowColor = texture2D(uFlowMap, baseUV);
    vec2 flowDir = (flowColor.rg - 0.5) * 2.0;
    float mobility = flowColor.b;
    flowDir *= mobility;

    float progress1 = fract(uTime * uSpeed);
    float progress2 = fract(uTime * uSpeed + 0.5);

    vec2 uv1 = baseUV + flowDir * progress1 * uDistortionStrength;
    vec2 uv2 = baseUV + flowDir * progress2 * uDistortionStrength;

    vec4 col1 = texture2D(uTexture, uv1);
    vec4 col2 = texture2D(uTexture, uv2);
    float mixFactor = abs(progress1 - 0.5) * 2.0;
    vec4 finalColor = mix(col1, col2, mixFactor);

    bool isBelowHorizon = false;
    if (abs(uProjectionType - 1.0) < 0.1) {
        float dist = distance(baseUV, vec2(0.5));
        if (dist > 0.5) {
            isBelowHorizon = true;
            float depth = clamp((dist - 0.5) / 0.5, 0.0, 1.0);
            vec3 ground = mix(vec3(0.10, 0.105, 0.125), vec3(0.035, 0.04, 0.05), depth);
            finalColor.rgb = mix(finalColor.rgb, ground, smoothstep(0.0, 0.02, dist - 0.5));
        }
    }

    if (uShowFlowMap > 0.5 && !isBelowHorizon) {
        vec4 overlayColor = vec4(flowColor.rgb, 1.0);
        finalColor = mix(finalColor, overlayColor, uFlowMapOpacity);
    }

    if (uShowCursor > 0.5) {
      float dist = distance(baseUV, uCursor);

      // Ring width is measured in *screen pixels*, not UV. A fixed UV width
      // looks thin when zoomed out and fat when zoomed in; the 2D view draws a
      // plain 1px border, so derive the UV-per-pixel scale with fwidth() and
      // keep the ring at 1px whatever the camera is doing.
      float uvPerPixel = max(fwidth(dist), 1e-6);
      float halfW = 0.5 * uvPerPixel;
      float d = abs(dist - uBrushSize);
      float ringAlpha = 1.0 - smoothstep(halfW - 0.5 * uvPerPixel, halfW + 0.5 * uvPerPixel, d);

      // Disc fill is antialiased over one pixel too, so the rim is not a
      // staircase at high zoom.
      float innerAlpha = 1.0 - smoothstep(uBrushSize - uvPerPixel, uBrushSize, dist);

      // Brush coverage profile. Must stay in step with core_fraction() /
      // brush_falloff() in engine/ops.rs and with src/brush.ts — the cursor is
      // only useful if it predicts what the stroke will actually do.
      float t = clamp(dist / max(uBrushSize, 1e-6), 0.0, 1.0);
      float core = 0.40 + 0.59 * clamp(uBrushHardness, 0.0, 1.0);
      float k = clamp((1.0 - t) / max(1.0 - core, 1e-4), 0.0, 1.0);
      float profile = k * k * k * (k * (k * 6.0 - 15.0) + 10.0);

      // Mirrors the 2D cursor exactly: a flat rgba(255,255,255,.10) wash across
      // the whole disc (.paint-cursor), plus the profile on top peaking at
      // rgba(255,255,255,.92) scaled by the inner div's strength * 0.8.
      float wash = innerAlpha * 0.10;
      float paint = innerAlpha * profile * (0.92 * uBrushStrength * 0.8);
      float fillAlpha = wash + paint * (1.0 - wash); // source-over, both white

      vec3 cursorColor = vec3(1.0);
      // 0.85 matches the 2D ring's rgba(255,255,255,.85) border.
      finalColor.rgb = mix(finalColor.rgb, cursorColor, ringAlpha * 0.85);
      finalColor.rgb = mix(finalColor.rgb, cursorColor, fillAlpha);
    }

    gl_FragColor = finalColor;
    #include <colorspace_fragment>
  }
`;

export const ARROW_FRAG = /* glsl */ `
  uniform sampler2D uFlowMap;
  uniform vec2 uGridSize;
  uniform vec3 uColor;
  uniform float uProjectionType;
  uniform float uPolarAngle;

  varying vec2 vUv;

  ${SAMPLING_UV}

  void main() {
    vec2 gridUV = vUv * uGridSize;
    vec2 cellIndex = floor(gridUV);
    vec2 cellLocal = fract(gridUV) - 0.5;
    vec2 cellCenterSphereUV = (cellIndex + 0.5) / uGridSize;
    vec2 texUV = getSamplingUV(cellCenterSphereUV);

    if (abs(uProjectionType - 1.0) < 0.1 && distance(texUV, vec2(0.5)) > 0.5) discard;

    vec4 flowVal = texture2D(uFlowMap, texUV);
    vec2 flow = (flowVal.rg - 0.5) * 2.0;
    vec2 visualDir = -flow;

    if (abs(uProjectionType - 1.0) < 0.1) {
        float theta = cellCenterSphereUV.x * 2.0 * 3.14159265;
        float c = cos(theta);
        float s = sin(theta);
        float u_sphere = visualDir.x * c - visualDir.y * s;
        float v_sphere = -(visualDir.x * s + visualDir.y * c);
        visualDir = vec2(u_sphere, v_sphere);
    }

    float mag = length(visualDir);
    if (mag < 0.02) discard;

    float angle = atan(visualDir.y, visualDir.x);
    float c = cos(angle);
    float s = sin(angle);
    vec2 rotatedUV = cellLocal * mat2(c, s, -s, c);

    float thickness = 0.005;
    float len = min(0.4, mag * 0.8 + 0.1);
    float dShaft = max(abs(rotatedUV.y) - thickness, abs(rotatedUV.x) - len);

    float headSz = len / 8.0;
    vec2 tip = vec2(len, 0.0);
    vec2 p = rotatedUV;

    vec2 wingEnd = vec2(len - headSz, headSz);
    vec2 v = wingEnd - tip;
    vec2 w = p - tip;
    float h = clamp(dot(w, v) / dot(v, v), 0.0, 1.0);
    float dWing1 = length(w - v * h) - thickness;

    vec2 wingEnd2 = vec2(len - headSz, -headSz);
    vec2 v2 = wingEnd2 - tip;
    float h2 = clamp(dot(w, v2) / dot(v2, v2), 0.0, 1.0);
    float dWing2 = length(w - v2 * h2) - thickness;

    float dArrow = min(dShaft, min(dWing1, dWing2));
    float alpha = 1.0 - smoothstep(0.0, 0.02, dArrow);
    if (alpha < 0.1) discard;

    float opacity = min(1.0, mag * 3.0);
    gl_FragColor = vec4(uColor, alpha * opacity);
    #include <colorspace_fragment>
  }
`;

export function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uTexture: { value: null },
      uFlowMap: { value: null },
      uSpeed: { value: 0.2 },
      uDistortionStrength: { value: 0.1 },
      uCursor: { value: new THREE.Vector2(0, 0) },
      uBrushSize: { value: 0.02 },
      uBrushStrength: { value: 0.5 },
      uBrushHardness: { value: 0.25 },
      uShowCursor: { value: 0 },
      uProjectionType: { value: 0 },
      uPolarAngle: { value: Math.PI / 2 },
      uShowFlowMap: { value: 0 },
      uFlowMapOpacity: { value: 0.2 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    // DoubleSide + a mirrored (scale.x = -1) sphere is the combination that
    // keeps panoramas un-flipped when viewed from inside.
    side: THREE.DoubleSide,
  });
}

export function createArrowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFlowMap: { value: null },
      uGridSize: { value: new THREE.Vector2(64, 32) },
      uColor: { value: new THREE.Color('#fbbf24') },
      uProjectionType: { value: 0 },
      uPolarAngle: { value: Math.PI / 2 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: ARROW_FRAG,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
}
