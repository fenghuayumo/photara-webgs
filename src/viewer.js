import { t, localize, language, onLanguageChange } from './i18n.js';
import { GaussianRenderer } from './renderer.js';
import { PlyLoader } from './loader.js';
import { OrbitControls } from './controls.js';
import { createDemoModel, modelBounds } from './model.js';
import { validateCamera } from './camera.js';

const template = `
  <div class="viewer">
    <div class="stage" aria-busy="false">
      <canvas aria-label="Gaussian 三维场景。拖动旋转，滚轮缩放，右键平移，双击聚焦；方向键平移，Shift 加方向键旋转，R 重置。"></canvas>
      <div class="badge"><span class="dot"></span><span data-name>Photara Gaussian Viewer</span></div>
      <button class="settings-toggle viewport-action" type="button" data-settings-toggle aria-label="隐藏设置" aria-expanded="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 15h18m-12-6 3 3 3-3"/></svg><span class="button-tooltip" data-settings-label aria-hidden="true">隐藏设置</span></button>
      <button class="fullscreen viewport-action" type="button" data-fullscreen aria-label="全屏查看" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="expand-icon" d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path class="collapse-icon" d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/></svg><span class="button-tooltip" data-fullscreen-label aria-hidden="true">全屏查看</span></button>
      <div class="empty"><span class="empty-mark" aria-hidden="true">✳</span><h2>从重建，到自由探索。</h2><p>打开 PLY 或 SOG 模型，或先探索合成示例。</p><button type="button" data-demo>探索示例 <span aria-hidden="true">↗</span></button></div>
      <div class="message" role="status" aria-live="polite" hidden></div>
      <button class="reset viewport-action" type="button" data-reset aria-label="重置视角" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6"/></svg><span class="button-tooltip" aria-hidden="true">重置视角 · R</span></button>
    </div>
    <div class="toolbar">
      <div class="actions"><button class="primary" type="button" data-open>打开 PLY / SOG <span aria-hidden="true">＋</span></button><input type="file" accept=".ply,.sog" data-file hidden><button type="button" data-example>合成示例</button></div>
      <div class="metadata" aria-label="模型信息"><span data-count>尚未加载模型</span><span data-method>—</span><span data-filter>—</span></div>
    </div>
    <div class="navigation" aria-label="相机控制">
      <label class="render-quality language-control"><svg class="language-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/></svg><select data-language aria-label="语言选择"><option value="zh-CN">中文</option><option value="en">英文</option></select></label>
      <div class="mode-switch" role="group" aria-label="相机模式"><button type="button" data-mode="orbit" aria-pressed="true">转台</button><button type="button" data-mode="fly" aria-pressed="false">自由漫游</button></div>
      <label class="fly-speed" title="控制 WASD、Q/E 和漫游滚轮的移动速度">漫游速度 <input type="range" data-speed aria-label="漫游移动速度" aria-valuetext="0.25 倍" min="-2" max="1" step="0.001" value="-0.602"><output data-speed-value>0.25×</output></label>
      <span class="navigation-key">V 切换模式</span>
      <label class="render-quality">渲染 <select data-quality aria-label="渲染质量模式"><option value="sorted">完整画质</option><option value="movement">交互加速（移动时有噪点）</option></select></label>
      <label class="render-quality" data-denoise-label hidden>去噪 <select data-denoise aria-label="随机渲染去噪"><option value="temporal">空间 + 时间重投影</option><option value="spatial">仅空间重建</option><option value="none">关闭（原始采样）</option></select></label>
      <span class="navigation-key" data-render-state aria-live="polite">完整画质</span>
    </div>
    <div class="footer"><span data-help>拖动旋转 · 滚轮缩放 · 右键平移 · 双击聚焦</span><span data-detail>文件在本机解析，不会上传。</span></div>
  </div>`;

