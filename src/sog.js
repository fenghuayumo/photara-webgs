import { modelBounds, validateModel } from './model.js';
import { DEFAULT_MAX_SPLATS } from './ply.js';

// Same RUB -> RDF basis conversion as Studio's format_coordinates.hpp.
const SH_SIGNS = [-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1];
const MAX_BYTES = 1024 * 1024 * 1024;
const safeName = name => typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.startsWith('/') && !name.includes(':') && !name.split('/').some(p => p === '..' || p === '.');
const fail = message => { throw new Error(`SOG: ${message}`); };
export const isSog = buffer => { const b = new Uint8Array(buffer); return b[0] === 80 && b[1] === 75 || new TextDecoder().decode(b.subarray(0, 256)).replace(/^\uFEFF/, '').trimStart().startsWith('{'); };

/** Read standard single-disk ZIP central directory; no encryption or ZIP64. */
export async function readSogArchive(buffer, { maxBytes = MAX_BYTES } = {}) {
  if (!(buffer instanceof ArrayBuffer)) fail('Expected ArrayBuffer');
  const b = new Uint8Array(buffer), v = new DataView(buffer);
  if (b.length > maxBytes) fail('Archive exceeds size limit');
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50 && i + 22 + v.getUint16(i + 20, true) === b.length) { end = i; break; }
  }
  if (end < 0) fail('Missing ZIP directory');
  if (v.getUint16(end + 4, true) || v.getUint16(end + 6, true) || v.getUint16(end + 8, true) !== v.getUint16(end + 10, true)) fail('Multi-disk ZIP is unsupported');
  const count = v.getUint16(end + 10, true), size = v.getUint32(end + 12, true), start = v.getUint32(end + 16, true);
  if (count === 65535 || start === 0xffffffff || size === 0xffffffff) fail('ZIP64 is unsupported');
  if (start + size > end || count > 1024) fail('Invalid ZIP directory');
  const entries = new Map(); let cursor = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > start + size || v.getUint32(cursor, true) !== 0x02014b50) fail('Invalid ZIP entry');
    const flags = v.getUint16(cursor + 8, true), method = v.getUint16(cursor + 10, true), crc = v.getUint32(cursor + 16, true);
    const compressed = v.getUint32(cursor + 20, true), length = v.getUint32(cursor + 24, true), n = v.getUint16(cursor + 28, true), extra = v.getUint16(cursor + 30, true), comment = v.getUint16(cursor + 32, true), local = v.getUint32(cursor + 42, true);
    if (cursor + 46 + n + extra + comment > start + size) fail('Truncated ZIP entry');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(cursor + 46, cursor + 46 + n));
    cursor += 46 + n + extra + comment;
    if (name.endsWith('/')) continue;
    if (!safeName(name) || entries.has(name)) fail('Unsafe or duplicate ZIP filename');
    if (flags & 1 || ![0, 8].includes(method)) fail('Encrypted or unsupported ZIP compression');
    total += length; if (total > maxBytes) fail('Unpacked data exceeds size limit');
    if (local + 30 > start || v.getUint32(local, true) !== 0x04034b50) fail('Invalid local ZIP header');
    const offset = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (offset + compressed > start) fail('Truncated ZIP data');
    entries.set(name, { offset, compressed, length, method, crc });
  }
  return async name => {
    const e = entries.get(name); if (!e) fail(`Missing file: ${name}`);
    let data = b.subarray(e.offset, e.offset + e.compressed);
    if (e.method === 8) {
      let stream; try { stream = new DecompressionStream('deflate-raw'); } catch { fail('This browser cannot decode deflated ZIP; use a stored SOG archive'); }
      const reader = new Blob([data]).stream().pipeThrough(stream).getReader(), output = new Uint8Array(e.length); let offset = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; if (offset + value.length > output.length) fail('ZIP size mismatch'); output.set(value, offset); offset += value.length; } }
      finally { await reader.cancel().catch(() => {}); }
      if (offset !== output.length) fail('Truncated ZIP output'); data = output;
    }
    if (data.length !== e.length) fail('ZIP size mismatch');
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    if (((crc ^ 0xffffffff) >>> 0) !== e.crc) fail(`CRC mismatch: ${name}`);
    return data;
  };
}

