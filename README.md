# Photara WebGS

## GitHub Pages 部署

运行 `npm run build` 生成 `dist/`，仅包含网站资源，不打包本地模型或测试报告。
GitHub 仓库的 Settings → Pages 中选择 GitHub Actions，推送 `master` 后自动测试、构建并部署。
私有仓库使用 GitHub Pages 需要账号套餐支持；模型仍由访问者在浏览器本地打开。

可独立嵌入静态网站的 WebGPU Gaussian 渲染器。使用原生 ES modules + WGSL，无运行时第三方依赖、不需要打包，适合后续接入 TEZOI 的 Visual Rendering 区域。

## 本地运行

需要 Node.js 20+：

```sh
npm run dev
```

打开 http://localhost:4173 ，点击「打开 PLY」、拖入 Photara PLY，或加载合成示例。文件在浏览器本地解析，不会上传。

需要支持 WebGPU 的浏览器和可用适配器；通过 HTTPS 或 localhost 访问，不能直接双击 `index.html`。没有 WebGL fallback；不支持时页面会显示错误。预览服务仅绑定本机。

## 嵌入现有网站

将本项目的 `src/` 整个复制到网站，例如 `site/photara-webgs/src/`，保留 shader、worker 和 CSS 的相对位置：

```html
<script type="module" src="./photara-webgs/src/index.js"></script>
<photara-viewer src="./assets/laboratory.ply"></photara-viewer>
```

组件样式位于 Shadow DOM，不影响网站现有样式。设置 `demo` 属性可以展示明确标记的合成数据。可运行的嵌入示例位于 `examples/embed.html`。

```js
await customElements.whenDefined('photara-viewer');
const element = document.querySelector('photara-viewer');
element.addEventListener('model-load', event => console.log(event.detail));
element.addEventListener('viewer-error', event => console.error(event.detail));
await element.load('./assets/scene.ply');
// 也接受 File、Blob、ArrayBuffer。ArrayBuffer 会转移给 worker，原 buffer 被 detach。
```

`src` 变化会取消先前加载。组件移除时终止 worker、取消请求、清理监听器并销毁 GPU 资源。静止、移出视口、浏览器标签隐藏时不持续渲染。没有自动旋转。

远程模型服务器需要允许 CORS，部署环境的 CSP 需要允许同源 module worker、shader fetch 和样式。这里没有接入或修改 TEZOI 网站，也没有部署。

## 相机与坐标

- 原始模型世界坐标不做翻转、缩放、居中或重排。自动取景只移动相机。
- OpenCV 相机坐标：+X 向右、+Y 向下、+Z 向前。
- `worldToCamera` 是列主序的刚性 world-to-camera 4×4 矩阵。相机中心从矩阵推导；可选 `position` 必须与其一致。
- 四元数为 `w,x,y,z`，输入归一化；尺度是标准差而非方差。
- `fx/fy/cx/cy` 为像素单位，独立保留非中心主点和不同横纵焦距。
- `model` 支持 `pinhole`、`orthographic`、`fisheye`、`equirectangular`。
- 正交相机的 `fx/fy` 是每世界单位对应的像素数。鱼眼使用 Photara 的 theta 多项式 `k1–k4`，不等价于普通 Brown 针孔畸变。
- 全景相机要求 `fx=W/(2π), fy=H/π, cx=W/2, cy=H/2`，对应 Photara 的全幅 equirectangular 投影。
- compute/fragment 采样使用整数像素，显式处理 WebGPU 的半像素位置。

可以在页面导入 `examples/camera.json`，或通过 API 设置精确标定相机：

```js
element.setCamera({
  worldToCamera: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,4,1],
  width: 1280, height: 720,
  fx: 684, fy: 684, cx: 640, cy: 360,
  near: 0.01, model: 'pinhole', distortion: [0,0,0,0]
});
element.resetCamera(); // 返回自由探索
```

