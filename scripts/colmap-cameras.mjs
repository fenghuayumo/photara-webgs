import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Camera-only COLMAP reader for the comparison fixture. Skip observations;
// never materialize the sparse cloud or millions of POINTS2D tuples.
export async function readColmapCameras(directory) {
  const cameras=new Map();
  const textCameras=resolve(directory,'cameras.txt');
  if(existsSync(textCameras)) {
    for(const line of (await readFile(textCameras,'utf8')).split(/\r?\n/)) {
      if(!line.trim()||line.startsWith('#'))continue;
      const [id,model,w,h,...p]=line.trim().split(/\s+/);
      cameras.set(Number(id),{model,width:Number(w),height:Number(h),p:p.map(Number)});
    }
  } else {
    const bytes=await readFile(resolve(directory,'cameras.bin'));let offset=0;
    const u64=()=>{const value=Number(bytes.readBigUInt64LE(offset));offset+=8;if(!Number.isSafeInteger(value))throw new Error('COLMAP integer exceeds safe range');return value;};
    const count=u64();
    const models=new Map([[0,['SIMPLE_PINHOLE',3]],[1,['PINHOLE',4]],[17,['EQUIRECTANGULAR',2]]]);
    for(let i=0;i<count;i++) {
      const id=bytes.readUInt32LE(offset),kind=bytes.readInt32LE(offset+4);offset+=8;
      const width=u64(),height=u64(),description=models.get(kind);
      if(!description)throw new Error(`Unsupported COLMAP binary camera model ${kind}`);
      const [model,n]=description,p=[];
      for(let j=0;j<n;j++){p.push(bytes.readDoubleLE(offset));offset+=8;}
      cameras.set(id,{model,width,height,p});
    }
  }
  const textImages=resolve(directory,'images.txt');let images=[];
  if(existsSync(textImages)) {
    const lines=(await readFile(textImages,'utf8')).trimEnd().split(/\r?\n/).filter(l=>!l.startsWith('#'));
    images=lines.filter((_,i)=>i%2===0).filter(l=>l.trim()).map(l=>{
      const row=l.trim().split(/\s+/);
      return {id:Number(row[0]),q:row.slice(1,5).map(Number),t:row.slice(5,8).map(Number),cameraId:Number(row[8]),name:row.slice(9).join(' ')};
    });
  } else {
    const bytes=await readFile(resolve(directory,'images.bin'));let offset=0;
    const u64=()=>{const value=Number(bytes.readBigUInt64LE(offset));offset+=8;if(!Number.isSafeInteger(value))throw new Error('COLMAP integer exceeds safe range');return value;};
    const count=u64();
    for(let i=0;i<count;i++) {
      const id=bytes.readUInt32LE(offset);offset+=4;
      const pose=[];for(let j=0;j<7;j++){pose.push(bytes.readDoubleLE(offset));offset+=8;}
      const cameraId=bytes.readUInt32LE(offset);offset+=4;
      const end=bytes.indexOf(0,offset);if(end<0)throw new Error('Truncated COLMAP image name');
      const name=bytes.toString('utf8',offset,end);offset=end+1;
      const points=u64();offset+=points*24;
      if(!Number.isSafeInteger(offset)||offset>bytes.length)throw new Error('Truncated COLMAP image observations');
      images.push({id,q:pose.slice(0,4),t:pose.slice(4),cameraId,name});
    }
  }
  if(!cameras.size||!images.length)throw new Error('Empty COLMAP camera model');
  for(const image of images)if(!cameras.has(image.cameraId))throw new Error(`Missing camera ${image.cameraId}`);
  images.sort((a,b)=>a.id-b.id);
  return {cameras,images};
}
