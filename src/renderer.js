import { validateModel, FILTER_MODES, RENDER_METHODS } from './model.js';
import { validateCamera, cameraPosition, CAMERA_MODELS } from './camera.js';

const BLIT = `
@group(0) @binding(0) var image: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f { return textureLoad(image,vec2i(p.xy),0); }
`;

/** Standalone WebGPU renderer. No DOM listeners, animation loop or framework. */
export class GaussianRenderer {
  static async create(canvas, { onError = error => console.error(error), powerPreference = 'high-performance', profiling = false } = {}) {
    if (!globalThis.isSecureContext || !navigator.gpu) throw new Error('需要支持 WebGPU 的浏览器，并通过 HTTPS 或 localhost 打开。');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference });
    if (!adapter) throw new Error('当前设备没有可用的 WebGPU 适配器。');
    const device = await adapter.requestDevice({ requiredFeatures: profiling && adapter.features.has('timestamp-query') ? ['timestamp-query'] : [], requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    } });
    const renderer = new GaussianRenderer(canvas, device, onError);
    renderer.profiling = profiling && device.features.has('timestamp-query');
    try { await renderer._initialize(); return renderer; }
    catch (error) { renderer.dispose(); throw error; }
  }

  constructor(canvas, device, onError) {
    this.canvas = canvas; this.device = device; this.onError = onError;
    this.resources = []; this.disposed = false; this.model = null; this.frameCount = 0;
    device.addEventListener('uncapturederror', event => this.onError(event.error));
    device.lost.then(info => { if (!this.disposed) { this.lost = true; this.onError(new Error(`WebGPU device lost: ${info.message}`)); } });
  }

  async _initialize() {
    const device = this.device;
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) throw new Error('Canvas 无法创建 WebGPU 上下文。');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque', colorSpace: 'srgb' });
    const names = ['common', 'project', 'draw', 'radix', 'rays'];
    const sources = await Promise.all(names.map(async name => {
      const response = await fetch(new URL(`./shaders/${name}.wgsl`, import.meta.url));
      if (!response.ok) throw new Error(`Shader ${name}: HTTP ${response.status}`);
      return response.text();
    }));
    const module = async (label, code) => {
      const shader = device.createShaderModule({ label, code });
      const info = await shader.getCompilationInfo();
      const errors = info.messages.filter(m => m.type === 'error');
      if (errors.length) throw new Error(`${label}: ${errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n')}`);
      return shader;
    };
    const [projection, draw, radix, blit, rays] = await Promise.all([
      module('Photara projection', sources[0] + sources[1]),
      module('Photara draw', sources[0] + sources[2]),
      module('GPU radix sort', sources[3]), module('Presentation', BLIT), module('Cached lens rays', sources[0] + sources[4]),
    ]);
    this.uniform = device.createBuffer({ label: 'CV camera', size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (this.profiling) {
      this.timestampQueries = device.createQuerySet({ type: 'timestamp', count: 8 });
      this.timestampBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    }
    this.sortLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } },
      ...Array.from({ length: 6 }, (_, i) => ({ binding: i + 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: i === 0 ? 'read-only-storage' : 'storage' } })),
    ] });
    const sortPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.sortLayout] });
    device.pushErrorScope('validation');
    try {
      this.projectPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: projection, entryPoint: 'main' } });
      this.rayPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: rays, entryPoint: 'main' } });
      this.sortPipelines = await Promise.all(['histogramMain', 'prefixMain', 'scatterMain'].map(entryPoint => device.createComputePipelineAsync({ layout: sortPipelineLayout, compute: { module: radix, entryPoint } })));
      this.drawPipeline = await device.createRenderPipelineAsync({
        layout: 'auto', vertex: { module: draw, entryPoint: 'vertexMain' },
        fragment: { module: draw, entryPoint: 'fragmentMain', targets: [{ format: 'rgba16float', blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        } }] }, primitive: { topology: 'triangle-list' },
      });
      const present = format => device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: blit, entryPoint: 'vs' }, fragment: { module: blit, entryPoint: 'fs', targets: [{ format }] } });
      [this.presentPipeline, this.capturePipeline] = await Promise.all([present(this.format), present('rgba8unorm')]);
    } finally {
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
    }
  }

  _check() { if (this.disposed || this.lost) throw new Error('Renderer is disposed or its GPU device was lost'); }

  /** Canonical model buffers; atomically replaces the previous GPU model. */
  async setModel(model) {
    this._check(); validateModel(model);
    const d = this.device, n = model.count, groups = Math.ceil(n / 256);
    const max = Math.min(d.limits.maxStorageBufferBindingSize, d.limits.maxBufferSize);
    for (const size of [n * 112, model.sh.byteLength, model.data.byteLength]) if (size > max) throw new Error(`模型超出此设备单个 GPU buffer 的限制（${Math.floor(max / 1048576)} MiB）。`);
    if (groups > d.limits.maxComputeWorkgroupsPerDimension) throw new Error('Model exceeds GPU dispatch limits');
    const buffers = [];
    const buffer = (label, size, initial, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC) => {
      const b = d.createBuffer({ label, size: Math.max(4, size), usage, mappedAtCreation: Boolean(initial) });
      buffers.push(b);
      if (initial) { new Uint8Array(b.getMappedRange()).set(new Uint8Array(initial.buffer, initial.byteOffset, initial.byteLength)); b.unmap(); }
      return b;
    };
    d.pushErrorScope('out-of-memory'); d.pushErrorScope('validation');
    let state, failure;
    try {
      const attributes = buffer('Activated Gaussians', model.data.byteLength, model.data);
      const sh = buffer('INRIA SH', model.sh.byteLength, model.sh);
      const projected = buffer('Projected Gaussians', n * 112);
      const keys = [buffer('Keys A', n * 8), buffer('Keys B', n * 8)];
      const ranks = buffer('Local radix ranks', n * 4);
      const hist = buffer('Radix histogram', groups * 16 * 4), prefixes = buffer('Radix prefixes', groups * 16 * 4), totals = buffer('Radix totals', 64);
      const params = new Uint32Array(8 * 64);
      for (let i = 0; i < 8; i++) params.set([n, i * 4, groups, 0], i * 64);
      const sortParams = buffer('Radix parameters', params.byteLength, params, GPUBufferUsage.UNIFORM);
      const bind = (layout, list) => d.createBindGroup({ layout, entries: list.map((b, binding) => ({ binding, resource: { buffer: b } })) });
      const projectGroup = bind(this.projectPipeline.getBindGroupLayout(0), [this.uniform, attributes, sh, projected, keys[0]]);
      const sortGroups = [0, 1].map(i => d.createBindGroup({ layout: this.sortLayout, entries: [sortParams, keys[i], keys[1 - i], ranks, hist, prefixes, totals].map((b, binding) => ({ binding, resource: { buffer: b, ...(binding === 0 ? { size: 16 } : {}) } })) }));
      state = { buffers, groups, keys, projected, projectGroup, drawGroup: null, sortGroups };
    } catch (error) { failure = error; }
    const validation = await d.popErrorScope(), memory = await d.popErrorScope();
    if (failure || validation || memory || this.disposed) {
      buffers.forEach(b => b.destroy());
      throw failure || new Error(validation?.message || memory?.message || 'Renderer disposed during upload');
    }
    this.resources.forEach(b => b.destroy());
    this.resources = buffers; this.state = state;
    // Retain only metadata on the renderer; the viewer may release CPU arrays.
    this.model = { count: n, bases: model.bases, degree: Math.sqrt(model.bases) - 1, renderMethod: model.renderMethod, filterMode: model.filterMode };
  }

  _resize(width, height) {
    if (width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) throw new Error('Viewport exceeds GPU texture limits');
    if (this.width === width && this.height === height) return;
    this.texture?.destroy(); this.captureTexture?.destroy(); this.captureTexture = null;
    this.rayKey = null;
    this.width = this.canvas.width = width; this.height = this.canvas.height = height;
    this.texture = this.device.createTexture({ label: 'Linear numeric Gaussian accumulation', size: [width, height], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    if (this.state) this.state.drawGroup = null;
    this.presentGroup = this.device.createBindGroup({ layout: this.presentPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.texture.createView() }] });
  }

  _ensureRays(width, height) {
    if (this.rayWidth === width && this.rayHeight === height) return;
    this.rayTexture?.destroy(); this.rayKey = null;
    this.rayWidth = width; this.rayHeight = height;
    this.rayTexture = this.device.createTexture({ label: 'Cached nonlinear camera rays', size: [width, height], format: 'rgba32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    this.rayGroup = this.device.createBindGroup({ layout: this.rayPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: this.rayTexture.createView() },
    ] });
    if (this.state) this.state.drawGroup = null;
  }

  render(camera, { renderMethod = this.model?.renderMethod, filterMode = this.model?.filterMode, background = [0.035, 0.055, 0.07], scaleModifier = 1 } = {}) {
    this._check();
    if (!this.model) throw new Error('Load a model before rendering');
    validateCamera(camera);
    if (!RENDER_METHODS.includes(renderMethod) || !FILTER_MODES.includes(filterMode)) throw new Error('Unknown rendering configuration');
    if (!Number.isFinite(scaleModifier) || scaleModifier <= 0 || background.length !== 3 || !background.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid render options');
    const { width, height } = camera;
    this._resize(width, height);
    const nonlinearGut = renderMethod === '3dgut' && CAMERA_MODELS[camera.model] >= 2;
    if (nonlinearGut) this._ensureRays(width, height);
    else if (!this.rayTexture) this._ensureRays(1, 1);
    if (!this.state.drawGroup) this.state.drawGroup = this.device.createBindGroup({ layout: this.drawPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.state.projected } },
      { binding: 2, resource: { buffer: this.state.keys[0] } }, { binding: 3, resource: this.rayTexture.createView() },
    ] });
    const bytes = new ArrayBuffer(160), f = new Float32Array(bytes), u = new Uint32Array(bytes);
    f.set(camera.worldToCamera, 0); f.set(camera.position || cameraPosition(camera.worldToCamera), 16);
    f.set([camera.fx, camera.fy, camera.cx, camera.cy], 20);
    f.set([width, height, camera.near ?? .2, scaleModifier], 24);
    u.set([this.model.count, this.model.bases, RENDER_METHODS.indexOf(renderMethod), FILTER_MODES.indexOf(filterMode)], 28);
    u.set([CAMERA_MODELS[camera.model ?? 'pinhole'], this.model.degree, 0, 0], 32);
    f.set(camera.distortion || [0, 0, 0, 0], 36);
    this.device.queue.writeBuffer(this.uniform, 0, bytes);
    const encoder = this.device.createCommandEncoder({ label: 'Photara Gaussian frame' });
    const timestamps = (begin, end) => this.profiling && (begin !== undefined || end !== undefined) ? { timestampWrites: {
      querySet: this.timestampQueries, ...(begin === undefined ? {} : { beginningOfPassWriteIndex: begin }),
      ...(end === undefined ? {} : { endOfPassWriteIndex: end }),
    } } : {};
    const rayKey = JSON.stringify([camera.model, width, height, camera.fx, camera.fy, camera.cx, camera.cy, camera.distortion || [0, 0, 0, 0]]);
    this.raysUpdated = nonlinearGut && this.rayKey !== rayKey;
    if (this.raysUpdated) {
      const rays = encoder.beginComputePass(timestamps(0, 1)); rays.setPipeline(this.rayPipeline); rays.setBindGroup(0, this.rayGroup);
      rays.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); rays.end(); this.rayKey = rayKey;
    }
    let pass = encoder.beginComputePass(timestamps(2, 3));
    pass.setPipeline(this.projectPipeline); pass.setBindGroup(0, this.state.projectGroup); pass.dispatchWorkgroups(this.state.groups); pass.end();
    // Separate passes give explicit storage-write/read synchronization.
    for (let i = 0; i < 8; i++) for (let stage = 0; stage < 3; stage++) {
      pass = encoder.beginComputePass(timestamps(i === 0 && stage === 0 ? 4 : undefined, i === 7 && stage === 2 ? 5 : undefined));
      pass.setPipeline(this.sortPipelines[stage]); pass.setBindGroup(0, this.state.sortGroups[i % 2], [i * 256]);
      pass.dispatchWorkgroups(stage === 1 ? 16 : this.state.groups); pass.end();
    }
    pass = encoder.beginRenderPass({ ...timestamps(6, 7), colorAttachments: [{ view: this.texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [...background, 1] }] });
    pass.setPipeline(this.drawPipeline); pass.setBindGroup(0, this.state.drawGroup);
    const seamCopies = camera.model === 'equirectangular' ? 3 : 1;
    pass.draw(6, this.model.count * seamCopies); pass.end();
    this._blit(encoder, this.context.getCurrentTexture().createView(), this.presentPipeline, this.presentGroup);
    if (this.profiling) encoder.resolveQuerySet(this.timestampQueries, 0, 8, this.timestampBuffer, 0);
    this.device.queue.submit([encoder.finish()]); this.frameCount++;
  }

  /** Optional GPU pass timings, read only by an explicit profiling caller. */
  async readTimings() {
    this._check();
    if (!this.profiling || !this.frameCount) return null;
    const output = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(this.timestampBuffer, 0, output, 0, 64);
    this.device.queue.submit([encoder.finish()]);
    try {
      await output.mapAsync(GPUMapMode.READ); const t = new BigUint64Array(output.getMappedRange());
      const ms = i => Number(t[i + 1] - t[i]) / 1e6;
      return { rays_ms: this.raysUpdated ? ms(0) : 0, project_ms: ms(2), sort_ms: ms(4), draw_ms: ms(6) };
    } finally { output.destroy(); }
  }

  _blit(encoder, view, pipeline, group) {
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
  }

  /** Explicit readback for screenshots/parity tests; never used in the frame loop. */
  async readPixels() {
    this._check();
    if (!this.texture) throw new Error('Render a frame first');
    const { width, height } = this;
    if (!this.captureTexture) this.captureTexture = this.device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const output = this.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    const group = this.device.createBindGroup({ layout: this.capturePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.texture.createView() }] });
    this._blit(encoder, this.captureTexture.createView(), this.capturePipeline, group);
    encoder.copyTextureToBuffer({ texture: this.captureTexture }, { buffer: output, bytesPerRow }, [width, height]);
    this.device.queue.submit([encoder.finish()]);
    try {
      await output.mapAsync(GPUMapMode.READ);
      const raw = new Uint8Array(output.getMappedRange()), result = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) result.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      return result;
    } finally { output.destroy(); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.resources.forEach(b => b.destroy()); this.resources = [];
    this.uniform?.destroy(); this.texture?.destroy(); this.captureTexture?.destroy(); this.rayTexture?.destroy();
    this.timestampQueries?.destroy(); this.timestampBuffer?.destroy();
    this.context?.unconfigure(); this.device.destroy(); this.model = null;
  }
}
