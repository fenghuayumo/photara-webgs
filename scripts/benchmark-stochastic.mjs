import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync, createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { serve } from './serve.mjs';
const args=process.argv.slice(2), option=(key,fallback)=>{const i=args.indexOf(`--${key}`);return i<0?fallback:args[i+1];};
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||resolve(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const modelPath=resolve(option('model','D:/BaiduNetdiskDownload/1023/20261023_merged_dataset/images.cache/splat.sog'));
const manifest=JSON.parse(await readFile(option('manifest','test-results/optimization/manifest.json')));
const referencePath=option('reference','docs/benchmarks/1023-sog-loading.json');
const reference=existsSync(referencePath)?JSON.parse(await readFile(referencePath)).records[0].images:null;
const output=resolve(option('output','test-results/stochastic.json')), frames=Number(option('frames','32'));
if(!Number.isInteger(frames)||frames<8||frames>240)throw new Error('frames must be 8–240');
const size=(await stat(modelPath)).size;
const server=serve(0),assets=createServer((req,res)=>{res.writeHead(200,{'Access-Control-Allow-Origin':'*','Content-Type':'application/octet-stream','Content-Length':size});createReadStream(modelPath).pipe(res);}).listen(0,'127.0.0.1');
await Promise.all([once(server,'listening'),once(assets,'listening')]);
let browser;
try {
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||(existsSync(edge)?edge:undefined),headless:true,args:['--enable-unsafe-webgpu']});
  const page=await browser.newPage();page.setDefaultTimeout(180000);const errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://localhost:${server.address().port}/tests/compare.html`);
  const info=await page.evaluate(async url=>{
    const {GaussianRenderer}=await import('/src/renderer.js'),{ModelLoader}=await import('/src/loader.js');
    window.gpuErrors=[];window.renderer=await GaussianRenderer.create(document.querySelector('canvas'),{profiling:true,onError:e=>gpuErrors.push(e.message)});
    const loader=new ModelLoader();try{const model=await loader.parse(await(await fetch(url)).arrayBuffer(),{shLayout:'packed'});await renderer.setModel(model);}finally{loader.dispose();}
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    return{count:renderer.model.count,bases:renderer.model.bases,adapter:adapter.info?{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description}:null,timestamps:renderer.profiling};
  },`http://127.0.0.1:${assets.address().port}/scene.sog`);
  const results=[];
  for(const method of ['3dgs','3dgut'])for(const width of [960,1440])for(const view of manifest.views){
    const scale=width/view.width,camera={...view,width,height:Math.round(view.height*scale),fx:view.fx*scale,fy:view.fy*scale,cx:view.cx*scale,cy:view.cy*scale};
    const result=await page.evaluate(async({camera,method,frames,cell})=>{
      const {cameraPosition,lookAtCV}=await import('/src/camera.js');
      const options={renderMethod:method,filterMode:'mip2d',background:[0,0,0]},r=renderer;
      const eye=cameraPosition(camera.worldToCamera),v=camera.worldToCamera,forward=[v[2],v[6],v[10]],right=[v[0],v[4],v[8]];
      const trajectory=Array.from({length:frames+4},(_,i)=>{
        const t=(i-4)/Math.max(1,frames-1)*Math.PI*2;
        const p=eye.map((x,a)=>x+right[a]*.15*Math.sin(t)+forward[a]*.05*Math.sin(2*t));
        const moved={...camera,worldToCamera:lookAtCV(p,eye.map((x,a)=>x+forward[a]*2))};delete moved.position;return moved;
      });
      const samples={sorted:[],stochastic:[]};
      // Alternate order per frame and per cell. Explicit GPU completion bounds
      // each sample; these are synchronized wall times, not browser RAF FPS.
      for(let i=0;i<trajectory.length;i++)for(const transparency of (i+cell)%2?['stochastic','sorted']:['sorted','stochastic']){
        const start=performance.now();r.render(trajectory[i],{...options,transparency,stochasticSeed:i});const submitted=performance.now();
        await r.device.queue.onSubmittedWorkDone();const completed=performance.now(),gpu=await r.readTimings();
        if(i>=4)samples[transparency].push({encode_ms:submitted-start,wall_ms:completed-start,...gpu});
      }
      const summarize=list=>Object.fromEntries(Object.keys(list[0]).map(key=>{const a=list.map(s=>s[key]).sort((x,y)=>x-y),percentile=p=>a[Math.min(a.length-1,Math.ceil(a.length*p)-1)];return[key,{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)}];}));
      r.render(camera,options);const exact=await r.readPixels();
      r.render(camera,{...options,transparency:'stochastic',stochasticSeed:123});const approximate=await r.readPixels({exact:false});
      const timing=await r.readTimings(),stochasticMemory=r.getMemoryUsage();
      const hit=await r.pick(camera.width/2,camera.height/2);
      const restored=await r.readPixels();let max=0,sum=0,noise=0;
      for(let i=0;i<exact.length;i++){max=Math.max(max,Math.abs(exact[i]-restored[i]));if(i%4!==3){sum+=Math.abs(exact[i]-approximate[i]);noise+=exact[i]!==approximate[i];}}
      const hash=async pixels=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].map(v=>v.toString(16).padStart(2,'0')).join('');
      const stats=await r.readVisibility();
      return{variants:{sorted:summarize(samples.sorted),stochastic:summarize(samples.stochastic)},samples,
        restoredMaxByte:max,sortedSHA256:await hash(exact),restoredSHA256:await hash(restored),singleSampleMAE:sum/(exact.length*.75),noisyChannels:noise,
        stochasticSort_ms:timing?.sort_ms,stochasticMemory,hit,visible:stats.visible,gpuErrors};
    },{camera,method,frames,cell:results.length});
    const name=`${width}-${view.name}`,old=method==='3dgut'&&reference?.find(image=>image.name===name);
    if(old)result.committedReferenceMatch=old.sha256===result.sortedSHA256;
    results.push({method,name,...result});
    console.log(JSON.stringify({method,name,sorted:result.variants.sorted.wall_ms,stochastic:result.variants.stochastic.wall_ms,drawSorted:result.variants.sorted.draw_ms,drawStochastic:result.variants.stochastic.draw_ms,restoredMaxByte:result.restoredMaxByte,singleSampleMAE:result.singleSampleMAE,committedReferenceMatch:result.committedReferenceMatch}));
    if(result.restoredMaxByte!==0||result.committedReferenceMatch===false||result.gpuErrors.length)throw new Error('Exact image regression or GPU error');
    await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify({date:'2026-11-02',browser:browser.version(),model:modelPath,info,framesPerVariant:frames,notes:'Deterministic short local camera trajectories; alternating modes, synchronized GPU completion, explicit timing readback outside wall interval. Not RAF FPS. Single-sample MAE is intentionally approximate movement quality. Static GUT hashes also compared with committed pre-stochastic loading benchmark.',errors,results},null,2));
  }
  if(errors.length)throw new Error(errors.join('\n'));
  console.log(`Exact restores and committed GUT hashes passed. ${output}`);
}finally{await browser?.close();server.close();assets.close();}
