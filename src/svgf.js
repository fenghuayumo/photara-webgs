/** Experimental raw-sample temporal moments -> wavelets -> TAA.
 * All textures stay on the renderer's GPUDevice; no frame readback. */
export class SvgfReconstruction {
  constructor(device, pipelines) {
    this.device=device; this.pipelines=pipelines;
    this.steps=[1,2,4].map(step=>{
      const buffer=device.createBuffer({label:'SVGF wavelet stride',size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      device.queue.writeBuffer(buffer,0,new Uint32Array([step,0,0,0]));return buffer;
    });
  }
  resize(width,height) {
    if(this.width===width&&this.height===height)return;
    this.destroyTextures();this.width=width;this.height=height;
    const texture=(label,format)=>this.device.createTexture({label,size:[width,height],format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
    this.frames=Array.from({length:2},()=>({color:texture('SVGF integrated color/variance','rgba16float'),meta:texture('SVGF depth/age/moments','rgba32float'),taa:texture('SVGF TAA history','rgba16float')}));
    this.wavelets=Array.from({length:2},()=>texture('SVGF wavelet scratch','rgba16float'));
  }
  encode(encoder,{camera,rawColor,depth,cameraUniform,uniform,index,timestamps}) {
    this.resize(camera.width,camera.height);
    const current=this.frames[index],old=this.frames[1-index],d=this.device;
    const group=(pipeline,slot,resources)=>d.createBindGroup({layout:pipeline.getBindGroupLayout(slot),entries:resources.map((resource,binding)=>({binding,resource}))});
    const run=(pipeline,groups,stamp={})=>{
      const pass=encoder.beginComputePass(stamp);pass.setPipeline(pipeline);
      groups.forEach((g,i)=>pass.setBindGroup(i,g));
      pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();
    };
    const {integrate,atrous,taa}=this.pipelines;
    run(integrate,[group(integrate,0,[{buffer:cameraUniform},{buffer:uniform},rawColor.createView(),depth.createView(),old.color.createView(),old.meta.createView(),current.color.createView(),current.meta.createView()])],timestamps(12,undefined));
    let input=current.color;
    for(let i=0;i<this.steps.length;i++){
      const output=this.wavelets[i%2];
      run(atrous,[group(atrous,0,[{buffer:cameraUniform}]),group(atrous,1,[input.createView(),current.meta.createView(),output.createView(),{buffer:this.steps[i]}])]);
      input=output;
    }
    run(taa,[group(taa,0,[{buffer:cameraUniform},{buffer:uniform},input.createView(),depth.createView(),old.taa.createView(),old.meta.createView(),current.taa.createView()])],timestamps(undefined,13));
    return current.taa;
  }
  get bytes() {return this.frames?this.width*this.height*80:0;}
  destroyTextures() {
    this.frames?.forEach(f=>{f.color.destroy();f.meta.destroy();f.taa.destroy();});
    this.wavelets?.forEach(t=>t.destroy());this.frames=null;this.wavelets=null;this.width=0;this.height=0;
  }
  dispose() {this.destroyTextures();this.steps.forEach(b=>b.destroy());}
}
