# 3DGS 空间分块与保守提前剔除

2026-11-02，仅修改 WebGS。默认完整排序与 Float32 高斯响应不变。

## 布局与执行

模型上传时对中心计算 30-bit Morton code，再用稳定整数 radix 构建每块最多
256 个 Gaussian 的空间索引。原 CPU 模型、坐标、尺度、SH 和逻辑 ID 不改变。
GPU 属性与投影槽按空间块布局，SH/DC/调色板仍按原 ID 寻址；输出 depth key 写回
**原 ID 的 key 槽位**，因此可见点压缩与稳定深度排序的同深度顺序保持原 ID 顺序。
这不是把各块独立排序、独立混合。

每帧流程为：

1. GPU 根据块的中心 AABB、最大尺度计算保守屏幕范围，写入块可见标志。
2. 连续清理全量 key 为无效 sentinel；不再清空所有投影结构。
3. 按空间块启动投影。不可见块的线程直接返回，跳过属性读取、精确协方差和 SH。
   候选块继续逐点精确剔除。仍启动全量投影线程检查标志，尚未做候选块间接 dispatch。
4. 按原 ID key 顺序压缩可见点，再做现有全局排序与透明混合。

绘制顶点入口显式检查无效 key，避免非 compact 路径读到上帧残留的投影数据。
随机预览、精确截图、拾取也使用一致的 GPU 属性/投影槽映射。

## 保守范围与回退

只对 **3DGS pinhole / orthographic** 启用提前块剔除。
鱼眼、全景、GUT 保持原逐点投影；跨 near 的块与极端数值范围也直接保留。
不能只检查点中心或三维物理支撑：现有 GS 的针孔 Jacobian 会对 x/z、y/z 做 clamp。
块范围明确按这个 clamp 上限约束二维协方差，并包含：

- 块中最大尺度、旋转归一化允许误差，以及每帧 `scaleModifier`；
- alpha 支撑上界（使用 12，覆盖 `2 log(255)`）；
- 最高 0.3 的二维滤波核与像素余量；
- Float32 AABB 舍入和相机变换余量；
- 非中心主点、不同 fx/fy、正交投影与 near clip。

这不做遮挡剔除，不降低点数/SH 阶数，也不引入 LOD。
大高斯、空间离群点或相机附近块可能令范围很松，收益由场景与视角决定。

## 性能实测

完整 3,000,000 点 SOG，SH degree 3；RTX 5090 D v2 / Edge 156。
同一版本分别测试完全不构建索引，以及同一 indexed renderer 内交替开关剔除。
每组预热 5 轮、采样 32 轮，记录 GPU timestamp 与提交到完成的同步墙钟。
后者不是 RAF FPS，各阶段分位数也不能直接相加。

| 视角 | 无索引投影 ms | 索引＋剔除投影 ms | 块判断 ms | 候选点数 |
| --- | ---: | ---: | ---: | ---: |
| 960 view0 | 约 0.40 | 0.099 | 0.0034 | 328,384 |
| 960 view1 | 约 0.40 | 0.095 | 0.0032 | 324,032 |
| 960 view2 | 约 0.40 | 0.117 | 0.0032 | 415,680 |
| 1440 view0 | 约 0.40 | 0.064 | 0.0031 | 327,616 |
| 1440 view1 | 约 0.40 | 0.054 | 0.0026 | 323,520 |
| 1440 view2 | 约 0.40 | 0.065 | 0.0026 | 415,424 |

投影计时包含清理 key 与候选投影两个 pass。约 **86–89%** 的点跳过精确投影，
但仍需检查块标志。无索引路径六组墙钟 p50 约 3.1–3.6 ms，新路径约 3.0–3.8 ms，
并没有与投影同倍率的整帧提速；还存在排序、绘制、浏览器和驱动调度开销。
按空间顺序布局但关闭剔除的路径本身更慢，不能仅与它比较后宣传加速倍数。

开发中曾先只增加空间索引而保留零散属性访问、全量清空投影结构，实测投影反而变慢。
最终让 GPU 属性与投影按块连续访问，并只清理 key，才获得净投影收益。
普通 GS 模型近乎全部可见时，索引开销可能超过收益；提供关闭整个空间布局的参考模式。
GPU 大型号以外的收益、长轨迹 p95/p99 尚需更多真机验证。

### 内存与加载成本

3M 点共 11,719 块，新增 GPU 索引/包围数据/标志 **12,421,884 bytes**，
约 12.42 MB。模型 buffer 从约 553.38 MB 增至 **565.80 MB**。
没有增加完整 GPU 属性副本，也没有重新展开 packed SH。
CPU 构建需 count 个 code、两个 count 个 ID scratch 数组，约 **36 MB** 加块 bounds 临时内存；
其中最终索引在上传完成后可释放。复制到映射 GPU 属性区时逐行重排，不额外分配完整属性数组。

本次索引构建约 **391 ms**；GPU buffer 创建/属性重排/上传约 **411 ms**，
另有校验与 SH 准备。当前构建在 `setModel()` 所在线程，通常是主线程，会增加首屏等待，
未把它转移到 Worker。不能把减少每帧工作量说成同时优化了加载速度。

## 精度与回归

六组完整 3DGS 图像：剔除开关的 RGBA8 最大误差 **0**，可见点数相同，
哈希与之前已提交的空间/时间重建报告中的 **排序基线** 一致。
GPU 测试另外覆盖四种滤波、两种投影、三种尺度倍率、compact 开关、
偏心主点、非平凡外参、大而细长高斯、跨 near、部分块、全不可见、
相机转向后的旧状态、SH 对应关系、同深度透明混合顺序与拾取。
索引单元测试检查覆盖所有原 ID、输入数组不变和包围范围。

`npm test`：31 项通过；`npm run test:gpu` 和 `npm run test:sog` 通过。
原始数据见 [机器记录](benchmarks/1023-spatial-blocks.json)。

## API 与复现

```js
await renderer.setModel(model); // auto：N >= 4096 构建空间布局，否则使用原布局
renderer.render(camera); // 支持的 GS 相机默认开启保守块剔除
renderer.render(camera,{blockCulling:false}); // 布局不变，只关闭块剔除
await renderer.setModel(model,{spatialBlocks:false}); // 关闭整个索引/空间布局，原始参考路径
await renderer.setModel(model,{spatialBlocks:true}); // 小夹具强制建块
await renderer.readBlockVisibility(); // 显式 readback 诊断，不参与正常帧循环
await renderer.readTimings(); // 新增 block_ms；project_ms 包含 key 清理
```

```powershell
node scripts/benchmark-blocks.mjs --output test-results/blocks-final.json
```

支持 `--model` / `--manifest` / `--output`。默认相机清单来自已有 1023 比较夹具。
逻辑 ID 保持不变，但内部 GPU 物理槽位已重排；不能把 `state.keys[].y` 当作外部原始 ID。
随机采样的 hash 使用物理槽位，因此新旧布局固定 seed 的噪点排列可能不同；
完整排序输出与拾取语义不受此影响。
