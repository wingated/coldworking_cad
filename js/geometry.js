// Convex polyhedron geometry kernel.
//
// Every piece in a coldworked sculpture is a convex solid with flat faces:
// blocks are boxes, and every shaping operation (saw cut, bevel/chamfer,
// face grind) is a plane clip. So the entire kernel is built on one robust
// primitive: clipping a convex polyhedron by a half-space.
//
// Representation:
//   poly = {
//     verts: [[x,y,z], ...],
//     faces: [{ indices: [i,...],   // CCW seen from outside
//               coating: string|null // dichroic coating id on this face
//             }, ...]
//   }
// Units are inches throughout the app.

import { V, Q } from './math.js';

const EPS = 1e-7;

export function faceNormal(poly, face) {
  // Newell's method (robust for any planar polygon).
  const idx = face.indices;
  let n = [0, 0, 0];
  for (let i = 0; i < idx.length; i++) {
    const a = poly.verts[idx[i]];
    const b = poly.verts[idx[(i + 1) % idx.length]];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return V.norm(n);
}

export function faceCentroid(poly, face) {
  let c = [0, 0, 0];
  for (const i of face.indices) c = V.add(c, poly.verts[i]);
  return V.scale(c, 1 / face.indices.length);
}

export function faceArea(poly, face) {
  const idx = face.indices;
  const p0 = poly.verts[idx[0]];
  let area = 0;
  for (let i = 1; i < idx.length - 1; i++) {
    const e1 = V.sub(poly.verts[idx[i]], p0);
    const e2 = V.sub(poly.verts[idx[i + 1]], p0);
    area += V.len(V.cross(e1, e2)) / 2;
  }
  return area;
}

// Axis-aligned box, centered at origin. Faces ordered -x,+x,-y,+y,-z,+z.
export function makeBox(w, h, d) {
  const x = w / 2, y = h / 2, z = d / 2;
  const verts = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const faces = [
    { indices: [0, 4, 7, 3], coating: null }, // -x
    { indices: [1, 2, 6, 5], coating: null }, // +x
    { indices: [0, 1, 5, 4], coating: null }, // -y
    { indices: [3, 7, 6, 2], coating: null }, // +y
    { indices: [0, 3, 2, 1], coating: null }, // -z
    { indices: [4, 5, 6, 7], coating: null }, // +z
  ];
  return { verts, faces };
}

export function clonePoly(poly) {
  return {
    verts: poly.verts.map(V.clone),
    faces: poly.faces.map((f) => ({ indices: f.indices.slice(), coating: f.coating })),
  };
}

export function transformPoly(poly, rotationQ, translation) {
  return {
    verts: poly.verts.map((v) => V.add(Q.rotateVec(rotationQ, v), translation)),
    faces: poly.faces.map((f) => ({ indices: f.indices.slice(), coating: f.coating })),
  };
}

// Clip poly by half-space dot(n, p) <= d. Returns { kept, cut } where either
// may be null (fully outside / fully inside). `capCoating` is applied to the
// new flat face created by the cut on the kept side.
export function clipPoly(poly, n, d, capCoating = null) {
  const sd = poly.verts.map((v) => V.dot(n, v) - d);
  const allIn = sd.every((s) => s <= EPS);
  const allOut = sd.every((s) => s >= -EPS);
  if (allIn) return { kept: clonePoly(poly), cut: null };
  if (allOut) return { kept: null, cut: clonePoly(poly) };

  const kept = buildClipped(poly, sd, false, capCoating, n, d);
  const cut = buildClipped(poly, sd, true, capCoating, n, d);
  return { kept, cut };
}

function buildClipped(poly, sdIn, flip, capCoating, planeN, planeD) {
  // flip=false keeps sd<=0 side; flip=true keeps sd>=0 side.
  const sd = flip ? sdIn.map((s) => -s) : sdIn;
  const newVerts = [];
  const vmap = new Map(); // weld key -> index

  function addVert(p) {
    const key = `${Math.round(p[0] / EPS)},${Math.round(p[1] / EPS)},${Math.round(p[2] / EPS)}`;
    if (vmap.has(key)) return vmap.get(key);
    const i = newVerts.length;
    newVerts.push(p);
    vmap.set(key, i);
    return i;
  }

  const newFaces = [];

  for (const face of poly.faces) {
    const idx = face.indices;
    const out = [];
    for (let i = 0; i < idx.length; i++) {
      const a = idx[i], b = idx[(i + 1) % idx.length];
      const sa = sd[a], sb = sd[b];
      if (sa <= EPS) out.push(addVert(poly.verts[a]));
      if ((sa < -EPS && sb > EPS) || (sa > EPS && sb < -EPS)) {
        const t = sa / (sa - sb);
        out.push(addVert(V.lerp(poly.verts[a], poly.verts[b], t)));
      }
    }
    // Deduplicate consecutive indices.
    const dedup = out.filter((v, i) => v !== out[(i + 1) % out.length]);
    if (dedup.length >= 3) newFaces.push({ indices: dedup, coating: face.coating });
  }
  if (newFaces.length < 3) return null;

  // The cap face's outward normal points along the clip plane normal on the
  // kept side, and opposite on the cut side.
  const nn = flip ? V.neg(planeN) : planeN;
  const dd = flip ? -planeD : planeD;

  const capIdx = [];
  for (let i = 0; i < newVerts.length; i++) {
    if (Math.abs(V.dot(nn, newVerts[i]) - dd) < 1e-5) capIdx.push(i);
  }
  if (capIdx.length >= 3) {
    // Order around centroid in the cap plane, CCW as seen from outside (+nn).
    let c = [0, 0, 0];
    for (const i of capIdx) c = V.add(c, newVerts[i]);
    c = V.scale(c, 1 / capIdx.length);
    let u = V.norm(V.sub(newVerts[capIdx[0]], c));
    if (V.len(u) < 1e-9) u = orthoBasis(nn)[0];
    const w = V.norm(V.cross(nn, u));
    capIdx.sort((a, b) => {
      const pa = V.sub(newVerts[a], c), pb = V.sub(newVerts[b], c);
      return Math.atan2(V.dot(pa, w), V.dot(pa, u)) - Math.atan2(V.dot(pb, w), V.dot(pb, u));
    });
    // Drop duplicates / collinear repeats.
    const cap = [];
    for (const i of capIdx) {
      if (cap.length === 0 || V.dist(newVerts[cap[cap.length - 1]], newVerts[i]) > 1e-6) cap.push(i);
    }
    if (cap.length >= 3 && V.dist(newVerts[cap[0]], newVerts[cap[cap.length - 1]]) < 1e-6) cap.pop();
    if (cap.length >= 3) {
      // Ensure winding matches outward normal nn.
      const tmpPoly = { verts: newVerts, faces: [] };
      const fn = faceNormal(tmpPoly, { indices: cap });
      if (V.dot(fn, nn) < 0) cap.reverse();
      newFaces.push({ indices: cap, coating: capCoating });
    }
  }
  return { verts: newVerts, faces: newFaces };
}

function orthoBasis(n) {
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = V.norm(V.cross(n, a));
  return [u, V.cross(n, u)];
}

export function polyVolume(poly) {
  // Sum of signed tetra volumes from origin over triangulated faces.
  let vol = 0;
  for (const face of poly.faces) {
    const idx = face.indices;
    const p0 = poly.verts[idx[0]];
    for (let i = 1; i < idx.length - 1; i++) {
      const p1 = poly.verts[idx[i]];
      const p2 = poly.verts[idx[i + 1]];
      vol += V.dot(p0, V.cross(p1, p2)) / 6;
    }
  }
  return Math.abs(vol);
}

export function polyCentroid(poly) {
  let c = [0, 0, 0], vol = 0;
  for (const face of poly.faces) {
    const idx = face.indices;
    const p0 = poly.verts[idx[0]];
    for (let i = 1; i < idx.length - 1; i++) {
      const p1 = poly.verts[idx[i]];
      const p2 = poly.verts[idx[i + 1]];
      const v = V.dot(p0, V.cross(p1, p2)) / 6;
      vol += v;
      c = V.add(c, V.scale(V.add(V.add(p0, p1), p2), v / 4));
    }
  }
  return vol !== 0 ? V.scale(c, 1 / vol) : [0, 0, 0];
}

export function polyBBox(poly) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of poly.verts) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i];
      if (v[i] > max[i]) max[i] = v[i];
    }
  }
  return { min, max };
}

