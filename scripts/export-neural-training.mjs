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
const output=resolve(option('output','test-results/neural-training'));
const exportWidth=Number(option('width','320'));
if(!Number.isInteger(exportWidth)||exportWidth<32||exportWidth>4096)throw new Error('width must be 32–4096');
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
  await mkdir(output,{recursive:true});
  for(const [viewIndex,view] of manifest.views.entries()){
    const width=exportWidth,scale=width/view.width;
    const camera={...view,width,height:Math.round(view.height*scale),fx:view.fx*scale,fy:view.fy*scale,cx:view.cx*scale,cy:view.cy*scale};
    for(let sample=0;sample<12;sample++){
      const data=await page.evaluate(async({camera,sample})=>{
        const c={...camera,worldToCamera:[...camera.worldToCamera]};
        delete c.position;
        c.worldToCamera[12]+=(sample%4-1.5)*.03;c.worldToCamera[13]+=(Math.floor(sample/4)-1)*.025;
        const png=pixels=>{const canvas=document.createElement('canvas');canvas.width=c.width;canvas.height=c.height;canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels),c.width,c.height),0,0);return canvas.toDataURL('image/png').split(',')[1];};
        r.render(c,{renderMethod:'3dgs',filterMode:'mip2d',background:[0,0,0]});const target=png(await r.readPixels());
        r.render(c,{renderMethod:'3dgs',filterMode:'mip2d',background:[0,0,0],transparency:'stochastic',reconstruction:'none',stochasticSeed:1000+sample});
        return {target,noisy:png(await r.readPixels({exact:false}))};
      },{camera,sample});
      for(const kind of ['target','noisy'])await writeFile(resolve(output,`${viewIndex}-${sample}-${kind}.png`),Buffer.from(data[kind],'base64'));
    }
    console.log(`Exported training view ${viewIndex}`);
  }
  await writeFile(resolve(output,'manifest.json'),JSON.stringify({width:exportWidth,samplesPerView:12,seeds:[1000,1011],trainViews:[0,1],validationView:2,info},null,2));
  if(errors.length)throw new Error(errors.join('\n'));
}finally{await browser?.close();server.close();assets.close();}
