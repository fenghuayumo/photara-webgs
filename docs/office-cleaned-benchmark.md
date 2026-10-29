# splat_cleaned：完整 295.7 万点测试

2026-10-29，RTX 5090 D v2、本机 Edge WebGPU，对比 Photara Studio `0954fae` 的 Vulkan viewport 库。完整模型，没有抽点、删除或为了测试修改尺度。

模型：`D:/BaiduNetdiskDownload/VID_20260911_145523_00_007_dataset/outputs/VID_20260911_145523_00_007_dataset_20260912-230833/step-000030000.ckpt/splat_cleaned.ply`。

- 文件 697,956,846 字节，2,957,438 个 Gaussian，SH degree 3。
- PLY 没有 GUT 元数据，读取为 `3dgs` / `classic`。GUT 是显式切换后的测试，不代表该模型经过 GUT 训练。
- 读取、解析、上传和 GPU 等待约 11.3–12.2 秒，不包含初始 renderer/shader 创建。
- 使用 `sparse/0/cameras.bin`、`images.bin`；原始相机为 COLMAP 扩展模型 17 / EQUIRECTANGULAR，7680×3840。
- 选择首、中、末外参：`00014.jpg`、`02818.jpg`、`05623.jpg`。已目视核对全景和原始照片对应。
- 全景保留完整球面内参约定；针孔、鱼眼、正交共用外参，使用 manifest 中显式构建的虚拟内参，不是原始照片的相机类型。

## Web 性能

11 个计时样本、2 个预热，同步帧墙钟中位数；下面是三个外参中位数的范围。模型驻留显存，排除加载、上传、截图和 readback。固定相机持续重绘，并非真实交互 FPS 或动画轨迹测试。

| 分辨率 | 模式 | 针孔 | 鱼眼 | 全景 |
| --- | --- | ---: | ---: | ---: |
| 960×540 / 全景 960×480 | 3DGS | 4.9–6.0 ms | 4.8–5.7 ms | 7.5–9.5 ms |
| 960×540 / 全景 960×480 | GUT | 25.9–39.7 ms | 22.6–46.1 ms | 8.0–9.1 ms |
| 1920×1080 / 全景 1920×960 | 3DGS | 6.0–7.6 ms | 6.7–7.2 ms | 7.9–8.9 ms |
| 1920×1080 / 全景 1920×960 | GUT | 92.7–148.0 ms | 77.2–171.5 ms | 10.9–11.5 ms |

960×540 的正交额外测试：3DGS 4.8–5.9 ms，GUT 5.4–5.9 ms。正交 GUT 图像误差大，不能只按其快慢判断可用性。

1920 宽时，GUT 针孔和鱼眼绘制 pass 分别约 88.7–144.4 ms、73.1–167.9 ms；投影约 0.69–0.83 ms，排序约 1.02–1.04 ms。全景绘制约 7.36–7.70 ms。因此主要瓶颈是 GUT 片元计算及 overdraw，而非排序。不同运行间有提交/驱动及系统负载噪声，不能用墙钟中位数反推严格的分辨率缩放规律。

## Web / C++ 图像差异

960 宽共 24 组，1920 宽共 18 组，逐图记录 MAE、RMSE、PSNR、最大误差、误差大于 8/255 的像素比例及时间。

- 3DGS 针孔、鱼眼、正交在 960 宽达到 57.65–60.67 dB，最大字节误差 2–3；全景为 48.83–54.13 dB，最大误差 8–13。两端整体很接近。
- GUT 针孔、鱼眼、正交在 960 宽约 24.94–28.28 dB；全景约 30.99–32.88 dB。仍有明显差异。
- 1920 宽的 3DGS 全景约 48.63–54.42 dB，GUT 全景约 30.94–32.83 dB。提高分辨率没有消除实现差异。
- 这些指标只量化两端差异，**不是把 C++ 当作正确图像，也不能证明 Web 更差**。

模型的激活尺度采用两端已有的 log-scale clamp [-20,20]。按该尺度计算，1,615,236 个 Gaussian 的长短轴比超过 1000（约 54.6%），中位数约 1.27×10⁵。极薄几何会使 GUT 局部空间最近点计算非常敏感；两端的候选覆盖规则也不同。这两项对误差的占比尚未隔离。

## 原始照片参照

对三个原始全景照片进行整数坐标重采样，使用数据集提供的 mask（255 为参与像素），在边界收缩一个目标像素后统计 RGB 拟合。此项是已注册视角的诊断，不是独立验证集成绩，也不是数值渲染器正确性证明。

960 宽、GUT 对原始照片的拟合：

| 视角 | Web | C++ |
| --- | ---: | ---: |
| 00014.jpg | 26.68 dB | 25.62 dB |
| 02818.jpg | 20.38 dB | 19.79 dB |
| 05623.jpg | 13.26 dB | 13.21 dB |

3DGS 两端与原照的成绩几乎相同（差异约 0.01 dB）。三个视角的 GUT Web 分数均略高，但不能据此作普遍质量排名：原始 mask 漏掉部分伸到镜头前的手和手指，尤其最后一张，这些被 cleaned 模型删除的遮挡仍影响计分。报告提供原照、渲染和 mask，需结合具体区域观察。现有结果足以说明不能继续把 C++ 作为正确性真值。

## 输出与复现

- `test-results/office-cleaned-report.html`：两档分辨率的结果入口和结论。
- `test-results/office-cleaned-comparison/`：960 宽 24 组比较及原照参照。
- `test-results/office-cleaned-comparison-1920/`：1920 宽 18 组比较及原照参照。
- 对应的 `office-cleaned[-1920]/` 是 Web 原始帧、manifest 和 GPU 各 pass 耗时。
- 对应的 `office-cleaned-cpp[-1920]/` 是 C++ 原始帧及耗时。

```powershell
$officeModel = 'D:/BaiduNetdiskDownload/VID_20260911_145523_00_007_dataset/outputs/VID_20260911_145523_00_007_dataset_20260912-230833/step-000030000.ckpt/splat_cleaned.ply'
$officeSparse = 'D:/BaiduNetdiskDownload/VID_20260911_145523_00_007_dataset/sparse/0'
node scripts/compare-scene.mjs --model $officeModel --sparse $officeSparse --output test-results/office-cleaned --samples 11
test-results/cpp-build/Release/photara_web_reference.exe $officeModel test-results/office-cleaned/manifest.json test-results/office-cleaned-cpp
node scripts/compare-scene.mjs --model $officeModel --sparse $officeSparse --output test-results/office-cleaned-1920 --width 1920 --modes pinhole,fisheye,equirectangular --samples 11
test-results/cpp-build/Release/photara_web_reference.exe $officeModel test-results/office-cleaned-1920/manifest.json test-results/office-cleaned-cpp-1920
```

使用 `scripts/compare-source.py` 生成原照参照后，再运行 `scripts/analyze-comparison.py`，报告会自动纳入 `source-fit.json`。二进制相机读取增加了三项回归检查；`npm test` 共 13 项通过。完整场景两档分辨率、42 次视角组合均完成，没有 WebGPU 验证错误。
