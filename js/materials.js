// Materials library: optical crystal blocks and dichroic coated plates.
//
// Crystal materials carry a d-line refractive index and Abbe number
// (dispersion); the renderer derives wavelength-dependent IOR from these.
// Dichroic materials are dielectric thin-film stacks on a clear substrate:
// described by reflection bands -> reflectance spectrum R(lambda), with
// T(lambda) = 1 - R(lambda).
//
// The library ships with real-world presets and supports user-defined
// materials, stored with the project.

import { cauchyFromAbbe, dichroicReflectance, spectrumToRGB, cssColor } from './spectra.js';

export const CRYSTAL_PRESETS = [
  {
    id: 'crystal_bk7', kind: 'crystal', name: 'Optical crystal (N-BK7 / K9)',
    nd: 1.5168, abbe: 64.17,
    // Absorption per inch, linear RGB (very slight, BK7 is water-clear).
    tint: [0.004, 0.004, 0.006],
    notes: 'Schott N-BK7 / Chinese K9. The standard water-clear optical crystal used for awards and sculpture blanks.',
  },
  {
    id: 'crystal_fused_silica', kind: 'crystal', name: 'Fused silica (quartz glass)',
    nd: 1.4585, abbe: 67.8,
    tint: [0.002, 0.002, 0.003],
    notes: 'Very low index and dispersion; extremely clear, harder to coldwork.',
  },
  {
    id: 'crystal_lead', kind: 'crystal', name: 'Lead crystal (24% PbO)',
    nd: 1.545, abbe: 45,
    tint: [0.005, 0.005, 0.008],
    notes: 'Classic full lead crystal; noticeably more fire than BK7.',
  },
  {
    id: 'crystal_f2', kind: 'crystal', name: 'Flint glass (Schott F2)',
    nd: 1.620, abbe: 36.37,
    tint: [0.006, 0.006, 0.009],
    notes: 'Dense flint: strong dispersion, lots of rainbow fire.',
  },
  {
    id: 'crystal_sf11', kind: 'crystal', name: 'Dense flint (N-SF11)',
    nd: 1.7847, abbe: 25.68,
    tint: [0.008, 0.008, 0.012],
    notes: 'Very high index and dispersion; brilliant, near-gemstone fire.',
  },
  {
    id: 'crystal_sf66', kind: 'crystal', name: 'Extra-dense flint (SF66)',
    nd: 1.9229, abbe: 20.88,
    tint: [0.010, 0.010, 0.016],
    notes: 'About the highest-dispersion optical glass made; diamond-like.',
  },
];

// Dichroic presets follow the Coatings By Sandberg (CBS) naming convention:
// "Reflect/Transmit". Band parameters are tuned so reflected and transmitted
// colors match the named pair; real coatings are similarly steep-edged and
// nearly absorption-free. Substrate is thin clear glass (borosilicate-ish).
export const DICHROIC_PRESETS = [
  {
    id: 'dichro_blue_gold', kind: 'dichroic', name: 'Dichroic Blue/Gold',
    substrateNd: 1.473, substrateAbbe: 65,
    bands: [{ center: 455, width: 110, strength: 0.96, edge: 22 }],
    notes: 'Reflects deep blue, transmits warm gold/amber. CBS-style Blue/Gold.',
  },
  {
    id: 'dichro_cyan_red', kind: 'dichroic', name: 'Dichroic Cyan/Red',
    substrateNd: 1.473, substrateAbbe: 65,
    bands: [{ center: 490, width: 150, strength: 0.96, edge: 20 }],
    notes: 'Reflects cyan, transmits red. One of the most popular CBS colors.',
  },
  {
    id: 'dichro_magenta_green', kind: 'dichroic', name: 'Dichroic Magenta/Green',
    substrateNd: 1.473, substrateAbbe: 65,
    bands: [
      { center: 420, width: 90, strength: 0.95, edge: 18 },
      { center: 660, width: 120, strength: 0.95, edge: 18 },
    ],
    notes: 'Reflects magenta (blue+red), transmits green.',
  },
  {
    id: 'dichro_yellow_blue', kind: 'dichroic', name: 'Dichroic Yellow/Blue',
    substrateNd: 1.473, substrateAbbe: 65,
    bands: [{ center: 595, width: 180, strength: 0.96, edge: 22 }],
    notes: 'Reflects yellow/gold, transmits blue.',
  },
  {
    id: 'dichro_red_cyan', kind: 'dichroic', name: 'Dichroic Red/Cyan',
    substrateNd: 1.473, substrateAbbe: 65,
    bands: [{ center: 650, width: 140, strength: 0.96, edge: 20 }],
    notes: 'Reflects red, transmits cyan/teal.',
  },
  {
    id: 'dichro_green_magenta', kind: 'dichroic', name: 'Dichroic Green/Magenta',
    substrateNd: 1.473, substrateAbbe: 65,
    bands: [{ center: 540, width: 110, strength: 0.95, edge: 18 }],
    notes: 'Reflects green, transmits magenta/pink.',
  },
  {
    id: 'dichro_uv_pink', kind: 'dichroic', name: 'Dichroic Violet/Lime',
    substrateNd: 1.473, substrateAbbe: 65,
    bands: [{ center: 405, width: 80, strength: 0.94, edge: 16 },
            { center: 700, width: 70, strength: 0.7, edge: 20 }],
    notes: 'Reflects violet with a red kick, transmits lime green.',
  },
];

