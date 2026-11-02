// Same-version canonical vs packed loading, sampled main/worker V8 memory,
// explicit buffer bytes, stage timings and six full-scene image hashes.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync, createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { serve } from './serve.mjs';
const args = process.argv.slice(2), option = (key, fallback) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
const modelPath = resolve(option('model', 'D:/BaiduNetdiskDownload/1023/20261023_merged_dataset/images.cache/splat.sog'));
const manifest = JSON.parse(await readFile(option('manifest', 'test-results/optimization/manifest.json')));
const output = resolve(option('output', 'test-results/sog-loading.json')), runs = Number(option('runs', '2'));
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('runs must be 1–10');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || resolve(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const size = (await stat(modelPath)).size;
const server = serve(0), assets = createServer((req, res) => {
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' });
  createReadStream(modelPath).pipe(res);
}).listen(0, '127.0.0.1');
await Promise.all([once(server, 'listening'), once(assets, 'listening')]);
let browser;
try {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync(edge) ? edge : undefined), headless: true, args: ['--enable-unsafe-webgpu'] });
  const records = [], errors = [];
  for (let run = 0; run < runs; run++) for (const layout of run % 2 ? ['packed', 'canonical'] : ['canonical', 'packed']) {
    const page = await browser.newPage(); page.setDefaultTimeout(180000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://localhost:${server.address().port}/tests/compare.html`);
    let phase = 'init', sequence = 0, busy = false;
    const samples = [], workers = new Set(), pending = new Map(), cdp = await page.context().newCDPSession(page);
    const workerSend = (sessionId, method) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Worker sample timeout')); }, 3000);
      pending.set(id, { resolve, reject, timer, sessionId });
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) }).catch(reject);
    });
    cdp.on('Target.receivedMessageFromTarget', event => {
      const message = JSON.parse(event.message), p = pending.get(message.id);
      if (p) { clearTimeout(p.timer); pending.delete(message.id); if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result); }
    });
    cdp.on('Target.attachedToTarget', e => { if (e.targetInfo.type === 'worker') workers.add(e.sessionId); });
    cdp.on('Target.detachedFromTarget', e => {
      workers.delete(e.sessionId);
      for (const [id, p] of pending) if (p.sessionId === e.sessionId) { clearTimeout(p.timer); pending.delete(id); p.reject(new Error('Worker detached')); }
    });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
    await page.exposeFunction('loadingPhase', name => { phase = name; });
    const sample = async () => {
      if (busy) return; busy = true;
      const currentPhase = phase, time = Date.now();
      await Promise.allSettled([
        cdp.send('Runtime.getHeapUsage').then(memory => samples.push({ phase: currentPhase, time, target: 'main', ...memory })),
        ...[...workers].map(session => workerSend(session, 'Runtime.getHeapUsage').then(memory => samples.push({ phase: currentPhase, time, target: 'worker', ...memory }))),
      ]);
      busy = false;
    };
    const timer = setInterval(sample, 25);
    let result;
    try {
      result = await page.evaluate(async ({ url, layout, views }) => {
        const { ModelLoader } = await import('/src/loader.js'), { GaussianRenderer } = await import('/src/renderer.js');
        const gpuErrors = [], renderer = await GaussianRenderer.create(document.querySelector('canvas'), { onError: e => gpuErrors.push(e.message) });
        const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
        const loader = new ModelLoader();
        try {
          await loadingPhase('fetch'); const start = performance.now(), input = await (await fetch(url)).arrayBuffer(), fetched = performance.now();
          await loadingPhase('worker'); const parseStart = performance.now();
          const model = await loader.parse(input, { shLayout: layout, profile: true }), parsed = performance.now();
          if (layout === 'packed' && (model.sh !== undefined || model.shDC.length !== model.count * 3)) throw new Error('Packed load expanded SH');
          const transferredBytes = model.data.byteLength + (model.sh || model.shDC).byteLength + (model.shPalette ? model.shPalette.labels.byteLength + model.shPalette.coefficients.byteLength : 0);
          await loadingPhase('upload');
          await renderer.setModel(model, { profiling: true });
          const uploaded = performance.now(), gpuMemory = renderer.getMemoryUsage(), uploadStats = renderer.lastUploadStats;
          await loadingPhase('render'); const images = [];
          for (const width of [960, 1440]) for (const view of views) {
            const scale = width / view.width, camera = { ...view, width, height: Math.round(view.height * scale), fx: view.fx * scale, fy: view.fy * scale, cx: view.cx * scale, cy: view.cy * scale };
            renderer.render(camera, { renderMethod:'3dgut', filterMode:'mip2d', background:[0,0,0] });
            const rgba = await renderer.readPixels(), digest = await crypto.subtle.digest('SHA-256', rgba);
            images.push({ name:`${width}-${view.name}`, sha256:[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join(''), bytes:rgba.byteLength });
          }
          return { count:model.count, bases:model.bases, loadStats:model.loadStats, transferredBytes, uploadStats, gpuMemory, images, gpuErrors,
            time:{ fetch_ms:fetched-start, worker_wall_ms:parsed-parseStart, loading_ms:uploaded-start },
            adapter:adapter.info?{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description}:null };
        } finally { loader.dispose(); renderer.dispose(); }
      }, { url:`http://127.0.0.1:${assets.address().port}/scene.sog`, layout, views:manifest.views });
    } finally { clearInterval(timer); await cdp.detach(); await page.close(); }
    const peaks = {};
    for (const target of ['main', 'worker']) {
      const loading = samples.filter(s => s.target === target && ['fetch','worker','upload'].includes(s.phase));
      peaks[target] = { samples:loading.length, usedSize:Math.max(0,...loading.map(s=>s.usedSize)), backingStorageSize:Math.max(0,...loading.map(s=>s.backingStorageSize || 0)), heapAndBacking:Math.max(0,...loading.map(s=>s.usedSize+(s.backingStorageSize || 0))) };
    }
    const record = { run, layout, ...result, sampledPeaks:peaks, samples }; records.push(record);
    console.log(JSON.stringify({ run, layout, loadStats:result.loadStats, uploadStats:result.uploadStats, time:result.time, sampledPeaks:peaks }));
    if (result.gpuErrors.length) throw new Error(result.gpuErrors.join('\n'));
    const hashes = records[0].images;
    if (record.images.some((image,i)=>image.sha256!==hashes[i].sha256)) throw new Error('Image mismatch');
    await mkdir(resolve(output, '..'), {recursive:true});
    await writeFile(output, JSON.stringify({ date:'2026-11-02', browser:browser.version(), model:modelPath, size, sampleInterval_ms:25, memoryNote:'CDP V8 heap/backing-store sampled per isolate; excludes image decoder, mapped GPU buffers, browser/driver native memory. Peaks are sampled lower bounds, not process RSS.', errors, records }, null, 2));
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`All ${records.length} loads and six image hashes per load match. ${output}`);
} finally { await browser?.close(); server.close(); assets.close(); }
