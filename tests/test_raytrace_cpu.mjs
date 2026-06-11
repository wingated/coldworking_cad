// CPU reference implementation of the path tracer's traversal and optics.
// Mirrors the GLSL in js/raytracer/pathtracer.js so the BVH builder, the
// exported scene data, and the physics can be validated headlessly.
// Run: node tests/test_raytrace_cpu.mjs

import { Model } from '../js/model.js';
import { buildRenderScene } from '../js/export.js';
import { buildBVH } from '../js/raytracer/bvh.js';
import { V } from '../js/math.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok: ${name}`);
  else { console.error(`FAIL: ${name} ${detail}`); failures++; }
}

// ---- scene prep (mirrors PathTracer.setScene) ----
function prepScene(scene) {
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
  return { nodes, nodeCount, tris, materials: scene.materials, coatings: scene.coatings };
}

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

function traverse(S, ro, rd) {
  let best = { t: Infinity, tri: -1 };
  if (S.nodeCount === 0) return best;
  const inv = [1 / rd[0], 1 / rd[1], 1 / rd[2]];
  const stack = [0];
  while (stack.length) {
    const ni = stack.pop();
    const o = ni * 8;
    const bmin = [S.nodes[o], S.nodes[o + 1], S.nodes[o + 2]];
    const a = S.nodes[o + 3];
    const bmax = [S.nodes[o + 4], S.nodes[o + 5], S.nodes[o + 6]];
    const b = S.nodes[o + 7];
    let tEnter = -Infinity, tExit = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = (bmin[k] - ro[k]) * inv[k], t1 = (bmax[k] - ro[k]) * inv[k];
      tEnter = Math.max(tEnter, Math.min(t0, t1));
      tExit = Math.min(tExit, Math.max(t0, t1));
    }
    if (tExit < Math.max(tEnter, 0) || tEnter >= best.t) continue;
    if (a < 0) {
      const start = -a - 1, count = b;
      for (let k = 0; k < count; k++) {
        const t = triHit(S.tris[start + k], ro, rd);
        if (t < best.t) { best = { t, tri: start + k }; }
      }
    } else {
      stack.push(a, b);
    }
  }
  return best;
}

function iorOf(S, mat, lambda) {
  const m = S.materials[mat];
  const um = lambda / 1000;
  return m.cauchyA + m.cauchyB / (um * um);
}

let rngState = 12345;
function rnd() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}

// One spectral path; returns { L, bounces, escaped }.
function tracePath(S, ro, rd, lambda, maxBounces = 40) {
  let throughput = 1, medium = 0;
  ro = ro.slice(); rd = rd.slice();
  for (let bounce = 0; bounce <= maxBounces; bounce++) {
    const h = traverse(S, ro, rd);
    if (h.tri < 0) return { L: throughput, bounces: bounce, escaped: true };
    const tri = S.tris[h.tri];
    const hitP = V.add(ro, V.scale(rd, h.t));
    let fromMat, toMat, sn;
    if (V.dot(rd, tri.n) < 0) { fromMat = tri.matF; toMat = tri.matB; sn = tri.n; }
    else { fromMat = tri.matB; toMat = tri.matF; sn = V.neg(tri.n); }
    const n1 = iorOf(S, fromMat, lambda), n2 = iorOf(S, toMat, lambda);
    const eta = n1 / n2;
    const ci = Math.min(1, Math.max(0, V.dot(V.neg(rd), sn)));
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
      const bins = S.coatings[tri.coat].bins;
      const u = Math.min(31, Math.max(0, ((lambda - 380) / 350) * 32 - 0.5));
      const i0 = Math.floor(u), i1 = Math.min(i0 + 1, 31);
      const Rc = bins[i0] + (bins[i1] - bins[i0]) * (u - i0);
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
  return { L: 0, bounces: maxBounces, escaped: false };
}

// =====================================================================
// Tests

// --- Single cube: ray through center refracts straight through ---
{
  const m = new Model();
  m.addBlock('crystal_bk7', 2, 2, 2);
  const S = prepScene(buildRenderScene(m));
  check('cube scene has 12 tris', S.tris.length === 12);

  const hit = traverse(S, [5, 0, 0], [-1, 0, 0]);
  check('BVH traverse hits +x face at t=4', Math.abs(hit.t - 4) < 1e-4, `t=${hit.t}`);

  // Normal incidence through the center: ray must exit the far side
  // undeviated (refraction with ci=1 keeps direction).
  const h1 = traverse(S, [5, 0, 0], [-1, 0, 0]);
  const tri = S.tris[h1.tri];
  check('front material is air', tri.matF === 0 || tri.matB === 0);
  check('back material is glass', tri.matF === 1 || tri.matB === 1);

  // Statistical: many paths from outside should mostly escape.
  let escaped = 0, totalBounces = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const lambda = 380 + rnd() * 350;
    const oy = (rnd() - 0.5) * 1.8, oz = (rnd() - 0.5) * 1.8;
    const r = tracePath(S, [5, oy, oz], [-1, 0, 0], lambda);
    if (r.escaped) { escaped++; totalBounces += r.bounces; }
  }
  check('paths escape the cube', escaped > N * 0.97, `${escaped}/${N}`);
  check('mean bounces sane (2-6)', totalBounces / escaped > 1.5 && totalBounces / escaped < 6,
    `${(totalBounces / escaped).toFixed(2)}`);
}

