# 1023 SOG：GPU 内存优化

2026-11-02，RTX 5090 D v2 / Edge WebGPU。本轮仅修改 WebGS，未同步 TEZOI。
使用同一完整 300 万 Gaussian、SH degree 3 的 `splat.sog`，延续前一轮 GUT 覆盖范围
和 GPU 可见点压缩。没有减少 Gaussian、降低 SH 阶数或使用 Float16。

## 缓冲区占用

以下为应用创建的模型 GPU buffer 请求字节数，MB 为十进制；不是驱动报告的整进程显存。
不包括 CPU 数组、swapchain、浏览器/驱动分配以及帧输出纹理。

| 内容 | 修改前 MB | 修改后 MB |
| --- | ---: | ---: |
| Gaussian 属性 | 144.0 | 144.0 |
| SH | 576.0 | 59.8 |
| 投影结果 | 336.0 | 288.0 |
| 排序、索引与其他模型缓冲区 | 61.6 | 61.6 |
| 合计 | **1,117.6** | **553.4** |

精确合计为 1,117,595,928 → 553,382,148 bytes，减少约 50.5%。

## 存储方法与精度

SOG 原本就用调色板存储高阶 SH。本轮保留解码后的 Float32 调色板和每个 Gaussian 的
标签，在 GPU 上按索引读取高阶项，DC 保留逐点 Float32。此场景调色板含 65,479 个条目；
GPU 存储布局为 `[3N 个 DC Float32][N 个 uint 标签][palette Float32]`。
这仅消除重复存储，不增加原 SOG 量化以外的误差。

canonical `model.sh` 仍是兼容既有 API 的完整 Float32 数组。renderer 上传前逐项核对
调色板能否精确还原它；调用者编辑 SH、标签无效或使用调色板反而更大时，自动使用普通
Float32 buffer。可用 `setModel(model, {shStorage:'float32'})` 显式选择参考路径。
没有调色板的普通 PLY 仍使用 Float32 SH，但同样获得投影结构的节省。

投影结构由 112 缩到 96 bytes/Gaussian：3DGS 的 conic yy 复用其未使用的 row0.x；
有效性直接由已存在的 opacity 表示。GUT 的三个 inverse-transform 行继续使用 Float32，
避免极薄 Gaussian 的数值精度变化。所有方法共用布局，可逐帧切换。

## 实景结果

同一数据集的首/中/末 COLMAP 外参，虚拟 pinhole 相机，`3dgut + mip2d`。
每组预热三帧后九帧，记录提交至 GPU 完成的墙钟中位数；不包含加载和截图。
两次单独运行会受到系统调度和负载影响，因此不把墙钟差异视为严格加速/回退比例。

| 视角 | 修改前 ms | 修改后 ms | RGBA8 最大字节差 |
| --- | ---: | ---: | ---: |
| 960-view0-pinhole | 3.7 | 4.5 | 0 |
| 960-view1-pinhole | 4.9 | 4.4 | 0 |
| 960-view2-pinhole | 3.8 | 4.0 | 0 |
| 1440-view0-pinhole | 4.8 | 5.0 | 0 |
| 1440-view1-pinhole | 3.9 | 5.0 | 0 |
| 1440-view2-pinhole | 5.0 | 5.0 | 0 |

六组完整截图与修改前保留的渲染器结果逐字节一致，MAE=0。
GPU projection 中位数从约 0.45–0.48 ms 变为 0.42–0.43 ms；排序和绘制没有明显回退。
场景加载/解析/上传墙钟本次约 6.3 → 6.5 秒，不是网络下载性能测试。
原始计时及 buffer bytes 见 [机器记录](benchmarks/1023-memory-optimization.json)。

## 检查与边界

- `npm test`：21 项通过，包括所有 Float32 系数的精确还原与 canonical 编辑后的回退。
- `npm run test:sog`：真实 WebP/PNG、worker 调色板传输，以及两种方法 × 四种相机的
  Float32/调色板逐字节图像对比通过。fixture 高阶 SH 为非零，覆盖 palette 第二行。
- `npm run test:gpu`：31 项 GPU 核心与 4 项 UI 回归通过，验证新的投影结构。

CPU 仍保留展开后的模型 SH，并新增约 23.8 MB 的标签/调色板元数据；本轮没有优化 CPU
峰值内存。兼容 canonical 编辑的核对过程仍需扫描展开数据。
设备还需要容纳 288,000,000-byte 的单个投影 buffer，因此不代表已经能在所有手机或
256 MiB 单缓冲区上限的 GPU 上运行。SOG 压缩下载大小不变。

`renderer.getMemoryUsage()` 可获取模型缓冲区、uniform/timestamp buffer 和本 renderer
拥有纹理的请求字节数；不强制 GPU readback，不包含 timestamp query 对象或驱动开销。

## 复现

沿用前一轮 `test-results/optimization/manifest.json` 相机清单：

```powershell
node scripts/benchmark-optimization.mjs --label memory-auto
node scripts/benchmark-optimization.mjs --label memory-float32 --float32-sh
```

`--float32-sh` 只关闭调色板路径，仍使用新的 96-byte 投影结构。
本机完整旧版快照在被 Git 忽略的 `test-results/memory-baseline/src/`：

```powershell
node scripts/benchmark-optimization.mjs --baseline --baseline-dir test-results/memory-baseline --label memory-before
node scripts/benchmark-optimization.mjs --label memory-after --reference memory-before
```