精确相机会保留指定输出分辨率，页面按容器等比显示；不擅自改变内参。C++ 的 `world_to_camera` 传入这里的 `worldToCamera` 即可。如需改变输出分辨率，显式调用 `resizeCamera()` 同步缩放内参。

## 不使用组件，仅使用渲染核心

```js
import { GaussianRenderer } from './src/renderer.js';
import { parsePly } from './src/ply.js';

const renderer = await GaussianRenderer.create(canvas);
const model = parsePly(await (await fetch('./scene.ply')).arrayBuffer());
await renderer.setModel(model);
renderer.render(camera, { background: [0,0,0] });
const rgba = await renderer.readPixels(); // 截图或比较时才 readback
renderer.dispose();
```

`parsePly` 本身是同步纯函数。组件在 module worker 中调用它；自定义页面也可复用 `PlyLoader` 避免阻塞主线程。

渲染核心不创建动画循环或监听 DOM。嵌入者可自行管理时间、相机、加载和画面可见性。每个 renderer 独立拥有 device，请在替换组件时释放旧实例。

## Photara PLY 与滤波语义

支持 ASCII、binary little endian 和 binary big endian；Gaussian vertex 必须是首个非空 element，顶点不支持 list property。支持普通标量属性类型、任意属性顺序以及附加的 Photara normal features（忽略）。默认最多 400 万 Gaussian，实际还受设备 buffer 限制。

读取以下元数据；缺失时默认 `3dgs` + `classic`，未知值会报错，不静默降级：

```text
comment photara_render_method 3dgs
comment photara_filter_mode classic
property float filter_3D
```

- `render_method`: `3dgs` / `3dgut`。
- `filter_mode`: `classic` / `mip2d` / `mip3d` / `mip`。
- `scale_0..2`: log-space，激活前 clamp 到 [-20,20]。
- `opacity`: logit，使用稳定 sigmoid。
- `rot_0..3`: scalar-first quaternion。零范数或损坏数据报错。
- `f_dc_*`, `f_rest_*`: SH degree 0–3。PLY 的余项按 R/G/B 分组存储，加载后转为 `[N,bases,RGB]`。
- `filter_3D`: 若存在，在加载时按 C++ renderer 上传逻辑应用一次，即 `s'=sqrt(s²+f²)`，`alpha'=sigmoid(opacity)*product(s/s')`。canonical GPU 模型已经激活和滤波，不会重复应用。

3DGS 使用 EWA Jacobian 和屏幕 covariance，针孔 Jacobian 包含 C++ 的 1.3× FOV clamp：

| 模式 | 2D covariance 对角增量 | 能量补偿 |
| --- | --- | --- |
| classic / mip3d | 0.3 | 关闭 |
| mip2d / mip | 0.1 | `sqrt(detBefore/detAfter)` |

3DGS 在加入上述滤波核后同步 Studio 的 EWA 足迹限制：令
`L = min(1024, width, height)`，当最大特征值 `λmax > L²/8` 时，
将整个二维 covariance 乘以 `L²/(8λmax)`，保持椭圆方向和长短轴比例。
这限制的是 `sqrt(8λmax)`；实际绘制边界仍按透明度的 `1/255` 等值线计算，
并保留像素 padding。Mip2D 能量补偿使用限制前的 covariance，不因足迹缩小而增加透明度。
该规则覆盖针孔、正交、鱼眼和全景的 3DGS；3DGUT 保持三维射线支撑规则。

3DGUT 在线性相机使用七点 UT（中心权重 1/4，其余 1/8）加保守支撑范围；鱼眼使用有限 alpha 支撑椭球的切线区间，全景使用包围球的经纬角域。片元阶段计算局部空间射线最近点响应，不复用二维 Gaussian 响应，也不额外添加 3DGS 的 Mip2D 处理。非线性相机射线以 RGBA32Float 缓存，只在内参、畸变或分辨率变化时重建；移动相机复用相机空间射线。SH 使用 `center-eye` 方向、INRIA 常量，结果下限为 0，最终显示不额外添加 tone mapping/gamma。

## GPU 管线和已知边界

