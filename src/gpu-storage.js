import { validateModelSH, toCanonicalModel } from './model.js';

/** Exact Float32 palette indirection. Canonical model.sh remains authoritative. */
export function prepareSHStorage(model, mode = 'auto', { segmented = false } = {}) {
  if (!['auto', 'float32', 'palette'].includes(mode)) throw new Error('Unknown SH storage mode');
  if (model.shLayout === 'packed') {
    validateModelSH(model);
    if (model.bases === 1) return { data: model.shDC, format: 'float32' };
    if (mode === 'float32') return { data: toCanonicalModel(model).sh, format: 'float32' };
    const { count, shDC, shPalette: { labels, coefficients } } = model;
    // Never expand packed SH implicitly, even when a tiny model's palette is
    // bigger than its canonical array. float32 is an explicit opt-in above.
    if (segmented) return { format: 'palette', byteLength: count * 16 + coefficients.byteLength, segments: [
      { offset: 0, data: shDC }, { offset: count * 12, data: labels }, { offset: count * 16, data: coefficients },
    ] };
    const data = new Float32Array(count * 4 + coefficients.length);
    data.set(shDC); new Uint32Array(data.buffer).set(labels, count * 3); data.set(coefficients, count * 4);
    return { data, format: 'palette' };
  }
  const raw = () => ({ data: model.sh, format: 'float32' });
  if (mode === 'float32' || !model.shPalette || model.bases === 1) return raw();
  const { labels, coefficients, count } = model.shPalette;
  const rest = (model.bases - 1) * 3, size = model.count * 4 + count * rest;
  if (!(labels instanceof Uint32Array) || labels.length !== model.count ||
      !(coefficients instanceof Float32Array) || !Number.isSafeInteger(count) || count < 1 || count > 65536 || coefficients.length !== count * rest) return raw();
  if (mode === 'auto' && size >= model.sh.length) return raw();
  // Detect canonical edits after decoding; never upload a stale palette.
  for (let i = 0; i < model.count; i++) {
    const label = labels[i]; if (label >= count) return raw();
    const source = i * model.bases * 3 + 3, palette = label * rest;
    for (let k = 0; k < rest; k++) if (model.sh[source + k] !== coefficients[palette + k]) return raw();
  }
  const data = new Float32Array(size), words = new Uint32Array(data.buffer);
  for (let i = 0; i < model.count; i++) {
    const source = i * model.bases * 3;
    data[i * 3] = model.sh[source]; data[i * 3 + 1] = model.sh[source + 1]; data[i * 3 + 2] = model.sh[source + 2];
  }
  words.set(labels, model.count * 3); data.set(coefficients, model.count * 4);
  return { data, format: 'palette' };
}
