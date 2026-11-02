# 随机 Splat 渲染评估

2026-11-02。已实现可选随机透明采样，默认仍为完整排序。

## 当前实现与实测

查看器的“渲染”选项提供 **完整画质 / 交互加速（移动时有噪点）**。
加速模式在转台拖动、滚轮、WASD 与聚焦动画期间使用随机片元覆盖，跳过 24 个
radix compute pass；输入停止约 130 ms 后或持续运动/动画结束后的下一帧恢复完整排序。
没有 Auto 性能阈值、TAA、历史重投影或静止随机累积；静止输出直接回到确定的排序路径。

GS 使用投影结构空闲分量保存中心深度，在顶点阶段写入整块一致的 reversed depth，
允许硬件 early-Z；panorama 使用径向中心距离。GUT 使用每条像素射线的响应峰值，
通过片元深度输出，因此深度测试成本更高。两种模式共用原 alpha 响应、过滤、支撑范围
和 SH 计算。随机数随 pixel、Gaussian ID 与 seed 变化，不是随机删除模型点。

深度纹理按需创建，使用 depth32float，每像素增加 4 bytes；960×540 增加 2.074 MB，
1440×810 增加 4.666 MB。改分辨率或 dispose 时释放，回到完整画质后缓存供下次交互使用。
不增加模型 GPU buffer，仅新增 16-byte seed uniform。`getMemoryUsage()` 包含新增资源。

`renderer.pick()` 在随机帧之后按需排序，再使用原 opacity 累积拾取；
它不把随机深度当成焦点，也不逐帧补排序。`readPixels()` 默认重新渲染最近一帧的
相机快照与原配置，强制返回完整排序图像；诊断用 `readPixels({exact:false})` 可读取随机帧。
标定相机输出始终使用完整排序。

### 完整 300 万点场景

RTX 5090 D v2 / Edge 156，三组相机附近的小范围确定性轨迹。
每组预热 4 帧、记录 32 帧，交替执行 sorted/stochastic，两个分辨率、两种方法。
使用显式 GPU 完成同步；时间不包含 readPixels / profiler readback，**不等于浏览器 RAF FPS**。
以下为提交到完成的同步墙钟 p50，单位 ms：

| 方法 | 分辨率 | view0 排序 → 随机 | view1 排序 → 随机 | view2 排序 → 随机 |
| --- | --- | ---: | ---: | ---: |
| 3DGS | 960×540 | 4.0 → 3.4 | 4.1 → 3.2 | 3.6 → 3.3 |
| 3DGS | 1440×810 | 4.6 → 4.0 | 4.1 → 3.8 | 4.0 → 3.2 |
| GUT | 960×540 | 3.9 → 3.0 | 3.9 → 3.2 | 4.0 → 3.0 |
| GUT | 1440×810 | 4.5 → 4.0 | 4.1 → 3.1 | 5.1 → 4.0 |

GPU 3DGS 绘制 p50：0.270–0.796 → 0.222–0.617 ms；GUT 绘制 p50：
0.263–0.764 → 0.295–0.869 ms（**GUT 绘制变慢**）。省去的 GPU 排序约 0.09–0.10 ms。
JS 编码采样大多为 0.1–0.2 ms，计时精度不足以证明 CPU 编码明显变快。
不能把全部墙钟差异归因于排序，更不能承诺在弱 GPU、全景或任意轨迹中同样加速。
每组 32 个样本的 p95/p99 和原始数据见 [机器记录](benchmarks/1023-stochastic.json)，
尾部存在系统/驱动抖动，有些指标没有改善。

所有 12 组输出恢复到排序后 RGBA8 最大误差 **0**；六组 GUT 排序哈希还与
随机路径加入前已提交的加载基准一致。运动随机帧是有损近似：单样本 RGB MAE
约 19.0–30.3 / 255，噪点可见，不应作为高质量截图。当前适合手动选择体验，
不默认开启；后续可评估多样本/空间滤波与重投影，必须重新衡量其成本与鬼影。

### API 与复现

```js
element.setRenderingMode('movement'); // 或 viewer.setRenderingMode(...)
element.setRenderingMode('sorted'); // 默认
renderer.render(camera, { transparency:'stochastic' });
renderer.render(camera, { transparency:'stochastic', stochasticSeed:123 }); // 可复现
await renderer.pick(x, y); // 按需排序，保持原拾取语义
await renderer.readPixels(); // 强制完整排序截图
await renderer.readPixels({ exact:false }); // 诊断原始随机帧
```

