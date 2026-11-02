# 随机 Splat 渲染评估

2026-11-02。评估文档，尚未实现随机渲染路径。

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
