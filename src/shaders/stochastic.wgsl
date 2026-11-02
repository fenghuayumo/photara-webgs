// common.wgsl and draw.wgsl precede this module. One independent Bernoulli
// coverage trial per pixel / Gaussian / seed, followed by opaque depth testing.
@group(0) @binding(4) var<uniform> stochastic: vec4u;
fn hash(value: u32) -> u32 {
    var h = value;
    h = (h ^ (h >> 16u))*0x7feb352du;
    h = (h ^ (h >> 15u))*0x846ca68bu;
    return h ^ (h >> 16u);
}
struct StochasticOut {
    @location(0) color: vec4f,
    @builtin(frag_depth) depth: f32,
};
fn stochasticResponse(input: VertexOut) -> vec2f {
    let response = gaussianResponse(input);
    let pixel = vec2u(floor(input.position.xy));
    var random = f32(hash(hash(pixel.x+pixel.y*u32(cam.viewport.x)) ^ hash(input.id) ^ hash(stochastic.x)) >> 8u)/16777216.0;
    if (stochastic.y != 0u) {
        // Randomly permuted four strata in each 2x2 pixel quad. Every pixel
        // remains marginally uniform, but smooth alpha covers the quad evenly.
        let quad = pixel/2u;
        let h = hash(hash(quad.x+quad.y*((u32(cam.viewport.x)+1u)/2u)) ^ hash(input.id) ^ hash(stochastic.x));
        let lane = (pixel.x&1u)+2u*(pixel.y&1u);
        let stratum = (lane*select(1u,3u,(h&1u)!=0u)+(h>>1u))&3u;
        random = (f32(stratum)+f32(hash(h)>>8u)/16777216.0)*0.25;
    }
    if (random >= response.x || !(response.y > 0.0)) { discard; }
    return response;
}
@vertex fn stochasticGSVertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
    var out = vertexQuad(vertex,instance);
    if(out.position.x==2.0&&out.position.y==2.0){return out;}
    let near = max(1e-6,cam.viewport.z);
    out.position.z = near/(near+max(0.0,projected[out.id].row0.y));
    return out;
}
// GS uses a constant center depth per quad, allowing hardware early-Z instead
// of writing frag_depth. GUT retains its per-ray peak and late depth below.
@fragment fn stochasticGSMain(input: VertexOut) -> @location(0) vec4f {
    let response = stochasticResponse(input);
    return vec4f(projected[input.id].color.xyz,1);
}
@fragment fn stochasticMain(input: VertexOut) -> StochasticOut {
    let response = stochasticResponse(input);
    var out: StochasticOut;
    out.color = vec4f(projected[input.id].color.xyz,1);
    // Infinite-far reversed depth preserves useful precision with tiny near
    // values. Panoramas use radial depth, other GS lenses use center view Z;
    // GUT uses the response peak along the actual pixel ray.
    let near = max(1e-6,cam.viewport.z);
    out.depth = near/(near+response.y);
    return out;
}