1. 每个 Gaussian 做 GPU 可见性判断、SH、3DGS 投影或 GUT 预处理。
2. 8 轮稳定的 4-bit LSD radix sort。组内并行 scan → 各 digit 的工作组前缀 → scatter；没有逐帧 CPU 排序或 readback，不依赖 subgroup 扩展。
3. 按远到近绘制实例化 quad，premultiplied alpha blending。3DGS / 3DGUT 的针孔、鱼眼和全景均按相机空间中心的径向距离排序；正交相机按 Z 排序，与 Studio 共享光栅器一致。同距离保留原始 ID 的稳定顺序。
4. RGBA16Float 累积，最后直接呈现；截图时显式转换为 RGBA8。

首版的明确边界：

- 对齐的是参数、坐标、投影和 Gaussian 响应；不是 C++ tile compute rasterizer 的逐位重写。混合顺序的同深度 tie、半精度累积和缺少前向 early termination 都可能产生细小差异。
- GUT 针孔覆盖额外并上保守包围球；鱼眼和全景使用保守局部 quad，全景跨接缝复制并保证每像素只混合一次。支撑穿越相机等无法安全界定的情况保留全屏覆盖，极端大尺度 Gaussian 仍可能产生 overdraw。
- 全景 EWA 对接缝做周期复制并限制每个像素的唯一归属；未增加训练、深度/法线输出、动画、mesh 合成、多个模型独立 placement、LOD、流式加载或压缩格式。
- 暂无 WebGL fallback；不要将 Rust/WASM 视为解决浏览器 GPU 能力限制的办法。
- 已使用 `chuan/images.cache/splat.ply` 的 826,036 个 Gaussian、三个 COLMAP 标定视角、四种相机和两种方法，与 C++ Studio 实际 Vulkan viewport 库进行 24 组截图比较。3DGS 大多数视角接近；GUT 仍有明显差异，详见 [实景比较与性能记录](docs/real-scene-comparison.md)，不能视为已完成 C++ 图像对齐。

2026-10-29 已复核 C++ `0954fae`，确认全景去重最小复现修复；Web 同步支持 GUT 精确极点与鱼眼镜头有效域。新旧 24 组逐图指标保存在 `test-results/comparison-20261029/`，GUT 全景/鱼眼误差有所下降，针孔及正交的旧模型差异仍在。

另已完成办公室 `splat_cleaned.ply` 的完整 295.7 万点、960/1920 宽测试，共 42 组 Web/C++ 比较，并加入原始全景照片参照。详见 [办公室大模型测试](docs/office-cleaned-benchmark.md)；本地报告入口为 `test-results/office-cleaned-report.html`。测试工具支持 COLMAP TXT/BIN 的 SIMPLE_PINHOLE、PINHOLE 和扩展 EQUIRECTANGULAR 相机。

实景 GPU timestamp 显示剩余 GUT 成本主要在片元 overdraw。后续可针对大尺度/极扁 Gaussian 做更紧的全景支撑界、tile candidate 压缩和前向 early termination；排序耗时应以 pass profile 为准。

显式启用 GPU profiling（设备支持 `timestamp-query` 时）：

```js
const renderer = await GaussianRenderer.create(canvas, { profiling: true });
renderer.render(camera);
const timing = await renderer.readTimings(); // rays/project/sort/draw，单位 ms
```

默认不启用查询；`readTimings()` 只读取最近提交帧，需在提交下一帧前等待它完成。无 timestamp-query 支持时返回 `null`。这不是浏览器事件、加载或截图耗时。

## 验证

```sh
npm test
npm run test:gpu
```

基础测试无依赖。GPU 测试需要 Playwright：若环境没有预装，运行 `npm install --no-save playwright`，然后 `npx playwright install chromium`。`BROWSER_EXECUTABLE` 可指定浏览器路径；`PLAYWRIGHT_MODULE_PATH` 可指定已有的 Playwright 包目录。本机 Windows 默认优先使用已安装 Edge。

