/** Browsers expose the user's system/browser language preferences here. */
export function detectLanguage(languages = globalThis.navigator?.languages, fallback = globalThis.navigator?.language) {
  const primary = languages?.[0] || fallback || 'en';
  return /^zh(?:-|$)/i.test(primary) ? 'zh-CN' : 'en';
}
const storageKey = 'photara-language';
const choices = ['auto', 'zh-CN', 'en'];
let saved;
try { saved = globalThis.localStorage?.getItem(storageKey); } catch {}
export let languagePreference = choices.includes(saved) ? saved : 'auto';
export let language = languagePreference === 'auto' ? detectLanguage() : languagePreference;
const listeners = new Set();
export function onLanguageChange(callback, { signal } = {}) {
  if (signal?.aborted) return;
  listeners.add(callback);
  signal?.addEventListener('abort', () => listeners.delete(callback), { once: true });
}
export function setLanguage(preference) {
  if (!choices.includes(preference)) throw new Error('Unknown language preference');
  languagePreference = preference;
  language = preference === 'auto' ? detectLanguage() : preference;
  try { globalThis.localStorage?.setItem(storageKey, preference); } catch {}
  for (const callback of listeners) callback();
}
globalThis.addEventListener?.('languagechange', () => {
  if (languagePreference === 'auto') setLanguage('auto');
});

const english = {
  '语言': 'Language', '自动': 'Auto', '语言选择': 'Language selection', '中文': 'Chinese', '英文': 'English',
  '隐藏设置': 'Hide settings', '显示设置': 'Show settings',
  '全屏查看': 'Fullscreen', '退出全屏': 'Exit fullscreen', '退出全屏 · Esc': 'Exit fullscreen · Esc',
  '重置视角': 'Reset view', '重置视角 · R': 'Reset view · R',
  '从重建，到自由探索。': 'From reconstruction to exploration.',
  '打开 PLY 或 SOG 模型，或先探索合成示例。': 'Open a PLY or SOG model, or explore the demo.',
  '探索示例': 'Explore demo', '打开 PLY / SOG': 'Open PLY / SOG', '合成示例': 'Demo scene',
  '模型信息': 'Model information', '尚未加载模型': 'No model loaded',
  '相机控制': 'Camera controls', '相机模式': 'Camera mode', '转台': 'Orbit', '自由漫游': 'Fly',
  '控制 WASD、Q/E 和漫游滚轮的移动速度': 'Movement speed for WASD, Q/E and the fly-mode scroll wheel',
  '漫游速度': 'Fly speed', '漫游移动速度': 'Fly movement speed', '0.25 倍': '0.25×',
  'V 切换模式': 'V to switch modes', '渲染': 'Rendering', '渲染质量模式': 'Rendering quality',
  '完整画质': 'Full quality', '交互加速（移动时有噪点）': 'Interactive (noise while moving)',
  '去噪': 'Denoising', '随机渲染去噪': 'Stochastic rendering denoising',
  '空间 + 时间重投影': 'Spatial + temporal', '仅空间重建': 'Spatial only', '关闭（原始采样）': 'Off (raw samples)',
  '拖动旋转 · 滚轮缩放 · 右键平移 · 双击聚焦': 'Drag to orbit · Scroll to zoom · Right-drag to pan · Double-click to focus',
  '文件在本机解析，不会上传。': 'Files are processed locally and never uploaded.',
  '标定相机 · 重置视角后恢复交互': 'Calibrated camera · Reset view to resume navigation',
  '拖动环视 · WASD 移动 · Q/E 升降 · 滚轮前后 · Shift 加速 / Alt 慢速 · 双击回到转台': 'Drag to look · WASD to move · Q/E up/down · Scroll forward/back · Shift faster / Alt slower · Double-click for orbit',
  '拖动旋转 · 滚轮缩放 · 右键平移 · 双击平滑聚焦 · WASD 进入漫游': 'Drag to orbit · Scroll to zoom · Right-drag to pan · Double-click to focus · WASD to fly',
  '正在加载 Gaussian 场景…': 'Loading Gaussian scene…',
  '3D 射线响应 · 保留模型原始坐标': '3D ray response · Original model coordinates',
  '保留模型原始坐标 · 文件不会上传': 'Original coordinates · Files stay on your device',
  '模型文件超过加载大小限制。': 'The model file exceeds the loading size limit.',
  '随机预览 · 停止后恢复画质': 'Stochastic preview · Full quality when still',
  '合成 Gaussian 示例': 'Gaussian demo scene',
  '需要支持 WebGPU 的浏览器，并通过 HTTPS 或 localhost 打开。': 'Use a WebGPU-capable browser over HTTPS or localhost.',
  '当前设备没有可用的 WebGPU 适配器。': 'No WebGPU adapter is available on this device.',
  'Canvas 无法创建 WebGPU 上下文。': 'Could not create a WebGPU canvas context.',
  'Photara WebGS 首页': 'Photara WebGS home', '嵌入示例': 'Embed example',
  '空间，换一个视角。': 'Space, from a new perspective.',
  '将 Gaussian 重建带入浏览器。': 'Bring Gaussian reconstructions to your browser.',
  '保留原始坐标，自由探索每个细节。': 'Keep original coordinates. Explore every detail.',
  '预览配置': 'Preview settings', '预览工具': 'Preview tools',
  'PLY 自动识别模型与滤波模式': 'PLY model and filter modes are detected automatically',
  '加载示例': 'Load demo', '导入相机 JSON': 'Import camera JSON', '保存画面': 'Save image',
  '展示说明': 'About the viewer', '直接探索': 'Explore directly',
  '打开或拖入 Gaussian PLY。旋转、平移、缩放，查看重建空间。': 'Open or drop a Gaussian PLY. Orbit, pan and zoom to explore the reconstructed space.',
  '延续重建约定': 'Photara conventions',
  '读取模型类型与滤波元数据，也可导入相机参数复现指定视角。': 'Read model and filter metadata, or import camera parameters to reproduce a specific view.',
  '放进你的网站': 'Embed in your website',
  '独立组件，按需加载。为后续场景展示保留简单的接入方式。': 'An independent component loaded on demand, ready to integrate into your scene showcase.',
  'Photara WebGS：在浏览器中交互探索 Gaussian 重建模型。': 'Photara WebGS: interactively explore Gaussian reconstructions in your browser.',
  '独立嵌入示例。此处展示合成 Gaussian，可通过打开 PLY 替换为 Photara 重建。': 'Standalone embed example. Open a PLY to replace the Gaussian demo with a Photara reconstruction.',
  '← 返回预览': '← Back to viewer',
  '已应用指定相机。点击重置视角可恢复自由探索。': 'Camera applied. Reset the view to resume free exploration.',
  '无法切换全屏：{error}': 'Could not switch fullscreen: {error}',
  '相机导入失败：{error}': 'Camera import failed: {error}',
  '模型加载失败：HTTP {status}': 'Model loading failed: HTTP {status}',
  '模型超出此设备单个 GPU buffer 的限制（{size} MiB）。': 'The model exceeds this device’s GPU buffer limit ({size} MiB).',
  'Gaussian 三维场景。{help}。V 切换模式，R 重置。': '3D Gaussian scene. {help}. V to switch modes, R to reset.',
};
const sources = new WeakMap();
const reverse = new Map(Object.entries(english).map(([zh, en]) => [en, zh]));
const boundControls = new WeakSet();

