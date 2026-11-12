import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Publish only viewer assets; local models and test reports stay on disk.
const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
// A clean build cannot retain removed runtime modules from an older build.
const outputPath=resolve(fileURLToPath(output));
if(outputPath!==resolve(fileURLToPath(root),'dist'))throw new Error('Build output must be the workspace dist directory');
await rm(outputPath, {recursive:true, force:true});
await mkdir(output, { recursive: true });
for (const path of ['index.html', 'demo.js', 'style.css', 'src', 'examples']) {
  await cp(new URL(path, root), new URL(path, output), { recursive: true });
}
console.log('Static viewer assets prepared in dist/');
