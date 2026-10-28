import { lookAtCV } from './camera.js';

export class OrbitControls {
  constructor(canvas, onChange) {
    this.canvas = canvas; this.onChange = onChange; this.abort = new AbortController(); this.pointers = new Map();
    const listen = (type, fn, options = {}) => canvas.addEventListener(type, fn, { ...options, signal: this.abort.signal });
    canvas.tabIndex = 0; canvas.style.touchAction = 'none';
    this.target = [0, 0, 0]; this.radius = 3; this.yaw = .3; this.pitch = -.15;
    this.initial = null; this.enabled = true;
    listen('contextmenu', e => e.preventDefault());
    listen('pointerdown', e => {
      if (!this.enabled) return;
      canvas.focus({ preventScroll: true }); canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    });
    listen('pointermove', e => {
      const old = this.pointers.get(e.pointerId);
      if (!old || !this.enabled) return;
      const dx = e.clientX - old.x, dy = e.clientY - old.y;
      if (this.pointers.size === 2) {
        const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)[1];
        const before = Math.hypot(old.x - other.x, old.y - other.y), after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (before > 2 && after > 2) this.zoom(before / after, false);
        this.pan(dx * .5, dy * .5, false);
      } else if (old.button === 2 || old.button === 1 || e.shiftKey) this.pan(dx, dy, false);
      else this.orbit(dx * .006, dy * .006, false);
      this.pointers.set(e.pointerId, { ...old, x: e.clientX, y: e.clientY }); this.onChange();
    });
    const up = e => this.pointers.delete(e.pointerId);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => listen(type, up));
    listen('wheel', e => { if (!this.enabled) return; e.preventDefault(); this.zoom(Math.exp(Math.max(-200, Math.min(200, e.deltaY * (e.deltaMode === 1 ? 16 : 1))) * .002)); }, { passive: false });
    listen('keydown', e => {
      if (!this.enabled) return;
      const dirs = { ArrowLeft: [-18, 0], ArrowRight: [18, 0], ArrowUp: [0, -18], ArrowDown: [0, 18] };
      if (dirs[e.key]) { e.preventDefault(); const [x, y] = dirs[e.key]; if (e.shiftKey) this.orbit(x * .006, y * .006); else this.pan(x, y); }
      else if (['+', '=', '-', '_'].includes(e.key)) { e.preventDefault(); this.zoom(e.key === '+' || e.key === '=' ? .85 : 1 / .85); }
      else if (e.key.toLowerCase() === 'r') { e.preventDefault(); this.reset(); }
    });
  }
  fit(bounds) {
    this.target = [...bounds.center]; this.radius = bounds.radius * 2.7;
    this.minimum = Math.max(1e-6, bounds.radius * .01); this.maximum = bounds.radius * 200;
    this.yaw = .3; this.pitch = -.15;
    this.initial = { target: [...this.target], radius: this.radius, yaw: this.yaw, pitch: this.pitch };
    this.onChange();
  }
  reset() { if (this.initial) { Object.assign(this, this.initial, { target: [...this.initial.target] }); this.onChange(); } }
  orbit(x, y, notify = true) { this.yaw -= x; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + y)); if (notify) this.onChange(); }
  zoom(factor, notify = true) { this.radius = Math.max(this.minimum || 1e-5, Math.min(this.maximum || 1e6, this.radius * factor)); if (notify) this.onChange(); }
  pan(dx, dy, notify = true) {
    const v = this.view(), scale = this.radius * 1.2 / Math.max(1, this.canvas.clientHeight);
    for (let a = 0; a < 3; a++) this.target[a] -= (v[a * 4] * dx + v[a * 4 + 1] * dy) * scale;
    if (notify) this.onChange();
  }
  view() {
    const cp = Math.cos(this.pitch);
    const eye = this.target.map((v, i) => v + this.radius * [Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp][i]);
    return lookAtCV(eye, this.target);
  }
  camera(width, height) {
    return { worldToCamera: this.view(), width, height, fx: height * .95, fy: height * .95, cx: width / 2, cy: height / 2, near: Math.max(1e-5, this.radius * .0001), model: 'pinhole' };
  }
  dispose() { this.abort.abort(); this.pointers.clear(); }
}
