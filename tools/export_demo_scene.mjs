// Export the demo sculpture as a .render.json file for the native viewer.
// Usage: node tools/export_demo_scene.mjs [out.render.json]

import { writeFileSync } from 'node:fs';
import { Model } from '../js/model.js';
import { buildDemoSculpture } from '../js/demo.js';
import { buildRenderScene } from '../js/export.js';

const out = process.argv[2] || 'demo.render.json';
const model = buildDemoSculpture(new Model());
const scene = buildRenderScene(model);
writeFileSync(out, JSON.stringify(scene));
console.log(`Wrote ${out}: ${scene.triangles.matFront.length} triangles, ` +
  `${scene.materials.length} materials, ${scene.coatings.length} coatings`);
