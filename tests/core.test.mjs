import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePly } from '../src/ply.js';
import { activateGaussian, createDemoModel, validateModel } from '../src/model.js';
import { lookAtCV, cameraPosition, validateCamera, resizeCamera } from '../src/camera.js';
import { OrbitControls } from '../src/controls.js';
import { detectLanguage, t } from '../src/i18n.js';

test('Language follows the primary browser preference with English fallback', () => {
  for (const value of ['zh-CN', 'zh-TW', 'zh-HK', 'zh', 'ZH-hans']) assert.equal(detectLanguage([value]), 'zh-CN');
  for (const value of ['en-US', 'fr-FR', 'ja-JP']) assert.equal(detectLanguage([value, 'zh-CN']), 'en');
  assert.equal(detectLanguage([], 'zh-CN'), 'zh-CN');
  assert.equal(detectLanguage([], ''), 'en');
  assert.equal(t('相机导入失败：{error}', { error: 'Invalid JSON' }, 'en'), 'Camera import failed: Invalid JSON');
  assert.equal(t('全屏查看', {}, 'zh-CN'), '全屏查看');
});

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

test('zoom continues forward past the orbit target and preserves reset',()=>{
  const canvas = new EventTarget(); canvas.style = {};
  let changes = 0;
  const controls = new OrbitControls(canvas, () => changes++);
  controls.fit({ center: [1, -2, 3], radius: 10 });
  controls.zoom(controls.minimum * 1.1 / controls.radius);
  const before = controls.view(), eye = cameraPosition(before);
  const step = controls.radius * (1 - .8);
  controls.zoom(.8);
  const after = cameraPosition(controls.view());
  after.forEach((v, a) => near(v, eye[a] + before[a * 4 + 2] * step));
  near(controls.radius, controls.minimum);
  const target = [...controls.target], atLimit = [...after];
  controls.zoom(.8);
  cameraPosition(controls.view()).forEach((v, a) => near(v, atLimit[a] + before[a * 4 + 2] * controls.minimum * .2));
  assert.ok(controls.target.some((v, a) => v !== target[a]));
  const movedTarget = [...controls.target];
  controls.zoom(1.2);
  assert.deepEqual(controls.target, movedTarget);
  near(controls.radius, controls.minimum * 1.2);
  const count = changes;
  for (const factor of [NaN, Infinity, 0, -1]) controls.zoom(factor);
  assert.equal(changes, count);
  controls.reset();
  assert.deepEqual(controls.target, [1, -2, 3]); near(controls.radius, 27);
  controls.dispose();
});

function controlsFixture() {
  const canvas = new EventTarget(); canvas.style = {};
  const controls = new OrbitControls(canvas, () => {});
  controls.fit({center:[1,-2,3],radius:10});
  return {controls,canvas};
}

test('focus smoothly recenters without changing heading and returns fly to orbit',()=>{
  const {controls:c}=controlsFixture(); c.setMode('fly');
  const yaw=c.yaw,pitch=c.pitch,eye=cameraPosition(c.view()),target=[2,1,4];
  const initial=[...c.target],radius=Math.hypot(...target.map((v,a)=>v-eye[a]));
  c.focus(target); assert.equal(c.mode,'orbit'); assert.deepEqual(c.target,initial);
  assert.equal(c.update(0),true); assert.equal(c.update(125),true);
  assert.ok(c.target.every((v,a)=>v>initial[a]&&v<target[a]));
  assert.equal(c.update(250),false); assert.deepEqual(c.target,target); near(c.radius,radius);
  assert.equal(c.yaw,yaw);assert.equal(c.pitch,pitch);
  const view=c.view();
  [0,1].forEach(a=>near(view[a]*target[0]+view[a+4]*target[1]+view[a+8]*target[2]+view[a+12],0));
  c.reset();assert.deepEqual(c.target,initial);c.dispose();
});

test('orbit/fly switching preserves pose; fly rotation keeps the eye fixed',()=>{
  const {controls:c}=controlsFixture(),pose=c.view();
  c.setMode('fly');assert.deepEqual(c.view(),pose);
  const eye=cameraPosition(pose);c.orbit(.2,.1);
  cameraPosition(c.view()).forEach((v,a)=>near(v,eye[a],1e-5));
  const looked=c.view();c.setMode('orbit');assert.deepEqual(c.view(),looked);
  c.orbit(.1,0);assert.ok(Math.hypot(...cameraPosition(c.view()).map((v,a)=>v-eye[a]))>1);
  assert.throws(()=>c.setMode('unknown'),/mode/);c.dispose();
});

test('fly movement is time based, normalizes diagonals and stops on blur or disable',()=>{
  const travel=(frames,diagonal=false)=>{
    const {controls:c,canvas}=controlsFixture();c.setMode('fly');
    const initial=[...c.target];c.keys.add('KeyW');if(diagonal)c.keys.add('KeyD');
    c.update(0);for(let i=1;i<=frames;i++)c.update(i*1000/frames);
    const distance=Math.hypot(...c.target.map((v,a)=>v-initial[a]));
    canvas.dispatchEvent(new Event('blur'));assert.equal(c.keys.size,0);assert.equal(c.update(2000),false);
    const stopped=[...c.target];c.keys.add('KeyW');c.enabled=false;c.update(3000);
    assert.deepEqual(c.target,stopped);assert.equal(c.keys.size,0);c.dispose();return distance;
  };
  near(travel(60),1.25,1e-5);near(travel(120),1.25,1e-5);near(travel(60,true),1.25,1e-5);
});

test('keyboard V toggles mode and movement keys enter fly; fly zoom preserves orbit distance',()=>{
  const {controls:c,canvas}=controlsFixture();
  const press=(code,key)=>canvas.dispatchEvent(Object.assign(new Event('keydown',{cancelable:true}),{code,key}));
  press('KeyV','v');assert.equal(c.mode,'fly');press('KeyV','v');assert.equal(c.mode,'orbit');
  press('KeyW','w');assert.equal(c.mode,'fly');assert.ok(c.keys.has('KeyW'));
  const radius=c.radius,target=[...c.target];c.zoom(.5);assert.equal(c.radius,radius);
  assert.ok(c.target.some((v,a)=>v!==target[a]));
  c.focus([0,0,0]);c.orbit(.1,0);assert.equal(c.transition,null);
  c.dispose();
});