GPU 检查包含独立 CPU oracle 像素对比、两个模型与所有 filter 模式、非平凡外参和四元数、四种相机、数值 Jacobian、全景接缝、GUT 近相机覆盖、超过 256 个工作组的 radix prefix 和稳定排序、SH、readback padding、worker 加载取消及资源生命周期。

2026-11-05 同步 Studio 的 EWA 足迹限制和径向排序。新增 GPU 回归覆盖限制阈值两侧、
旋转各向异性与各向同性 covariance、1024 像素上限、横竖分辨率、四种滤波/相机的像素响应，
以及径向距离与 Z 顺序相反时的 GS/GUT 排序、稳定同距、空间重排和可见点压缩路径。

测试结果及桌面/手机截图写入被 Git 忽略的 `test-results/`。开发服务与测试服务分别使用端口 4173 / 4174。


## SOG v2

文件选择、拖放与 `element.load()` 自动识别 `.ply` / `.sog`；URL 也支持
非打包 SOG 的 `meta.json`，附属图像相对于该 URL 加载。单独的本地
`meta.json` 不包含图像，请使用 `.sog` ZIP 包。

```js
await element.load('./scene.sog');
await element.load('./scene/meta.json');
// Browser / worker API; async because ZIP and raw image decoding are asynchronous.
import { parseSog, ModelLoader } from './src/index.js';
const model = await parseSog(buffer);
```

支持 SOG v2、ZIP STORE / DEFLATE、lossless WebP/PNG、SH degree 0–3、
16-bit SH palette labels 和 `antialiased` 的 mip2d。按 Studio 导入约定将 SOG 的 RUB 坐标转换为 Photara RDF，旋转与 SH 同步转换。
原始 RGBA 解码禁用颜色转换和 alpha 预乘，避免低透明度像素的数据损坏。
解码在 module worker 内执行，依赖 OffscreenCanvas WebGL2 的原始像素读取；
模型显示仍使用 WebGPU。SOG 压缩减少下载体积，查看器使用紧凑 CPU SH 与 GPU 调色板。
不支持旧 SOG v1、v3、Streamed SOG/LOD、ZIP64、加密 ZIP 和 2DGS。

标准 SOG 不记录 Photara 的 `3dgut` 方法，默认使用 `3dgs`；对于已知的
GUT 模型，嵌入端应显式指定渲染方法。TEZOI 的场景配置保留了该模型的
`3dgut + mip2d`。SOG 为有损量化格式，不承诺与原 PLY 逐像素相同。

格式依据：https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/

SOG 回归：`npm test`（数值与损坏数据），`npm run test:sog`（真实 WebP/PNG、ZIP、worker、GPU 出图），`npm run test:gpu`（既有渲染回归）。


## 2026-11-02：GUT 与可见点管线优化

默认启用针孔 GUT 的保守椭球覆盖边界与 GPU 稳定可见点压缩。
压缩结果直接驱动 GPU 间接排序和绘制，延后 SH 到屏幕剔除后计算。
完整 300 万点 SOG 的六组固定相机对照，RGBA8 与旧源码结果逐字节一致。
实测计时、设备、复现命令和边界见 [本场景优化报告](docs/1023-gut-optimization.md)。

```js
renderer.render(camera); // 默认 compact:true, tightBounds:true
renderer.render(camera, { compact:false, tightBounds:false }); // 对照覆盖/排序路径
// 仅用于显式性能诊断，正常帧循环不需要 readback：
await renderer.device.queue.onSubmittedWorkDone();
console.log(await renderer.readTimings()); // profiling 开启时含 compact_ms
console.log(await renderer.readVisibility()); // { visible, total }
```

本轮仅更新 WebGS，尚未同步 TEZOI。


## 2026-11-02：GPU 内存优化

SOG 默认保留高阶 SH 调色板并在 GPU 按索引读取，保持 Float32 精度；
投影中间结构从 112 减为 96 bytes/点。当前完整 300 万点模型的 GPU 模型缓冲区
从约 1,117.6 MB 降至 553.4 MB，六组固定视角与此前截图逐字节一致。
详见 [GPU 内存报告](docs/1023-memory-optimization.md)。CPU 峰值内存本轮未降低。

