# Neural Lite 质量降噪

2026-11-12。交互加速默认使用 Neural Lite 质量版（`neural`），去噪菜单保留 SVGF + TAA，
也可选择原 temporal / spatial / none 作对照。渲染模式仍默认完整排序，停止移动后恢复排序，
截图默认继续精确输出。底层 renderer 的降噪仍需显式选择。

## 独立实现与训练

参考 Hu 等人的 [Ultra-fast Neural Inference for Stochastic Gaussian Splatting Denoising](https://arxiv.org/abs/2609.25604)
中双路时间累积、方差融合与稳定化的思路。这不是论文完整复现：论文主要学习历史可信度；
我们的小网络学习空间滤波核，历史置信度使用确定性深度与颜色检查。

运行时是项目自己的 WGSL compute shader、GPU 资源管理及训练脚本。
16 输入 → 24 个 SiLU 隐藏单元 → 10 输出，共 658 个参数，FP32 权重约 2.6 KB。
输入是 3×3 亮度、中心 RGB、较大范围颜色均值和局部方差；输出九个 softmax 邻域权重
及与大范围均值混合的比例。只对观察到的颜色作凸组合，不直接生成 RGB。

权重从零训练，不加载其他项目的代码或预训练参数。训练数据由本地模型通过本项目渲染器产生的
随机帧／排序帧对，加上程序生成的透明覆盖、软边和细线样本组成。
当前只使用一个本地场景，两个相机视角训练，第三个视角留出验证。
72,000 个实景训练 patch、36,000 个验证 patch，4000 步 Adam 优化，种子 82731。
验证单像素空间 MAE 为 5.44/255，原始随机输入为 19.04/255；这不是端到端运动指标。
模型文件包含数据摘要，PNG 数据不纳入 Git。训练脚本依赖 PyTorch、NumPy、Pillow。
单场景训练不代表对未见场景、其他分辨率或 Gaussian 分布均有同等效果。

## 管线

1. 网络预测小范围空间核，再按局部方差进行一轮较大范围残余噪声过滤。
2. 以 3×3 第三近命中深度作重投影假设；不足三次命中时借用局部平均命中深度。
3. 逐 bilinear tap 作 15% 相对深度检查，有效支持必须超过 25%。
4. 原始样本与亮度矩用 Float32 纹理累积，最多 64 个有效样本。按实际混合权重更新有效
   样本数，避免把被拒绝的历史误算成额外采样。该数量仍是启发式近似，未完整建模样本相关性。
5. 方差和历史长度选择原始累积与神经空间结果，再用受邻域约束的显示历史稳定输出。
   显示历史不反馈进原始颜色和矩，避免反复累积模糊。

适配本项目原生 CV 相机与整数像素采样，GS/GUT 的针孔、正交、鱼眼和全景共用实现，
全景支持水平周期寻址。模型、内参、near、尺寸、方法、背景或模式变化会拒绝旧历史；
相机跳切也可用 `resetHistory:true`。本次修正了 near 改变没有重置历史的问题。
不增加相机 jitter，不做 CPU 逐帧回读。

重建纹理共 100 bytes/pixel：960×540 约 51.84 MB，1920×1080 约 207.36 MB，
不含原有颜色、随机深度、截图及射线纹理。切换模式会缓存资源；resize/dispose 释放纹理。
只使用神经模式不会分配旧 spatial/temporal 的纹理。内存统计包含权重和纹理，
`readTimings().neural_ms` 覆盖三个计算 pass。

## 本机运动测量

300 万点，NVIDIA Blackwell / Edge 157，960 宽，三条针孔短轨迹。
每模式 8 帧预热 + 24 帧采样，计时和质量分开。

| 轨迹 | 原始随机 MAE | SVGF MAE / 边缘 MAE | 自研 Neural MAE / 边缘 MAE |
| --- | ---: | ---: | ---: |
| view0 | 19.607 | 3.903 / 16.812 | 4.269 / 16.539 |
| view1 | 20.354 | 3.720 / 13.275 | 3.548 / 10.013 |
| view2 | 16.740 | 2.483 / 10.652 | 3.412 / 8.622 |

MAE 是相对排序图的 RGB 平均字节误差，包含噪声、偏差与模糊。神经模式边缘误差均较低，
但整体 MAE 仅 view1 优于 SVGF，不能宣称全面更优。仍有噪点、软化与潜在拖影。
旧版模型的测试数值不适用于本实现。[机器记录](benchmarks/neural-denoising.json)包含详细结果。
合成细线中心对比度为排序参考的 63.1%，遮挡露出夹具旧红色最大残留 2/255。

验证包含独立 CPU 网络推理对照、边界像素、八组 GS/GUT × 四镜头的噪声与历史重置、
模式切换、精确截图、细线及遮挡露出夹具。合成测试不证明任意场景均无拖影。

```js
element.setRenderingMode('movement'); // 默认神经降噪
element.setReconstructionMode('svgf');
element.setReconstructionMode('neural');
renderer.render(camera, {transparency:'stochastic', reconstruction:'neural'});
```

```powershell
node scripts/export-neural-training.mjs --width 960 --output test-results/neural-training960
python scripts/train-neural.py --data test-results/neural-training960 --steps 4000
npm test
npm run test:gpu
npm run build
node scripts/benchmark-reconstruction.mjs --methods 3dgs --widths 960 --views 3 --frames 24 --output test-results/neural-own-final
```

对比拼图依次为 sorted、none、spatial、temporal、svgf、neural。
