// Forward WebGL2 renderer: hemisphere ambient + up to 12 point lights + one spot light,
// cheap specular with a fake environment term for metals, exp² fog, ACES tone mapping.
import { Camera, Geometry, Material, Node, Scene, Texture, type PointLight } from './scene';
import { m4NormalMatrix, m4MaxScale, type M4 } from './math';

const MAX_POINTS = 8;

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUv;
#ifdef MORPH
layout(location=3) in vec3 aMP0;
layout(location=4) in vec3 aMP1;
layout(location=5) in vec3 aMN0;
layout(location=6) in vec3 aMN1;
uniform vec2 uMorph;
#endif
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNormalMat;
out vec3 vWPos;
out vec3 vNrm;
out vec2 vUv;
void main() {
  vec3 p = aPos;
  vec3 n = aNrm;
#ifdef MORPH
  p += aMP0 * uMorph.x + aMP1 * uMorph.y;
  n += aMN0 * uMorph.x + aMN1 * uMorph.y;
#endif
  vec4 w = uModel * vec4(p, 1.0);
  vWPos = w.xyz;
  vNrm = uNormalMat * n;
  vUv = aUv;
  gl_Position = uViewProj * w;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vWPos;
in vec3 vNrm;
in vec2 vUv;
uniform vec4 uColor;
uniform sampler2D uMap;
uniform float uMetal;
uniform float uRough;
uniform vec3 uEmissive;
uniform vec3 uCamPos;
uniform vec3 uSky;
uniform vec3 uGround;
uniform float uEnvSpec;
uniform int uNumPoints;
uniform vec4 uPointPos[${MAX_POINTS}];
uniform vec3 uPointCol[${MAX_POINTS}];
uniform vec4 uSpotPos;
uniform vec4 uSpotDir;
uniform vec3 uSpotCol;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uExposure;
uniform float uOpacity;
out vec4 outColor;

vec3 aces(vec3 x) {
  const float a = 2.51; const float b = 0.03; const float c = 2.43; const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float falloff(float d, float range) {
  float r = d / range;
  float w = clamp(1.0 - r * r * r * r, 0.0, 1.0);
  return w * w / (d * d + 1.0);
}

void main() {
  vec4 base = uColor;
#ifdef MAP
  base *= texture(uMap, vUv);
#endif
#ifdef UNLIT
  vec3 col = base.rgb;
#ifdef FOG
  float fd = length(vWPos - uCamPos);
  col = mix(col, uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * fd * fd));
#endif
#ifdef RAW
  outColor = vec4(toSRGB(clamp(col * uExposure, 0.0, 1.0)), base.a * uOpacity);
#else
  outColor = vec4(toSRGB(aces(col * uExposure)), base.a * uOpacity);
#endif
  return;
#else
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamPos - vWPos);
  vec3 diffC = base.rgb * (1.0 - uMetal);
  vec3 F0 = mix(vec3(0.04), base.rgb, uMetal);
  float rough = clamp(uRough, 0.08, 1.0);
  float shin = clamp(2.0 / (rough * rough * rough * rough) - 2.0, 1.0, 512.0);
  float specNorm = (shin + 8.0) / 25.13;
  vec3 hemi = mix(uGround, uSky, N.y * 0.5 + 0.5);
  vec3 col = diffC * hemi;
  vec3 R = reflect(-V, N);
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0) * (1.0 - rough);
  col += F * mix(uGround, uSky, R.y * 0.5 + 0.5) * uEnvSpec * (1.0 - rough * 0.6);
  for (int i = 0; i < ${MAX_POINTS}; i++) {
    if (i >= uNumPoints) break;
    vec3 Lv = uPointPos[i].xyz - vWPos;
    float d = length(Lv);
    vec3 L = Lv / d;
    float att = falloff(d, uPointPos[i].w);
    float NdL = max(dot(N, L), 0.0);
    if (att * NdL <= 0.0) continue;
    vec3 H = normalize(L + V);
    float sp = pow(max(dot(N, H), 0.0), shin) * specNorm;
    col += uPointCol[i] * att * NdL * (diffC + F * sp);
  }
  if (uSpotCol.r + uSpotCol.g + uSpotCol.b > 0.0) {
    vec3 Lv = uSpotPos.xyz - vWPos;
    float d = length(Lv);
    vec3 L = Lv / d;
    float cd = dot(-L, uSpotDir.xyz);
    float cone = smoothstep(uSpotDir.w, uSpotDir.w + 0.08, cd);
    float att = falloff(d, uSpotPos.w) * cone;
    float NdL = max(dot(N, L), 0.0);
    vec3 H = normalize(L + V);
    float sp = pow(max(dot(N, H), 0.0), shin) * specNorm;
    col += uSpotCol * att * NdL * (diffC + F * sp);
  }
  col += uEmissive;
