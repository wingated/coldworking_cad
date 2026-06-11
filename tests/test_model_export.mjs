// Tests for the document model and render-scene export.
// Run: node tests/test_model_export.mjs

import { Model } from '../js/model.js';
import { buildRenderScene, AIR } from '../js/export.js';
import { polyVolume } from '../js/geometry.js';
import { V } from '../js/math.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok: ${name}`);
  else { console.error(`FAIL: ${name} ${detail}`); failures++; }
}
function approx(a, b, eps = 1e-4) { return Math.abs(a - b) < eps; }

function triCount(scene) { return scene.triangles.matFront.length; }
function areaOfTris(scene, filter) {
  let area = 0;
  const t = scene.triangles;
  for (let i = 0; i < triCount(scene); i++) {
    if (!filter(t.matFront[i], t.matBack[i], t.coating[i])) continue;
    const p = t.positions;
    const a = [p[i * 9], p[i * 9 + 1], p[i * 9 + 2]];
    const b = [p[i * 9 + 3], p[i * 9 + 4], p[i * 9 + 5]];
    const c = [p[i * 9 + 6], p[i * 9 + 7], p[i * 9 + 8]];
    area += V.len(V.cross(V.sub(b, a), V.sub(c, a))) / 2;
  }
  return area;
}

// --- Single block: 6 exterior faces, 12 triangles, area 6 ---
{
  const m = new Model();
  m.addBlock('crystal_bk7', 1, 1, 1);
  const scene = buildRenderScene(m);
  check('single block tri count', triCount(scene) === 12, `${triCount(scene)}`);
  check('single block area', approx(areaOfTris(scene, () => true), 6));
  check('all exterior', scene.triangles.matFront.every((f) => f === AIR));
}

// --- Two glued same-material blocks: shared face disappears (seamless) ---
{
  const m = new Model();
  m.addBlock('crystal_bk7', 1, 1, 1, [0, 0, 0]);
  m.addBlock('crystal_bk7', 1, 1, 1, [1, 0, 0]);
  const scene = buildRenderScene(m);
  const total = areaOfTris(scene, () => true);
  // 2x1x1 bar exterior area = 2*(2*1) + 2*(2*1) + 2*(1*1) = 10
  check('glued same material: seamless area', approx(total, 10), `${total}`);
  check('glued same material: no internal tris',
    scene.triangles.matBack.every((b, i) => scene.triangles.matFront[i] === AIR));
}

// --- Two glued different-material blocks: interface emitted once ---
{
  const m = new Model();
  m.addBlock('crystal_bk7', 1, 1, 1, [0, 0, 0]);
  m.addBlock('crystal_sf11', 1, 1, 1, [1, 0, 0]);
  const scene = buildRenderScene(m);
  const internal = areaOfTris(scene, (f, b) => f !== AIR && b !== AIR);
  const exterior = areaOfTris(scene, (f) => f === AIR);
  check('different materials: interface area 1', approx(internal, 1), `${internal}`);
  check('different materials: exterior area 10', approx(exterior, 10), `${exterior}`);
  check('three materials in palette', scene.materials.length === 3);
}

// --- Partial overlap: small cube on big face ---
{
  const m = new Model();
  m.addBlock('crystal_bk7', 2, 2, 2, [0, 0, 0]);
  m.addBlock('crystal_bk7', 1, 1, 1, [1.5, 0, 0]); // touches +x face of big cube
  const scene = buildRenderScene(m);
  const total = areaOfTris(scene, () => true);
  // Exterior: big cube 24 - 1 (covered) + small cube 6 - 1 (touching) = 28
  check('partial overlap exterior area', approx(total, 28), `${total}`);
}

// --- Dichroic plate on a face ---
{
  const m = new Model();
  const b = m.addBlock('crystal_bk7', 1, 1, 1);
  // Face 1 is +x.
  const plate = m.addPlateOnFace(b.id, 1, 'dichro_cyan_red', 'in');
  check('plate created', plate !== null);
  check('plate volume = 1*1*0.125', approx(polyVolume(plate.poly), 0.125), `${polyVolume(plate.poly)}`);
  const scene = buildRenderScene(m);
  const coated = areaOfTris(scene, (f, bk, c) => c >= 0);
  check('coated interface area 1', approx(coated, 1), `${coated}`);
  check('one coating in palette', scene.coatings.length === 1);
  check('coating spectrum sane', scene.coatings[0].bins.length === 32 &&
    Math.max(...scene.coatings[0].bins) > 0.5 && Math.min(...scene.coatings[0].bins) < 0.2);
  // The coated triangles must be interfaces between plate substrate and crystal.
  const t = scene.triangles;
  let ok = true;
  for (let i = 0; i < triCount(scene); i++) {
    if (t.coating[i] >= 0 && (t.matFront[i] === AIR || t.matBack[i] === AIR)) ok = false;
  }
  check('coated face is internal (plate glued to block)', ok);
}

