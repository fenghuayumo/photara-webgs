export const CAMERA_MODELS = { pinhole: 0, orthographic: 1, fisheye: 2, equirectangular: 3 };
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = a => { const n = Math.hypot(...a); if (n < 1e-10) throw new Error('Degenerate camera axes'); return a.map(v => v / n); };

/** CV camera: +X right, +Y down, +Z forward; column-major world-to-camera. */
export function lookAtCV(eye, target, up = [0, -1, 0]) {
  const forward = normalize(target.map((v, i) => v - eye[i]));
  const right = normalize(cross(forward, up));
  const down = cross(forward, right);
  return new Float32Array([right[0], down[0], forward[0], 0, right[1], down[1], forward[1], 0, right[2], down[2], forward[2], 0, -dot(right, eye), -dot(down, eye), -dot(forward, eye), 1]);
}

export function cameraPosition(view) {
  const t = [view[12], view[13], view[14]];
  return [0, 1, 2].map(a => -dot([view[a * 4], view[a * 4 + 1], view[a * 4 + 2]], t));
}

export function validateCamera(camera) {
  const { worldToCamera: v, width, height, fx, fy, cx, cy } = camera;
  if (!v || v.length !== 16 || !Array.from(v).every(Number.isFinite)) throw new Error('Camera requires a finite column-major worldToCamera');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || ![fx, fy, cx, cy].every(Number.isFinite) || fx <= 0 || fy <= 0) throw new Error('Invalid camera resolution or intrinsics');
  if (!Object.hasOwn(CAMERA_MODELS, camera.model ?? 'pinhole')) throw new Error('Unknown camera model');
  if (Math.abs(v[3]) + Math.abs(v[7]) + Math.abs(v[11]) + Math.abs(v[15] - 1) > 1e-4) throw new Error('Camera must be an affine rigid transform');
  const columns = [0, 1, 2].map(i => Array.from(v).slice(i * 4, i * 4 + 3));
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (Math.abs(dot(columns[a], columns[b]) - Number(a === b)) > 1e-3) throw new Error('Camera rotation must be orthonormal');
  if (dot(cross(columns[0], columns[1]), columns[2]) < .999) throw new Error('Camera rotation must preserve handedness');
  if (camera.near !== undefined && (!Number.isFinite(camera.near) || camera.near < 0)) throw new Error('Near clip must be nonnegative');
  if (camera.distortion && (camera.distortion.length !== 4 || !camera.distortion.every(Number.isFinite))) throw new Error('Distortion must contain k1–k4');
  if (camera.position && (camera.position.length !== 3 || !camera.position.every(Number.isFinite) || Math.hypot(...camera.position.map((x, i) => x - cameraPosition(v)[i])) > 1e-3)) throw new Error('Camera position does not match worldToCamera');
  // Panorama projection in Photara derives its intrinsics from image dimensions.
  if (camera.model === 'equirectangular' && (Math.abs(fx - width / (2 * Math.PI)) > 1e-3 || Math.abs(fy - height / Math.PI) > 1e-3 || Math.abs(cx - width / 2) > 1e-3 || Math.abs(cy - height / 2) > 1e-3)) throw new Error('Panorama requires fx=W/2π, fy=H/π, cx=W/2, cy=H/2');
  return camera;
}

/** Explicitly rescale calibrated intrinsics when changing output resolution. */
export function resizeCamera(camera, width, height) {
  const sx = width / camera.width, sy = height / camera.height;
  return { ...camera, width, height, fx: camera.fx * sx, fy: camera.fy * sy, cx: camera.cx * sx, cy: camera.cy * sy };
}
