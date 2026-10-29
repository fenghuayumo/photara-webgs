"""Create per-image RGB metrics, PNGs and a self-contained local comparison index."""
import argparse
import html
import json
import math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument('--web', default='test-results/real-scene')
parser.add_argument('--cpp', default='test-results/cpp-reference')
parser.add_argument('--output', default='test-results/comparison')
parser.add_argument('--reference-revision', default='unspecified')
parser.add_argument('--panorama-probe', help='JSON output of cpp-reference --panorama-probe')
parser.add_argument('--previous', help='Earlier metrics.json for before/after image metrics')
args = parser.parse_args()
web, cpp, output = map(Path, (args.web, args.cpp, args.output))
output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((web/'manifest.json').read_text())
wt = json.loads((web/'timings.json').read_text())
web_times = {v['name']: v for v in wt['measurements']}
cpp_times = {v['name']: v for v in json.loads((cpp/'timings.json').read_text())}
previous = {v['name']: v for v in json.loads(Path(args.previous).read_text())['measurements']} if args.previous else {}
probe = json.loads(Path(args.panorama_probe).read_text(encoding='utf-8-sig')) if args.panorama_probe else None
probe_message = '本轮未提供全景去重最小复现结果。'
source_fit_path=output/'source-fit.json'
source_fit=json.loads(source_fit_path.read_text()) if source_fit_path.exists() else None
source_scores={v['name']:v for v in source_fit['measurements']} if source_fit else {}
if probe:
    passed = probe['studio_rgb'] == probe['single_contribution_expected_rgb']
    probe_message = f"本轮 C++ 全景去重最小复现{'通过' if passed else '未通过'}：实际 {probe['studio_rgb']}，单次贡献预期 {probe['single_contribution_expected_rgb']}。"
measurements, cards = [], []
for method in manifest['methods']:
    for view in manifest['views']:
        name = f"{method}-{view['name']}"
        a = np.asarray(Image.open(web/f'{name}.ppm')).astype(np.float64)
        b = np.asarray(Image.open(cpp/f'{name}.ppm')).astype(np.float64)
        error = np.abs(a-b)
        rmse = float(np.sqrt(np.mean((a-b)**2)))
        mae = float(error.mean())
        psnr = 20*math.log10(255/rmse) if rmse else None
        measurement = dict(name=name, source_image=view['sourceImage'], width=view['width'], height=view['height'],
                           mae=mae, rmse=rmse, psnr_db=psnr, max_error=int(error.max()),
                           pixels_over_8_percent=float(np.mean(np.max(error,axis=2)>8)*100),
                           web_ms=web_times[name]['median_ms'], cpp_ms=cpp_times[name]['median_ms'],
                           web_gpu_ms=web_times[name].get('gpu_median_ms'))
        measurements.append(measurement)
        if name in previous:
            measurement['previous_psnr_db'] = previous[name]['psnr_db']
            measurement['previous_mae'] = previous[name]['mae']
        Image.fromarray(a.astype('uint8')).save(output/f'{name}-web.png')
        Image.fromarray(b.astype('uint8')).save(output/f'{name}-cpp.png')
        diff = Image.fromarray(np.minimum(error*8,255).astype('uint8'))
        diff.save(output/f'{name}-diff.png')
        w,h=view['width'],view['height']
        sheet=Image.new('RGB',(w*3,h+44),(20,26,34))
        draw=ImageDraw.Draw(sheet)
        for i,(label,pixels) in enumerate([('WebGPU',a),('C++ Studio / Vulkan',b),('Absolute difference x8',np.minimum(error*8,255))]):
            draw.text((i*w+12,12),label,fill='white')
            sheet.paste(Image.fromarray(pixels.astype('uint8')),(i*w,44))
        sheet.save(output/f'{name}.png')
        psnr_text = f'{psnr:.2f}' if psnr is not None else '∞'
        quality = f"PSNR {psnr_text} dB · MAE {mae:.3f}/255 · max {int(error.max())} · pixels >8: {measurement['pixels_over_8_percent']:.2f}%"
        if name in previous:
            old = previous[name]
            quality += f"<br>上次：PSNR {old['psnr_db']:.2f} dB · MAE {old['mae']:.3f}/255"
        timing = f"Web {measurement['web_ms']:.2f} ms · C++ {measurement['cpp_ms']:.2f} ms"
        source_panel=''
        if name in source_scores:
            score=source_scores[name];measurement['source_fit']=score
            source_panel=(f'<details><summary>原始照片参照（数据集 mask，非正确性验收）</summary>'
                          f'<p>原照片拟合：Web {score["web_psnr_db"]:.2f} / C++ {score["cpp_psnr_db"]:.2f} dB。'
                          f'计分 mask 占比 {score["valid_percent"]:.1f}%；mask 会漏掉部分手和手指遮挡，分数包含该误差。'
                          f'<a href="mask-{view["name"]}.png">查看计分 mask</a></p>'
                          f'<img loading="lazy" src="source-fit-{name}.png"></details>')
        cards.append(f'<article data-method="{method}" data-mode="{view["model"]}"><h2>{html.escape(name)}</h2>'
                     f'<p>Source camera: {html.escape(view["sourceImage"])} · {w} × {h}</p><p>{quality}<br>{timing}</p>'
                     f'<a href="{name}.png"><img loading="lazy" src="{name}.png" alt="Web, C++, difference"></a>'
                     f'<details><summary>Overlay slider</summary><div class="overlay" style="aspect-ratio:{w}/{h}">'
                     f'<img src="{name}-cpp.png"><img class="web" src="{name}-web.png"></div>'
                     '<input aria-label="Web overlay" type="range" min="0" max="100" value="50" oninput="this.previousElementSibling.lastElementChild.style.clipPath=`inset(0 ${100-this.value}% 0 0)`"></details>'+source_panel+'</article>')
