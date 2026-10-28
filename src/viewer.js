import { GaussianRenderer } from './renderer.js';
import { PlyLoader } from './loader.js';
import { OrbitControls } from './controls.js';
import { createDemoModel, modelBounds } from './model.js';
import { validateCamera } from './camera.js';

const template = `
  <div class="viewer">
    <div class="stage" aria-busy="false">
      <canvas aria-label="Gaussian 三维场景。拖动旋转，滚轮缩放，右键平移；方向键平移，Shift 加方向键旋转，R 重置。"></canvas>
      <div class="badge"><span class="dot"></span><span data-name>Photara Gaussian Viewer</span></div>
      <div class="empty"><span class="empty-mark" aria-hidden="true">✳</span><h2>从重建，到自由探索。</h2><p>打开 Photara 导出的 PLY，或先探索合成示例。</p><button type="button" data-demo>探索示例 <span aria-hidden="true">↗</span></button></div>
      <div class="message" role="status" aria-live="polite" hidden></div>
      <button class="reset" type="button" data-reset aria-label="重置视角" disabled>↺ <span>重置视角</span></button>
    </div>
    <div class="toolbar">
      <div class="actions"><button class="primary" type="button" data-open>打开 PLY <span aria-hidden="true">＋</span></button><input type="file" accept=".ply" data-file hidden><button type="button" data-example>合成示例</button></div>
      <div class="metadata" aria-label="模型信息"><span data-count>尚未加载模型</span><span data-method>—</span><span data-filter>—</span></div>
    </div>
    <div class="footer"><span>拖动旋转 · 滚轮缩放 · 右键平移</span><span data-detail>文件在本机解析，不会上传。</span></div>
  </div>`;