```js
await renderer.setModel(model); // SOG 调色板精确还原且更小时自动采用
await renderer.setModel(model, { shStorage:'float32' }); // 参考路径
console.log(renderer.getMemoryUsage()); // 应用 buffer/texture 请求字节数，不是整个进程显存
```

`model.sh` 仍是 canonical Float32 数组。存在调色板时会核对高阶项，修改后不能精确还原
则自动回退普通 Float32；没有调色板的 PLY 也获得投影结构的内存节省。
本轮仍未同步 TEZOI。

## 2026-11-02：SOG 紧凑 CPU 加载

查看器现在默认直接保留 DC、标签与 Float32 调色板，不完整展开高阶 SH；
Worker 按紧凑形式转移，上传直接写 GPU 映射区，省掉 CPU 拼接数组。
完整 300 万点场景模型数组由 743.8 MB 降至 203.8 MB（减少 72.6%），
另省去 59.8 MB 上传临时数组。GPU 占用和图像精度保持不变。
同版本交替对照的本地加载约 6.3–6.9 → 3.5–3.9 秒；
采样方法、阶段计时及边界见 [加载内存报告](docs/1023-sog-loading.md)。

```js
await element.load('./scene.sog'); // 查看器默认 packed，PLY 不受影响
await element.load('./scene.sog', { shLayout: 'canonical' }); // 显式兼容路径
// 直接解析 API 与 ModelLoader 默认仍返回原有完整 model.sh：
const canonical = await parseSog(buffer);
const packed = await parseSog(anotherBuffer, { shLayout: 'packed' });
// packed.sh 不存在；可编辑 shDC、shPalette.labels、shPalette.coefficients。
await renderer.setModel(packed); // 不隐式展开
import { toCanonicalModel } from './src/index.js';
const editable = toCanonicalModel(packed); // 显式分配完整 Float32 SH
editable.sh[4] += 0.1;
await renderer.setModel(editable); // 仍核对 canonical SH 编辑，必要时回退 Float32
```

诊断时可使用 `parseSog(buffer,{profile:true})` / `ModelLoader.parse(buffer,{profile:true})`
获取 `model.loadStats`，以及 `setModel(model,{profiling:true})` 的 `renderer.lastUploadStats`。
这些字节统计与 V8 采样均不能代替整进程内存测量；图片解码与 GPU 驱动仍有额外分配。

## 3DGS 空间块提前剔除

4096 点及以上模型默认构建空间块，在 pinhole / orthographic 的 3DGS 精确投影前
保守剔除整个不可见块。完整 300 万点夹具的候选点约 32–42 万，精确输出与原基线一致。
新增约 12.42 MB GPU 索引，增加一次加载构建与属性重排；不保证所有场景整帧提速。
near 交叉、数值异常块保留，GUT/鱼眼/全景回退逐点投影。

```js
renderer.render(camera,{blockCulling:false}); // 仅关闭剔除
await renderer.setModel(model,{spatialBlocks:false}); // 完全关闭空间布局
console.log(await renderer.readBlockVisibility()); // 仅诊断使用
```

详见 [空间分块报告](docs/1023-spatial-blocks.md)。

## 可选随机渲染交互加速

“渲染”选项默认 **完整画质**。选择 **交互加速（移动时有噪点）** 后，
移动期间跳过排序，以随机透明采样和深度测试绘制；停止后恢复完整排序画质。
此模式不会删点或改变 SOG 数据。现已加入 2×2 分层采样、空间重建和时间重投影降噪，
“去噪”选项可比较关闭 / 仅空间 / 空间 + 时间；移动帧仍有噪点和细节软化。
截图及标定相机继续使用完整排序。