function translated(target, key, value) {
  let records = sources.get(target);
  if (!records) { records = new Map(); sources.set(target, records); }
  let record = records.get(key);
  if (!record || record.rendered !== value) {
    const text = value.trim(), source = english[text] ? text : reverse.get(text);
    if (!source) return value;
    record = { source, whitespace: value, text, rendered: value };
    records.set(key, record);
  }
  record.rendered = record.whitespace.replace(record.text, t(record.source));
  return record.rendered;
}

export function t(source, values = {}, locale = language) {
  const text = locale === 'zh-CN' ? source : (english[source] || source);
  return text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

/** Translate static text nodes and accessible labels without rewriting markup. */
export function localize(root) {
  const doc = root.ownerDocument || root;
  const walker = doc.createTreeWalker(root, 4);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (['SCRIPT', 'STYLE', 'PRE', 'CODE'].includes(node.parentElement?.tagName)) continue;
    // Model filenames are user data, not interface labels.
    if (node.parentElement?.matches('[data-name]')) continue;
    node.textContent = translated(node, 'text', node.textContent);
  }
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of ['aria-label', 'title', 'aria-valuetext', 'content']) {
      const source = element.getAttribute(attribute);
      if (source) element.setAttribute(attribute, translated(element, attribute, source));
    }
  }
  (root.documentElement || root.querySelector('.viewer'))?.setAttribute('lang', language);
  for (const control of root.querySelectorAll('[data-language]')) {
    control.value = language;
    if (!boundControls.has(control)) {
      control.addEventListener('change', () => setLanguage(control.value));
      boundControls.add(control);
    }
  }
}