// Unique edges as pairs of vertex indices, with the two adjacent face indices.
export function polyEdges(poly) {
  const map = new Map();
  poly.faces.forEach((face, fi) => {
    const idx = face.indices;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[i], b = idx[(i + 1) % idx.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!map.has(key)) map.set(key, { a: Math.min(a, b), b: Math.max(a, b), faces: [] });
      map.get(key).faces.push(fi);
    }
  });
  return [...map.values()];
}

// Chamfer (bevel) all edges by clipping with a 45-degree bisector plane set
// back `dist` from each edge. Sharp edges only (dihedral angle below ~170deg).
export function chamferPoly(poly, dist) {
  let result = clonePoly(poly);
  const edges = polyEdges(poly);
  const normals = poly.faces.map((f) => faceNormal(poly, f));
  for (const e of edges) {
    if (e.faces.length !== 2) continue;
    const n1 = normals[e.faces[0]], n2 = normals[e.faces[1]];
    if (V.dot(n1, n2) > 0.985) continue; // nearly coplanar, not a real edge
    const bis = V.norm(V.add(n1, n2));
    const edgeMid = V.scale(V.add(poly.verts[e.a], poly.verts[e.b]), 0.5);
    // Plane through point edgeMid - bis*dist, normal bis.
    const d = V.dot(bis, edgeMid) - dist;
    const r = clipPoly(result, bis, d);
    if (r.kept) result = r.kept;
  }
  return result;
}

