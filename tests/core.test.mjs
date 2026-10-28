import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePly } from '../src/ply.js';
import { activateGaussian, createDemoModel, validateModel } from '../src/model.js';
import { lookAtCV, cameraPosition, validateCamera, resizeCamera } from '../src/camera.js';

const names = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
const values = [1,-2,3,.1,.2,.3,0,Math.log(.2),Math.log(.3),Math.log(.4),2,0,0,0];
function ply({ binary = false, little = true, extra = [], extraValues = [], comments = '', newline = '\n' } = {}) {
  const header = ['ply',`format ${binary ? little ? 'binary_little_endian' : 'binary_big_endian' : 'ascii'} 1.0`,comments,'element vertex 1',...names.concat(extra).map(n => `property float ${n}`),'end_header',''].join(newline);
  const h = new TextEncoder().encode(header), row = values.concat(extraValues);
  if (!binary) return new TextEncoder().encode(header + row.join(' ') + '\n').buffer;
  const result = new Uint8Array(h.length + row.length * 4); result.set(h);
  const view = new DataView(result.buffer);
  row.forEach((v,i) => view.setFloat32(h.length + i * 4, v, little));
  return result.buffer;
}
const near = (a,b,tol=1e-6) => assert.ok(Math.abs(a-b)<tol, `${a} ≠ ${b}`);

test('ASCII PLY preserves coordinates and activates parameters', () => {
  const m = parsePly(ply());
  assert.equal(m.renderMethod, '3dgs'); assert.equal(m.filterMode, 'classic');
  assert.deepEqual(Array.from(m.data.slice(0,3)), [1,-2,3]);
  near(m.data[3],.5); near(m.data[4],.2); near(m.data[8],1);
  assert.equal(m.bases,1); validateModel(m);
});
test('binary little and big endian, CRLF, agree with ASCII', () => {
  const reference = parsePly(ply());
  for (const little of [true,false]) {
    const m = parsePly(ply({ binary:true, little, newline:'\r\n' }));
    Array.from(m.data).forEach((v,i)=>near(v,reference.data[i]));
  }
});
test('PLY SH channels are transposed to interleaved INRIA order', () => {
  const m = parsePly(ply({ extra:Array.from({length:9},(_,i)=>`f_rest_${i}`), extraValues:[10,11,12,20,21,22,30,31,32] }));
  assert.equal(m.degree,1);
  assert.deepEqual(Array.from(m.sh.slice(3)),[10,20,30,11,21,31,12,22,32]);
});
test('metadata and 3D filtering preserve density and run once', () => {
  const m = parsePly(ply({ comments:'comment photara_render_method 3dgut\ncomment photara_filter_mode mip', extra:['filter_3D'], extraValues:[.1] }));
  assert.equal(m.renderMethod,'3dgut'); assert.equal(m.filterMode,'mip'); assert.equal(m.hasFilter3D,true);
  const scales=[.2,.3,.4]; const filtered=scales.map(s=>Math.hypot(s,.1));
  filtered.forEach((s,i)=>near(m.data[4+i],s));
  near(m.data[3],.5*scales.reduce((f,s,i)=>f*s/filtered[i],1));
  // Renderer receives the activated result, not a second filter_3D field.
  assert.equal(m.data.length,12);
});
test('provided filter_3D is applied even for classic metadata (C++ upload behavior)',()=>{
  const m=parsePly(ply({extra:['filter_3D'],extraValues:[.2]})); near(m.data[4],Math.hypot(.2,.2));
});
test('malformed/unsupported PLY fails explicitly',()=>{
  const truncated=ply({binary:true}).slice(0,-4);
  assert.throws(()=>parsePly(truncated),/Truncated/);
  assert.throws(()=>parsePly(ply(),{maxSplats:0}),/count/);
  assert.throws(()=>parsePly(ply({comments:'comment photara_render_method unknown'})),/render method/);
  assert.throws(()=>parsePly(ply({comments:'comment photara_filter_mode unknown'})),/filter mode/);
  assert.throws(()=>parsePly(ply({extra:['f_rest_0'],extraValues:[1]})),/SH/);
  assert.throws(()=>parsePly(ply({extra:['filter_3D'],extraValues:[-.2]})),/nonnegative/);
  const missing=new TextDecoder().decode(ply()).replace('property float opacity','property float something_else');
  assert.throws(()=>parsePly(new TextEncoder().encode(missing).buffer),/opacity/);
});
test('activation is stable at extreme logits and clamps log scale',()=>{
  const a=activateGaussian([-100,100,0],1000,[2,0,0,0]);
  assert.equal(a.opacity,1); near(a.scales[0],Math.exp(-20)); near(a.scales[1],Math.exp(20),1e-3);
  assert.equal(activateGaussian([0,0,0],-1000,[1,0,0,0]).opacity,0);
  assert.throws(()=>activateGaussian([0,0,0],0,[0,0,0,0]),/quaternion/);
});
test('lookAtCV gives +Z forward and eye is recovered from nontrivial extrinsics',()=>{
  const eye=[2,-3,-4],target=[.2,.6,1]; const v=lookAtCV(eye,target);
  cameraPosition(v).forEach((x,i)=>near(x,eye[i]));
  const transform=p=>[0,1,2].map(a=>v[a]*p[0]+v[4+a]*p[1]+v[8+a]*p[2]+v[12+a]);
  transform(eye).forEach(x=>near(x,0)); const p=transform(target); near(p[0],0);near(p[1],0);assert.ok(p[2]>0);
});
test('calibrated camera validation and resolution preserve principal point',()=>{
  const c={worldToCamera:lookAtCV([0,0,0],[0,0,1]),width:100,height:80,fx:92,fy:85,cx:43,cy:34};
  validateCamera(c); const r=resizeCamera(c,200,120); assert.equal(r.cx,86);assert.equal(r.cy,51); assert.equal(r.fy,127.5);
  assert.throws(()=>validateCamera({...c,position:[1,0,0]}),/position/);
  assert.throws(()=>validateCamera({...c,model:'equirectangular'}),/Panorama/);
  const bad=new Float32Array(c.worldToCamera);bad[0]=2;assert.throws(()=>validateCamera({...c,worldToCamera:bad}),/orthonormal/);
});
test('synthetic demo is deterministic and valid',()=>{
  const a=createDemoModel(),b=createDemoModel(); validateModel(a);assert.deepEqual(a.data,b.data);assert.equal(a.count,1764);
});
