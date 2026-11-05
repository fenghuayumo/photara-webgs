import { t } from './i18n.js';
export const FILTER_MODES = ['classic', 'mip2d', 'mip3d', 'mip'];
export const RENDER_METHODS = ['3dgs', '3dgut'];
export const SH_C0 = 0.28209479177387814;

/** Original world coordinates, activated scales/opacity and scalar-first
 * normalized quaternion. SH defaults to canonical [N, bases, RGB]; packed
 * models explicitly use shLayout:'packed', shDC and an optional shPalette.
 * 3D filtering is applied exactly once at ingestion, even if metadata says classic.
 */
export function activateGaussian(logScales, logit, quaternion, filter = 0) {
  const scales = logScales.map(v => Math.exp(Math.max(-20, Math.min(20, v))));
  let factor = 1;
  for (let a = 0; a < 3; a++) {
    const raw = scales[a];
    scales[a] = Math.hypot(raw, filter);
    factor *= raw / scales[a];
  }
  const norm = Math.hypot(...quaternion);
  if (!(norm > 1e-10)) throw new Error('Gaussian quaternion must have a nonzero norm');
  const e = Math.exp(-Math.abs(logit));
  const opacity = (logit >= 0 ? 1 / (1 + e) : e / (1 + e)) * factor;
  return { scales, opacity, quaternion: quaternion.map(v => v / norm) };
}

export function validateModel(model) {
  const { count, bases, data, renderMethod, filterMode } = model;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Model must contain Gaussians');
  if (![1, 4, 9, 16].includes(bases)) throw new Error('SH degree must be 0–3');
  if (!(data instanceof Float32Array) || data.length !== count * 12) throw new Error('Invalid model buffer sizes');
  validateModelSH(model);
  if (!RENDER_METHODS.includes(renderMethod) || !FILTER_MODES.includes(filterMode)) throw new Error('Unknown render method or filter mode');
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) throw new Error('Non-finite Gaussian attribute');
  for (let i = 0; i < count; i++) {
    const k = i * 12;
    if (data[k + 3] < 0 || data[k + 3] > 1 || data[k + 4] <= 0 || data[k + 5] <= 0 || data[k + 6] <= 0) throw new Error('Invalid activated scale or opacity');
    const n = Math.hypot(...data.subarray(k + 8, k + 12));
    if (Math.abs(n - 1) > 1e-4) throw new Error('Quaternion must be normalized');
  }
  return model;
}

/** Packed models have one authoritative SH representation; never hide a stale
 * canonical array behind it. Canonical palettes remain optional upload hints. */
export function validateModelSH(model) {
  const { count, bases, shLayout, sh, shDC, shPalette } = model;
  if (!Number.isSafeInteger(count) || count < 1 || ![1, 4, 9, 16].includes(bases)) throw new Error('Invalid SH dimensions');
  const finite = data => { for (const v of data) if (!Number.isFinite(v)) throw new Error('Non-finite SH coefficient'); };
  if (shLayout === 'packed') {
    if (sh !== undefined || !(shDC instanceof Float32Array) || shDC.length !== count * 3) throw new Error('Invalid packed SH DC buffer');
    finite(shDC);
    if (bases === 1) {
      if (shPalette !== undefined) throw new Error('Degree-zero packed SH cannot have a palette');
      return;
    }
    const palette = shPalette;
    if (!palette || !Number.isSafeInteger(palette.count) || palette.count < 1 || palette.count > 65536 ||
        !(palette.labels instanceof Uint32Array) || palette.labels.length !== count ||
        !(palette.coefficients instanceof Float32Array) || palette.coefficients.length !== palette.count * (bases - 1) * 3) throw new Error('Invalid packed SH palette buffers');
    for (const label of palette.labels) if (label >= palette.count) throw new Error('Packed SH label exceeds palette');
    finite(palette.coefficients);
  } else {
    if (shLayout !== undefined && shLayout !== 'canonical') throw new Error('Unknown SH layout');
    if (!(sh instanceof Float32Array) || sh.length !== count * bases * 3) throw new Error('Invalid model buffer sizes');
    finite(sh);
  }
}

/** Explicitly materialize editable [N, bases, RGB] SH from a packed model.
 * Attributes and metadata are shared; the expanded SH array is newly allocated.
 */
export function toCanonicalModel(model) {
  validateModel(model);
  if (model.shLayout !== 'packed') return model;
  const { count, bases, shDC, shPalette } = model, sh = new Float32Array(count * bases * 3);
  for (let i = 0; i < count; i++) {
    sh.set(shDC.subarray(i * 3, i * 3 + 3), i * bases * 3);
    if (bases > 1) {
      const rest = (bases - 1) * 3, offset = shPalette.labels[i] * rest;
      sh.set(shPalette.coefficients.subarray(offset, offset + rest), i * bases * 3 + 3);
    }
  }
  const { shDC: ignored, ...canonical } = model;
  return { ...canonical, shLayout: 'canonical', sh };
}

export function modelBounds(data) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.length; i += 12) {
    const radius = 3 * Math.max(data[i + 4], data[i + 5], data[i + 6]);
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], data[i + a] - radius); max[a] = Math.max(max[a], data[i + a] + radius); }
  }
  const center = min.map((v, a) => (v + max[a]) / 2);
  return { min, max, center, radius: Math.max(1e-5, Math.hypot(...max.map((v, a) => v - center[a]))) };
}

/** Deterministic synthetic Gaussians; no downloaded assets or implied reconstruction. */
export function createDemoModel({ renderMethod = '3dgs', filterMode = 'classic', side = 42 } = {}) {
  if (!Number.isInteger(side) || side < 2 || side > 400) throw new Error('Demo side must be 2–400');
  const count = side * side;
  const data = new Float32Array(count * 12), sh = new Float32Array(count * 3);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const i = y * side + x, u = x / (side - 1), v = y / (side - 1);
    const phi = u * Math.PI * 2, theta = (v * .88 + .06) * Math.PI;
    const r = 1 + .16 * Math.sin(phi * 5) * Math.sin(theta * 3);
    data.set([r * Math.sin(theta) * Math.cos(phi), r * Math.cos(theta), r * Math.sin(theta) * Math.sin(phi), .82,
      .035, .065, .022, 0, Math.cos(phi / 2), 0, Math.sin(phi / 2), 0], i * 12);
    const color = [.15 + .7 * u, .4 + .42 * v, .9 - .5 * u];
    sh.set(color.map(c => (c - .5) / SH_C0), i * 3);
  }
  return { count, bases: 1, degree: 0, data, sh, renderMethod, filterMode, bounds: modelBounds(data), name: t('合成 Gaussian 示例'), isDemo: true, hasFilter3D: false };
}
