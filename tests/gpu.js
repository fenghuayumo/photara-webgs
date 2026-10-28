import { GaussianRenderer } from '../src/renderer.js';
import { SH_C0 } from '../src/model.js';
import { lookAtCV, cameraPosition } from '../src/camera.js';
import { GaussianViewer } from '../src/viewer.js';

const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const errors=[],results=[];
function model(items, renderMethod='3dgs',filterMode='classic',bases=1) {
  const data=new Float32Array(items.length*12),sh=new Float32Array(items.length*bases*3);
  items.forEach((g,i)=>{
    const q=g.q||[1,0,0,0],n=Math.hypot(...q);
    data.set([...g.p,g.alpha||.7,...g.s,0,...q.map(x=>x/n)],i*12);
    sh.set((g.color||[.8,.2,.4]).map(c=>(c-.5)/SH_C0),i*bases*3);
    if(g.sh)sh.set(g.sh,i*bases*3);
  });
  return{count:items.length,bases,data,sh,renderMethod,filterMode};
}
const cam={worldToCamera:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),width:65,height:57,fx:60,fy:56,cx:31,cy:26,near:.01,model:'pinhole'};

// Independent double precision reference: quaternion matrix, explicit covariance,
// front-to-back transmittance and local-space closest-point ray response.
function oracle(m,camera,x,y) {
  const v=camera.worldToCamera, eye=cameraPosition(v),mode=camera.model;
  const view=p=>[0,1,2].map(a=>v[a]*p[0]+v[a+4]*p[1]+v[a+8]*p[2]+v[a+12]);
  const rotateView=p=>[0,1,2].map(a=>v[a]*p[0]+v[a+4]*p[1]+v[a+8]*p[2]);
  const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  let rgb=[0,0,0],T=1;
  const order=Array.from({length:m.count},(_,i)=>i).sort((a,b)=>{
    const ca=view(m.data.subarray(a*12,a*12+3)),cb=view(m.data.subarray(b*12,b*12+3));
    return m.renderMethod==='3dgut'||mode==='equirectangular'?dot(ca,ca)-dot(cb,cb):ca[2]-cb[2];
  });
  for(const id of order){
    const g=m.data.subarray(id*12,id*12+12), t=view(g.subarray(0,3)),s=g.subarray(4,7);
    const [w,qx,qy,qz]=g.subarray(8,12);
    const axes=[
      [1-2*(qy*qy+qz*qz),2*(qx*qy+w*qz),2*(qx*qz-w*qy)],
      [2*(qx*qy-w*qz),1-2*(qx*qx+qz*qz),2*(qy*qz+w*qx)],
      [2*(qx*qz+w*qy),2*(qy*qz-w*qx),1-2*(qx*qx+qy*qy)],
    ].map(rotateView);
    let distance,opacity=g[3];
    if(m.renderMethod==='3dgut'){
      const u=(x-camera.cx)/camera.fx, vv=(y-camera.cy)/camera.fy;
      let ray=[u,vv,1],offset=[0,0,0];
      if(mode==='orthographic'){ray=[0,0,1];offset=[u,vv,0];}
      if(mode==='equirectangular')ray=[Math.cos(vv)*Math.sin(u),Math.sin(vv),Math.cos(vv)*Math.cos(u)];
      if(mode==='fisheye'){
        const r=Math.hypot(u,vv),k=camera.distortion||[0,0,0,0];let lo=0,hi=Math.PI/2;
        for(let i=0;i<40;i++){const z=(lo+hi)/2,qq=z*z,td=z*(1+qq*(k[0]+qq*(k[1]+qq*(k[2]+qq*k[3]))));if(td<r)lo=z;else hi=z;}
        const th=(lo+hi)/2,f=r>1e-8?Math.sin(th)/r:1;ray=[u*f,vv*f,Math.cos(th)];
      }
      const o=axes.map((a,i)=>dot(a,offset.map((z,j)=>z-t[j]))/s[i]);
      const d=axes.map((a,i)=>dot(a,ray)/s[i]);const peak=-dot(o,d)/dot(d,d);if(peak<=0)continue;
      distance=o.reduce((sum,z,i)=>sum+(z+peak*d[i])**2,0);
    }else{
      let px=camera.fx*t[0]/t[2]+camera.cx,py=camera.fy*t[1]/t[2]+camera.cy;
      let du=[camera.fx/t[2],0,-camera.fx*t[0]/t[2]**2],dv=[0,camera.fy/t[2],-camera.fy*t[1]/t[2]**2];
      if(mode==='orthographic'){px=camera.fx*t[0]+camera.cx;py=camera.fy*t[1]+camera.cy;du=[camera.fx,0,0];dv=[0,camera.fy,0];}
      if(mode==='fisheye'||mode==='equirectangular'){
        const project=p=>{
          if(mode==='equirectangular')return[camera.fx*Math.atan2(p[0],p[2])+camera.cx,camera.fy*Math.atan2(p[1],Math.hypot(p[0],p[2]))+camera.cy];
          const r=Math.hypot(p[0],p[1]),th=Math.atan2(r,p[2]),q=th*th,k=camera.distortion||[0,0,0,0],td=th*(1+q*(k[0]+q*(k[1]+q*(k[2]+q*k[3]))));
          return[camera.fx*p[0]*td/r+camera.cx,camera.fy*p[1]*td/r+camera.cy];
        };
        [px,py]=project(t);
        for(let axis=0;axis<3;axis++){
          const plus=[...t],minus=[...t],h=1e-5;plus[axis]+=h;minus[axis]-=h;
          const a=project(plus),b=project(minus);let dx=a[0]-b[0];
          if(mode==='equirectangular')dx-=Math.round(dx/camera.width)*camera.width;
          du[axis]=dx/(2*h);dv[axis]=(a[1]-b[1])/(2*h);
        }
      }
      const ua=axes.map((a,i)=>dot(a,du)*s[i]),va=axes.map((a,i)=>dot(a,dv)*s[i]);
      let a=dot(ua,ua),b=dot(ua,va),c=dot(va,va);const det0=Math.max(1e-6,a*c-b*b);
      const mip=m.filterMode==='mip2d'||m.filterMode==='mip',k=mip?.1:.3;a+=k;c+=k;
      const det=a*c-b*b;if(mip)opacity*=Math.sqrt(det0/Math.max(1e-6,det));
      let dx=x-px;const dy=y-py;if(mode==='equirectangular')dx-=Math.round(dx/camera.width)*camera.width;distance=(c*dx*dx-2*b*dx*dy+a*dy*dy)/det;
    }
    const alpha=Math.min(.99,opacity*Math.exp(-.5*distance));if(alpha<1/255)continue;
    const color=[0,1,2].map(a=>.5+SH_C0*m.sh[id*m.bases*3+a]);
    for(let a=0;a<3;a++)rgb[a]+=T*alpha*color[a];T*=1-alpha;
  }
  return rgb.map(x=>Math.round(Math.max(0,Math.min(1,x))*255));
}
async function test(name,fn){await fn();results.push({name,status:'passed'});document.querySelector('#results').textContent=JSON.stringify(results,null,2);}

