export { PlyLoader, ModelLoader } from './loader.js';
export { parseSog, decodeSogPlanes, readSogArchive } from './sog.js';
export { GaussianRenderer } from './renderer.js';
export { GaussianViewer } from './viewer.js';
export { parsePly } from './ply.js';
export { createDemoModel, activateGaussian, validateModel, toCanonicalModel } from './model.js';
export { lookAtCV, resizeCamera, cameraPosition, validateCamera, CAMERA_MODELS } from './camera.js';
import { GaussianViewer } from './viewer.js';

export class PhotaraViewerElement extends HTMLElement {
  static observedAttributes = ['src'];
  connectedCallback() {
    if (this.viewer) return;
    this.viewer = new GaussianViewer(this.shadowRoot || this.attachShadow({ mode: 'open' }), {
      onReady: renderer => this.dispatchEvent(new CustomEvent('viewer-ready', { detail: renderer })),
      onLoad: model => this.dispatchEvent(new CustomEvent('model-load', { detail: model })),
      onError: error => this.dispatchEvent(new CustomEvent('viewer-error', { detail: error })),
    });
    if (this.getAttribute('src')) this.viewer.load(this.getAttribute('src')).catch(() => {});
    else if (this.hasAttribute('demo')) this.viewer.loadDemo().catch(() => {});
  }
  attributeChangedCallback(name, previous, value) {
    if (name === 'src' && value && value !== previous && this.viewer) this.viewer.load(value).catch(() => {});
  }
  disconnectedCallback() { this.viewer?.dispose(); this.viewer = null; }
  load(source, options) { return this.viewer.load(source, options); }
  setCamera(camera) { this.viewer.setCamera(camera); }
  resetCamera() { this.viewer.resetCamera(); }
  setControlMode(mode) { this.viewer.setControlMode(mode); }
}
if (!customElements.get('photara-viewer')) customElements.define('photara-viewer', PhotaraViewerElement);
