import { DEFAULT_MAX_SPLATS } from './ply.js';
import { modelBounds, validateModel } from './model.js';
import { decodeSogImage, readSogArchive } from './sog.js';
import { parseSogXtMetadata } from './sog-xt-metadata.js';

const fail=message=>{throw new Error(`SOG-XT: ${message}`);};
const fields=['active_mask','means_bytes_0','means_bytes_1','scales','quaternions','opacities','f_dc'];
const image=p=>p&&Number.isInteger(p.width)&&Number.isInteger(p.height)&&p.width>0&&p.height>0&&p.data instanceof Uint8Array&&p.data.length===p.width*p.height*4;

function metadataInfo(metadata) {
  if(!metadata||typeof metadata!=='object')fail('Invalid metadata');
  const reference=!Object.hasOwn(metadata,'format'),version=metadata.version??0,meta=metadata.meta;
  if(!reference&&(metadata.format!=='SOG-XT'||![1,2].includes(version)))fail('Unsupported version');
  const side=meta?.grid_side,degree=meta?.sh_degree??3;
  if(!Number.isInteger(side)||side<1||side>16383||side*side>64*1024*1024||![0,1,2,3].includes(degree)||meta.image_codec!=='webp'||!Array.isArray(metadata.ops))fail('Invalid dimensions or codec');
  if(meta.antialiased!==undefined&&typeof meta.antialiased!=='boolean')fail('Invalid antialiased flag');
  if(meta.count!==undefined&&(!Number.isSafeInteger(meta.count)||meta.count<1||meta.count>side*side))fail('Invalid Gaussian count');
  if(!reference&&meta.count===undefined)fail('Missing Gaussian count');
  if(degree&&(!Number.isInteger(meta.f_rest_centroids_side)||meta.f_rest_centroids_side<1||meta.f_rest_centroids_side>256))fail('Invalid palette dimensions');
  return {meta,side,degree,reference,version};
}

