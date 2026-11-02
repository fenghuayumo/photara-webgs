import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync, createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { serve } from './serve.mjs';
const args = process.argv.slice(2), option = (k, fallback) => { const i = args.indexOf(`--${k}`); return i < 0 ? fallback : args[i + 1]; };
const label = option('label', 'run'), baseline = args.includes('--baseline');
const baselineDir = option('baseline-dir', 'test-results/optimization-baseline');
if (baseline && !existsSync(resolve(baselineDir, 'src/renderer.js'))) throw new Error('Create the pre-change source snapshot before using --baseline');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || resolve(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const manifest = JSON.parse(await readFile('test-results/optimization/manifest.json'));
const output = resolve('test-results/optimization', label); await mkdir(output, { recursive: true });
const server = serve(0), assets = createServer((req, res) => { res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' }); createReadStream(option('model', 'D:/BaiduNetdiskDownload/1023/20261023_merged_dataset/images.cache/splat.sog')).pipe(res); }).listen(0, '127.0.0.1');
await Promise.all([once(server, 'listening'), once(assets, 'listening')]);
let browser;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage(); page.setDefaultTimeout(180000); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (baseline) await page.route('**/src/**', async route => {
    const path = resolve(baselineDir, new URL(route.request().url()).pathname.slice(1));
    if (existsSync(path)) await route.fulfill({ body: await readFile(path), contentType: path.endsWith('.js') ? 'text/javascript' : 'text/plain' });
    else await route.continue();
  });
  await page.goto(`http://localhost:${server.address().port}/tests/compare.html`);
  const info = await page.evaluate(async ({url, shStorage}) => {
    const { GaussianRenderer } = await import('/src/renderer.js'), { ModelLoader } = await import('/src/loader.js');
    window.gpuErrors = [];
    window.renderer = await GaussianRenderer.create(document.querySelector('canvas'), { profiling: true, onError: e => gpuErrors.push(e.message) });
    const loader = new ModelLoader(), start = performance.now();
    const model = await loader.parse(await (await fetch(url)).arrayBuffer());
    await renderer.setModel(model, {shStorage}); loader.dispose();
    const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    return { count: model.count, load_ms: performance.now() - start, timestamp: renderer.profiling, memory: renderer.getMemoryUsage ? renderer.getMemoryUsage() : {modelBuffers:renderer.resources.reduce((sum,b)=>sum+b.size,0)}, adapter: adapter.info ? {vendor:adapter.info.vendor, architecture:adapter.info.architecture, description:adapter.info.description} : null };
  }, {url:`http://127.0.0.1:${assets.address().port}/scene.sog`, shStorage:args.includes('--float32-sh')?'float32':'auto'});
  const measurements = [];
  for (const width of [960, 1440]) for (const view of manifest.views) {
    const scale = width / view.width, camera = { ...view, width, height: Math.round(view.height * scale), fx: view.fx * scale, fy: view.fy * scale, cx: view.cx * scale, cy: view.cy * scale };
    const result = await page.evaluate(async ({ camera, compact, tight, paired }) => {
      if (paired) {
        const modes = [{name:'original',tightBounds:false,compact:false},{name:'tight',tightBounds:true,compact:false},{name:'compact',tightBounds:true,compact:true}];
        const collected = modes.map(() => []);
        for(let i=-5;i<15;i++) for(let j=0;j<3;j++){
          const index=(j+(i+6)%3)%3,start=performance.now();
          renderer.render(camera,{renderMethod:'3dgut',filterMode:'mip2d',background:[0,0,0],...modes[index]});
          await renderer.device.queue.onSubmittedWorkDone();
          const wall=performance.now()-start,timing=await renderer.readTimings();
          if(i>=0)collected[index].push({wall_ms:wall,...timing});
        }
        const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
        const variants=modes.map((m,i)=>({name:m.name,median:Object.fromEntries(Object.keys(collected[i][0]).map(k=>[k,median(collected[i].map(s=>s[k]))])),samples:collected[i]}));
        const pixels=[];for(const mode of modes){renderer.render(camera,{renderMethod:'3dgut',filterMode:'mip2d',background:[0,0,0],...mode});pixels.push(await renderer.readPixels());}
        const diffs=pixels.slice(1).map(p=>{let max=0,n=0;for(let i=0;i<p.length;i++){const d=Math.abs(p[i]-pixels[0][i]);max=Math.max(max,d);n+=d>0;}return{maxByte:max,changedChannels:n};});
        return {variants,diffs,stats:await renderer.readVisibility(),gpuErrors,image:''};
      }
      const samples = [], times = [];
      for (let i = -3; i < 9; i++) {
        const start = performance.now();
        renderer.render(camera, { renderMethod: '3dgut', filterMode: 'mip2d', compact, tightBounds: tight, background: [0,0,0] });
        await renderer.device.queue.onSubmittedWorkDone();
        if (i >= 0) { times.push(performance.now() - start); samples.push(await renderer.readTimings()); }
      }
      const image = await renderer.readPixels(); let binary = '';
      for (let i = 0; i < image.length; i += 32768) binary += String.fromCharCode(...image.subarray(i, i + 32768));
      const median = list => [...list].sort((a,b) => a-b)[Math.floor(list.length/2)];
      const stages = Object.fromEntries(Object.keys(samples[0] || {}).map(k => [k, median(samples.map(s => s[k]))]));
      const stats = renderer.readVisibility ? await renderer.readVisibility() : null;
      return { wall_ms: median(times), stages, samples, stats, image: btoa(binary), gpuErrors };
    }, { camera, compact: !args.includes('--no-compact'), tight: !args.includes('--no-tight'), paired: args.includes('--paired') });
    const { image, ...timing } = result, name = `${width}-${view.name}`;
    const pixels = Buffer.from(image, 'base64'); await writeFile(resolve(output, `${name}.rgba`), pixels);
    const reference = resolve('test-results/optimization', option('reference', 'baseline'), `${name}.rgba`);
    if (!baseline && !args.includes('--paired') && existsSync(reference)) {
      const old = await readFile(reference); let max = 0, sum = 0, different = 0;
      for (let i = 0; i < pixels.length; i++) if (i % 4 !== 3) { const d = Math.abs(pixels[i] - old[i]); max = Math.max(max, d); sum += d; different += d > 0; }
      timing.diff = { maxByte: max, mae: sum / (pixels.length * .75), changedChannels: different };
    }
    measurements.push({ name, ...timing }); console.log(JSON.stringify({ name, ...timing, samples: undefined, variants: timing.variants?.map(({name,median}) => ({name,median})) }));
    await writeFile(resolve(output, 'timings.json'), JSON.stringify({ info, errors, measurements }, null, 2));
    if (result.gpuErrors.length) throw new Error(result.gpuErrors.join('\n'));
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser?.close(); server.close(); assets.close(); }
