// CV (+Y down, +Z forward) to the upstream denoiser's GL view convention.
const multiply=(a,b)=>Array.from({length:16},(_,i)=>{
  const row=i%4,col=Math.floor(i/4);
  return [0,1,2,3].reduce((s,k)=>s+a[k*4+row]*b[col*4+k],0);
});
function glView(view) {
  return Array.from(view,(v,i)=>i%4===1||i%4===2?-v:v);
}
function inverseRigid(v) {
  const out=[v[0],v[4],v[8],0,v[1],v[5],v[9],0,v[2],v[6],v[10],0,0,0,0,1];
  for(let i=0;i<3;i++)out[12+i]=-[0,1,2].reduce((s,k)=>s+out[k*4+i]*v[12+k],0);
  return out;
}
export function neuralProjection(camera) {
  const {width:w,height:h,fx,fy,cx,cy}=camera;
  const x=2*(cx+0.5)/w-1,y=1-2*(cy+0.5)/h;
  // Integer source samples are at WebGPU texel centres (p + 0.5).
  return camera.model==='orthographic'
    ? [2*fx/w,0,0,0,0,2*fy/h,0,0,0,0,0,0,x,y,0,1]
    : [2*fx/w,0,0,0,0,2*fy/h,0,0,-x,-y,0,-1,0,0,1,0];
}
export function fillNeuralCamera(uniforms,camera,previous,{valid=false,halfBias=0,seed=0}={}) {
  const view=glView(camera.worldToCamera),old=previous||camera;
  const relative=multiply(glView(old.worldToCamera),inverseRigid(view));
  const projection=neuralProjection(camera);
  uniforms.fill(0);
  uniforms.set(multiply(neuralProjection(old),relative),0);
  uniforms.set(projection,16);
  uniforms.set([relative[2],relative[6],relative[10],relative[14]],32);
  uniforms.set([projection[0],projection[5],projection[8],projection[9]],36);
  uniforms.set([projection[12],projection[13],projection[11],projection[15]],40);
  // Photara stores near/(near+Z), including orthographic cameras. The
  // upstream inverse depth transform is independent of its XY projection.
  const near=Math.max(1e-6,camera.near??0.2);
  uniforms.set([0,-1,near,near],44);
  uniforms.set([camera.width,camera.height,1/camera.width,1/camera.height],48);
  uniforms.set([1e8,0,valid?1:0,1,halfBias,0,near,0],52);
  uniforms[60]=Math.acos(Math.max(-1,Math.min(1,(relative[0]+relative[5]+relative[10]-1)/2)));
  uniforms[61]=valid&&camera.worldToCamera.every((v,i)=>v===old.worldToCamera[i])?1:0;
  // No margin or projection jitter; source RNG already changes every frame.
  uniforms[68]=seed;
}
