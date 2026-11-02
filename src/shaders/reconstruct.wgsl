// common.wgsl precedes this module. Spatial reconstruction and temporal
// reprojection are separate passes, never sampling an output being written.
struct HistoryCamera { previous: Camera, settings: vec4f };
@group(0) @binding(1) var rawColor: texture_2d<f32>;
@group(0) @binding(2) var rawDepth: texture_depth_2d;
@group(0) @binding(3) var spatialColor: texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var spatialDepth: texture_storage_2d<r32float,write>;

fn linearDepth(p: vec2i) -> f32 {
    let z = textureLoad(rawDepth,p,0);
    if (!(z>0.0)) { return 0.0; }
    return max(0.0,max(1e-6,cam.viewport.z)*(1.0/z-1.0));
}
@compute @workgroup_size(8,8)
fn spatialMain(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2i(cam.viewport.xy); let p = vec2i(id.xy);
    if (any(p>=size)) { return; }
    let centerDepth = linearDepth(p);
    var sum = vec3f(0); var weight = 0.0;
    var depthSum = 0.0; var depthWeight = 0.0;
    for (var y=-1; y<=1; y++) { for (var x=-1; x<=1; x++) {
        var q = p+vec2i(x,y);
        if (cam.lens.x==3u) { q.x = (q.x+size.x)%size.x; }
        if (any(q<vec2i(0)) || any(q>=size)) { continue; }
        let d = linearDepth(q);
        var w = f32((2-abs(x))*(2-abs(y)));
        // Keep discontinuities sharp; do not discard uncovered trials, which
        // are part of transparent coverage and must contribute background.
        if (centerDepth>0.0 && d>0.0) {
            let relative = abs(d-centerDepth)/max(centerDepth,1e-6);
            // Stochastic depth is itself a random visible layer, not a mesh
            // depth map. A hard bilateral gate would preserve the noise.
            w *= 0.5+0.5*exp(-relative*relative/0.0016);
        }
        sum += textureLoad(rawColor,q,0).rgb*w; weight += w;
        if (d>0.0) { depthSum+=d*w; depthWeight+=w; }
    } }
    textureStore(spatialColor,p,vec4f(sum/max(weight,1e-6),1));
    // Average stochastic hits into a reprojection hypothesis; per-trial center
    // depth would jump among transparent layers. Temporal checks still apply.
    textureStore(spatialDepth,p,vec4f(depthSum/max(depthWeight,1e-6),0,0,0));
}

@group(1) @binding(0) var<uniform> history: HistoryCamera;
@group(1) @binding(1) var currentColor: texture_2d<f32>;
@group(1) @binding(2) var currentDepth: texture_2d<f32>;
@group(1) @binding(3) var previousColor: texture_2d<f32>;
@group(1) @binding(4) var previousMeta: texture_2d<f32>;
@group(1) @binding(5) var outputColor: texture_storage_2d<rgba16float,write>;
@group(1) @binding(6) var outputMeta: texture_storage_2d<rg32float,write>;

fn previousProjection(t: vec3f) -> vec3f {
    let old = history.previous; var uv = vec2f(0); var valid = 1.0;
    if (cam.lens.x == 3u) {
        uv = vec2f(atan2(t.x,t.z),atan2(t.y,length(t.xz)));
    } else if (cam.lens.x == 2u) {
        let r=length(t.xy); let th=atan2(r,t.z); let q=th*th; let k=old.distortion;
        let td=th*(1.0+q*(k.x+q*(k.y+q*(k.z+q*k.w))));
        uv=t.xy*select(1.0,td/max(r,1e-8),r>1e-8);
        if (t.z<=0.0) { valid=0.0; }
    } else if (cam.lens.x == 1u) { uv=t.xy; }
    else { uv=t.xy/max(t.z,1e-8); if (t.z<=old.viewport.z) { valid=0.0; } }
    return vec3f(uv*old.intrinsics.xy+old.intrinsics.zw,valid);
}
@compute @workgroup_size(8,8)
fn temporalMain(@builtin(global_invocation_id) id: vec3u) {
    let size=vec2i(cam.viewport.xy); let p=vec2i(id.xy);
    if (any(p>=size)) { return; }
    let color=textureLoad(currentColor,p,0).rgb;
    let depth=textureLoad(currentDepth,p,0).x;
    var result=color; var count=1.0;
    if (history.settings.x>0.0 && depth>0.0) {
        let ray=pixelRay(vec2f(p));
        var point=ray*depth;
        // GS fisheye stores view Z; GUT fisheye stores radial ray distance.
        if (cam.lens.x==0u || (cam.lens.x==2u && cam.config.z==0u)) { point=ray*(depth/max(ray.z,1e-8)); }
        if (cam.lens.x==1u) { point=vec3f((vec2f(p)-cam.intrinsics.zw)/cam.intrinsics.xy,depth); }
        let world=transpose(viewRotation())*(point-cam.view[3].xyz);
        let previousPoint=(history.previous.view*vec4f(world,1)).xyz;
        let projected=previousProjection(previousPoint);
        let expected=select(previousPoint.z,length(previousPoint),cam.lens.x==3u || (cam.lens.x==2u && cam.config.z==1u));
        let origin=vec2i(floor(projected.xy)); let fraction=fract(projected.xy);
        var oldColor=vec3f(0); var oldCount=0.0; var accepted=0.0;
        // Bilinear gather with per-tap depth rejection: do not interpolate
        // foreground history into a disoccluded background pixel.
        for (var y=0; y<2; y++) { for (var x=0; x<2; x++) {
            var q=origin+vec2i(x,y);
            if (cam.lens.x==3u) { q.x=(q.x+size.x)%size.x; }
            if (projected.z==0.0 || any(q<vec2i(0)) || any(q>=size)) { continue; }
            let info=textureLoad(previousMeta,q,0).xy;
            let tolerance=max(1e-5,abs(expected)*0.1);
            if (!(info.x>0.0) || abs(info.x-expected)>tolerance) { continue; }
            let w=select(1.0-fraction.x,fraction.x,x==1)*select(1.0-fraction.y,fraction.y,y==1);
            oldColor+=textureLoad(previousColor,q,0).rgb*w; oldCount+=info.y*w; accepted+=w;
        } }
        if (accepted>0.25) {
            oldColor/=accepted; oldCount/=accepted;
            var low=color; var high=color;
            for (var y=-1; y<=1; y++) { for (var x=-1; x<=1; x++) {
                var q=p+vec2i(x,y);
                if (cam.lens.x==3u) { q.x=(q.x+size.x)%size.x; }
                q=clamp(q,vec2i(0),size-1);
                let neighbour=textureLoad(currentColor,q,0).rgb;
                low=min(low,neighbour); high=max(high,neighbour);
            } }
            // Clamp history to current support; cap age so moving edges react.
            count=min(8.0,oldCount+1.0);
            let weight=min(0.85,(count-1.0)/count)*accepted;
            result=mix(color,clamp(oldColor,low,high),weight);
        }
    }
    textureStore(outputColor,p,vec4f(result,1));
    textureStore(outputMeta,p,vec4f(depth,count,0,0));
}
