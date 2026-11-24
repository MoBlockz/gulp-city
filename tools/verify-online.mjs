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
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timed out')); }, 30000);
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
  const session = { send, evaluate, errors, close: () => { ws.close(); proc.kill(); }, T: c => evaluate('window.__t(' + JSON.stringify(c) + ')').catch(e => {
    throw new Error(e.message + '\nIn ' + label + ', while evaluating: ' + c.slice(0, 220));
  }) };
  sessions.push(session); return session;
}
async function verify() {
try {
  let a = await browser('host');
  if (process.argv.includes('--passengers-only')) {
    await a.T(`startGame({mode:'towns'}); clearWorld(); busStops=[]; passengerGroups.clear();
      window.__site={road:0,axis:'x',dir:1,pos:BLOCKS[1]}; addBusStop(__site,'isolation-stop');
      window.__bus=objects.find(o=>o.kind==='bus'); __bus.x=__site.pos-2; clk=10; night=0;`);
    console.log('BEFORE ARRIVAL', await a.T('JSON.stringify(objects.map(o=>[o.id,o.kind,o.move?.type]))'));
    await a.T('moveObj(__bus,.4,10)');
    console.log('AFTER ARRIVAL', await a.T('JSON.stringify(objects.map(o=>[o.id,o.kind,o.move?.type]))'));
    assert.equal(await a.T('objects.filter(o=>o.move?.type==="passenger").length'),2);
    console.log('PASS isolated daytime passenger arrival'); return;
  }
  assert.equal(await a.evaluate('document.querySelector("#killBtn,#killPanel")'), null, 'instant-kill controls removed');
  assert.equal(await a.T('typeof doKill'), 'undefined', 'instant-kill code removed');
  await a.T('startGame(); loadTown(16)');
  assert.deepEqual(await a.T('({blocks:layout.length,giant:!!giantObj})'), {blocks:225,giant:true}, 'expanded city keeps its central giant tower');
  assert.deepEqual(await a.T(`(() => {
    const a={R:1,level:0,phantomT:0}, b={R:3,level:4,phantomT:0};
    frenzy=true; const atLimit=canEatHole(a,b); b.R=3.001; const overLimit=canEatHole(a,b);
    frenzy=false; const ordinary=canEatHole(a,b); a.phantomT=60; b.R=15; const phantom=canEatHole(a,b);
    return {atLimit,overLimit,ordinary,phantom};
  })()`), {atLimit:true,overLimit:false,ordinary:false,phantom:true}, '3x boundary and Phantom exception');
  assert.deepEqual(await a.T(`(() => {
    setHoles([{name:'Attacker',color:0x8a5cff,player:true},{name:'Bigger',color:0xff4f9a}]);
    resetHoles([[0,0],[.2,0]]); frenzy=true;
    player.R=1; player.vx=5; holes[1].R=3; holes[1].shield=0;
    holeVsHole(); return {attacker:player.alive,target:holes[1].alive};
  })()`), {attacker:true,target:false}, 'a moving player can actually gulp a 3x rival in Frenzy');
  assert.equal(await a.T(`(() => {
    resetHoles([[0,0],[.2,0]]); frenzy=false;
    player.R=1; player.phantomT=60; holes[1].R=15; holes[1].shield=12;
    holeVsHole(); return player.alive && !holes[1].alive;
  })()`), true, 'Phantom gulps even a giant shielded rival');
  await a.T(`resetHoles([[0,0],[20,20]]); holes[1].phantomT=60; player.phantomT=60; syncHoles(0); updateTags()`);
  assert.deepEqual(await a.T(`({enemyVisible:holes[1].grp.visible,cutout:holeUniform.value[1].z,
    tag:holes[1].tag.style.display,selfVisible:player.grp.visible})`),
    {enemyVisible:false,cutout:0,tag:'none',selfVisible:true}, 'Phantom hides opponent mesh, ground cutout, and name while owner remains controllable');
  assert.equal(await a.T(`(() => {
    const enemy=holes[1], x=(enemy.x+CITY)*miniC.width/(CITY*2), y=(enemy.z+CITY)*miniC.width/(CITY*2);
    const original=miniG.arc; let shown=false;
    miniG.arc=function(ax,ay,...args){ if(Math.abs(ax-x)<.01&&Math.abs(ay-y)<.01) shown=true; return original.call(this,ax,ay,...args); };
    try { drawMini(0); } finally { miniG.arc=original; } return shown;
  })()`), false, 'invisible opponent is absent from minimap');
  assert.deepEqual(await a.T(`(() => { const ai=holes[1]; ai.mode='target'; ai.tk='hole'; ai.target=player; ai.aiT=10;
    return aiDir(ai,.01); })()`), [0,0], 'AI abandons a target that turns invisible');
  await a.T('updateHoles(60.01,0); syncHoles(0)');
  assert.equal(await a.T('holes[1].phantomT===0 && holes[1].grp.visible'), true, 'invisibility expires after one minute');
  await a.T('frenzy=false; gameT=0; phantomReadyAt=PHANTOM_INTERVAL; clearWorld(); puTimer=99999');
  await a.T('gameT=599.999; updatePhantomSpawn()');
  assert.equal(await a.T('powerups.filter(p=>p.type==="phantom").length'), 0, 'no Phantom before ten minutes');
  await a.T(`for(let i=0;i<12;i++) spawnPU('speed',-100,-100); gameT=600; withRandom(()=>.99,updatePhantomSpawn)`);
  assert.equal(await a.T('powerups.filter(p=>p.type==="phantom").length'), 1, 'guaranteed Phantom at ten minutes despite full normal pickup capacity and high random roll');
  await a.T('updatePhantomSpawn()');
  assert.equal(await a.T('powerups.filter(p=>p.type==="phantom").length'), 1, 'same tick does not duplicate Phantom');
  assert.equal(await a.T('phantomReadyAt'), 1200, 'next appearance scheduled at twenty minutes');
  await a.T('gameT=1199.999; updatePhantomSpawn()');
  assert.equal(await a.T('powerups.filter(p=>p.type==="phantom").length'), 1, 'no early second appearance');
  await a.T('gameT=1200; updatePhantomSpawn()');
  assert.equal(await a.T('powerups.filter(p=>p.type==="phantom").length'), 2, 'second guaranteed appearance at twenty minutes');
  await a.T('clearWorld(); gameT=599.99; clk=599.99; phantomReadyAt=600; refillT=.01; step(.02,0)');
  assert.equal(await a.T('powerups.some(p=>p.type==="phantom"&&!p.dead)'), true, 'ten-minute town rebuild cannot erase the scheduled Phantom');
  console.log('PASS larger maps, removed instant kills, 3x limit, Phantom effects, duration and guaranteed schedule');
  assert.equal(await a.T(`(() => {
    resetHoles([[0,0],[.2,0]]); player.R=1; player.phantomT=60; holes[1].R=15; holes[1].phantomT=60;
    holeVsHole(); return player.alive && holes[1].alive && !canEatHole(holes[1],player);
  })()`), true, 'even another Phantom cannot swallow a protected player');
  assert.equal(await a.T(`(() => {
    player.frozenT=0; applyPU(holes[1],{type:'freeze',x:0,z:0});
    onPick({type:'freeze',t:town,id:'test-freeze'},{peerId:'test-rival'});
    return player.frozenT===0;
  })()`), true, 'Phantom blocks local and multiplayer freezes');
  await a.T('startGame({mode:"endless"})');
  console.log('PASS Endless city loaded');
  assert.deepEqual(await a.T('({mode:gameMode,town,refillT})'), {mode:'endless',town:0,refillT:900}, 'Endless starts in one city with a 15-minute rebuild timer');
  await a.T('clearWorld(); player.score=111; player.growth=222; updateTowns(899)');
  assert.equal(await a.T('state==="play" && townEp[0]===0 && refillT===1'), true, 'empty Endless city waits for the scheduled rebuild');
  await a.T('updateTowns(.99)');
  assert.equal(await a.T('townEp[0]'), 0, 'no rebuild before fifteen minutes');
  await a.T('updateTowns(.02)');
  assert.equal(await a.T('townEp[0]===1 && objects.length>0 && refillT===900 && !frenzy && player.score===111 && player.growth===222'), true,
    'Endless rebuild restores the city, resets Frenzy, and preserves score and growth');
  assert.deepEqual(await a.T(`(() => {
    const bus=spawn('bus',0,0); bus.gold=false; const before=player.score; finishEat(bus,player);
    const tower=spawn('tower',0,0); const expected=objectPoints(tower), base=tower.pts; finishEat(tower,player);
    return {busPoints:player.score-before-expected,towerBonus:expected-base,goldBus:objectPoints({kind:'bus',pts:25,gold:true})};
  })()`), {busPoints:45,towerBonus:200,goldBus:145}, 'bus and skyscraper bonuses reach the real score, including gold buses');
  a.close();
  for (const mode of ['towns','classic','endless']) {
    a = await browser('passengers-' + mode);
    await a.T(`startGame({mode:${JSON.stringify(mode)}}); clearWorld(); busStops=[]; passengerGroups.clear();
      window.__testSite={road:ROADS[Math.floor(ROADS.length/2)],axis:'x',dir:1,pos:BLOCKS[Math.floor(BLOCKS.length/2)]};
      addBusStop(window.__testSite,'day-stop');
      window.__testBus=objects.find(o=>o.kind==='bus'); __testBus.x=__testSite.pos-2;
      night=0; clk=10; moveObj(__testBus,.4,10);`);
    assert.equal(await a.T('objects.filter(o=>o.move?.type==="passenger").length'), 2, mode + ' daytime bus unloads two people');
    const start = await a.T('objects.filter(o=>o.move?.type==="passenger").map(o=>[o.id,o.x,o.z])');
    await a.T('clk=12; for(const p of objects) if(p.move?.type==="passenger") moveObj(p,.1,12)');
    const walked = await a.T('objects.filter(o=>o.move?.type==="passenger").map(o=>[o.id,o.x,o.z])');
    assert.notDeepEqual(walked, start, mode + ' passengers walk away onto the pavement');
    await a.T('night=1; __testBus.x=__testSite.pos-2; __testBus.move.wait=0; __testBus.move.sinceStop=4; moveObj(__testBus,.4,12)');
    assert.equal(await a.T('objects.filter(o=>o.move?.type==="passenger").length'), 2, mode + ' buses do not unload at night');
    await a.T('loadTown(town)');
    assert.equal(await a.T('objects.filter(o=>o.move?.type==="passenger").length'), 2, mode + ' passengers survive a town revisit');
    await a.T('removeObj(objects.find(o=>o.move?.type==="passenger")); loadTown(town)');
    assert.equal(await a.T('objects.filter(o=>o.move?.type==="passenger").length'), 1, mode + ' swallowed passenger stays gone');
    if (mode === 'endless') {
      assert.deepEqual(await a.T(`(() => { const snap=makeSnap(); beginSpectate(snap);
        return {mode:gameMode,refillT,passengers:objects.filter(o=>o.move?.type==='passenger').length}; })()`),
        {mode:'endless',refillT:900,passengers:1}, 'spectator snapshot restores Endless mode and live passengers');
      if (process.env.ENDLESS_SHOT) {
        await a.T('syncHoles(0); updateCamera(1); renderer.render(scene,camera)');
        const shot=await a.send('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(process.env.ENDLESS_SHOT,Buffer.from(shot.data,'base64'));
      }
    }
    assert.deepEqual(a.errors,[], mode + ' runtime errors'); a.close();
  }
  console.log('PASS Endless rebuild, score bonuses, daytime passengers in every mode and full Phantom immunity');
  a = await browser('host-online');
  // Traffic pauses at the correct curb, including reverse lanes and journeys across the map seam.
  await a.T(`startGame(); baseSeed=12345; loadTown(1);`);
  const initialStops = await a.T('busStops.length');
  assert.ok(initialStops > 0, 'town starts with working bus stops');
  await a.T('clk=19.999; updateBusStops()');
  assert.equal(await a.T('busStops.length'), initialStops, 'no early stop');
  await a.T('clk=20; updateBusStops(); updateBusStops()');
  assert.equal(await a.T('busStops.length'), initialStops + 1, 'one stop at 20 seconds, without duplicates');
  await a.T('clk=40; updateBusStops()');
  assert.equal(await a.T('busStops.length'), initialStops + 2, 'another stop at 40 seconds');
  await a.T(`loadTown(town); clk=40; updateBusStops()`);
  assert.equal(await a.T('objects.filter(o=>o.id==="stop-timed-0").length'), 1, 'town reload keeps deterministic stop IDs');
  for (const axis of ['x', 'z']) for (const dir of [-1, 1]) {
    const result = await a.T(`(() => {
      const axis=${JSON.stringify(axis)}, dir=${dir}, road=ROADS[0], pos=BLOCKS[0];
      const id='test-stop-'+axis+dir;
      for (const old of busStops) if(old.state==='idle'&&old.stop.axis===axis&&old.stop.dir===dir&&old.stop.road===road) removeObj(old);
      addBusStop({road,axis,dir,pos},id);
      const bus=spawnVehicle(pos-dir*2,road,axis,dir,5,'bus');
      moveObj(bus,.4,0);
      const arrived=bus[axis], waiting=bus.move.wait;
      moveObj(bus,2.5,0); const held=bus[axis];
      moveObj(bus,.75,0); const resumed=bus[axis];
      removeObj(objById.get(id));
      bus[axis]=pos-dir*2; bus.move.wait=0; bus.move.sinceStop=4;
      moveObj(bus,.8,0);
      return {pos,arrived,waiting,held,resumed,skipped:bus.move.wait===0};
    })()`);
    assert.ok(Math.abs(result.arrived - result.pos) < 1e-6, axis + dir + ' reaches stop');
    assert.ok(Math.abs(result.waiting - 3) < 1e-6, 'three-second dwell');
    assert.equal(result.held, result.arrived, 'bus stays at stop');
    assert.ok((result.resumed - result.arrived) * dir > 0, 'bus resumes in its lane direction');
    assert.equal(result.skipped, true, 'swallowed stop is skipped');
  }
  assert.equal(await a.T(`(() => {
    const road=ROADS[0], pos=-WRAP+5;
    addBusStop({road,axis:'x',dir:1,pos},'wrap-stop');
    const bus=spawnVehicle(WRAP-2,road,'x',1,5,'bus'); moveObj(bus,1.4,0);
    return Math.abs(bus.x-pos)<1e-6 && Math.abs(bus.move.wait-3)<1e-6;
  })()`), true, 'bus stops after crossing the map seam');
  assert.equal(await a.T('townOf({remote:true,town:0})'), 0, 'Classic city stays town zero');
  await a.T('clk=600; refillTown(town,1)');
  const rebuiltStops = await a.T('busStops.length');
  await a.T('clk=619.999; updateBusStops()');
  assert.equal(await a.T('busStops.length'), rebuiltStops, 'rebuilt town starts a fresh stop timer');
  await a.T('clk=620; updateBusStops()');
  assert.equal(await a.T('busStops.length'), rebuiltStops + 1, 'stop timer continues after town rebuild');
  await a.T(`keys.KeyD=true; touch.active=true; touch.id=7; window.dispatchEvent(new Event('blur'))`);
  assert.deepEqual(await a.T('inputDir()'), [0, 0], 'focus loss clears keyboard and touch movement');
  if (process.env.BUS_SHOT) {
    await a.T(`clearWorld(); busStops=[]; addBusStop({road:0,axis:'x',dir:1,pos:0},'photo-stop');
      spawnVehicle(0,0,'x',1,5,'bus'); only(); syncHoles(0);
      camera.position.set(8,7,9); camera.lookAt(0,1,-2); renderer.render(scene,camera)`);
    const shot = await a.send('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(process.env.BUS_SHOT, Buffer.from(shot.data,'base64'));
  }
  await a.T('toMenu()');
  console.log('PASS bus arrivals, dwell, departures, swallowed stops, map wrap, spawn timer and input fixes');
  if (process.argv.includes('--traffic-only')) return;
  const b = await browser('guest');
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
  await a.T(`$('mpModes').querySelector('[data-m="endless"]').click()`);
  await until(() => b.T('net.lobbyMode==="endless"'), 'Endless mode selection synchronised');
  await a.T(`$('mpStart').click()`);
  await until(() => b.T('state === "play"'), 'start game relayed');
  assert.equal(await b.T('gameMode==="endless" && town===0 && refillT===900'), true, 'Endless starts correctly online');
  assert.equal(await a.T('baseSeed'), await b.T('baseSeed'), 'shared city seed');
  const signature = `objects.filter(o=>!o.move&&o.kind!=='person').map(o=>[o.id,o.kind,o.x,o.z,o.gold])`;
  assert.deepEqual(await a.T(signature), await b.T(signature), 'same city in both browsers');
  await a.T('clk=20; updateBusStops()'); await b.T('clk=20; updateBusStops()');
  assert.deepEqual(await a.T('busStops.map(o=>[o.id,o.x,o.z])'), await b.T('busStops.map(o=>[o.id,o.x,o.z])'), 'new bus stops match in multiplayer');
  const authority = await a.T('busAuthority()===net.myId') ? a : b;
  const follower = authority === a ? b : a;
  await authority.T(`window.__busTestId=objects.find(o=>o.kind==='bus'&&o.move).id;
    const bus=objById.get(window.__busTestId); bus.move.wait=2.5; netState()`);
  const busId = await authority.evaluate('window.__busTestId');
  await until(() => follower.T(`Math.abs(objById.get(${JSON.stringify(busId)}).move.wait-2.5)<.02`), 'bus stopping state synchronised online');
  await authority.T(`night=0; const bus=objById.get(window.__busTestId);
    const stop=busStops.find(s=>s.stop.axis===bus.move.axis&&s.stop.dir===bus.move.dir&&s.stop.lane===(bus.move.axis==='x'?bus.z:bus.x));
    bus.move.visit=(bus.move.visit||0)+1; unloadPassengers(bus,stop);`);
  await until(() => follower.T('objects.some(o=>o.move?.type==="passenger")'), 'daytime bus passengers synchronised online');
  assert.deepEqual(await authority.T('passengerSnapshot()'), await follower.T('passengerSnapshot()'), 'same passenger IDs and routes on both browsers');
  await a.T('gameT=600; updatePhantomSpawn()'); await b.T('gameT=600; updatePhantomSpawn()');
  await until(() => a.T('powerups.some(p=>p.id==="phantom-1")'), 'scheduled Phantom exists for host');
  await until(() => b.T('powerups.some(p=>p.id==="phantom-1")'), 'scheduled Phantom synchronised to guest');
  assert.equal(await a.T('powerups.filter(p=>p.type==="phantom").length'), 1, 'host has one scheduled Phantom');
  assert.equal(await b.T('powerups.filter(p=>p.type==="phantom").length'), 1, 'guest has one scheduled Phantom');
  assert.equal(await b.T('phantomReadyAt'), 1200, 'next appearance synchronised across the room');
  await a.T('player.x = 12; player.z = 8; player.score = 123; netState()');
  await until(() => b.T('holes.find(h=>h.remote).score === 123 && holes.find(h=>h.remote).nx === 12'), 'movement and score relayed');

  // A swallowed object disappears in the other player's copy of the city.
  const object = await a.T(`objects.find(o=>o.state==='idle'&&o.kind==='cone').id`);
  await a.T(`net.eaten.push(${JSON.stringify(object)}); netState()`);
  await until(() => b.T(`!objById.has(${JSON.stringify(object)}) || objById.get(${JSON.stringify(object)}).state !== 'idle'`), 'swallowed objects synchronised');

  // Phantom state hides the player on the other browser, and old instant-kill packets have no effect.
  assert.equal(await a.T(`['kill','died','kblock'].some(n=>n in net.A)`), false, 'instant-kill network actions removed');
  await a.T(`applyPU(player,{type:'phantom',x:player.x,z:player.z}); netState()`);
  await until(() => b.T('holes.find(h=>h.remote).phantomT>59'), 'Phantom state synchronised online');
  await b.T(`netSend('pick',{type:'freeze',t:town,id:'protection-test'})`);
  await until(() => a.T(`$('banner').textContent.includes('PHANTOM BLOCKED FREEZE')`), 'Phantom protection blocks a rival Freeze online');
  assert.equal(await a.T('player.alive && player.frozenT===0'),true,'protected player remains alive and unfrozen');
  await b.T('syncHoles(0); updateTags()');
  assert.equal(await b.T('!holes.find(h=>h.remote).grp.visible && holes.find(h=>h.remote).tag.style.display==="none"'), true, 'opponent is invisible online');
  await a.T(`net.room.makeAction('kill').send({t:net.roster[1].id})`);
  await pause(300);
  assert.equal(await b.T('player.alive'), true, 'legacy kill packet ignored');
  await a.T('player.phantomT=0; player.R=4.6; player.growth=2600; player.level=5; netState()');
  await until(() => b.T('holes.find(h=>h.remote).nR===4.6 && holes.find(h=>h.remote).phantomT===0'), 'Phantom ends online');
  // Ordinary swallowing and respawn still work without the deleted kill mechanic.
  await b.T('player.shield = 0; netState()');
  await pause(500);
  await b.T(`const other=holes.find(h=>h.remote); other.R=other.nR; other.x=other.nx; other.z=other.nz;
    player.x=other.x; player.z=other.z; holeVsHole()`);
  await until(() => b.T('!player.alive'), 'ordinary gulp relayed');
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
  const refillEpoch = await authority.T('townEp[0]+1');
  await authority.T('refillT=0; updateTowns(0)');
  await until(() => follower.T(`townEp[0]===${refillEpoch}`), 'Endless rebuild synchronised online');
  assert.equal(await follower.T('gameMode==="endless" && refillT===900 && !frenzy'),true,'guest keeps Endless mode and fresh 15-minute timer after rebuild');
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
}
await verify();
