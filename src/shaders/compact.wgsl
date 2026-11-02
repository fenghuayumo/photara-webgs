// Stable block compaction preserves Gaussian ID order for equal-depth ties.
@group(0) @binding(1) var<storage,read> sourceKeys: array<vec2u>;
@group(0) @binding(2) var<storage,read_write> destinationKeys: array<vec2u>;
@group(0) @binding(3) var<storage,read_write> ranks: array<u32>;
@group(0) @binding(4) var<storage,read_write> counts: array<u32>;
@group(0) @binding(5) var<storage,read_write> offsets: array<u32>;
@group(0) @binding(6) var<storage,read_write> sortParameters: array<u32>;
// drawIndirect (4 words), dispatchWorkgroupsIndirect (3 words), visible count.
@group(0) @binding(7) var<storage,read_write> indirect: array<u32>;
var<workgroup> scan: array<u32,256>;

@compute @workgroup_size(256)
fn countMain(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
    var visible = 0u;
    if (gid.x < cam.config.x) { visible = u32(sourceKeys[gid.x].x != 0xffffffffu); }
    scan[lane] = visible; workgroupBarrier();
    for (var step=1u; step<256u; step*=2u) {
        var value=0u; if (lane>=step) { value=scan[lane-step]; }
        workgroupBarrier(); scan[lane]+=value; workgroupBarrier();
    }
    if (gid.x < cam.config.x) { ranks[gid.x]=scan[lane]-visible; }
    if (lane==255u) { counts[group.x]=scan[lane]; }
}

@compute @workgroup_size(256)
fn prefixMain(@builtin(local_invocation_index) lane: u32) {
    let groups=(cam.config.x+255u)/256u; var carry=0u;
    for (var base=0u; base<groups; base+=256u) {
        let id=base+lane; var value=0u;
        if (id<groups) { value=counts[id]; }
        scan[lane]=value; workgroupBarrier();
        for (var step=1u; step<256u; step*=2u) {
            var previous=0u; if (lane>=step) { previous=scan[lane-step]; }
            workgroupBarrier(); scan[lane]+=previous; workgroupBarrier();
        }
        if (id<groups) { offsets[id]=carry+scan[lane]-value; }
        carry+=scan[255u]; workgroupBarrier();
    }
    if (lane<8u) {
        sortParameters[lane*64u]=carry;
        sortParameters[lane*64u+2u]=(carry+255u)/256u;
    }
    if (lane==0u) {
        indirect[0]=6u; indirect[1]=carry*select(1u,3u,cam.lens.x==3u);
        indirect[2]=0u; indirect[3]=0u;
        indirect[4]=(carry+255u)/256u; indirect[5]=1u; indirect[6]=1u;
        indirect[7]=carry;
    }
}

@compute @workgroup_size(256)
fn scatterMain(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x>=cam.config.x) { return; }
    let item=sourceKeys[gid.x];
    if (item.x!=0xffffffffu) { destinationKeys[offsets[gid.x/256u]+ranks[gid.x]]=item; }
}
