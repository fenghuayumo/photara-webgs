// Stable LSD radix sort, 4 bits/pass, 8 passes. No readback or subgroup features.
struct Params { count: u32, shift: u32, groups: u32, unused: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage,read> inputKeys: array<vec2u>;
@group(0) @binding(2) var<storage,read_write> outputKeys: array<vec2u>;
@group(0) @binding(3) var<storage,read_write> ranks: array<u32>;
@group(0) @binding(4) var<storage,read_write> histogram: array<u32>;
@group(0) @binding(5) var<storage,read_write> prefixes: array<u32>;
@group(0) @binding(6) var<storage,read_write> totals: array<u32>;
// Exactly 16 KiB for histogramMain (portable minimum workgroup storage).
var<workgroup> h0: array<vec4u,256>;
var<workgroup> h1: array<vec4u,256>;
var<workgroup> h2: array<vec4u,256>;
var<workgroup> h3: array<vec4u,256>;
var<workgroup> scan: array<u32,256>;
fn flags(digit: u32, base: u32, valid: bool) -> vec4u {
    return vec4u(select(vec4u(0),vec4u(1),vec4u(digit)==vec4u(base,base+1u,base+2u,base+3u))) * u32(valid);
}
@compute @workgroup_size(256)
fn histogramMain(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
    let valid = gid.x < params.count;
    var digit = 0u;
    if (valid) { digit = (inputKeys[gid.x].x>>params.shift)&15u; }
    h0[lane]=flags(digit,0u,valid); h1[lane]=flags(digit,4u,valid);
    h2[lane]=flags(digit,8u,valid); h3[lane]=flags(digit,12u,valid);
    workgroupBarrier();
    for (var offset=1u; offset<256u; offset*=2u) {
        var a=vec4u(0); var b=vec4u(0); var c=vec4u(0); var d=vec4u(0);
        if (lane>=offset) { a=h0[lane-offset]; b=h1[lane-offset]; c=h2[lane-offset]; d=h3[lane-offset]; }
        workgroupBarrier();
        h0[lane]+=a; h1[lane]+=b; h2[lane]+=c; h3[lane]+=d;
        workgroupBarrier();
    }
    if (valid) {
        var rank=0u;
        switch (digit/4u) {
            case 0u: { rank=h0[lane][digit%4u]; }
            case 1u: { rank=h1[lane][digit%4u]; }
            case 2u: { rank=h2[lane][digit%4u]; }
            default: { rank=h3[lane][digit%4u]; }
        }
        ranks[gid.x]=rank-1u;
    }
    if (lane<16u) {
        var n=0u;
        switch (lane/4u) {
            case 0u: { n=h0[255u][lane%4u]; }
            case 1u: { n=h1[255u][lane%4u]; }
            case 2u: { n=h2[255u][lane%4u]; }
            default: { n=h3[255u][lane%4u]; }
        }
        histogram[lane*params.groups+group.x]=n;
    }
}
@compute @workgroup_size(256)
fn prefixMain(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
    let digit=group.x;
    var carry=0u;
    for (var base=0u; base<params.groups; base+=256u) {
        let id=base+lane;
        var value=0u;
        if (id<params.groups) { value=histogram[digit*params.groups+id]; }
        scan[lane]=value;
        workgroupBarrier();
        for (var offset=1u; offset<256u; offset*=2u) {
            var n=0u;
            if (lane>=offset) { n=scan[lane-offset]; }
            workgroupBarrier(); scan[lane]+=n; workgroupBarrier();
        }
        if (id<params.groups) { prefixes[digit*params.groups+id]=carry+scan[lane]-value; }
        carry+=scan[255u];
        workgroupBarrier();
    }
    if (lane==0u) { totals[digit]=carry; }
}
@compute @workgroup_size(256)
fn scatterMain(@builtin(global_invocation_id) gid: vec3u) {
    let id=gid.x;
    if (id>=params.count) { return; }
    let item=inputKeys[id]; let digit=(item.x>>params.shift)&15u;
    var base=0u;
    for (var d=0u; d<digit; d++) { base+=totals[d]; }
    let destination=base+prefixes[digit*params.groups+id/256u]+ranks[id];
    outputKeys[destination]=item;
}
