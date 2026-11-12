// SVGF-like reconstruction for stochastic coverage. No noise-free normals are
// available: depth is a soft reprojection hypothesis, not a mesh surface.
struct HistoryCamera { previous: Camera, settings: vec4f };
@group(0) @binding(1) var<uniform> history: HistoryCamera;
@group(0) @binding(2) var currentColor: texture_2d<f32>;
@group(0) @binding(3) var currentDepth: texture_2d<f32>;
@group(0) @binding(4) var previousColor: texture_2d<f32>;
@group(0) @binding(5) var previousMeta: texture_2d<f32>;
@group(0) @binding(6) var outputColor: texture_storage_2d<rgba16float,write>;
@group(0) @binding(7) var outputMeta: texture_storage_2d<rgba32float,write>;

fn address(p: vec2i) -> vec2i {
    let size=vec2i(cam.viewport.xy); var q=p;
    if(cam.lens.x==3u) { q.x=(q.x%size.x+size.x)%size.x; }
    return clamp(q,vec2i(0),size-1);
}
fn luma(c: vec3f) -> f32 { return dot(c,vec3f(0.2126,0.7152,0.0722)); }
fn previousProjection(t: vec3f) -> vec3f {
    let old=history.previous; var uv=vec2f(0); var valid=1.0;
    if(cam.lens.x==3u) { uv=vec2f(atan2(t.x,t.z),atan2(t.y,length(t.xz))); }
    else if(cam.lens.x==2u) {
        let r=length(t.xy); let th=atan2(r,t.z); let q=th*th; let k=old.distortion;
        let td=th*(1.0+q*(k.x+q*(k.y+q*(k.z+q*k.w))));
        uv=t.xy*select(1.0,td/max(r,1e-8),r>1e-8);
        if(t.z<=0.0) { valid=0.0; }
    } else if(cam.lens.x==1u) { uv=t.xy; }
    else { uv=t.xy/max(t.z,1e-8); if(t.z<=old.viewport.z) { valid=0.0; } }
    return vec3f(uv*old.intrinsics.xy+old.intrinsics.zw,valid);
}
struct Reprojected { color: vec3f, stats: vec4f, accepted: f32, motion: f32 };
fn reproject(p: vec2i,depth: f32) -> Reprojected {
    var result: Reprojected;
    if(history.settings.x==0.0 || !(depth>0.0)) { return result; }
    let ray=pixelRay(vec2f(p)); var point=ray*depth;
    if(cam.lens.x==0u || (cam.lens.x==2u && cam.config.z==0u)) { point=ray*(depth/max(ray.z,1e-8)); }
    if(cam.lens.x==1u) { point=vec3f((vec2f(p)-cam.intrinsics.zw)/cam.intrinsics.xy,depth); }
    let world=transpose(viewRotation())*(point-cam.view[3].xyz);
    let oldPoint=(history.previous.view*vec4f(world,1)).xyz;
    let projected=previousProjection(oldPoint);
    let expected=select(oldPoint.z,length(oldPoint),cam.lens.x==3u || (cam.lens.x==2u && cam.config.z==1u));
    let origin=vec2i(floor(projected.xy)); let fraction=fract(projected.xy);
    let size=vec2i(cam.viewport.xy);
    var delta=projected.xy-vec2f(p);
    if(cam.lens.x==3u) { delta.x-=round(delta.x/cam.viewport.x)*cam.viewport.x; }
    result.motion=length(delta);
    for(var y=0;y<2;y++) { for(var x=0;x<2;x++) {
        var q=origin+vec2i(x,y);
        if(cam.lens.x==3u) { q.x=(q.x%size.x+size.x)%size.x; }
        if(projected.z==0.0 || any(q<vec2i(0)) || any(q>=size)) { continue; }
        let stats=textureLoad(previousMeta,q,0);
        if(!(stats.x>0.0) || abs(stats.x-expected)>max(1e-5,abs(expected)*0.1)) { continue; }
        let w=select(1.0-fraction.x,fraction.x,x==1)*select(1.0-fraction.y,fraction.y,y==1);
        result.color+=textureLoad(previousColor,q,0).rgb*w;
        result.stats+=stats*w; result.accepted+=w;
    } }
    if(result.accepted>0.25) { result.color/=result.accepted; result.stats/=result.accepted; }
    else { result.accepted=0.0; }
    return result;
}

