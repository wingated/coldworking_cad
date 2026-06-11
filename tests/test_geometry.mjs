// Node-based unit tests for the geometry kernel (no DOM/GL needed).
// Run: node tests/test_geometry.mjs

import {
  makeBox, clipPoly, polyVolume, polyCentroid, polyBBox, polyEdges,
  chamferPoly, offsetFace, raycastPoly, faceNormal, triangulate,
  clipPolygon2D, subtractPolygon2D, polygonArea2D, transformPoly,
} from '../js/geometry.js';
import { V, Q, DEG } from '../js/math.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok: ${name}`);
  else { console.error(`FAIL: ${name} ${detail}`); failures++; }
}
function approx(a, b, eps = 1e-5) { return Math.abs(a - b) < eps; }

// --- Box basics ---
const box = makeBox(2, 3, 4);
check('box volume', approx(polyVolume(box), 24));
check('box edges', polyEdges(box).length === 12);
check('box centroid', V.len(polyCentroid(box)) < 1e-6);
for (const f of box.faces) {
  const n = faceNormal(box, f);
  const c = f.indices.reduce((acc, i) => V.add(acc, box.verts[i]), [0, 0, 0]).map((x) => x / 4);
  check('box face normal outward', V.dot(n, c) > 0, JSON.stringify(n));
}

// --- Plane clip: cut box in half along x ---
{
  const { kept, cut } = clipPoly(makeBox(2, 2, 2), [1, 0, 0], 0);
  check('clip kept volume', approx(polyVolume(kept), 4), `got ${polyVolume(kept)}`);
  check('clip cut volume', approx(polyVolume(cut), 4), `got ${polyVolume(cut)}`);
  check('clip kept faces', kept.faces.length === 6, `got ${kept.faces.length}`);
  // Cap face should have outward normal +x on kept side.
  const cap = kept.faces[kept.faces.length - 1];
  const n = faceNormal(kept, cap);
  check('cap normal +x', approx(n[0], 1), JSON.stringify(n));
  // Conservation of volume under angled cut.
  const r2 = clipPoly(makeBox(2, 2, 2), V.norm([1, 1, 0.3]), 0.2);
  check('angled cut conserves volume',
    approx(polyVolume(r2.kept) + polyVolume(r2.cut), 8),
    `${polyVolume(r2.kept)} + ${polyVolume(r2.cut)}`);
}

// --- Clip entirely inside/outside ---
{
  const r = clipPoly(makeBox(2, 2, 2), [1, 0, 0], 5);
  check('clip all-in', r.kept !== null && r.cut === null && approx(polyVolume(r.kept), 8));
  const r2 = clipPoly(makeBox(2, 2, 2), [1, 0, 0], -5);
  check('clip all-out', r2.kept === null && r2.cut !== null);
}

// --- Repeated slicing (the "bar into N pieces" workflow) ---
{
  let bar = makeBox(10, 1, 1);
  const pieces = [];
  let rest = bar;
  for (let i = 1; i < 10; i++) {
    const { kept, cut } = clipPoly(rest, [1, 0, 0], -5 + i);
    pieces.push(kept);
    rest = cut;
  }
  pieces.push(rest);
  check('bar sliced into 10', pieces.length === 10 && pieces.every((p) => approx(polyVolume(p), 1, 1e-4)),
    pieces.map((p) => polyVolume(p).toFixed(4)).join(','));
}

// --- Chamfer ---
{
  const c = chamferPoly(makeBox(2, 2, 2), 0.2);
  // Cube chamfered on all 12 edges: 6 + 12 new faces, plus corner triangles
  // from intersecting chamfer planes.
  check('chamfer reduces volume', polyVolume(c) < 8 && polyVolume(c) > 7,
    `vol ${polyVolume(c)}`);
  check('chamfer adds faces', c.faces.length >= 18, `faces ${c.faces.length}`);
}

// --- Offset face (extrude) ---
{
  const b = makeBox(2, 2, 2);
  // Face index 1 is +x; push it out 1" -> volume 12.
  const e = offsetFace(b, 1, 1);
  check('extrude +x face', approx(polyVolume(e), 12), `vol ${polyVolume(e)}`);
  const s = offsetFace(b, 1, -0.5);
  check('shrink +x face', approx(polyVolume(s), 6), `vol ${polyVolume(s)}`);
}

// --- Raycast ---
{
  const b = makeBox(2, 2, 2);
  const hit = raycastPoly(b, [5, 0, 0], [-1, 0, 0]);
  check('raycast hit', hit !== null && approx(hit.t, 4), hit && `t=${hit.t}`);
  check('raycast face is +x', hit.faceIndex === 1, `face ${hit && hit.faceIndex}`);
  const miss = raycastPoly(b, [5, 5, 0], [-1, 0, 0]);
  check('raycast miss', miss === null);
}

// --- Transform ---
{
  const b = transformPoly(makeBox(2, 2, 2), Q.fromAxisAngle([0, 0, 1], 45 * DEG), [10, 0, 0]);
  check('transform preserves volume', approx(polyVolume(b), 8));
  check('transform moves centroid', approx(V.dist(polyCentroid(b), [10, 0, 0]), 0));
}

// --- Triangulate ---
{
  const t = triangulate(makeBox(1, 1, 1));
  check('triangulate count', t.positions.length === 12 * 3 * 3, `${t.positions.length}`);
}

// --- 2D polygon ops (interface detection) ---
{
  const sq = [[0, 0], [2, 0], [2, 2], [0, 2]]; // CCW
  const sq2 = [[1, 1], [3, 1], [3, 3], [1, 3]];
  const inter = clipPolygon2D(sq, sq2);
  check('2D intersection area', approx(Math.abs(polygonArea2D(inter)), 1), `${polygonArea2D(inter)}`);
  const diff = subtractPolygon2D(sq, sq2);
  const diffArea = diff.reduce((a, p) => a + Math.abs(polygonArea2D(p)), 0);
  check('2D subtraction area', approx(diffArea, 3), `${diffArea}`);
  // Disjoint
  const far = [[10, 10], [11, 10], [11, 11], [10, 11]];
  check('2D disjoint intersection empty', clipPolygon2D(sq, far).length < 3);
  const diff2 = subtractPolygon2D(sq, far);
  const diff2Area = diff2.reduce((a, p) => a + Math.abs(polygonArea2D(p)), 0);
  check('2D disjoint subtraction = full', approx(diff2Area, 4), `${diff2Area}`);
  // Identical
  check('2D identical intersection', approx(Math.abs(polygonArea2D(clipPolygon2D(sq, sq))), 4));
  const diff3 = subtractPolygon2D(sq, sq);
  const diff3Area = diff3.reduce((a, p) => a + Math.abs(polygonArea2D(p)), 0);
  check('2D identical subtraction empty', approx(diff3Area, 0), `${diff3Area}`);
}

// --- Angled slice then re-slice (compound cuts stay consistent) ---
{
  let p = makeBox(2, 2, 2);
  const cut1 = clipPoly(p, V.norm([1, 1, 1]), 0.5);
  const cut2 = clipPoly(cut1.kept, V.norm([-1, 1, 0]), 0.3);
  const total = polyVolume(cut2.kept) + polyVolume(cut2.cut) + polyVolume(cut1.cut);
  check('compound cuts conserve volume', approx(total, 8, 1e-4), `${total}`);
}

console.log(failures === 0 ? '\nAll geometry tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
