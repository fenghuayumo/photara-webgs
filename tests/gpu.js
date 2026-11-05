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
    // Reverse original IDs for equal depths: the GPU's stable back-to-front
    // draw is traversed front-to-back by this transmittance reference.
    return (mode==='orthographic'?ca[2]-cb[2]:dot(ca,ca)-dot(cb,cb))||b-a;
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
        const h2=hi*hi,limit=hi*(1+h2*(k[0]+h2*(k[1]+h2*(k[2]+h2*k[3]))));
        if(!(r<limit))continue;
        for(let i=0;i<40;i++){const z=(lo+hi)/2,qq=z*z,td=z*(1+qq*(k[0]+qq*(k[1]+qq*(k[2]+qq*k[3]))));if(td<r)lo=z;else hi=z;}
        const th=(lo+hi)/2,t2=th*th,derivative=1+t2*(3*k[0]+t2*(5*k[1]+t2*(7*k[2]+9*t2*k[3])));
        if(!(derivative>1e-6))continue;
        const f=r>1e-8?Math.sin(th)/r:1;ray=[u*f,vv*f,Math.max(0,Math.cos(th))];
      }
      const o=axes.map((a,i)=>dot(a,offset.map((z,j)=>z-t[j]))/s[i]);
      const d=axes.map((a,i)=>dot(a,ray)/s[i]);const peak=-dot(o,d)/dot(d,d);if(peak<=0)continue;
      distance=o.reduce((sum,z,i)=>sum+(z+peak*d[i])**2,0);
    }else{
      let px=camera.fx*t[0]/t[2]+camera.cx,py=camera.fy*t[1]/t[2]+camera.cy;
      let du=[camera.fx/t[2],0,-camera.fx*t[0]/t[2]**2],dv=[0,camera.fy/t[2],-camera.fy*t[1]/t[2]**2];
      if(mode==='pinhole'){
        const tx=Math.max(-1.3*camera.width/(2*camera.fx),Math.min(1.3*camera.width/(2*camera.fx),t[0]/t[2]));
        const ty=Math.max(-1.3*camera.height/(2*camera.fy),Math.min(1.3*camera.height/(2*camera.fy),t[1]/t[2]));
        du[2]=-camera.fx*tx/t[2];dv[2]=-camera.fy*ty/t[2];
      }
      if(mode==='orthographic'){px=camera.fx*t[0]+camera.cx;py=camera.fy*t[1]+camera.cy;du=[camera.fx,0,0];dv=[0,camera.fy,0];}
      if(mode==='fisheye'||mode==='equirectangular'){
        const project=p=>{
          if(mode==='equirectangular')return[camera.fx*Math.atan2(p[0],p[2])+camera.cx,camera.fy*Math.atan2(p[1],Math.hypot(p[0],p[2]))+camera.cy];
          const r=Math.hypot(p[0],p[1]),th=Math.atan2(r,p[2]),q=th*th,k=camera.distortion||[0,0,0,0],td=th*(1+q*(k[0]+q*(k[1]+q*(k[2]+q*k[3]))));
          const rho=r>1e-12?td/r:1/p[2];
          return[camera.fx*p[0]*rho+camera.cx,camera.fy*p[1]*rho+camera.cy];
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
      const filteredDet=a*c-b*b;if(mip)opacity*=Math.sqrt(det0/Math.max(1e-6,filteredDet));
      // Independent eigensolve of the filtered covariance. The cap changes
      // its support, while opacity compensation remains based on filteredDet.
      const lambda=(a+c+Math.hypot(a-c,2*b))/2,limit=Math.min(1024,camera.width,camera.height);
      if(Number.isFinite(lambda)&&8*lambda>limit*limit){const q=limit*limit/(8*lambda);a*=q;b*=q;c*=q;}
      const det=a*c-b*b;
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
  const r=await GaussianRenderer.create(document.querySelector('#canvas'),{profiling:true,onError:e=>errors.push(e.message)});
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
  await test('EWA footprint cap: covariance, bounds, aspect ratio and uncapped Mip compensation',async()=>{
    for(const [width,height] of [[65,57],[41,67],[1152,1088]])for(const filter of ['classic','mip2d','mip3d','mip']){
      const c={...cam,model:'orthographic',width,height,fx:40,fy:40,cx:Math.floor(width/2),cy:Math.floor(height/2)};
      const limit=Math.min(1024,width,height),variance=limit*limit/8,k=['mip2d','mip'].includes(filter)?.1:.3;
      const items=[
        {p:[0,0,2],s:[limit/20,limit/80,.1],q:[Math.cos(Math.PI/8),0,0,Math.sin(Math.PI/8)],alpha:.8},
        {p:[0,0,2],s:[limit/20,limit/20,.1],alpha:.8},
        ...[.999,1.001].map(f=>({p:[0,0,2],s:[Math.sqrt((variance*f-k)/1600),.01,.01],alpha:.8})),
      ];
      const m=model(items,'3dgs',filter);await r.setModel(m);r.render(c,{background:[0,0,0]});
      const output=r.device.createBuffer({size:m.count*96,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const enc=r.device.createCommandEncoder();enc.copyBufferToBuffer(r.state.projected,0,output,0,m.count*96);r.device.queue.submit([enc.finish()]);
      await output.mapAsync(GPUMapMode.READ);const projected=new Float32Array(output.getMappedRange()).slice();output.destroy();
      for(let id=0;id<m.count;id++){
        const p=projected.subarray(id*24,id*24+24),sx=m.data[id*12+4]*40,sy=m.data[id*12+5]*40;
        const angle=id===0?Math.PI/4:0,cs=Math.cos(angle),sn=Math.sin(angle);
        const raw=[sx*sx*cs*cs+sy*sy*sn*sn,(sx*sx-sy*sy)*cs*sn,sx*sx*sn*sn+sy*sy*cs*cs];
        const filtered=[raw[0]+k,raw[1],raw[2]+k],lambda=(filtered[0]+filtered[2]+Math.hypot(filtered[0]-filtered[2],2*filtered[1]))/2;
        const q=Math.min(1,variance/lambda),expected=filtered.map(v=>v*q),invDet=p[6]*p[12]-p[7]*p[7];
        const got=[p[12]/invDet,-p[7]/invDet,p[6]/invDet];
        got.forEach((v,i)=>assert(Math.abs(v-expected[i])<Math.max(1e-4,Math.abs(expected[i])*2e-4),`Cap covariance ${width}/${height}/${filter}/${id}/${i}: ${v} vs ${expected[i]}`));
        const alpha=m.data[id*12+3]*(k===.1?Math.sqrt(Math.max(1e-6,raw[0]*raw[2]-raw[1]**2)/Math.max(1e-6,filtered[0]*filtered[2]-filtered[1]**2)):1);
        assert(Math.abs(p[11]-alpha)<2e-5,'Footprint cap changed opacity compensation');
        const th=2*Math.log(alpha*255),extent=[Math.sqrt(th*expected[0])+1,Math.sqrt(th*expected[2])+1];
        assert(Math.abs(p[2]-p[0]-2*extent[0])<.02&&Math.abs(p[3]-p[1]-2*extent[1])<.02,'Bounds did not use capped covariance');
      }
    }
  });
  for(const mode of ['pinhole','orthographic','fisheye','equirectangular'])for(const filter of ['classic','mip2d','mip3d','mip'])await test(`Large EWA ${mode}/${filter}: capped pixels vs oracle`,async()=>{
    const c={...cam,model:mode,distortion:[.05,-.01,.002,0]};
    if(mode==='equirectangular')Object.assign(c,{fx:c.width/(2*Math.PI),fy:c.height/Math.PI,cx:c.width/2,cy:c.height/2});
    const m=model([{p:[.1,.1,1],s:[4,.3,.2],q:[.9,.1,.1,.3],alpha:.8,color:[.8,.3,.6]}],'3dgs',filter);
    await r.setModel(m);r.render(c,{background:[0,0,0]});const pixels=await r.readPixels();let maxError=0;
    for(let y=0;y<c.height;y+=3)for(let x=0;x<c.width;x+=3){const expected=oracle(m,c,x,y);for(let a=0;a<3;a++)maxError=Math.max(maxError,Math.abs(pixels[(y*c.width+x)*4+a]-expected[a]));}
    assert(maxError<=2,`Capped EWA pixel mismatch: ${maxError}`);
  });
  await test('Radial sorting for central cameras, Z sorting for orthographic GS/GUT',async()=>{
    for(const method of ['3dgs','3dgut'])for(const mode of ['pinhole','orthographic','fisheye','equirectangular'])for(const compact of [false,true]){
      const c={...cam,model:mode,fx:20,fy:20,cx:32,cy:28};
      if(mode==='equirectangular')Object.assign(c,{fx:c.width/(2*Math.PI),fy:c.height/Math.PI,cx:c.width/2,cy:c.height/2});
      // ID 0 is nearer by Z, farther radially; IDs 0/2 have identical depth
      // and overlap ID 1. A translated eye catches world-space distance keys.
      c.worldToCamera=lookAtCV([10,0,0],[10,0,2]);
      const m=model([{p:[11.5,0,2],s:[.5,.5,.5],alpha:.8,color:[1,0,0]},
        {p:[10,0,2.2],s:[.5,.5,.5],alpha:.8,color:[0,1,0]},
        {p:[11.5,0,2],s:[.5,.5,.5],alpha:.3,color:[0,0,1]}],method);
      await r.setModel(m,{spatialBlocks:true});r.render(c,{compact,background:[0,0,0]});
      const output=r.device.createBuffer({size:24,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const enc=r.device.createCommandEncoder();enc.copyBufferToBuffer(r.state.keys[compact?1:0],0,output,0,24);r.device.queue.submit([enc.finish()]);
      await output.mapAsync(GPUMapMode.READ);const got=new Uint32Array(output.getMappedRange()).slice();output.destroy();
      const expected=mode==='orthographic'?[1,0,2]:[0,2,1];
      // Spatial storage may reorder IDs; resolve sorted IDs through the
      // uploaded attributes, including opacity to distinguish the depth tie.
      const attrs=r.device.createBuffer({size:m.data.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const read=r.device.createCommandEncoder();read.copyBufferToBuffer(r.state.attributes,0,attrs,0,m.data.byteLength);r.device.queue.submit([read.finish()]);await attrs.mapAsync(GPUMapMode.READ);
      const data=new Float32Array(attrs.getMappedRange()).slice();attrs.destroy();
      expected.forEach((original,i)=>{
        const actual=got[i*2+1];
        assert(data[actual*12]===m.data[original*12]&&data[actual*12+3]===m.data[original*12+3],`${method}/${mode}/${compact}: wrong radial/Z order or unstable tie`);
      });
      const pixels=await r.readPixels();let maxError=0;
      for(let y=20;y<36;y+=3)for(let x=24;x<45;x+=3){const ref=oracle(m,c,x,y);for(let a=0;a<3;a++)maxError=Math.max(maxError,Math.abs(pixels[(y*c.width+x)*4+a]-ref[a]));}
      assert(maxError<=2,`${method}/${mode}/${compact}: radial compositing differs from oracle: ${maxError}`);
    }
  });
  await test('GUT near-camera support remains conservative',async()=>{
    const m=model([{p:[.15,.1,.25],s:[.35,.4,.3],q:[.8,.1,.2,.3],alpha:.85}],'3dgut');await r.setModel(m);r.render(cam,{background:[0,0,0]});const p=await r.readPixels();
    for(let y=0;y<cam.height;y+=5)for(let x=0;x<cam.width;x+=5){const expected=oracle(m,cam,x,y);for(let a=0;a<3;a++)assert(Math.abs(p[(y*cam.width+x)*4+a]-expected[a])<=2,'GUT clipped support');}
  });
  for(const mode of ['fisheye','equirectangular'])await test(`GUT ${mode}: conservative support, seam, poles and cached rays`,async()=>{
    const c={...cam,model:mode,distortion:[.05,-.01,.002,0]};
    if(mode==='equirectangular')Object.assign(c,{fx:c.width/(2*Math.PI),fy:c.height/Math.PI,cx:c.width/2,cy:c.height/2});
    const items=mode==='fisheye'?[
      {p:[1.7,.9,1],s:[.09,.3,.12],q:[.8,.2,.1,-.3],alpha:.85},
      {p:[-1.9,-.9,1],s:[.2,.05,.15],q:[.7,-.2,.3,.1],alpha:.7},
      {p:[.1,-.12,.18],s:[.2,.03,.14],q:[.8,.1,.3,-.2],alpha:.6},
    ]:[
      {p:[.01,.2,-2],s:[.15,.3,.08],alpha:.8},
      {p:[.02,-2,.03],s:[.25,.1,.2],alpha:.75},
      {p:[-.02,2,.02],s:[.2,.1,.3],alpha:.7},
      {p:[.1,.05,.03],s:[.3,.2,.25],alpha:.6},
    ];
    const m=model(items,'3dgut');await r.setModel(m);
    // Intrinsic changes must rebuild the camera-space ray image even at the
    // same resolution. Pose changes can retain it without changing pixels.
    const variants=mode==='fisheye'?[c,{...c,fx:38,fy:42,distortion:[-.07,.02,0,0]},c]:[c,{...c,worldToCamera:lookAtCV([.02,0,0],[0,0,2])},c];
    for(const camera of variants){
      r.render(camera,{background:[0,0,0]});const p=await r.readPixels();let maxError=0;
      for(let y=0;y<c.height;y+=2)for(let x=0;x<c.width;x+=2){const expected=oracle(m,camera,x,y);for(let a=0;a<3;a++)maxError=Math.max(maxError,Math.abs(p[(y*c.width+x)*4+a]-expected[a]));}
      assert(maxError<=2,`${mode} clipped or stale rays: ${maxError}`);
    }
  });
  await test('GUT exact panorama poles retain finite support at low opacity',async()=>{
    const c={...cam,width:96,height:64,model:'equirectangular',fx:96/(2*Math.PI),fy:64/Math.PI,cx:48,cy:32};
    for(const alpha of [.9,.006])for(const sign of [-1,1]){
      const m=model([{p:[0,sign*2,0],s:[.2,.2,.2],alpha,color:[.8,.3,.2]}],'3dgut');
      await r.setModel(m);r.render(c,{background:[0,0,0]});const p=await r.readPixels();
      assert(p.some((v,i)=>i%4!==3&&v>0),'Exact panorama pole was culled');
      let maxError=0;
      for(let y=0;y<c.height;y+=3)for(let x=0;x<c.width;x+=3){const expected=oracle(m,c,x,y);for(let a=0;a<3;a++)maxError=Math.max(maxError,Math.abs(p[(y*c.width+x)*4+a]-expected[a]));}
      assert(maxError<=2,`Pole support differs from oracle: ${maxError}`);
    }
  });
  await test('GUT fisheye outside lens returns background instead of horizon rays',async()=>{
    const c={...cam,width:96,height:64,model:'fisheye',fx:20,fy:20,cx:48,cy:32,distortion:[0,0,0,0]};
    const m=model([{p:[2,0,.0001],s:[.2,.2,.2],alpha:.9,color:[1,0,0]}],'3dgut');await r.setModel(m);
    r.render(c,{background:[.13,.07,.11]});const p=await r.readPixels();const i=(32*c.width+95)*4;
    [33,18,28].forEach((expected,a)=>assert(Math.abs(p[i+a]-expected)<=1,'Invalid fisheye ray rendered geometry'));
    r.render(c,{background:[0,0,0]});const black=await r.readPixels();let maxError=0;
    for(let y=0;y<c.height;y+=3)for(let x=0;x<c.width;x+=3){const expected=oracle(m,c,x,y);for(let a=0;a<3;a++)maxError=Math.max(maxError,Math.abs(black[(y*c.width+x)*4+a]-expected[a]));}
    assert(maxError<=2,`Fisheye lens boundary differs from oracle: ${maxError}`);
  });
  for(const count of [777,65617])await test(`GPU radix stability: ${count} entries, partial group, culled keys`,async()=>{
    const items=Array.from({length:count},(_,i)=>({p:[0,0,i%19===0?-1:1+((i*167)%149)/50],s:[.02,.02,.02]}));const m=model(items);await r.setModel(m,{spatialBlocks:false});r.render(cam,{compact:false});
    const output=r.device.createBuffer({size:m.count*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=r.device.createCommandEncoder();encoder.copyBufferToBuffer(r.state.keys[0],0,output,0,m.count*8);r.device.queue.submit([encoder.finish()]);await output.mapAsync(GPUMapMode.READ);
    const got=new Uint32Array(output.getMappedRange()).slice();output.destroy();
    const expected=Array.from({length:m.count},(_,i)=>i).sort((a,b)=>{
      const za=m.data[a*12+2],zb=m.data[b*12+2];return(za<0?Infinity:-za)-(zb<0?Infinity:-zb)||a-b;
    });
    expected.forEach((id,i)=>assert(got[i*2+1]===id,`Sort mismatch at ${i}: ${got[i*2+1]} vs ${id}`));
  });
  await test('Tight GUT pinhole support: rotated thin ellipsoids and eye crossings',async()=>{
    let seed=123456;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const c={...cam,width:48,height:32,fx:25,fy:25,cx:24,cy:16,near:.001};
    for(let i=0;i<20;i++){
      const g={p:[(random()-.5)*2,(random()-.5)*2,.05+random()*3],s:[.005+random()*.03,.02+random()*.2,.1+random()*2],q:[random(),random(),random(),random()],alpha:.1+random()*.85};
      const m=model([g],'3dgut');await r.setModel(m);r.render(c,{tightBounds:false,compact:false,background:[0,0,0]});const old=await r.readPixels();
      r.render(c,{tightBounds:true,compact:true,background:[0,0,0]});const actual=await r.readPixels();let diff=0;
      for(let p=0;p<actual.length;p++)diff=Math.max(diff,Math.abs(actual[p]-old[p]));assert(diff===0,`Tight support clipped case ${i}: ${diff}`);
    }
  });
  for(const count of [1,257,65617]) await test(`Stable visible compaction and indirect draw: ${count}`,async()=>{
    const m=model(Array.from({length:count},(_,i)=>({p:[i%7===0?100:0,0,i%19===0?-1:1+(i%5)*.2],s:[.02,.02,.02],alpha:.2})));await r.setModel(m);
    const readKeys=async(index,n)=>{
      if(!n)return new Uint32Array();
      const output=r.device.createBuffer({size:n*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const enc=r.device.createCommandEncoder();enc.copyBufferToBuffer(r.state.keys[index],0,output,0,n*8);r.device.queue.submit([enc.finish()]);await output.mapAsync(GPUMapMode.READ);const data=new Uint32Array(output.getMappedRange()).slice();output.destroy();return data;
    };
    r.render(cam,{compact:false});const reference=await readKeys(0,count),pixels=await r.readPixels();
    const expected=[];for(let i=0;i<count;i++)if(reference[i*2]!==0xffffffff)expected.push(reference[i*2],reference[i*2+1]);
    r.render(cam,{compact:true});const stats=await r.readVisibility(),got=await readKeys(1,stats.visible),actual=await r.readPixels();
    assert(stats.visible===expected.length/2,'Wrong visible count');assert(got.every((v,i)=>v===expected[i]),'Compaction changed stable order');assert(actual.every((v,i)=>v===pixels[i]),'Compaction changed image');
    r.render({...cam,near:100},{compact:true});assert((await r.readVisibility()).visible===0,'Stale indirect count on empty frame');
    r.render(cam,{compact:false});const restored=await r.readPixels();assert(restored.every((v,i)=>v===pixels[i]),'Legacy path did not restore full count');
  });
  await test('SH direction and non-DC basis order',async()=>{
    const coefficients=[0,0,0,.2,0,0,0,.3,0,0,0,.4];const g={p:[.2,.1,2],s:[.2,.2,.2],alpha:.8,sh:coefficients};const m=model([g],'3dgs','classic',4);await r.setModel(m);r.render(cam,{background:[0,0,0]});const pixels=await r.readPixels();
    const norm=Math.hypot(...g.p),d=g.p.map(x=>x/norm),center=[37,29],i=(center[1]*cam.width+center[0])*4;
    // Recover alpha using a second DC-only render with known white color.
    const white=model([{...g,sh:undefined,color:[1,1,1]}]);await r.setModel(white);r.render(cam,{background:[0,0,0]});const wp=await r.readPixels();const alpha=wp[i]/255;
    const expected=[.5-.4886025119029199*d[1]*.2,.5+.4886025119029199*d[2]*.3,.5-.4886025119029199*d[0]*.4];
    expected.forEach((v,a)=>assert(Math.abs(pixels[i+a]-Math.round(v*alpha*255))<=2,'SH direction mismatch'));
  });
  await test('GPU focus picking: GS/GUT opacity depth, background, compaction and cameras',async()=>{
    for(const method of ['3dgs','3dgut'])for(const compact of [true,false]) {
      // A faint foreground floater must not steal the opaque surface focus.
      await r.setModel(model([{p:[0,0,1],s:[.1,.1,.1],alpha:.02},{p:[0,0,2],s:[.2,.2,.2],alpha:.9}],method));
      assert(await r.pick(31,26)===null,'New model used stale projection');
      r.render(cam,{compact});const hit=await r.pick(31,26);
      assert(hit&&Math.hypot(hit[0],hit[1],hit[2]-2)<1e-4,`${method} wrong surface ${hit}`);
      assert(await r.pick(0,0)===null,'Background changed focus');
      assert(await r.pick(-1,26)===null&&await r.pick(NaN,26)===null,'Invalid pick accepted');
      r.render({...cam,near:10},{compact});assert(await r.pick(31,26)===null,'Empty frame picked stale data');
    }
    for(const mode of ['pinhole','orthographic','fisheye','equirectangular']) {
      const c={...cam,model:mode,worldToCamera:lookAtCV([2,-1,-3],[2,-1,0])};
      if(mode==='equirectangular')Object.assign(c,{fx:65/(2*Math.PI),fy:57/Math.PI,cx:32.5,cy:28.5});
      await r.setModel(model([{p:[2,-1,0],s:[.3,.3,.3],alpha:.8}],'3dgut'));
      r.render(c);const hit=await r.pick(c.cx,c.cy);
      assert(hit&&Math.hypot(hit[0]-2,hit[1]+1,hit[2])<.2,`${mode} world-space pick failed ${hit}`);
    }
    await r.setModel(model([{p:[0,0,2],s:[.3,.3,.3],alpha:.1}]));r.render(cam);
    assert(await r.pick(31,26),'Thin surface fallback missing');
    const misses=Array.from({length:600},()=>({p:[.5,0,1],s:[.01,.01,.01],alpha:.9}));
    await r.setModel(model([...misses,{p:[0,0,2],s:[.2,.2,.2],alpha:.9}]));
    r.render(cam);const batched=await r.pick(31,26);
    assert(batched&&Math.abs(batched[2]-2)<1e-4,'Picking did not traverse workgroup batches');
  });
  await test('Stochastic depth, deterministic seeds, skipped sort and exact capture across cameras',async()=>{
    for(const method of ['3dgs','3dgut'])for(const mode of ['pinhole','orthographic','fisheye','equirectangular'])for(const compact of [true,false]) {
      const c={...cam,model:mode};
      if(mode==='equirectangular')Object.assign(c,{fx:c.width/(2*Math.PI),fy:c.height/Math.PI,cx:c.width/2,cy:c.height/2});
      const m=model([{p:[0,0,2],s:[.3,.3,.3],alpha:.99,color:[1,0,0]},{p:[0,0,3],s:[.3,.3,.3],alpha:.99,color:[0,1,0]}],method);
      await r.setModel(m);r.render(c,{compact,background:[0,0,0]});const exact=await r.readPixels();
      r.render(c,{compact,background:[0,0,0],transparency:'stochastic',stochasticSeed:7});
      assert(!r.state.keysSorted,'Stochastic render sorted its keys');
      const timing=await r.readTimings();if(timing)assert(timing.sort_ms===0,'Skipped sort returned stale timestamps');
      const first=await r.readPixels({exact:false});
      r.render(c,{compact,background:[0,0,0],transparency:'stochastic',stochasticSeed:7});
      const same=await r.readPixels({exact:false});assert(same.every((v,i)=>v===first[i]),'Fixed seed is not deterministic');
      const i=(Math.floor(c.cy)*c.width+Math.floor(c.cx))*4;
      assert(first[i]>250&&first[i+1]<2,`${method}/${mode} nearest opaque depth failed: ${first.slice(i,i+4)}`);
      const restored=await r.readPixels();assert(r.lastTransparency==='sorted','Capture did not force sorted');
      assert(restored.every((v,i)=>v===exact[i]),'Stochastic round trip changed exact output');
      if(mode==='fisheye'||mode==='equirectangular'){m.data[3]=0;m.data[15]=0;await r.setModel(m);}
      r.render({...c,near:100},{compact,background:[0,0,0],transparency:'stochastic'});
      const empty=await r.readPixels({exact:false});assert(empty.every((v,i)=>i%4===3||v===0),`${method}/${mode} empty stochastic frame retained depth/color`);
    }
    for(const options of [{transparency:'invalid'},{stochasticSeed:NaN}]){
      let rejected=false;try{r.render(cam,options);}catch{rejected=true;}assert(rejected,'Invalid stochastic option accepted');
    }
  });
  await test('Stochastic alpha statistics, noise variation and deterministic picking',async()=>{
    const c={...cam,width:32,height:32,fx:30,fy:30,cx:16,cy:16};
    await r.setModel(model([{p:[0,0,2],s:[.5,.5,.5],alpha:.5,color:[1,0,0]},{p:[0,0,3],s:[.5,.5,.5],alpha:.5,color:[0,1,0]}]));
    let red=0,green=0,samples=0,changed=0,previous;
    for(let seed=0;seed<64;seed++){
      r.render(c,{background:[0,0,0],transparency:'stochastic',stochasticSeed:seed});const pixels=await r.readPixels({exact:false});
      for(let y=12;y<=20;y++)for(let x=12;x<=20;x++) {const i=(y*c.width+x)*4;red+=pixels[i]/255;green+=pixels[i+1]/255;samples++;}
      if(previous)changed+=pixels.some((v,i)=>v!==previous[i]);previous=pixels;
    }
    r.render(c,{background:[0,0,0]});const sorted=await r.readPixels();let er=0,eg=0;
    for(let y=12;y<=20;y++)for(let x=12;x<=20;x++){const i=(y*c.width+x)*4;er+=sorted[i]/255;eg+=sorted[i+1]/255;}
    assert(Math.abs(red/samples-er/81)<.03&&Math.abs(green/samples-eg/81)<.03,'Stochastic coverage is biased or correlated');
    assert(changed>60,'Sample seed did not vary noise');
    const point=await r.pick(16,16);
    r.render(c,{transparency:'stochastic'});const stochasticPick=await r.pick(16,16);
    assert(stochasticPick&&point.every((v,i)=>Math.abs(v-stochasticPick[i])<1e-5),'Stochastic pick used unsorted keys');
    const memory=r.getMemoryUsage();assert(memory.textures>=32*32*12,'Depth texture missing from accounting');
  });
  await test('Stochastic panorama seams, GUT poles, lens bounds and snapshot capture',async()=>{
    for(const method of ['3dgs','3dgut']) {
      const c={...cam,width:96,height:48,model:'equirectangular',fx:96/(2*Math.PI),fy:48/Math.PI,cx:48,cy:24};
      await r.setModel(model([{p:[.01,0,-2],s:[.3,.3,.3],alpha:.99,color:[1,0,0]}],method));
      r.render(c,{transparency:'stochastic',stochasticSeed:8,background:[0,0,0]});const pixels=await r.readPixels({exact:false});
      for(const x of [0,95])assert(pixels[(24*96+x)*4]>250,`${method} panorama seam clipped`);
    }
    const c={...cam,width:96,height:48,model:'equirectangular',fx:96/(2*Math.PI),fy:48/Math.PI,cx:48,cy:24};
    await r.setModel(model([{p:[0,-2,0],s:[.3,.3,.3],alpha:.99,color:[1,0,0]}],'3dgut'));
    r.render(c,{transparency:'stochastic',stochasticSeed:8,background:[0,0,0]});
    const pole=await r.readPixels({exact:false});assert(pole.some((v,i)=>i%4===0&&v>250),'Stochastic GUT pole disappeared');
    const fish={...cam,width:96,height:64,model:'fisheye',fx:20,fy:20,cx:48,cy:32,distortion:[0,0,0,0],worldToCamera:lookAtCV([.2,-.1,-1],[0,0,2])};
    await r.setModel(model(scene,'3dgut'));r.render(fish,{background:[.1,.2,.3]});const exact=await r.readPixels();
    r.render(fish,{transparency:'stochastic',background:[.1,.2,.3]});const raw=await r.readPixels({exact:false});
    const i=(32*96+95)*4;assert(Math.abs(raw[i]-26)<=1,'Out-of-lens stochastic ray hit geometry');
    // Caller edits must not change the camera used for exact capture.
    fish.distortion[0]=.2;fish.worldToCamera[12]+=2;
    const restored=await r.readPixels();assert(restored.every((v,i)=>v===exact[i]),'Capture camera snapshot was mutated by caller');
  });
  await test('Spatial/temporal reconstruction reduces noise and preserves exact output across lenses',async()=>{
    const mae=(a,b)=>a.reduce((s,v,i)=>s+(i%4===3?0:Math.abs(v-b[i])),0)/(a.length*.75);
    for(const method of ['3dgs','3dgut'])for(const mode of ['pinhole','orthographic','fisheye','equirectangular']){
      const c={...cam,width:48,height:32,fx:30,fy:30,cx:24,cy:16,model:mode};
      if(mode==='equirectangular')Object.assign(c,{fx:48/(2*Math.PI),fy:32/Math.PI});
      await r.setModel(model([{p:[0,0,2],s:[.5,.5,.5],alpha:.5,color:[1,.2,.1]}],method));
      r.render(c,{background:[0,0,0]});const exact=await r.readPixels();
      let rawError=0,spatialError=0,temporalError=0;
      for(let seed=0;seed<12;seed++){
        r.render(c,{background:[0,0,0],transparency:'stochastic',stochasticSeed:seed});rawError+=mae(await r.readPixels({exact:false}),exact);
        r.render(c,{background:[0,0,0],transparency:'stochastic',stochasticSeed:seed,reconstruction:'spatial'});spatialError+=mae(await r.readPixels({exact:false}),exact);
      }
      for(let seed=0;seed<12;seed++){
        r.render(c,{background:[0,0,0],transparency:'stochastic',stochasticSeed:seed,reconstruction:'temporal'});
        temporalError+=mae(await r.readPixels({exact:false}),exact);
      }
      assert(spatialError<rawError*.75,`${method}/${mode} spatial noise reduction failed ${spatialError}/${rawError}`);
      assert(temporalError<spatialError,`${method}/${mode} temporal noise reduction failed ${temporalError}/${spatialError}`);
      assert(r.reconstruction.historyAccepted,'Consecutive frames rejected all history');
      const timing=await r.readTimings();if(timing)assert(timing.spatial_ms>=0&&timing.temporal_ms>=0,'Missing reconstruction timings');
      const restored=await r.readPixels();assert(restored.every((v,i)=>v===exact[i]),'Reconstruction changed exact capture');
      assert(r.reconstruction.previous===null,'Sorted output did not reset history');
    }
  });
  await test('Reprojection disocclusion, history resets and odd viewport edges',async()=>{
    const c={...cam,width:49,height:33,fx:35,fy:35,cx:24,cy:16};
    // A red foreground patch in front of a green background; a camera truck
    // reveals green. Reprojection must not leave red at the old pixel location.
    const items=[{p:[0,0,2],s:[.18,.35,.05],alpha:.99,color:[1,0,0]},
      {p:[0,0,4],s:[2,2,.05],alpha:.99,color:[0,1,0]}];
    const m=model(items);await r.setModel(m);
    for(let seed=0;seed<8;seed++)r.render(c,{transparency:'stochastic',reconstruction:'temporal',stochasticSeed:seed});
    const moved={...c,worldToCamera:lookAtCV([.7,0,0],[.7,0,2])};
    r.render(moved,{transparency:'stochastic',reconstruction:'temporal',stochasticSeed:12});
    const moving=await r.readPixels({exact:false}),i=(16*49+24)*4;
    // The background ellipse is now capped too; its revealed green response
    // is lower than the old full-screen splat. Compare against that response.
    const expectedGreen=oracle(m,moved,24,16)[1];
    assert(moving[i]<25&&Math.abs(moving[i+1]-expectedGreen)<35,`Disocclusion retained red history or lost background: ${moving.slice(i,i+4)} vs green ${expectedGreen}`);
    r.render(moved,{transparency:'stochastic',reconstruction:'temporal',stochasticSeed:12,resetHistory:true});
    assert(!r.reconstruction.historyAccepted,'Explicit reset retained history');
    const reset=await r.readPixels({exact:false});
    r.render(moved,{transparency:'stochastic',reconstruction:'spatial',stochasticSeed:12});
    assert((await r.readPixels({exact:false})).every((v,i)=>v===reset[i]),'First temporal frame differs from spatial');
    r.render(moved,{transparency:'stochastic',reconstruction:'temporal'});
    r.render({...moved,fx:40},{transparency:'stochastic',reconstruction:'temporal'});assert(!r.reconstruction.historyAccepted,'Lens change retained history');
    r.render(moved,{transparency:'stochastic',reconstruction:'temporal',background:[1,1,1]});assert(!r.reconstruction.historyAccepted,'Background change retained history');
    r.render({...moved,width:51},{transparency:'stochastic',reconstruction:'temporal'});assert(!r.reconstruction.historyAccepted,'Resize retained history');
    await r.setModel(model([{p:[0,0,2],s:[.3,.3,.3],alpha:.9,color:[0,0,1]}]));
    r.render(c,{transparency:'stochastic',reconstruction:'temporal'});assert(!r.reconstruction.historyAccepted,'Model replacement retained history');
    const pixels=await r.readPixels({exact:false});assert(pixels.every((v,i)=>i%4===3||i%4===2||v<=18),'New model retained old red/green');
    r.render(c);assert(r.reconstruction.previous===null,'Switch to sorted retained history');
    r.render({...c,width:51});r.render(c,{transparency:'stochastic',reconstruction:'temporal'});
    assert(!r.reconstruction.historyAccepted&&r.reconstruction.color,'Returning to prior dimensions did not recreate textures');
  });
  await test('Reconstruction thin-detail contrast and moving disocclusion trail bounds',async()=>{
    const c={...cam,width:65,height:49,fx:64,fy:64,cx:32,cy:24};
    await r.setModel(model([{p:[0,0,2],s:[.018,.5,.02],alpha:.99,color:[1,0,0]}]));
    r.render(c,{background:[0,0,0]});const reference=await r.readPixels(),center=(24*65+32)*4;
    for(let i=0;i<16;i++)r.render(c,{transparency:'stochastic',reconstruction:'temporal',stochasticSeed:i,background:[0,0,0]});
    const filtered=await r.readPixels({exact:false}),contrast=filtered[center]/reference[center];
    assert(contrast>.45,`Thin line contrast collapsed: ${contrast}`);
    const restored=await r.readPixels();assert(restored.every((v,i)=>v===reference[i]),'Thin detail not restored exactly');
    await r.setModel(model([{p:[0,0,2],s:[.18,.35,.05],alpha:.99,color:[1,0,0]},
      {p:[0,0,4],s:[2,2,.05],alpha:.99,color:[0,1,0]}]));
    for(let seed=0;seed<8;seed++)r.render(c,{transparency:'stochastic',reconstruction:'temporal',stochasticSeed:seed});
    let maxTrail=0;
    for(let frame=0;frame<8;frame++){
      const x=.7+frame*.02,camera={...c,worldToCamera:lookAtCV([x,0,0],[x,0,2])};
      r.render(camera,{transparency:'stochastic',reconstruction:'temporal',stochasticSeed:frame+10});
      const pixels=await r.readPixels({exact:false});maxTrail=Math.max(maxTrail,pixels[center]);
    }
    assert(maxTrail<25,`Red disocclusion trail persisted: ${maxTrail}`);
    results.push({name:'Reconstruction detail/trail measurements',thinLineContrastRatio:contrast,maxDisocclusionRedByte:maxTrail,status:'passed'});
  });
  await test('Spatial blocks preserve GS pixels, stable order and visible counts at clipping boundaries',async()=>{
    let seed=81923;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const items=Array.from({length:1537},(_,i)=>({p:[(i%3===0?1:100)*(random()-.5),random()-.5,(random()-.1)*5],s:[.001+random()*.03,.001+random()*.5,.001+random()*.1],q:[random(),random(),random(),random()],alpha:.001+random()*.9}));
    // Very wide anisotropic splats, off-screen centers, near-plane crossings,
    // equal depths and an asymmetric principal point must survive broadphase.
    items.push({p:[5,0,1],s:[3,.001,.1],alpha:.8},{p:[0,0,.0001],s:[.5,.5,.5],alpha:.6});
    for(const filter of ['classic','mip2d','mip3d','mip']){
      await r.setModel(model(items,'3dgs',filter),{spatialBlocks:true});
      for(const mode of ['pinhole','orthographic'])for(const modifier of [.1,1,5])for(const compact of [false,true]){
        const c={...cam,model:mode,cx:11,cy:39,worldToCamera:lookAtCV([.2,-.1,-.3],[0,0,2])};
        r.render(c,{blockCulling:false,scaleModifier:modifier,compact});const ref=await r.readPixels(),visibility=await r.readVisibility();
        r.render(c,{blockCulling:true,scaleModifier:modifier,compact});const actual=await r.readPixels();
        assert(actual.every((v,i)=>v===ref[i]),`Spatial clipping: ${mode}/${filter}/${modifier}/${compact}`);
        assert((await r.readVisibility()).visible===visibility.visible,'Blocks changed visible count');
      }
    }
    const separated=Array.from({length:8193},(_,i)=>({p:[i%2?100:-100,0,2],s:[.01,.01,.01]}));
    await r.setModel(model(separated),{spatialBlocks:true});r.render(cam);
    const stats=await r.readBlockVisibility();assert(stats.enabled&&stats.candidateSplats<=256,'Offscreen blocks were not rejected');
    // Rotate into one cluster: previously rejected projection entries must not
    // be stale, and global depth ties retain the original-ID compositing order.
    const c={...cam,worldToCamera:lookAtCV([0,0,0],[100,0,2])};
    r.render(c,{blockCulling:false});const ref=await r.readPixels();
    r.render(c);assert((await r.readPixels()).every((v,i)=>v===ref[i]),'Stale point state or depth-tie order');
    for(const mode of ['fisheye','equirectangular']){
      const camera={...cam,model:mode};if(mode==='equirectangular')Object.assign(camera,{fx:65/(2*Math.PI),fy:57/Math.PI,cx:32.5,cy:28.5});
      r.render(camera);assert(!r.lastBlockCulling,'Unsupported lens used pinhole block bounds');
    }
    r.render(cam,{renderMethod:'3dgut'});assert(!r.lastBlockCulling,'GUT used GS block bounds');
    const ties=model(Array.from({length:1025},(_,i)=>({p:[(i%17-8)*.01,0,2],s:[.1,.1,.1],alpha:.1,color:[i%2,.2,(i%3)/3]})),'3dgs','classic',4);
    for(let i=0;i<ties.count;i++)ties.sh[i*12+3]=(i%5)*.1;
    await r.setModel(ties,{spatialBlocks:false});r.render(cam);const original=await r.readPixels();
    await r.setModel(ties,{spatialBlocks:true});r.render(cam);
    assert((await r.readPixels()).every((v,i)=>v===original[i]),'GPU spatial layout changed original ties or SH correspondence');
    const point=await r.pick(31,26);assert(point&&Math.abs(point[2]-2)<1e-4,'Spatial layout broke world picking');
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
  await test('Optional GPU pass timestamps',async()=>{
    const timing=await r.readTimings();
    if(r.profiling)assert(timing&&Object.values(timing).every(v=>Number.isFinite(v)&&v>=0),'Invalid GPU timestamps');
    else assert(timing===null,'Unsupported timestamps should be optional');
  });
  await r.device.queue.onSubmittedWorkDone();assert(errors.length===0,`GPU errors: ${errors.join('\n')}`);r.dispose();
  window.__gpuResult={passed:true,results,errors};
}catch(error){window.__gpuResult={passed:false,results,errors,error:error.stack};}
document.querySelector('#results').textContent=JSON.stringify(window.__gpuResult,null,2);