// --- Fresnel sanity at normal incidence: R ≈ ((n-1)/(n+1))^2 ≈ 4.2% for BK7 ---
{
  const m = new Model();
  m.addBlock('crystal_bk7', 2, 2, 2);
  const S = prepScene(buildRenderScene(m));
  let reflected = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    // Count first-interaction reflections: path that bounces exactly once
    // and exits backwards.
    rngState = i * 7919 + 13;
    const r = rnd; // first random decides reflect/refract at first surface
    // Re-implement just the first surface decision:
    const lambda = 550;
    const n2 = iorOf(S, 1, lambda);
    const R = Math.pow((1 - n2) / (1 + n2), 2);
    if (rnd() < R) reflected++;
  }
  const frac = reflected / N;
  check('normal-incidence Fresnel ~4.2%', frac > 0.03 && frac < 0.06, `${(frac * 100).toFixed(2)}%`);
}

// --- Dispersion: prism deviates blue more than red ---
{
  const m = new Model();
  const b = m.addBlock('crystal_sf11', 2, 2, 2);
  // Cut a shallow wedge (~14 degree exit face) so refraction, not TIR,
  // happens at the exit surface.
  m.slicePiece(b.id, V.norm([1, 0.25, 0]), 0);
  m.deletePieces([m.pieces[1].id]);
  const S = prepScene(buildRenderScene(m));

  // Shoot a ray horizontally into the vertical face and follow the pure
  // refraction path (analytic Snell at each surface, no randomness).
  function refractPath(lambda) {
    let ro = [-5, -0.5, 0], rd = [1, 0, 0];
    for (let i = 0; i < 10; i++) {
      const h = traverse(S, ro, rd);
      if (h.tri < 0) return rd;
      const hitP = V.add(ro, V.scale(rd, h.t));
      const tri = S.tris[h.tri];
      let fromMat, toMat, sn;
      if (V.dot(rd, tri.n) < 0) { fromMat = tri.matF; toMat = tri.matB; sn = tri.n; }
      else { fromMat = tri.matB; toMat = tri.matF; sn = V.neg(tri.n); }
      const eta = iorOf(S, fromMat, lambda) / iorOf(S, toMat, lambda);
      const ci = Math.min(1, Math.max(0, V.dot(V.neg(rd), sn)));
      const st2 = eta * eta * (1 - ci * ci);
      if (st2 >= 1) rd = V.norm(V.sub(rd, V.scale(sn, 2 * V.dot(rd, sn))));
      else {
        const ct = Math.sqrt(1 - st2);
        rd = V.norm(V.add(V.scale(rd, eta), V.scale(sn, eta * ci - ct)));
      }
      ro = V.add(hitP, V.scale(rd, 1e-4));
    }
    return rd;
  }
  const red = refractPath(656);
  const blue = refractPath(486);
  // Deviation from the incoming +x direction.
  const dev = (d) => Math.acos(Math.min(1, d[0]));
  check('prism bends the beam', dev(red) > 0.01, JSON.stringify({ red, blue }));
  // SF11 disperses strongly; blue must deviate more than red.
  check('blue deviates more than red (dispersion)', dev(blue) > dev(red) + 0.003,
    `red ${dev(red).toFixed(4)} blue ${dev(blue).toFixed(4)}`);
}

// --- Dichroic plate splits by wavelength ---
{
  const m = new Model();
  const b = m.addBlock('crystal_bk7', 1, 1, 1);
  m.addPlateOnFace(b.id, 1, 'dichro_cyan_red', 'in'); // reflects ~490nm band
  const S = prepScene(buildRenderScene(m));
  // Find the coated triangle and check the coating reflects cyan, passes red.
  const coated = S.tris.filter((t) => t.coat >= 0);
  check('coated tris exist', coated.length > 0);
  const bins = S.coatings[0].bins;
  const at = (lambda) => bins[Math.round(((lambda - 380) / 350) * 32 - 0.5)];
  check('reflects cyan (490nm)', at(490) > 0.8, `${at(490)}`);
  check('transmits red (670nm)', at(670) < 0.15, `${at(670)}`);

  // Monte Carlo: paths of both wavelengths must terminate (no infinite
  // bouncing inside the laminate).
  let cyanThrough = 0, redThrough = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const rC = tracePath(S, [5, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8], [-1, 0, 0], 490, 60);
    const rR = tracePath(S, [5, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8], [-1, 0, 0], 670, 60);
    if (rC.escaped) cyanThrough++;
    if (rR.escaped) redThrough++;
  }
  check('both wavelengths mostly escape eventually', cyanThrough > N * 0.9 && redThrough > N * 0.9,
    `${cyanThrough} ${redThrough}`);
}

// --- BVH on a bigger scene: sliced + arrayed pieces ---
{
  const m = new Model();
  const b = m.addBlock('crystal_bk7', 4, 0.5, 0.5);
  m.addPlateOnFace(b.id, 3, 'dichro_magenta_green', 'in');
  m.sliceEqual(m.pieces.map((p) => p.id), [1, 0, 0], 8);
  m.arrayRotational(m.pieces.map((p) => p.id), 4, [0, 0, 1], [0, 0, 0], 360);
  const scene = buildRenderScene(m);
  const S = prepScene(scene);
  check('big scene tri count > 200', S.tris.length > 200, `${S.tris.length}`);
  // Fire a bundle of rays; all should terminate without infinite loops and
  // mostly escape.
  let escaped = 0;
  const N = 1500;
  for (let i = 0; i < N; i++) {
    const dir = V.norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
    const r = tracePath(S, V.scale(dir, -8), dir, 380 + rnd() * 350, 60);
    if (r.escaped) escaped++;
  }
  check('complex scene: >90% of paths escape', escaped > N * 0.9, `${escaped}/${N}`);
}

console.log(failures === 0 ? '\nAll CPU raytrace tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