findings = [probe_message, 'Rendering methods are explicitly selected for this comparison.',
            'Numerical precision and UT/tile candidate coverage remain possible sources of image differences; their contributions are not isolated.']
report = dict(model=manifest['modelPath'], count=wt['info']['count'], resolution_note='Pinhole/fisheye/orthographic 16:9, panorama 2:1; numeric RGB without tone mapping.',
              timing_note='Median synchronized wall time, resident model; excludes PLY parsing/upload and PNG/readback; static C++ frame cache invalidated.',
              reference_revision=args.reference_revision, panorama_probe=probe, findings=findings, source_fit_note=source_fit['note'] if source_fit else None, measurements=measurements)
(output/'metrics.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
doc='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Photara real-scene parity</title>
<style>body{max-width:1560px;margin:40px auto;padding:0 24px;background:#10151d;color:#e3eaf5;font:16px/1.6 system-ui}h1{font-size:30px}h2{font-size:21px}p{color:#b8c4d4}article{background:#1a2230;border:1px solid #314058;border-radius:12px;padding:20px;margin:24px 0}img{width:100%;display:block}select,input{font:inherit;margin:8px;padding:8px}a{color:#9dccff}.overlay{position:relative}.overlay img{position:absolute;inset:0}.overlay .web{clip-path:inset(0 50% 0 0)}summary{cursor:pointer}input[type=range]{width:90%}</style>
<h1>Photara WebGPU / C++ Studio 逐图对比</h1>
<p>MODEL_COUNT Gaussian 实景；共用原始 COLMAP 外参、输出内参、SH、黑色背景。左：Web；中：C++；右：8 倍绝对差分。展开图片下方的滑块可叠加检查。</p>
<p>耗时为模型驻留后的同步帧墙钟中位数，包含提交等待，排除读取模型、上传和截图。全景包含接缝两侧。各图像及指标均为本机实际运行结果。</p>
<p>C++ reference: REFERENCE_REVISION。PROBE_MESSAGE 本报告显式选择 3DGS 和 GUT 作比较，逐图列出本轮误差及上次误差；最小复现通过不代表实景已全部对齐。</p>
<label>方法 <select id="method"><option value="">全部</option><option>3dgs</option><option>3dgut</option></select></label>
<label>相机 <select id="mode"><option value="">全部</option><option>pinhole</option><option>fisheye</option><option>equirectangular</option><option>orthographic</option></select></label>
'''+''.join(cards)+'''<script>for(const s of document.querySelectorAll('select'))s.onchange=()=>{for(const a of document.querySelectorAll('article'))a.hidden=(method.value&&a.dataset.method!==method.value)||(mode.value&&a.dataset.mode!==mode.value)}</script></html>'''
(output/'index.html').write_text(doc.replace('MODEL_COUNT', f"{wt['info']['count']:,}").replace('REFERENCE_REVISION', html.escape(args.reference_revision)).replace('PROBE_MESSAGE', html.escape(probe_message)),encoding='utf-8')
for m in measurements:
    print(f"{m['name']:35s} PSNR={m['psnr_db']:.2f} MAE={m['mae']:.3f} max={m['max_error']} web={m['web_ms']:.2f} cpp={m['cpp_ms']:.2f}")
