struct SpatialBlock { centerScale: vec4f, extent: vec4f };
@group(0) @binding(1) var<storage,read> blocks: array<SpatialBlock>;
@group(0) @binding(2) var<storage,read_write> blockVisible: array<u32>;
fn ratioInterval(a: vec2f,z: vec2f) -> vec2f {
    let q=vec4f(a.x/z.x,a.x/z.y,a.y/z.x,a.y/z.y);
    return vec2f(min(min(q.x,q.y),min(q.z,q.w)),max(max(q.x,q.y),max(q.z,q.w)));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let index=id.x;if(index>=(cam.config.x+255u)/256u){return;}
    blockVisible[index]=1u;
    let b=blocks[index];
    let center=(cam.view*vec4f(b.centerScale.xyz,1)).xyz;
    let rotation=viewRotation();
    let extent=abs(rotation[0])*b.extent.x+abs(rotation[1])*b.extent.y+abs(rotation[2])*b.extent.z;
    let padding=1e-5*(abs(center)+extent+vec3f(1));
    let lo=center-extent-padding;let hi=center+extent+padding;
    // Unsafe ranges and near-plane crossings deliberately retain the block.
    if(!all(abs(lo)<vec3f(1e30))||!all(abs(hi)<vec3f(1e30))||!(b.centerScale.w*cam.viewport.w<1e30)){return;}
    if(hi.z<=cam.viewport.z){blockVisible[index]=0u;return;}
    if(lo.z<=max(1e-6,cam.viewport.z)){return;}
    let s=b.centerScale.w*cam.viewport.w;
    var x=vec2f(lo.x,hi.x);var y=vec2f(lo.y,hi.y);
    var support=vec2f(0);
    if(cam.lens.x==0u){
        x=ratioInterval(x,vec2f(lo.z,hi.z));y=ratioInterval(y,vec2f(lo.z,hi.z));
        // The GS Jacobian clamps x/z,y/z, even with an off-centre principal
        // point. Bound THAT covariance, not a physical ellipsoid/frustum.
        let limit=1.3*cam.viewport.xy/(2.0*cam.intrinsics.xy);
        let axis=s*cam.intrinsics.xy*sqrt(vec2f(1)+limit*limit)/lo.z;
        support=sqrt(12.0*(axis*axis+vec2f(.3)))+2.0;
    }else{
        let axis=s*cam.intrinsics.xy;
        support=sqrt(12.0*(axis*axis+vec2f(.3)))+2.0;
    }
    x=x*cam.intrinsics.x+cam.intrinsics.z;
    y=y*cam.intrinsics.y+cam.intrinsics.w;
    if(x.y+support.x<0.0||x.x-support.x>cam.viewport.x||y.y+support.y<0.0||y.x-support.y>cam.viewport.y){blockVisible[index]=0u;}
}
