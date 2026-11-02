# 1023 SOG：GUT 覆盖范围与可见点压缩

2026-11-02。本轮只修改 WebGS，未同步 TEZOI。
完整 3,000,000 Gaussian 的原始 `splat.sog`，SH degree 3；没有抽点、LOD、
降低 SH 阶数、改变 alpha 阈值或动态降分辨率。
硬件为 RTX 5090 D v2，Edge WebGPU / NVIDIA Blackwell adapter，启用 GPU timestamp。

## 已实现

- 针孔 GUT 使用有限 alpha 支撑椭球的切平面计算屏幕边界，替换 UT 与最大轴包围球的并集。
- 对跨越相机 z=0 平面的支撑，使用包围盒的单侧投影约束；只有无法进一步约束的轴才保留全屏范围。继续保留像素余量与数值 padding。
- 在屏幕范围剔除后再读取和计算 SH，减少不可见点的带宽。
- GPU 稳定压缩：块内 scan → 块计数 prefix → scatter，保持原 Gaussian ID 顺序。
- 可见数量直接在 GPU 更新 radix 参数、间接 dispatch 与间接 draw。没有逐帧 CPU 排序或计数 readback。
- 复用已有 keys/ranks 缓冲区，仅增加每块两个 uint 与 32 字节间接参数；300 万点约增加 94 KB。
- `readTimings()` 增加 `compact_ms`，`readVisibility()` 提供显式诊断 readback。

## 同一次运行内交替对照

三组来自数据集首、中、末的 COLMAP 外参；使用比较工具构造的虚拟 pinhole 内参。
960×540、1440×810，`3dgut + mip2d`，黑背景。每个视角五轮预热，
之后十五轮，每轮轮换三条路径的执行顺序。表格是提交到 GPU 完成的墙钟中位数，单位 ms。
排除模型加载、截图和 profiler readback；不是实际交互 FPS。
三条路径共享当前投影 shader 的延后 SH 计算；“旧覆盖”由 `tightBounds:false` 恢复。

| 分辨率 / 视角 | 旧覆盖＋全量排序 | 紧覆盖＋全量排序 | 紧覆盖＋可见压缩 | 可见点 |
| --- | ---: | ---: | ---: | ---: |
| 960-view0-pinhole | 70.5 | 8.0 | 4.1 | 34,664 |
| 960-view1-pinhole | 59.6 | 8.0 | 4.9 | 48,419 |
| 960-view2-pinhole | 64.9 | 6.0 | 3.9 | 14,295 |
| 1440-view0-pinhole | 144.7 | 7.9 | 5.1 | 34,617 |
| 1440-view1-pinhole | 113.7 | 9.1 | 4.2 | 48,361 |
| 1440-view2-pinhole | 253.2 | 8.5 | 4.0 | 14,274 |

原始 GPU 绘制中位数约 57–247 ms；最终压缩路径为 0.30–0.75 ms。
投影约 0.44–0.48 ms，压缩约 0.057–0.058 ms，排序约 0.095–0.105 ms
（全量排序约 1.03–1.05 ms）。各阶段中位数不能直接相加等同于墙钟中位数；
提交、同步、驱动、其他 GPU 工作与系统调度会影响墙钟时间。

最终版本另行独立运行，六组墙钟中位数 3.1–5.1 ms；与修改前保留的旧源码
渲染结果相比，全部 RGBA8 最大误差为 0，MAE 为 0。交替对照内的三条路径
也逐字节一致。完整原始 samples 和独立运行数据见
[机器记录](benchmarks/1023-gut-optimization.json)。原始 rgba 与旧源码快照保存在
本机被 Git 忽略的 `test-results/optimization/` 与 `test-results/optimization-baseline/`。

## 验证与边界

`npm test`：18 项数值/加载测试通过。
`npm run test:sog`：原始 RGBA、压缩/未压缩 ZIP、非打包目录、worker 和 GPU 出图通过。
`npm run test:gpu`：31 项核心 GPU 检查及 4 项 UI 检查通过。
新增覆盖旋转薄椭球、相机平面穿越、零可见点、257/65,617 个点的部分工作组、
同深度稳定性，以及压缩与全量路径之间切换。20 组确定性随机椭球与旧路径截图一致。

这些结果证明当前被测试的针孔场景明显提速，不代表任意场景或设备的最优值。
全景和鱼眼本轮未新增覆盖边界优化，但仍通过已有 oracle 测试；可见点压缩也用于它们。
仍然需要投影全量点，GPU 常驻内存仍约 1.1 GB，没有加入 LOD 或压缩 GPU SH 存储。
未改动 GUT 的逐像素响应，也未解决已记录的 Web/C++ 实景图像差异。

## 复现

先用现有工具生成相机清单（无需运行 PLY 渲染）：

```powershell
node scripts/compare-scene.mjs --model 'D:/BaiduNetdiskDownload/1023/20261023_merged_dataset/images.cache/splat.ply' --sparse 'D:/BaiduNetdiskDownload/1023/20261023_merged_dataset/sparse/0' --output test-results/optimization --methods 3dgut --modes pinhole --views 3 --manifest-only
node scripts/benchmark-optimization.mjs --label paired --paired
```

`--model` 可指定另一个 SOG；相机清单仍必须与该模型匹配。
`--paired` 在同一个 renderer 内切换开关，因此不依赖旧源码快照。
单独 `--no-tight` / `--no-compact` 可分别禁用两项优化。
默认模型路径为本场景的 `images.cache/splat.sog`。