@compute @workgroup_size(8,8)
fn integrateMain(@builtin(global_invocation_id) id: vec3u) {
    let p=vec2i(id.xy); if(any(p>=vec2i(cam.viewport.xy))) { return; }
    let color=textureLoad(currentColor,p,0).rgb;
    let depth=textureLoad(currentDepth,p,0).x;
    let old=reproject(p,depth); let y=luma(color);
    var count=1.0; var weight=0.0;
    if(old.accepted>0.0) {
        count=min(32.0,old.stats.y+1.0);
        weight=min(0.96,(count-1.0)/count)*old.accepted;
        // Partial reprojection reduces effective samples even if history is
        // old. Using age here underestimates variance and protects noise.
        count=min(32.0,1.0/((1.0-weight)*(1.0-weight)+weight*weight/max(old.stats.y,1.0)));
    }
    // Raw observations drive moments. Spatially blurred input would
    // underestimate variance and permanently bake blur into temporal history.
    let moments=mix(vec2f(y,y*y),old.stats.zw,weight);
    var localMean=0.0; var localSecond=0.0;
    var low=color; var high=color;
    for(var j=-1;j<=1;j++) { for(var i=-1;i<=1;i++) {
        let c=textureLoad(currentColor,address(p+vec2i(i,j)),0).rgb; let v=luma(c);
        localMean+=v/9.0; localSecond+=v*v/9.0; low=min(low,c); high=max(high,c);
    } }
    let temporalVariance=max(0.0,moments.y-moments.x*moments.x);
    let spatialVariance=max(0.0,localSecond-localMean*localMean);
    let variance=mix(spatialVariance,temporalVariance,min(1.0,(count-1.0)/4.0));
    let integrated=mix(color,clamp(old.color,low,high),weight);
    textureStore(outputColor,p,vec4f(integrated,variance/max(count,1.0)));
    textureStore(outputMeta,p,vec4f(depth,count,moments));
}

// A separate layout permits all wavelet iterations to share one pipeline.
@group(1) @binding(0) var waveletColor: texture_2d<f32>;
@group(1) @binding(1) var waveletMeta: texture_2d<f32>;
@group(1) @binding(2) var waveletOutput: texture_storage_2d<rgba16float,write>;
@group(1) @binding(3) var<uniform> waveletSettings: vec4u;
@compute @workgroup_size(8,8)
fn atrousMain(@builtin(global_invocation_id) id: vec3u) {
    let p=vec2i(id.xy); if(any(p>=vec2i(cam.viewport.xy))) { return; }
    let center=textureLoad(waveletColor,p,0); let stats=textureLoad(waveletMeta,p,0);
    var variance=0.0;
    for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) {
        variance+=textureLoad(waveletColor,address(p+vec2i(x,y)),0).a/9.0;
    } }
    // Wavelet taps and reprojected histories are correlated. Propagating
    // squared weights alone shrinks variance too far after the first pass.
    // Retain an observation-moment floor so bright outliers are not mistaken
    // for sharp detail by subsequent scales.
    let observationVariance=max(0.0,stats.w-stats.z*stats.z)/max(stats.y,1.0);
    let sigma=8.0*sqrt(max(variance,observationVariance*0.25))+0.01;
    var sum=vec3f(0); var weights=0.0; var varSum=0.0;
    for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) {
        let q=address(p+vec2i(x,y)*i32(waveletSettings.x));
        let c=textureLoad(waveletColor,q,0); let d=textureLoad(waveletMeta,q,0).x;
        var w=f32((2-abs(x))*(2-abs(y)))*exp(-abs(luma(c.rgb)-luma(center.rgb))/sigma);
        // Missing coverage contributes background. Avoid interpreting random
        // layer changes as deterministic surface boundaries.
        if(stats.x>0.0 && d>0.0) { w*=0.5+0.5*exp(-abs(d-stats.x)/(max(d,stats.x)*0.15+1e-5)); }
        sum+=c.rgb*w; weights+=w; varSum+=c.a*w*w;
    } }
    textureStore(waveletOutput,p,vec4f(sum/max(weights,1e-6),varSum/max(weights*weights,1e-6)));
}

@compute @workgroup_size(8,8)
fn taaMain(@builtin(global_invocation_id) id: vec3u) {
    let p=vec2i(id.xy); if(any(p>=vec2i(cam.viewport.xy))) { return; }
    let color=textureLoad(currentColor,p,0).rgb; let depth=textureLoad(currentDepth,p,0).x;
    let old=reproject(p,depth); var low=color; var high=color;
    for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) {
        let c=textureLoad(currentColor,address(p+vec2i(x,y)),0).rgb; low=min(low,c); high=max(high,c);
    } }
    // TAA stabilizes residual flicker with a shorter history during motion.
    // No extra jitter: the renderer uses calibrated integer pixel samples.
    let weight=select(0.0,mix(0.85,0.5,clamp(old.motion/8.0,0.0,1.0))*old.accepted,old.accepted>0.0);
    textureStore(outputColor,p,vec4f(mix(color,clamp(old.color,low,high),weight),1));
}
