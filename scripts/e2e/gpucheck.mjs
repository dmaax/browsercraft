// Is headless Chrome's WebGPU usable from a worker with an OffscreenCanvas? No game involved.
//   BC_ORIGIN=http://localhost:8090 node gpucheck.mjs [extra chrome flags...]
// Prints the adapter and whether the device survives 6 s of presenting. "swiftshader" + "LOST" means
// Chrome fell back to software WebGPU, which breaks the game too; pass --use-angle=vulkan.
import puppeteer from 'puppeteer-core';

const ORIGIN = process.env.BC_ORIGIN || 'http://localhost:8090';
const extra = process.argv.slice(2);
const b = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--window-size=640,360', '--no-first-run', ...extra],
  defaultViewport: { width: 640, height: 360 },
});
const p = await b.newPage();
const out = [];
p.on('workercreated', w => w.on('console', m => out.push(m.text())));
await p.goto(ORIGIN + '/game/t1.html'); // any cross-origin-isolated page
await p.evaluate(() => {
  document.body.innerHTML = '<canvas id="c" width="640" height="360"></canvas>';
  const off = document.getElementById('c').transferControlToOffscreen();
  const src = `onmessage = async (e) => {
    const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!ad) { console.log('NO ADAPTER'); return; }
    const dev = await ad.requestDevice();
    let lost = null;
    dev.lost.then(i => { lost = i.reason; console.log('LOST ' + i.reason + ': ' + i.message); });
    const ctx = e.data.getContext('webgpu');
    ctx.configure({ device: dev, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
    console.log('adapter ' + ad.info.vendor + ' / ' + ad.info.architecture);
    let n = 0; const t0 = performance.now();
    const f = () => {
      if (lost) return;
      const enc = dev.createCommandEncoder();
      enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, .6, .2, 1] }] }).end();
      dev.queue.submit([enc.finish()]);
      n++;
      if (performance.now() - t0 < 6000) requestAnimationFrame(f); else console.log('OK ' + n + ' frames, device alive');
    };
    requestAnimationFrame(f);
  };`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  w.postMessage(off, [off]);
});
await new Promise(r => setTimeout(r, 8000));
await b.close();
console.log((extra.join(' ') || '(no extra flags)') + '\n  ' + (out.join('\n  ') || 'no output'));
process.exit(out.some(s => s.startsWith('OK ')) ? 0 : 1);