构造 `GaussianViewer` 时可传 `{renderingMode:'movement'}`。
`npm test`、`npm run test:sog`、`npm run test:gpu` 验证默认路径不回退；GPU 测试新增
两种方法/四种相机、compact 切换、固定 seed、透明统计、空帧、相机快照与按需拾取。

```powershell
node scripts/benchmark-stochastic.mjs --frames 32
# 可覆盖 --model / --manifest / --output；--reference 指定含 records[0].images 的旧图像哈希记录。
```

## SuperSplat 当前的做法

[SuperSplat Editor 3.0 官方说明](https://blog.playcanvas.com/new-in-supersplat-editor-3-0-rebuilt-on-webgpu/)
描述了 Stochastic Alpha：以透明度作为每片元的随机覆盖概率，存活片元以不透明方式做
深度测试，从而不需要深度排序。编辑器提供 Disabled / Enabled / Movement / Auto；
Auto 在排序帧较慢时于运动期间启用，停止后恢复完整排序与混合。

[SuperSplat Viewer 源码](https://github.com/playcanvas/supersplat-viewer/blob/main/src/render/stochastic-splat-renderer.ts)
也包含 WebGPU 可选随机路径，采用投影缓存、间接绘制、不透明颜色与深度目标，
并含时间累积等实现。Viewer 与 Editor 是不同实现，不应混为相同默认配置。

[StochasticSplats 论文](https://arxiv.org/abs/2503.24366) 讨论了无排序的随机栅格化与
采样数/画质的权衡。其性能倍数不能直接用于本项目，随机 alpha 也不等于随机删掉一批点。

## 对当前 WebGS 的判断

这可以作为另一种透明合成策略，与 `renderMethod:'3dgs'|'3dgut'` 分开；
不必改变模型格式或重新训练，也不能代替空间剔除、LOD、紧凑存储与分页。

现有 [1023 GUT 基准](1023-gut-optimization.md) 在可见压缩后排序约 0.095–0.105 ms、
绘制约 0.30–0.75 ms。去掉排序直接省下的 GPU 时间有限，但也能减少 24 个排序
compute pass 的编码与调度。当前没有纯 3DGS 连续漫游的对应数据，不能用 GUT 的
固定视角外推所有场景，也不能在加入深度目标后承诺总体更快。

更适合先做可选的运动加速分支，复用投影、可见压缩与间接参数，保留当前排序基线。
先提供 sorted / movement，等轨迹分析与设备测试充分后再决定 Auto 的阈值。

## 实现必须同时处理的内容

1. 真正的片元深度：当前绘制顶点深度固定为 0.5，不能只打开 depth test。
   需要明确 GS 深度近似、GUT 射线响应位置、非线性相机的深度映射与 near 行为。
2. 采样独立性：随机源需考虑 pixel、Gaussian ID 和采样/帧序号，避免高斯间相关性
   造成遮挡偏差。有限样本会出现噪点，薄结构和透明层需要专门评估。
3. 交互调度：鼠标拖动、滚轮、按键移动、聚焦动画都应标记运动，停止后主动请求
   一帧 sorted 输出。截图/标定输出仍使用确定的排序路径。
4. 拾取：当前 opacity 拾取按排序键从前向后扫描；随机绘制跳过排序后不能继续读旧键。
   可以只在双击时补做排序，或增加独立深度/ID 拾取，需对比成本和命中语义。
5. 深度纹理与可选历史缓冲带来额外显存。若加入 TAA/重投影，还须处理相机切换、
   模型替换、分辨率变化、遮挡变化和鬼影，不能把累积图直接跨视角复用。

## 验收建议

分别用纯 3DGS 与 GUT，覆盖 pinhole / fisheye / panorama、室内近距离重叠、薄结构和
较弱 GPU。使用确定性连续轨迹，比较 p50/p95/p99 帧时间、CPU 提交与 GPU 各阶段、
新纹理显存、运动噪点与停止后的恢复时间。
停止后的排序截图必须与现有基线逐字节相同；运动帧需要报告画质/噪声，不能把有损近似
与完整排序速度直接称为无损加速。优先验证收益后，再决定是否默认启用。