/** Framework-independent mount; styles are scoped by a shadow root in the element. */
export class GaussianViewer {
  constructor(root, { pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2), controlMode = 'orbit', renderingMode = 'sorted', reconstruction = 'temporal', onLoad, onError, onReady } = {}) {
    this.root = root; this.options = { pixelRatio, onLoad, onError, onReady };
    this.reconstructionMode = 'temporal';
    this.abort = new AbortController(); this.loader = new PlyLoader(); this.generation = 0; this.uploadQueue = Promise.resolve();
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./viewer.css', import.meta.url).href;
    root.replaceChildren(link); const container = document.createElement('div'); container.innerHTML = template; root.append(container);
    this.canvas = root.querySelector('canvas'); this.stage = root.querySelector('.stage'); this.message = root.querySelector('.message');
    this.container = root.querySelector('.viewer'); localize(root);
    this.controls = new OrbitControls(this.canvas, () => this._controlsChanged(), () => this._updateNavigation());
    const listen = (element, type, fn, options = {}) => element.addEventListener(type, fn, { ...options, signal: this.abort.signal });
    const file = root.querySelector('[data-file]');
    listen(root.querySelector('[data-open]'), 'click', () => file.click());
    listen(file, 'change', () => { const selected = file.files[0]; file.value = ''; if (selected) this.load(selected).catch(() => {}); });
    ['[data-demo]', '[data-example]'].forEach(selector => listen(root.querySelector(selector), 'click', () => this.loadDemo().catch(() => {})));
    listen(root.querySelector('[data-reset]'), 'click', () => this.resetCamera());
    const settingsToggle = root.querySelector('[data-settings-toggle]');
    listen(settingsToggle, 'click', () => {
      const expanded = settingsToggle.getAttribute('aria-expanded') !== 'true';
      settingsToggle.setAttribute('aria-expanded', String(expanded));
      const label = expanded ? t('隐藏设置') : t('显示设置');
      settingsToggle.setAttribute('aria-label', label);
      root.querySelector('[data-settings-label]').textContent = label;
      for (const panel of root.querySelectorAll('.toolbar, .navigation, .footer')) panel.hidden = !expanded;
      this.invalidate();
    });
    const fullscreen = root.querySelector('[data-fullscreen]');
    fullscreen.hidden = !this.container.requestFullscreen || !document.fullscreenEnabled;
    listen(fullscreen, 'click', async () => {
      try {
        if (this.isFullscreen()) await document.exitFullscreen();
        else await this.container.requestFullscreen();
      } catch (error) { this._error(new Error(t('无法切换全屏：{error}', { error: error.message }))); }
    });
    listen(document, 'fullscreenchange', () => {
      const active = this.isFullscreen();
      fullscreen.setAttribute('aria-pressed', String(active));
      fullscreen.setAttribute('aria-label', active ? t('退出全屏') : t('全屏查看'));
      root.querySelector('[data-fullscreen-label]').textContent = active ? t('退出全屏 · Esc') : t('全屏查看');
      this.controls.stop(); this.invalidate();
    });
    root.querySelectorAll('[data-mode]').forEach(button => listen(button, 'click', () => { this.setControlMode(button.dataset.mode); this.canvas.focus({ preventScroll: true }); }));
    listen(root.querySelector('[data-speed]'), 'input', e => {
      const speed = Math.round(10 ** Number(e.target.value) * 100) / 100;
      this.controls.setSpeed(speed);
      root.querySelector('[data-speed-value]').textContent = `${speed.toFixed(2)}×`;
      e.target.setAttribute('aria-valuetext', `${speed.toFixed(2)}×`);
    });
    listen(root.querySelector('[data-quality]'), 'change', e => this.setRenderingMode(e.target.value));
    listen(root.querySelector('[data-denoise]'), 'change', e => this.setReconstructionMode(e.target.value));
    listen(this.canvas, 'dblclick', e => {
      if (e.button !== 0 || !this.controls.enabled || !this.modelInfo) return;
      e.preventDefault();
      this.controls.stop();
      const box = this.canvas.getBoundingClientRect();
      this.focusAt(e.clientX - box.left, e.clientY - box.top).catch(error => this._error(error));
    });
    listen(this.stage, 'dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    listen(this.stage, 'drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) this.load(f).catch(() => {}); });
    listen(document, 'visibilitychange', () => { if (document.hidden) this.controls.stop(); this.invalidate(); });
    this.visible = true;
    this.intersection = new IntersectionObserver(entries => { this.visible = entries[0].isIntersecting; if (this.visible) this.invalidate(); else this.controls.stop(); });
    this.intersection.observe(this.stage);
    this.resize = new ResizeObserver(() => this.invalidate()); this.resize.observe(this.stage);
    this.setControlMode(controlMode);
    this.setRenderingMode(renderingMode);
    this.setReconstructionMode(reconstruction);
    onLanguageChange(() => {
      localize(root); this._updateNavigation();
      if (this.modelInfo) root.querySelector('[data-count]').textContent = `${this.modelInfo.count.toLocaleString(language)} Gaussians`;
      if (this.modelInfo?.isDemo) root.querySelector('[data-name]').textContent = t('合成 Gaussian 示例');
      this.invalidate();
    }, { signal: this.abort.signal });
  }
  isFullscreen() { return this.root.fullscreenElement === this.container || document.fullscreenElement === this.container; }
  setReconstructionMode(mode) {
    if (!['none','spatial','temporal'].includes(mode)) throw new Error('Unknown stochastic reconstruction');
    this.reconstructionMode=mode;this.root.querySelector('[data-denoise]').value=mode;
    this.renderer?.reconstruction?.reset();this.invalidate();
  }
  setRenderingMode(mode) {
    if (!['sorted', 'movement'].includes(mode)) throw new Error('Unknown viewer rendering mode');
    this.renderingMode = mode; this.motionUntil = 0;
    this.root.querySelector('[data-quality]').value = mode;
    this.root.querySelector('[data-denoise-label]').hidden=mode!=='movement';
    clearTimeout(this.settleTimer); this.invalidate();
  }
  _controlsChanged() {
    this.motionUntil = performance.now() + 120;
    clearTimeout(this.settleTimer);
    if (this.renderingMode === 'movement') this.settleTimer = setTimeout(() => this.invalidate(), 130);
    this.invalidate();
  }
  _updateNavigation() {
    const fly = this.controls.mode === 'fly', enabled = this.controls.enabled;
    this.root.querySelectorAll('[data-mode]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.mode === this.controls.mode)); button.disabled = !enabled; });
    this.root.querySelector('[data-speed]').disabled = !enabled;
    const help = !enabled ? t('标定相机 · 重置视角后恢复交互') : fly
      ? t('拖动环视 · WASD 移动 · Q/E 升降 · 滚轮前后 · Shift 加速 / Alt 慢速 · 双击回到转台')
      : t('拖动旋转 · 滚轮缩放 · 右键平移 · 双击平滑聚焦 · WASD 进入漫游');
    this.root.querySelector('[data-help]').textContent = help;
    this.canvas.setAttribute('aria-label', t('Gaussian 三维场景。{help}。V 切换模式，R 重置。', { help }));
  }
  setControlMode(mode) { if (!this.controls.enabled) return; this.controls.setMode(mode); this._updateNavigation(); }
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
    this.stage.setAttribute('aria-busy', 'true'); this._status(t('正在加载 Gaussian 场景…'));
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
      this.modelInfo = { ...renderer.model, name: model.name, isDemo: model.isDemo === true, hasFilter3D: model.hasFilter3D, bounds: model.bounds || modelBounds(model.data) };
      this.calibratedCamera = null; this.controls.enabled = true; this.controls.fit(this.modelInfo.bounds);
      this._updateNavigation();
      this.root.querySelector('.empty').hidden = true;
      this.root.querySelector('[data-reset]').disabled = false;
      this.root.querySelector('[data-name]').textContent = model.name;
      this.root.querySelector('[data-count]').textContent = `${model.count.toLocaleString(language)} Gaussians`;
      this.root.querySelector('[data-method]').textContent = model.renderMethod.toUpperCase();
      this.root.querySelector('[data-filter]').textContent = model.filterMode;
      this.root.querySelector('[data-detail]').textContent = model.renderMethod === '3dgut' ? t('3D 射线响应 · 保留模型原始坐标') : t('保留模型原始坐标 · 文件不会上传');
      this._status(''); this.invalidate(); this.options.onLoad?.(this.modelInfo);
      return this.modelInfo;
    } catch (error) {
      if (generation === this.generation) { this.fetchAbort.abort(); this.loader.cancel(); this._error(error); }
      throw error;
    } finally { if (generation === this.generation) this.stage.setAttribute('aria-busy', 'false'); }
  }
  /** File/Blob, URL string or ArrayBuffer; parsing happens in a module worker. */
  load(source, { name, maxSplats, maxBytes = 1024 * 1024 * 1024, shLayout = 'packed' } = {}) {
    return this._replace(async signal => {
      let buffer, baseUrl;
      if (source instanceof ArrayBuffer) buffer = source;
      else if (source instanceof Blob) {
        if (source.size > maxBytes) throw new Error(t('模型文件超过加载大小限制。'));
        name ||= source.name; buffer = await source.arrayBuffer();
      } else {
        const response = await fetch(source, { signal });
        baseUrl = response.url;
        if (!response.ok) throw new Error(t('模型加载失败：HTTP {status}', { status: response.status }));
        if (Number(response.headers.get('content-length')) > maxBytes) throw new Error(t('模型文件超过加载大小限制。'));
        // Enforce the size limit even for chunked responses without Content-Length.
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error(t('模型文件超过加载大小限制。'));
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        buffer = bytes.buffer;
        name ||= String(source).split('/').at(-1).split('?')[0];
      }
      if (signal.aborted) throw new DOMException('Load cancelled', 'AbortError');
      if (buffer.byteLength > maxBytes) throw new Error(t('模型文件超过加载大小限制。'));
      return this.loader.parse(buffer, { name, baseUrl, maxBytes, shLayout, ...(maxSplats === undefined ? {} : { maxSplats }) });
    });
  }
  loadDemo(options) { return this._replace(async () => createDemoModel(options)); }
  /** Exact calibrated output resolution; no automatic FOV/principal-point changes. */
  setCamera(camera) {
    validateCamera(camera);
    this.calibratedCamera = { ...camera, worldToCamera: new Float32Array(camera.worldToCamera), distortion: [...(camera.distortion || [0, 0, 0, 0])] };
    this.controls.enabled = false; this._updateNavigation(); this.invalidate();
  }
  resetCamera() { this.calibratedCamera = null; this.controls.enabled = true; this.controls.reset(); this._updateNavigation(); }
  /** CSS pixels relative to the canvas. Calibrated cameras retain exact output. */
  async focusAt(x, y) {
    if (this.disposed || !this.controls.enabled || !this.renderer || !this.modelInfo || this.stage.getAttribute('aria-busy') === 'true') return null;
    const box = this.canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    const renderer = this.renderer, generation = this.generation, revision = this.focusRevision = (this.focusRevision || 0) + 1;
    const frame = renderer.frameCount, view = this.controls.view(), controlsRevision = this.controls.revision;
    const point = await renderer.pick(x * renderer.width / box.width, y * renderer.height / box.height);
    const currentView = this.controls.view();
    if (this.disposed || generation !== this.generation || revision !== this.focusRevision || controlsRevision !== this.controls.revision || frame !== renderer.frameCount || !this.controls.enabled || !view.every((v, i) => v === currentView[i])) return null;
    if (point) this.controls.focus(point);
    return point;
  }
  invalidate() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(time => {
      this.frame = 0;
      if (!this.renderer?.model || !this.visible || document.hidden || this.disposed) return;
      const box = this.stage.getBoundingClientRect(); if (box.width < 1 || box.height < 1) return;
      const active = this.controls.update(time);
      const camera = this.calibratedCamera || this.controls.camera(Math.max(1, Math.round(box.width * this.options.pixelRatio)), Math.max(1, Math.round(box.height * this.options.pixelRatio)));
      const transparency = this.renderingMode === 'movement' && !this.calibratedCamera && (active || time < this.motionUntil) ? 'stochastic' : 'sorted';
      try {
        this.renderer.render(camera, { transparency, reconstruction:this.reconstructionMode });
        const state = this.root.querySelector('[data-render-state]'), text = transparency === 'stochastic' ? t('随机预览 · 停止后恢复画质') : t('完整画质');
        if (state.textContent !== text) state.textContent = text;
      } catch (error) { this._error(error); }
      if (active) this.invalidate();
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; ++this.generation;
    cancelAnimationFrame(this.frame); this.fetchAbort?.abort(); this.loader.dispose();
    clearTimeout(this.settleTimer);
    this.abort.abort(); this.resize.disconnect(); this.intersection.disconnect(); this.controls.dispose(); this.renderer?.dispose();
  }
}
