import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSogXtPlanes } from '../src/sog-xt.js';
import { parseSogXtMetadata } from '../src/sog-xt-metadata.js';
import { toCanonicalModel } from '../src/model.js';
import { isSog } from '../src/sog.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<2e-6,`${a} != ${b}`);
const plane=(w,h)=>({width:w,height:h,data:new Uint8Array(w*h*4)});
function fixture(degree=3,version=2){
  const meta={format:'SOG-XT',version,meta:{count:2,grid_side:2,sh_degree:degree,image_codec:'webp',antialiased:true,f_rest_centroids_side:2},ops:[]},planes={};
  const add=(field,min,max,levels)=>meta.ops.push({input_fields:[field],transforms:[{simple_quantize:{min_values:min,max_values:max,levels}}]});
  for(const f of ['active_mask','means_bytes_0','means_bytes_1','scales','quaternions','opacities','f_dc','f_rest_labels'])planes[f+'.webp']=plane(2,2);
  for(const p of [0,3]){
    planes['active_mask.webp'].data[p*4]=255;
    planes['means_bytes_0.webp'].data.set([255,255,255,255],p*4);planes['means_bytes_1.webp'].data.set([255,255,255,255],p*4);
    planes['scales.webp'].data.set([0,128,255,255],p*4);
    planes['quaternions.webp'].data.set([99,50,50,50],p*4);
    planes['opacities.webp'].data[p*4]=p?255:0;
    planes['f_dc.webp'].data.set([0,128,255,255],p*4);
    planes['f_rest_labels.webp'].data.set([1,1,0,255],p*4);
  }
  add('means',0,Math.log(3),65536);add('scales',[-3,-2,-1],[-2,-1,0],256);
  add('quaternions',-1,1,100);add('opacities',-2,2,256);add('f_dc',-.5,.5,256);
  if(degree){
    const dims=version===1?((degree+1)**2-1)*3:45;
    add('f_rest_centroids',Array.from({length:dims},(_,i)=>i*.1),Array.from({length:dims},(_,i)=>i*.1+1),100);
    const p=planes['f_rest_centroids.webp']=plane(10,6);
    for(let b=0;b<(degree+1)**2-1;b++){const pixel=(Math.floor(b/5)*2+1)*10+(b%5)*2+1;p.data.set([0,50,99,255],pixel*4);}
  }
  return {meta,planes};
}
test('SOG-XT active masks, quantizers, RDF coordinates and activation',()=>{
  const {meta,planes}=fixture(0),m=decodeSogXtPlanes(meta,planes);
  assert.equal(m.count,2);assert.equal(m.sourceFormat,'sog-xt');assert.equal(m.filterMode,'mip2d');
  near(m.data[0],2);near(m.data[1],2);near(m.data[2],2);
  near(m.data[3],1/(1+Math.exp(2)));near(m.data[15],1/(1+Math.exp(-2)));
  near(m.data[4],Math.exp(-3));near(m.data[6],1);assert.ok(m.data[9]>0&&m.data[10]>0&&m.data[11]>0);
  near(Math.hypot(...m.data.slice(8,12)),1);near(m.sh[0],-.5);near(m.sh[2],.5);
});
test('SOG-XT v1/v2 SH tiling, channel order and packed parity for degrees 0–3',()=>{
  for(const degree of [0,1,2,3])for(const version of [1,2]){
    const{meta,planes}=fixture(degree,version),a=decodeSogXtPlanes(meta,planes),packed=decodeSogXtPlanes(meta,planes,{shLayout:'packed'});
    assert.deepEqual(toCanonicalModel(packed).sh,a.sh);assert.deepEqual(packed.data,a.data);assert.equal(packed.sh,undefined);
    if(degree){
      assert.equal(packed.shPalette.labels[0],3);
      for(let b=0;b<a.bases-1;b++)for(let c=0;c<3;c++)near(a.sh[(b+1)*3+c],(version===2?c*15+b:b*3+c)*.1+[0,50/99,1][c]);
    }
  }
});
test('SOG-XT rejects inconsistent masks, dimensions, codes, labels and metadata',()=>{
  for(const modify of [m=>m.version=3,m=>m.meta.count=3,m=>m.meta.grid_side=0,m=>m.meta.image_codec='jpeg',m=>m.ops[0].transforms[0].simple_quantize.levels=1,m=>m.ops[1].transforms[0].simple_quantize.min_values=[0,1],m=>m.ops[0].transforms[0].simple_quantize.max_values=-1]){
    const{meta,planes}=fixture();modify(meta);assert.throws(()=>decodeSogXtPlanes(meta,planes),/SOG-XT/);
  }
  for(const modify of [p=>p['means_bytes_1.webp'].width=1,p=>p['quaternions.webp'].data[0]=100,p=>p['f_rest_labels.webp'].data[0]=2,p=>p['f_rest_centroids.webp'].data.fill(255),p=>p['active_mask.webp'].data.fill(0)]){
    const{meta,planes}=fixture();modify(planes);assert.throws(()=>decodeSogXtPlanes(meta,planes),/SOG-XT/);
  }
  const{meta,planes}=fixture();assert.throws(()=>decodeSogXtPlanes(meta,planes,{maxSplats:1}),/limit/);
});
test('SOG-XT YAML block/flow data, bounds and content identification',()=>{
  const yaml=`---\nmeta:\n  grid_side: 2\n  image_codec: webp\n  antialiased: true\nops:\n- input_fields: [means]\n  transforms:\n  - simple_quantize:\n      min_values: -1.0\n      max_values: [1, 2, 3] # ranges\n`;
  const parsed=parseSogXtMetadata(yaml);assert.equal(parsed.meta.grid_side,2);assert.equal(parsed.meta.antialiased,true);
  assert.deepEqual(parsed.ops[0].input_fields,['means']);assert.deepEqual(parsed.ops[0].transforms[0].simple_quantize.max_values,[1,2,3]);
  assert.equal(parseSogXtMetadata('{meta: {grid_side: 2}, ops: []}').meta.grid_side,2);
  for(const text of ['a: &anchor 1','a: *anchor','a: !!js/function x','__proto__: 1','a: 1\na: 2','a:\n    b: 1\n  c: 2','{invalid}'])assert.throws(()=>parseSogXtMetadata(text),/metadata/);
  assert.throws(()=>parseSogXtMetadata('{"a":'.repeat(34)+'0'+'}'.repeat(34)),/limit/);
  assert.equal(isSog(new TextEncoder().encode(yaml).buffer),true);
});
