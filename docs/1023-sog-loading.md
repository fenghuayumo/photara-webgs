# 1023 SOG：紧凑 CPU 加载

2026-11-02。完整 3,000,000 Gaussian、SH degree 3、65,479 项调色板，
49,837,148-byte 的本地 `splat.sog`。RTX 5090 D v2 / Edge 156 WebGPU。
本次仅修改 WebGS，未同步 TEZOI。

## 实现与兼容性

查看器 `load()` 默认指定 `shLayout:'packed'`。解码直接生成 `shDC`、标签和
Float32 调色板，不分配完整 `[N, bases, RGB]` 的 SH。Worker 将这些 ArrayBuffer
以 transfer list 转移给主线程。上传直接将三个源数组写入映射后的 GPU buffer，
不再分配拼接用的 CPU SH 临时数组；GPU 布局和 shader 不变。

直接调用 `parseSog()`、`decodeSogPlanes()`、`ModelLoader.parse()` 默认仍返回
canonical `model.sh`，不会用隐藏 getter 或缩短的数组改变 API 语义。
紧凑模型明确标记 `shLayout:'packed'`，不同时保留 `model.sh`；上传前校验 DC、
标签范围、调色板尺寸和有限值。编辑 packed 的三个数组会作用于后续上传。

`toCanonicalModel(packed)` 显式分配完整 SH，属性和调色板元数据仍共享；
返回的完整 SH 为权威数据，其高阶项被编辑后，已有调色板核对会使上传回退到 Float32。
`setModel(packed,{shStorage:'float32'})` 也是显式展开路径。
packed 的 `auto` 始终保留调色板，不因极小场景调色板更大而隐式展开。
degree 0 直接使用 DC，不生成标签或高阶调色板。PLY 加载行为不变。

## CPU 数组与上传临时内存

MB 为十进制。以下是 typed array 的精确字节数，不是进程内存。

| 内容 | canonical MB | packed MB |
| --- | ---: | ---: |
| Gaussian 属性 | 144.0 | 144.0 |
| 完整 SH | 576.0 | 0 |
| 独立 DC | 0 | 36.0 |
| 标签与调色板 | 23.786 | 23.786 |
| 模型 / Worker 传输数组合计 | **743.786** | **203.786** |
| 上传 SH 拼接临时数组 | 59.786 | **0** |

消除完整 576 MB SH 后，由 36 MB 独立 DC 替代其中的 DC 部分，模型数组净减
540,000,000 bytes（72.6%）。GPU 模型缓冲区仍为 **553,382,148 bytes**，
与此前 GPU 调色板版本相同。映射 GPU buffer 及驱动上传分配没有计入“CPU 拼接临时数组”。

## 同版本交替对照

使用同一工作区源码，依次 canonical → packed → packed → canonical，
每次新建页面、Worker 与 renderer，加载完成后验证六个完整视角。
这比较兼容路径与紧凑路径，不是旧 commit 的完整性能复刻。

通过 CDP 每 25 ms 请求主线程与 Worker isolate 的 `Runtime.getHeapUsage`，
只统计 fetch / worker / upload 阶段，排除截图 readback。
采样到的 backing-store 峰值如下：

| isolate | canonical MB | packed MB |
| --- | ---: | ---: |
| 主线程 | 803.614 | 203.828 |
| Worker | 869.620 | 329.620 |

这是 V8 管理的 ArrayBuffer 等 backing store 的采样峰值下界；
不是进程 RSS，不包括 WebP 解码器、WebGL 图片纹理、GPU 映射内存、浏览器/驱动原生分配。
两个 isolate 的独立峰值不能直接相加视为同时刻进程峰值。
Worker 仍同时持有约 49.8 MB 输入包和 76.0 MB 解码图像，本轮未做流式图片属性解码。

| 阶段 | canonical 秒（两次范围） | packed 秒（两次范围） |
| --- | ---: | ---: |
| 图像读取与解码 | 1.120–1.192 | 1.207–1.514 |
| 数值解码 | 0.914–1.233 | 0.685–0.707 |
| Worker 校验与 bounds | 1.876–2.033 | 0.642–0.648 |
| 主线程模型校验 | 1.458–2.498 | 0.600–0.608 |
| SH 上传准备 | 0.153–0.158 | 0.099–0.101 |
| GPU buffer 创建/上传及错误域收尾 | 0.149–0.180 | 0.154–0.166 |
| 本地 HTTP fetch 至 setModel 完成 | **6.333–6.860** | **3.539–3.890** |

未测外网下载，采样、浏览器 JIT、系统调度都会影响耗时。
图像解码没有因此变快；主要减少的是重复 SH 的展开、遍历和主线程拼接。
计时不是 GPU 帧率，也不是任意模型的加速承诺。

## 画质与回归

每次加载后以相同 `3dgut + mip2d` 输出首/中/末三组相机，
960×540、1440×810，共六张完整 RGBA8。
四次运行中每张图 SHA-256 完全相同。没有抽点、降 SH 阶数、Float16 或新增量化。

- `npm test`：29 项通过，含 degree 0–3 精确展开、分配回归、损坏 packed 数据、
  可编辑来源及分段上传字节一致性。
- `npm run test:sog`：8 组检查通过，含真实 PNG/WebP、STORE/DEFLATE/非打包目录、
  Worker/取消、查看器默认路径，以及两种方法 × 四种相机的完整 SH/调色板/packed 图像对照。
- `npm run test:gpu`：32 项 GPU 检查及 7 项 UI 检查通过。

原始逐阶段时间、采样与图像哈希见 [机器记录](benchmarks/1023-sog-loading.json)。

## 复现

使用已有 `test-results/optimization/manifest.json`，可从前一轮比较脚本生成。

```powershell
node scripts/benchmark-sog-loading.mjs --runs 2
# 可覆盖模型、相机清单和输出路径：
node scripts/benchmark-sog-loading.mjs --model 'D:/path/scene.sog' --manifest 'path/manifest.json' --output test-results/sog-loading.json
```

剩余优先项是 GPU 分页兼容、真实连续相机轨迹分析和块级剔除。
288 MB 的单个投影 buffer 限制仍然存在。
