import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';

const ROOT = process.env.BC_ROOT || path.resolve('web');
const DATA = process.env.BC_DATA || path.resolve('data');
const STATE = process.env.BC_STATE || path.resolve('state');
const PORT = +(process.env.PORT || 8090);
const CLIENT_ID = process.env.MS_CLIENT_ID || '';
const ADMINS = (process.env.ADMIN_UUIDS || '').split(',').map(s => s.trim().replace(/-/g, '')).filter(Boolean);
// Ports the /ws bridge may dial. Wide by default: the bridge only relays traffic that is Minecraft in
// both directions (see relay()), so the port range is not what keeps it from being an open relay.
const PORTS = (process.env.MC_PORTS || '1024-65535').split('-').map(Number);
const DEV = process.env.BC_DEV === '1';
const PROXY_HOSTS = new Set(['discovery.minecraftservices.com', 'sessionserver.mojang.com', 'api.minecraftservices.com', 'textures.minecraft.net', 'api.mojang.com', 'authserver.mojang.com', 'pc.realms.minecraft.net', 'resources.download.minecraft.net']);

fs.mkdirSync(STATE, { recursive: true });
const dbFile = path.join(STATE, 'db.json');
const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : { sessions: {}, accounts: {}, instances: [], catalog: [] };
let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => fsp.writeFile(dbFile + '.tmp', JSON.stringify(db, null, 1)).then(() => fsp.rename(dbFile + '.tmp', dbFile)), 200); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg' };

function headers(res, extra = {}) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

function cookies(req) {
  const o = {};
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return o;
}

function session(req) {
  if (DEV) return { uuid: 'dev', name: 'dev', admin: true };
  const s = db.sessions[cookies(req).bc];
  return s && s.exp > Date.now() ? s : null;
}

function json(res, code, o) { headers(res, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.writeHead(code); res.end(JSON.stringify(o)); }

async function body(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > 1 << 20) throw new Error('too large'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

async function post(url, data, form) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', Accept: 'application/json' },
    body: form ? new URLSearchParams(data) : JSON.stringify(data),
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) { const e = new Error(j.error_description || j.error || j.XErr || r.status); e.data = j; e.status = r.status; throw e; }
  return j;
}

