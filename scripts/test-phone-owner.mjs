// 844x390 触控：浮动摇杆、落点、按键不进球场、结算不显示算式。
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { chromium } = require('/tmp/pw/node_modules/playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, '..', 'docs');
const OUT = '/opt/cursor/artifacts';

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}
function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(DOCS, rel);
    if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('no'); return;
    }
    res.writeHead(200, { 'content-type': mime(file), 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function screenOf(page, x, y) {
  const p = await page.evaluate(({ x, y }) => {
    const cv = document.getElementById('game');
    const rect = cv.getBoundingClientRect();
    const W = 1280, H = 720;
    const scale = Math.min(rect.width / W, rect.height / H);
    const offX = (rect.width - W * scale) / 2;
    const offY = (rect.height - H * scale) / 2;
    return { x: rect.left + offX + x * scale, y: rect.top + offY + y * scale };
  }, { x, y });
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function makeTouch(page) {
  let cdp = null;
  return {
    async init() { cdp = await page.context().newCDPSession(page); },
    async send(type, points) {
      await cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), id: p.id })),
      });
    },
  };
}

async function matchInfo(page) {
  return page.evaluate(() => {
    const m = window.__matches[Object.keys(window.__matches)[0]];
    const id = m.control.playerId;
    const p = m.byId[id];
    const ui = window.__touchState();
    return {
      id, x: p.x, y: p.y,
      dx: m.control.dx, dy: m.control.dy,
      phase: m.phase,
      ui,
    };
  });
}

async function drag(touch, page, x0, y0, x1, y1, steps) {
  await touch.send('touchStart', [{ id: 1, x: x0, y: y0 }]);
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x0 + (x1 - x0) * (i / steps));
    const y = Math.round(y0 + (y1 - y0) * (i / steps));
    await touch.send('touchMove', [{ id: 1, x, y }]);
    await page.waitForTimeout(30);
  }
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push('PAGE ' + e.message));
const touch = makeTouch(page);

