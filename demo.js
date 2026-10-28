import './src/index.js';
const viewer = document.querySelector('#viewer');
const status = document.querySelector('#tool-status');
const capture = document.querySelector('#capture');
viewer.addEventListener('model-load', () => { capture.disabled = false; status.textContent = ''; });
document.querySelector('#open-camera').addEventListener('click', () => document.querySelector('#camera').click());
document.querySelector('#generate').addEventListener('click', () => {
  viewer.viewer.loadDemo({ renderMethod: document.querySelector('#method').value }).catch(error => { status.textContent = error.message; });
});
document.querySelector('#camera').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try {
    const camera = JSON.parse(await file.text()); viewer.setCamera(camera); status.textContent = '已应用指定相机。点击重置视角可恢复自由探索。';
  } catch (error) { status.textContent = `相机导入失败：${error.message}`; }
});
capture.addEventListener('click', async () => {
  capture.disabled = true;
  try {
    const renderer = viewer.viewer.renderer;
    const pixels = await renderer.readPixels();
    const canvas = document.createElement('canvas'); canvas.width = renderer.width; canvas.height = renderer.height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), canvas.width, canvas.height), 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'photara-webgs.png'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { status.textContent = error.message; }
  finally { capture.disabled = false; }
});
