# 实景渲染比较与 GUT 性能记录

## 2026-10-29：复核 Photara 0954fae

重新链接当前 `splat_drender_vulkan.lib`，运行 Studio 的 `splat_gut_forward_test.exe` 通过，并重跑同一模型、同一 24 组相机。Web 同步补齐了两项新边界语义：GUT 全景中心恰好在极点时保留有限支撑；鱼眼超出 theta<π/2 畸变域或逆投影导数无效时返回背景，避免地平线射线重复。新增两项独立 oracle GPU 检查；Web GPU 27 项和 4 项 UI 检查通过。

上次的全景重复混合最小复现现已通过：C++ 输出 `[143,36,71]`，与单次贡献预期一致。原来的 `[198,50,99]` 三次混合结果已不再出现。该结论只针对已验证的复现，不代表所有全景实景误差都解决。

| GUT 图像 | 上次 PSNR | 本次 PSNR | 上次 MAE → 本次 MAE（字节） |
| --- | ---: | ---: | ---: |
| view0 鱼眼 | 33.21 dB | 33.26 dB | 1.143 → 1.119 |
| view1 鱼眼 | 35.05 dB | 35.48 dB | 1.334 → 1.290 |
| view2 鱼眼 | 32.62 dB | 32.63 dB | 1.121 → 1.104 |
| view0 全景 | 23.09 dB | 23.17 dB | 6.317 → 5.739 |
| view1 全景 | 28.80 dB | 29.23 dB | 3.560 → 2.728 |
| view2 全景 | 23.00 dB | 23.02 dB | 6.097 → 5.896 |

3DGS 的 12 组误差、GUT 针孔和正交的误差均与上次相同。新修复有效，但旧 `chuan` PLY 的 GUT 实景仍未完全对齐。训练侧 ADC、轴比正则化需要重新训练才会改变模型参数，不能自动消除这个旧 PLY 的极端各向异性。其余误差的数值计算/候选覆盖占比仍未隔离。

本次输出保存在 `test-results/comparison-20261029/`（含上次指标对照），Web 原始帧在 `test-results/real-scene-20261029/`，C++ 原始帧及最小复现 JSON 在 `test-results/cpp-reference-20261029/`。上次记录保留在原目录。两次运行的 CPU/GPU 负载未控制为完全一致，因此不使用跨日期墙钟变化判断修复带来的性能回归。

生成本次报告：

```powershell
cmake --build test-results/cpp-build --config Release
test-results/cpp-build/Release/photara_web_reference.exe D:/ScanVideo/chuan/images.cache/splat.ply test-results/real-scene/manifest.json test-results/cpp-reference-20261029
test-results/cpp-build/Release/photara_web_reference.exe --panorama-probe | Set-Content test-results/cpp-reference-20261029/panorama-probe.json
node scripts/compare-scene.mjs --output test-results/real-scene-20261029 --samples 11
python scripts/analyze-comparison.py --web test-results/real-scene-20261029 --cpp test-results/cpp-reference-20261029 --output test-results/comparison-20261029 --reference-revision 0954fae --panorama-probe test-results/cpp-reference-20261029/panorama-probe.json --previous test-results/comparison/metrics.json
```

比较脚本现在默认使用系统分配的空闲 loopback 端口，避免与本机其他服务冲突；可通过 `--port`、`--asset-port` 指定端口。

## 2026-10-28：初始记录

2026-10-28，在 NVIDIA GeForce RTX 5090 D v2 上使用本机 Edge WebGPU，与 `D:/ProgramCode/C++/photara-studio` 的实际 Studio Vulkan viewport 库比较。C++ 工作树干净，源码提交 `1899b8d`。没有重写 C++ 渲染算法作为参考。

模型为 `D:/ScanVideo/chuan/images.cache/splat.ply`，218,075,248 字节、826,036 个 Gaussian。该文件没有声明 GUT，加载默认是 3DGS；对比中显式选择两种方法。模型的原始尺度、位置、SH 和滤波参数保持一致。

## 相机与输出

