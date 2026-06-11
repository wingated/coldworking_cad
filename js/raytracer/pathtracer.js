// GPU spectral path tracer (WebGL2 fragment shader, progressive).
//
// Physics:
//  - Hero-wavelength spectral sampling: each camera path carries one
//    wavelength; CIE color matching turns accumulated spectral radiance
//    into XYZ -> linear sRGB. This is what makes dispersion ("fire") and
//    dichroic color splitting come out correctly.
//  - Per-material Cauchy dispersion n(lambda) = A + B/lambda_um^2 derived
//    from catalog nd / Abbe numbers.
//  - Triangles carry the materials on BOTH sides, so glued glass-glass
//    interfaces refract with the correct relative IOR and seamless joints
//    simply don't exist as geometry.
//  - Dichroic coatings: spectral reflectance R(lambda) from a 32-bin table;
//    transmission = 1 - R; combined with base Fresnel of the substrate.

import { buildBVH } from './bvh.js';
import { cieXYZ, xyzToLinearRGB, LAMBDA_MIN, LAMBDA_MAX } from '../spectra.js';

const TEX_W = 2048;
const MAX_MATS = 16;
const MAX_COATS = 16;

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const TRACE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uPrev;
uniform sampler2D uTris;     // 4 texels per tri: v0/matF, v1/matB, v2/coat, n
uniform sampler2D uBVH;      // 2 texels per node
uniform sampler2D uCoat;     // 32 x MAX_COATS reflectance bins
uniform int uFrame;
uniform vec2 uRes;
uniform vec3 uEye, uRight, uUp, uFwd;
uniform float uTanFov, uAspect;
uniform int uBounces;
uniform float uEnvIntensity;
uniform int uFloorOn;
uniform float uFloorY;
uniform int uDispersion;
uniform vec2 uCauchy[${MAX_MATS}];
uniform vec3 uTint[${MAX_MATS}];
uniform vec3 uWhiteBalance;
uniform int uNodeCount;
out vec4 frag;

const float TMIN = 1.5e-4;
const float INF = 1e30;

uint seed;
void srand(uvec2 p, uint f) {
  seed = p.x * 1973u + p.y * 9277u + f * 26699u + 1u;
}
uint pcg() {
  seed = seed * 747796405u + 2891336453u;
  uint w = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
  return (w >> 22u) ^ w;
}
float rnd() { return float(pcg()) / 4294967296.0; }

vec4 fetchTri(int i) { return texelFetch(uTris, ivec2(i % ${TEX_W}, i / ${TEX_W}), 0); }
vec4 fetchNode(int i) { return texelFetch(uBVH, ivec2(i % ${TEX_W}, i / ${TEX_W}), 0); }

// Cauchy IOR; lambda in nm.
float iorOf(int mat, float lambda) {
  vec2 c = uCauchy[mat];
  if (uDispersion == 0) lambda = 587.56;
  float um = lambda / 1000.0;
  return c.x + c.y / (um * um);
}

// Spectral absorption per inch from an RGB absorption triple.
float sigmaOf(int mat, float lambda) {
  vec3 t = uTint[mat];
  float wb = exp(-0.5 * pow((lambda - 465.0) / 45.0, 2.0));
  float wg = exp(-0.5 * pow((lambda - 550.0) / 45.0, 2.0));
  float wr = exp(-0.5 * pow((lambda - 615.0) / 55.0, 2.0));
  float s = wb + wg + wr + 1e-5;
  return (t.b * wb + t.g * wg + t.r * wr) / s;
}

float coatR(int coat, float lambda) {
  float u = (lambda - ${LAMBDA_MIN}.0) / (${LAMBDA_MAX}.0 - ${LAMBDA_MIN}.0) * 32.0 - 0.5;
  float fu = clamp(u, 0.0, 31.0);
  int i0 = int(floor(fu));
  int i1 = min(i0 + 1, 31);
  float f = fu - float(i0);
  float r0 = texelFetch(uCoat, ivec2(i0, coat), 0).r;
  float r1 = texelFetch(uCoat, ivec2(i1, coat), 0).r;
  return mix(r0, r1, f);
}

