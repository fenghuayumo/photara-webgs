import { t } from './i18n.js';
import { prepareSHStorage } from './gpu-storage.js';
import { StochasticReconstruction } from './reconstruction.js';
import { buildSpatialBlocks } from './spatial-blocks.js';
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
    if (!globalThis.isSecureContext || !navigator.gpu) throw new Error(t('需要支持 WebGPU 的浏览器，并通过 HTTPS 或 localhost 打开。'));
    const adapter = await navigator.gpu.requestAdapter({ powerPreference });
    if (!adapter) throw new Error(t('当前设备没有可用的 WebGPU 适配器。'));
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
    if (!this.context) throw new Error(t('Canvas 无法创建 WebGPU 上下文。'));
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque', colorSpace: 'srgb' });
    const names = ['common', 'project', 'draw', 'radix', 'rays', 'compact', 'pick', 'stochastic', 'reconstruct', 'blocks'];
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
    const [projection, draw, radix, blit, rays, compactShader, pickShader, stochasticShader, reconstructionShader, blockShader] = await Promise.all([
      module('Photara projection', sources[0] + sources[1]),
      module('Photara draw', sources[0] + sources[2]),
      module('GPU radix sort', sources[3]), module('Presentation', BLIT), module('Cached lens rays', sources[0] + sources[4]), module('Visible compaction', sources[0] + sources[5]),
      module('Focus picking', sources[0] + sources[6]),
      module('Stochastic alpha', sources[0] + sources[2] + sources[7]),
      module('Stochastic reconstruction', sources[0] + sources[8]),
      module('Spatial block visibility',sources[0]+sources[9]),
    ]);
    this.uniform = device.createBuffer({ label: 'CV camera', size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.stochasticUniform = device.createBuffer({ label: 'Stochastic sample seed', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (this.profiling) {
      this.timestampQueries = device.createQuerySet({ type: 'timestamp', count: 16 });
      this.timestampBuffer = device.createBuffer({ size: 128, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    }
    this.sortLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } },
      ...Array.from({ length: 6 }, (_, i) => ({ binding: i + 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: i === 0 ? 'read-only-storage' : 'storage' } })),
    ] });
    const sortPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.sortLayout] });
    this.compactLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ...Array.from({ length: 7 }, (_, i) => ({ binding: i + 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: i === 0 ? 'read-only-storage' : 'storage' } })),
    ] });
    const compactLayout = device.createPipelineLayout({ bindGroupLayouts: [this.compactLayout] });
    device.pushErrorScope('validation');
    try {
      const spatial = await device.createComputePipelineAsync({layout:'auto',compute:{module:reconstructionShader,entryPoint:'spatialMain'}});
      const temporal = await device.createComputePipelineAsync({layout:'auto',compute:{module:reconstructionShader,entryPoint:'temporalMain'}});
      this.reconstruction = new StochasticReconstruction(device,spatial,temporal);
      this.projectPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: projection, entryPoint: 'main' } });
      this.clearProjectPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:projection,entryPoint:'clearMain'}});
      this.blockPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:blockShader,entryPoint:'main'}});
      this.pickPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: pickShader, entryPoint: 'main' } });
      this.compactPipelines = await Promise.all(['countMain', 'prefixMain', 'scatterMain'].map(entryPoint => device.createComputePipelineAsync({ layout: compactLayout, compute: { module: compactShader, entryPoint } })));
      this.rayPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: rays, entryPoint: 'main' } });
      this.sortPipelines = await Promise.all(['histogramMain', 'prefixMain', 'scatterMain'].map(entryPoint => device.createComputePipelineAsync({ layout: sortPipelineLayout, compute: { module: radix, entryPoint } })));
      this.drawPipeline = await device.createRenderPipelineAsync({
        layout: 'auto', vertex: { module: draw, entryPoint: 'vertexMain' },
        fragment: { module: draw, entryPoint: 'fragmentMain', targets: [{ format: 'rgba16float', blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        } }] }, primitive: { topology: 'triangle-list' },
      });
      this.stochasticPipeline = await device.createRenderPipelineAsync({
        layout: 'auto', vertex: { module: stochasticShader, entryPoint: 'vertexMain' },
        fragment: { module: stochasticShader, entryPoint: 'stochasticMain', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      });
      this.stochasticGSPipeline = await device.createRenderPipelineAsync({
        layout: 'auto', vertex: { module: stochasticShader, entryPoint: 'stochasticGSVertex' },
        fragment: { module: stochasticShader, entryPoint: 'stochasticGSMain', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      });
      const present = format => device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: blit, entryPoint: 'vs' }, fragment: { module: blit, entryPoint: 'fs', targets: [{ format }] } });
      [this.presentPipeline, this.capturePipeline] = await Promise.all([present(this.format), present('rgba8unorm')]);
    } finally {
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
    }
  }

  _check() { if (this.disposed || this.lost) throw new Error('Renderer is disposed or its GPU device was lost'); }

  /** Canonical or packed model buffers; atomically replaces the GPU model. */
  async setModel(model, { shStorage = 'auto', profiling = false, spatialBlocks = 'auto' } = {}) {
    const start = profiling ? performance.now() : 0;
    this._check(); validateModel(model);
    const validated = profiling ? performance.now() : 0;
    const packedSH = prepareSHStorage(model, shStorage, { segmented: true });
    const prepared = profiling ? performance.now() : 0;
    const shBytes = packedSH.byteLength ?? packedSH.data.byteLength;
    const d = this.device, n = model.count, groups = Math.ceil(n / 256);
    if(![true,false,'auto'].includes(spatialBlocks))throw new Error('Invalid spatialBlocks option');
    const indexStart=performance.now();
    const spatial=(spatialBlocks===true||(spatialBlocks==='auto'&&n>=4096))?buildSpatialBlocks(model.data):null;
    const indexBuildMs=performance.now()-indexStart;
    const max = Math.min(d.limits.maxStorageBufferBindingSize, d.limits.maxBufferSize);
    for (const size of [n * 96, shBytes, model.data.byteLength]) if (size > max) throw new Error(t('模型超出此设备单个 GPU buffer 的限制（{size} MiB）。', { size: Math.floor(max / 1048576) }));
    if (groups > d.limits.maxComputeWorkgroupsPerDimension) throw new Error('Model exceeds GPU dispatch limits');
    const buffers = [];
    const buffer = (label, size, initial, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC) => {
      const b = d.createBuffer({ label, size: Math.max(4, size), usage, mappedAtCreation: Boolean(initial) });
      buffers.push(b);
      if (initial) {
        const target = new Uint8Array(b.getMappedRange());
        if(typeof initial==='function')initial(target);
        else for (const { data, offset } of Array.isArray(initial) ? initial : [{ data: initial, offset: 0 }]) target.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
        b.unmap();
      }
      return b;
    };
    d.pushErrorScope('out-of-memory'); d.pushErrorScope('validation');
    let state, failure;
    try {
      const attributes = buffer('Activated Gaussians', model.data.byteLength, spatial?target=>{
        const floats=new Float32Array(target.buffer,target.byteOffset,target.byteLength/4);
        for(let i=0;i<n;i++){const source=spatial.indices[i]*12;floats.set(model.data.subarray(source,source+12),i*12);}
      }:model.data);
      const sh = buffer(`INRIA SH (${packedSH.format})`, shBytes, packedSH.segments || packedSH.data);
      const projected = buffer('Projected Gaussians', n * 96);
      const keys = [buffer('Keys A', n * 8), buffer('Keys B', n * 8)];
      const ranks = buffer('Local radix ranks', n * 4);
      const hist = buffer('Radix histogram', groups * 16 * 4), prefixes = buffer('Radix prefixes', groups * 16 * 4), totals = buffer('Radix totals', 64);
      const params = new Uint32Array(8 * 64);
      for (let i = 0; i < 8; i++) params.set([n, i * 4, groups, 0], i * 64);
      const sortParams = buffer('Radix parameters', params.byteLength, params, GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const bind = (layout, list) => d.createBindGroup({ layout, entries: list.map((b, binding) => ({ binding, resource: { buffer: b } })) });
      const spatialIndices=buffer('Spatial original IDs',spatial?.indices.byteLength||4,spatial?.indices);
      const blockBounds=buffer('Spatial block bounds',spatial?.bounds.byteLength||32,spatial?.bounds);
      const blockVisible=buffer('Spatial block visibility',spatial?spatial.count*4:4);
      const blockGroup=bind(this.blockPipeline.getBindGroupLayout(0),[this.uniform,blockBounds,blockVisible]);
      const projectGroup = bind(this.projectPipeline.getBindGroupLayout(0), [this.uniform, attributes, sh, projected, keys[0],spatialIndices,blockVisible]);
      const clearProjectGroup=d.createBindGroup({layout:this.clearProjectPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:4,resource:{buffer:keys[0]}}]});
      const sortGroups = [0, 1].map(i => d.createBindGroup({ layout: this.sortLayout, entries: [sortParams, keys[i], keys[1 - i], ranks, hist, prefixes, totals].map((b, binding) => ({ binding, resource: { buffer: b, ...(binding === 0 ? { size: 16 } : {}) } })) }));
      const counts = buffer('Visible block counts', groups * 4), offsets = buffer('Visible block offsets', groups * 4);
      const indirect = buffer('Visible indirect arguments', 32, null, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
      const compactGroup = bind(this.compactLayout, [this.uniform, keys[0], keys[1], ranks, counts, offsets, sortParams, indirect]);
      state = { memory: { attributes: model.data.byteLength, sh: shBytes, projected: n * 96, spatial:spatialIndices.size+blockBounds.size+blockVisible.size },clearProjectGroup,blockVisible,blockGroup,blockCount:spatial?.count||0, attributes, sortParams, params, compactGroup, indirect, buffers, groups, keys, projected, projectGroup, drawGroup: null, sortGroups };
    } catch (error) { failure = error; }
    const validation = await d.popErrorScope(), memory = await d.popErrorScope();
    if (failure || validation || memory || this.disposed) {
      buffers.forEach(b => b.destroy());
      throw failure || new Error(validation?.message || memory?.message || 'Renderer disposed during upload');
    }
    this.resources.forEach(b => b.destroy());
    this.resources = buffers; this.state = state;
    this.hasRenderedModel = false;
    this.lastFrame = null;
    this.reconstruction.reset();
    // Retain only metadata on the renderer; the viewer may release CPU arrays.
    this.model = { shFormat: packedSH.format, count: n, bases: model.bases, degree: Math.sqrt(model.bases) - 1, renderMethod: model.renderMethod, filterMode: model.filterMode };
    this.lastUploadStats = profiling ? {
      validation_ms: validated - start, sh_prepare_ms: prepared - validated,
      spatial_build_ms:indexBuildMs,
      gpu_upload_ms: performance.now() - prepared-indexBuildMs, total_ms: performance.now() - start,
      shTemporaryBytes: packedSH.data && packedSH.data !== model.sh && packedSH.data !== model.shDC ? packedSH.data.byteLength : 0,
    } : null;
  }

  _resize(width, height) {
    if (width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) throw new Error('Viewport exceeds GPU texture limits');
    if (this.width === width && this.height === height) return;
    this.texture?.destroy(); this.captureTexture?.destroy(); this.captureTexture = null;
    this.depthTexture?.destroy(); this.depthTexture = null;
    this.reconstruction.destroyTextures(); this.displayTexture = null;
    this.rayKey = null;
    this.width = this.canvas.width = width; this.height = this.canvas.height = height;
    this.texture = this.device.createTexture({ label: 'Linear numeric Gaussian accumulation', size: [width, height], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    if (this.state) { this.state.drawGroup = null; this.state.stochasticGroup = null; }
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
    if (this.state) { this.state.drawGroup = null; this.state.stochasticGroup = null; }
  }

  render(camera, { renderMethod = this.model?.renderMethod, filterMode = this.model?.filterMode, background = [0.035, 0.055, 0.07], scaleModifier = 1, tightBounds = true, compact = true, transparency = 'sorted', stochasticSeed = this.frameCount >>> 0, reconstruction = 'none', resetHistory = false, blockCulling = true } = {}) {
    this._check();
    if (!this.model) throw new Error('Load a model before rendering');
    validateCamera(camera);
    if (!RENDER_METHODS.includes(renderMethod) || !FILTER_MODES.includes(filterMode)) throw new Error('Unknown rendering configuration');
    if (!['sorted', 'stochastic'].includes(transparency) || !Number.isInteger(stochasticSeed) || stochasticSeed < 0 || stochasticSeed > 0xffffffff) throw new Error('Invalid transparency mode or stochastic seed');
    if (!['none','spatial','temporal'].includes(reconstruction)) throw new Error('Unknown stochastic reconstruction');
    if(typeof blockCulling!=='boolean')throw new Error('Invalid blockCulling option');
    if (!Number.isFinite(scaleModifier) || scaleModifier <= 0 || background.length !== 3 || !background.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid render options');
    const { width, height } = camera;
    this.lastBlockCulling=Boolean(blockCulling&&this.state.blockCount&&renderMethod==='3dgs'&&['pinhole','orthographic'].includes(camera.model||'pinhole'));
    this._resize(width, height);
    const stochastic = transparency === 'stochastic';
    const stochasticPipeline = renderMethod === '3dgs' ? this.stochasticGSPipeline : this.stochasticPipeline;
    if (stochastic && !this.depthTexture) this.depthTexture = this.device.createTexture({ label: 'Stochastic reversed depth', size: [width, height], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const nonlinearGut = renderMethod === '3dgut' && CAMERA_MODELS[camera.model] >= 2;
    if (nonlinearGut) this._ensureRays(width, height);
    else if (!this.rayTexture) this._ensureRays(1, 1);
    if (this.state.drawCompact !== compact) { this.state.drawGroup = null; this.state.stochasticGroup = null; this.state.drawCompact = compact; }
    if (!this.state.drawGroup) this.state.drawGroup = this.device.createBindGroup({ layout: this.drawPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.state.projected } },
      { binding: 2, resource: { buffer: this.state.keys[compact ? 1 : 0] } }, { binding: 3, resource: this.rayTexture.createView() },
    ] });
    if (this.state.stochasticMethod !== renderMethod) { this.state.stochasticGroup = null; this.state.stochasticMethod = renderMethod; }
    if (stochastic && !this.state.stochasticGroup) this.state.stochasticGroup = this.device.createBindGroup({ layout: stochasticPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.state.projected } },
      { binding: 2, resource: { buffer: this.state.keys[compact ? 1 : 0] } }, { binding: 3, resource: this.rayTexture.createView() },
      { binding: 4, resource: { buffer: this.stochasticUniform } },
    ] });
    const bytes = new ArrayBuffer(160), f = new Float32Array(bytes), u = new Uint32Array(bytes);
    f.set(camera.worldToCamera, 0); f.set(camera.position || cameraPosition(camera.worldToCamera), 16);
    f.set([camera.fx, camera.fy, camera.cx, camera.cy], 20);
    f.set([width, height, camera.near ?? .2, scaleModifier], 24);
    u.set([this.model.count, this.model.bases, RENDER_METHODS.indexOf(renderMethod), FILTER_MODES.indexOf(filterMode)], 28);
    u.set([CAMERA_MODELS[camera.model ?? 'pinhole'], this.model.degree, (tightBounds ? 1 : 0)|(this.lastBlockCulling?2:0)|(this.state.blockCount?4:0), this.model.shFormat === 'palette' ? 1 : 0], 32);
    f.set(camera.distortion || [0, 0, 0, 0], 36);
    this.device.queue.writeBuffer(this.uniform, 0, bytes);
    if (stochastic) this.device.queue.writeBuffer(this.stochasticUniform, 0, new Uint32Array([stochasticSeed, reconstruction==='none'?0:1, 0, 0]));
    if (!compact) this.device.queue.writeBuffer(this.state.sortParams, 0, this.state.params);
    this.lastCompact = compact;
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
    if(this.lastBlockCulling){const blocks=encoder.beginComputePass(timestamps(14,15));blocks.setPipeline(this.blockPipeline);blocks.setBindGroup(0,this.state.blockGroup);blocks.dispatchWorkgroups(Math.ceil(this.state.blockCount/64));blocks.end();}
    if(this.lastBlockCulling){const clear=encoder.beginComputePass(timestamps(2,undefined));clear.setPipeline(this.clearProjectPipeline);clear.setBindGroup(0,this.state.clearProjectGroup);clear.dispatchWorkgroups(this.state.groups);clear.end();}
    let pass = encoder.beginComputePass(timestamps(this.lastBlockCulling?undefined:2, 3));
    pass.setPipeline(this.projectPipeline); pass.setBindGroup(0, this.state.projectGroup); pass.dispatchWorkgroups(this.state.groups); pass.end();
    if (compact) for (let stage = 0; stage < 3; stage++) {
      pass = encoder.beginComputePass(timestamps(stage === 0 ? 8 : undefined, stage === 2 ? 9 : undefined));
      pass.setPipeline(this.compactPipelines[stage]); pass.setBindGroup(0, this.state.compactGroup);
      pass.dispatchWorkgroups(stage === 1 ? 1 : this.state.groups); pass.end();
    }
    if (!stochastic) this._encodeSort(encoder, compact, timestamps);
    this.state.keysSorted = !stochastic;
    pass = encoder.beginRenderPass({ ...timestamps(6, 7), colorAttachments: [{ view: this.texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [...background, 1] }],
      ...(stochastic ? { depthStencilAttachment: { view: this.depthTexture.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: reconstruction==='none'?'discard':'store' } } : {}),
    });
    pass.setPipeline(stochastic ? stochasticPipeline : this.drawPipeline); pass.setBindGroup(0, stochastic ? this.state.stochasticGroup : this.state.drawGroup);
    const seamCopies = camera.model === 'equirectangular' ? 3 : 1;
    if (compact) pass.drawIndirect(this.state.indirect, 0);
    else pass.draw(6, this.model.count * seamCopies);
    pass.end();
    this.displayTexture=this.texture;
    if (resetHistory) this.reconstruction.reset();
    if (stochastic && reconstruction!=='none') {
      const key=JSON.stringify([camera.model||'pinhole',width,height,camera.fx,camera.fy,camera.cx,camera.cy,camera.distortion,renderMethod,filterMode,background,scaleModifier,tightBounds,compact,reconstruction,blockCulling]);
      this.displayTexture=this.reconstruction.encode(encoder,{camera,bytes,key,mode:reconstruction,rawColor:this.texture,rawDepth:this.depthTexture,cameraUniform:this.uniform,timestamps});
    } else this.reconstruction.reset();
    const displayGroup=this.displayTexture===this.texture?this.presentGroup:this.device.createBindGroup({layout:this.presentPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.displayTexture.createView()}]});
    this._blit(encoder, this.context.getCurrentTexture().createView(), this.presentPipeline, displayGroup);
    if (this.profiling) encoder.resolveQuerySet(this.timestampQueries, 0, 16, this.timestampBuffer, 0);
    this.device.queue.submit([encoder.finish()]); this.frameCount++; this.hasRenderedModel = true;
    this.lastTransparency = transparency;
    this.lastReconstruction=stochastic?reconstruction:'none';
    this.lastFrame = stochastic ? { camera: { ...camera, worldToCamera: Array.from(camera.worldToCamera), ...(camera.position ? { position: [...camera.position] } : {}), ...(camera.distortion ? { distortion: [...camera.distortion] } : {}) }, options: { renderMethod, filterMode, background: [...background], scaleModifier, tightBounds, compact,blockCulling } } : null;
  }

  _encodeSort(encoder, compact, timestamps = () => ({})) {
    // Separate passes give explicit storage-write/read synchronization.
    for (let i = 0; i < 8; i++) for (let stage = 0; stage < 3; stage++) {
      const pass = encoder.beginComputePass(timestamps(i === 0 && stage === 0 ? 4 : undefined, i === 7 && stage === 2 ? 5 : undefined));
      pass.setPipeline(this.sortPipelines[stage]); pass.setBindGroup(0, this.state.sortGroups[compact ? 1 - i % 2 : i % 2], [i * 256]);
      if (stage !== 1 && compact) pass.dispatchWorkgroupsIndirect(this.state.indirect, 16);
      else pass.dispatchWorkgroups(stage === 1 ? 16 : this.state.groups);
      pass.end();
    }
  }

  /** Pick a world-space focus point from the last frame, in canvas pixels.
   * Gaussian data has no mesh surface: this uses accumulated-opacity depth.
   * Only explicit picks allocate/read back 16 bytes; the frame loop is unchanged.
   */
  async pick(x, y) {
    this._check();
    if (!this.hasRenderedModel || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const d = this.device, buffers = [];
    const allocate = (size, usage) => { const b = d.createBuffer({ size, usage }); buffers.push(b); return b; };
    try {
      const request = allocate(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const result = allocate(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const output = allocate(16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      d.queue.writeBuffer(request, 0, new Uint32Array([Math.floor(x), Math.floor(y), this.lastCompact ? 1 : 0, 0]));
      const group = d.createBindGroup({ layout: this.pickPipeline.getBindGroupLayout(0), entries:
        [this.uniform, this.state.projected, this.state.keys[this.lastCompact ? 1 : 0], this.state.attributes, this.state.indirect, request, result]
          .map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const encoder = d.createCommandEncoder({ label: 'Double-click focus' });
      // Stochastic drawing never sorts. Explicit picking still uses the same
      // deterministic opacity scan, so prepare its keys only when requested.
      if (!this.state.keysSorted) { this._encodeSort(encoder, this.lastCompact); this.state.keysSorted = true; }
      const pass = encoder.beginComputePass(); pass.setPipeline(this.pickPipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
      encoder.copyBufferToBuffer(result, 0, output, 0, 16); d.queue.submit([encoder.finish()]);
      await output.mapAsync(GPUMapMode.READ);
      const point = new Float32Array(output.getMappedRange());
      return point[3] > 0 && point.every(Number.isFinite) ? Array.from(point.slice(0, 3)) : null;
    } finally { buffers.forEach(b => b.destroy()); }
  }

  /** Optional GPU pass timings, read only by an explicit profiling caller. */
  async readTimings() {
    this._check();
    if (!this.profiling || !this.frameCount) return null;
    const output = this.device.createBuffer({ size: 128, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(this.timestampBuffer, 0, output, 0, 128);
    this.device.queue.submit([encoder.finish()]);
    try {
      await output.mapAsync(GPUMapMode.READ); const t = new BigUint64Array(output.getMappedRange());
      const ms = i => Number(t[i + 1] - t[i]) / 1e6;
      return { block_ms:this.lastBlockCulling?ms(14):0, compact_ms: this.lastCompact ? ms(8) : 0, rays_ms: this.raysUpdated ? ms(0) : 0, project_ms: ms(2), sort_ms: this.lastTransparency === 'stochastic' ? 0 : ms(4), draw_ms: ms(6), spatial_ms:this.lastReconstruction!=='none'?ms(10):0, temporal_ms:this.lastReconstruction==='temporal'?ms(12):0 };
    } finally { output.destroy(); }
  }

  /** Requested allocation bytes, excluding driver/browser allocations and CPU arrays. */
  getMemoryUsage() {
    this._check();
    const modelBuffers = this.resources.reduce((sum, buffer) => sum + buffer.size, 0);
    const controlBuffers = (this.uniform?.size || 0) + (this.stochasticUniform?.size || 0) + (this.timestampBuffer?.size || 0) + (this.reconstruction?.uniform.size || 0);
    const textures = (this.texture ? this.width * this.height * 8 : 0) +
      (this.captureTexture ? this.width * this.height * 4 : 0) + (this.rayTexture ? this.rayWidth * this.rayHeight * 16 : 0) + (this.depthTexture ? this.width * this.height * 4 : 0) + (this.reconstruction?.bytes || 0);
    return { ...this.state?.memory, modelBuffers, controlBuffers, textures, total: modelBuffers + controlBuffers + textures, shFormat: this.model?.shFormat };
  }

  /** Explicit profiling readback only; never needed by normal rendering. */
  async readBlockVisibility() {
    this._check();
    const total=this.state.blockCount;
    if(!this.lastBlockCulling)return{enabled:false,total,candidateBlocks:total,candidateSplats:this.model.count};
    const output=this.device.createBuffer({size:total*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    const encoder=this.device.createCommandEncoder();encoder.copyBufferToBuffer(this.state.blockVisible,0,output,0,total*4);this.device.queue.submit([encoder.finish()]);
    try{await output.mapAsync(GPUMapMode.READ);const flags=new Uint32Array(output.getMappedRange());let candidateBlocks=0,candidateSplats=0;
      for(let i=0;i<total;i++)if(flags[i]){candidateBlocks++;candidateSplats+=Math.min(256,this.model.count-i*256);}
      return{enabled:true,total,candidateBlocks,candidateSplats};
    }finally{output.destroy();}
  }

  /** Explicit profiling readback only; never needed by normal rendering. */
  async readVisibility() {
    this._check();
    if (!this.lastCompact) return { visible: this.model.count, total: this.model.count };
    const output = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(this.state.indirect, 0, output, 0, 32);
    this.device.queue.submit([encoder.finish()]);
    try { await output.mapAsync(GPUMapMode.READ); return { visible: new Uint32Array(output.getMappedRange())[7], total: this.model.count }; }
    finally { output.destroy(); }
  }

  _blit(encoder, view, pipeline, group) {
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
  }

  /** Explicit readback for screenshots/parity tests; never used in the frame loop. */
  async readPixels({ exact = true } = {}) {
    this._check();
    if (!this.texture || !this.hasRenderedModel) throw new Error('Render a frame first');
    if (exact && this.lastTransparency === 'stochastic') this.render(this.lastFrame.camera, this.lastFrame.options);
    const { width, height } = this;
    if (!this.captureTexture) this.captureTexture = this.device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const output = this.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    const group = this.device.createBindGroup({ layout: this.capturePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: (this.displayTexture||this.texture).createView() }] });
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
    this.stochasticUniform?.destroy(); this.depthTexture?.destroy();
    this.reconstruction?.dispose();
    this.timestampQueries?.destroy(); this.timestampBuffer?.destroy();
    this.context?.unconfigure(); this.device.destroy(); this.model = null;
  }
}
