/** Exact Float32 palette indirection. Canonical model.sh remains authoritative. */
export function prepareSHStorage(model, mode = 'auto') {
  if (!['auto', 'float32', 'palette'].includes(mode)) throw new Error('Unknown SH storage mode');
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