// CIE 1931 CMF fit (Wyman et al. 2013).
float gpw(float x, float mu, float s1, float s2) {
  float t = (x - mu) / (x < mu ? s1 : s2);
  return exp(-0.5 * t * t);
}
vec3 cie(float l) {
  float x = 1.056 * gpw(l, 599.8, 37.9, 31.0)
          + 0.362 * gpw(l, 442.0, 16.0, 26.7)
          - 0.065 * gpw(l, 501.1, 20.4, 26.2);
  float y = 0.821 * gpw(l, 568.8, 46.9, 40.5)
          + 0.286 * gpw(l, 530.9, 16.3, 31.1);
  float z = 1.217 * gpw(l, 437.0, 11.8, 36.0)
          + 0.681 * gpw(l, 459.0, 26.0, 13.8);
  return vec3(x, y, z);
}

float blob(vec3 d, vec3 c, float sharp, float inten) {
  return inten * pow(max(dot(d, normalize(c)), 0.0), sharp);
}

// Studio environment: soft gradient plus a few "softbox" lights. Returns
// spectral radiance (flat spectrum = neutral white).
float envLight(vec3 d) {
  float v = 0.05 + 0.13 * smoothstep(-0.6, 0.9, d.y);
  v += blob(d, vec3(0.5, 0.85, 0.25), 90.0, 22.0);   // key light
  v += blob(d, vec3(-0.75, 0.45, -0.35), 45.0, 7.0); // fill
  v += blob(d, vec3(0.1, 0.25, -1.0), 220.0, 12.0);  // rim
  v += blob(d, vec3(0.0, -1.0, 0.0), 8.0, 0.6);      // bounce card below
  return v * uEnvIntensity;
}

struct Hit { float t; int tri; };

bool aabbHit(vec3 bmin, vec3 bmax, vec3 ro, vec3 inv, float tBest) {
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 lo = min(t0, t1), hi = max(t0, t1);
  float tEnter = max(max(lo.x, lo.y), lo.z);
  float tExit = min(min(hi.x, hi.y), hi.z);
  return tExit >= max(tEnter, 0.0) && tEnter < tBest;
}

float triHit(int tri, vec3 ro, vec3 rd) {
  vec3 v0 = fetchTri(tri * 4).xyz;
  vec3 v1 = fetchTri(tri * 4 + 1).xyz;
  vec3 v2 = fetchTri(tri * 4 + 2).xyz;
  vec3 e1 = v1 - v0, e2 = v2 - v0;
  vec3 p = cross(rd, e2);
  float det = dot(e1, p);
  if (abs(det) < 1e-12) return INF;
  float invDet = 1.0 / det;
  vec3 tv = ro - v0;
  float u = dot(tv, p) * invDet;
  if (u < -1e-6 || u > 1.0 + 1e-6) return INF;
  vec3 q = cross(tv, e1);
  float v = dot(rd, q) * invDet;
  if (v < -1e-6 || u + v > 1.0 + 1e-6) return INF;
  float t = dot(e2, q) * invDet;
  return t > TMIN ? t : INF;
}

Hit traverse(vec3 ro, vec3 rd) {
  Hit best; best.t = INF; best.tri = -1;
  if (uNodeCount == 0) return best;
  vec3 inv = 1.0 / rd;
  int stack[28];
  int sp = 0;
  stack[sp++] = 0;
  for (int guard = 0; guard < 4096 && sp > 0; guard++) {
    int ni = stack[--sp];
    vec4 n0 = fetchNode(ni * 2);
    vec4 n1 = fetchNode(ni * 2 + 1);
    if (!aabbHit(n0.xyz, n1.xyz, ro, inv, best.t)) continue;
    if (n0.w < 0.0) {
      int start = int(-n0.w) - 1;
      int count = int(n1.w);
      for (int k = 0; k < count; k++) {
        float t = triHit(start + k, ro, rd);
        if (t < best.t) { best.t = t; best.tri = start + k; }
      }
    } else {
      if (sp < 26) { stack[sp++] = int(n0.w); stack[sp++] = int(n1.w); }
    }
  }
  return best;
}

vec3 cosineHemisphere(vec3 n) {
  float r1 = rnd(), r2 = rnd();
  float phi = 6.2831853 * r1;
  float sr = sqrt(r2);
  vec3 t = normalize(cross(abs(n.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0), n));
  vec3 b = cross(n, t);
  return normalize(t * (cos(phi) * sr) + b * (sin(phi) * sr) + n * sqrt(1.0 - r2));
}

