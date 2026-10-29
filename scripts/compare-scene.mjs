import { writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';
import { cameraPosition } from '../src/camera.js';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readColmapCameras } from './colmap-cameras.mjs';

const args=process.argv.slice(2), option=(name,fallback)=>{const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];};
const modelPath=resolve(option('model','D:/ScanVideo/chuan/images.cache/splat.ply'));
const sparse=resolve(option('sparse','D:/ScanVideo/chuan/sparse/0'));
const output=resolve(option('output','test-results/real-scene'));
const width=Number(option('width','960')), limit=Number(option('limit','0')), samples=Number(option('samples','7'));
const methods=option('methods','3dgs,3dgut').split(','), modes=option('modes','pinhole,orthographic,fisheye,equirectangular').split(',');
const countViews=Number(option('views','3'));
const baselineRef=args.includes('--baseline')?option('baseline-ref','f1a5fb9'):null;
if(baselineRef)execFileSync('git',['rev-parse','--verify',baselineRef],{stdio:'pipe'});
await mkdir(output,{recursive:true});
const {cameras,images}=await readColmapCameras(sparse);
const views=[];
for(let vi=0;vi<countViews;vi++){
  const row=images[Math.round(vi*(images.length-1)/Math.max(1,countViews-1))];
  let [w,x,y,z]=row.q;const n=Math.hypot(w,x,y,z);[w,x,y,z]=[w/n,x/n,y/n,z/n];
  const R=[1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y),2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x),2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)];
  const worldToCamera=[R[0],R[3],R[6],0,R[1],R[4],R[7],0,R[2],R[5],R[8],0,...row.t,1];
  const source=cameras.get(row.cameraId),panorama=source.model==='EQUIRECTANGULAR';
  if(!['SIMPLE_PINHOLE','PINHOLE','EQUIRECTANGULAR'].includes(source.model))throw new Error(`Unsupported source camera ${source.model}`);
  const [fx,fy,cx,cy]=panorama?[source.width/(2*Math.PI),source.height/Math.PI,source.width/2,source.height/2]:source.model==='SIMPLE_PINHOLE'?[source.p[0],source.p[0],source.p[1],source.p[2]]:source.p;
  for(const model of modes){
    const height=model==='equirectangular'?Math.round(width/2):Math.round(width*(panorama?9/16:source.height/source.width));
    const camera={name:`view${vi}-${model}`,sourceImage:row.name,sourceCameraModel:source.model,worldToCamera,position:cameraPosition(worldToCamera),width,height,
      fx:fx*width/source.width,fy:fy*height/source.height,cx:cx*width/source.width,cy:cy*height/source.height,near:.01,model,distortion:[0,0,0,0]};
    if(panorama&&model==='pinhole')Object.assign(camera,{fx:height*.95,fy:height*.95,cx:width/2,cy:height/2});
    if(model==='equirectangular')Object.assign(camera,{fx:width/(2*Math.PI),fy:height/Math.PI,cx:width/2,cy:height/2});
    if(model==='fisheye')Object.assign(camera,{fx:width/Math.PI,fy:width/Math.PI,cx:width/2,cy:height/2,distortion:[.05,-.01,.002,0]});
    if(model==='orthographic')Object.assign(camera,{fx:height/10,fy:height/10,cx:width/2,cy:height/2});
    views.push(camera);
  }
}
const manifest={modelPath,methods,views,samples,...(limit?{limit}:{}),...(baselineRef?{baselineRef}:{})};
await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2));
if(args.includes('--manifest-only'))process.exit(0);
const require=createRequire(import.meta.url);
let chromium;try{({chromium}=await import('playwright'));}catch{({chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||resolve(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')));}
// Use free loopback ports so comparison runs can coexist with Studio tools.
const server=serve(Number(option('port','0')));
let origin;
const assetServer=createServer((req,res)=>{
  if(req.url!=='/scene.ply'){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'application/octet-stream','Access-Control-Allow-Origin':origin});
  createReadStream(modelPath).pipe(res);
}).listen(Number(option('asset-port','0')),'127.0.0.1');
await Promise.all([once(server,'listening'),once(assetServer,'listening')]);
origin=`http://localhost:${server.address().port}`;
const sceneUrl=`http://127.0.0.1:${assetServer.address().port}/scene.ply`;
const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let browser;
try{
  browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||(existsSync(edge)?edge:undefined),headless:true,args:['--enable-unsafe-webgpu']});
  const page=await browser.newPage({viewport:{width:Math.max(width,800),height:800}});
  if(baselineRef) await page.route('**/src/**',async route=>{
    const path=new URL(route.request().url()).pathname.slice(1);
    try{const body=execFileSync('git',['show',`${baselineRef}:${path}`],{maxBuffer:1024*1024});await route.fulfill({body,contentType:path.endsWith('.js')?'text/javascript':'text/plain'});}
    catch{await route.continue();}
  });
  page.setDefaultTimeout(180000);page.on('pageerror',e=>console.error(e));
  await page.goto(`${origin}/tests/compare.html`);
  const info=await page.evaluate(async ({limit,sceneUrl})=>{
    const {GaussianRenderer}=await import('../src/renderer.js'),{parsePly}=await import('../src/ply.js');
    window.renderer=await GaussianRenderer.create(document.querySelector('canvas'),{profiling:true,onError:e=>{window.gpuErrors.push(e.message);}});
    const start=performance.now();window.scene=parsePly(await(await fetch(sceneUrl)).arrayBuffer());
    const sourceCount=scene.count;
    if(limit&&limit<scene.count){scene.count=limit;scene.data=scene.data.slice(0,limit*12);scene.sh=scene.sh.slice(0,limit*scene.bases*3);}
    await renderer.setModel(scene);await renderer.device.queue.onSubmittedWorkDone();
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    return {sourceCount,count:scene.count,renderMethod:scene.renderMethod,filterMode:scene.filterMode,bases:scene.bases,load_ms:performance.now()-start,adapter:adapter.info?{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description}:null};
  },{limit,sceneUrl});
  console.log(JSON.stringify(info));
  const results=[];
  for(const method of methods)for(const camera of views){
    const result=await page.evaluate(async ({camera,method,samples})=>{
      const times=[],gpu=[];
      for(let i=-2;i<samples;i++){
        await renderer.device.queue.onSubmittedWorkDone();const start=performance.now();
        renderer.render(camera,{renderMethod:method,background:[0,0,0]});await renderer.device.queue.onSubmittedWorkDone();
        if(i>=0){times.push(performance.now()-start);if(renderer.readTimings)gpu.push(await renderer.readTimings());}
      }
      const rgba=await renderer.readPixels(), rgb=new Uint8Array(camera.width*camera.height*3);
      for(let i=0;i<rgb.length/3;i++)rgb.set(rgba.subarray(i*4,i*4+3),i*3);
      let binary='';for(let i=0;i<rgb.length;i+=32768)binary+=String.fromCharCode(...rgb.subarray(i,i+32768));
      const sorted=[...times].sort((a,b)=>a-b);
      const gpu_median_ms=Object.fromEntries(['rays_ms','project_ms','sort_ms','draw_ms'].map(key=>[key,gpu.length&&gpu[0]?gpu.map(v=>v[key]).sort((a,b)=>a-b)[Math.floor(gpu.length/2)]:null]));
      return{samples_ms:times,median_ms:sorted[Math.floor(sorted.length/2)],gpu_median_ms,image:btoa(binary),gpuErrors};
    },{camera,method,samples});
    const name=`${method}-${camera.name}`,{image,...timing}=result;
    if(timing.gpuErrors.length)throw new Error(timing.gpuErrors.join('\n'));
    await writeFile(resolve(output,`${name}.ppm`),Buffer.concat([Buffer.from(`P6\n${camera.width} ${camera.height}\n255\n`),Buffer.from(image,'base64')]));
    results.push({name,...timing});console.log(`${name} ${timing.median_ms.toFixed(2)} ms`);
    await writeFile(resolve(output,'timings.json'),JSON.stringify({info,measurements:results},null,2));
  }
}finally{await browser?.close();server.close();assetServer.close();}