/** Decode without Canvas2D alpha premultiplication or color conversion. */
export async function decodeSogImage(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'none' });
  let gl;
  try {
    if (bitmap.width * bitmap.height > 64 * 1024 * 1024) fail('Image exceeds pixel limit');
    gl = new OffscreenCanvas(1, 1).getContext('webgl2', { premultipliedAlpha: false, antialias: false });
    if (!gl) fail('Raw image decoding requires WebGL2');
    if (Math.max(bitmap.width, bitmap.height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) fail('Image exceeds texture size limit');
    const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) fail('Image framebuffer is incomplete');
    const data = new Uint8Array(bitmap.width * bitmap.height * 4);
    gl.readPixels(0, 0, bitmap.width, bitmap.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    if (gl.getError() !== gl.NO_ERROR) fail('Image pixel decoding failed');
    return { width: bitmap.width, height: bitmap.height, data };
  } finally { bitmap.close(); gl?.getExtension('WEBGL_lose_context')?.loseContext(); }
}

function checkMeta(m, maxSplats) {
  if (m?.version !== 2) fail(`Unsupported version: ${m?.version}; expected SOG v2`);
  if (m.model === '2dgs') fail('2DGS models require a different renderer');
  if (m.model && m.model !== 'antialiased') fail(`Unsupported model: ${m.model}`);
  if (!Number.isSafeInteger(m.count) || m.count < 1 || m.count > maxSplats) fail('Invalid Gaussian count');
  for (const [key, n] of [['means', 2], ['scales', 1], ['quats', 1], ['sh0', 1], ...(m.shN ? [['shN', 2]] : [])]) {
    if (!Array.isArray(m[key]?.files) || m[key].files.length !== n || !m[key].files.every(safeName)) fail(`Invalid ${key} files`);
  }
  for (const key of ['scales', 'sh0', ...(m.shN ? ['shN'] : [])]) if (!Array.isArray(m[key].codebook) || m[key].codebook.length !== 256 || !m[key].codebook.every(Number.isFinite)) fail(`Invalid ${key} codebook`);
  for (const key of ['mins', 'maxs']) if (!Array.isArray(m.means[key]) || m.means[key].length !== 3 || !m.means[key].every(Number.isFinite)) fail('Invalid position ranges');
  if (m.means.mins.some((v, i) => v > m.means.maxs[i])) fail('Reversed position range');
  if (m.shN && (![1, 2, 3].includes(m.shN.bands) || !Number.isInteger(m.shN.count) || m.shN.count < 1 || m.shN.count > 65536)) fail('Invalid SH palette');
}

