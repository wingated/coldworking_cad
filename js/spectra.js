// Spectral utilities shared by the materials UI and the path tracer.
//
// Wavelengths are in nanometers, visible range 380-730nm.

export const LAMBDA_MIN = 380;
export const LAMBDA_MAX = 730;

// Fraunhofer lines used for refractive index / Abbe number definitions (nm).
export const LAMBDA_D = 587.56; // helium d-line
export const LAMBDA_F = 486.13; // hydrogen F-line
export const LAMBDA_C = 656.27; // hydrogen C-line

// Cauchy dispersion model n(lambda) = A + B / lambda_um^2, fit from the
// d-line index and Abbe number. Good to ~1e-3 across the visible range,
// plenty for art visualization.
export function cauchyFromAbbe(nd, vd) {
  const um = (nm) => nm / 1000;
  const invF2 = 1 / (um(LAMBDA_F) ** 2);
  const invC2 = 1 / (um(LAMBDA_C) ** 2);
  const B = (nd - 1) / (vd * (invF2 - invC2));
  const A = nd - B / (um(LAMBDA_D) ** 2);
  return { A, B };
}

export function iorAt(cauchy, lambdaNm) {
  const um = lambdaNm / 1000;
  return cauchy.A + cauchy.B / (um * um);
}

// CIE 1931 color matching functions, multi-lobe Gaussian fit
// (Wyman, Sloan & Shirley 2013). Returns [X, Y, Z] for wavelength in nm.
function g(x, mu, s1, s2) {
  const t = (x - mu) * (x < mu ? 1 / s1 : 1 / s2);
  return Math.exp(-0.5 * t * t);
}

export function cieXYZ(l) {
  const x = 1.056 * g(l, 599.8, 37.9, 31.0)
          + 0.362 * g(l, 442.0, 16.0, 26.7)
          - 0.065 * g(l, 501.1, 20.4, 26.2);
  const y = 0.821 * g(l, 568.8, 46.9, 40.5)
          + 0.286 * g(l, 530.9, 16.3, 31.1);
  const z = 1.217 * g(l, 437.0, 11.8, 36.0)
          + 0.681 * g(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}

const XYZ_TO_SRGB = [
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.2040, 1.0570],
];

export function xyzToLinearRGB([x, y, z]) {
  return XYZ_TO_SRGB.map((row) => row[0] * x + row[1] * y + row[2] * z);
}

// Integrate a spectrum function f(lambda)->[0,1] against the CMFs under an
// equal-energy illuminant; returns linear sRGB normalized so a flat
// f(lambda)=1 spectrum maps to [1,1,1]. Used for UI swatches.
export function spectrumToRGB(f, steps = 64) {
  let X = 0, Y = 0, Z = 0, Yn = 0;
  for (let i = 0; i < steps; i++) {
    const l = LAMBDA_MIN + ((i + 0.5) / steps) * (LAMBDA_MAX - LAMBDA_MIN);
    const [cx, cy, cz] = cieXYZ(l);
    const v = f(l);
    X += cx * v; Y += cy * v; Z += cz * v;
    Yn += cy;
  }
  const rgb = xyzToLinearRGB([X / Yn, Y / Yn, Z / Yn]);
  return rgb.map((c) => Math.max(0, c));
}

export function linearToSrgb8(rgb) {
  return rgb.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.min(c, 1), 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  });
}

export function cssColor(rgbLinear) {
  const [r, g2, b] = linearToSrgb8(rgbLinear);
  return `rgb(${r},${g2},${b})`;
}

// Dichroic coating reflectance built from a set of smooth reflection bands:
// R(lambda) = clamp( sum_i strength_i * smoothband(lambda; center, width, edge) ).
// Transmittance is taken as 1 - R (dielectric stacks absorb almost nothing).
export function dichroicReflectance(bands, lambda) {
  let r = 0;
  for (const b of bands) {
    const edge = b.edge ?? 18; // nm transition softness
    const lo = b.center - b.width / 2;
    const hi = b.center + b.width / 2;
    r += (b.strength ?? 0.95) * smoothstep(lo - edge, lo + edge, lambda)
       * (1 - smoothstep(hi - edge, hi + edge, lambda));
  }
  return Math.max(0, Math.min(0.99, r));
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Sample a dichroic's spectra into N bins for GPU upload: returns
// Float32Array of reflectance per bin across [LAMBDA_MIN, LAMBDA_MAX].
export function sampleSpectrum(bands, bins = 32) {
  const out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const l = LAMBDA_MIN + ((i + 0.5) / bins) * (LAMBDA_MAX - LAMBDA_MIN);
    out[i] = dichroicReflectance(bands, l);
  }
  return out;
}
