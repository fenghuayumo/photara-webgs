import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {serve} from './serve.mjs';
const args=process.argv.slice(2),option=(key,fallback)=>{const i=args.indexOf(`--${key}`);return i<0?fallback:args[i+1];};
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||resolve(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const path=option('model','D:/BaiduNetdiskDownload/1023/20261023_merged_dataset/images.cache/splat.sog'),size=(await stat(path)).size;
const manifest=JSON.parse(await readFile(option('manifest','test-results/optimization/manifest.json')));
const previous=JSON.parse(await readFile('docs/benchmarks/1023-reconstruction.json')).results;
const output=resolve(option('output','test-results/blocks.json'));
const server=serve(0),assets=createServer((req,res)=>{res.writeHead(200,{'Access-Control-Allow-Origin':'*','Content-Length':size});createReadStream(path).pipe(res);}).listen(0,'127.0.0.1');
await Promise.all([once(server,'listening'),once(assets,'listening')]);let browser;
try{
  browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--enable-unsafe-webgpu']});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://localhost:${server.address().port}/tests/compare.html`);
  const info=await page.evaluate(async ({url,views})=>{
    const {GaussianRenderer}=await import('/src/renderer.js'),{ModelLoader}=await import('/src/loader.js');
    window.gpuErrors=[];window.r=await GaussianRenderer.create(document.querySelector('canvas'),{profiling:true,onError:e=>gpuErrors.push(e.message)});
    const loader=new ModelLoader();let m;try{m=await loader.parse(await(await fetch(url)).arrayBuffer(),{shLayout:'packed'});await r.setModel(m,{spatialBlocks:false});}finally{loader.dispose();}
    const unindexed=[];
    for(const width of [960,1440])for(const view of views){
      const scale=width/view.width,camera={...view,width,height:Math.round(view.height*scale),fx:view.fx*scale,fy:view.fy*scale,cx:view.cx*scale,cy:view.cy*scale},samples=[];
      for(let i=-5;i<32;i++){const start=performance.now();r.render(camera,{renderMethod:'3dgs',filterMode:'mip2d',background:[0,0,0]});await r.device.queue.onSubmittedWorkDone();const wall_ms=performance.now()-start,timing=await r.readTimings();if(i>=0)samples.push({wall_ms,...timing});}
      unindexed.push({name:`${width}-${view.name}`,samples,summary:Object.fromEntries(Object.keys(samples[0]).map(k=>[k,[...samples].map(s=>s[k]).sort((a,b)=>a-b)[15]]))});
    }
    await r.setModel(m,{profiling:true});
    const a=await navigator.gpu.requestAdapter();return{count:r.model.count,memory:r.getMemoryUsage(),upload:r.lastUploadStats,unindexed,adapter:{vendor:a.info.vendor,architecture:a.info.architecture}};
  },{url:`http://127.0.0.1:${assets.address().port}/scene.sog`,views:manifest.views});
  const results=[];
  for(const width of [960,1440])for(const view of manifest.views){
    const scale=width/view.width,camera={...view,width,height:Math.round(view.height*scale),fx:view.fx*scale,fy:view.fy*scale,cx:view.cx*scale,cy:view.cy*scale};
    const result=await page.evaluate(async camera=>{
      const samples={off:[],on:[]},options={renderMethod:'3dgs',filterMode:'mip2d',background:[0,0,0]};
      for(let i=-5;i<32;i++)for(const blockCulling of i%2?[true,false]:[false,true]){
        const start=performance.now();r.render(camera,{...options,blockCulling});await r.device.queue.onSubmittedWorkDone();
        const wall_ms=performance.now()-start,timing=await r.readTimings();if(i>=0)samples[blockCulling?'on':'off'].push({wall_ms,...timing});
      }
      const summary=list=>Object.fromEntries(Object.keys(list[0]).map(k=>{const a=list.map(s=>s[k]).sort((a,b)=>a-b);return[k,{p50:a[15],p95:a[30]}];}));
      r.render(camera,{...options,blockCulling:false});const ref=await r.readPixels(),visibleBefore=await r.readVisibility();
      r.render(camera,{...options,blockCulling:true});const actual=await r.readPixels(),visibleAfter=await r.readVisibility(),blocks=await r.readBlockVisibility();
      let max=0;actual.forEach((v,i)=>max=Math.max(max,Math.abs(v-ref[i])));
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',actual))].map(v=>v.toString(16).padStart(2,'0')).join('');
      return{samples,summary:{off:summary(samples.off),on:summary(samples.on)},maxByte:max,hash,visibleBefore,visibleAfter,blocks,gpuErrors};
    },camera);
    const name=`${width}-${view.name}`,old=previous.find(p=>p.method==='3dgs'&&p.name===name);
    result.committedReferenceMatch=result.hash===old.fixedSHA256;
    results.push({name,...result});console.log(JSON.stringify({name,projectOff:result.summary.off.project_ms.p50,projectOn:result.summary.on.project_ms.p50,block_ms:result.summary.on.block_ms.p50,wallOff:result.summary.off.wall_ms.p50,wallOn:result.summary.on.wall_ms.p50,blocks:result.blocks,maxByte:result.maxByte,committedReferenceMatch:result.committedReferenceMatch}));
    if(result.maxByte!==0||!result.committedReferenceMatch||result.visibleBefore.visible!==result.visibleAfter.visible||result.gpuErrors.length)throw new Error('Block culling regression');
    await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify({date:'2026-11-02',browser:browser.version(),info,errors,results},null,2));
  }
  if(errors.length)throw new Error(errors.join('\n'));
}finally{await browser?.close();server.close();assets.close();}
