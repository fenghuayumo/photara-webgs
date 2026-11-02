export const SPATIAL_BLOCK_SIZE = 256;

/** Spatial index only: original attributes, SH and stable IDs are never reordered. */
export function buildSpatialBlocks(data) {
  const count=data.length/12,indices=new Uint32Array(count),codes=new Uint32Array(count);
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<count;i++)for(let a=0;a<3;a++){const x=data[i*12+a];min[a]=Math.min(min[a],x);max[a]=Math.max(max[a],x);}
  const spread=n=>{n=(n|(n<<16))&0x030000ff;n=(n|(n<<8))&0x0300f00f;n=(n|(n<<4))&0x030c30c3;n=(n|(n<<2))&0x09249249;return n;};
  for(let i=0;i<count;i++){
    const q=[0,1,2].map(a=>Math.max(0,Math.min(1023,Math.floor((data[i*12+a]-min[a])/Math.max(1e-30,max[a]-min[a])*1023))));
    indices[i]=i;codes[i]=(spread(q[0])|(spread(q[1])<<1)|(spread(q[2])<<2))>>>0;
  }
  // Stable integer radix avoids a multi-million-element JS object sort.
  let source=indices,target=new Uint32Array(count);
  for(let shift=0;shift<32;shift+=8){
    const offsets=new Uint32Array(256);for(let i=0;i<count;i++)offsets[(codes[source[i]]>>>shift)&255]++;
    let total=0;for(let i=0;i<256;i++){const n=offsets[i];offsets[i]=total;total+=n;}
    for(let i=0;i<count;i++){const id=source[i];target[offsets[(codes[id]>>>shift)&255]++]=id;}
    [source,target]=[target,source];
  }
  const blockCount=Math.ceil(count/SPATIAL_BLOCK_SIZE),bounds=new Float32Array(blockCount*8);
  for(let block=0;block<blockCount;block++){
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];let scale=0;
    for(let j=block*256;j<Math.min(count,(block+1)*256);j++){
      const k=source[j]*12;for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],data[k+a]);hi[a]=Math.max(hi[a],data[k+a]);scale=Math.max(scale,data[k+4+a]);}
    }
    for(let a=0;a<3;a++){
      bounds[block*8+a]=(lo[a]+hi[a])/2;
      bounds[block*8+4+a]=(hi[a]-lo[a])/2+Math.max(1e-6,Math.abs(lo[a])*1e-6,Math.abs(hi[a])*1e-6);
    }
    // Covers quaternion normalization tolerance and Float32 rotation error.
    bounds[block*8+3]=scale*1.001;
  }
  return {indices:source,bounds,count:blockCount};
}
