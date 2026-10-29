struct Camera {
    view: mat4x4f,
    eye: vec4f,
    intrinsics: vec4f,
    viewport: vec4f, // width, height, near clip, scale modifier
    config: vec4u,     // count, bases, render method (0 GS / 1 GUT), filter (0..3)
    lens: vec4u,     // camera model, SH degree, reserved
    distortion: vec4f,
};
struct Gaussian { centerOpacity: vec4f, scale: vec4f, quaternion: vec4f };
struct Projected {
    bounds: vec4f,
    centerConic: vec4f, // center.xy, inverse covariance xx, xy
    color: vec4f,
    row0: vec4f, row1: vec4f, row2: vec4f,
    extra: vec4f, // inverse covariance yy, validity
};
@group(0) @binding(0) var<uniform> cam: Camera;
const PI = 3.141592653589793;
const ALPHA_FLOOR = 1.0 / 255.0;

fn rotate(q: vec4f, v: vec3f) -> vec3f {
    return v + 2.0 * cross(q.yzw, cross(q.yzw, v) + q.x * v);
}
fn viewRotation() -> mat3x3f { return mat3x3f(cam.view[0].xyz, cam.view[1].xyz, cam.view[2].xyz); }
struct Projection { pixel: vec2f, du: vec3f, dv: vec3f, valid: u32 };
fn project(t: vec3f) -> Projection {
    var p: Projection;
    let fx = cam.intrinsics.x; let fy = cam.intrinsics.y;
    let c = cam.intrinsics.zw;
    let mode = cam.lens.x;
    if (mode == 3u) {
        let h = length(t.xz); let l2 = dot(t,t);
        if (h < 1e-5 || l2 < 1e-12) { return p; }
        p.pixel = vec2f(atan2(t.x,t.z), atan2(t.y,h)) * cam.intrinsics.xy + c;
        p.du = fx * vec3f(t.z,0,-t.x)/(h*h);
        p.dv = fy * vec3f(-t.y*t.x/h,h,-t.y*t.z/h)/l2;
    } else if (mode == 2u) {
        if (t.z <= 1e-6) { return p; }
        let r2 = dot(t.xy,t.xy); let r = sqrt(r2);
        let theta = atan2(r,t.z); let q = theta*theta;
        let k = cam.distortion;
        let td = theta*(1.0+q*(k.x+q*(k.y+q*(k.z+q*k.w))));
        let dt = 1.0+q*(3.0*k.x+q*(5.0*k.y+q*(7.0*k.z+9.0*q*k.w)));
        if (theta >= PI*0.5 || td < 0 || dt <= 1e-6) { return p; }
        if (r2 < 1e-6*t.z*t.z) {
            let iz = 1.0/t.z; let qq = r2*iz*iz;
            let a = k.x-1.0/3.0; let b = k.y-k.x+0.2;
            let s = iz*(1.0+a*qq+b*qq*qq);
            let ds = 2.0*iz*iz*iz*(a+2.0*b*qq);
            let dz = -iz*iz*(1.0+3.0*a*qq+5.0*b*qq*qq);
            p.pixel = c + cam.intrinsics.xy*t.xy*s;
            p.du = fx*vec3f(s+t.x*t.x*ds,t.x*t.y*ds,t.x*dz);
            p.dv = fy*vec3f(t.x*t.y*ds,s+t.y*t.y*ds,t.y*dz);
        } else {
            let rho = td/r; let l2 = dot(t,t);
            let dtheta = vec3f(t.z*t.x/(l2*r),t.z*t.y/(l2*r),-r/l2);
            let drho = dt*dtheta/r - vec3f(t.xy,0)*td/(r*r*r);
            p.pixel = c + cam.intrinsics.xy*rho*t.xy;
            p.du = fx*(vec3f(rho,0,0)+t.x*drho);
            p.dv = fy*(vec3f(0,rho,0)+t.y*drho);
        }
    } else {
        if (t.z <= cam.viewport.z) { return p; }
        if (mode == 1u) {
            p.pixel = t.xy*cam.intrinsics.xy+c;
            p.du = vec3f(fx,0,0); p.dv = vec3f(0,fy,0);
        } else {
            let iz = 1.0/t.z;
            p.pixel = t.xy*iz*cam.intrinsics.xy+c;
            let lim = 1.3*cam.viewport.xy/(2.0*cam.intrinsics.xy);
            let xy = clamp(t.xy*iz,-lim,lim)*t.z;
            p.du = vec3f(fx*iz,0,-fx*xy.x*iz*iz);
            p.dv = vec3f(0,fy*iz,-fy*xy.y*iz*iz);
        }
    }
    p.valid = 1u;
    return p;
}
fn pixelRay(pixel: vec2f) -> vec3f {
    let uv = (pixel-cam.intrinsics.zw)/cam.intrinsics.xy;
    if (cam.lens.x == 1u) { return vec3f(0,0,1); }
    if (cam.lens.x == 3u) { return vec3f(cos(uv.y)*sin(uv.x),sin(uv.y),cos(uv.y)*cos(uv.x)); }
    if (cam.lens.x != 2u) { return normalize(vec3f(uv,1)); }
    let r = length(uv); let k = cam.distortion;
    var lo = 0.0; var hi = PI*0.5;
    let h2 = hi*hi;
    let limit = hi*(1.0+h2*(k.x+h2*(k.y+h2*(k.z+h2*k.w))));
    // Native Photara supports the monotonic front hemisphere. Out-of-lens
    // pixels have no ray instead of all collapsing onto the horizon.
    if (!(r < limit)) { return vec3f(0); }
    for (var i = 0u; i < 28u; i++) {
        let m = (lo+hi)*0.5; let q = m*m;
        let td = m*(1.0+q*(k.x+q*(k.y+q*(k.z+q*k.w))));
        if (td < r) { lo = m; } else { hi = m; }
    }
    let theta = (lo+hi)*0.5;
    let t2 = theta*theta;
    let derivative = 1.0+t2*(3.0*k.x+t2*(5.0*k.y+t2*(7.0*k.z+9.0*t2*k.w)));
    if (!(derivative > 1e-6)) { return vec3f(0); }
    let s = select(1.0,sin(theta)/max(r,1e-8),r>1e-8);
    return vec3f(uv*s,max(0.0,cos(theta)));
}
