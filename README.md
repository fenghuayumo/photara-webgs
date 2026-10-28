# Photara WebGS

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

3DGUT 使用七点 UT（中心权重 1/4，其余 1/8）估计覆盖，并在片元阶段计算局部空间射线最近点响应。它不复用二维 Gaussian 响应；也不额外添加 3DGS 的 Mip2D 处理，与当前 C++ GUT 分支保持相同分支语义。SH 使用 `center-eye` 方向、INRIA 常量，结果下限为 0，最终显示不额外添加 tone mapping/gamma。

## GPU 管线和已知边界

1. 每个 Gaussian 做 GPU 可见性判断、SH、3DGS 投影或 GUT 预处理。
2. 8 轮稳定的 4-bit LSD radix sort。组内并行 scan → 各 digit 的工作组前缀 → scatter；没有逐帧 CPU 排序或 readback，不依赖 subgroup 扩展。
3. 按远到近绘制实例化 quad，premultiplied alpha blending。3DGS 针孔/正交使用相机 Z，全景和 3DGUT 使用相机距离。
4. RGBA16Float 累积，最后直接呈现；截图时显式转换为 RGBA8。

首版的明确边界：

- 对齐的是参数、坐标、投影和 Gaussian 响应；不是 C++ tile compute rasterizer 的逐位重写。混合顺序的同深度 tie、半精度累积和缺少前向 early termination 都可能产生细小差异。
- GUT 针孔覆盖额外并上保守包围球。穿越相机的支撑区域，以及 GUT 鱼眼/全景目前使用全屏 quad，保证射线贡献不被小覆盖范围截断，但大场景 overdraw 可能明显。不是已完成的百万级 GUT 性能优化。
- 全景 EWA 对接缝做周期复制并限制每个像素的唯一归属；未增加训练、深度/法线输出、动画、mesh 合成、多个模型独立 placement、LOD、流式加载或压缩格式。
- 暂无 WebGL fallback；不要将 Rust/WASM 视为解决浏览器 GPU 能力限制的办法。
- 本轮使用合成数据和独立双精度 oracle 验证，尚未拿实际 Photara 导出场景与 C++ 截图做逐图对比，也没有声称达到 SuperSplat 性能。

下一步优先拿真实 Photara PLY 和标定相机做同视角图像比较，再据实际 profile 优化 GUT 覆盖、可见点压缩、排序和场景分块。

## 验证

```sh
npm test
npm run test:gpu
```

基础测试无依赖。GPU 测试需要 Playwright：若环境没有预装，运行 `npm install --no-save playwright`，然后 `npx playwright install chromium`。`BROWSER_EXECUTABLE` 可指定浏览器路径；`PLAYWRIGHT_MODULE_PATH` 可指定已有的 Playwright 包目录。本机 Windows 默认优先使用已安装 Edge。

GPU 检查包含独立 CPU oracle 像素对比、两个模型与所有 filter 模式、非平凡外参和四元数、四种相机、数值 Jacobian、全景接缝、GUT 近相机覆盖、超过 256 个工作组的 radix prefix 和稳定排序、SH、readback padding、worker 加载取消及资源生命周期。

测试结果及桌面/手机截图写入被 Git 忽略的 `test-results/`。开发服务与测试服务分别使用端口 4173 / 4174。