/** Studio SOG-XT uses RDF coordinates directly, unlike standard SOG's RUB. */
export function decodeSogXtPlanes(metadata,planes,{maxSplats=DEFAULT_MAX_SPLATS,name='SOG-XT model',shLayout='canonical',profile=false}={}) {
  if(!['canonical','packed'].includes(shLayout))fail('Unknown SH layout');
  const start=performance.now(),{meta,side,degree,reference,version}=metadataInfo(metadata);
  const pixels=side*side,rest=(degree+1)**2-1,bases=rest+1;
  const get=field=>{
    const plane=planes[`${field}.webp`];if(!image(plane)||plane.width!==side||plane.height!==side)fail(`Invalid property image: ${field}`);return plane.data;
  };
  const mask=get('active_mask');let count=0;
  for(let p=0;p<pixels;p++)if(mask[p*4])count++;
  if(!count||count>maxSplats||(meta.count!==undefined&&meta.count!==count))fail('Count disagrees with active mask or exceeds limit');
  const quantizer=(field,channels,maximum)=>{
    let config;
    for(const op of metadata.ops){
      if(!Array.isArray(op.input_fields)||op.input_fields.length!==1||op.input_fields[0]!==field)continue;
      for(const transform of op.transforms||[])if(transform.simple_quantize){if(config)fail(`Duplicate quantizer: ${field}`);config=transform.simple_quantize;}
    }
    if(!config)fail(`Missing quantizer: ${field}`);
    const low=Array.isArray(config.min_values)?config.min_values:[config.min_values];
    const high=Array.isArray(config.max_values)?config.max_values:[config.max_values],levels=config.levels??256;
    if(![1,channels].includes(low.length)||high.length!==low.length||!Number.isInteger(levels)||levels<2||levels>65536||(!reference&&levels>maximum)||!low.every(Number.isFinite)||!high.every(Number.isFinite)||low.some((v,i)=>v>high[i]))fail(`Invalid quantizer: ${field}`);
    return {low,high,levels};
  };
  const property=(field,channels,maximum)=>{
    const quant=quantizer(field,channels,maximum),low=get(field==='means'?'means_bytes_0':field),high=field==='means'?get('means_bytes_1'):null;
    let min=65535,max=0;
    const code=(p,c)=>low[p*4+c]+(high?256*high[p*4+c]:0);
    if(reference)for(let p=0;p<pixels;p++)for(let c=0;c<channels;c++){const v=code(p,c);min=Math.min(min,v);max=Math.max(max,v);}
    return (p,c)=>{
      const v=code(p,c),k=quant.low.length===1?0:c;
      if(!reference&&v>=quant.levels)fail(`Code exceeds quantizer range: ${field}`);
      const fraction=reference?(v-min)/Math.max(1,max-min):v/(quant.levels-1);
      // Match the C++ decoder's Float32 tensor boundary before activation.
      return Math.fround(quant.low[k]+(quant.high[k]-quant.low[k])*fraction);
    };
  };
  const means=property('means',3,65536),scales=property('scales',3,256),rotations=property('quaternions',4,100),opacity=property('opacities',1,256),dc=property('f_dc',3,256);
  const packed=shLayout==='packed',data=new Float32Array(count*12),sh=new Float32Array(count*(packed?1:bases)*3);
  let shPalette,labels;
  if(rest){
    const cs=meta.f_rest_centroids_side,centers=planes['f_rest_centroids.webp'];labels=get('f_rest_labels');
    if(!image(centers)||centers.width!==cs*5||centers.height!==cs*3)fail('Invalid centroid image');
    const channelMajor=reference||version>=2,quant=quantizer('f_rest_centroids',channelMajor?45:rest*3,100);
    let min=255,max=0;
    if(reference)for(let p=0;p<centers.width*centers.height;p++)for(let c=0;c<3;c++){const v=centers.data[p*4+c];min=Math.min(min,v);max=Math.max(max,v);}
    const coefficients=new Float32Array(cs*cs*rest*3),indices=new Uint32Array(count),used=new Set();
    let row=0;for(let p=0;p<pixels;p++)if(mask[p*4]){
      const u=labels[p*4],v=labels[p*4+1];if(u>=cs||v>=cs)fail('SH label exceeds palette');
      const entry=v*cs+u;indices[row++]=entry;used.add(entry);
    }
    // Only referenced cells carry model coefficients; padded cells are not
    // constrained by the format, so do not activate or validate their codes.
    for(const entry of used)for(let b=0;b<rest;b++)for(let c=0;c<3;c++){
      const pixel=(Math.floor(b/5)*cs+Math.floor(entry/cs))*(cs*5)+(b%5)*cs+entry%cs;
      const code=centers.data[pixel*4+c],channel=quant.low.length===1?0:(channelMajor?c*15+b:b*3+c);
      if(!reference&&code>=quant.levels)fail('SH code exceeds quantizer range');
      coefficients[(entry*rest+b)*3+c]=quant.low[channel]+(quant.high[channel]-quant.low[channel])*(reference?(code-min)/Math.max(1,max-min):code/(quant.levels-1));
    }
    shPalette={count:cs*cs,labels:indices,coefficients};
  }
  let row=0;
  for(let p=0;p<pixels;p++)if(mask[p*4]){
    const offset=row*12;
    for(let c=0;c<3;c++){
      const value=means(p,c);data[offset+c]=Math.sign(value)*Math.expm1(Math.abs(value));
      data[offset+4+c]=Math.exp(scales(p,c));sh[row*(packed?1:bases)*3+c]=dc(p,c);
    }
    const logit=opacity(p,0);data[offset+3]=logit>=0?1/(1+Math.exp(-logit)):Math.exp(logit)/(1+Math.exp(logit));
    const q=[0,1,2,3].map(c=>rotations(p,c)),length=Math.hypot(...q);
    if(length<1e-6)fail('Invalid quaternion');
    for(let c=0;c<4;c++)data[offset+8+c]=q[c]/length;
    if(rest&&!packed){const label=shPalette.labels[row];sh.set(shPalette.coefficients.subarray(label*rest*3,(label+1)*rest*3),(row*bases+1)*3);}
    row++;
  }
  const model={count,bases,degree,data,...(packed?{shLayout,shDC:sh}:{sh}),renderMethod:'3dgs',filterMode:meta.antialiased?'mip2d':'classic',hasFilter3D:false,sourceFormat:'sog-xt',name};
  if(shPalette)model.shPalette=shPalette;
  const decoded=performance.now();validateModel(model);model.bounds=modelBounds(data);
  if(profile)model.loadStats={numeric_ms:decoded-start,validation_bounds_ms:performance.now()-decoded};
  return model;
}

