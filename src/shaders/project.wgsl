// common.wgsl is prepended by the loader.
@group(0) @binding(1) var<storage,read> gaussians: array<Gaussian>;
@group(0) @binding(2) var<storage,read> harmonics: array<f32>;
@group(0) @binding(3) var<storage,read_write> projected: array<Projected>;
@group(0) @binding(4) var<storage,read_write> keys: array<vec2u>;
fn coeff(id: u32, b: u32) -> vec3f {
    let k = (id*cam.config.y+b)*3u;
    return vec3f(harmonics[k],harmonics[k+1u],harmonics[k+2u]);
}
fn colorSH(id: u32, center: vec3f) -> vec3f {
    var rgb = 0.28209479177387814*coeff(id,0u);
    let delta = center-cam.eye.xyz;
    if (cam.lens.y == 0u || length(delta) < 1e-8) { return max(rgb+0.5,vec3f(0)); }
    let dir = normalize(delta); let x = dir.x; let y = dir.y; let z = dir.z;
    rgb += 0.4886025119029199*(-y*coeff(id,1u)+z*coeff(id,2u)-x*coeff(id,3u));
    if (cam.lens.y > 1u) {
        let xx=x*x; let yy=y*y; let zz=z*z;
        rgb += 1.0925484305920792*x*y*coeff(id,4u)
             - 1.0925484305920792*y*z*coeff(id,5u)
             + 0.31539156525252005*(2.0*zz-xx-yy)*coeff(id,6u)
             - 1.0925484305920792*x*z*coeff(id,7u)
             + 0.5462742152960396*(xx-yy)*coeff(id,8u);
        if (cam.lens.y > 2u) {
            rgb += -0.5900435899266435*y*(3.0*xx-yy)*coeff(id,9u)
                 + 2.890611442640554*x*y*z*coeff(id,10u)
                 - 0.4570457994644658*y*(4.0*zz-xx-yy)*coeff(id,11u)
                 + 0.3731763325901154*z*(2.0*zz-3.0*xx-3.0*yy)*coeff(id,12u)
                 - 0.4570457994644658*x*(4.0*zz-xx-yy)*coeff(id,13u)
                 + 1.445305721320277*z*(xx-yy)*coeff(id,14u)
                 - 0.5900435899266435*x*(xx-3.0*yy)*coeff(id,15u);
        }
    }
    return max(rgb+0.5,vec3f(0));
}
fn slopeBounds(v: f32, z: f32, radius: f32) -> vec2f {
    let h = radius*sqrt(max(0.0,v*v+z*z-radius*radius));
    return (vec2f(v*z)-vec2f(h,-h))/(z*z-radius*radius);
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) tid: vec3u) {
    let id = tid.x;
    if (id >= cam.config.x) { return; }
    keys[id] = vec2u(0xffffffffu,id);
    var out: Projected;
    projected[id] = out;
    let g = gaussians[id];
    let t = (cam.view*vec4f(g.centerOpacity.xyz,1)).xyz;
    let p = project(t);
    let opacity = g.centerOpacity.w;
    if (p.valid == 0u || opacity < ALPHA_FLOOR) { return; }
    let vr = viewRotation(); let q = g.quaternion;
    let ax = vr*rotate(q,vec3f(1,0,0));
    let ay = vr*rotate(q,vec3f(0,1,0));
    let az = vr*rotate(q,vec3f(0,0,1));
    let scales = g.scale.xyz*cam.viewport.w;
    let a = ax*scales.x; let b = ay*scales.y; let c = az*scales.z;
    out.color = vec4f(colorSH(id,g.centerOpacity.xyz),opacity);
    let threshold = max(0.0,2.0*log(opacity/ALPHA_FLOOR));
    if (cam.config.z == 1u) {
        // Seven-point UT (lambda=1); used only for screen coverage.
        var points: array<vec2f,7>;
        points[0] = p.pixel;
        var mu = 0.25*p.pixel;
        var boundary = false;
        let axes = array<vec3f,3>(a,b,c);
        for (var axis=0u; axis<3u; axis++) {
            for (var side=0u; side<2u; side++) {
                let pp = project(t+select(-2.0,2.0,side==1u)*axes[axis]);
                boundary = boundary || pp.valid == 0u;
                var uv = pp.pixel;
                if (cam.lens.x == 3u) { uv.x = p.pixel.x + (uv.x-p.pixel.x)-round((uv.x-p.pixel.x)/cam.viewport.x)*cam.viewport.x; }
                points[1u+axis*2u+side] = uv; mu += 0.125*uv;
            }
        }
        var covariance = vec2f(0);
        for (var i=0u; i<7u; i++) {
            let d = points[i]-mu;
            covariance += select(0.125,0.25,i==0u)*d*d;
        }
        let extent = sqrt(threshold*(4.0*covariance+vec2f(1)))+vec2f(1);
        out.bounds = vec4f(mu-extent,mu+extent);
        // A conservative sphere encloses the finite 3D alpha support. This
        // prevents UT underestimation near the camera from cutting off rays.
        let radius = sqrt(threshold)*max(scales.x,max(scales.y,scales.z));
        if (cam.lens.x == 0u && t.z > radius+1e-5 && !boundary) {
            let bx = slopeBounds(t.x,t.z,radius)*cam.intrinsics.x+vec2f(cam.intrinsics.z);
            let by = slopeBounds(t.y,t.z,radius)*cam.intrinsics.y+vec2f(cam.intrinsics.w);
            out.bounds = vec4f(min(out.bounds.xy,vec2f(bx.x,by.x)-1.0),max(out.bounds.zw,vec2f(bx.y,by.y)+1.0));
        } else if (cam.lens.x == 1u) {
            let e = sqrt(threshold)*vec2f(length(vec3f(a.x,b.x,c.x)),length(vec3f(a.y,b.y,c.y)))*cam.intrinsics.xy+1.0;
            out.bounds = vec4f(p.pixel-e,p.pixel+e);
        } else {
            // Nonlinear lens support and near-plane crossings are conservative
            // full-viewport quads in v1. The per-pixel response is still 3D.
            out.bounds = vec4f(vec2f(-1),cam.viewport.xy+1.0);
        }
        out.row0 = vec4f(ax/scales.x,-dot(ax,t)/scales.x);
        out.row1 = vec4f(ay/scales.y,-dot(ay,t)/scales.y);
        out.row2 = vec4f(az/scales.z,-dot(az,t)/scales.z);
    } else {
        let u = vec3f(dot(p.du,a),dot(p.du,b),dot(p.du,c));
        let v = vec3f(dot(p.dv,a),dot(p.dv,b),dot(p.dv,c));
        let raw = vec3f(dot(u,u),dot(u,v),dot(v,v));
        let mip2d = cam.config.w == 1u || cam.config.w == 3u;
        let kernel = select(0.3,0.1,mip2d);
        let cov = raw+vec3f(kernel,0,kernel);
        let det = cov.x*cov.z-cov.y*cov.y;
        if (!(det > 0.0)) { return; }
        let compensation = select(1.0,sqrt(max(1e-6,raw.x*raw.z-raw.y*raw.y)/max(1e-6,det)),mip2d);
        out.color.w *= compensation;
        if (out.color.w < ALPHA_FLOOR) { return; }
        let th = max(0.0,2.0*log(out.color.w/ALPHA_FLOOR));
        let e = sqrt(th*cov.xz)+1.0;
        out.bounds = vec4f(p.pixel-e,p.pixel+e);
        out.centerConic = vec4f(p.pixel,cov.z/det,-cov.y/det);
        out.extra.x = cov.x/det;
    }
    if (cam.lens.x != 3u && (any(out.bounds.zw < vec2f(0)) || any(out.bounds.xy > cam.viewport.xy))) { return; }
    out.extra.y = 1.0;
    projected[id] = out;
    let depth = select(t.z,length(t),cam.config.z==1u || cam.lens.x==3u);
    // Positive depth IEEE bits are monotonic. Invert for back-to-front draw.
    keys[id] = vec2u(~bitcast<u32>(depth),id);
}
