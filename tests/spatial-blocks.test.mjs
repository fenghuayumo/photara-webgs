import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSpatialBlocks} from '../src/spatial-blocks.js';

test('spatial IDs cover each original ID once and blocks enclose centers and scales',()=>{
  for(const n of [1,257,8193]){
    const data=new Float32Array(n*12);
    for(let i=0;i<n;i++)data.set([Math.sin(i)*30,Math.cos(i*11)*5,(i%97)-30,.7,.01+(i%13),.1,.2,0,1,0,0,0],i*12);
    const before=data.slice(),index=buildSpatialBlocks(data);
    assert.deepEqual(data,before);assert.equal(new Set(index.indices).size,n);
    assert.equal(index.count,Math.ceil(n/256));
    for(let i=0;i<n;i++){
      const id=index.indices[i],k=Math.floor(i/256)*8;assert.ok(id<n);
      for(let a=0;a<3;a++)assert.ok(Math.abs(data[id*12+a]-index.bounds[k+a])<=index.bounds[k+4+a]);
      assert.ok(index.bounds[k+3]>=Math.max(...data.subarray(id*12+4,id*12+7)));
    }
  }
});
test('Morton partition groups spatially close centers without changing ID tie order',()=>{
  const data=new Float32Array(1024*12);
  for(let i=0;i<1024;i++)data.set([i%2?100:-100,0,0,.8,.01,.01,.01,0,1,0,0,0],i*12);
  const a=buildSpatialBlocks(data),b=buildSpatialBlocks(data);assert.deepEqual(a,b);
  for(let block=0;block<4;block++)assert.ok(a.bounds[block*8+4]<.001,'Separated clusters share a block');
});
