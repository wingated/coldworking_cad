// CPU reference renderer: runs the exact same spectral path tracing
// algorithm as the GPU shader, in Node, and writes a PNG. Used to validate
// the whole pipeline headlessly and as a ground-truth reference.
//
// Usage: node tools/render_cpu.mjs [width] [height] [spp] [out.png]

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { Model } from '../js/model.js';
import { buildDemoSculpture } from '../js/demo.js';
import { buildRenderScene } from '../js/export.js';
import { buildBVH } from '../js/raytracer/bvh.js';
import { cieXYZ, xyzToLinearRGB, LAMBDA_MIN, LAMBDA_MAX } from '../js/spectra.js';
import { V } from '../js/math.js';

const W = parseInt(process.argv[2]) || 320;
const H = parseInt(process.argv[3]) || 240;
const SPP = parseInt(process.argv[4]) || 32;
const OUT = process.argv[5] || 'demo_render.png';
const BOUNCES = 24;
const ENV_INTENSITY = 1.0;
const EXPOSURE = 1.0;

// ---- scene ----
const model = buildDemoSculpture(new Model());
const scene = buildRenderScene(model);
const pos = scene.triangles.positions;
const triCount = pos.length / 9;
const { nodes, nodeCount, order } = buildBVH(pos, triCount);
const tris = [];
for (let i = 0; i < triCount; i++) {
  const t = order[i];
  tris.push({
    v0: [pos[t * 9], pos[t * 9 + 1], pos[t * 9 + 2]],
    v1: [pos[t * 9 + 3], pos[t * 9 + 4], pos[t * 9 + 5]],
    v2: [pos[t * 9 + 6], pos[t * 9 + 7], pos[t * 9 + 8]],
    n: [scene.triangles.normals[t * 3], scene.triangles.normals[t * 3 + 1], scene.triangles.normals[t * 3 + 2]],
    matF: scene.triangles.matFront[t],
    matB: scene.triangles.matBack[t],
    coat: scene.triangles.coating[t],
  });
}
console.log(`Scene: ${triCount} tris, ${nodeCount} BVH nodes, ${scene.materials.length} materials, ${scene.coatings.length} coatings`);

// ---- rng ----
let seed = 0x9e3779b9;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
}

// ---- tracing (mirrors GLSL) ----
const TMIN = 1.5e-4;

function triHit(tri, ro, rd) {
  const e1 = V.sub(tri.v1, tri.v0), e2 = V.sub(tri.v2, tri.v0);
  const p = V.cross(rd, e2);
  const det = V.dot(e1, p);
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const tv = V.sub(ro, tri.v0);
  const u = V.dot(tv, p) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return Infinity;
  const q = V.cross(tv, e1);
  const v = V.dot(rd, q) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return Infinity;
  const t = V.dot(e2, q) * inv;
  return t > TMIN ? t : Infinity;
}

function traverse(ro, rd) {
  let bestT = Infinity, bestTri = -1;
  const inv = [1 / rd[0], 1 / rd[1], 1 / rd[2]];
  const stack = [0];
  while (stack.length) {
    const ni = stack.pop();
    const o = ni * 8;
    let tEnter = -Infinity, tExit = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = (nodes[o + k] - ro[k]) * inv[k];
      const t1 = (nodes[o + 4 + k] - ro[k]) * inv[k];
      tEnter = Math.max(tEnter, Math.min(t0, t1));
      tExit = Math.min(tExit, Math.max(t0, t1));
    }
    if (tExit < Math.max(tEnter, 0) || tEnter >= bestT) continue;
    const a = nodes[o + 3], b = nodes[o + 7];
    if (a < 0) {
      const start = -a - 1, count = b;
      for (let k = 0; k < count; k++) {
        const t = triHit(tris[start + k], ro, rd);
        if (t < bestT) { bestT = t; bestTri = start + k; }
      }
    } else {
      stack.push(a, b);
    }
  }
  return { t: bestT, tri: bestTri };
}

function iorOf(mat, lambda) {
  const m = scene.materials[mat];
  const um = lambda / 1000;
  return m.cauchyA + m.cauchyB / (um * um);
}

function sigmaOf(mat, lambda) {
  const t = scene.materials[mat].tint;
  const wb = Math.exp(-0.5 * ((lambda - 465) / 45) ** 2);
  const wg = Math.exp(-0.5 * ((lambda - 550) / 45) ** 2);
  const wr = Math.exp(-0.5 * ((lambda - 615) / 55) ** 2);
  return (t[2] * wb + t[1] * wg + t[0] * wr) / (wb + wg + wr + 1e-5);
}

function coatR(coat, lambda) {
  const bins = scene.coatings[coat].bins;
  const u = Math.min(31, Math.max(0, ((lambda - LAMBDA_MIN) / (LAMBDA_MAX - LAMBDA_MIN)) * 32 - 0.5));
  const i0 = Math.floor(u), i1 = Math.min(i0 + 1, 31);
  return bins[i0] + (bins[i1] - bins[i0]) * (u - i0);
}