export async function parseSogXt(buffer,{baseUrl,decodeImage=decodeSogImage,maxBytes=1024*1024*1024,archiveReader,...options}={}) {
  const start=performance.now();
  if(!(buffer instanceof ArrayBuffer)||buffer.byteLength>maxBytes)fail('Invalid input or size limit exceeded');
  let readFile=archiveReader,metadata;
  if(new Uint8Array(buffer)[0]===80){
    readFile??=await readSogArchive(buffer,{maxBytes});
    metadata=parseSogXtMetadata(new TextDecoder().decode(await readFile('container_meta.yaml')));
  }else{
    metadata=parseSogXtMetadata(new TextDecoder().decode(buffer));
    if(!baseUrl)fail('Unbundled metadata requires its source URL');
    let total=buffer.byteLength;
    readFile=async name=>{
      const response=await fetch(new URL(name,baseUrl));if(!response.ok)fail(`HTTP ${response.status}: ${name}`);
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const{done,value}=await reader.read();if(done)break;total+=value.length;if(total>maxBytes)fail('Dataset exceeds size limit');chunks.push(value);size+=value.length;}}
      finally{await reader.cancel().catch(()=>{});}
      const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
    };
  }
  const{degree,meta,side}=metadataInfo(metadata);
  if(meta.count>(options.maxSplats??DEFAULT_MAX_SPLATS))fail('Gaussian count exceeds limit');
  const names=[...fields,...(degree?['f_rest_labels','f_rest_centroids']:[])],planes={};let decodedBytes=0;
  const imagesStart=performance.now();
  for(const field of names){
    const name=`${field}.webp`,plane=await decodeImage(await readFile(name));
    const expectedWidth=field==='f_rest_centroids'?meta.f_rest_centroids_side*5:side;
    const expectedHeight=field==='f_rest_centroids'?meta.f_rest_centroids_side*3:side;
    if(!image(plane)||plane.width!==expectedWidth||plane.height!==expectedHeight)fail(`Invalid property image: ${field}`);
    decodedBytes+=plane.data.byteLength;if(decodedBytes>maxBytes)fail('Decoded images exceed size limit');planes[name]=plane;
    if(field==='active_mask'){
      let count=0;for(let i=0;i<side*side;i++)if(plane.data[i*4])count++;
      if(!count||count>(options.maxSplats??DEFAULT_MAX_SPLATS)||(meta.count!==undefined&&meta.count!==count))fail('Count disagrees with active mask or exceeds limit');
    }
  }
  const imagesEnd=performance.now(),model=decodeSogXtPlanes(metadata,planes,options);
  if(options.profile)Object.assign(model.loadStats,{metadata_ms:imagesStart-start,images_ms:imagesEnd-imagesStart,parse_ms:performance.now()-start,sourceBytes:buffer.byteLength,decodedPlaneBytes:decodedBytes,modelBytes:model.data.byteLength+(model.sh||model.shDC).byteLength+(model.shPalette?model.shPalette.labels.byteLength+model.shPalette.coefficients.byteLength:0)});
  return model;
}
