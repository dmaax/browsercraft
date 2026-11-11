// End-to-end check: boot the Browsercraft client in headless Chrome and join a Minecraft server
// through the srv/server.mjs WebSocket bridge.
//
//   node join.mjs                      # defaults below
//   BC_ORIGIN=http://localhost:8090 MC_SERVER=10.0.0.5:25565 SECS=240 node join.mjs
//
// Exit code 0 when the client reached the world (frames keep being presented after connecting),
// 1 otherwise. Check the server log too: "<name> joined the game".
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = process.env.BC_ORIGIN || 'http://localhost:8090';
const SERVER = process.env.MC_SERVER || 'localhost:25565';
const NAME = process.env.MC_NAME || 'BcE2E';
const SECS = +(process.env.SECS || 240);
const OUT = path.resolve(process.env.OUT || 'e2e-out');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const F2_AFTER = +(process.env.F2_AFTER || 60); // seconds after connecting before the in-game screenshot
fs.mkdirSync(OUT, { recursive: true });

const T0 = Date.now();
const log = (s) => console.log(`${String(Math.round((Date.now() - T0) / 1000)).padStart(4)}s ${s}`);

const b = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  // Without --use-angle=vulkan headless Chrome on Linux falls back to SwiftShader, whose WebGPU device
  // is destroyed on the first OffscreenCanvas present (gpucheck.mjs reproduces it without the game).
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist',
    '--window-size=1280,720', '--no-first-run', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  defaultViewport: { width: 1280, height: 720 },
  protocolTimeout: 0,
});
const p = await b.newPage();
const fh = fs.createWriteStream(path.join(OUT, 'console.log'));
let connectedAt = 0, device = '';
const onLine = (src, t) => {
  fh.write(`${Date.now() - T0} ${src} ${t}\n`);
  if (/^(FPS|LAT) /.test(t)) return;
  if (/\[boot\]|Connecting to|graphics device|CRASH|device lost|joined|Disconnected|kicked/i.test(t)) log(`[${src}] ${t.split('\n')[0].slice(0, 200)}`);
  if (/Connecting to/.test(t) && !connectedAt) connectedAt = Date.now();
  const d = /Using graphics device: (\S+)/.exec(t); if (d) device = d[1];
};
p.on('console', m => onLine('page', m.text()));
p.on('pageerror', e => onLine('pageerror', e.message));
p.on('workercreated', w => w.on('console', m => onLine('worker', m.text())));
const cdp = await p.target().createCDPSession();
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT });

// Any same-origin page under /game/ works: worker.js, io.js, naga.wasm and mc.wasm resolve relative to it.
await p.goto(ORIGIN + '/game/t1.html');
await p.evaluate(() => { document.body.style.margin = '0'; document.body.innerHTML = '<canvas id="c" style="width:1280px;height:720px;display:block"></canvas>'; });
// Fresh profile = first launch: skip the accessibility onboarding and the third-party-server warning,
// which would otherwise sit in front of --quickPlayMultiplayer forever.
await p.evaluate(async () => {
  const mc = await (await navigator.storage.getDirectory()).getDirectoryHandle('mc', { create: true });
  const w = await (await mc.getFileHandle('options.txt', { create: true })).createWritable();
  await w.write('onboardAccessibility:false\nskipMultiplayerWarning:true\n');
  await w.close();
});
await p.evaluate(async (name, server) => {
  const { boot } = await import('/game/boot.js');
  boot(document.getElementById('c'), {
    args: ['--username', name, '--accessToken', '0', '--version', '26.3', '--gameDir', '/mc', '--assetsDir', '/mc/assets', '--assetIndex', '34', '--quickPlayMultiplayer', server],
    onmessage: (m) => {
      if (m.status) console.log('[boot] ' + m.status + (m.error ? ' ' + m.error.slice(0, 300) : ''));
      // Downloads go through whatever link serves BC_ORIGIN; report every 10% so a slow link is visible.
      if (m.progress && m.progress.p !== undefined) {
        const d = Math.floor(m.progress.p * 10);
        if (d !== self.__bcLast) { self.__bcLast = d; console.log('[boot] ' + m.progress.text + ' ' + d * 10 + '%'); }
      }
    },
  });
}, NAME, SERVER);
log(`booting ${NAME} -> ${SERVER} via ${ORIGIN}`);

// Probe the client worker: GPU tickets issued/completed and frames presented. After connecting, a
// healthy client keeps presenting frames; a stuck one (e.g. waiting forever on a dead future) does not.
const probe = async () => {
  const w = p.workers().find(x => x.url().endsWith('/game/worker.js'));
  if (!w) return null;
  return Promise.race([w.evaluate(() => {
    const g = self.bc && self.bc.g;
    return g ? { ticket: g.ticket, done: g.doneMax, frames: g.fn || 0 } : null;
  }), new Promise(r => setTimeout(() => r('busy'), 3000))]);
};
let framesAfter = 0, prev = null, shot = false;
const end = Date.now() + SECS * 1000;
while (Date.now() < end) {
  await new Promise(r => setTimeout(r, 10000));
  const s = await probe().catch(() => null);
  if (s && s !== 'busy' && connectedAt) {
    if (prev && s.ticket > prev.ticket) framesAfter++;
    prev = s;
  }
  log('probe ' + JSON.stringify(s) + (connectedAt ? ` progressing=${framesAfter}` : ''));
  // F2 = the game's own screenshot (read back from WebGPU); page screenshots do not capture the worker's canvas.
  if (!shot && connectedAt && Date.now() - connectedAt > F2_AFTER * 1000) { shot = true; await p.focus('canvas').catch(() => {}); await p.keyboard.press('F2'); log('F2 -> ' + OUT); }
}
await new Promise(r => setTimeout(r, 3000));
await b.close();
fh.end();
const ok = connectedAt > 0 && framesAfter >= 3 && device !== 'google';
log(`${ok ? 'PASS' : 'FAIL'}: device=${device || '?'} connected=${!!connectedAt} progressing-probes-after-connect=${framesAfter} (log and screenshot in ${OUT})`);
process.exit(ok ? 0 : 1);