export const DICHROIC_THICKNESS = 0.125; // standard 1/8" plate, inches

let userCounter = 0;

export class MaterialLibrary {
  constructor() {
    this.materials = new Map();
    for (const m of [...CRYSTAL_PRESETS, ...DICHROIC_PRESETS]) {
      this.materials.set(m.id, { ...m, preset: true });
    }
  }

  get(id) { return this.materials.get(id); }
  all() { return [...this.materials.values()]; }
  crystals() { return this.all().filter((m) => m.kind === 'crystal'); }
  dichroics() { return this.all().filter((m) => m.kind === 'dichroic'); }

  addCrystal({ name, nd, abbe, tint }) {
    const id = `user_crystal_${Date.now()}_${userCounter++}`;
    const m = { id, kind: 'crystal', name, nd, abbe, tint: tint ?? [0.004, 0.004, 0.006], preset: false, notes: 'User material' };
    this.materials.set(id, m);
    return m;
  }

  addDichroic({ name, bands }) {
    const id = `user_dichro_${Date.now()}_${userCounter++}`;
    const m = {
      id, kind: 'dichroic', name, bands,
      substrateNd: 1.473, substrateAbbe: 65, preset: false, notes: 'User material',
    };
    this.materials.set(id, m);
    return m;
  }

  remove(id) {
    const m = this.materials.get(id);
    if (m && !m.preset) this.materials.delete(id);
  }

  // Persist only user materials; presets are rebuilt from code.
  serializeUser() {
    return this.all().filter((m) => !m.preset);
  }

  loadUser(list) {
    for (const m of list ?? []) this.materials.set(m.id, { ...m, preset: false });
  }
}

export function materialCauchy(mat) {
  if (mat.kind === 'crystal') return cauchyFromAbbe(mat.nd, mat.abbe);
  return cauchyFromAbbe(mat.substrateNd ?? 1.473, mat.substrateAbbe ?? 65);
}

// UI swatch colors.
export function materialSwatch(mat) {
  if (mat.kind === 'crystal') {
    // Higher index -> render swatch slightly brighter/cooler to differentiate.
    const t = Math.min(1, (mat.nd - 1.45) / 0.5);
    return cssColor([0.75 - 0.15 * t, 0.85, 0.9 + 0.08 * t]);
  }
  const rgb = spectrumToRGB((l) => dichroicReflectance(mat.bands, l));
  return cssColor(rgb);
}

export function dichroicTransmitSwatch(mat) {
  const rgb = spectrumToRGB((l) => 1 - dichroicReflectance(mat.bands, l));
  return cssColor(rgb);
}
