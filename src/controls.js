import { lookAtCV, cameraPosition } from './camera.js';

export class OrbitControls {
  constructor(canvas, onChange, onModeChange = () => {}) {
    this.canvas = canvas; this.onChange = onChange; this.abort = new AbortController(); this.pointers = new Map();
    const listen = (type, fn, options = {}) => canvas.addEventListener(type, fn, { ...options, signal: this.abort.signal });
    canvas.tabIndex = 0; canvas.style.touchAction = 'none';
    this.target = [0, 0, 0]; this.radius = 3; this.yaw = .3; this.pitch = -.15;
    this.initial = null; this.enabled = true; this.mode = 'orbit'; this.speed = 0.25; this.onModeChange = onModeChange;
    this.keys = new Set(); this.revision = 0;
    listen('contextmenu', e => e.preventDefault());
    listen('pointerdown', e => {
      if (!this.enabled) return;
      this.cancelTransition();
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
      } else if (old.button === 2 || (old.button === 1 && e.shiftKey) || (old.button === 0 && e.shiftKey)) this.pan(dx, dy, false);
      else if (old.button === 1 && (this.mode === 'fly' || e.ctrlKey)) this.zoom(Math.exp(dy * .01), false);
      else this.orbit(dx * .006, dy * .006, false);
      this.pointers.set(e.pointerId, { ...old, x: e.clientX, y: e.clientY }); this.onChange();
    });
    const up = e => this.pointers.delete(e.pointerId);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => listen(type, up));
    listen('wheel', e => {
      if (!this.enabled) return;
      e.preventDefault();
      const delta = Math.max(-200, Math.min(200, e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1)));
      if (this.mode === 'fly') this.move(0, 0, -delta * .002 * this.moveSpeed * (e.shiftKey ? 10 : e.altKey ? .1 : 1));
      else this.zoom(Math.exp(delta * .002));
    }, { passive: false });
    listen('keydown', e => {
      if (!this.enabled) return;
      if (e.code === 'KeyV' && !e.repeat) { e.preventDefault(); this.setMode(this.mode === 'orbit' ? 'fly' : 'orbit'); return; }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (this.mode !== 'fly') this.setMode('fly');
        this.cancelTransition(); this.keys.add(e.code); this.fast = e.shiftKey; this.slow = e.altKey;
        this.onChange(); return;
      }
      if (e.key === 'Shift' || e.key === 'Alt') { this.fast = e.shiftKey; this.slow = e.altKey; }
      const dirs = { ArrowLeft: [-18, 0], ArrowRight: [18, 0], ArrowUp: [0, -18], ArrowDown: [0, 18] };
      if (dirs[e.key]) { e.preventDefault(); const [x, y] = dirs[e.key]; if (e.shiftKey) this.orbit(x * .006, y * .006); else this.pan(x, y); }
      else if (['+', '=', '-', '_'].includes(e.key)) { e.preventDefault(); this.zoom(e.key === '+' || e.key === '=' ? .85 : 1 / .85); }
      else if (e.key.toLowerCase() === 'r') { e.preventDefault(); this.reset(); }
    });
    const keyup = e => { this.keys.delete(e.code); this.fast = e.shiftKey; this.slow = e.altKey; };
    listen('keyup', keyup);
    listen('blur', () => this.stop());
    // Releasing outside the canvas must not leave the camera moving.
    globalThis.window?.addEventListener('keyup', keyup, { signal: this.abort.signal });
    globalThis.window?.addEventListener('blur', () => this.stop(), { signal: this.abort.signal });
  }
  get enabled() { return this._enabled; }
  set enabled(value) { this._enabled = value; if (!value) this.stop(); }
  get moveSpeed() { return (this.sceneRadius || 1) * .5 * this.speed; }
  setSpeed(speed) {
    if (!Number.isFinite(speed) || speed <= 0) throw new Error('Invalid camera speed');
    this.speed = speed;
  }
  setMode(mode) {
    if (!['orbit', 'fly'].includes(mode)) throw new Error('Unknown camera control mode');
    if (this.mode === mode) return;
    this.stop(); this.mode = mode; this.onModeChange(mode); this.onChange();
  }
  cancelTransition() { this.transition = null; this.revision++; }
  stop() { this.keys?.clear(); this.fast = false; this.slow = false; this.lastTime = null; this.cancelTransition(); this.pointers.clear(); }
  fit(bounds) {
    this.stop(); this.sceneRadius = bounds.radius;
    this.target = [...bounds.center]; this.radius = bounds.radius * 2.7;
    this.minimum = Math.max(1e-6, bounds.radius * .01); this.maximum = bounds.radius * 200;
    this.yaw = .3; this.pitch = -.15;
    this.initial = { target: [...this.target], radius: this.radius, yaw: this.yaw, pitch: this.pitch };
    this.onChange();
  }
  reset() { this.stop(); if (this.initial) { Object.assign(this, this.initial, { target: [...this.initial.target] }); this.onChange(); } }
  /** Recenter without rotating, matching SuperSplat's focal-point interaction. */
  focus(point, { animate = true } = {}) {
    if (!point || point.length !== 3 || !point.every(Number.isFinite)) return;
    const eye = cameraPosition(this.view()), delta = eye.map((v, i) => v - point[i]);
    const radius = Math.hypot(...delta);
    if (radius < 1e-6) return;
    this.setMode('orbit'); this.stop();
    const distance = Math.max(this.minimum || 1e-5, radius);
    if (animate) this.transition = { target: [...point], radius: distance, fromTarget: [...this.target], fromRadius: this.radius, start: null };
    else { this.target = [...point]; this.radius = distance; }
    this.onChange();
  }
  orbit(x, y, notify = true) {
    this.cancelTransition();
    const eye = this.mode === 'fly' ? cameraPosition(this.view()) : null;
    this.yaw -= x; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + y));
    if (eye) { const offset = this.offset(); this.target = eye.map((v, a) => v - offset[a]); }
    if (notify) this.onChange();
  }
  zoom(factor, notify = true) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (this.mode === 'fly') { this.move(0, 0, (1 - factor) * this.moveSpeed, notify); return; }
    this.cancelTransition();
    const minimum = this.minimum || 1e-5, requested = this.radius * factor;
    if (requested < minimum) {
      // Keep a usable orbit distance, but carry the remaining dolly motion
      // forward with the target so the camera can travel through the scene.
      const view = this.view(), travel = minimum - requested;
      for (let a = 0; a < 3; a++) this.target[a] += view[a * 4 + 2] * travel;
    }
    this.radius = Math.max(minimum, Math.min(this.maximum || 1e6, requested));
    if (notify) this.onChange();
  }
  pan(dx, dy, notify = true) {
    this.cancelTransition();
    const v = this.view(), scale = this.radius * 1.2 / Math.max(1, this.canvas.clientHeight);
    for (let a = 0; a < 3; a++) this.target[a] -= (v[a * 4] * dx + v[a * 4 + 1] * dy) * scale;
    if (notify) this.onChange();
  }
  /** Translate in camera right, world up, and camera forward axes. */
  move(right, up, forward, notify = true) {
    this.cancelTransition();
    const view = this.view();
    for (let a = 0; a < 3; a++) this.target[a] += view[a * 4] * right + view[a * 4 + 2] * forward - Number(a === 1) * up;
    if (notify) this.onChange();
  }
  /** Called only while animated or moving; delta time keeps fly speed frame independent. */
  update(now) {
    if (!this.enabled) return false;
    const dt = this.lastTime === null || this.lastTime === undefined ? 0 : Math.max(0, Math.min(.05, (now - this.lastTime) / 1000));
    this.lastTime = now;
    if (this.mode === 'fly' && this.keys.size) {
      const axis = (positive, negative) => Number(this.keys.has(positive)) - Number(this.keys.has(negative));
      const direction = [axis('KeyD', 'KeyA'), axis('KeyE', 'KeyQ'), axis('KeyW', 'KeyS')];
      const distance = this.moveSpeed * (this.fast ? 10 : this.slow ? .1 : 1) * dt / Math.max(1, Math.hypot(...direction));
      this.move(...direction.map(v => v * distance), false);
    }
    if (this.transition) {
      const t = this.transition; t.start ??= now;
      const fraction = Math.min(1, Math.max(0, (now - t.start) / 250)), ease = 1 - (1 - fraction) ** 3;
      this.target = t.fromTarget.map((v, a) => v + (t.target[a] - v) * ease);
      this.radius = t.fromRadius + (t.radius - t.fromRadius) * ease;
      if (fraction === 1) { this.target = [...t.target]; this.radius = t.radius; this.transition = null; }
    }
    const active = Boolean(this.transition || this.keys.size);
    if (!active) this.lastTime = null;
    return active;
  }
  offset() {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp].map(v => v * this.radius);
  }
  view() {
    const offset = this.offset(), eye = this.target.map((v, i) => v + offset[i]);
    return lookAtCV(eye, this.target);
  }
  camera(width, height) {
    return { worldToCamera: this.view(), width, height, fx: height * .95, fy: height * .95, cx: width / 2, cy: height / 2, near: Math.max(1e-5, this.radius * .0001), model: 'pinhole' };
  }
  dispose() { this.stop(); this.abort.abort(); }
}
