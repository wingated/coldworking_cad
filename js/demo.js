// Demo sculpture: a laminated dichroic core study, used by the "Demo"
// toolbar button and by the CPU reference renderer.

import { V } from './math.js';

export function buildDemoSculpture(model) {
  model.deserialize({
    format: 'coldworking-cad', version: 1,
    projectName: 'Demo: dichroic core study', pieces: [],
  });

  // Laminate: BK7 slab | cyan/red dichroic | BK7 slab | blue/gold | F2 slab.
  const a = model.addBlock('crystal_bk7', 0.75, 1.5, 1.5, [-0.4375, 0.75, 0]);
  const plate = model.addPlateOnFace(a.id, 1, 'dichro_cyan_red', 'in'); // +x face
  const b = model.addBlock('crystal_bk7', 0.75, 1.5, 1.5, [3, 0.75, 0]);
  model.mateFaces(plate.id, 1, b.id, 0); // glue b onto the plate's outer face

  const plate2 = model.addPlateOnFace(b.id, 1, 'dichro_blue_gold', 'in');
  const c = model.addBlock('crystal_f2', 0.5, 1.5, 1.5, [3, 0.75, 0]);
  model.mateFaces(plate2.id, 1, c.id, 0);

  // One angled saw cut across the whole laminate; both halves stay in place
  // (the joint becomes invisible where materials match).
  model.checkpoint();
  for (const id of model.pieces.map((p) => p.id)) {
    model.slicePiece(id, V.norm([0.25, 1, 0.18]), 1.18, { checkpoint: false });
  }

  // Accent: dense flint cube rotated on two axes.
  const d = model.addBlock('crystal_sf11', 0.8, 0.8, 0.8, [0.4, 0.57, 1.9]);
  model.rotatePieces([d.id], [0, 1, 0], 45, d.position);
  model.rotatePieces([d.id], [1, 0, 0], 35, d.position);

  // Final light bevel on the crystal slabs (not the thin plates).
  model.chamferPieces(
    model.pieces.filter((p) => !p.name.includes('plate')).map((p) => p.id), 0.04);

  return model;
}
