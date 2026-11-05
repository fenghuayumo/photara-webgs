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
    const fullscreen = page.locator('photara-viewer').locator('[data-fullscreen]');
    const settingsToggle = page.locator('photara-viewer').locator('[data-settings-toggle]');
    await settingsToggle.click();
    if(!await page.evaluate(()=>{
      const root=document.querySelector('photara-viewer').shadowRoot;
      return [...root.querySelectorAll('.toolbar,.navigation,.footer')].every(panel=>panel.hidden);
    }))throw new Error('Settings panels did not hide');
    await settingsToggle.click();
    if(await settingsToggle.getAttribute('aria-expanded')!=='true')throw new Error('Settings panels did not restore');
    result.ui.push('Hide and restore settings panels from viewport icon');
    await fullscreen.click();
    await page.waitForFunction(()=>document.querySelector('photara-viewer').viewer.isFullscreen());
    const fillsScreen=await page.evaluate(()=>{
      const v=document.querySelector('photara-viewer').viewer,b=v.container.getBoundingClientRect();
      return Math.abs(b.width-innerWidth)<2&&Math.abs(b.height-innerHeight)<2&&v.stage.clientHeight>innerHeight/2;
    });
    if(!fillsScreen)throw new Error('Fullscreen viewer did not fill viewport');
    await page.screenshot({path:fileURLToPath(new URL('../test-results/fullscreen.png',import.meta.url))});
    await fullscreen.click();
    await page.waitForFunction(()=>{
      const v=document.querySelector('photara-viewer').viewer;
      return !v.isFullscreen()&&v.root.querySelector('[data-fullscreen]').getAttribute('aria-pressed')==='false';
    });
    if(await fullscreen.getAttribute('aria-pressed')!=='false')throw new Error('Fullscreen button state did not restore');
    result.ui.push('Fullscreen enter/exit, viewport sizing and accessible button state');
    const quality = page.locator('photara-viewer').locator('[data-quality]');
    await quality.selectOption('movement');
    await canvas.focus(); await page.keyboard.down('w');
    await page.waitForFunction(()=>document.querySelector('photara-viewer').viewer.renderer.lastTransparency==='stochastic');
    await page.keyboard.up('w');
    await page.waitForFunction(()=>{
      const v=document.querySelector('photara-viewer').viewer;
      return performance.now()>v.motionUntil&&!v.frame&&v.renderer.lastTransparency==='sorted';
    });
    await canvas.press('r');
    await page.waitForFunction(()=>{
      const v=document.querySelector('photara-viewer').viewer;
      return performance.now()>v.motionUntil&&!v.frame&&v.renderer.lastTransparency==='sorted';
    });
    // Keep interaction acceleration enabled through all following orbit, fly,
    // focus, calibrated-camera and capture checks.
    result.ui.push('Opt-in movement rendering and exact restore after key release/reset');
    const denoise=page.locator('photara-viewer').locator('[data-denoise]');
    for(const reconstruction of ['spatial','none','temporal']) {
      await denoise.selectOption(reconstruction);
      await canvas.focus();await page.keyboard.down('w');
      await page.waitForFunction(mode=>{
        const r=document.querySelector('photara-viewer').viewer.renderer;
        return r.lastTransparency==='stochastic'&&r.lastReconstruction===mode;
      },reconstruction);
      await page.keyboard.up('w');
    }
    await canvas.press('r');
    await page.waitForFunction(()=>{
      const v=document.querySelector('photara-viewer').viewer;
      return performance.now()>v.motionUntil&&!v.frame&&v.renderer.lastTransparency==='sorted';
    });
    result.ui.push('Raw/spatial/temporal reconstruction selector and sorted restore');
    const before = await page.evaluate(() => document.querySelector('photara-viewer').viewer.controls.yaw);
    await canvas.focus(); await page.keyboard.press('Shift+ArrowRight');
    const after = await page.evaluate(() => document.querySelector('photara-viewer').viewer.controls.yaw);
    if (before === after) throw new Error('Keyboard orbit did not update camera');
    result.ui.push('Keyboard orbit');
    const focus = await page.evaluate(async () => {
      const viewer = document.querySelector('photara-viewer').viewer;
      viewer.options.pixelRatio = 1.5;
      const frame = viewer.renderer.frameCount; viewer.invalidate();
      while(viewer.renderer.frameCount === frame) await new Promise(requestAnimationFrame);
      const { renderer, controls, canvas } = viewer, box = canvas.getBoundingClientRect();
      for(const [u,v] of [[.6,.5],[.4,.5],[.5,.6],[.5,.4]]) {
        const point = await renderer.pick(u*renderer.width,v*renderer.height);
        if(point && Math.hypot(...point.map((x,i)=>x-controls.target[i]))>.01) {
          const m=controls.view();
          const eye=[0,1,2].map(a=>-(m[a*4]*m[12]+m[a*4+1]*m[13]+m[a*4+2]*m[14]));
          return { point, eye, yaw:controls.yaw, pitch:controls.pitch, x:u*box.width, y:v*box.height };
        }
      }
      throw new Error('No off-center focus test point found');
    });
    await page.evaluate(()=>{
      const viewer=document.querySelector('photara-viewer').viewer;
      viewer.canvas.addEventListener('dblclick',e=>{
        const box=viewer.canvas.getBoundingClientRect(),r=viewer.renderer;
        window.__focusExpected=r.pick((e.clientX-box.left)*r.width/box.width,(e.clientY-box.top)*r.height/box.height);
      },{once:true,capture:true});
    });
    await canvas.dblclick({position:{x:focus.x,y:focus.y}});
    focus.point=await page.evaluate(()=>window.__focusExpected);
    if(!focus.point)throw new Error('Double-click did not hit model');
    await page.waitForFunction(point=>{
      const c=document.querySelector('photara-viewer').viewer.controls;
      return !c.transition&&Math.hypot(...point.map((x,i)=>x-c.target[i]))<1e-4;
    },focus.point);
    const centered=await page.evaluate(({point,eye,yaw,pitch})=>{
      const c=document.querySelector('photara-viewer').viewer.controls,m=c.view();
      const cameraPoint=[0,1,2].map(a=>m[a]*point[0]+m[a+4]*point[1]+m[a+8]*point[2]+m[a+12]);
      return c.yaw===yaw&&c.pitch===pitch&&Math.hypot(...cameraPoint.slice(0,2))<1e-4&&Math.abs(c.radius-Math.hypot(...point.map((v,i)=>v-eye[i])))<1e-4;
    },focus);
    if(!centered)throw new Error('Focus did not recenter while preserving orientation and picked distance');
    await page.keyboard.press('r');
    const reset=await page.evaluate(()=>{
      const c=document.querySelector('photara-viewer').viewer.controls;
      return c.target.every((v,i)=>v===c.initial.target[i])&&c.radius===c.initial.radius;
    });
    if(!reset)throw new Error('Focus changed the initial reset camera');
    result.ui.push('Smooth double-click recenter at 1.5 pixel ratio, orientation preservation and R reset');
    const dollyTarget = await page.evaluate(()=>{
      const c=document.querySelector('photara-viewer').viewer.controls;
      c.zoom(c.minimum/c.radius);
      return [...c.target];
    });
    await canvas.hover(); await page.mouse.wheel(0,-100);
    await page.waitForFunction(target=>{
      const c=document.querySelector('photara-viewer').viewer.controls;
      return c.radius===c.minimum&&Math.hypot(...c.target.map((v,i)=>v-target[i]))>1e-6;
    },dollyTarget);
    await canvas.focus(); await page.keyboard.press('r');
    result.ui.push('Mouse wheel keeps moving forward at minimum orbit distance');
    const pose=await page.evaluate(()=>Array.from(document.querySelector('photara-viewer').viewer.controls.view()));
    await page.locator('photara-viewer').locator('[data-mode="fly"]').click();
    const flyPose=await page.evaluate(()=>Array.from(document.querySelector('photara-viewer').viewer.controls.view()));
    if(pose.some((v,i)=>v!==flyPose[i]))throw new Error('Switch to fly changed camera pose');
    await page.locator('photara-viewer').locator('[data-speed]').evaluate(input=>{
      input.value=String(Math.log10(4));input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    if(await page.evaluate(()=>document.querySelector('photara-viewer').viewer.controls.speed!==4))throw new Error('Fly speed slider did not select 4x');
    const flyWheel=await page.evaluate(()=>{
      const c=document.querySelector('photara-viewer').viewer.controls;
      return {target:[...c.target],radius:c.radius};
    });
    await canvas.hover();await page.mouse.wheel(0,-100);
    await page.waitForFunction(({target,radius})=>{
      const c=document.querySelector('photara-viewer').viewer.controls;
      return c.radius===radius&&Math.hypot(...c.target.map((v,i)=>v-target[i]))>.01;
    },flyWheel);
    const flyStart=await page.evaluate(()=>[...document.querySelector('photara-viewer').viewer.controls.target]);
    await canvas.focus(); await page.keyboard.down('w');
    await page.waitForFunction(target=>document.querySelector('photara-viewer').viewer.controls.target.some((v,i)=>Math.abs(v-target[i])>.02),flyStart);
    await page.keyboard.up('w');
    // Force another frame after keyup, then check that an idle camera stops rendering.
    await page.evaluate(()=>document.querySelector('photara-viewer').viewer.invalidate());
    await page.waitForFunction(()=>document.querySelector('photara-viewer').viewer.frame===0);
    const stopped=await page.evaluate(()=>[...document.querySelector('photara-viewer').viewer.controls.target]);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const still=await page.evaluate(()=>[...document.querySelector('photara-viewer').viewer.controls.target]);
    if(still.some((v,i)=>v!==stopped[i]))throw new Error('Camera kept moving after key release');
    const flyEye=await page.evaluate(()=>{
      const m=document.querySelector('photara-viewer').viewer.controls.view();
      return [0,1,2].map(a=>-(m[a*4]*m[12]+m[a*4+1]*m[13]+m[a*4+2]*m[14]));
    });
    await canvas.hover();const cb=await canvas.boundingBox();
    await page.mouse.move(cb.x+cb.width*.5,cb.y+cb.height*.5);await page.mouse.down();
    await page.mouse.move(cb.x+cb.width*.55,cb.y+cb.height*.53,{steps:5});await page.mouse.up();
    const lookError=await page.evaluate(eye=>{
      const m=document.querySelector('photara-viewer').viewer.controls.view();
      return Math.hypot(...[0,1,2].map(a=>-(m[a*4]*m[12]+m[a*4+1]*m[13]+m[a*4+2]*m[14])-eye[a]));
    },flyEye);
    if(lookError>1e-4)throw new Error('Fly look moved camera position');
    await canvas.focus();await page.keyboard.press('v');
    await page.locator('photara-viewer').locator('[data-mode="orbit"][aria-pressed="true"]').waitFor();
    await page.keyboard.press('w');
    await page.locator('photara-viewer').locator('[data-mode="fly"][aria-pressed="true"]').waitFor();
    await page.keyboard.press('r');
    // Double-click from fly must return to orbit after a successful pick.
    await page.locator('photara-viewer').locator('[data-speed]').evaluate(input=>{
      input.value='0';input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await canvas.dblclick({position:{x:focus.x,y:focus.y}});
    await page.locator('photara-viewer').locator('[data-mode="orbit"][aria-pressed="true"]').waitFor();
    await page.waitForFunction(()=>!document.querySelector('photara-viewer').viewer.controls.transition);
    result.ui.push('Orbit/fly UI and V toggle, WASD hold/release, free look, speed, double-click returns to orbit');
    await page.locator('#camera').setInputFiles(fileURLToPath(new URL('../examples/camera.json', import.meta.url)));
    await page.waitForFunction(() => document.querySelector('photara-viewer').viewer.calibratedCamera?.width === 1280);
    if(await page.evaluate(()=>document.querySelector('photara-viewer').viewer.renderer.lastTransparency!=='sorted'))throw new Error('Calibrated view used stochastic rendering');
    if(!await page.locator('photara-viewer').locator('[data-mode="fly"]').isDisabled())throw new Error('Calibrated camera allowed navigation');
    const download = page.waitForEvent('download'); await page.locator('#capture').click();
    if ((await download).suggestedFilename() !== 'photara-webgs.png') throw new Error('Screenshot download failed');
    result.ui.push('Calibrated camera file import and PNG export');
    await page.locator('photara-viewer').locator('[data-reset]').click();
    await page.waitForFunction(() => !document.querySelector('photara-viewer').viewer.calibratedCamera);
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/desktop.png', import.meta.url)), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('photara-viewer').locator('[data-mode="fly"]').click();
    await page.waitForFunction(()=>{
      const v=document.querySelector('photara-viewer').viewer;
      return performance.now()>v.motionUntil&&!v.frame&&v.renderer.lastTransparency==='sorted';
    });
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
