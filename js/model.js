// Document model: the sculpture is a flat list of solid pieces, each a convex
// polyhedron of some crystal (or a dichroic plate) with a rigid transform.
// All coldworking operations live here; the UI calls these and the viewport
// re-renders on change.

import {
  makeBox, clipPoly, clonePoly, transformPoly, chamferPoly, offsetFace,
  faceNormal, faceCentroid, polyVolume, polyBBox, convexIntersectionVolume,
} from './geometry.js';
import { V, Q, DEG } from './math.js';
import { MaterialLibrary, DICHROIC_THICKNESS } from './materials.js';

const FORMAT_VERSION = 1;

export class Model {
  constructor() {
    this.library = new MaterialLibrary();
    this.pieces = [];
    this.nextId = 1;
    this.revision = 0;
    this.projectName = 'Untitled sculpture';
    this._undo = [];
    this._redo = [];
    this._listeners = new Set();
    this._worldCache = new Map(); // pieceId -> {rev, poly}
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _notify() {
    this.revision++;
    for (const fn of this._listeners) fn();
  }

  // ---- undo/redo (snapshot-based; documents are small) ----
  checkpoint() {
    this._undo.push(this.serialize());
    if (this._undo.length > 100) this._undo.shift();
    this._redo.length = 0;
  }

  undo() {
    if (this._undo.length === 0) return false;
    this._redo.push(this.serialize());
    this._restore(this._undo.pop());
    return true;
  }

  redo() {
    if (this._redo.length === 0) return false;
    this._undo.push(this.serialize());
    this._restore(this._redo.pop());
    return true;
  }

  _restore(json) {
    const keepName = this.projectName;
    this.deserialize(json, { silent: true });
    this.projectName = json.projectName ?? keepName;
    this._worldCache.clear();
    this._notify();
  }

  // ---- queries ----
  getPiece(id) { return this.pieces.find((p) => p.id === id); }

  worldPoly(piece) {
    const cached = this._worldCache.get(piece.id);
    if (cached && cached.rev === piece.rev) return cached.poly;
    const poly = transformPoly(piece.poly, piece.rotation, piece.position);
    this._worldCache.set(piece.id, { rev: piece.rev, poly });
    return poly;
  }

  sceneBBox() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of this.pieces) {
      const bb = polyBBox(this.worldPoly(p));
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], bb.min[i]);
        max[i] = Math.max(max[i], bb.max[i]);
      }
    }
    if (!isFinite(min[0])) return { min: [-1, -1, -1], max: [1, 1, 1] };
    return { min, max };
  }

  // ---- piece creation ----
  _newPiece(props) {
    const piece = {
      id: this.nextId++,
      name: props.name ?? `Piece ${this.nextId - 1}`,
      materialId: props.materialId,
      poly: props.poly,
      rotation: props.rotation ?? Q.identity(),
      position: props.position ?? [0, 0, 0],
      rev: 0,
      visible: true,
    };
    this.pieces.push(piece);
    return piece;
  }

  addBlock(materialId, w, h, d, position = [0, 0, 0]) {
    this.checkpoint();
    const mat = this.library.get(materialId);
    const p = this._newPiece({
      name: `${mat ? mat.name.split(' ')[0] : 'Block'} ${w}×${h}×${d}`,
      materialId,
      poly: makeBox(w, h, d),
      position,
    });
    this._notify();
    return p;
  }

  // Attach a 1/8" dichroic plate flush onto a world-space face of a piece.
  // The coated surface faces the host piece (coatedSide='in') or away ('out').
  addPlateOnFace(pieceId, faceIndex, dichroicId, coatedSide = 'in') {
    const host = this.getPiece(pieceId);
    if (!host) return null;
    this.checkpoint();
    const wp = this.worldPoly(host);
    const face = wp.faces[faceIndex];
    const n = faceNormal(wp, face);
    const c = faceCentroid(wp, face);

    // Build the plate as a prism matching the host face outline, extruded
    // outward by the plate thickness.
    const t = DICHROIC_THICKNESS;
    const pts = face.indices.map((i) => wp.verts[i]);
    const verts = [
      ...pts,                                   // inner ring (against host)
      ...pts.map((p) => V.add(p, V.scale(n, t))), // outer ring
    ];
    const k = pts.length;
    const faces = [];
    // Inner face: outward normal is -n (faces the host). Host face is CCW
    // seen from +n, so reversed it is CCW seen from -n.
    faces.push({ indices: [...Array(k).keys()].reverse(), coating: coatedSide === 'in' ? dichroicId : null });
    // Outer face.
    faces.push({ indices: [...Array(k).keys()].map((i) => i + k), coating: coatedSide === 'out' ? dichroicId : null });
    // Side walls.
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k;
      faces.push({ indices: [i, j, j + k, i + k], coating: null });
    }
    const mat = this.library.get(dichroicId);
    // Store geometry in local coordinates centered at the plate centroid.
    const center = V.add(c, V.scale(n, t / 2));
    const local = { verts: verts.map((v) => V.sub(v, center)), faces };
    const piece = this._newPiece({
      name: `${mat ? mat.name.replace('Dichroic ', '') : 'Dichroic'} plate`,
      materialId: dichroicId,
      poly: local,
      position: center,
    });
    this._notify();
    return piece;
  }

  // ---- cutting ----

  // Slice a piece by a world-space plane dot(n,p)=d. Returns the new piece
  // ids ([] if the plane misses). Both halves remain in place, exactly like
  // a saw cut.
  slicePiece(pieceId, n, d, { checkpoint = true } = {}) {
    const piece = this.getPiece(pieceId);
    if (!piece) return [];
    // World plane -> local: dot(n, R p + t) = d  =>  dot(R^T n, p) = d - dot(n, t)
    const qInv = Q.conjugate(piece.rotation);
    const ln = Q.rotateVec(qInv, n);
    const ld = d - V.dot(n, piece.position);
    const { kept, cut } = clipPoly(piece.poly, ln, ld);
    if (!kept || !cut) return [];
    if (checkpoint) this.checkpoint();
    piece.poly = kept;
    piece.rev++;
    const other = this._newPiece({
      name: piece.name + ' (cut)',
      materialId: piece.materialId,
      poly: cut,
      rotation: piece.rotation.slice(),
      position: piece.position.slice(),
    });
    this._notify();
    return [piece.id, other.id];
  }

  // Slice pieces into `count` equal slabs along a world direction (the
  // "cut the bar into N identical pieces" workflow). Cuts every selected
  // piece with the same set of planes.
  sliceEqual(pieceIds, dir, count) {
    if (count < 2) return;
    this.checkpoint();
    const n = V.norm(dir);
    // Find extent of the selection along n.
    let lo = Infinity, hi = -Infinity;
    for (const id of pieceIds) {
      const piece = this.getPiece(id);
      if (!piece) continue;
      for (const v of this.worldPoly(piece).verts) {
        const s = V.dot(n, v);
        lo = Math.min(lo, s); hi = Math.max(hi, s);
      }
    }
    if (!isFinite(lo)) return;
    let targets = [...pieceIds];
    for (let i = 1; i < count; i++) {
      const d = lo + ((hi - lo) * i) / count;
      const produced = [];
      for (const id of targets) {
        const res = this.slicePiece(id, n, d, { checkpoint: false });
        produced.push(id, ...res.filter((x) => x !== id));
      }
      targets = [...new Set(produced)];
    }
    this._notify();
  }

  // ---- transforms ----
  translatePieces(ids, delta) {
    this.checkpoint();
    for (const id of ids) {
      const p = this.getPiece(id);
      if (!p) continue;
      p.position = V.add(p.position, delta);
      p.rev++;
    }
    this._notify();
  }

  rotatePieces(ids, axis, angleDeg, pivot) {
    this.checkpoint();
    const q = Q.fromAxisAngle(axis, angleDeg * DEG);
    for (const id of ids) {
      const p = this.getPiece(id);
      if (!p) continue;
      p.rotation = Q.normalize(Q.multiply(q, p.rotation));
      p.position = V.add(pivot, Q.rotateVec(q, V.sub(p.position, pivot)));
      p.rev++;
    }
    this._notify();
  }

  // Move piece B so its face mates flush against a face of piece A
  // (normals opposed, face centroids coincident). This is the "glue" step.
  mateFaces(pieceAId, faceA, pieceBId, faceB) {
    const a = this.getPiece(pieceAId), b = this.getPiece(pieceBId);
    if (!a || !b || a === b) return false;
    this.checkpoint();
    const wpA = this.worldPoly(a), wpB = this.worldPoly(b);
    const nA = faceNormal(wpA, wpA.faces[faceA]);
    const nB = faceNormal(wpB, wpB.faces[faceB]);
    const q = Q.fromTo(nB, V.neg(nA));
    b.rotation = Q.normalize(Q.multiply(q, b.rotation));
    b.rev++;
    // Recompute face centroid after rotation, then translate into contact.
    const wpB2 = this.worldPoly(b);
    const cA = faceCentroid(wpA, wpA.faces[faceA]);
    const cB = faceCentroid(wpB2, wpB2.faces[faceB]);
    b.position = V.add(b.position, V.sub(cA, cB));
    b.rev++;
    this._notify();
    return true;
  }

  // ---- replication ----
  duplicatePieces(ids, offset = [0, 0, 0]) {
    this.checkpoint();
    const created = [];
    for (const id of ids) {
      const p = this.getPiece(id);
      if (!p) continue;
      created.push(this._newPiece({
        name: p.name + ' copy',
        materialId: p.materialId,
        poly: clonePoly(p.poly),
        rotation: p.rotation.slice(),
        position: V.add(p.position, offset),
      }).id);
    }
    this._notify();
    return created;
  }

  // Linear array: `count` total copies stepped by `step` (world vector).
  arrayLinear(ids, count, step) {
    this.checkpoint();
    const created = [];
    for (let i = 1; i < count; i++) {
      const offset = V.scale(step, i);
      for (const id of ids) {
        const p = this.getPiece(id);
        if (!p) continue;
        created.push(this._newPiece({
          name: `${p.name} [${i}]`,
          materialId: p.materialId,
          poly: clonePoly(p.poly),
          rotation: p.rotation.slice(),
          position: V.add(p.position, offset),
        }).id);
      }
    }
    this._notify();
    return created;
  }

  // Rotational array about an axis through `pivot` (e.g. the radial cores in
  // a Storms-style sculpture).
  arrayRotational(ids, count, axis, pivot, totalAngleDeg = 360) {
    this.checkpoint();
    const created = [];
    const stepAngle = (totalAngleDeg === 360 ? 360 / count : totalAngleDeg / (count - 1)) * DEG;
    for (let i = 1; i < count; i++) {
      const q = Q.fromAxisAngle(axis, stepAngle * i);
      for (const id of ids) {
        const p = this.getPiece(id);
        if (!p) continue;
        created.push(this._newPiece({
          name: `${p.name} [r${i}]`,
          materialId: p.materialId,
          poly: clonePoly(p.poly),
          rotation: Q.normalize(Q.multiply(q, p.rotation)),
          position: V.add(pivot, Q.rotateVec(q, V.sub(p.position, pivot))),
        }).id);
      }
    }
    this._notify();
    return created;
  }

  // ---- finishing ----
  chamferPieces(ids, dist) {
    this.checkpoint();
    for (const id of ids) {
      const p = this.getPiece(id);
      if (!p) continue;
      p.poly = chamferPoly(p.poly, dist);
      p.rev++;
    }
    this._notify();
  }

  extrudeFace(pieceId, faceIndex, dist) {
    const p = this.getPiece(pieceId);
    if (!p) return;
    this.checkpoint();
    p.poly = offsetFace(p.poly, faceIndex, dist);
    p.rev++;
    this._notify();
  }

  deletePieces(ids) {
    this.checkpoint();
    const set = new Set(ids);
    this.pieces = this.pieces.filter((p) => !set.has(p.id));
    this._notify();
  }

  setPieceMaterial(ids, materialId) {
    this.checkpoint();
    for (const id of ids) {
      const p = this.getPiece(id);
      if (p) { p.materialId = materialId; p.rev++; }
    }
    this._notify();
  }

  renamePiece(id, name) {
    const p = this.getPiece(id);
    if (p) { p.name = name; this._notify(); }
  }

  setVisibility(ids, visible) {
    for (const id of ids) {
      const p = this.getPiece(id);
      if (p) p.visible = visible;
    }
    this._notify();
  }

  // Pairs of visible pieces whose solids interpenetrate (more than a glue
  // tolerance) — physically impossible in coldworked glass, and ambiguous
  // for the renderer. Returns [{a, b, volume}].
  findOverlaps(tolerance = 1e-4) {
    const out = [];
    const pieces = this.pieces.filter((p) => p.visible);
    for (let i = 0; i < pieces.length; i++) {
      const wa = this.worldPoly(pieces[i]);
      const ba = polyBBox(wa);
      for (let j = i + 1; j < pieces.length; j++) {
        const wb = this.worldPoly(pieces[j]);
        const bb = polyBBox(wb);
        if (ba.min[0] > bb.max[0] + tolerance || bb.min[0] > ba.max[0] + tolerance ||
            ba.min[1] > bb.max[1] + tolerance || bb.min[1] > ba.max[1] + tolerance ||
            ba.min[2] > bb.max[2] + tolerance || bb.min[2] > ba.max[2] + tolerance) continue;
        const vol = convexIntersectionVolume(wa, wb);
        if (vol > tolerance) out.push({ a: pieces[i].id, b: pieces[j].id, volume: vol });
      }
    }
    return out;
  }

  pieceInfo(id) {
    const p = this.getPiece(id);
    if (!p) return null;
    const wp = this.worldPoly(p);
    const bb = polyBBox(wp);
    return {
      name: p.name,
      material: this.library.get(p.materialId),
      volume: polyVolume(p.poly),
      dims: V.sub(bb.max, bb.min),
      faces: p.poly.faces.length,
      verts: p.poly.verts.length,
    };
  }

  // ---- serialization ----
  serialize() {
    return {
      format: 'coldworking-cad', version: FORMAT_VERSION,
      projectName: this.projectName,
      units: 'in',
      nextId: this.nextId,
      userMaterials: this.library.serializeUser(),
      pieces: this.pieces.map((p) => ({
        id: p.id, name: p.name, materialId: p.materialId,
        rotation: p.rotation.slice(), position: p.position.slice(),
        visible: p.visible,
        poly: {
          verts: p.poly.verts.map((v) => v.slice()),
          faces: p.poly.faces.map((f) => ({ indices: f.indices.slice(), coating: f.coating })),
        },
      })),
    };
  }

  deserialize(json, { silent = false } = {}) {
    if (json.format !== 'coldworking-cad') throw new Error('Not a coldworking-cad file');
    this.projectName = json.projectName ?? 'Untitled sculpture';
    this.nextId = json.nextId ?? 1;
    this.library = new MaterialLibrary();
    this.library.loadUser(json.userMaterials);
    this.pieces = (json.pieces ?? []).map((p) => ({
      id: p.id, name: p.name, materialId: p.materialId,
      rotation: p.rotation, position: p.position,
      visible: p.visible !== false,
      rev: 0,
      poly: p.poly,
    }));
    for (const p of this.pieces) this.nextId = Math.max(this.nextId, p.id + 1);
    this._worldCache.clear();
    if (!silent) {
      this._undo.length = 0;
      this._redo.length = 0;
      this._notify();
    }
  }
}
