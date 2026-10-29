// Camera-space rays depend on intrinsics, not pose or individual Gaussians.
@group(0) @binding(1) var outputRays: texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy>=vec2u(cam.viewport.xy))) { return; }
    textureStore(outputRays,vec2i(id.xy),vec4f(pixelRay(vec2f(id.xy)),0));
}
