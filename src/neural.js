import { WebGPUDenoisePasses } from './vendor/gaussian-splat-lite/neuralDenoisePasses.js';
import { neuralDenoiseModels } from './vendor/gaussian-splat-lite/neuralDenoiseWeights.js';
import { fillNeuralCamera } from './neural-camera.js';

/** Adapter around upstream's native WebGPU passes and pretrained weights.
 * Shares the renderer's device and command encoder; no Three.js or readback. */
export class NeuralReconstruction {
  constructor(device) {this.device=device;this.previous=null;}
  encode(encoder,{camera,rawColor,rawDepth,mode,valid,index,seed,timestamps}) {
    const profile=mode==='neural'?'quality':'performance';
    if(this.profile!==profile) {
      this.dispose();this.profile=profile;
      this.passes=new WebGPUDenoisePasses(this.device,{...neuralDenoiseModels[profile],stabilizeNoise:true},false);
    }
    const {device,passes}=this;
    if(this.width!==camera.width||this.height!==camera.height) {
      this.destroyTextures();this.width=camera.width;this.height=camera.height;
      this.outputs=[0,1].map(()=>device.createTexture({label:`Neural ${profile} output`,size:[this.width,this.height],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC}));
      valid=false;
    }
    if(passes.external?.color!==rawColor||passes.external?.depth!==rawDepth||passes.external?.history[0]!==this.outputs[0]) {
      passes.prepare(this.width,this.height,{color:rawColor,depth:rawDepth,history:this.outputs,encode:false});valid=false;
    }
    fillNeuralCamera(passes.uniforms,camera,this.previous,{valid,halfBias:passes.halfBias,seed});
    device.queue.writeBuffer(passes.uniformBuffer,0,passes.uniforms);
    passes.frames[1-index](encoder,timestamps);
    this.previous={...camera,worldToCamera:Array.from(camera.worldToCamera)};
    return this.outputs[index];
  }
  get bytes() {
    const bytes={rgba16float:8,rg32float:8,rgba32float:16,r16float:2};
    return [...(this.outputs||[]),...(this.passes?.textures||[])].reduce((s,t)=>s+t.width*t.height*bytes[t.format],0);
  }
  get uniformBytes() {return this.passes?.uniformBuffer.size||0;}
  destroyTextures() {
    this.outputs?.forEach(t=>t.destroy());this.outputs=null;
    if(this.passes){this.passes.textures.forEach(t=>t.destroy());this.passes.textures=[];this.passes.frames=[];this.passes.external=null;}
    this.width=0;this.height=0;this.previous=null;
  }
  dispose() {this.destroyTextures();this.passes?.dispose();this.passes=null;this.profile=null;}
}
