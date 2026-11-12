// Photara kernel prediction and dual-path temporal reconstruction.
// Trained from scratch; all coordinates use our native CV camera convention.
struct HistoryCamera { previous: Camera, settings: vec4f };
@group(0) @binding(1) var<uniform> history: HistoryCamera;
@group(0) @binding(2) var<storage,read> weights: array<f32>;
@group(0) @binding(3) var noisy: texture_2d<f32>;
@group(0) @binding(4) var depthSource: texture_depth_2d;
@group(0) @binding(5) var spatial: texture_storage_2d<rgba16float,write>;
@group(0) @binding(6) var guide: texture_storage_2d<r32float,write>;

fn bounded(p: vec2i) -> vec2i {
    let size=vec2i(cam.viewport.xy);var q=p;
    if(cam.lens.x==3u){q.x=(q.x%size.x+size.x)%size.x;}
    return clamp(q,vec2i(0),size-1);
}
fn luminance(c: vec3f) -> f32 {return dot(c,vec3f(.2126,.7152,.0722));}
fn linearDepth(p: vec2i) -> f32 {
    let d=textureLoad(depthSource,bounded(p),0);
    return select(0.0,max(1e-6,cam.viewport.z)*(1.0/max(d,1e-20)-1.0),d>0.0);
}
@compute @workgroup_size(8,8)
fn spatialMain(@builtin(global_invocation_id) id: vec3u) {
    let p=vec2i(id.xy);if(any(p>=vec2i(cam.viewport.xy))){return;}
    var inputs: array<f32,16>;var colors: array<vec3f,9>;
    var mean=0.0;var second=0.0;var wide=vec3f(0);
    var nearest=vec3f(1e30);var depthSum=0.0;var hits=0.0;
    for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
        let i=u32((y+1)*3+x+1);let q=bounded(p+vec2i(x,y));
        let color=textureLoad(noisy,q,0).rgb;colors[i]=color;
        let l=luminance(color);inputs[i]=l;mean+=l/9.0;second+=l*l/9.0;
        wide+=textureLoad(noisy,bounded(p+vec2i(x,y)*2),0).rgb*f32((2-abs(x))*(2-abs(y)))/16.0;
        let depth=linearDepth(q);
        if(depth>0.0){
            let a=max(nearest.x,depth);let b=max(nearest.y,a);
            nearest=vec3f(min(nearest.x,depth),min(nearest.y,a),min(nearest.z,b));
            depthSum+=depth;hits+=1.0;
        }
    }}
    inputs[9]=colors[4].r;inputs[10]=colors[4].g;inputs[11]=colors[4].b;
    inputs[12]=wide.r;inputs[13]=wide.g;inputs[14]=wide.b;inputs[15]=max(0.0,second-mean*mean);
    var hidden: array<f32,24>;
    for(var o=0u;o<24u;o++){
        var value=weights[384u+o];
        for(var i=0u;i<16u;i++){value+=weights[o*16u+i]*inputs[i];}
        hidden[o]=value/(1.0+exp(-value));
    }
    var logits: array<f32,10>;var peak=-1e30;
    for(var o=0u;o<10u;o++){
        var value=weights[648u+o];
        for(var i=0u;i<24u;i++){value+=weights[408u+o*24u+i]*hidden[i];}
        logits[o]=value;if(o<9u){peak=max(peak,value);}
    }
    var sum=vec3f(0);var total=0.0;
    for(var i=0u;i<9u;i++){let w=exp(logits[i]-peak);sum+=w*colors[i];total+=w;}
    let color=mix(sum/total,wide,1.0/(1.0+exp(-logits[9])));
    // Third nearest rejects isolated foreground hits; a sparse neighbourhood
    // borrows its mean, keeping transparent rims attached to visible content.
    let depth=select(depthSum/max(hits,1.0),nearest.z,hits>=3.0);
    textureStore(spatial,p,vec4f(color,inputs[15]));
    textureStore(guide,p,vec4f(depth,0,0,0));
}

@group(1) @binding(0) var filtered: texture_2d<f32>;
@group(1) @binding(1) var depthGuide: texture_2d<f32>;
@group(1) @binding(2) var previousRaw: texture_2d<f32>;
@group(1) @binding(3) var previousState: texture_2d<f32>;
@group(1) @binding(4) var previousOutput: texture_2d<f32>;
@group(1) @binding(5) var nextRaw: texture_storage_2d<rgba32float,write>;
@group(1) @binding(6) var nextState: texture_storage_2d<rgba32float,write>;
@group(1) @binding(7) var output: texture_storage_2d<rgba16float,write>;

// Conservative postfilter at a larger footprint. Learned kernels handle the
// immediate edge; variance controls the remaining broad stochastic speckles.
@group(2) @binding(0) var refineInput:texture_2d<f32>;
@group(2) @binding(1) var refineOutput:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8)
fn refineMain(@builtin(global_invocation_id) id:vec3u){
    let p=vec2i(id.xy);if(any(p>=vec2i(cam.viewport.xy))){return;}
    let center=textureLoad(refineInput,p,0);
    let sigma=2.0*sqrt(max(center.a,0.0)/9.0)+.01;
    var sum=vec3f(0);var total=0.0;
    for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
        let c=textureLoad(refineInput,bounded(p+vec2i(x,y)*2),0);
        let w=f32((2-abs(x))*(2-abs(y)))*exp(-abs(luminance(c.rgb)-luminance(center.rgb))/sigma);
        sum+=c.rgb*w;total+=w;
    }}
    textureStore(refineOutput,p,vec4f(sum/total,center.a));
}