// Move a face plane outward (+) or inward (-) along its normal: extrude /
// shrink. Vertices on the face are recomputed as the intersection of the
// moved plane with their two other adjacent face planes (exact for valence-3
// vertices); higher-valence vertices fall back to translation along the
// face normal.
export function offsetFace(poly, faceIndex, dist) {
  const out = clonePoly(poly);
  const face = out.faces[faceIndex];
  const n = faceNormal(out, face);
  const d = V.dot(n, out.verts[face.indices[0]]) + dist;

  const normals = out.faces.map((f) => faceNormal(out, f));
  const ds = out.faces.map((f, i) => V.dot(normals[i], out.verts[f.indices[0]]));

  for (const vi of face.indices) {
    // Find the other faces touching this vertex.
    const adj = [];
    out.faces.forEach((f, fi) => {
      if (fi !== faceIndex && f.indices.includes(vi)) adj.push(fi);
    });
    if (adj.length === 2) {
      const p = intersect3Planes(n, d, normals[adj[0]], ds[adj[0]], normals[adj[1]], ds[adj[1]]);
      if (p) { out.verts[vi] = p; continue; }
    }
    out.verts[vi] = V.add(out.verts[vi], V.scale(n, dist));
  }
  return out;
}

function intersect3Planes(n1, d1, n2, d2, n3, d3) {
  const denom = V.dot(n1, V.cross(n2, n3));
  if (Math.abs(denom) < 1e-10) return null;
  const p = V.scale(
    V.add(
      V.add(V.scale(V.cross(n2, n3), d1), V.scale(V.cross(n3, n1), d2)),
      V.scale(V.cross(n1, n2), d3)
    ),
    1 / denom
  );
  return p;
}