function envLight(d) {
  const blob = (c, sharp, inten) => {
    const cn = V.norm(c);
    return inten * Math.pow(Math.max(V.dot(d, cn), 0), sharp);
  };
  let v = 0.05 + 0.13 * smoothstep(-0.6, 0.9, d[1]);
  v += blob([0.5, 0.85, 0.25], 90, 22);
  v += blob([-0.75, 0.45, -0.35], 45, 7);
  v += blob([0.1, 0.25, -1.0], 220, 12);
  v += blob([0, -1, 0], 8, 0.6);
  return v * ENV_INTENSITY;
}
function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function tracePath(ro, rd, lambda) {
  let L = 0, throughput = 1, medium = 0;
  for (let bounce = 0; bounce <= BOUNCES; bounce++) {
    const h = traverse(ro, rd);
    if (h.tri < 0) { L += throughput * envLight(rd); break; }
    throughput *= Math.exp(-sigmaOf(medium, lambda) * h.t);
    const tri = tris[h.tri];
    const hitP = V.add(ro, V.scale(rd, h.t));
    let fromMat, toMat, sn;
    if (V.dot(rd, tri.n) < 0) { fromMat = tri.matF; toMat = tri.matB; sn = tri.n; }
    else { fromMat = tri.matB; toMat = tri.matF; sn = V.neg(tri.n); }
    const n1 = iorOf(fromMat, lambda), n2 = iorOf(toMat, lambda);
    const eta = n1 / n2;
    const ci = Math.min(1, Math.max(0, -V.dot(rd, sn)));
    const st2 = eta * eta * (1 - ci * ci);
    let R, ct = 0;
    if (st2 >= 1) R = 1;
    else {
      ct = Math.sqrt(1 - st2);
      const rs = (n1 * ci - n2 * ct) / (n1 * ci + n2 * ct);
      const rp = (n1 * ct - n2 * ci) / (n1 * ct + n2 * ci);
      R = 0.5 * (rs * rs + rp * rp);
    }
    if (tri.coat >= 0) {
      const Rc = coatR(tri.coat, lambda);
      R = Rc + (1 - Rc) * R;
    }
    if (rnd() < R) {
      rd = V.norm(V.sub(rd, V.scale(sn, 2 * V.dot(rd, sn))));
      medium = fromMat;
    } else {
      rd = V.norm(V.add(V.scale(rd, eta), V.scale(sn, eta * ci - ct)));
      medium = toMat;
    }
    ro = V.add(hitP, V.scale(rd, 1e-4));
  }
  return L;
}

// ---- camera (matches the app's framing of the demo) ----
const bb = scene.bbox;
const target = V.scale(V.add(bb.min, bb.max), 0.5);
const size = V.len(V.sub(bb.max, bb.min));
const dist = Math.max(2, size * 1.1);
const theta = 0.7, phi = 0.42;
const eye = V.add(target, V.scale(
  [Math.cos(phi) * Math.cos(theta), Math.sin(phi), Math.cos(phi) * Math.sin(theta)], dist));
const fwd = V.norm(V.sub(target, eye));
const right = V.norm(V.cross(fwd, [0, 1, 0]));
const up = V.cross(right, fwd);
const tanFov = Math.tan((40 * Math.PI / 180) / 2);

// White balance for equal-energy spectrum.
let wbX = 0, wbY = 0, wbZ = 0;
for (let i = 0; i < 256; i++) {
  const l = LAMBDA_MIN + ((i + 0.5) / 256) * (LAMBDA_MAX - LAMBDA_MIN);
  const c = cieXYZ(l);
  wbX += c[0]; wbY += c[1]; wbZ += c[2];
}
const wbRGB = xyzToLinearRGB([wbX / wbY, 1, wbZ / wbY]).map((c) => 1 / Math.max(c, 1e-3));

// ---- render ----
const img = new Float32Array(W * H * 3);
const t0 = Date.now();
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let s = 0; s < SPP; s++) {
      const lambda = LAMBDA_MIN + rnd() * (LAMBDA_MAX - LAMBDA_MIN);
      const ndcX = ((x + rnd()) / W) * 2 - 1;
      const ndcY = 1 - ((y + rnd()) / H) * 2;
      const rd = V.norm(V.add(fwd, V.add(
        V.scale(right, ndcX * tanFov * (W / H)),
        V.scale(up, ndcY * tanFov))));
      const L = tracePath(eye.slice(), rd, lambda);
      const xyz = cieXYZ(lambda).map((c) => c * L * 3.10);
      const rgb = xyzToLinearRGB(xyz);
      r += rgb[0] * wbRGB[0]; g += rgb[1] * wbRGB[1]; b += rgb[2] * wbRGB[2];
    }
    const o = (y * W + x) * 3;
    img[o] = r / SPP; img[o + 1] = g / SPP; img[o + 2] = b / SPP;
  }
  if (y % 20 === 0) process.stdout.write(`\rrow ${y}/${H}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
console.log(`\nRendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---- tonemap + PNG ----
function aces(x) {
  return Math.max(0, Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
}
const bytes = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H * 3; i++) {
  bytes[i] = Math.round(Math.pow(aces(Math.max(0, img[i]) * EXPOSURE), 1 / 2.2) * 255);
}

// Stats sanity.
let mean = 0, nonZero = 0;
for (let i = 0; i < bytes.length; i++) { mean += bytes[i]; if (bytes[i] > 8) nonZero++; }
console.log(`mean pixel ${(mean / bytes.length).toFixed(1)}, lit fraction ${(nonZero / bytes.length * 100).toFixed(1)}%`);

writeFileSync(OUT, encodePNG(W, H, bytes));
console.log(`Wrote ${OUT}`);

function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const idat = deflateSync(raw, { level: 9 });
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(w, h)),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat(chunks);

  function ihdr(w2, h2) {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(w2, 0); b.writeUInt32BE(h2, 4);
    b[8] = 8; b[9] = 2; // 8-bit RGB
    return b;
  }
  function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  }
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
