import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSogPlanes, readSogArchive, parseSog } from '../src/sog.js';
import { validateModel, toCanonicalModel } from '../src/model.js';
import { prepareSHStorage } from '../src/gpu-storage.js';
const image=(w,h,pixels)=>({width:w,height:h,data:new Uint8Array(pixels)});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-5,`${a} != ${b}`);
function fixture(bands=0){
 const book=Array.from({length:256},(_,i)=>i/100);
 const meta={version:2,count:2,means:{mins:[-Math.log(3),0,0],maxs:[Math.log(3),Math.log(2),0],files:['l','h']},scales:{codebook:book.map(v=>-v),files:['s']},quats:{files:['q']},sh0:{codebook:book,files:['dc']}};
 const planes={l:image(2,1,[0,0,0,255,255,255,0,255]),h:image(2,1,[0,0,0,255,255,255,0,255]),s:image(2,1,[0,10,20,255,30,40,50,255]),q:image(2,1,[128,128,128,252,128,128,128,255]),dc:image(2,1,[10,20,30,0,40,50,60,128])};
 if(bands){const rest=[3,8,15][bands-1],data=new Uint8Array(64*rest*2*4);meta.shN={bands,count:65,codebook:book,files:['palette','labels']};for(let b=0;b<rest;b++){data.set([1+b,21+b,41+b,255],b*4);data.set([61+b,81+b,101+b,255],(64*rest+b)*4);}planes.palette=image(64*rest,2,data);planes.labels=image(2,1,[0,0,0,255,64,0,0,255]);}
 return{meta,planes};
}
test('SOG positions, activated scale/alpha, wxyz and RUB-to-RDF coordinates',()=>{const{meta,planes}=fixture();const m=decodeSogPlanes(meta,planes);near(m.data[0],-2);near(m.data[12],2);near(m.data[13],-1);near(m.data[5],Math.exp(-.1));assert.equal(m.data[3],0);near(m.data[15],128/255);near(m.data[8],.99998846);near(m.data[23],-.99998846);near(m.sh[0],.1);assert.equal(m.renderMethod,'3dgs');});
test('SOG all SH degrees and palette row addressing keep interleaved RGB',()=>{for(const degree of [1,2,3]){const{meta,planes}=fixture(degree),m=decodeSogPlanes(meta,planes);assert.equal(m.degree,degree);assert.equal(m.bases,(degree+1)**2);near(m.sh[3],-.01);near(m.sh[4],-.21);near(m.sh[5],-.41);near(m.sh[m.bases*3+3],-.61);near(m.sh[m.bases*3+4],-.81);near(m.sh[m.bases*3+5],-1.01);}});
test('SOG metadata and corrupt images fail explicitly',()=>{const{meta,planes}=fixture(1);for(const change of [m=>m.version=3,m=>m.count=4000001,m=>m.scales.codebook=[],m=>m.quats.files=['../q'],m=>m.model='2dgs']){const m=structuredClone(meta);change(m);assert.throws(()=>decodeSogPlanes(m,planes),/SOG/);}const bad=structuredClone(planes);bad.q.data[3]=0;assert.throws(()=>decodeSogPlanes(meta,bad),/quaternion/);const label=structuredClone(planes);label.labels.data[0]=255;assert.throws(()=>decodeSogPlanes(meta,label),/label/);const m=structuredClone(meta);m.scales.codebook[0]=1000;assert.throws(()=>decodeSogPlanes(m,planes),/Non-finite/);});
test('antialiased SOG selects mip2d without applying 3D filter twice',()=>{const{meta,planes}=fixture();meta.model='antialiased';const m=decodeSogPlanes(meta,planes);assert.equal(m.filterMode,'mip2d');assert.equal(m.hasFilter3D,false);near(m.data[15],128/255);});

test('packed SOG degrees 0–3 never allocate expanded SH and materialize exactly',()=>{
  for(const degree of [0,1,2,3]) {
    const {meta,planes}=fixture(degree),canonical=decodeSogPlanes(meta,planes);
    const Original=globalThis.Float32Array,allocations=[];
    let packed;
    try {
      globalThis.Float32Array=new Proxy(Original,{construct(target,args){allocations.push(args[0]);return Reflect.construct(target,args);}});
      packed=decodeSogPlanes(meta,planes,{shLayout:'packed'});
    } finally { globalThis.Float32Array=Original; }
    validateModel(packed);assert.equal(packed.sh,undefined);assert.equal(packed.shDC.length,meta.count*3);
    assert.deepEqual(allocations,[meta.count*12,meta.count*3,...(degree?[meta.shN.count*(canonical.bases-1)*3]:[])],'Unexpected Float32 model allocation');
    const expanded=toCanonicalModel(packed);
    assert.equal(expanded.shLayout,'canonical');assert.equal(expanded.shDC,undefined);
    assert.deepEqual(expanded.sh,canonical.sh);assert.deepEqual(expanded.data,canonical.data);
    assert.deepEqual(packed.bounds,canonical.bounds);
    assert.equal(toCanonicalModel(canonical),canonical);
    const reference=prepareSHStorage(packed,'float32');assert.deepEqual(reference.data,canonical.sh);
    if(degree) {
      expanded.sh[3]+=1;assert.equal(prepareSHStorage(expanded,'palette').format,'float32');
      assert.notEqual(expanded.sh[3],packed.shPalette.coefficients[0]);
    }
  }
});

