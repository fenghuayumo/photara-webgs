import { activateGaussian, FILTER_MODES, RENDER_METHODS, modelBounds } from './model.js';

const TYPES = {
  char: [1, 'getInt8'], int8: [1, 'getInt8'], uchar: [1, 'getUint8'], uint8: [1, 'getUint8'],
  short: [2, 'getInt16'], int16: [2, 'getInt16'], ushort: [2, 'getUint16'], uint16: [2, 'getUint16'],
  int: [4, 'getInt32'], int32: [4, 'getInt32'], uint: [4, 'getUint32'], uint32: [4, 'getUint32'],
  float: [4, 'getFloat32'], float32: [4, 'getFloat32'], double: [8, 'getFloat64'], float64: [8, 'getFloat64'],
};
export const DEFAULT_MAX_SPLATS = 4_000_000;

export function parsePly(buffer, { maxSplats = DEFAULT_MAX_SPLATS, name = 'Photara PLY' } = {}) {
  if (!(buffer instanceof ArrayBuffer)) throw new TypeError('Expected ArrayBuffer');
  const bytes = new Uint8Array(buffer);
  const headerLimit = Math.min(bytes.length, 1024 * 1024);
  let end = -1, header;
  for (let i = 0; i < headerLimit; i++) {
    if (bytes[i] !== 10) continue;
    let start = i - 1;
    while (start >= 0 && bytes[start] !== 10) start--;
    const line = new TextDecoder().decode(bytes.subarray(start + 1, i)).trim();
    if (line === 'end_header') { end = i + 1; header = new TextDecoder().decode(bytes.subarray(0, end)); break; }
  }
  if (end < 0) throw new Error('Missing PLY header (maximum 1 MiB)');
  const lines = header.split(/\r?\n/);
  if (lines[0].trim() !== 'ply') throw new Error('Not a PLY file');
  let format, count = 0, stride = 0, element, sawVertex = false;
  let renderMethod = '3dgs', filterMode = 'classic';
  const properties = [], names = new Set();
  for (const line of lines.slice(1)) {
    const words = line.trim().split(/\s+/), [key, a, b] = words;
    if (key === 'format') {
      if (b !== '1.0' || !['ascii', 'binary_little_endian', 'binary_big_endian'].includes(a)) throw new Error('Unsupported PLY format');
      format = a;
    }
    if (key === 'comment' && a === 'photara_render_method') renderMethod = b;
    if (key === 'comment' && a === 'photara_filter_mode') filterMode = b;
    if (key === 'element') {
      const n = Number(b);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid PLY element count');
      if (!sawVertex && a !== 'vertex' && n > 0) throw new Error('Vertex must be the first nonempty PLY element');
      element = a;
      if (a === 'vertex') {
        if (sawVertex) throw new Error('Duplicate vertex element');
        sawVertex = true; count = n;
      }
    }
    if (key === 'property' && element === 'vertex') {
      if (a === 'list') throw new Error('List properties in Gaussian vertices are unsupported');
      if (!TYPES[a] || !b || names.has(b)) throw new Error('Invalid or duplicate PLY property');
      names.add(b); properties.push({ name: b, type: a, offset: stride }); stride += TYPES[a][0];
    }
  }
  if (!format || count < 1 || count > maxSplats) throw new Error(`PLY Gaussian count must be 1–${maxSplats.toLocaleString()}`);
  if (!RENDER_METHODS.includes(renderMethod)) throw new Error(`Unsupported render method: ${renderMethod}`);
  if (!FILTER_MODES.includes(filterMode)) throw new Error(`Unsupported filter mode: ${filterMode}`);
  const required = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
  for (const key of required) if (!names.has(key)) throw new Error(`Missing Gaussian property: ${key}`);
  const rest = properties.filter(p => /^f_rest_\d+$/.test(p.name)).length;
  const bases = 1 + rest / 3;
  if (![1, 4, 9, 16].includes(bases)) throw new Error('Unsupported or incomplete SH coefficients (degree 0–3 required)');
  for (let i = 0; i < rest; i++) if (!names.has(`f_rest_${i}`)) throw new Error('Non-contiguous SH properties');
  if (format !== 'ascii' && end + count * stride > bytes.length) throw new Error('Truncated PLY vertex data');
  const data = new Float32Array(count * 12), sh = new Float32Array(count * bases * 3);
  const view = new DataView(buffer), little = format === 'binary_little_endian';
  const propIndex = Object.fromEntries(properties.map((p, i) => [p.name, i]));
  let cursor = end;
  // Streaming token cursor avoids allocating millions of ASCII token strings at once.
  const readAscii = () => {
    while (cursor < bytes.length && bytes[cursor] <= 32) cursor++;
    const start = cursor;
    while (cursor < bytes.length && bytes[cursor] > 32) cursor++;
    if (start === cursor) throw new Error('Truncated ASCII PLY');
    return Number(new TextDecoder().decode(bytes.subarray(start, cursor)));
  };
  const row = new Float64Array(properties.length);
  const get = key => row[propIndex[key]];
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < properties.length; j++) {
      const p = properties[j];
      row[j] = format === 'ascii' ? readAscii() : view[TYPES[p.type][1]](end + i * stride + p.offset, little);
      if (!Number.isFinite(row[j])) throw new Error(`Non-finite PLY attribute at Gaussian ${i}`);
    }
    const filter = names.has('filter_3D') ? get('filter_3D') : 0;
    if (filter < 0) throw new Error('filter_3D must be nonnegative');
    const a = activateGaussian([get('scale_0'), get('scale_1'), get('scale_2')], get('opacity'), [0, 1, 2, 3].map(k => get(`rot_${k}`)), filter);
    data.set([get('x'), get('y'), get('z'), a.opacity, ...a.scales, 0, ...a.quaternion], i * 12);
    for (let c = 0; c < 3; c++) {
      sh[(i * bases) * 3 + c] = get(`f_dc_${c}`);
      for (let b = 1; b < bases; b++) sh[(i * bases + b) * 3 + c] = get(`f_rest_${c * (bases - 1) + b - 1}`);
    }
    // Float32 conversion can overflow even when the source float64 was finite.
    for (let k = i * 12; k < (i + 1) * 12; k++) if (!Number.isFinite(data[k])) throw new Error('PLY attribute exceeds Float32 range');
    for (let k = i * bases * 3; k < (i + 1) * bases * 3; k++) if (!Number.isFinite(sh[k])) throw new Error('PLY SH exceeds Float32 range');
  }
  return { count, bases, degree: Math.sqrt(bases) - 1, data, sh, renderMethod, filterMode, hasFilter3D: names.has('filter_3D'), bounds: modelBounds(data), name };
}