try {
  await page.goto(base + '/?debug=1&autostart=1', { waitUntil: 'domcontentloaded' });
  await touch.init();
  await page.waitForFunction(() => {
    const ids = Object.keys(window.__matches || {});
    return ids.length && window.__matches[ids[0]].phase === 'play' && window.__touchState;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(400);

  const layer = await page.evaluate(() => {
    const ui = document.getElementById('touch-ui');
    const zone = document.getElementById('stick-zone');
    const html = getComputedStyle(document.documentElement);
    return {
      hidden: ui.hidden,
      z: getComputedStyle(ui).zIndex,
      pe: getComputedStyle(zone).pointerEvents,
      ta: getComputedStyle(zone).touchAction,
      htmlTa: html.touchAction,
      width: zone.getBoundingClientRect().width,
      vw: window.innerWidth,
      keys: document.querySelectorAll('#vkey-layer .vkey').length,
    };
  });
  assert(!layer.hidden, '控制层没显示 ' + JSON.stringify(layer));
  assert(Number(layer.z) >= 30, '控制层不在画布之上 ' + layer.z);
  assert(layer.pe === 'auto', '摇杆区 pointer-events 不是 auto ' + layer.pe);
  assert(layer.ta === 'none' && layer.htmlTa === 'none', 'touch-action 不是 none ' + JSON.stringify(layer));
  assert(Math.abs(layer.width - layer.vw * 0.4) < 2, '摇杆区不是屏幕 40% ' + JSON.stringify(layer));
  assert(layer.keys === 5, '虚拟键没有盖在画布上 ' + layer.keys);

  const before = await matchInfo(page);
  await drag(touch, page, 130, 180, 270, 175, 8);
  await page.waitForTimeout(700);
  const mid = await matchInfo(page);
  assert(mid.ui.touchN > 0, '调试条没有收到触摸 ' + mid.ui.touch);
  assert(mid.dx > 0.35, '左上角拖动摇杆 dx=' + mid.dx + ' ' + mid.ui.touch);
  assert(mid.x > before.x + 1.2, '球员没有跟着摇杆走 ' + before.x.toFixed(2) + ' -> ' + mid.x.toFixed(2));
  const stickOn = await page.evaluate(() => {
    const el = document.getElementById('float-stick');
    const dbg = document.getElementById('touch-debug');
    return { hidden: el.hidden, text: dbg.textContent, left: el.style.left };
  });
  assert(!stickOn.hidden && /touch/.test(stickOn.text), '浮动摇杆或调试条没出现 ' + JSON.stringify(stickOn));
  await page.screenshot({ path: path.join(OUT, 'joystick-open-play.png') });
  await touch.send('touchEnd', [{ id: 1, x: 270, y: 175 }]);
  await page.waitForTimeout(120);
  const up = await matchInfo(page);
  assert(Math.abs(up.dx) < 0.2, '松手后方向没归零 ' + up.dx);

  await page.evaluate(() => window.__matches[Object.keys(window.__matches)[0]].debugPose('menu'));
  await page.waitForFunction(() => window.__touchState().menu && window.__touchState().kind === 'cmds', null, { timeout: 5000 });
  await page.waitForTimeout(450);
  const layout = await page.evaluate(() => window.__touchLayout());
  const downKey = layout.keys.filter((k) => k.key === 's')[0];
  const okKey = layout.keys.filter((k) => k.key === 'e')[0];
  async function tapKey(k) {
    const p = await screenOf(page, k.x, k.y);
    await touch.send('touchStart', [{ id: 3, x: p.x, y: p.y }]);
    await page.waitForTimeout(50);
    await touch.send('touchEnd', [{ id: 3, x: p.x, y: p.y }]);
    await page.waitForTimeout(120);
  }
  await tapKey(downKey);
  await tapKey(okKey);
  await page.waitForTimeout(200);
  let aimed = (await matchInfo(page)).ui;
  assert(aimed.kind === 'aim', '确定没有进入选落点 ' + JSON.stringify(aimed));
  const aim0 = aimed.aim;
  const gap = await screenOf(page, 1000, 180);
  await touch.send('touchStart', [{ id: 7, x: gap.x, y: gap.y }]);
  await page.waitForTimeout(40);
  await touch.send('touchEnd', [{ id: 7, x: gap.x, y: gap.y }]);
  await page.waitForTimeout(80);
  const afterGap = (await matchInfo(page)).ui;
  assert(afterGap.kind === 'aim', '按键旁边的点击离开了选落点 ' + JSON.stringify(afterGap));
  assert(Math.abs(afterGap.aim.x - aim0.x) < 0.4 && Math.abs(afterGap.aim.y - aim0.y) < 0.4,
    '按键区域的点击改了落点 ' + JSON.stringify(aim0) + ' -> ' + JSON.stringify(afterGap.aim));

  await drag(touch, page, 120, 210, 290, 200, 8);
  await page.waitForTimeout(2600);
  const movedAim = (await matchInfo(page)).ui;
  assert(movedAim.kind === 'aim', '摇杆拖动时退出了选落点 ' + movedAim.kind);
  assert(movedAim.aim.x > aim0.x + 3, '摇杆没有推动落点 ' + aim0.x.toFixed(2) + ' -> ' + movedAim.aim.x.toFixed(2));
  await page.screenshot({ path: path.join(OUT, 'landing-cursor-by-stick.png') });
  await touch.send('touchEnd', [{ id: 1, x: 280, y: 200 }]);
  await page.waitForTimeout(80);
  const held = (await matchInfo(page)).ui.aim;
  await tapKey(okKey);
  await page.waitForTimeout(200);
  const confirmed = (await matchInfo(page)).ui;
  assert(confirmed.kind === 'tech', '确定没有确认落点 ' + JSON.stringify(confirmed));
  assert(Math.abs(confirmed.aim.x - held.x) < 1.5, '确定把落点改到了按键上 ' + held.x + ' -> ' + confirmed.aim.x);
  await page.screenshot({ path: path.join(OUT, 'landing-confirmed-by-key.png') });

  await page.evaluate(() => {
    const m = window.__matches[Object.keys(window.__matches)[0]];
    m.phase = 'play';
    m.decision = null;
    m.restart = null;
    m.setPaused(false);
    m.ball.ownerId = 'h10';
    m.lastAction = null;
  });
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const m = window.__matches[Object.keys(window.__matches)[0]];
    m.ball.ownerId = 'a9';
    m.lastAction = {
      kind: 'goalkick', label: '球门球', text: '门将开出球门球', team: 'away',
      until: Date.now() + 4000, success: true,
    };
  });
  await page.waitForTimeout(400);
  const toast1 = (await matchInfo(page)).ui.toast;
  assert(toast1.indexOf('断球') < 0, '球门球误报对方断球: ' + toast1);
  await page.evaluate(() => {
    const m = window.__matches[Object.keys(window.__matches)[0]];
    m.lastAction = {
      kind: 'duel', label: '突破', text: '突破成功', team: 'home', success: true,
      until: Date.now() + 4000,
      duel: { atkLabel: '突破', defLabel: '卡位', result: '突破成功', atkName: '甲', defName: '乙', atkAttrs: [], defAttrs: [], swingA: '+1%', swingD: '-2%', fatA: '0.90', fatD: '0.80', aScore: '12.0', dScore: '9.0', support: 1 },
    };
  });
  await page.waitForTimeout(400);
  const toast2 = (await matchInfo(page)).ui.toast;
  assert(!toast2 || toast2.indexOf('断球') < 0, '结算时还挂着断球提示: ' + toast2);

  console.log('PASS play+aim', 'move', before.x.toFixed(2), '->', mid.x.toFixed(2), 'aim', aim0.x.toFixed(1), '->', movedAim.aim.x.toFixed(1));
} catch (err) {
  try { await page.screenshot({ path: path.join(OUT, 'phone-owner-fail.png') }); } catch (e) {}
  console.error('FAIL', err.message);
  console.error(logs.join('\n'));
  try { console.error(JSON.stringify(await matchInfo(page))); } catch (e) {}
  await browser.close();
  server.close();
  process.exit(1);
}