test('packed SH validation rejects corrupt buffers, labels, non-finite data and ambiguous layouts',()=>{
  const {meta,planes}=fixture(3),source=decodeSogPlanes(meta,planes,{shLayout:'packed'});
  for(const modify of [m=>m.shDC=new Float32Array(1),m=>m.shDC[0]=Infinity,m=>m.sh=new Float32Array(96),m=>m.shPalette.labels[0]=65,m=>m.shPalette.labels=new Uint16Array(2),m=>m.shPalette.coefficients[0]=NaN,m=>m.shPalette.count=0,m=>delete m.shPalette,m=>m.shLayout='invalid']){
    const m=structuredClone(source);modify(m);assert.throws(()=>validateModel(m));assert.throws(()=>toCanonicalModel(m));
  }
  assert.throws(()=>decodeSogPlanes(meta,planes,{shLayout:'invalid'}),/layout/);
});

test('packed segmented upload matches contiguous bytes and retains editable sources',()=>{
  const {meta,planes}=fixture(3),m=decodeSogPlanes(meta,planes,{shLayout:'packed'});
  for(const modify of [()=>{},()=>{m.shDC[0]=.75;m.shPalette.labels[0]=64;m.shPalette.coefficients[0]=.125;}]) {
    modify();const storage=prepareSHStorage(m),upload=prepareSHStorage(m,'auto',{segmented:true});
    assert.equal(upload.data,undefined);assert.equal(upload.segments[0].data,m.shDC);
    const bytes=new Uint8Array(upload.byteLength);
    for(const {offset,data} of upload.segments)bytes.set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),offset);
    assert.deepEqual(bytes,new Uint8Array(storage.data.buffer));
    const canonical=toCanonicalModel(m),words=new Uint32Array(storage.data.buffer);
    for(let i=0;i<m.count;i++)for(let b=0;b<m.bases;b++)for(let c=0;c<3;c++){
      const k=b===0?i*3+c:m.count*4+(words[m.count*3+i]*(m.bases-1)+b-1)*3+c;
      assert.equal(storage.data[k],canonical.sh[(i*m.bases+b)*3+c]);
    }
  }
});
function zip(files){const parts=[],central=[];let offset=0;for(const[name,raw]of Object.entries(files)){const n=Buffer.from(name),b=Buffer.from(raw);let crc=0xffffffff;for(const byte of b){crc^=byte;for(let k=0;k<8;k++)crc=(crc>>>1)^(0xedb88320&-(crc&1));}crc=(crc^0xffffffff)>>>0;const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt32LE(crc,14);h.writeUInt32LE(b.length,18);h.writeUInt32LE(b.length,22);h.writeUInt16LE(n.length,26);parts.push(h,n,b);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt32LE(crc,16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=h.length+n.length+b.length;}const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);const b=Buffer.concat([...parts,dir,end]);return b.buffer.slice(b.byteOffset,b.byteOffset+b.length);}
test('stored SOG archive resolves metadata and images and checks CRC',async()=>{const{meta,planes}=fixture(3),files={'meta.json':JSON.stringify(meta)};for(const key of Object.keys(planes))files[key]=key;const archive=zip(files);const m=await parseSog(archive,{decodeImage:async b=>planes[new TextDecoder().decode(b)]});assert.equal(m.count,2);assert.equal(m.degree,3);const damaged=archive.slice(0);new Uint8Array(damaged)[30+'meta.json'.length]^=1;const read=await readSogArchive(damaged);await assert.rejects(read('meta.json'),/CRC/);await assert.rejects(readSogArchive(zip({'../bad':'x'})),/Unsafe/);await assert.rejects(readSogArchive(archive,{maxBytes:20}),/limit/);await assert.rejects(readSogArchive(archive.slice(0,-4)),/directory/);});
