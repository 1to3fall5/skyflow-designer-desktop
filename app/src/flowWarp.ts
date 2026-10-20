/**
 * The 3D preview's flow animation, on a flat quad.
 *
 * The 2D view drew 天空贴图 as a plain `<img>`, so 播放动画 moved nothing on
 * the left half of a split while the right half was visibly flowing. Canvas 2D
 * cannot do this: the offset is different at every pixel, so there is no
 * transform, clip or composite that expresses it. It is the one job in the 2D
 * view that wants the GPU.
 *
 * The maths is `SKY_FRAG`'s, minus the sphere: sample the texture at
 * `uv + flow * progress * distortion` twice, half a cycle apart, and cross-fade
 * so the seam when `fract` wraps is invisible. Same 速度 and 强度 as the 3D
 * side, so the two halves of the split agree.
 *
 * Returns null where there is no WebGL — headless tests, or a machine whose
 * driver is blacklisted. The caller keeps the static image in that case, so
 * losing the context costs the animation and nothing else.
 */

const VERT = /* glsl */ `
  attribute vec2 aPos;
  varying vec2 vUv;
  void main() {
    // v runs *down* the screen: both textures are uploaded unflipped, so v = 0
    // is the top row of the canvas and of the image.
    vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D uSky;
  uniform sampler2D uFlow;
  uniform float uPhase;
  uniform float uDistortion;

  void main() {
    vec4 fc = texture2D(uFlow, vUv);
    vec2 flow = (fc.rg - 0.5) * 2.0;
    // The 3D shader's v grows upward and ours grows downward, so the vertical
    // component is negated. Without that the texture drifts *against* the
    // arrows here — the arrows' on-screen direction is the reference, and it
    // is the one thing the two views already agree on.
    vec2 dir = vec2(flow.x, -flow.y) * fc.b;

    float p1 = fract(uPhase);
    float p2 = fract(uPhase + 0.5);
    vec4 c1 = texture2D(uSky, vUv + dir * p1 * uDistortion);
    vec4 c2 = texture2D(uSky, vUv + dir * p2 * uDistortion);
    vec4 c = mix(c1, c2, abs(p1 - 0.5) * 2.0);

    // The canvas is composited as premultiplied alpha, so hand it back
    // premultiplied rather than straight colour.
    gl_FragColor = vec4(c.rgb * c.a, c.a);
  }
`;

export interface FlowWarp {
  /** Upload the sky texture. `w` / `h` are its natural size. */
  setSky(src: TexImageSource, w: number, h: number): void;
  /** Re-read the composite flowmap. Only worth calling when the pixels moved. */
  setFlow(src: TexImageSource): void;
  /** Draw one frame. `phase` is in cycles, exactly like `uTime * uSpeed`. */
  draw(phase: number, distortion: number): void;
  dispose(): void;
}

function getGL(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  try {
    return (canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    }) ?? null) as WebGLRenderingContext | null;
  } catch {
    // jsdom does not implement getContext at all and says so by throwing.
    return null;
  }
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function createFlowWarp(canvas: HTMLCanvasElement): FlowWarp | null {
  const gl = getGL(canvas);
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uSky = gl.getUniformLocation(prog, 'uSky');
  const uFlow = gl.getUniformLocation(prog, 'uFlow');
  const uPhase = gl.getUniformLocation(prog, 'uPhase');
  const uDistortion = gl.getUniformLocation(prog, 'uDistortion');

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

  const newTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // CLAMP_TO_EDGE, not REPEAT: a non-power-of-two texture with REPEAT is
    // incomplete in WebGL 1 and samples black, and sky images are very rarely
    // power-of-two. Only the outermost pixels can fall outside anyway.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  };
  const skyTex = newTex();
  const flowTex = newTex();

  /** Shrink past the driver's limit — an 8K sky would otherwise upload black. */
  const fit = (src: TexImageSource, w: number, h: number): TexImageSource => {
    if (w <= maxTex && h <= maxTex) return src;
    const k = maxTex / Math.max(w, h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(w * k));
    c.height = Math.max(1, Math.floor(h * k));
    const cx = c.getContext('2d');
    if (!cx) return src;
    // ImageData is a TexImageSource but not a CanvasImageSource; neither the
    // sky image nor an oversized one ever is, so this is only about types.
    cx.drawImage(src as CanvasImageSource, 0, 0, c.width, c.height);
    return c;
  };

  return {
    setSky(src, w, h) {
      gl.bindTexture(gl.TEXTURE_2D, skyTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fit(src, w, h));
    },
    setFlow(src) {
      gl.bindTexture(gl.TEXTURE_2D, flowTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    },
    draw(phase, distortion) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, skyTex);
      gl.uniform1i(uSky, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, flowTex);
      gl.uniform1i(uFlow, 1);
      gl.uniform1f(uPhase, phase);
      gl.uniform1f(uDistortion, distortion);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl.deleteTexture(skyTex);
      gl.deleteTexture(flowTex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
