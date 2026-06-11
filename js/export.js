// Scene export for the ray tracer (and for the standalone visualizer file).
//
// The CAD model is a set of glued convex solids. A correct optical model
// must distinguish three kinds of surfaces:
//   1. exterior faces:    air <-> glass
//   2. glued interfaces:  glass <-> glass (invisible if same material — the
//                         "no visible seams" property of good coldworking)
//   3. dichroic surfaces: spectral splitters (coated faces), interior or not
//
// Coincident face pairs between adjacent pieces are detected geometrically
// and emitted exactly once as interface triangles carrying the materials on
// both sides; the non-contact remainder of each face stays an exterior
// air-glass surface. This avoids both double-refraction and z-fighting at
// glue joints.

import {
  faceNormal, planeBasis, clipPolygon2D, subtractPolygon2D, polygonArea2D,
} from './geometry.js';
import { V } from './math.js';
import { materialCauchy, DICHROIC_THICKNESS } from './materials.js';
import { sampleSpectrum } from './spectra.js';

const PLANE_EPS = 2e-4;  // inches: faces closer than this are "glued"
const AREA_EPS = 1e-6;   // square inches

export const AIR = 0; // material index 0 is always air

// Build the render scene from the model. Returns
// {
//   materials: [{ name, cauchyA, cauchyB, tint:[r,g,b] }],  // [0] is air
//   coatings:  [{ name, bins: Float32Array }],
//   triangles: { positions: Float32Array(9*n),
//                normals: Float32Array(3*n),       // geometric, per tri
//                matFront: Int32Array(n), matBack: Int32Array(n),
//                coating: Int32Array(n) },          // -1 = none
//   bbox: { min, max },
// }
export function buildRenderScene(model) {
  const pieces = model.pieces.filter((p) => p.visible);

  // Material palette.
  const matIndex = new Map(); // materialId -> palette index
  const materials = [{ name: 'air', cauchyA: 1.0, cauchyB: 0.0, tint: [0, 0, 0] }];
  function matIdx(materialId) {
    if (matIndex.has(materialId)) return matIndex.get(materialId);
    const m = model.library.get(materialId);
    const c = m ? materialCauchy(m) : { A: 1.5, B: 0.005 };
    const tint = m && m.kind === 'crystal' ? m.tint : [0.01, 0.01, 0.01];
    const idx = materials.length;
    materials.push({ name: m ? m.name : 'unknown', cauchyA: c.A, cauchyB: c.B, tint });
    matIndex.set(materialId, idx);
    return idx;
  }

  // Coating palette.
  const coatIndex = new Map();
  const coatings = [];
  function coatIdx(coatingId) {
    if (coatingId == null) return -1;
    if (coatIndex.has(coatingId)) return coatIndex.get(coatingId);
    const m = model.library.get(coatingId);
    const idx = coatings.length;
    coatings.push({
      name: m ? m.name : 'coating',
      bins: m && m.bands ? Array.from(sampleSpectrum(m.bands, 32)) : new Array(32).fill(0.5),
    });
    coatIndex.set(coatingId, idx);
    return idx;
  }

  // Gather world-space faces with owning piece info.
  const allFaces = [];
  for (const piece of pieces) {
    const wp = model.worldPoly(piece);
    wp.faces.forEach((face, fi) => {
      const n = faceNormal(wp, face);
      const pts = face.indices.map((i) => wp.verts[i]);
      const d = V.dot(n, pts[0]);
      allFaces.push({
        piece, faceIndex: fi, n, d, pts,
        coating: face.coating,
        mat: matIdx(piece.materialId),
        // Regions of this face still exposed to air, as 2D convex polys in
        // the face plane basis; initialized to the full face.
        u: null, w: null, exterior: null,
      });
    });
  }

  // Precompute 2D projections.
  for (const f of allFaces) {
    const [u, w] = planeBasis(f.n);
    f.u = u; f.w = w;
    f.poly2d = f.pts.map((p) => [V.dot(p, u), V.dot(p, w)]);
    if (polygonArea2D(f.poly2d) < 0) f.poly2d.reverse(); // ensure CCW in 2D
    f.exterior = [f.poly2d];
  }

  const triangles = { positions: [], normals: [], matFront: [], matBack: [], coating: [] };

  function emitPolygon(pts3, n, matFront, matBack, coating) {
    for (let i = 1; i < pts3.length - 1; i++) {
      triangles.positions.push(...pts3[0], ...pts3[i], ...pts3[i + 1]);
      triangles.normals.push(...n);
      triangles.matFront.push(matFront);
      triangles.matBack.push(matBack);
      triangles.coating.push(coating);
    }
  }

  function unproject(f, poly2d) {
    // (u, w, n) is orthonormal, so p = u*a + w*b + n*d for plane points.
    const origin = V.scale(f.n, f.d);
    return poly2d.map(([a, b]) =>
      V.add(origin, V.add(V.scale(f.u, a), V.scale(f.w, b))));
  }

  // Detect glued interfaces: pairs of faces with opposing normals in the
  // same plane and overlapping outlines.
  for (let i = 0; i < allFaces.length; i++) {
    for (let j = i + 1; j < allFaces.length; j++) {
      const a = allFaces[i], b = allFaces[j];
      if (a.piece === b.piece) continue;
      if (V.dot(a.n, b.n) > -0.9999) continue; // not opposing
      // Distance between the two planes measured along a.n.
      const planeDist = Math.abs(V.dot(a.n, b.pts[0]) - a.d);
      if (planeDist > PLANE_EPS) continue;

      // Project b's outline into a's 2D basis and intersect.
      const b2d = b.pts.map((p) => [V.dot(p, a.u), V.dot(p, a.w)]);
      if (polygonArea2D(b2d) < 0) b2d.reverse();
      const overlap = clipPolygon2D(a.poly2d, b2d);
      if (overlap.length < 3 || Math.abs(polygonArea2D(overlap)) < AREA_EPS) continue;

      // Emit interface: normal a.n points out of piece A into piece B.
      const sameMat = a.mat === b.mat;
      const coat = coatIdx(a.coating ?? b.coating);
      if (!sameMat || coat >= 0) {
        emitPolygon(unproject(a, overlap), a.n, b.mat, a.mat, coat);
      }
      // If same material and uncoated: emit nothing — seamless glue joint.

      // Remove the overlap from both faces' exterior regions.
      a.exterior = a.exterior.flatMap((p) => subtractPolygon2D(p, overlap));
      const overlapInB = overlap.map(([x, y]) => {
        // Convert from a's basis back to 3D, then into b's basis.
        const p3 = unproject(a, [[x, y]])[0];
        return [V.dot(p3, b.u), V.dot(p3, b.w)];
      });
      if (polygonArea2D(overlapInB) < 0) overlapInB.reverse();
      b.exterior = b.exterior.flatMap((p) => subtractPolygon2D(p, overlapInB));
    }
  }

  // Emit remaining exterior regions as air-glass surfaces.
  for (const f of allFaces) {
    for (const region of f.exterior) {
      if (region.length < 3 || Math.abs(polygonArea2D(region)) < AREA_EPS) continue;
      emitPolygon(unproject(f, region), f.n, AIR, f.mat, coatIdx(f.coating));
    }
  }

  const bbox = model.sceneBBox();
  return {
    format: 'coldworking-render-scene',
    version: 1,
    projectName: model.projectName,
    units: 'in',
    plateThickness: DICHROIC_THICKNESS,
    materials,
    coatings,
    triangles: {
      positions: triangles.positions,
      normals: triangles.normals,
      matFront: triangles.matFront,
      matBack: triangles.matBack,
      coating: triangles.coating,
    },
    bbox,
  };
}