// Triangulate (fan) -> { positions: Float32Array, normals, faceIds: Int32Array }
export function triangulate(poly) {
  const positions = [], normals = [], faceIds = [];
  poly.faces.forEach((face, fi) => {
    const n = faceNormal(poly, face);
    const idx = face.indices;
    for (let i = 1; i < idx.length - 1; i++) {
      for (const j of [idx[0], idx[i], idx[i + 1]]) {
        positions.push(...poly.verts[j]);
        normals.push(...n);
      }
      faceIds.push(fi);
    }
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    faceIds: new Int32Array(faceIds),
  };
}

// Ray vs convex polyhedron via successive half-space clipping of the ray
// parameter interval. Returns { t, faceIndex } of the entry hit or null.
export function raycastPoly(poly, origin, dir) {
  let tmin = -Infinity, tmax = Infinity;
  let enterFace = -1;
  for (let fi = 0; fi < poly.faces.length; fi++) {
    const face = poly.faces[fi];
    const n = faceNormal(poly, face);
    const d = V.dot(n, poly.verts[face.indices[0]]);
    const denom = V.dot(n, dir);
    const dist = d - V.dot(n, origin);
    if (Math.abs(denom) < 1e-12) {
      if (dist < -EPS) return null; // parallel and outside
      continue;
    }
    const t = dist / denom;
    if (denom < 0) {
      if (t > tmin) { tmin = t; enterFace = fi; }
    } else {
      if (t < tmax) tmax = t;
    }
    if (tmin > tmax + EPS) return null;
  }
  if (tmax < Math.max(tmin, 0)) return null;
  const t = tmin > 0 ? tmin : tmax;
  return { t, faceIndex: tmin > 0 ? enterFace : -1, tEnter: tmin, tExit: tmax };
}

// Volume of the intersection of two convex polyhedra (0 if disjoint).
// Used to warn about physically impossible interpenetrating pieces.
export function convexIntersectionVolume(a, b) {
  let cur = clonePoly(a);
  for (const f of b.faces) {
    const n = faceNormal(b, f);
    const d = V.dot(n, b.verts[f.indices[0]]);
    const r = clipPoly(cur, n, d);
    if (!r.kept) return 0;
    cur = r.kept;
  }
  return polyVolume(cur);
}

// ---------------------------------------------------------------------------
// 2D convex polygon helpers, used for detecting glued (coincident) faces at
// export time so the renderer sees a single seamless interface.

// Project 3D points on a plane (normal n) to 2D coordinates.
export function projectToPlane(points, n) {
  const [u, w] = orthoBasis(n);
  return points.map((p) => [V.dot(p, u), V.dot(p, w)]);
}

export function planeBasis(n) { return orthoBasis(n); }

// Sutherland-Hodgman: clip convex polygon `subject` (2D, CCW) by convex
// polygon `clip` (2D, CCW). Returns the intersection polygon (possibly []).
export function clipPolygon2D(subject, clip) {
  let output = subject.slice();
  for (let i = 0; i < clip.length; i++) {
    if (output.length === 0) return [];
    const a = clip[i], b = clip[(i + 1) % clip.length];
    // Edge a->b; inside = left of edge for CCW.
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const sp = cross2(a, b, p), sq = cross2(a, b, q);
      if (sp >= -1e-9) output.push(p);
      if ((sp > 1e-9 && sq < -1e-9) || (sp < -1e-9 && sq > 1e-9)) {
        const t = sp / (sp - sq);
        output.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return dedup2D(output);
}

// Subtract convex polygon `clip` from convex polygon `subject`: returns a
// list of convex polygons covering subject \ clip. Standard technique:
// successively clip by each edge of `clip`, keeping the outside parts.
export function subtractPolygon2D(subject, clip) {
  const results = [];
  let remaining = subject.slice();
  for (let i = 0; i < clip.length; i++) {
    if (remaining.length === 0) break;
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const outside = [], inside = [];
    for (let j = 0; j < remaining.length; j++) {
      const p = remaining[j], q = remaining[(j + 1) % remaining.length];
      const sp = cross2(a, b, p), sq = cross2(a, b, q);
      if (sp <= 1e-9) outside.push(p);
      if (sp >= -1e-9) inside.push(p);
      if ((sp > 1e-9 && sq < -1e-9) || (sp < -1e-9 && sq > 1e-9)) {
        const t = sp / (sp - sq);
        const x = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        outside.push(x);
        inside.push(x);
      }
    }
    const out = dedup2D(outside);
    if (out.length >= 3) results.push(out);
    remaining = dedup2D(inside);
  }
  return results;
}

export function polygonArea2D(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function cross2(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function dedup2D(poly) {
  const out = [];
  for (const p of poly) {
    if (out.length === 0 || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 1e-7) {
      out.push(p);
    }
  }
  while (out.length >= 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-7) {
    out.pop();
  }
  return out;
}