/** Framework-independent mount; styles are scoped by a shadow root in the element. */
export class GaussianViewer {
  constructor(root, { pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2), onLoad, onError, onReady } = {}) {
    this.root = root; this.options = { pixelRatio, onLoad, onError, onReady };
    this.abort = new AbortController(); this.loader = new PlyLoader(); this.generation = 0; this.uploadQueue = Promise.resolve();
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./viewer.css', import.meta.url).href;
    root.replaceChildren(link); const container = document.createElement('div'); container.innerHTML = template; root.append(container);
    this.canvas = root.querySelector('canvas'); this.stage = root.querySelector('.stage'); this.message = root.querySelector('.message');
    this.controls = new OrbitControls(this.canvas, () => this.invalidate());
    const listen = (element, type, fn, options = {}) => element.addEventListener(type, fn, { ...options, signal: this.abort.signal });
    const file = root.querySelector('[data-file]');
    listen(root.querySelector('[data-open]'), 'click', () => file.click());
    listen(file, 'change', () => { const selected = file.files[0]; file.value = ''; if (selected) this.load(selected).catch(() => {}); });
    ['[data-demo]', '[data-example]'].forEach(selector => listen(root.querySelector(selector), 'click', () => this.loadDemo().catch(() => {})));
    listen(root.querySelector('[data-reset]'), 'click', () => this.resetCamera());
    listen(this.stage, 'dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    listen(this.stage, 'drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) this.load(f).catch(() => {}); });
    listen(document, 'visibilitychange', () => this.invalidate());
    this.visible = true;
    this.intersection = new IntersectionObserver(entries => { this.visible = entries[0].isIntersecting; if (this.visible) this.invalidate(); });
    this.intersection.observe(this.stage);
    this.resize = new ResizeObserver(() => this.invalidate()); this.resize.observe(this.stage);
  }
  async initialize() {
    if (this.renderer?.lost) { this.renderer.dispose(); this.renderer = null; this.initializing = null; }
    if (!this.initializing) {
      this.initializing = GaussianRenderer.create(this.canvas, { onError: error => this._error(error) }).then(renderer => {
        if (this.disposed) { renderer.dispose(); throw new DOMException('Viewer disposed', 'AbortError'); }
        this.renderer = renderer; this.options.onReady?.(renderer); return renderer;
      }).catch(error => { this.initializing = null; throw error; });
    }
    return this.initializing;
  }
  _status(text, error = false) { this.message.textContent = text; this.message.hidden = !text; this.message.classList.toggle('is-error', error); }
  _error(error) { if (this.disposed || error.name === 'AbortError') return; this._status(error.message, true); this.options.onError?.(error); }
  async _replace(getModel) {
    if (this.disposed) throw new Error('Viewer disposed');
    const generation = ++this.generation;
    this.fetchAbort?.abort(); this.loader.cancel(); this.fetchAbort = new AbortController();
    const signal = this.fetchAbort.signal;
    this.stage.setAttribute('aria-busy', 'true'); this._status('正在加载 Gaussian 场景…');
    try {
      const [renderer, model] = await Promise.all([this.initialize(), getModel(signal)]);
      if (generation !== this.generation) return;
      // Serialize uploads so a slower, superseded load cannot replace a newer one.
      const upload = this.uploadQueue.catch(() => {}).then(async () => {
        if (generation !== this.generation || this.disposed) return false;
        await renderer.setModel(model); return true;
      });
      this.uploadQueue = upload;
      if (!await upload || generation !== this.generation || this.disposed) return;
      this.modelInfo = { ...renderer.model, name: model.name, hasFilter3D: model.hasFilter3D, bounds: model.bounds || modelBounds(model.data) };
      this.calibratedCamera = null; this.controls.enabled = true; this.controls.fit(this.modelInfo.bounds);
      this.root.querySelector('.empty').hidden = true;
      this.root.querySelector('[data-reset]').disabled = false;
      this.root.querySelector('[data-name]').textContent = model.name;
      this.root.querySelector('[data-count]').textContent = `${model.count.toLocaleString()} Gaussians`;
      this.root.querySelector('[data-method]').textContent = model.renderMethod.toUpperCase();
      this.root.querySelector('[data-filter]').textContent = model.filterMode;
      this.root.querySelector('[data-detail]').textContent = model.renderMethod === '3dgut' ? '3D 射线响应 · 保留模型原始坐标' : '保留模型原始坐标 · 文件不会上传';
      this._status(''); this.invalidate(); this.options.onLoad?.(this.modelInfo);
      return this.modelInfo;
    } catch (error) {
      if (generation === this.generation) { this.fetchAbort.abort(); this.loader.cancel(); this._error(error); }
      throw error;
    } finally { if (generation === this.generation) this.stage.setAttribute('aria-busy', 'false'); }
  }
  /** File/Blob, URL string or ArrayBuffer; parsing happens in a module worker. */
  load(source, { name, maxSplats, maxBytes = 1024 * 1024 * 1024 } = {}) {
    return this._replace(async signal => {
      let buffer;
      if (source instanceof ArrayBuffer) buffer = source;
      else if (source instanceof Blob) {
        if (source.size > maxBytes) throw new Error('PLY 文件超过加载大小限制。');
        name ||= source.name; buffer = await source.arrayBuffer();
      } else {
        const response = await fetch(source, { signal });
        if (!response.ok) throw new Error(`模型加载失败：HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('PLY 文件超过加载大小限制。');
        // Enforce the size limit even for chunked responses without Content-Length.
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error('PLY 文件超过加载大小限制。');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        buffer = bytes.buffer;
        name ||= String(source).split('/').at(-1).split('?')[0];
      }
      if (signal.aborted) throw new DOMException('Load cancelled', 'AbortError');
      if (buffer.byteLength > maxBytes) throw new Error('PLY 文件超过加载大小限制。');
      return this.loader.parse(buffer, { name, ...(maxSplats === undefined ? {} : { maxSplats }) });
    });
  }
  loadDemo(options) { return this._replace(async () => createDemoModel(options)); }
  /** Exact calibrated output resolution; no automatic FOV/principal-point changes. */
  setCamera(camera) {
    validateCamera(camera);
    this.calibratedCamera = { ...camera, worldToCamera: new Float32Array(camera.worldToCamera), distortion: [...(camera.distortion || [0, 0, 0, 0])] };
    this.controls.enabled = false; this.invalidate();
  }
  resetCamera() { this.calibratedCamera = null; this.controls.enabled = true; this.controls.reset(); }
  invalidate() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.renderer?.model || !this.visible || document.hidden || this.disposed) return;
      const box = this.stage.getBoundingClientRect(); if (box.width < 1 || box.height < 1) return;
      const camera = this.calibratedCamera || this.controls.camera(Math.max(1, Math.round(box.width * this.options.pixelRatio)), Math.max(1, Math.round(box.height * this.options.pixelRatio)));
      try { this.renderer.render(camera); } catch (error) { this._error(error); }
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; ++this.generation;
    cancelAnimationFrame(this.frame); this.fetchAbort?.abort(); this.loader.dispose();
    this.abort.abort(); this.resize.disconnect(); this.intersection.disconnect(); this.controls.dispose(); this.renderer?.dispose();
  }
}
