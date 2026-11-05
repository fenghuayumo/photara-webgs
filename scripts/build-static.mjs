import { cp, mkdir } from 'node:fs/promises';

// Publish only viewer assets; local models and test reports stay on disk.
const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await mkdir(output, { recursive: true });
for (const path of ['index.html', 'demo.js', 'style.css', 'src', 'examples']) {
  await cp(new URL(path, root), new URL(path, output), { recursive: true });
}
console.log('Static viewer assets prepared in dist/');