#ifdef FOG
  float fd = length(vWPos - uCamPos);
  col = mix(col, uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * fd * fd));
#endif
  outColor = vec4(toSRGB(aces(col * uExposure)), base.a * uOpacity);
#endif
}`;

interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface DrawItem { node: Node; geometry: Geometry; material: Material; depth: number; weights: number[] | null; program: string }

export class Renderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  programs = new Map<string, Program>();
  pixelRatio = 1;
  maxPixelRatio = 1.5;
  /** upper bound on drawn pixels (megapixels); high-DPI 5K/4K screens would otherwise render ~8 MP */
  pixelBudget = 2.0;
  /** 0.5–1, lowered automatically when frames are slow */
  dynamicScale = 1;
  private pp = new Float32Array(MAX_POINTS * 4);
  private pc = new Float32Array(MAX_POINTS * 3);
  private sky3 = new Float32Array(3);
  private ground3 = new Float32Array(3);
  private opaque: DrawItem[] = [];
  private transparent: DrawItem[] = [];
  private pts: PointLight[] = [];
  width = 1;
  height = 1;
  drawCalls = 0;
  triangles = 0;
  private aniso: EXT_texture_filter_anisotropic | null;
  private nmat = new Float32Array(9);
  private planes = new Float32Array(24);
  private lost = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.programs.clear(); });
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  resize(cssW: number, cssH: number) {
    let pr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const mp = (cssW * cssH * pr * pr) / 1e6;
    if (mp > this.pixelBudget) pr *= Math.sqrt(this.pixelBudget / mp);
    pr = Math.max(0.45, pr * this.dynamicScale);
    const w = Math.max(1, Math.round(cssW * pr)), h = Math.max(1, Math.round(cssH * pr));
    if (w !== this.canvas.width || h !== this.canvas.height) { this.canvas.width = w; this.canvas.height = h; }
    this.pixelRatio = pr; this.width = w; this.height = h;
  }

  private program(key: string): Program {
    let p = this.programs.get(key);
    if (p) return p;
    const gl = this.gl;
    const defs = key.split('|').filter(Boolean).map((d) => `#define ${d}\n`).join('');
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src.replace('#version 300 es\n', '#version 300 es\n' + defs));
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    const names = ['uModel', 'uViewProj', 'uNormalMat', 'uMorph', 'uColor', 'uMap', 'uMetal', 'uRough', 'uEmissive', 'uCamPos',
      'uSky', 'uGround', 'uEnvSpec', 'uNumPoints', 'uPointPos', 'uPointCol', 'uSpotPos', 'uSpotDir', 'uSpotCol', 'uFogColor',
      'uFogDensity', 'uExposure', 'uOpacity'];
    const u: Record<string, WebGLUniformLocation | null> = {};
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);
    p = { prog, u };
    this.programs.set(key, p);
    return p;
  }

  /** Compile all shader variants up front to avoid hitches mid-game. */
  warmup() {
    for (const k of ['FOG|', 'FOG|MAP|', 'FOG|MORPH|', 'FOG|MAP|MORPH|', 'UNLIT|FOG|', 'UNLIT|FOG|MAP|', 'UNLIT|MAP|', 'UNLIT|MAP|RAW', 'UNLIT|RAW', 'UNLIT|FOG|MAP|RAW', 'UNLIT|FOG|RAW', 'UNLIT|']) this.program(k);
  }

  private upload(g: Geometry) {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const attr = (loc: number, data: Float32Array, size: number) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      g.buffers.push(b);
    };
    attr(0, g.positions, 3);
    attr(1, g.normals, 3);
    if (g.uvs) attr(2, g.uvs, 2); else { gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0, 0); }
    if (g.targets.length) {
      const zero = new Float32Array(g.positions.length);
      attr(3, g.targets[0].pos, 3);
      attr(4, g.targets[1]?.pos || zero, 3);
      attr(5, g.targets[0].nrm || zero, 3);
      attr(6, g.targets[1]?.nrm || zero, 3);
    }
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    g.buffers.push(ib);
    gl.bindVertexArray(null);
    g.vao = vao;
  }

  disposeGeometry(g: Geometry) {
    const gl = this.gl;
    if (g.vao) gl.deleteVertexArray(g.vao);
    for (const b of g.buffers) gl.deleteBuffer(b);
    g.vao = null; g.buffers = [];
  }

  private bindTexture(t: Texture) {
    const gl = this.gl;
    if (!t.gl) t.gl = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t.gl);
    if (t.glVersion !== t.version && t.source) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, t.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, t.source);
      const wrap = t.clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (t.mipmaps) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      t.glVersion = t.version;
    }
  }

  private extractPlanes(m: M4) {
    const p = this.planes;
    const rows = [
      [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
      [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
      [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
      [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
      [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
      [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
    ];
    rows.forEach((r, i) => {
      const l = Math.hypot(r[0], r[1], r[2]) || 1;
      p[i * 4] = r[0] / l; p[i * 4 + 1] = r[1] / l; p[i * 4 + 2] = r[2] / l; p[i * 4 + 3] = r[3] / l;
    });
  }

  private visible(g: Geometry, world: M4): boolean {
    const c = g.center;
    const x = world[0] * c[0] + world[4] * c[1] + world[8] * c[2] + world[12];
    const y = world[1] * c[0] + world[5] * c[1] + world[9] * c[2] + world[13];
    const z = world[2] * c[0] + world[6] * c[1] + world[10] * c[2] + world[14];
    const r = g.radius * m4MaxScale(world);
    const p = this.planes;
    for (let i = 0; i < 6; i++) if (p[i * 4] * x + p[i * 4 + 1] * y + p[i * 4 + 2] * z + p[i * 4 + 3] < -r) return false;
    return true;
  }

  render(scene: Scene, camera: Camera) {
    if (this.lost) return;
    const gl = this.gl;
    camera.aspect = this.width / this.height;
    camera.update();
    scene.root.updateWorld(null);
    this.extractPlanes(camera.viewProj);

    const opaque = this.opaque, transparent = this.transparent;
    opaque.length = 0; transparent.length = 0;
    const cp = camera.position;
    const collect = (n: Node) => {
      if (!n.visible) return;
      if (n.mesh) {
        for (const prim of n.mesh.primitives) {
          const g = prim.geometry;
          const mat = n.materialOverride || prim.material;
          if (!this.visible(g, n.world)) continue;
          const w = n.world;
          const dx = w[12] - cp[0], dy = w[13] - cp[1], dz = w[14] - cp[2];
          const morph = g.targets.length > 0;
          const key = (mat.unlit ? 'UNLIT|' : '') + (mat.fog ? 'FOG|' : '') + (mat.map ? 'MAP|' : '') + (morph && !mat.unlit ? 'MORPH|' : '') + (mat.unlit && !mat.toneMapped ? 'RAW' : '');
          const item: DrawItem = { node: n, geometry: g, material: mat, depth: dx * dx + dy * dy + dz * dz, weights: morph ? n.morphWeights : null, program: key };
          (mat.transparent || mat.additive ? transparent : opaque).push(item);
        }
      }
      for (const c of n.children) collect(c);
    };
    collect(scene.root);
    opaque.sort((a, b) => (a.material.renderOrder - b.material.renderOrder) || (a.program < b.program ? -1 : a.program > b.program ? 1 : a.depth - b.depth));
    transparent.sort((a, b) => (a.material.renderOrder - b.material.renderOrder) || (b.depth - a.depth));

    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(scene.clearColor[0], scene.clearColor[1], scene.clearColor[2], 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // light uniforms
    const pts = this.pts; pts.length = 0;
    for (const p of scene.points) if (p.enabled && p.intensity > 0.01) pts.push(p);
    // keep the lights that matter most for this view when over budget
    if (pts.length > MAX_POINTS) pts.sort((a, b) => dist2(a.position, cp) / (a.intensity * a.range) - dist2(b.position, cp) / (b.intensity * b.range));
    const np = Math.min(pts.length, MAX_POINTS);
    const pp = this.pp, pc = this.pc;
    for (let i = 0; i < np; i++) {
      const L = pts[i];
      pp[i * 4] = L.position[0]; pp[i * 4 + 1] = L.position[1]; pp[i * 4 + 2] = L.position[2]; pp[i * 4 + 3] = L.range;
      pc[i * 3] = L.color[0] * L.intensity; pc[i * 3 + 1] = L.color[1] * L.intensity; pc[i * 3 + 2] = L.color[2] * L.intensity;
    }
    for (let k = 0; k < 3; k++) { this.sky3[k] = scene.sky[k] * scene.ambient; this.ground3[k] = scene.ground[k] * scene.ambient; }
    const s = scene.spot;
    const spotOn = s.enabled && s.intensity > 0;

    this.drawCalls = 0; this.triangles = 0;
    let current: Program | null = null;
    let lastMat: Material | null = null;
    const setFrame = (p: Program) => {
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.u.uViewProj, false, camera.viewProj);
      gl.uniform3fv(p.u.uCamPos, camera.position);
      gl.uniform3fv(p.u.uSky, this.sky3);
      gl.uniform3fv(p.u.uGround, this.ground3);
      gl.uniform1f(p.u.uEnvSpec, scene.envSpec);
      gl.uniform1i(p.u.uNumPoints, np);
      gl.uniform4fv(p.u.uPointPos, pp);
      gl.uniform3fv(p.u.uPointCol, pc);
      gl.uniform4f(p.u.uSpotPos, s.position[0], s.position[1], s.position[2], s.range);
      gl.uniform4f(p.u.uSpotDir, s.direction[0], s.direction[1], s.direction[2], Math.cos(s.angle));
      gl.uniform3f(p.u.uSpotCol, spotOn ? s.color[0] * s.intensity : 0, spotOn ? s.color[1] * s.intensity : 0, spotOn ? s.color[2] * s.intensity : 0);
      gl.uniform3fv(p.u.uFogColor, scene.fogColor);
      gl.uniform1f(p.u.uFogDensity, scene.fogDensity);
      gl.uniform1f(p.u.uExposure, scene.exposure);
      gl.uniform1i(p.u.uMap, 0);
    };
    const draw = (it: DrawItem) => {
      const p = this.program(it.program);
      if (p !== current) {
        current = p; lastMat = null;
        setFrame(p);
      }
      const m = it.material;
      if (m !== lastMat) {
        gl.uniform4fv(p.u.uColor, m.color);
        gl.uniform1f(p.u.uMetal, m.metallic);
        gl.uniform1f(p.u.uRough, m.roughness);
        gl.uniform3f(p.u.uEmissive, m.emissive[0] * m.emissiveIntensity, m.emissive[1] * m.emissiveIntensity, m.emissive[2] * m.emissiveIntensity);
        gl.uniform1f(p.u.uOpacity, 1);
        if (m.map) { gl.activeTexture(gl.TEXTURE0); this.bindTexture(m.map); }
        if (m.doubleSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
        if (m.additive) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); }
        else if (m.transparent) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
        else gl.disable(gl.BLEND);
        gl.depthMask(m.depthWrite && !m.additive);
        if (m.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
        lastMat = m;
      }
      gl.uniformMatrix4fv(p.u.uModel, false, it.node.world);
      gl.uniformMatrix3fv(p.u.uNormalMat, false, m4NormalMatrix(this.nmat, it.node.world));
      if (it.geometry.targets.length) {
        const w = it.weights || [0, 0];
        gl.uniform2f(p.u.uMorph, w[0] || 0, w[1] || 0);
      }
      if (!it.geometry.vao) this.upload(it.geometry);
      gl.bindVertexArray(it.geometry.vao);
      gl.drawElements(gl.TRIANGLES, it.geometry.indices.length, gl.UNSIGNED_INT, 0);
      this.drawCalls++; this.triangles += it.geometry.indices.length / 3;
    };
    for (const it of opaque) draw(it);
    for (const it of transparent) draw(it);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Upload geometry/textures for a subtree ahead of first draw (avoids stalls on reveal). */
  prepare(root: Node) {
    root.traverse((n) => {
      if (!n.mesh) return;
      for (const p of n.mesh.primitives) {
        if (!p.geometry.vao) this.upload(p.geometry);
        if (p.material.map) { this.gl.activeTexture(this.gl.TEXTURE0); this.bindTexture(p.material.map); }
      }
    });
  }
}

function dist2(a: number[], b: number[]) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}