/** Pure numeric decode, also used by independent fixture tests. Converts SOG RUB coordinates to Photara RDF, including rotation and SH. */
export function decodeSogPlanes(meta, planes, { maxSplats = DEFAULT_MAX_SPLATS, name = 'SOG model', shLayout = 'canonical', profile = false } = {}) {
  if (!['canonical', 'packed'].includes(shLayout)) fail('Unknown SH layout');
  const start = performance.now();
  checkMeta(meta, maxSplats);
  const [low, high] = meta.means.files.map(f => planes[f]), scale = planes[meta.scales.files[0]], quat = planes[meta.quats.files[0]], dc = planes[meta.sh0.files[0]];
  const image = p => p && Number.isInteger(p.width) && Number.isInteger(p.height) && p.width > 0 && p.height > 0 && p.data instanceof Uint8Array && p.data.length === p.width * p.height * 4;
  if (!image(low) || low.width * low.height < meta.count) fail('Invalid position image');
  const rest = meta.shN ? [3, 8, 15][meta.shN.bands - 1] : 0, bases = rest + 1;
  const palette = meta.shN && planes[meta.shN.files[0]], labels = meta.shN && planes[meta.shN.files[1]];
  for (const p of [high, scale, quat, dc, ...(labels ? [labels] : [])]) if (!image(p) || p.width !== low.width || p.height !== low.height) fail('Mismatched property image dimensions');
  if (meta.shN && (!image(labels) || !image(palette) || palette.width !== 64 * rest || palette.height < Math.ceil(meta.shN.count / 64))) fail('Invalid SH palette images');
  const packed = shLayout === 'packed';
  const data = new Float32Array(meta.count * 12), sh = new Float32Array(meta.count * (packed ? 1 : bases) * 3);
  let shPalette;
  if (rest) {
    const coefficients = new Float32Array(meta.shN.count * rest * 3), indices = new Uint32Array(meta.count);
    for (let entry = 0; entry < meta.shN.count; entry++) for (let b = 0; b < rest; b++) {
      const pixel = (Math.floor(entry / 64) * palette.width + entry % 64 * rest + b) * 4;
      for (let c = 0; c < 3; c++) coefficients[(entry * rest + b) * 3 + c] = meta.shN.codebook[palette.data[pixel + c]] * SH_SIGNS[b];
    }
    shPalette = { count: meta.shN.count, labels: indices, coefficients };
  }
  for (let i = 0; i < meta.count; i++) {
    const k = i * 4, d = i * 12;
    for (let c = 0; c < 3; c++) {
      const q = low.data[k + c] + high.data[k + c] * 256, n = meta.means.mins[c] + (meta.means.maxs[c] - meta.means.mins[c]) * q / 65535;
      data[d + c] = (c === 0 ? 1 : -1) * Math.sign(n) * Math.expm1(Math.abs(n));
      data[d + 4 + c] = Math.exp(meta.scales.codebook[scale.data[k + c]]);
      sh[i * (packed ? 1 : bases) * 3 + c] = meta.sh0.codebook[dc.data[k + c]];
    }
    data[d + 3] = dc.data[k + 3] / 255;
    const mode = quat.data[k + 3] - 252; if (mode < 0 || mode > 3) fail('Invalid quaternion mode');
    const a = [0, 1, 2].map(c => (quat.data[k + c] / 255 - .5) * Math.SQRT2);
    const omitted = Math.sqrt(Math.max(0, 1 - a.reduce((s, v) => s + v * v, 0)));
    const q = [...a]; q.splice(mode, 0, omitted); const length = Math.hypot(...q);
    for (let c = 0; c < 4; c++) data[d + 8 + c] = q[c] / length * (c < 2 ? 1 : -1);
    if (rest) {
      const label = labels.data[k] + labels.data[k + 1] * 256; if (label >= meta.shN.count) fail('SH label exceeds palette');
      shPalette.labels[i] = label;
      if (!packed) sh.set(shPalette.coefficients.subarray(label * rest * 3, (label + 1) * rest * 3), (i * bases + 1) * 3);
    }
  }
  const model = { count: meta.count, bases, degree: meta.shN?.bands || 0, data, ...(packed ? { shLayout, shDC: sh } : { sh }), renderMethod: '3dgs', filterMode: meta.model === 'antialiased' ? 'mip2d' : 'classic', hasFilter3D: false, name, sourceFormat: 'sog' };
  if (shPalette) model.shPalette = shPalette;
  const decoded = performance.now();
  validateModel(model); model.bounds = modelBounds(data);
  if (profile) model.loadStats = { numeric_ms: decoded - start, validation_bounds_ms: performance.now() - decoded };
  return model;
}

export async function parseSog(buffer, { baseUrl, decodeImage = decodeSogImage, maxBytes = MAX_BYTES, ...options } = {}) {
  const start = performance.now();
  if (options.shLayout !== undefined && !['canonical', 'packed'].includes(options.shLayout)) fail('Unknown SH layout');
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > maxBytes) fail('Invalid input or size limit exceeded');
  let readFile, meta;
  if (new Uint8Array(buffer)[0] === 80) {
    readFile = await readSogArchive(buffer, { maxBytes });
    meta = JSON.parse(new TextDecoder().decode(await readFile('meta.json')));
  } else {
    if (!baseUrl) fail('Unbundled meta.json requires its source URL');
    meta = JSON.parse(new TextDecoder().decode(buffer));
    let total = buffer.byteLength;
    readFile = async name => {
      const response = await fetch(new URL(name, baseUrl)); if (!response.ok) fail(`HTTP ${response.status}: ${name}`);
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > maxBytes) fail('Dataset exceeds size limit'); size += value.length; chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; } return bytes;
    };
  }
  checkMeta(meta, options.maxSplats ?? DEFAULT_MAX_SPLATS);
  const files = [...new Set([meta.means, meta.scales, meta.quats, meta.sh0, ...(meta.shN ? [meta.shN] : [])].flatMap(p => p.files))], planes = {};
  // Decode sequentially to bound temporary image/GPU allocations.
  const imagesStart = performance.now();
  for (const file of files) planes[file] = await decodeImage(await readFile(file));
  const imagesEnd = performance.now(), model = decodeSogPlanes(meta, planes, options);
  if (options.profile) Object.assign(model.loadStats, {
    metadata_ms: imagesStart - start, images_ms: imagesEnd - imagesStart, parse_ms: performance.now() - start,
    sourceBytes: buffer.byteLength, decodedPlaneBytes: Object.values(planes).reduce((sum, p) => sum + p.data.byteLength, 0),
    modelBytes: model.data.byteLength + (model.sh || model.shDC).byteLength + (model.shPalette ? model.shPalette.labels.byteLength + model.shPalette.coefficients.byteLength : 0),
  });
  return model;
}
