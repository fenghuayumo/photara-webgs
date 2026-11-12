# Neural Lite 与 SVGF 可切换实验

2026-11-12。交互加速的“去噪”菜单支持 SVGF + TAA、Neural Lite 性能、Neural Lite 质量，
并保留原 temporal / spatial / none 对照。默认仍为 temporal。停止后恢复完整排序。

Neural Lite 使用 Gaussian-Splat-Lite 的原生 WebGPU passes 和内置训练权重，
固定到提交 `03914d2da079360d03293bcc4e1819a797b523af`（1.8.1），无需训练或在线下载。
它包含学习的历史可信度预测、双时间累积路径及最终稳定；质量版另使用学习的多尺度空间滤波，
性能版使用较便宜的局部滤波。上游源码、Apache-2.0 许可、NOTICE 与修改说明保存在
`src/vendor/gaussian-splat-lite/`，构建随 src 一起打包。

## 使用与适配边界

```js
element.setRenderingMode('movement');
element.setReconstructionMode('svgf');
element.setReconstructionMode('neural-performance');
element.setReconstructionMode('neural'); // 质量版

renderer.render(camera, {
  transparency:'stochastic', reconstruction:'neural',
  resetHistory:false, // 相机跳切时设为 true
});
```

同一 GPUDevice、同一 command encoder 执行，运动帧不做 CPU 像素回读，不依赖 Three.js。
适配 CV 相机到上游 GL view convention，包含非中心主点、整数像素与 texel centre 的半像素偏移；
深度按 `near/(near+Z)` 反解，正交也使用这一深度约定。原有展示颜色直接输入网络，
不额外做 sRGB transfer 或 tone mapping。现阶段不添加投影 jitter、捕获 margin 或 MSAA；
随机源仍是本项目分层采样。因此这是模型迁移试验，不是上游 viewer 的完整复刻。

支持 3DGS / 3DGUT 的 pinhole 与 orthographic；鱼眼和全景随机帧显式报错，
不静默使用错误的针孔重投影。查看器手动漫游使用针孔，标定相机继续完整排序。
切换 SVGF、神经 profile 或其他模式，以及模型、输出尺寸、内参、背景等改变，均拒绝旧历史。
两种神经 profile 互相切换会释放旧 profile 资源，再构建新管线；首次启用存在编译开销。
同尺寸切到 SVGF 会缓存神经资源供切回；resize/dispose 释放纹理，内存统计包含网络 scratch、
两个累积路径及输出。`readTimings().neural_ms` 统计神经管线 GPU 区间。

## 本机实测

300 万点 1023 SOG，NVIDIA Blackwell / Edge 157，960 宽针孔相机，三条短运动轨迹。
每模式连续 8 帧预热 + 24 帧测量；质量回读与计时分开。MAE 是相对同姿态排序图的
RGB 平均字节误差，同时包含噪声、偏差与模糊；边缘 MAE 按排序图梯度选区。

| 轨迹 | SVGF MAE / 边缘 MAE | Neural 性能 | Neural 质量 |
| --- | ---: | ---: | ---: |
| view0 | 3.903 / 16.812 | 4.282 / 12.324 | 3.321 / 11.916 |
| view1 | 3.720 / 13.275 | 3.906 / 8.622 | 3.106 / 7.975 |
| view2 | 2.483 / 10.652 | 3.337 / 8.269 | 2.555 / 7.630 |

神经质量版在前两条轨迹整体误差较低，第三条略高；两种神经模式的边缘误差均比 SVGF 低。
性能版的整体 MAE 均高于 SVGF，不能宣称神经模式全面更优。实景仍可能有噪点和拖影。
完整样本汇总见 [机器记录](benchmarks/neural-denoising.json)。短轨迹高端 GPU 结果不能
代表手机、长时间运动或其他场景，墙钟时间接近不能用来断言没有性能成本。

合成细线中心对比度：SVGF 60.3%，Neural 性能 92.5%，Neural 质量 94.4%；
移动遮挡露出夹具的旧红色最大残留分别为 3/255、2/255、4/255。
合成夹具仅验证指定情形，不证明所有透明层均无拖影。
八组 GS/GUT × 针孔/正交 × 神经 profile 测试验证噪声下降、重置、尺寸和模式切换及精确截图。
另有 CPU 相机矩阵测试、GPU/UI 测试和完整静态构建验证。

```powershell
npm test
npm run test:gpu
npm run build
node scripts/benchmark-reconstruction.mjs --methods 3dgs --widths 960 --views 3 --frames 24 --output test-results/neural-final
```

对比拼图从左到右、从上到下：sorted、none、spatial、temporal、svgf、neural-performance、neural。
