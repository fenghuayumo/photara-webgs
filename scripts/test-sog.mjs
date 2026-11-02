import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { serve } from './serve.mjs';
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = await import('playwright')); } catch {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || resolve(process.env.USERPROFILE || process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')));
}
const server = serve(0); await once(server, 'listening');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync(edge) ? edge : undefined), headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/tests/compare.html`);
  const result = await page.evaluate(async () => {
    const { decodeSogImage, parseSog } = await import('../src/sog.js');
    const { ModelLoader } = await import('../src/loader.js');
    const { GaussianRenderer } = await import('../src/renderer.js');
    const { lookAtCV } = await import('../src/camera.js');
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const expected = [64,128,192,0,80,140,200,1,100,160,220,128,120,180,240,255];
    for (const file of ['raw.png', 'dc.webp']) {
      const image = await decodeSogImage(await (await fetch(`./fixtures/sog/${file}`)).arrayBuffer());
      check(image.data.every((v,i) => v === expected[i]), `Raw alpha/RGB or row order changed: ${file}`);
    }
    let reference;
    for (const file of ['stored.sog', 'deflated.sog', 'meta.json']) {
      const response = await fetch(`./fixtures/sog/${file}`);
      const model = await parseSog(await response.arrayBuffer(), { baseUrl: response.url });
      check(model.count === 4 && model.degree === 3, `Bad scene: ${file}`);
      check(model.data[0] < 0 && model.data[1] > 0 && model.data[2] < 0, 'RUB/RDF conversion failed');
      if (reference) check(model.data.every((v,i) => v === reference.data[i]) && model.sh.every((v,i) => v === reference.sh[i]), 'Archive layouts disagree');
      reference = model;
    }
    const loader = new ModelLoader();
    try {
      const model = await loader.parse(await (await fetch('./fixtures/sog/deflated.sog')).arrayBuffer());
      check(model.data.every((v,i) => v === reference.data[i]), 'Worker decode differs');
      const renderer = await GaussianRenderer.create(document.querySelector('canvas'), { onError: e => { throw e; } });
      try {
        const cameras = [
          { model:'pinhole',width:96,height:96,fx:32,fy:32,cx:48,cy:48 },
          { model:'orthographic',width:96,height:96,fx:10,fy:10,cx:48,cy:48 },
          { model:'fisheye',width:96,height:96,fx:30,fy:30,cx:48,cy:48,distortion:[0,0,0,0] },
          { model:'equirectangular',width:96,height:48,fx:96/(2*Math.PI),fy:48/Math.PI,cx:48,cy:24 },
        ].map(c => ({...c,worldToCamera:lookAtCV([0,0,-6],[0,0,0]),near:.01}));
        for (const method of ['3dgs','3dgut']) for (const camera of cameras) {
          await renderer.setModel(model, {shStorage:'float32'});
          renderer.render(camera, {renderMethod:method,background:[0,0,0]});
          const referencePixels = await renderer.readPixels();
          await renderer.setModel(model, {shStorage:'palette'});
          check(renderer.getMemoryUsage().shFormat === 'palette', 'GPU palette path was not used');
          renderer.render(camera, {renderMethod:method,background:[0,0,0]});
          const pixels = await renderer.readPixels();
          check(pixels.every((v,i)=>v===referencePixels[i]), `Palette image differs: ${method}/${camera.model}`);
          check(pixels.some((v,i)=>i%4!==3 && v>0), 'SOG produced an empty GPU image');
        }
        model.sh[4] += .1;
        await renderer.setModel(model, {shStorage:'palette'});
        check(renderer.getMemoryUsage().shFormat === 'float32', 'Edited canonical SH did not fall back');
      } finally { renderer.dispose(); }
    } finally { loader.dispose(); }
    return { passed: true, checks: ['raw PNG/WebP alpha and rows', 'stored/deflated/unbundled parity', 'coordinate conversion', 'module worker', 'WebGPU output', 'exact GPU palette across two methods/four cameras', 'canonical edit fallback'] };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); server.close(); }
