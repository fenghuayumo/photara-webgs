import { NeuralReconstruction } from './neural.js';
/** Owns only stochastic reconstruction resources, allocated on explicit use. */
export class StochasticReconstruction {
  constructor(device, spatial, temporal, svgf) {
    this.device=device; this.spatial=spatial; this.temporal=temporal; this.svgf=svgf; this.neural=new NeuralReconstruction(device);
    this.uniform=device.createBuffer({label:'Previous stochastic camera',size:176,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.reset();
  }
  reset() { this.previous=null; this.index=0; this.key=null; this.historyAccepted=false; }
  resize(width,height) {
    if(this.width===width&&this.height===height)return;
    this.destroyTextures();this.width=width;this.height=height;
    const texture=(label,format)=>this.device.createTexture({label,size:[width,height],format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
    this.color=texture('Spatial stochastic color','rgba16float');this.depth=texture('Spatial stochastic depth','r32float');
    this.reset();
  }
  encode(encoder,{camera,bytes,key,mode,rawColor,rawDepth,cameraUniform,timestamps,seed}) {
    this.resize(camera.width,camera.height);
    const device=this.device;
    const group=(layout,entries)=>device.createBindGroup({layout,entries:entries.map((resource,binding)=>({binding,resource}))});
    const spatialGroup=group(this.spatial.getBindGroupLayout(0),[{buffer:cameraUniform},rawColor.createView(),rawDepth.createView(),this.color.createView(),this.depth.createView()]);
    let pass;
    if(!mode.startsWith('neural')) {pass=encoder.beginComputePass(timestamps(10,11));pass.setPipeline(this.spatial);pass.setBindGroup(0,spatialGroup);pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();}
    if(mode==='spatial') {this.reset();return this.color;}
    if (mode==='temporal' && !this.histories) {
      const texture=(label,format)=>device.createTexture({label,size:[this.width,this.height],format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
      this.histories=Array.from({length:2},()=>({color:texture('Temporal stochastic color','rgba16float'),meta:texture('Temporal depth and age','rg32float')}));
    }
    const valid=Boolean(this.previous&&this.key===key&&[0,1,2].reduce((s,a)=>s+camera.worldToCamera[a*4+2]*this.previous[a*4+2],0)>.9);
    const uniform=new ArrayBuffer(176);new Uint8Array(uniform).set(this.previousBytes||new Uint8Array(bytes));
    new Float32Array(uniform).set([valid?1:0,0,0,0],40);device.queue.writeBuffer(this.uniform,0,uniform);
    if(mode==='svgf'||mode.startsWith('neural')) {
      const result=mode==='svgf' ? this.svgf.encode(encoder,{camera,rawColor,depth:this.depth,cameraUniform,uniform:this.uniform,index:this.index,timestamps}) : this.neural.encode(encoder,{camera,rawColor,rawDepth,mode,valid,index:this.index,seed,timestamps});
      this.previous=Array.from(camera.worldToCamera);this.previousBytes=new Uint8Array(bytes.slice(0));this.key=key;this.historyAccepted=valid;
      this.index=1-this.index;return result;
    }
    const current=this.histories[this.index],old=this.histories[1-this.index];
    const temporalGroup=group(this.temporal.getBindGroupLayout(1),[{buffer:this.uniform},this.color.createView(),this.depth.createView(),old.color.createView(),old.meta.createView(),current.color.createView(),current.meta.createView()]);
    pass=encoder.beginComputePass(timestamps(12,13));pass.setPipeline(this.temporal);
    pass.setBindGroup(0,group(this.temporal.getBindGroupLayout(0),[{buffer:cameraUniform}]));pass.setBindGroup(1,temporalGroup);
    pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();
    this.previous=Array.from(camera.worldToCamera);this.previousBytes=new Uint8Array(bytes.slice(0));this.key=key;this.historyAccepted=valid;
    this.index=1-this.index;return current.color;
  }
  get bytes() {return (this.color?this.width*this.height*(12+(this.histories?32:0)):0)+(this.svgf?.bytes||0)+(this.neural?.bytes||0);}
  destroyTextures() {this.color?.destroy();this.depth?.destroy();this.histories?.forEach(h=>{h.color.destroy();h.meta.destroy();});this.svgf?.destroyTextures();this.neural?.destroyTextures();this.color=null;this.depth=null;this.histories=null;this.width=0;this.height=0;this.reset();}
  dispose() {this.destroyTextures();this.uniform.destroy();this.svgf?.dispose();this.neural?.dispose();}
}