// 结算：没有 debug，不能出现属性/摇摆/分数。
const plain = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});
const sp = await plain.newPage();
await sp.goto(base + '/?autostart=1', { waitUntil: 'domcontentloaded' });
await sp.waitForTimeout(1200);
const posed = await sp.evaluate(() => window.__demoPose && window.__demoPose('burst'));
assert(posed && posed.scene === 'burst', '摆拍失败 ' + JSON.stringify(posed));
await sp.waitForTimeout(500);
await sp.screenshot({ path: path.join(OUT, 'settlement-no-numbers.png') });
const dbgHidden = await sp.evaluate(() => {
  const el = document.getElementById('touch-debug');
  return !el || el.hidden;
});
assert(dbgHidden, '没有 debug 时不该显示触摸调试条');
console.log('PASS settlement pose', posed && posed.text);

// 真实比赛里的一次球权变化，t=0 / 1.5s / 3s。
const live = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
});
const lp = await live.newPage();
await lp.goto(base + '/?debug=1&autostart=1', { waitUntil: 'domcontentloaded' });
await lp.waitForFunction(() => {
  const ids = Object.keys(window.__matches || {});
  return ids.length && window.__matches[ids[0]].phase === 'play';
}, null, { timeout: 15000 });
await lp.keyboard.press('d');
await lp.waitForTimeout(4300);
const seen = await lp.evaluate(() => {
  var m = window.__matches[Object.keys(window.__matches)[0]];
  m.destroy();
  function owner() {
    var id = m.ball.ownerId;
    return id && m.byId[id] ? m.byId[id].team : null;
  }
  function pick() {
    var d = m.decision;
    if (!d) return;
    if (d.kind === 'gk-distribute') { try { m.applyCommand(d.playerId, 'gk-punt'); } catch (e) { m.phase = 'play'; m.decision = null; } return; }
    if (d.kind === 'qte') { try { m.strikePenalty(m.byId[d.playerId], { mark: 0.5 }); } catch (e) {} if (m.phase === 'decision') { m.phase = 'play'; m.decision = null; } return; }
    var leaf = null;
    function consider(o) {
      if (!o || !o.enabled || leaf) return;
      if (o.moves || o.skills || o.shots) {
        (o.moves || []).concat(o.skills || []).concat(o.shots || []).forEach(consider);
        return;
      }
      leaf = o;
    }
    (d.options || []).forEach(consider);
    if (!leaf) { m.phase = 'play'; m.decision = null; return; }
    var p = m.byId[d.playerId];
    var params = (p && (leaf.id === 'pass' || d.kind === 'setpiece')) ? { aimX: p.x + (p.team === 'home' ? 16 : -16), aimY: p.y, technique: 'inside', height: 'mid' } : null;
    try { m.applyCommand(d.playerId, leaf.id, params); } catch (e) { m.phase = 'play'; m.decision = null; }
  }
  function release() {
    if (m.overlayUntilWall || m.pendingOutcome) {
      m.overlayUntilWall = 0;
      m.releaseFreeze();
    }
  }
  window.__stepMatch = function (n) {
    for (var s = 0; s < n; s++) {
      release();
      if (m.decision || m.phase === 'decision') pick();
      m.control.activeStamp = -1e15;
      m.control.dx = 0;
      m.control.dy = 0;
      m.tick();
    }
    if (m.lastAction && m.lastAction.cut) m.lastAction = null;
  };
  var prev = null, prevOpen = false;
  for (var i = 0; i < 20000; i++) {
    if (m.decision || m.phase === 'decision') pick();
    var before = owner();
    var beforeOpen = m.phase === 'play' && !m.restart;
    release();
    var mid = owner();
    m.control.activeStamp = -1e15;
    m.control.dx = 0;
    m.control.dy = 0;
    m.tick();
    var team = owner();
    var open = m.phase === 'play' && !m.restart;
    var flipped = (before && mid && before !== mid) || (before && team && before !== team);
    if (open && beforeOpen && prevOpen && flipped) {
      if (m.lastAction && m.lastAction.cut) m.lastAction = null;
      return { changed: true, team: team || mid, prev: before, phase: m.phase, x: +m.ball.x.toFixed(1), y: +m.ball.y.toFixed(1), tick: i };
    }
    if (open) { prev = team; prevOpen = true; }
    else prevOpen = false;
    if (m.phase === 'fulltime') break;
  }
  return { changed: false, phase: m.phase, x: +m.ball.x.toFixed(1) };
});
assert(seen && seen.changed, '没有等到公开比赛里的球权变化 ' + JSON.stringify(seen));
await lp.waitForTimeout(280);
await lp.screenshot({ path: path.join(OUT, 'transition-0.png') });
await lp.evaluate(() => window.__stepMatch(15));
await lp.waitForTimeout(280);
await lp.screenshot({ path: path.join(OUT, 'transition-1.5.png') });
await lp.evaluate(() => window.__stepMatch(15));
await lp.waitForTimeout(280);
await lp.screenshot({ path: path.join(OUT, 'transition-3.png') });
fs.writeFileSync(path.join(OUT, 'transition-note.json'), JSON.stringify(seen, null, 2));
console.log('PASS transition', JSON.stringify(seen));

await browser.close();
server.close();
console.log('ALL PHONE OWNER CHECKS PASSED');
