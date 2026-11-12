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
  const result = await page.evaluate(async()=>{
    const {parseSog,decodeSogImage}=await import('/src/sog.js');
    const {parsePly}=await import('/src/ply.js');
    const {ModelLoader}=await import('/src/loader.js');
    const {toCanonicalModel}=await import('/src/model.js');
    const {GaussianRenderer}=await import('/src/renderer.js');
    const {lookAtCV}=await import('/src/camera.js');
    const check=(ok,message)=>{if(!ok)throw new Error(message);};
    const get=async file=>{const response=await fetch(`/tests/fixtures/sog-xt/${file}`);if(!response.ok)throw new Error(file);return response;};
    const nativeErrors=[],loader=new ModelLoader(),canvas=document.querySelector('canvas');
    const renderer=await GaussianRenderer.create(canvas,{onError:e=>nativeErrors.push(e.message)});
    const cases=[...Array.from({length:4},(_,degree)=>({file:`degree${degree}.sog-xt`,expected:`degree${degree}.ply`})),
      {file:'v1-degree1.sog-xt',expected:'v1-degree1.ply'},
      {file:'unbundled/container_meta.yaml',expected:'degree3.ply'},
      {file:'reference.sog-xt',expected:'reference.ply'},
      {file:'unbundled/reference.yaml',expected:'reference.ply'}];
    const records=[];
    try{
      for(const {file,expected} of cases){
        const source=await get(file),buffer=await source.arrayBuffer();
        const model=await parseSog(buffer,{baseUrl:source.url}),ply=parsePly(await(await get(expected)).arrayBuffer());
        check(model.sourceFormat==='sog-xt'&&model.count===ply.count&&model.degree===ply.degree,`Shape mismatch ${file}`);
        check(model.filterMode===ply.filterMode,`Antialias metadata mismatch ${file}`);
        const maxError=(a,b)=>a.reduce((m,v,i)=>Math.max(m,Math.abs(v-b[i])),0);
        const dataError=maxError(model.data,ply.data),shError=maxError(model.sh,ply.sh);
        check(dataError<3e-6&&shError<1e-6,`Native decode mismatch ${file}: ${dataError}/${shError}`);
        const packed=await loader.parse(buffer.slice(0),{baseUrl:source.url,shLayout:'packed',profile:true});
        check(packed.sh===undefined&&packed.shDC.length===model.count*3,`Packed expansion ${file}`);
        check(toCanonicalModel(packed).sh.every((v,i)=>v===model.sh[i]),`Packed SH mismatch ${file}`);
        check(packed.data.every((v,i)=>v===model.data[i]),`Worker data mismatch ${file}`);
        const view=lookAtCV([0,0,0],[0,0,2]);
        const cameras=[{model:'pinhole',width:96,height:64,fx:75,fy:75,cx:48,cy:32},
          {model:'orthographic',width:96,height:64,fx:70,fy:70,cx:48,cy:32},
          {model:'fisheye',width:96,height:64,fx:65,fy:65,cx:48,cy:32},
          {model:'equirectangular',width:96,height:48,fx:96/(2*Math.PI),fy:48/Math.PI,cx:48,cy:24}].map(c=>({...c,worldToCamera:view,near:.01}));
        for(const method of ['3dgs','3dgut'])for(const camera of cameras){
          await renderer.setModel(model,{shStorage:'float32'});renderer.render(camera,{renderMethod:method});const reference=await renderer.readPixels();
          await renderer.setModel(packed);renderer.render(camera,{renderMethod:method});const pixels=await renderer.readPixels();
          check(pixels.every((v,i)=>v===reference[i]),`Packed GPU mismatch ${file}/${method}/${camera.model}`);
          check(pixels.some((v,i)=>i%4!==3&&v>25),`Empty model ${file}`);
        }
        records.push({file,dataError,shError,count:model.count,degree:model.degree});
      }
      const promise=loader.parse(await(await get('degree3.sog-xt')).arrayBuffer());loader.cancel();
      await promise.then(()=>{throw new Error('Cancelled load completed');},e=>check(e.name==='AbortError','Bad cancellation'));
      let limited=false;try{await parseSog(await(await get('degree3.sog-xt')).arrayBuffer(),{maxSplats:1});}catch(e){limited=e.message.includes('limit');}check(limited,'Count limit ignored');
      await renderer.device.queue.onSubmittedWorkDone();check(nativeErrors.length===0,nativeErrors.join('\n'));
    }finally{loader.dispose();renderer.dispose();}
    return {passed:true,records,checks:['Studio native SH 0-3 numeric parity','native and reference block YAML','stored/deflated/unbundled autodetection','packed/canonical Worker parity','two render methods and four lenses','GPU palette parity','limits and cancellation']};
  });
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.locator('photara-viewer').locator('[data-file]').setInputFiles(resolve('tests/fixtures/sog-xt/degree3.sog-xt'));
  await page.waitForFunction(()=>document.querySelector('photara-viewer').viewer?.modelInfo?.sourceFormat==='sog-xt');
  if(await page.locator('photara-viewer').locator('[data-file]').getAttribute('accept')!=='.ply,.sog,.sog-xt')throw new Error('File chooser lacks SOG-XT');
  result.checks.push('Viewer .sog-xt file chooser and packed upload');
  await page.evaluate(async()=>{
    const file=new File([await(await fetch('/tests/fixtures/sog-xt/degree1.sog-xt')).arrayBuffer()],'dropped.sog-xt');
    const dataTransfer=new DataTransfer();dataTransfer.items.add(file);
    document.querySelector('photara-viewer').shadowRoot.querySelector('.stage').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
  });
  await page.waitForFunction(()=>document.querySelector('photara-viewer').viewer?.modelInfo?.name==='dropped.sog-xt');
  result.checks.push('Viewer SOG-XT drag/drop');
  if(errors.length)throw new Error(errors.join('\n'));
  console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();server.close();}
