import { serve } from './serve.mjs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  const bundled = process.env.PLAYWRIGHT_MODULE_PATH || resolve(process.env.USERPROFILE || process.env.HOME || '.', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  try { ({ chromium } = createRequire(import.meta.url)(bundled)); }
  catch { throw new Error('Install test dependency: npm install --no-save playwright, then npx playwright install chromium'); }
}
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const executablePath = process.env.BROWSER_EXECUTABLE || (existsSync(edge) ? edge : undefined);
const server = serve(4174);
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-unsafe-webgpu', ...(process.env.SOFTWARE_GPU ? ['--use-angle=swiftshader'] : [])] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const messages = [];
  page.on('pageerror', e => messages.push(e.message));
  await page.goto('http://localhost:4174/tests/gpu.html');
  await page.waitForFunction(() => window.__gpuResult, null, { timeout: 180000 });
  const result = await page.evaluate(() => window.__gpuResult);
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  if (!result.passed || messages.length) process.exitCode = 1;
  if (result.passed) {
    result.ui = [];
    await page.goto('http://localhost:4174/');
    await page.locator('photara-viewer').locator('[data-demo]').click();
    await page.waitForFunction(() => document.querySelector('photara-viewer').viewer?.renderer?.frameCount > 0);
    const canvas = page.locator('photara-viewer').locator('canvas');
    const before = await page.evaluate(() => document.querySelector('photara-viewer').viewer.controls.yaw);
    await canvas.focus(); await page.keyboard.press('Shift+ArrowRight');
    const after = await page.evaluate(() => document.querySelector('photara-viewer').viewer.controls.yaw);
    if (before === after) throw new Error('Keyboard orbit did not update camera');
    result.ui.push('Keyboard orbit');
    await page.locator('#camera').setInputFiles(fileURLToPath(new URL('../examples/camera.json', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('photara-viewer').viewer.calibratedCamera?.width === 1280);
    const download = page.waitForEvent('download'); await page.locator('#capture').click();
    if ((await download).suggestedFilename() !== 'photara-webgs.png') throw new Error('Screenshot download failed');
    result.ui.push('Calibrated camera file import and PNG export');
    await page.locator('photara-viewer').locator('[data-reset]').click();
    await page.waitForFunction(() => !document.querySelector('photara-viewer').viewer.calibratedCamera);
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/desktop.png', import.meta.url)), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/mobile.png', import.meta.url)), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error('Mobile viewport overflow');
    result.ui.push('Desktop/mobile layout and reset');
    const unsupported = await browser.newPage();
    await unsupported.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
    await unsupported.goto('http://localhost:4174/');
    await unsupported.locator('photara-viewer').locator('[data-demo]').click();
    await unsupported.locator('photara-viewer').locator('.message.is-error').filter({ hasText: 'WebGPU' }).waitFor();
    result.ui.push('Unsupported WebGPU error state'); await unsupported.close();
  }
  if (messages.length) process.exitCode = 1;
  await writeFile(new URL('../test-results/gpu.json', import.meta.url), JSON.stringify({ ...result, pageErrors: messages }, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); server.close(); }
