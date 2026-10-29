"""Compare native panorama renders with their registered source photographs.

This measures image fit on the dataset's valid static pixels, not rasterizer
correctness or held-out quality. Do not apply a perspective photo to an
orthographic render or compare masked-out moving people with cleaned geometry.
"""
import argparse
import json
import math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

p=argparse.ArgumentParser()
p.add_argument('--web',required=True);p.add_argument('--cpp',required=True)
p.add_argument('--images',required=True);p.add_argument('--masks',required=True)
p.add_argument('--output',required=True)
args=p.parse_args()
web,cpp,images,masks,out=map(Path,(args.web,args.cpp,args.images,args.masks,args.output))
out.mkdir(parents=True,exist_ok=True)
manifest=json.loads((web/'manifest.json').read_text())
results=[]
for view in manifest['views']:
    if view['model']!='equirectangular' or view.get('sourceCameraModel')!='EQUIRECTANGULAR':continue
    photo=np.asarray(Image.open(images/view['sourceImage']).convert('RGB'),dtype=np.float32)
    mask=np.asarray(Image.open(masks/Path(view['sourceImage']).with_suffix('.png')).convert('L'))
    sh,sw=photo.shape[:2];w,h=view['width'],view['height']
    if mask.shape!=(sh,sw):raise ValueError('Source image/mask dimensions differ')
    # Native Photara evaluates integer pixels. Sample the original integer
    # grid explicitly instead of introducing a resize half-pixel shift.
    x=np.arange(w,dtype=np.float32)*sw/w;y=np.arange(h,dtype=np.float32)*sh/h
    x0=np.floor(x).astype(int);y0=np.floor(y).astype(int)
    x1=(x0+1)%sw;y1=np.minimum(y0+1,sh-1)
    wx=(x-x0)[None,:,None];wy=(y-y0)[:,None,None]
    source=(photo[y0[:,None],x0]*(1-wx)+photo[y0[:,None],x1]*wx)*(1-wy)+(photo[y1[:,None],x0]*(1-wx)+photo[y1[:,None],x1]*wx)*wy
    valid=(mask[y0[:,None],x0]==255)&(mask[y0[:,None],x1]==255)&(mask[y1[:,None],x0]==255)&(mask[y1[:,None],x1]==255)
    # One target-pixel margin around semantic-mask boundaries.
    padded=np.pad(valid,((1,1),(0,0)),mode='edge')
    valid=valid & padded[:-2] & padded[2:] & np.roll(valid,1,axis=1) & np.roll(valid,-1,axis=1)
    if not valid.any():raise ValueError('No valid static pixels')
    Image.fromarray(np.rint(source).clip(0,255).astype('uint8')).save(out/f"source-{view['name']}.png")
    Image.fromarray((valid*255).astype('uint8')).save(out/f"mask-{view['name']}.png")
    for method in manifest['methods']:
        name=f"{method}-{view['name']}";row={'name':name,'source_image':view['sourceImage'],'valid_percent':float(valid.mean()*100)}
        panels=[('Source photograph (metric uses dataset mask)',source)]
        for backend,directory in [('web',web),('cpp',cpp)]:
            rgb=np.asarray(Image.open(directory/f'{name}.ppm'),dtype=np.float32)
            error=rgb[valid]-source[valid];mse=float(np.mean(error.astype(np.float64)**2))
            psnr=20*math.log10(255/math.sqrt(mse)) if mse else None
            row[f'{backend}_psnr_db']=psnr;row[f'{backend}_mae']=float(np.abs(error).mean())
            panels.append((f'{backend.upper()} | static RGB PSNR {psnr:.2f} dB',rgb))
        sheet=Image.new('RGB',(w*3,h+44),(20,26,34));draw=ImageDraw.Draw(sheet)
        for i,(label,pixels) in enumerate(panels):
            draw.text((i*w+12,12),label,fill='white');sheet.paste(Image.fromarray(np.rint(pixels).clip(0,255).astype('uint8')),(i*w,44))
        sheet.save(out/f'source-fit-{name}.png');results.append(row)
        print(f"{name}: web {row['web_psnr_db']:.2f} / cpp {row['cpp_psnr_db']:.2f} dB, static mask {row['valid_percent']:.1f}%")
(out/'source-fit.json').write_text(json.dumps({'note':'Registered source-view RGB fit on the provided dataset mask; not held-out evaluation or proof of numerical rasterizer correctness. Masks visibly miss some hands/fingers; residual occlusions affect the scores. Integer source sampling, one-pixel mask margin.','measurements':results},indent=2),encoding='utf-8')
