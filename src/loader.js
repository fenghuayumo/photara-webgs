export class PlyLoader {
  constructor() { this.serial = 0; }
  cancel() {
    this.worker?.terminate(); this.worker = null;
    this.reject?.(new DOMException('Load cancelled', 'AbortError')); this.reject = null;
  }
  parse(buffer, options) {
    this.cancel();
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const worker = this.worker = new Worker(new URL('./ply-worker.js', import.meta.url), { type: 'module' });
      this.reject = reject;
      const done = () => { worker.terminate(); if (this.worker === worker) { this.worker = null; this.reject = null; } };
      worker.onmessage = ({ data }) => { if (data.id !== id) return; done(); if (data.error) reject(new Error(data.error)); else resolve(data.model); };
      worker.onerror = event => { done(); reject(new Error(event.message || 'Model worker failed')); };
      worker.postMessage({ id, buffer, options }, [buffer]);
    });
  }
  dispose() { this.cancel(); }
}

// Both loaders auto-detect PLY and SOG content.
export { PlyLoader as ModelLoader };
