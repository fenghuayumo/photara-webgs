@group(0) @binding(1) var<storage,read> projected: array<Projected>;
@group(0) @binding(2) var<storage,read> keys: array<vec2u>;
@group(0) @binding(3) var rays: texture_2d<f32>;
struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(flat) id: u32,
    @location(1) @interpolate(flat) seamShift: f32,
};
@vertex fn vertexMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
    var out: VertexOut;
    let seamCopies = cam.lens.x==3u;
    let index = select(instance,instance/3u,seamCopies);
    let id = keys[index].y;
    out.id = id;
    out.seamShift = 0.0;
    let p = projected[id];
    if (p.extra.y==0.0) { out.position=vec4f(2,2,0.5,1); return out; }
    let corners = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(1,1),vec2f(0,0),vec2f(1,1),vec2f(0,1));
    var pixel = mix(p.bounds.xy,p.bounds.zw,corners[vertex]);
    if (seamCopies) {
        out.seamShift = (f32(instance%3u)-1.0)*cam.viewport.x;
        pixel.x += out.seamShift;
    }
    let ndc = (pixel+0.5)/cam.viewport.xy*2.0-1.0;
    out.position = vec4f(ndc.x,-ndc.y,0.5,1);
    return out;
}
@fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
    let p = projected[input.id];
    // Photara CUDA/Vulkan samples integer pixel coordinates. WebGPU fragment
    // positions are half-integers, so floor here deliberately removes 0.5.
    let pixel = floor(input.position.xy);
    var distance = 0.0;
    if (cam.config.z==1u) {
        if (cam.lens.x==3u) {
            let dx = pixel.x-p.centerConic.x-input.seamShift;
            if (dx < -0.5*cam.viewport.x || dx >= 0.5*cam.viewport.x) { discard; }
        }
        var ray = vec3f(0,0,1);
        if (cam.lens.x>=2u) { ray = textureLoad(rays,vec2i(pixel),0).xyz; }
        else if (cam.lens.x==0u) { ray = normalize(vec3f((pixel-cam.intrinsics.zw)/cam.intrinsics.xy,1)); }
        if (!(dot(ray,ray)>0.0)) { discard; }
        var origin = vec3f(p.row0.w,p.row1.w,p.row2.w);
        if (cam.lens.x==1u) {
            let offset = vec3f((pixel-cam.intrinsics.zw)/cam.intrinsics.xy,0);
            origin += vec3f(dot(p.row0.xyz,offset),dot(p.row1.xyz,offset),dot(p.row2.xyz,offset));
        }
        let d = vec3f(dot(p.row0.xyz,ray),dot(p.row1.xyz,ray),dot(p.row2.xyz,ray));
        let dd = dot(d,d);
        let peak = -dot(origin,d)/dd;
        if (!(dd>0.0) || !(peak>0.0)) { discard; }
        let closest = origin+peak*d;
        distance = dot(closest,closest);
    } else {
        var delta = pixel-p.centerConic.xy;
        if (cam.lens.x==3u) {
            delta.x -= input.seamShift;
            // Only the nearest periodic copy owns a pixel, including splats
            // wider than half the panorama. Prevent duplicate alpha blending.
            if (delta.x < -0.5*cam.viewport.x || delta.x >= 0.5*cam.viewport.x) { discard; }
        }
        distance = p.centerConic.z*delta.x*delta.x+2.0*p.centerConic.w*delta.x*delta.y+p.extra.x*delta.y*delta.y;
    }
    let alpha = min(0.99,p.color.w*exp(-0.5*distance));
    if (alpha<ALPHA_FLOOR) { discard; }
    return vec4f(p.color.xyz*alpha,alpha);
}
