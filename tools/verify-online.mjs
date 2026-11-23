// Run with Node 22+: node tools/verify-online.mjs. Requires Edge and internet access.
// Two isolated browser profiles use real public relays with WebRTC deliberately disabled.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gulp-online-'));
const browsers = [], sockets = [], sessions = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) { console.log('PASS', label); return; } await pause(150); }
  throw new Error('Timed out: ' + label);
};
const script = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
fs.writeFileSync(path.join(temp, 'game.mjs'), script);
assert.equal(spawnSync(process.execPath, ['--check', path.join(temp, 'game.mjs')]).status, 0, 'game syntax');
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name !== '/' && name !== '/index.html') { res.writeHead(204); res.end(); return; }
  // Exercise game logic without spending the test budget drawing thousands of meshes in software.
  const body = html.replace('requestAnimationFrame(frame);', '')
    .replace('\nframe();\n</script>', '\nwindow.__t = c => eval(c);\n</script>');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const testUrl = url + '/?lobby=verify' + Date.now().toString(36);
async function browser(label) {
  const profile = path.join(temp, label);
  const proc = spawn(process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=480,640', 'about:blank'
  ], { stdio: 'ignore' });
  browsers.push(proc);
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => fs.existsSync(portFile), label + ' browser ready', 15000);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const info = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl); sockets.push(ws);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map(), errors = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.id) { const done = pending.get(m.id); if (done) { pending.delete(m.id); done(m); } }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timed out')); }, 15000);
    pending.set(n, m => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source:
    `window.RTCPeerConnection = class { constructor() { throw new Error('Direct peer connections are disabled in this test'); } };
    ${process.env.BLOCK_RELAY ? `const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket { constructor(url, protocols) {
      if (url.includes(${JSON.stringify(process.env.BLOCK_RELAY)})) throw new Error('Relay disabled in test');
      super(url, protocols);
    } };` : ''}` });
  await send('Page.navigate', { url: testUrl });
  await until(() => evaluate('typeof window.__t === "function"'), label + ' game loaded', 30000);
  const session = { send, evaluate, errors, T: c => evaluate('window.__t(' + JSON.stringify(c) + ')') };
  sessions.push(session); return session;
}
try {
  const a = await browser('host'), b = await browser('guest');
  // Zoom gestures are cancelled in-game, but ordinary movement and menus still work.
  assert.equal(await a.T(`(() => { const e = new Event('gesturestart', {cancelable:true}); document.dispatchEvent(e); return e.defaultPrevented; })()`), false);
  await a.T(`$('playBtn').click()`);
  assert.equal(await a.T('state'), 'play');
  for (const expr of [
    `new Event('gesturestart', {cancelable:true})`,
    `new Event('gesturechange', {cancelable:true})`,
    `new WheelEvent('wheel', {ctrlKey:true,cancelable:true})`,
    `new MouseEvent('dblclick', {cancelable:true})`,
    `new KeyboardEvent('keydown', {key:'+',ctrlKey:true,cancelable:true,bubbles:true})`,
    `Object.defineProperty(new Event('touchmove', {cancelable:true}), 'touches', {value:[{},{}]})`
  ]) assert.equal(await a.T(`(() => { const e = ${expr}; document.dispatchEvent(e); return e.defaultPrevented; })()`), true, expr);
  await a.T(`canvas.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,isPrimary:true,clientX:20,clientY:20}));
    canvas.dispatchEvent(new PointerEvent('pointerdown',{pointerId:2,isPrimary:false,clientX:70,clientY:70}));`);
  assert.equal(await a.T('touch.id'), 1, 'second finger must not take over movement');
  await a.T(`window.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:60,clientY:20}));`);
  assert.equal(await a.T('inputDir()[0] > 0'), true, 'drag movement works');
  await a.T(`window.dispatchEvent(new PointerEvent('pointerup',{pointerId:1})); toMenu()`);
  console.log('PASS zoom gestures blocked; one-finger movement preserved');

  await a.T(`$('mpBtn').click(); $('mpName').value = 'Online Host'; $('mpGo').click()`);
  await until(() => a.T('net.isHost && net.roster.length === 1'), 'host connected to internet', 35000);
  const code = await a.T('net.gameCode');
  await b.T(`$('mpBtn').click(); $('mpName').value = 'Other House'; $('mpCodeIn').value = '${code}'; $('mpCodeGo').click()`);
  await until(() => a.T('net.roster.length === 2'), 'guest joined by code with WebRTC unavailable', 30000);
  await until(() => b.T('net.roster.length === 2'), 'both players have the same lobby');
  assert.deepEqual(await a.T('net.roster'), await b.T('net.roster'));
  await b.T(`pickLobbyColor(9)`);
  await until(() => a.T('net.roster[1].c === 9'), 'colour selection relayed');
  await a.T(`$('mpStart').click()`);
  await until(() => b.T('state === "play"'), 'start game relayed');
  assert.equal(await a.T('baseSeed'), await b.T('baseSeed'), 'shared city seed');
  const signature = `objects.filter(o=>!o.move&&o.kind!=='person').map(o=>[o.id,o.kind,o.x,o.z,o.gold])`;
  assert.deepEqual(await a.T(signature), await b.T(signature), 'same city in both browsers');
  await a.T('player.x = 12; player.z = 8; player.score = 123; netState()');
  await until(() => b.T('holes.find(h=>h.remote).score === 123 && holes.find(h=>h.remote).nx === 12'), 'movement and score relayed');

  // A swallowed object disappears in the other player's copy of the city.
  const object = await a.T(`objects.find(o=>o.state==='idle'&&o.kind==='cone').id`);
  await a.T(`net.eaten.push(${JSON.stringify(object)}); netState()`);
  await until(() => b.T(`!objById.has(${JSON.stringify(object)}) || objById.get(${JSON.stringify(object)}).state !== 'idle'`), 'swallowed objects synchronised');

  // Kill, respawn, and leaving use control messages rather than direct connections too.
  await b.T('player.shield = 0; netState()');
  await pause(500);
  await a.T('holes.find(h=>h.remote).shield = 0; doKill(holes.find(h=>h.remote))');
  await until(() => b.T('!player.alive'), 'rival kill relayed');
  for (let i = 0; i < 30; i++) {
    await b.T('for(let j=0;j<6;j++) step(1/30,0)');
    await pause(200);
  }
  await until(() => a.T('holes.find(h=>h.remote).netAlive'), 'respawn relayed');

  // An offline browser reconnects through WebSockets without recreating the room.
  await b.send('Network.enable');
  await b.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await pause(1500);
  await b.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await until(() => b.T('net.room.isConnected()'), 'internet reconnection', 20000);
  await b.T('player.score = 456; netState()');
  await until(() => a.T('holes.find(h=>h.remote).score === 456'), 'state resumes after reconnection');
  await b.T('toMenu()');
  await until(() => a.T('holes.length === 1'), 'departed player removed', 5000);
  await a.T('toMenu()');

  // Unknown codes return to the entry screen rather than claiming a connection.
  await b.T(`$('mpBtn').click(); $('mpCodeIn').value='ZZZZZZ'; $('mpCodeGo').click()`);
  await until(() => b.T(`$('mpStatus').textContent.includes('No game found')`), 'invalid code explained', 22000);
  await b.T('toMenu()');
  // Discovery also works online, without entering a code.
  await a.T(`lastGame=null; $('mpBtn').click(); $('mpGo').click()`);
  await until(() => a.T('net.isHost && net.roster.length === 1'), 'new lobby hosted', 25000);
  await b.T(`lastGame=null; $('mpBtn').click(); $('mpGo').click()`);
  await until(() => b.T('!!net.prompt'), 'online game found automatically', 15000);
  await b.T(`$('askYes').click()`);
  await until(() => b.T('net.roster.length === 2'), 'discovered game joined', 15000);
  await b.T('toMenu()'); await a.T('toMenu()');
  assert.deepEqual(a.errors, [], 'host runtime errors'); assert.deepEqual(b.errors, [], 'guest runtime errors');
  console.log('PASS no runtime errors; all online and input checks passed');
} catch (error) {
  for (const session of sessions) console.log('DIAGNOSTIC', await session.T(`({state, status:$('mpStatus').textContent,
    alive:player.alive, holes:holes.map(h=>({remote:h.remote,alive:h.alive,netAlive:h.netAlive,lv:h.lv})), errors:window.__gcErrors})`).catch(() => 'browser unavailable'), session.errors);
  throw error;
} finally {
  for (const ws of sockets) ws.close();
  for (const proc of browsers) proc.kill();
  server.closeAllConnections(); server.close();
  // Profiles can stay locked briefly after Edge exits; they live under the OS temporary directory.
}
