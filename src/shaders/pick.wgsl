// On-demand single-pixel picking. Scan sorted splats front-to-back in parallel
// batches; use the opacity median, or the strongest contribution for thin data.
@group(0) @binding(1) var<storage,read> projected: array<Projected>;
@group(0) @binding(2) var<storage,read> keys: array<vec2u>;
@group(0) @binding(3) var<storage,read> gaussians: array<Gaussian>;
@group(0) @binding(4) var<storage,read> indirect: array<u32>;
@group(0) @binding(5) var<uniform> request: vec4u; // pixel.xy, compact, reserved
@group(0) @binding(6) var<storage,read_write> result: vec4f;
var<workgroup> samples: array<vec2f,256>; // ray distance, alpha
var<workgroup> finished: u32;

fn sampleSplat(id: u32, pixel: vec2f, ray: vec3f) -> vec2f {
    let p = projected[id];
    if (p.color.w < ALPHA_FLOOR) { return vec2f(0); }
    var delta = pixel-p.centerConic.xy;
    if (cam.lens.x == 3u) { delta.x -= round(delta.x/cam.viewport.x)*cam.viewport.x; }
    let ownedPixel = p.centerConic.xy+delta;
    if (any(ownedPixel < p.bounds.xy) || any(ownedPixel > p.bounds.zw)) { return vec2f(0); }
    var distance = 0.0;
    let center = (cam.view*vec4f(gaussians[id].centerOpacity.xyz,1)).xyz;
    var depth = dot(center,ray);
    if (cam.lens.x == 0u) { depth = center.z/ray.z; }
    if (cam.lens.x == 1u) { depth = center.z; }
    if (cam.config.z == 1u) {
        var origin = vec3f(p.row0.w,p.row1.w,p.row2.w);
        if (cam.lens.x == 1u) {
            let offset = vec3f((pixel-cam.intrinsics.zw)/cam.intrinsics.xy,0);
            origin += vec3f(dot(p.row0.xyz,offset),dot(p.row1.xyz,offset),dot(p.row2.xyz,offset));
        }
        let d = vec3f(dot(p.row0.xyz,ray),dot(p.row1.xyz,ray),dot(p.row2.xyz,ray));
        let dd = dot(d,d);
        if (!(dd > 0.0)) { return vec2f(0); }
        depth = -dot(origin,d)/dd;
        let closest = origin+depth*d;
        distance = dot(closest,closest);
    } else {
        distance = p.centerConic.z*delta.x*delta.x+2.0*p.centerConic.w*delta.x*delta.y+p.row0.x*delta.y*delta.y;
    }
    let alpha = min(0.99,p.color.w*exp(-0.5*distance));
    if (!(depth > 0.0) || alpha < ALPHA_FLOOR) { return vec2f(0); }
    return vec2f(depth,alpha);
}

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lane: u32) {
    let pixel = vec2f(request.xy);
    let ray = pixelRay(pixel);
    let count = select(cam.config.x,indirect[7],request.z != 0u);
    var transmittance = 1.0;
    var strongest = 0.0;
    var depth = 0.0;
    if (lane == 0u) { finished = 0u; result = vec4f(0); }
    workgroupBarrier();
    for (var base = 0u; base < count; base += 256u) {
        var sample = vec2f(0);
        if (base+lane < count && dot(ray,ray) > 0.0) {
            let key = keys[count-1u-base-lane];
            if (key.x != 0xffffffffu) { sample = sampleSplat(key.y,pixel,ray); }
        }
        samples[lane] = sample;
        workgroupBarrier();
        if (lane == 0u) {
            for (var i = 0u; i < min(256u,count-base); i++) {
                let s = samples[i];
                let contribution = transmittance*s.y;
                if (contribution > strongest) { strongest = contribution; depth = s.x; }
                transmittance *= 1.0-s.y;
                if (transmittance <= 0.5) { depth = s.x; finished = 1u; break; }
            }
        }
        workgroupBarrier();
        if (workgroupUniformLoad(&finished) != 0u) { break; }
    }
    if (lane == 0u && transmittance <= 0.95 && depth > 0.0) {
        var point = ray*depth;
        if (cam.lens.x == 1u) { point += vec3f((pixel-cam.intrinsics.zw)/cam.intrinsics.xy,0); }
        let world = transpose(viewRotation())*(point-cam.view[3].xyz);
        result = vec4f(world,1.0-transmittance);
    }
}
