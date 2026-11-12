/** Photara's own compute-only learned filter and dual-path temporal history. */
export class NeuralReconstruction {
  constructor(device,pipelines,weights) {this.device=device;this.pipelines=pipelines;this.weights=weights;}
  resize(width,height) {
    if(this.width===width&&this.height===height)return;
    this.destroyTextures();this.width=width;this.height=height;
    const texture=(label,format)=>this.device.createTexture({label,size:[width,height],format,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
    this.spatial=texture('Photara learned spatial filter','rgba16float');
    this.refined=texture('Photara multiscale residual filter','rgba16float');
    this.guide=texture('Photara robust depth guide','r32float');
    this.frames=[0,1].map(()=>({raw:texture('Photara raw accumulation','rgba32float'),state:texture('Photara depth/count/moments','rgba32float'),output:texture('Photara temporal output','rgba16float')}));
  }
  encode(encoder,{camera,rawColor,rawDepth,index,timestamps,cameraUniform,uniform}) {
    this.resize(camera.width,camera.height);
    const device=this.device,{spatial,refine,temporal}=this.pipelines;
    const bind=(pipeline,slot,resources)=>device.createBindGroup({layout:pipeline.getBindGroupLayout(slot),entries:resources.map((resource,binding)=>({binding,resource}))});
    const dispatch=(pipeline,groups,stamp)=>{
      const pass=encoder.beginComputePass(stamp);pass.setPipeline(pipeline);groups.forEach((group,i)=>pass.setBindGroup(i,group));
      pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();
    };
    const spatialGroup=device.createBindGroup({layout:spatial.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:cameraUniform}},{binding:2,resource:{buffer:this.weights}},{binding:3,resource:rawColor.createView()},{binding:4,resource:rawDepth.createView()},{binding:5,resource:this.spatial.createView()},{binding:6,resource:this.guide.createView()}]});
    dispatch(spatial,[spatialGroup],timestamps(10,undefined));
    const refineCamera=bind(refine,0,[{buffer:cameraUniform}]);
    // Group 1 is deliberately empty for this entry point.
    const refineEmpty=device.createBindGroup({layout:refine.getBindGroupLayout(1),entries:[]});
    dispatch(refine,[refineCamera,refineEmpty,bind(refine,2,[this.spatial.createView(),this.refined.createView()])],{});
    const current=this.frames[index],old=this.frames[1-index];
    // Auto layout omits bindings unused by the temporal entry point.
    const cameraGroup=device.createBindGroup({layout:temporal.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:cameraUniform}},{binding:1,resource:{buffer:uniform}},{binding:3,resource:rawColor.createView()}]});
    dispatch(temporal,[cameraGroup,bind(temporal,1,[this.refined.createView(),this.guide.createView(),old.raw.createView(),old.state.createView(),old.output.createView(),current.raw.createView(),current.state.createView(),current.output.createView()])],timestamps(undefined,11));
    return current.output;
  }
  get bytes() {return this.frames?this.width*this.height*100:0;}
  get uniformBytes() {return this.weights?.size||0;}
  destroyTextures() {this.spatial?.destroy();this.refined?.destroy();this.guide?.destroy();this.frames?.forEach(f=>Object.values(f).forEach(t=>t.destroy()));this.frames=null;this.width=0;this.height=0;}
  dispose() {this.destroyTextures();this.weights.destroy();}
}
