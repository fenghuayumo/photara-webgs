# Gaussian Splat Lite neural denoiser

Source: https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite

Pinned revision: `03914d2da079360d03293bcc4e1819a797b523af` (package 1.8.1).
Original files: `src/addons/neuralDenoise{Passes,Shaders,Weights}.js`.
Copyright 2026 William Liu. Distributed under Apache-2.0; see LICENSE and NOTICE.
Upstream third-party notices are retained in THIRD_PARTY_LICENSES.md.

Photara changes:

- `neuralDenoisePasses.js`: optional GPU timestamps on the caller's command encoder.
- `neuralDenoiseShaders.js`: extend uniforms with an independent frame seed for
  half-float rounding without projection jitter; clamp block bounds for tiny viewports.
- `neuralDenoiseWeights.js`: original pretrained weights, unchanged.

The adapter in `../../neural.js` uses the native GPU passes, not Three.js scene
capture. It adapts CV camera coordinates, the source's integer pixel centres,
and Photara's reversed depth. It does not add MSAA, capture margins or camera
jitter. Network inputs remain display-referred, matching Photara's existing
display output. This is an experimental transfer; it is not identical to the
upstream viewer and does not claim the upstream's image quality or performance.