从 `D:/ScanVideo/chuan/sparse/0/cameras.txt`、`images.txt` 读取首、中、末三个已注册图像的外参。针孔保留原始标定内参并按输出分辨率缩放；其他相机共用外参，但使用 manifest 中显式定义的新内参。鱼眼是 theta 多项式 `[0.05,-0.01,0.002,0]`，横向焦距 `W/π`，不是原始数据集的标定鱼眼。

两种方法 × 四种相机 × 三个外参，共 24 组。针孔、正交、鱼眼是 960×540，全景是 960×480。共用黑色背景、完整 SH 和 near=0.01，截图为数值 RGB，不叠加 tone mapping。C++ 参考工具直接调用 `splat_render::Renderer::upload/draw/download_rgb`。

本机输出：

- `test-results/comparison/index.html`：逐图并排、8 倍绝对差分及叠加滑块。
- `test-results/comparison/metrics.json`：每图 MAE、RMSE、PSNR、最大误差、误差超过 8/255 的像素比例及耗时。
- `test-results/real-scene/manifest.json`：完整相机矩阵、内参和来源图像。
- `test-results/real-scene/timings.json`：Web 同步帧墙钟和 GPU 各 pass 的中位数。
- `test-results/cpp-reference/timings.json`：C++ 同步帧墙钟中位数。

## 图像对齐结果

3DGS 的 12 张图中，11 张 PSNR 为 58.56–61.12 dB，最大 RGB 字节误差 1–5；`view1-equirectangular` 为 39.51 dB，MAE=0.744/255，最大误差 23。

GUT 尚未完成图像对齐。针孔分别为 54.26、34.13、53.96 dB，鱼眼约 32.62–35.05 dB，全景约 23.00–28.80 dB，正交约 17.42–18.98 dB。这些差异必须保留在报告中，不能用合成 oracle 测试通过来宣称实景与 C++ 已一致。

已独立确认 C++ 全景重复混合问题：一个位于 `[0,0,-2]`、尺度 `[0.2,0.2,1]`、opacity=0.7 的 Gaussian，其 UT sigma point 穿过相机，触发宽覆盖；周期 tile 副本会重叠。在接缝中心，单个 Gaussian 的理论 RGB 字节值是 `[143,36,71]`，C++ 实际得到 `[198,50,99]`，与同一 Gaussian 混合三次一致。运行参考工具的 `--panorama-probe` 可复现。Web 保持每像素只接受一个周期副本。

另外，原始模型约 43,688 个 Gaussian 的长短轴比超过 1000，最大约 6.59×10¹⁰。GUT 的浮点局部射线最近点计算在极薄 Gaussian 上可能出现显著数值敏感性；C++ 的 UT/tile candidate 覆盖与 Web 的保守有限支撑范围也不同。两者对其余实景差异的占比尚未隔离，不能把所有误差归因于已确认的全景重复混合。

## 本轮优化

原实现对所有 GUT 鱼眼、全景 Gaussian 绘制全屏 quad，并对鱼眼的每次片元求值重复进行 28 次逆畸变二分。优化后：

1. 鱼眼通过有限 alpha 支撑椭球的切线斜率区间，保守界定畸变后的像素范围。畸变多项式按系数符号做区间界，支持混合正负系数。椭球无法安全界定时仍使用全屏覆盖。
2. 全景通过支撑包围球的经纬角域收紧覆盖，显式处理接缝、极点和穿过相机的支撑。
3. 相机空间射线使用 RGBA32Float 纹理缓存。分辨率、内参、相机模型或畸变变化时重建；仅改变外参时复用。线性相机只需要 1×1 占位纹理。
4. 增加可选 GPU timestamp-query，分别读取射线、投影、排序、绘制耗时；默认关闭。

## 性能结果

以下为完整 826,036 点模型、11 个计时样本（2 个预热）后的同步帧墙钟中位数。模型驻留显存，排除解析、上传、截图与 readback。C++ 每帧通过不可见的 near 数值微调绕过静态帧缓存；两端都等待 GPU 完成，仍包含各自提交及驱动开销。两端图像尚未完全一致，耗时不能单独代表相同质量下的后端胜负。

