import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync, createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { serve } from './serve.mjs';
const args=process.argv.slice(2),option=(key,fallback)=>{const i=args.indexOf(`--${key}`);return i<0?fallback:args[i+1];};
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||resolve(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const model=resolve(option('model','D:/BaiduNetdiskDownload/1023/20261023_merged_dataset/images.cache/splat.sog'));
const manifest=JSON.parse(await readFile(option('manifest','test-results/optimization/manifest.json')));
const output=resolve(option('output','test-results/reconstruction')),frames=Number(option('frames','24'));
if(!Number.isInteger(frames)||frames<8||frames>240)throw new Error('frames must be 8–240');
const reference=JSON.parse(await readFile('docs/benchmarks/1023-sog-loading.json')).records[0].images;
const size=(await stat(model)).size;
const server=serve(0),assets=createServer((req,res)=>{res.writeHead(200,{'Access-Control-Allow-Origin':'*','Content-Length':size});createReadStream(model).pipe(res);}).listen(0,'127.0.0.1');
await Promise.all([once(server,'listening'),once(assets,'listening')]);
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--enable-unsafe-webgpu']});
  const page=await browser.newPage();page.setDefaultTimeout(180000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/tests/compare.html`);
  const info=await page.evaluate(async url=>{
    const {GaussianRenderer}=await import('/src/renderer.js'),{ModelLoader}=await import('/src/loader.js');
    window.gpuErrors=[];window.r=await GaussianRenderer.create(document.querySelector('canvas'),{profiling:true,onError:e=>gpuErrors.push(e.message)});
    const loader=new ModelLoader();try{const m=await loader.parse(await(await fetch(url)).arrayBuffer(),{shLayout:'packed'});await r.setModel(m);}finally{loader.dispose();}
    const a=await navigator.gpu.requestAdapter();return{count:r.model.count,adapter:{vendor:a.info.vendor,architecture:a.info.architecture},browser:navigator.userAgent};
  },`http://127.0.0.1:${assets.address().port}/scene.sog`);
  await mkdir(output,{recursive:true});const results=[];
  for(const method of option('methods','3dgs,3dgut').split(','))for(const width of option('widths','960,1440').split(',').map(Number))for(const view of manifest.views.slice(0,Number(option('views','3')))){
    const scale=width/view.width,camera={...view,width,height:Math.round(view.height*scale),fx:view.fx*scale,fy:view.fy*scale,cx:view.cx*scale,cy:view.cy*scale};
    const data=await page.evaluate(async({camera,method,frames})=>{
      const {cameraPosition,lookAtCV}=await import('/src/camera.js');
      const options={renderMethod:method,filterMode:'mip2d',background:[0,0,0]};
      const eye=cameraPosition(camera.worldToCamera),v=camera.worldToCamera,f=[v[2],v[6],v[10]],right=[v[0],v[4],v[8]];
      const trajectory=Array.from({length:frames+8},(_,i)=>{
        const t=i/(frames+7)*Math.PI*2,p=eye.map((x,a)=>x+right[a]*.15*Math.sin(t)+f[a]*.05*Math.sin(2*t));
        const c={...camera,worldToCamera:lookAtCV(p,eye.map((x,a)=>x+f[a]*2))};delete c.position;return c;
      });
      const modes=['sorted','none','spatial','temporal'],timings={},quality={},images={};
      const percentile=(values,p)=>{const a=[...values].sort((a,b)=>a-b);return a[Math.min(a.length-1,Math.ceil(a.length*p)-1)];};
      // Each mode traverses uninterrupted history. Sorted/raw between temporal
      // frames would reset history and invalidate the comparison.
      for(const mode of modes){
        r.reconstruction.reset();const samples=[];
        for(let i=0;i<trajectory.length;i++){
          const start=performance.now();r.render(trajectory[i],{...options,transparency:mode==='sorted'?'sorted':'stochastic',reconstruction:mode==='sorted'?'none':mode,stochasticSeed:i});
          await r.device.queue.onSubmittedWorkDone();const wall_ms=performance.now()-start,stages=await r.readTimings();
          if(i>=8)samples.push({wall_ms,...stages});
        }
        timings[mode]={samples,summary:Object.fromEntries(Object.keys(samples[0]).map(k=>[k,{p50:percentile(samples.map(s=>s[k]),.5),p95:percentile(samples.map(s=>s[k]),.95)}]))};
      }
      // Separate quality run: readback does not contaminate timing samples.
      const references=[];
      for(let i=0;i<trajectory.length;i++){r.render(trajectory[i],options);references.push(await r.readPixels());}
      const gradients=pixels=>{
        let sum=0;for(let y=1;y<camera.height-1;y++)for(let x=1;x<camera.width-1;x++)for(let a=0;a<3;a++){
          const i=(y*camera.width+x)*4+a;sum+=Math.abs(pixels[i+4]-pixels[i-4])+Math.abs(pixels[i+camera.width*4]-pixels[i-camera.width*4]);
        }return sum;
      };
      for(const mode of modes.slice(1)){
        r.reconstruction.reset();const samples=[];
        for(let i=0;i<trajectory.length;i++){
          r.render(trajectory[i],{...options,transparency:'stochastic',reconstruction:mode,stochasticSeed:i});const pixels=await r.readPixels({exact:false}),ref=references[i];
          if(i>=8){let error=0,edgeError=0,edgeCount=0;
            for(let y=1;y<camera.height-1;y++)for(let x=1;x<camera.width-1;x++)for(let a=0;a<3;a++){
              const k=(y*camera.width+x)*4+a,d=Math.abs(pixels[k]-ref[k]);error+=d;
              if(Math.abs(ref[k+4]-ref[k-4])+Math.abs(ref[k+camera.width*4]-ref[k-camera.width*4])>40){edgeError+=d;edgeCount++;}
            }
            samples.push({mae:error/((camera.width-2)*(camera.height-2)*3),edgeMAE:edgeError/Math.max(1,edgeCount),gradientRatio:gradients(pixels)/Math.max(1,gradients(ref))});
          }
          if(i===trajectory.length-1)images[mode]=pixels;
        }
        quality[mode]={samples,mean:Object.fromEntries(Object.keys(samples[0]).map(k=>[k,samples.reduce((s,a)=>s+a[k],0)/samples.length]))};
      }
      images.sorted=references.at(-1);
      // The last moving view must recover exactly when capture requests sorted.
      const restored=await r.readPixels();let restoredMaxByte=0;
      restored.forEach((v,i)=>restoredMaxByte=Math.max(restoredMaxByte,Math.abs(v-images.sorted[i])));
      r.render(camera,options);const fixed=await r.readPixels(),hash=await crypto.subtle.digest('SHA-256',fixed);
      const montage=document.createElement('canvas');montage.width=camera.width*2;montage.height=(camera.height+30)*2;const ctx=montage.getContext('2d');
      modes.forEach((mode,index)=>{const x=index%2*camera.width,y=Math.floor(index/2)*(camera.height+30);ctx.fillStyle='#14252a';ctx.fillRect(x,y,camera.width,30);ctx.fillStyle='white';ctx.font='18px sans-serif';ctx.fillText(mode,x+10,y+22);ctx.putImageData(new ImageData(new Uint8ClampedArray(images[mode]),camera.width,camera.height),x,y+30);});
      return{timings,quality,restoredMaxByte,fixedSHA256:[...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join(''),memory:r.getMemoryUsage(),gpuErrors,montage:montage.toDataURL('image/png').split(',')[1]};
    },{camera,method,frames});
    const name=`${width}-${view.name}`,png=data.montage;delete data.montage;
    if(method==='3dgut')data.committedReferenceMatch=reference.find(image=>image.name===name)?.sha256===data.fixedSHA256;
    if(data.restoredMaxByte!==0||data.committedReferenceMatch===false||data.gpuErrors.length)throw new Error('Exact/GPU regression');
    results.push({method,name,...data});await writeFile(resolve(output,`${method}-${name}.png`),Buffer.from(png,'base64'));
    await writeFile(resolve(output,'report.json'),JSON.stringify({info,frames,notes:'Consecutive short trajectories per mode; timings exclude readback; quality uses a separate run. Edge MAE includes noise and blur, gradient ratio alone is not a detail score. Synthetic disocclusion assertions are in tests/gpu.js.',errors,results},null,2));
    console.log(JSON.stringify({method,name,wall:Object.fromEntries(Object.entries(data.timings).map(([k,v])=>[k,v.summary.wall_ms.p50])),quality:Object.fromEntries(Object.entries(data.quality).map(([k,v])=>[k,v.mean])),restore:data.restoredMaxByte}));
  }
  if(errors.length)throw new Error(errors.join('\n'));
}finally{await browser?.close();server.close();assets.close();}