struct Reprojected {raw:vec3f,display:vec3f,state:vec4f,support:f32,motion:f32};
fn historyAt(p:vec2i,depth:f32) -> Reprojected {
    var result:Reprojected;
    if(history.settings.x==0.0||!(depth>0.0)){return result;}
    let ray=pixelRay(vec2f(p));var point=ray*depth;
    if(cam.lens.x==0u||(cam.lens.x==2u&&cam.config.z==0u)){point=ray*(depth/max(ray.z,1e-8));}
    if(cam.lens.x==1u){point=vec3f((vec2f(p)-cam.intrinsics.zw)/cam.intrinsics.xy,depth);}
    let world=transpose(viewRotation())*(point-cam.view[3].xyz);
    let old=(history.previous.view*vec4f(world,1)).xyz;
    let previous=history.previous;var uv=vec2f(0);var valid=true;
    if(cam.lens.x==3u){uv=vec2f(atan2(old.x,old.z),atan2(old.y,length(old.xz)));}
    else if(cam.lens.x==2u){
        let r=length(old.xy);let th=atan2(r,old.z);let t=th*th;let k=previous.distortion;
        uv=old.xy*(th*(1.0+t*(k.x+t*(k.y+t*(k.z+t*k.w))))/max(r,1e-8));valid=old.z>0.0;
    }else if(cam.lens.x==1u){uv=old.xy;}
    else{uv=old.xy/max(old.z,1e-8);valid=old.z>previous.viewport.z;}
    let pixel=uv*previous.intrinsics.xy+previous.intrinsics.zw;
    let expected=select(old.z,length(old),cam.lens.x==3u||(cam.lens.x==2u&&cam.config.z==1u));
    let base=vec2i(floor(pixel));let t=fract(pixel);let size=vec2i(cam.viewport.xy);
    var movement=pixel-vec2f(p);
    if(cam.lens.x==3u){movement.x-=round(movement.x/cam.viewport.x)*cam.viewport.x;}
    result.motion=length(movement);
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){
        var q=base+vec2i(x,y);if(cam.lens.x==3u){q.x=(q.x%size.x+size.x)%size.x;}
        if(!valid||any(q<vec2i(0))||any(q>=size)){continue;}
        let state=textureLoad(previousState,q,0);
        if(!(state.x>0.0)||abs(state.x-expected)>max(1e-5,abs(expected)*.15)){continue;}
        let w=select(1.0-t.x,t.x,x==1)*select(1.0-t.y,t.y,y==1);
        result.raw+=textureLoad(previousRaw,q,0).rgb*w;
        result.display+=textureLoad(previousOutput,q,0).rgb*w;result.state+=state*w;result.support+=w;
    }}
    if(result.support>.25){result.raw/=result.support;result.display/=result.support;result.state/=result.support;}
    else{result.support=0.0;}
    return result;
}
@compute @workgroup_size(8,8)
fn temporalMain(@builtin(global_invocation_id) id:vec3u){
    let p=vec2i(id.xy);if(any(p>=vec2i(cam.viewport.xy))){return;}
    let sample=textureLoad(noisy,p,0).rgb;let spatialColor=textureLoad(filtered,p,0);
    let depth=textureLoad(depthGuide,p,0).x;let old=historyAt(p,depth);
    var low=spatialColor.rgb;var high=low;var rawLow=sample;var rawHigh=sample;
    for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
        let q=bounded(p+vec2i(x,y));let c=textureLoad(filtered,q,0).rgb;let raw=textureLoad(noisy,q,0).rgb;
        low=min(low,c);high=max(high,c);rawLow=min(rawLow,raw);rawHigh=max(rawHigh,raw);
    }}
    var count=1.0;var weight=0.0;
    if(old.support>0.0){
        weight=min(.97,old.state.y/(old.state.y+1.0))*old.support;
        count=min(64.0,1.0/((1.0-weight)*(1.0-weight)+weight*weight/max(old.state.y,1.0)));
    }
    let y=luminance(sample);let moments=mix(vec2f(y,y*y),old.state.zw,weight);
    let raw=mix(sample,clamp(old.raw,rawLow,rawHigh),weight);
    let variance=max(0.0,moments.y-moments.x*moments.x);
    // Variance chooses between sharp sample accumulation and the neural
    // spatial fallback. The filtered display never feeds raw statistics.
    let error=sqrt(variance/max(count,1.0));
    let gate=clamp(5.0*error+exp(-count/8.0),0.0,1.0);
    let color=mix(raw,spatialColor.rgb,gate);
    let slack=vec3f(.01);let clipped=clamp(old.display,low-slack,high+slack);
    let difference=length(clipped-spatialColor.rgb);
    let stableWeight=select(0.0,.85*old.support*exp(-difference*6.0)/(1.0+old.motion*.05),old.support>0.0);
    textureStore(nextRaw,p,vec4f(raw,1));
    textureStore(nextState,p,vec4f(depth,count,moments));
    textureStore(output,p,vec4f(mix(color,clipped,stableWeight),1));
}
