import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readColmapCameras } from '../scripts/colmap-cameras.mjs';

const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const doubles=values=>{const b=Buffer.alloc(values.length*8);values.forEach((v,i)=>b.writeDoubleLE(v,i*8));return b;};
const camera=(id,kind,width,height,params)=>Buffer.concat([u32(id),u32(kind),u64(width),u64(height),doubles(params)]);
const image=(id,cameraId,name,points)=>Buffer.concat([u32(id),doubles([1,0,0,0,1,2,3]),u32(cameraId),Buffer.from(name+'\0'),u64(points),Buffer.alloc(points*24)]);
async function fixture(fn){
  const prefix=join(tmpdir(),'photara-colmap-'),directory=await mkdtemp(prefix);
  try{await fn(directory);}finally{assert.ok(directory.startsWith(prefix));await rm(directory,{recursive:true,force:true});}
}
test('COLMAP binary reads panorama and pinhole cameras, skips points and preserves image names',async()=>fixture(async directory=>{
  await writeFile(join(directory,'cameras.bin'),Buffer.concat([u64(3),camera(7,17,7680,3840,[7680,3840]),camera(8,0,640,480,[500,320,240]),camera(9,1,800,600,[600,610,400,300])]));
  await writeFile(join(directory,'images.bin'),Buffer.concat([u64(2),image(2,7,'全景 frame 2.jpg',2),image(1,8,'frame1.jpg',0)]));
  const {cameras,images}=await readColmapCameras(directory);
  assert.deepEqual(cameras.get(7),{model:'EQUIRECTANGULAR',width:7680,height:3840,p:[7680,3840]});
  assert.equal(cameras.get(8).model,'SIMPLE_PINHOLE');assert.equal(cameras.get(9).model,'PINHOLE');
  assert.deepEqual(images.map(i=>i.id),[1,2]);assert.equal(images[1].name,'全景 frame 2.jpg');
  assert.deepEqual(images[1].t,[1,2,3]);assert.deepEqual(images[1].q,[1,0,0,0]);
}));
test('COLMAP TXT accepts an image with no observations without shifting records',async()=>fixture(async directory=>{
  await writeFile(join(directory,'cameras.txt'),'# cameras\n7 SIMPLE_PINHOLE 640 480 500 320 240\n');
  await writeFile(join(directory,'images.txt'),'# images\n1 1 0 0 0 1 2 3 7 frame 1.jpg\n\n2 1 0 0 0 4 5 6 7 frame2.jpg\n1 2 3\n');
  const {images}=await readColmapCameras(directory);
  assert.equal(images.length,2);assert.equal(images[0].name,'frame 1.jpg');assert.deepEqual(images[1].t,[4,5,6]);
}));
test('COLMAP binary rejects truncated observations and missing camera references',async()=>fixture(async directory=>{
  await writeFile(join(directory,'cameras.bin'),Buffer.concat([u64(1),camera(7,17,96,64,[96,64])]));
  await writeFile(join(directory,'images.bin'),Buffer.concat([u64(1),image(1,7,'bad.jpg',2).subarray(0,-1)]));
  await assert.rejects(readColmapCameras(directory),/Truncated COLMAP image observations/);
  await writeFile(join(directory,'images.bin'),Buffer.concat([u64(1),image(1,8,'missing.jpg',0)]));
  await assert.rejects(readColmapCameras(directory),/Missing camera 8/);
}));