| 视角 | Web 鱼眼 960×540 | C++ 鱼眼 | Web 全景 960×480 | C++ 全景 |
| --- | ---: | ---: | ---: | ---: |
| view0 | 5.20 ms | 8.63 ms | 2.90 ms | 18.56 ms |
| view1 | 10.60 ms | 4.83 ms | 2.90 ms | 6.40 ms |
| view2 | 4.70 ms | 8.77 ms | 3.70 ms | 18.35 ms |

GPU timestamp 的鱼眼投影约 0.21–0.22 ms，排序约 0.31 ms，绘制约 3.02–8.47 ms；全景绘制约 1.31–1.34 ms。固定内参的预热后射线缓存不重建，`rays_ms=0`。帧墙钟包含 GPU pass 之间及提交等待，因此不能直接等同于各 pass 之和。剩余主要瓶颈是绘制/overdraw；view1 鱼眼仍慢于 C++。

优化前后另用完整模型、160×90 鱼眼/160×80 全景、9 个样本进行对照，避免原全屏实现高分辨率下产生极大的 GPU 工作量：

| 视角 | 鱼眼优化前 → 后 | 全景优化前 → 后 | 两张图最大字节差 |
| --- | ---: | ---: | ---: |
| view0 | 161.8 → 5.9 ms | 46.4 → 3.0 ms | 0 |
| view1 | 137.1 → 3.0 ms | 47.1 → 3.0 ms | 0 |
| view2 | 162.5 → 2.9 ms | 46.7 → 2.9 ms | 0 |

这是相同低分辨率、相同完整模型的比较，不是把优化前低分辨率耗时与优化后 960 宽耗时直接相除。低分辨率优化后墙钟已经明显受到浏览器提交等待影响，不能外推为所有场景的 GPU 加速倍数。六张前后截图均逐像素一致。

## 复现

需要现有 photara-studio Release 构建（`splat_render.lib`、`splat_drender_vulkan.lib`、`photara_vk.lib`）、MSVC、Vulkan SDK、nlohmann/json 头文件、Playwright，以及 Python 的 numpy/Pillow。参考 PLY 读取器仅接受本夹具所用的 binary little endian float 属性；不是替代生产 PLY loader。

```powershell
cmake -S scripts/cpp-reference -B test-results/cpp-build -DPHOTARA_ROOT=D:/ProgramCode/C++/photara-studio -DVulkan_INCLUDE_DIR=D:/ProgramTool/Vulkan1-4/Include -DVulkan_LIBRARY=D:/ProgramTool/Vulkan1-4/Lib/vulkan-1.lib
cmake --build test-results/cpp-build --config Release
node scripts/compare-scene.mjs --manifest-only --samples 11
test-results/cpp-build/Release/photara_web_reference.exe D:/ScanVideo/chuan/images.cache/splat.ply test-results/real-scene/manifest.json test-results/cpp-reference
node scripts/compare-scene.mjs --samples 11
python scripts/analyze-comparison.py
test-results/cpp-build/Release/photara_web_reference.exe --panorama-probe
```

比较脚本支持 `--model`、`--sparse`、`--output`、`--width`、`--views`、`--methods`、`--modes`、`--limit`、`--samples`。`--sparse` 当前读取 COLMAP TXT 的 SIMPLE_PINHOLE/PINHOLE 输入。

```powershell
node scripts/compare-scene.mjs --output test-results/full-baseline-small --baseline --baseline-ref f1a5fb9 --methods 3dgut --modes fisheye,equirectangular --views 3 --width 160 --samples 9
node scripts/compare-scene.mjs --output test-results/full-optimized-small --methods 3dgut --modes fisheye,equirectangular --views 3 --width 160 --samples 9
npm test
npm run test:gpu
```

基础测试 10 项通过，GPU 检查 25 项通过，另外 4 项 UI 检查通过。新增验证覆盖非线性 GUT 局部支撑、接缝、极点、相机内参/畸变变化后的缓存失效、仅外参变化时复用，以及可选 timestamp 查询。