```js
element.setRenderingMode('movement'); // 开启交互加速
element.setRenderingMode('sorted'); // 默认完整画质
element.setReconstructionMode('temporal'); // 交互加速时默认；可选 'spatial' / 'none'
renderer.render(camera, { transparency:'stochastic' }); // 底层显式随机帧
renderer.render(camera, { transparency:'stochastic', reconstruction:'temporal' }); // 显式去噪
await renderer.readPixels(); // 默认强制完整排序截图
await renderer.readPixels({ exact:false }); // 诊断随机帧
```

完整 300 万点短轨迹实测与精度边界见 [随机渲染报告](docs/stochastic-rendering.md)。
它增加每像素 4 bytes 深度纹理，不保证所有设备或场景提速；GUT 绘制阶段可能变慢。
空间 + 时间重建还增加 44 bytes/pixel 纹理。完整场景运动 MAE 相比原始随机下降约
54–61%，GPU 新增重建 pass 约 0.024–0.047 ms；细节、拖影与测量边界见
[重建报告](docs/stochastic-reconstruction.md)。停止后的排序截图保持逐字节一致。

## 查看器相机控制与双击聚焦

查看器提供“转台 / 自由漫游”按钮，也可在画布获得焦点后按 V 切换；切换保留当前视角。

| 操作 | 转台 | 自由漫游 |
| --- | --- | --- |
| 左键拖动 / 单指拖动 | 围绕焦点旋转 | 原地环视 |
| 右键拖动 / 双指拖动 | 平移 | 平移 |
| 滚轮 / 双指缩放 | 靠近或远离焦点 | 沿视线前后移动 |
| WASD | 自动进入自由漫游 | 前后左右持续移动 |
| Q / E | 自动进入自由漫游 | 沿世界竖直方向下降 / 上升 |
| Shift / Alt | — | 移动时 10× 加速 / 0.1× 慢速 |
| 双击模型 | 平滑居中并设置焦点 | 平滑居中并回到转台 |

自由漫游提供 0.25× / 1× / 4× 移动速度，基础速度按模型范围适配。
键盘操作仅在画布获得焦点时生效，松键、失焦、页面隐藏和禁用控制时停止移动；
只有按住移动键或聚焦过渡期间连续请求渲染，静止时保持按需绘制。

加载模型后，鼠标左键双击模型可将点击处设为相机目标与旋转中心。
相机保持朝向，将点击点在 250 ms 内平滑移到画面中心，同时按命中距离更新观察距离；
点击背景不改变视角或模式。新的拖动、滚轮、移动键或重置会中断聚焦过渡。
此行为参考 [SuperSplat 相机源码](https://github.com/playcanvas/supersplat/blob/main/src/camera.ts) 的 `pickFocalPoint()`，
拾取深度仍使用本项目的 GS/GUT 响应估计，不承诺和 SuperSplat 每次命中相同位置。
滚轮靠近旋转中心达到最小距离后，会沿视线同步推进相机和旋转中心，可继续进入场景。
按 R 或点击“重置视角”回到首次适配模型的视角。
`setCamera()` 的标定模式保持精确相机输出，重置后恢复交互聚焦。

拾取复用最近一帧的 GPU 投影与排序，仅在双击时执行计算并回读 16 bytes，
不保留额外 CPU 模型副本。GS 使用该像素的二维高斯响应和中心深度，GUT 使用射线响应峰值；
按前向累积透明度达到 50% 的位置确定目标，较透明区域回退到最强贡献点，
总透明度不足 5% 时视为背景。Gaussian 没有网格表面，因此这是视觉深度估计。

嵌入端也可调用 `await viewer.focusAt(x, y)`（canvas 内的 CSS 像素），
或 `await renderer.pick(x, y)`（最近一帧的渲染像素），返回世界坐标或 `null`。
`focusAt()` 命中后启动平滑过渡，返回时不等待动画结束。
`viewer.setControlMode('orbit' | 'fly')` 和自定义元素的 `element.setControlMode(...)` 可切换模式；
构造 `GaussianViewer` 时也可通过 `{ controlMode: 'fly' }` 设置初始模式，默认 `orbit`。