// --- Slice then export: still watertight, volume preserved ---
{
  const m = new Model();
  const b = m.addBlock('crystal_bk7', 2, 1, 1);
  const ids = m.slicePiece(b.id, V.norm([1, 0.2, 0]), 0.1);
  check('slice produced 2 pieces', ids.length === 2 && m.pieces.length === 2);
  const vol = m.pieces.reduce((a, p) => a + polyVolume(p.poly), 0);
  check('slice conserves volume', approx(vol, 2), `${vol}`);
  const scene = buildRenderScene(m);
  // Same material, uncoated: cut face should vanish (seamless) -> exterior = 10... no:
  // 2x1x1 bar area = 2*2 + 2*2 + 1 + 1 = 10.
  const total = areaOfTris(scene, () => true);
  check('sliced bar still seamless', approx(total, 10, 1e-3), `${total}`);
}

// --- sliceEqual: bar into 8 ---
{
  const m = new Model();
  const b = m.addBlock('crystal_bk7', 8, 1, 1);
  m.sliceEqual([b.id], [1, 0, 0], 8);
  check('sliceEqual count', m.pieces.length === 8, `${m.pieces.length}`);
  const vols = m.pieces.map((p) => polyVolume(p.poly));
  check('sliceEqual equal volumes', vols.every((v) => approx(v, 1, 1e-3)), vols.join(','));
}

// --- Rotate 45deg and glue: mateFaces aligns properly ---
{
  const m = new Model();
  const a = m.addBlock('crystal_bk7', 1, 1, 1, [0, 0, 0]);
  const b = m.addBlock('crystal_sf11', 1, 1, 1, [5, 5, 5]);
  m.rotatePieces([b.id], [0, 0, 1], 45, [5, 5, 5]);
  m.mateFaces(a.id, 1 /* +x of A */, b.id, 0 /* -x of B */);
  const scene = buildRenderScene(m);
  const internal = areaOfTris(scene, (f, bk) => f !== AIR && bk !== AIR);
  check('mateFaces creates full interface', approx(internal, 1, 1e-3), `${internal}`);
}

// --- Undo/redo ---
{
  const m = new Model();
  m.addBlock('crystal_bk7', 1, 1, 1);
  m.addBlock('crystal_bk7', 1, 1, 1, [2, 0, 0]);
  check('two pieces', m.pieces.length === 2);
  m.undo();
  check('undo to one piece', m.pieces.length === 1);
  m.undo();
  check('undo to empty', m.pieces.length === 0);
  m.redo(); m.redo();
  check('redo to two pieces', m.pieces.length === 2);
}

// --- Serialize round trip ---
{
  const m = new Model();
  const b = m.addBlock('crystal_bk7', 2, 1, 1);
  m.slicePiece(b.id, [1, 0, 0], 0);
  m.addPlateOnFace(m.pieces[0].id, 1, 'dichro_blue_gold');
  m.library.addCrystal({ name: 'My glass', nd: 1.6, abbe: 40 });
  const json = JSON.parse(JSON.stringify(m.serialize()));
  const m2 = new Model();
  m2.deserialize(json);
  check('roundtrip piece count', m2.pieces.length === m.pieces.length);
  check('roundtrip user material', m2.library.all().some((x) => x.name === 'My glass'));
  const s1 = buildRenderScene(m), s2 = buildRenderScene(m2);
  check('roundtrip same scene tris', triCount(s1) === triCount(s2));
}

// --- Rotational array ---
{
  const m = new Model();
  const b = m.addBlock('crystal_bk7', 1, 0.2, 0.2, [1, 0, 0]);
  m.arrayRotational([b.id], 6, [0, 0, 1], [0, 0, 0], 360);
  check('rotational array count', m.pieces.length === 6, `${m.pieces.length}`);
  const vol = m.pieces.reduce((a, p) => a + polyVolume(p.poly), 0);
  check('rotational array volumes', approx(vol, 6 * 0.04, 1e-3), `${vol}`);
}

// --- Chamfer via model ---
{
  const m = new Model();
  const b = m.addBlock('crystal_bk7', 1, 1, 1);
  m.chamferPieces([b.id], 0.1);
  check('chamfer faces > 6', m.pieces[0].poly.faces.length > 6);
  const scene = buildRenderScene(m);
  check('chamfered block exports', triCount(scene) > 12);
}

// --- Overlap detection ---
{
  const m = new Model();
  m.addBlock('crystal_bk7', 1, 1, 1, [0, 0, 0]);
  m.addBlock('crystal_bk7', 1, 1, 1, [1, 0, 0]); // face-touching: NOT an overlap
  check('glued pieces do not count as overlap', m.findOverlaps().length === 0);
  m.addBlock('crystal_bk7', 1, 1, 1, [0.5, 0, 0]); // interpenetrates both
  const ov = m.findOverlaps();
  check('interpenetration detected', ov.length === 2, `${ov.length}`);
  check('overlap volume correct', ov.every((o) => approx(o.volume, 0.5, 1e-3)),
    ov.map((o) => o.volume.toFixed(4)).join(','));
}

console.log(failures === 0 ? '\nAll model/export tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