void main() {
  uvec2 pix = uvec2(gl_FragCoord.xy);
  srand(pix, uint(uFrame));

  // Hero wavelength for this path.
  float lambda = ${LAMBDA_MIN}.0 + rnd() * (${LAMBDA_MAX}.0 - ${LAMBDA_MIN}.0);

  // Camera ray with AA jitter.
  vec2 jitter = vec2(rnd(), rnd()) - 0.5;
  vec2 ndc = ((gl_FragCoord.xy + jitter) / uRes) * 2.0 - 1.0;
  vec3 rd = normalize(uFwd + uRight * (ndc.x * uTanFov * uAspect) + uUp * (ndc.y * uTanFov));
  vec3 ro = uEye;

  float L = 0.0;          // spectral radiance along this path
  float throughput = 1.0;
  int medium = 0;         // air

  for (int bounce = 0; bounce <= uBounces; bounce++) {
    Hit h = traverse(ro, rd);

    // Optional matte floor as an analytic plane.
    float tFloor = INF;
    if (uFloorOn == 1 && rd.y < -1e-6) {
      float t = (uFloorY - ro.y) / rd.y;
      if (t > TMIN) tFloor = t;
    }

    if (tFloor < h.t) {
      throughput *= exp(-sigmaOf(medium, lambda) * tFloor);
      ro = ro + rd * tFloor;
      throughput *= 0.55; // floor albedo
      rd = cosineHemisphere(vec3(0.0, 1.0, 0.0));
      ro += rd * 1e-4;
      continue;
    }

    if (h.tri < 0) {
      L += throughput * envLight(rd);
      break;
    }

    // Absorption through the medium we just crossed.
    throughput *= exp(-sigmaOf(medium, lambda) * h.t);

    vec4 d0 = fetchTri(h.tri * 4);
    vec4 d1 = fetchTri(h.tri * 4 + 1);
    vec4 d2 = fetchTri(h.tri * 4 + 2);
    vec4 d3 = fetchTri(h.tri * 4 + 3);
    int matF = int(d0.w + 0.5);
    int matB = int(d1.w + 0.5);
    int coat = d2.w < -0.5 ? -1 : int(d2.w + 0.5); // -1 = uncoated
    vec3 n = d3.xyz;

    vec3 hitP = ro + rd * h.t;

    int fromMat, toMat;
    vec3 sn;
    if (dot(rd, n) < 0.0) { fromMat = matF; toMat = matB; sn = n; }
    else { fromMat = matB; toMat = matF; sn = -n; }

    float n1 = iorOf(fromMat, lambda);
    float n2 = iorOf(toMat, lambda);
    float eta = n1 / n2;
    float ci = clamp(dot(-rd, sn), 0.0, 1.0);
    float st2 = eta * eta * (1.0 - ci * ci);

    float R;
    float ct = 0.0;
    if (st2 >= 1.0) {
      R = 1.0; // total internal reflection
    } else {
      ct = sqrt(1.0 - st2);
      float rs = (n1 * ci - n2 * ct) / (n1 * ci + n2 * ct);
      float rp = (n1 * ct - n2 * ci) / (n1 * ct + n2 * ci);
      R = 0.5 * (rs * rs + rp * rp);
    }
    if (coat >= 0) {
      float Rc = coatR(coat, lambda);
      R = Rc + (1.0 - Rc) * R;
    }

    if (rnd() < R) {
      rd = normalize(reflect(rd, sn));
      medium = fromMat;
    } else {
      rd = normalize(eta * rd + (eta * ci - ct) * sn);
      medium = toMat;
    }
    ro = hitP + rd * 1e-4;
  }

  vec3 xyz = cie(lambda) * L * 3.10; // (lambdaRange / integral of ybar)
  vec3 rgb = vec3(
    3.2406 * xyz.x - 1.5372 * xyz.y - 0.4986 * xyz.z,
    -0.9689 * xyz.x + 1.8758 * xyz.y + 0.0415 * xyz.z,
    0.0557 * xyz.x - 0.2040 * xyz.y + 1.0570 * xyz.z
  ) * uWhiteBalance;

  vec4 prev = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0);
  frag = prev + vec4(rgb, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
uniform sampler2D uAccum;
uniform float uExposure;
out vec4 frag;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec4 a = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0);
  vec3 c = a.a > 0.0 ? a.rgb / a.a : vec3(0.0);
  c = max(c, 0.0) * uExposure;
  c = aces(c);
  c = pow(c, vec3(1.0 / 2.2));
  frag = vec4(c, 1.0);
}`;

function compile(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vsSrc], [gl.FRAGMENT_SHADER, fsSrc]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('PathTracer shader: ' + gl.getShaderInfoLog(sh));
    }
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('PathTracer link: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

// Equal-energy white point correction so a flat spectrum renders neutral.
function whiteBalance() {
  let X = 0, Y = 0, Z = 0;
  const steps = 256;
  for (let i = 0; i < steps; i++) {
    const l = LAMBDA_MIN + ((i + 0.5) / steps) * (LAMBDA_MAX - LAMBDA_MIN);
    const c = cieXYZ(l);
    X += c[0]; Y += c[1]; Z += c[2];
  }
  const rgb = xyzToLinearRGB([X / Y, 1, Z / Y]);
  return rgb.map((c) => 1 / Math.max(c, 1e-3));
}

export class PathTracer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 not available');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('EXT_color_buffer_float not available — GPU path tracing needs float render targets');
    }
    this.gl = gl;
    this.traceProg = compile(gl, QUAD_VS, TRACE_FS);
    this.displayProg = compile(gl, QUAD_VS, DISPLAY_FS);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.accum = [null, null];
    this.fbo = gl.createFramebuffer();
    this.frame = 0;
    this.sampleCount = 0;
    this.running = false;

    this.triTex = gl.createTexture();
    this.bvhTex = gl.createTexture();
    this.coatTex = gl.createTexture();
    this.nodeCount = 0;
    this.scene = null;

    this.camera = { eye: [6, 4, 8], target: [0, 0, 0], fov: 40 * Math.PI / 180 };
    this.options = {
      bounces: 24, envIntensity: 1.0, floor: false, floorY: 0,
      dispersion: true, exposure: 1.0, maxSamples: 0, scale: 1.0,
    };
    this._wb = whiteBalance();
    this.onProgress = null;
  }

  setScene(scene) {
    this.scene = scene;
    const gl = this.gl;
    const pos = scene.triangles.positions;
    const triCount = pos.length / 9;

    const { nodes, nodeCount, order } = buildBVH(pos, triCount);
    this.nodeCount = nodeCount;

    // Triangle texture: 4 RGBA32F texels per triangle, BVH order.
    const texels = Math.max(1, triCount * 4);
    const h = Math.ceil(texels / TEX_W);
    const data = new Float32Array(TEX_W * h * 4);
    for (let i = 0; i < triCount; i++) {
      const t = order[i];
      const o = i * 16;
      for (let v = 0; v < 3; v++) {
        data[o + v * 4] = pos[t * 9 + v * 3];
        data[o + v * 4 + 1] = pos[t * 9 + v * 3 + 1];
        data[o + v * 4 + 2] = pos[t * 9 + v * 3 + 2];
      }
      data[o + 3] = scene.triangles.matFront[t];
      data[o + 7] = scene.triangles.matBack[t];
      data[o + 11] = scene.triangles.coating[t];
      data[o + 12] = scene.triangles.normals[t * 3];
      data[o + 13] = scene.triangles.normals[t * 3 + 1];
      data[o + 14] = scene.triangles.normals[t * 3 + 2];
      data[o + 15] = 0;
    }
    uploadTex(gl, this.triTex, TEX_W, h, data);

    // BVH texture: 2 texels per node.
    const bvhTexels = Math.max(1, nodeCount * 2);
    const bh = Math.ceil(bvhTexels / TEX_W);
    const bdata = new Float32Array(TEX_W * bh * 4);
    bdata.set(nodes);
    uploadTex(gl, this.bvhTex, TEX_W, bh, bdata);

    // Coatings: 32 x MAX_COATS, R stores reflectance.
    const cdata = new Float32Array(32 * MAX_COATS * 4);
    scene.coatings.slice(0, MAX_COATS).forEach((c, ci) => {
      for (let b = 0; b < 32; b++) cdata[(ci * 32 + b) * 4] = c.bins[b];
    });
    uploadTex(gl, this.coatTex, 32, MAX_COATS, cdata);

    this.reset();
  }

  setCamera(cam) {
    Object.assign(this.camera, cam);
    this.reset();
  }

  setOptions(opts) {
    Object.assign(this.options, opts);
    this.reset();
  }

  reset() {
    this.frame = 0;
    this.sampleCount = 0;
    this._needClear = true;
  }

  _ensureTargets(w, h) {
    const gl = this.gl;
    if (this._tw === w && this._th === h && this.accum[0]) return;
    this._tw = w; this._th = h;
    for (let i = 0; i < 2; i++) {
      if (this.accum[i]) gl.deleteTexture(this.accum[i]);
      this.accum[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.accum[i]);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    this._needClear = true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.renderFrame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; }

  renderFrame() {
    const gl = this.gl, canvas = this.canvas;
    if (!this.scene) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.options.scale;
    const w = Math.max(8, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(8, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      this.reset();
    }
    this._ensureTargets(w, h);

    if (this.options.maxSamples > 0 && this.sampleCount >= this.options.maxSamples) {
      return; // converged enough; keep displaying
    }

    if (this._needClear) {
      for (let i = 0; i < 2; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accum[i], 0);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      this._needClear = false;
    }

    const src = this.frame % 2, dst = 1 - src;

    // Trace pass: accumulate into dst.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accum[dst], 0);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.traceProg);
    const u = (name) => gl.getUniformLocation(this.traceProg, name);

    bind(gl, 0, this.accum[src], u('uPrev'));
    bind(gl, 1, this.triTex, u('uTris'));
    bind(gl, 2, this.bvhTex, u('uBVH'));
    bind(gl, 3, this.coatTex, u('uCoat'));

    gl.uniform1i(u('uFrame'), this.frame);
    gl.uniform2f(u('uRes'), w, h);

    const { eye, target, fov } = this.camera;
    const fwd = norm3(sub3(target, eye));
    const right = norm3(cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    gl.uniform3fv(u('uEye'), eye);
    gl.uniform3fv(u('uRight'), right);
    gl.uniform3fv(u('uUp'), up);
    gl.uniform3fv(u('uFwd'), fwd);
    gl.uniform1f(u('uTanFov'), Math.tan(fov / 2));
    gl.uniform1f(u('uAspect'), w / h);
    gl.uniform1i(u('uBounces'), this.options.bounces);
    gl.uniform1f(u('uEnvIntensity'), this.options.envIntensity);
    gl.uniform1i(u('uFloorOn'), this.options.floor ? 1 : 0);
    gl.uniform1f(u('uFloorY'), this.options.floorY);
    gl.uniform1i(u('uDispersion'), this.options.dispersion ? 1 : 0);
    gl.uniform3fv(u('uWhiteBalance'), this._wb);
    gl.uniform1i(u('uNodeCount'), this.nodeCount);

    const cauchy = new Float32Array(MAX_MATS * 2);
    const tint = new Float32Array(MAX_MATS * 3);
    this.scene.materials.slice(0, MAX_MATS).forEach((m, i) => {
      cauchy[i * 2] = m.cauchyA;
      cauchy[i * 2 + 1] = m.cauchyB;
      tint[i * 3] = m.tint[0]; tint[i * 3 + 1] = m.tint[1]; tint[i * 3 + 2] = m.tint[2];
    });
    gl.uniform2fv(u('uCauchy'), cauchy);
    gl.uniform3fv(u('uTint'), tint);

    drawQuad(gl, this.quad);

    // Display pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.displayProg);
    bind(gl, 0, this.accum[dst], gl.getUniformLocation(this.displayProg, 'uAccum'));
    gl.uniform1f(gl.getUniformLocation(this.displayProg, 'uExposure'), this.options.exposure);
    drawQuad(gl, this.quad);

    this.frame++;
    this.sampleCount++;
    if (this.onProgress) this.onProgress(this.sampleCount);
  }
}

function uploadTex(gl, tex, w, h, data) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function bind(gl, unit, tex, loc) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(loc, unit);
}

function drawQuad(gl, buf) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