async function minecraft(msToken) {
  const xbl = await post('https://user.auth.xboxlive.com/user/authenticate', { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msToken }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' });
  const uhs = xbl.DisplayClaims.xui[0].uhs;
  const xsts = await post('https://xsts.auth.xboxlive.com/xsts/authorize', { Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' });
  const mc = await post('https://api.minecraftservices.com/authentication/login_with_xbox', { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` });
  const pr = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: 'Bearer ' + mc.access_token } });
  if (pr.status === 404) throw Object.assign(new Error('Dieser Account besitzt Minecraft nicht.'), { status: 403 });
  if (!pr.ok) throw new Error('profile ' + pr.status);
  const p = await pr.json();
  const skin = p.skins?.find(s => s.state === 'ACTIVE')?.url || p.skins?.[0]?.url || null;
  return { token: mc.access_token, exp: Date.now() + (mc.expires_in || 86400) * 1000, uuid: p.id, name: p.name, skin };
}

async function refresh(acc) {
  const t = await post('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: acc.refresh, scope: 'XboxLive.signin offline_access' }, true);
  acc.refresh = t.refresh_token || acc.refresh;
  Object.assign(acc, await minecraft(t.access_token));
  save();
  return acc;
}

function newSession(res, p) {
  const id = crypto.randomBytes(24).toString('base64url');
  db.sessions[id] = { uuid: p.uuid, name: p.name, admin: ADMINS.includes(p.uuid), exp: Date.now() + 1000 * 3600 * 24 * 180 };
  save();
  res.setHeader('Set-Cookie', `bc=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${3600 * 24 * 180}`);
}

const bakeLog = [];
function log(s) { bakeLog.push(new Date().toISOString().slice(0, 19) + ' ' + s); if (bakeLog.length > 2000) bakeLog.shift(); }

const api = {
  'GET /me': (req, res, s) => json(res, 200, { name: s.name, uuid: s.uuid, admin: !!s.admin, versions: db.versions || ['26.3'] }),
  'GET /instances': (req, res) => json(res, 200, db.instances),
  'GET /catalog': (req, res) => json(res, 200, db.catalog),
  'GET /bake/log': (req, res, s) => { if (!s.admin) return json(res, 403, { error: 'admin' }); headers(res, { 'Content-Type': 'text/plain' }); res.end(bakeLog.slice(-400).join('\n')); },
  'POST /instances': async (req, res, s) => {
    if (!s.admin) return json(res, 403, { error: 'admin' });
    const b = await body(req);
    const i = { id: crypto.randomBytes(6).toString('hex'), name: String(b.name || 'Instanz').slice(0, 60), version: String(b.version || '26.3'), mods: (b.mods || []).map(String), state: 'baking', build: null, created: Date.now() };
    db.instances.push(i);
    save();
    startBake(i);
    json(res, 200, i);
  },
  'POST /instances/delete': async (req, res, s) => {
    if (!s.admin) return json(res, 403, { error: 'admin' });
    const b = await body(req);
    db.instances = db.instances.filter(i => i.id !== b.id);
    save();
    json(res, 200, {});
  },
  'POST /instances/rebake': async (req, res, s) => {
    if (!s.admin) return json(res, 403, { error: 'admin' });
    const b = await body(req);
    const i = db.instances.find(x => x.id === b.id);
    if (!i) return json(res, 404, {});
    i.state = 'baking';
    save();
    startBake(i);
    json(res, 200, i);
  },
  'POST /auth/token': async (req, res, s) => {
    const b = await body(req);
    const acc = db.accounts[s.uuid + ':' + b.uuid];
    if (!acc) return json(res, 404, { error: 'unknown account' });
    if (acc.exp - Date.now() < 3600 * 1000) await refresh(acc);
    json(res, 200, { token: acc.token, uuid: acc.uuid, name: acc.name });
  },
  'POST /auth/forget': async (req, res, s) => {
    const b = await body(req);
    delete db.accounts[s.uuid + ':' + b.uuid];
    save();
    json(res, 200, {});
  },
};

const pub = {
  'POST /auth/device': async (req, res) => {
    if (!CLIENT_ID) return json(res, 503, { error: 'MS_CLIENT_ID fehlt' });
    const d = await post('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', { client_id: CLIENT_ID, scope: 'XboxLive.signin offline_access' }, true);
    json(res, 200, { user_code: d.user_code, device_code: d.device_code, verification_uri: d.verification_uri, interval: d.interval });
  },
  'POST /auth/poll': async (req, res) => {
    const b = await body(req);
    let t;
    try {
      t = await post('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { client_id: CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: b.device_code }, true);
    } catch (e) {
      if (e.data?.error === 'authorization_pending' || e.data?.error === 'slow_down') return json(res, 200, { pending: true });
      throw e;
    }
    const p = await minecraft(t.access_token);
    let s = session(req);
    if (!s) { newSession(res, p); s = { uuid: p.uuid }; }
    db.accounts[s.uuid + ':' + p.uuid] = { ...p, refresh: t.refresh_token };
    save();
    json(res, 200, { uuid: p.uuid, name: p.name, skin: p.skin ? '/proxy/textures.minecraft.net' + new URL(p.skin).pathname : null });
  },
};

const bakes = new Map();
function startBake(i) {
  const cmd = process.env.BAKE_CMD;
  if (!cmd) { log(`[${i.id}] BAKE_CMD nicht gesetzt`); i.state = 'failed'; save(); return; }
  if (bakes.has(i.id)) return;
  log(`[${i.id}] Bake gestartet: ${i.name} (${i.version}, ${i.mods.length} Mods)`);
  const p = spawn('sh', ['-c', cmd], { env: { ...process.env, BC_INSTANCE: i.id, BC_VERSION: i.version, BC_MODS: i.mods.join(',') } });
  bakes.set(i.id, p);
  const out = (d) => String(d).split('\n').filter(Boolean).forEach(l => log(`[${i.id}] ${l}`));
  p.stdout.on('data', out);
  p.stderr.on('data', out);
  p.on('close', (code) => {
    bakes.delete(i.id);
    i.state = code === 0 ? 'ready' : 'failed';
    if (code === 0) i.build = i.id;
    log(`[${i.id}] Bake beendet: ${code === 0 ? 'ok' : 'Fehler ' + code}`);
    save();
  });
}

async function proxy(req, res, s) {
  const u = new URL(req.url, 'http://x');
  const parts = u.pathname.split('/');
  const host = parts[2];
  if (!PROXY_HOSTS.has(host)) return json(res, 403, { error: 'host' });
  if (DEV && process.env.BC_FAKEJOIN === '1' && u.pathname.endsWith('/session/minecraft/join')) { headers(res); res.writeHead(204); return res.end(); }
  const target = 'https://' + host + '/' + parts.slice(3).join('/') + u.search;
  const h = {};
  for (const k of ['authorization', 'content-type', 'accept']) if (req.headers[k]) h[k] = req.headers[k];
  const r = await fetch(target, { method: req.method, headers: h, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(await (async () => { const c = []; for await (const x of req) c.push(x); return c; })()) });
  headers(res, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': host === 'textures.minecraft.net' ? 'public, max-age=86400' : 'no-store' });
  res.writeHead(r.status);
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function file(req, res, p) {
  try {
    const st = await fsp.stat(p);
    if (st.isDirectory()) return file(req, res, path.join(p, 'index.html'));
    headers(res, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': p.includes('/builds/') || p.includes('/objects/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.writeHead(200);
    fs.createReadStream(p).pipe(res);
  } catch {
    headers(res);
    res.writeHead(404);
    res.end('not found');
  }
}

function safe(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return p.startsWith(base) ? p : null;
}

async function objects(req, res, rel) {
  const p = safe(DATA, rel);
  if (!p) return json(res, 400, {});
  if (!fs.existsSync(p)) {
    const h = path.basename(p);
    if (!/^[0-9a-f]{40}$/.test(h)) return json(res, 404, {});
    const r = await fetch(`https://resources.download.minecraft.net/${h.slice(0, 2)}/${h}`);
    if (!r.ok) return json(res, 404, {});
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p + '.tmp', Buffer.from(await r.arrayBuffer()));
    await fsp.rename(p + '.tmp', p);
  }
  return file(req, res, p);
}

// BC_ACCESS_LOG=1 logs every request and every bridge connection (paths only: no query strings,
// cookies or headers, so no tokens end up in the log).
const ACCESS = process.env.BC_ACCESS_LOG === '1';
const alog = (...a) => { if (ACCESS) console.log(new Date().toISOString(), ...a); };

const server = http.createServer(async (req, res) => {
  if (ACCESS) {
    const t0 = Date.now(), pth = new URL(req.url, 'http://x').pathname, who = session(req) ? 'session' : 'anon';
    let done = false;
    res.on('finish', () => { done = true; alog(req.method, pth, res.statusCode, res.getHeader('content-length') ?? '-', (Date.now() - t0) + 'ms', who); });
    res.on('close', () => { if (!done) alog(req.method, pth, 'ABORTED', (Date.now() - t0) + 'ms', who); });
  }
  try {
    const u = new URL(req.url, 'http://x');
    const s = session(req);
    if (u.pathname.startsWith('/api/')) {
      const k = req.method + ' ' + u.pathname.slice(4);
      if (pub[k]) return await pub[k](req, res);
      if (!s) return json(res, 401, { error: 'login' });
      if (api[k]) return await api[k](req, res, s);
      return json(res, 404, { error: 'no route' });
    }
    if (u.pathname.startsWith('/proxy/')) { if (!s) return json(res, 401, {}); return await proxy(req, res, s); }
    if (u.pathname.startsWith('/data/') || u.pathname.startsWith('/builds/')) {
      if (!s) return json(res, 401, {});
      if (u.pathname.startsWith('/data/assets/objects/')) return await objects(req, res, u.pathname.slice(6));
      const p = u.pathname.startsWith('/data/') ? safe(DATA, u.pathname.slice(6)) : safe(path.join(STATE, 'builds'), u.pathname.slice(8));
      return p ? await file(req, res, p) : json(res, 400, {});
    }
    if (u.pathname === '/') { res.writeHead(302, { Location: '/launcher/' }); return res.end(); }
    const p = safe(ROOT, u.pathname);
    // mc.wasm is Mojang's code compiled to wasm: only hand it to logged-in players, never publicly.
    if (p && path.basename(p) === 'mc.wasm' && !s) return json(res, 401, { error: 'login' });
    return p ? await file(req, res, p) : json(res, 400, {});
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

// The bridge must not become a door into the server's own network: targets that resolve to
// loopback, private, link-local, CGNAT, multicast or reserved ranges are refused unless
// MC_ALLOW_PRIVATE=1 (e.g. for testing against a Minecraft server on the same LAN).
const ALLOW_PRIVATE = process.env.MC_ALLOW_PRIVATE === '1';
const ORIGINS = new Set((process.env.BC_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) blocked.addSubnet(a, p, 'ipv6');
const HOST_RE = /^[a-z0-9.-]{1,253}$/;

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // browsers always send Origin on WebSocket handshakes; cookie-less tools can't use a session anyway
  try { const h = new URL(o).host; return h === req.headers.host || ORIGINS.has(o); } catch { return false; }
}

// Resolves where a /ws connection may go. Returns { host, port, addrs } or { error } with a reason
// that is shown to the player inside the game.
async function target(host, port) {
  if (!HOST_RE.test(host)) return { error: 'invalid server address' };
  if (port === 25565) {
    try {
      const r = await dns.resolveSrv('_minecraft._tcp.' + host);
      if (r.length) { host = r[0].name.toLowerCase().replace(/\.$/, ''); port = r[0].port; }
    } catch {}
    if (!HOST_RE.test(host)) return { error: 'invalid SRV record target' };
  }
  if (!Number.isInteger(port) || port < PORTS[0] || port > (PORTS[1] || PORTS[0])) return { error: `port ${port} is not allowed by this bridge (MC_PORTS ${PORTS.join('-')})`, host, port };
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { return { error: `cannot resolve ${host}`, host, port }; }
  if (!addrs.length) return { error: `cannot resolve ${host}`, host, port };
  if (!ALLOW_PRIVATE && addrs.some(a => blocked.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))) return { error: `${host} is a private address`, host, port };
  return { host, port, addrs };
}

// --- Just enough of the Minecraft protocol framing for the bridge ------------------------------
// The bridge only relays connections that look like Minecraft in both directions: the client's
// first two packets must be a handshake plus a Status Request or Login Start, and the server's
// first reply must be a valid status response or login packet. Nothing else the client sends is
// passed on before that, so the bridge cannot be used to talk to SMTP, SSH, HTTP and the like,
// which is what makes a wide MC_PORTS range acceptable.
function rv(b, o) { // VarInt at o -> [value, next]; [-1] = need more bytes, [-2] = malformed
  let n = 0;
  for (let i = 0; i < 5; i++) {
    if (o + i >= b.length) return [-1, o];
    const x = b[o + i];
    n |= (x & 0x7f) << (7 * i);
    if (!(x & 0x80)) return [n >>> 0, o + i + 1];
  }
  return [-2, o];
}
const wv = (n) => { const o = []; n >>>= 0; do { const x = n & 0x7f; n >>>= 7; o.push(x | (n ? 0x80 : 0)); } while (n); return Buffer.from(o); };
const wstr = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([wv(b.length), b]); };
const pkt = (id, ...parts) => { const body = Buffer.concat([wv(id), ...parts]); return Buffer.concat([wv(body.length), body]); };

// One uncompressed packet at the start of b: { need } | { bad } | { id, body, size }
function frame(b, max) {
  const [len, o] = rv(b, 0);
  if (len === -1) return { need: true };
  if (len < 1 || len > max) return { bad: true };
  if (b.length < o + len) return { need: true };
  const [id, p] = rv(b, o);
  if (id < 0 || p > o + len) return { bad: true };
  return { id, body: b.subarray(p, o + len), size: o + len };
}

// Length and packet id as soon as they have arrived, to reject non-Minecraft peers on their first bytes.
function peek(b) {
  const [len, o] = rv(b, 0);
  if (len < 0) return null;
  const [id] = rv(b, o);
  return id < 0 ? null : { len, id };
}

function handshake(f) {
  if (f.id !== 0) return null;
  const b = f.body;
  const [proto, o1] = rv(b, 0);
  const [sl, o2] = proto < 0 ? [-2, 0] : rv(b, o1);
  if (sl < 0 || sl > 1024 || o2 + sl + 2 >= b.length) return null;
  const [next, end] = rv(b, o2 + sl + 2);
  if (end !== b.length || next < 1 || next > 3) return null;
  return { proto, address: b.toString('utf8', o2, o2 + sl), next };
}

// Second client packet: Status Request (empty) for status, Login Start (name + UUID) otherwise.
const okRequest = (hs, f) => f.id === 0 && (hs.next === 1 ? f.body.length === 0 : f.body.length >= 17 && f.body.length <= 120);

// First server packet: a JSON status response, or one of the clientbound login packets
// (disconnect, encryption request, login success, set compression, plugin/cookie request).
function okReply(hs, f) {
  if (hs.next !== 1) return f.id <= 5;
  if (f.id !== 0) return false;
  const [n, o] = rv(f.body, 0);
  return n > 0 && f.body[o] === 0x7b; // '{'
}

const CLIENT_WAIT = 10000, SERVER_WAIT = 20000;

// Relays one /ws connection, or answers it in-game with `refusal` when the target is not allowed.
function relay(ws, tg, refusal) {
  const t0 = Date.now(), tag = tg.addrs ? `${tg.host}:${tg.port}` : tg.host ? `${tg.host}:${tg.port}` : '?';
  let phase = 'client', cbuf = Buffer.alloc(0), sbuf = Buffer.alloc(0), hs = null, sock = null, up = 0, down = 0, closed = false, why = refusal;
  let timer = setTimeout(timeout, CLIENT_WAIT);

  function stop(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    alog(`WS closed ${tag} after ${((Date.now() - t0) / 1000).toFixed(1)}s, client->server ${up} B, server->client ${down} B: ${reason}`);
    try { ws.close(); } catch {}
    if (sock) sock.destroy();
  }
  function timeout() {
    if (phase === 'client') stop('no Minecraft handshake from the client');
    else if (phase === 'connecting') refuse(`timed out connecting to ${tag}`);
    else if (phase === 'server') refuse(`${tag} did not answer like a Minecraft server`);
    else stop('timeout');
  }
  // Answer in the Minecraft protocol so the player sees the reason: a red MOTD in the server
  // list (status) or a disconnect screen (login).
  function refuse(reason) {
    if (closed) return;
    if (ws.readyState !== 1) return stop(reason);
    why = reason;
    phase = 'refuse';
    if (sock) { sock.destroy(); sock = null; }
    clearTimeout(timer);
    timer = setTimeout(() => stop('refused: ' + why), 5000);
    alog(`WS refused in-game ${tag}: ${why}`);
    const text = { text: 'Browsercraft: ' + why, color: 'red' };
    if (hs.next === 1) {
      ws.send(pkt(0, wstr(JSON.stringify({ version: { name: 'Browsercraft bridge', protocol: hs.proto }, players: { max: 0, online: 0 }, description: text }))));
      answerPing();
    } else {
      ws.send(pkt(0, wstr(JSON.stringify(text))));
      setTimeout(() => stop('refused: ' + why), 500);
    }
  }
  function answerPing() {
    const f = frame(cbuf, 64);
    if (f.need) return;
    if (f.bad || f.id !== 1) return stop('refused: ' + why);
    ws.send(pkt(1, f.body));
    setTimeout(() => stop('refused: ' + why), 200);
  }
  function fromClient() {
    const pk = peek(cbuf);
    if (pk && (pk.id !== 0 || pk.len < 1 || pk.len > 1100)) return stop('not a Minecraft handshake');
    const f1 = frame(cbuf, 1100);
    if (f1.need) return cbuf.length > 2048 ? stop('handshake too long') : undefined;
    const h = f1.bad ? null : handshake(f1);
    if (!h) return stop('not a Minecraft handshake');
    const f2 = frame(cbuf.subarray(f1.size), 200);
    if (f2.need) return;
    if (f2.bad || !okRequest(h, f2)) return stop('not a Minecraft status/login request');
    hs = h;
    const first = cbuf.subarray(0, f1.size + f2.size);
    cbuf = cbuf.subarray(f1.size + f2.size); // anything else waits until the server is verified
    if (why) return refuse(why);
    phase = 'connecting';
    clearTimeout(timer);
    timer = setTimeout(timeout, SERVER_WAIT);
    // Dial the addresses that were checked instead of resolving the name again: a second DNS
    // answer could point somewhere else. net.connect still tries each address in turn.
    const lookup = (_h, o, cb) => (o && o.all ? cb(null, tg.addrs) : cb(null, tg.addrs[0].address, tg.addrs[0].family));
    sock = net.connect({ host: tg.host, port: tg.port, lookup });
    sock.setNoDelay(true);
    sock.on('connect', () => { phase = 'server'; alog(`WS tcp connected ${tag} (${['', 'status', 'login', 'transfer'][hs.next]})`); sock.write(first); });
    sock.on('data', fromServer);
    sock.on('error', (e) => { if (phase === 'connecting') refuse(`cannot reach ${tag} (${e.code || e.message})`); else if (phase !== 'refuse') stop(`tcp error ${e.code || e.message}`); });
    sock.on('close', () => { if (phase === 'open') stop('server closed'); else if (phase === 'server') refuse(`${tag} closed the connection without answering`); });
  }
  function fromServer(d) {
    down += d.length;
    if (phase === 'open') { if (ws.readyState === 1) ws.send(d); return; }
    if (phase !== 'server') return;
    sbuf = Buffer.concat([sbuf, d]);
    const pk = peek(sbuf);
    if (pk && (pk.len < 1 || pk.len > 1 << 21 || (hs.next === 1 ? pk.id !== 0 : pk.id > 5))) return refuse(`${tag} is not a Minecraft server`);
    const f = frame(sbuf, 1 << 21);
    if (f.need) return;
    if (f.bad || !okReply(hs, f)) return refuse(`${tag} is not a Minecraft server`);
    phase = 'open';
    clearTimeout(timer);
    alog(`WS open ${tag}: verified Minecraft ${hs.next === 1 ? 'status' : 'login'} reply`);
    ws.send(sbuf);
    sbuf = null;
    if (cbuf.length) sock.write(cbuf);
    cbuf = null;
  }

  ws.on('message', (d) => {
    up += d.length;
    if (phase === 'open') return sock.write(d);
    cbuf = Buffer.concat([cbuf, d]);
    if (cbuf.length > 1 << 16) return stop('client sent too much before the server answered');
    if (phase === 'client') fromClient();
    else if (phase === 'refuse' && hs.next === 1) answerPing();
  });
  ws.on('close', () => stop('client closed'));
  ws.on('error', () => stop('client error'));
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 << 20 });
server.on('upgrade', async (req, sock, head) => {
  sock.on('error', () => {});
  try {
    const u = new URL(req.url, 'http://x');
    const s = session(req);
    const why = u.pathname !== '/ws' ? 'not /ws' : !s ? 'no session' : !sameOrigin(req) ? 'origin ' + req.headers.origin : '';
    if (why) { alog('WS refused:', why); sock.destroy(); return; }
    const h = String(u.searchParams.get('h') || '').toLowerCase(), p = +u.searchParams.get('p') || 25565;
    const tg = await target(h, p);
    if (tg.error) alog(`WS will refuse ${h}:${p}: ${tg.error}`);
    else alog(`WS accepted -> ${h}:${p}` + (tg.host !== h || tg.port !== p ? ` (SRV ${tg.host}:${tg.port})` : ''));
    wss.handleUpgrade(req, sock, head, (ws) => relay(ws, tg, tg.error || null));
  } catch (e) {
    console.error(e);
    sock.destroy();
  }
});

server.listen(PORT, () => console.log('browsercraft on :' + PORT));