try{
  const r=await GaussianRenderer.create(document.querySelector('#canvas'),{onError:e=>errors.push(e.message)});
  const scene=[{p:[-.12,.08,2],s:[.36,.28,.2],q:[.98,.08,-.12,.09],alpha:.88,color:[.8,.2,.4]},{p:[.2,-.1,2.6],s:[.4,.3,.25],alpha:.65,color:[.1,.6,.3]}];
  for(const method of ['3dgs','3dgut'])for(const filter of ['classic','mip2d','mip3d','mip'])await test(`${method} ${filter}: pixels vs independent double oracle`,async()=>{
    const m=model(scene,method,filter);await r.setModel(m);r.render(cam,{background:[0,0,0]});const pixels=await r.readPixels();
    let maxError=0;
    for(let y=9;y<48;y+=3)for(let x=10;x<55;x+=3){const expected=oracle(m,cam,x,y);for(let a=0;a<3;a++)maxError=Math.max(maxError,Math.abs(pixels[(y*cam.width+x)*4+a]-expected[a]));}
    assert(maxError<=2,`Pixel mismatch, max ${maxError}`);
  });
  await test('Nonidentity extrinsics, rotated anisotropic GUT Gaussian',async()=>{
    const c={...cam,worldToCamera:lookAtCV([.5,-.3,-1],[0,0,2])};const m=model(scene,'3dgut');await r.setModel(m);r.render(c,{background:[0,0,0]});const p=await r.readPixels();
    for(const [x,y]of[[31,26],[25,20],[38,32]]){const expected=oracle(m,c,x,y);for(let a=0;a<3;a++)assert(Math.abs(p[(y*c.width+x)*4+a]-expected[a])<=2,'Extrinsic/quaternion mismatch');}
  });
  for(const method of ['3dgs','3dgut'])await test(`${method} orthographic camera`,async()=>{
    const c={...cam,model:'orthographic',fx:30,fy:28};const m=model(scene,method);await r.setModel(m);r.render(c,{background:[0,0,0]});const p=await r.readPixels();
    for(const [x,y]of[[31,26],[25,20],[38,32]]){const expected=oracle(m,c,x,y);for(let a=0;a<3;a++)assert(Math.abs(p[(y*c.width+x)*4+a]-expected[a])<=2,'Orthographic mismatch');}
  });
  for(const mode of ['fisheye','equirectangular'])await test(`GUT ${mode} ray response`,async()=>{
    const c={...cam,model:mode,distortion:[.05,-.01,.002,0]};
    if(mode==='equirectangular')Object.assign(c,{fx:c.width/(2*Math.PI),fy:c.height/Math.PI,cx:c.width/2,cy:c.height/2});
    const m=model(scene,'3dgut');await r.setModel(m);r.render(c,{background:[0,0,0]});const p=await r.readPixels();
    for(const [x,y]of[[31,26],[28,24],[34,30]]){const expected=oracle(m,c,x,y);for(let a=0;a<3;a++)assert(Math.abs(p[(y*c.width+x)*4+a]-expected[a])<=2,`${mode} mismatch`);}
  });
  for(const mode of ['fisheye','equirectangular'])await test(`3DGS ${mode}: covariance vs numerical Jacobian`,async()=>{
    const c={...cam,model:mode,distortion:[.05,-.01,.002,0]};
    if(mode==='equirectangular')Object.assign(c,{fx:c.width/(2*Math.PI),fy:c.height/Math.PI,cx:c.width/2,cy:c.height/2});
    const m=model(scene,'3dgs','mip');await r.setModel(m);r.render(c,{background:[0,0,0]});const p=await r.readPixels();
    for(let y=19;y<35;y+=3)for(let x=23;x<42;x+=3){const expected=oracle(m,c,x,y);for(let a=0;a<3;a++)assert(Math.abs(p[(y*c.width+x)*4+a]-expected[a])<=2,`${mode} EWA mismatch`);}
  });
  await test('Panorama seam copies do not double-blend a very wide ellipse',async()=>{
    const c={...cam,model:'equirectangular',fx:cam.width/(2*Math.PI),fy:cam.height/Math.PI,cx:cam.width/2,cy:cam.height/2};
    const m=model([{p:[.02,.05,-2],s:[4,2,1],alpha:.8,color:[.3,.7,.9]}]);await r.setModel(m);r.render(c,{background:[0,0,0]});const p=await r.readPixels();
    for(let x=0;x<c.width;x+=3){const expected=oracle(m,c,x,28);for(let a=0;a<3;a++)assert(Math.abs(p[(28*c.width+x)*4+a]-expected[a])<=2,`Seam duplicate at ${x}`);}
  });
  await test('GUT near-camera support remains conservative',async()=>{
    const m=model([{p:[.15,.1,.25],s:[.35,.4,.3],q:[.8,.1,.2,.3],alpha:.85}],'3dgut');await r.setModel(m);r.render(cam,{background:[0,0,0]});const p=await r.readPixels();
    for(let y=0;y<cam.height;y+=5)for(let x=0;x<cam.width;x+=5){const expected=oracle(m,cam,x,y);for(let a=0;a<3;a++)assert(Math.abs(p[(y*cam.width+x)*4+a]-expected[a])<=2,'GUT clipped support');}
  });
  for(const count of [777,65617])await test(`GPU radix stability: ${count} entries, partial group, culled keys`,async()=>{
    const items=Array.from({length:count},(_,i)=>({p:[0,0,i%19===0?-1:1+((i*167)%149)/50],s:[.02,.02,.02]}));const m=model(items);await r.setModel(m);r.render(cam);
    const output=r.device.createBuffer({size:m.count*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=r.device.createCommandEncoder();encoder.copyBufferToBuffer(r.state.keys[0],0,output,0,m.count*8);r.device.queue.submit([encoder.finish()]);await output.mapAsync(GPUMapMode.READ);
    const got=new Uint32Array(output.getMappedRange()).slice();output.destroy();
    const expected=Array.from({length:m.count},(_,i)=>i).sort((a,b)=>{
      const za=m.data[a*12+2],zb=m.data[b*12+2];return(za<0?Infinity:-za)-(zb<0?Infinity:-zb)||a-b;
    });
    expected.forEach((id,i)=>assert(got[i*2+1]===id,`Sort mismatch at ${i}: ${got[i*2+1]} vs ${id}`));
  });
  await test('SH direction and non-DC basis order',async()=>{
    const coefficients=[0,0,0,.2,0,0,0,.3,0,0,0,.4];const g={p:[.2,.1,2],s:[.2,.2,.2],alpha:.8,sh:coefficients};const m=model([g],'3dgs','classic',4);await r.setModel(m);r.render(cam,{background:[0,0,0]});const pixels=await r.readPixels();
    const norm=Math.hypot(...g.p),d=g.p.map(x=>x/norm),center=[37,29],i=(center[1]*cam.width+center[0])*4;
    // Recover alpha using a second DC-only render with known white color.
    const white=model([{...g,sh:undefined,color:[1,1,1]}]);await r.setModel(white);r.render(cam,{background:[0,0,0]});const wp=await r.readPixels();const alpha=wp[i]/255;
    const expected=[.5-.4886025119029199*d[1]*.2,.5+.4886025119029199*d[2]*.3,.5-.4886025119029199*d[0]*.4];
    expected.forEach((v,a)=>assert(Math.abs(pixels[i+a]-Math.round(v*alpha*255))<=2,'SH direction mismatch'));
  });
  await test('Near clipping and resize/readback row padding',async()=>{
    await r.setModel(model(scene));r.render({...cam,near:10,width:67,height:41},{background:[.1,.2,.3]});const p=await r.readPixels();
    assert(p.length===67*41*4,'Readback dimensions');assert(Math.abs(p[0]-26)<=1&&Math.abs(p.at(-2)-77)<=1,'Clipped frame/background');
  });
  await test('Worker PLY loading, cancellation, viewer lifecycle and visibility',async()=>{
    const host=document.createElement('div');host.style.cssText='width:600px;height:600px';document.body.append(host);
    const viewer=new GaussianViewer(host.attachShadow({mode:'open'}),{onError:e=>errors.push(e.message)});
    await viewer.loadDemo({side:8});host.scrollIntoView();
    const deadline=performance.now()+5000;
    while(!viewer.renderer.frameCount&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert(viewer.renderer.frameCount>0,'Viewer never drew');
    const count=viewer.renderer.frameCount;viewer.visible=false;viewer.invalidate();await new Promise(resolve=>setTimeout(resolve,50));assert(viewer.renderer.frameCount===count,'Hidden viewer drew');
    const fields=['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
    const text=['ply','format ascii 1.0','comment photara_render_method 3dgut','element vertex 1',...fields.map(x=>`property float ${x}`),'end_header','0 0 2 0 0 0 1 -2 -2 -2 1 0 0 0',''].join('\n');
    await viewer.load(new Blob([text]),{name:'worker-test.ply'});assert(viewer.modelInfo.renderMethod==='3dgut','Worker metadata');
    const old=viewer.load(new Blob([text]));const newer=viewer.loadDemo({side:6});await Promise.allSettled([old,newer]);assert(viewer.modelInfo.count===36,'Stale load replaced new model');
    viewer.dispose();assert(viewer.renderer.disposed,'Device leaked');host.remove();
  });
  await r.device.queue.onSubmittedWorkDone();assert(errors.length===0,`GPU errors: ${errors.join('\n')}`);r.dispose();
  window.__gpuResult={passed:true,results,errors};
}catch(error){window.__gpuResult={passed:false,results,errors,error:error.stack};}
document.querySelector('#results').textContent=JSON.stringify(window.__gpuResult,null,2);
