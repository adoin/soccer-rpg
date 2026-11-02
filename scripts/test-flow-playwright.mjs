// 结算先于开球、球门球限制、高球、门将持球、裁判走动、主罚名单。
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const playwright = (() => {
  try { return require('playwright'); }
  catch (e) { return require('/tmp/pw/node_modules/playwright'); }
})();
const { chromium } = playwright;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, '..', 'docs');
const OUT = '/opt/cursor/artifacts';

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
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

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });

async function openPage(viewport, mobile) {
  const ctx = await browser.newContext({
    viewport: viewport,
    hasTouch: !!mobile,
    isMobile: !!mobile,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__M = function () { return window.__matches[Object.keys(window.__matches)[0]]; };
  });
  await page.goto(base + '/?debug=1&autostart=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const ids = Object.keys(window.__matches || {});
    return ids.length && window.__matches[ids[0]].phase === 'play';
  }, null, { timeout: 15000 });
  return page;
}
async function shot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log('SHOT', file);
  return file;
}
async function settle(page) {
  await page.waitForTimeout(450);
}

const desk = await openPage({ width: 1280, height: 720 }, false);

const goalInfo = await desk.evaluate(() => {
  const m = window.__M();
  m.setPaused(true);
  m.goal(m.byId.h9, 'home');
  m.setPaused(false);
  return { phase: m.phase, overlay: m.overlayUntil > m.now, action: m.lastAction && m.lastAction.kind };
});
assert(goalInfo.phase === 'goal' && goalInfo.overlay && goalInfo.action === 'goal', '进球没有先冻住 ' + JSON.stringify(goalInfo));
await desk.waitForTimeout(400);
const stillGoal = await desk.evaluate(() => window.__M().phase);
assert(stillGoal === 'goal', '结算画面还在时已经开球了 ' + stillGoal);
await shot(desk, 'goal-overlay-before-kickoff.png');
await desk.waitForFunction(() => window.__M().phase === 'kickoff' || window.__M().phase === 'play', null, { timeout: 8000 });
const afterGoal = await desk.evaluate(() => ({ phase: window.__M().phase, overlay: window.__M().overlayUntil > window.__M().now }));
assert(afterGoal.phase === 'kickoff' || (afterGoal.phase === 'play' && !afterGoal.overlay), '画面结束后才开球 ' + JSON.stringify(afterGoal));
console.log('PASS goal overlay before kickoff', JSON.stringify(afterGoal));

await desk.evaluate(() => {
  const m = window.__M();
  m.setPaused(true);
  m.decision = null;
  m.lastAction = null;
  m.overlayUntil = m.now;
  m.ball.x = 106; m.ball.y = 20; m.ball.vx = 0; m.ball.vy = 0; m.ball.vz = 0; m.ball.z = 0;
  m.ball.lastTouchTeam = 'home';
  m.whistleGoalKick('away');
  m.overlayUntil = m.now;
  m.lastAction = null;
  m.phase = 'play';
  m.restart.readyAt = m.now + 20000;
  m.players.forEach(function (p) {
    if (p.team === 'home') { p.x = 97; p.y = 22 + (p.num % 6) * 5; }
  });
});
await settle(desk);
await shot(desk, 'goalkick-waiting-inside.png');
const waiting = await desk.evaluate(() => {
  const m = window.__M();
  const inside = m.players.filter(function (p) { return p.team === 'home' && p.x > 105 - 16.5; }).length;
  return { inside: inside, owner: m.ball.ownerId, z: m.ball.z, vz: m.ball.vz };
});
assert(waiting.inside > 0 && waiting.owner === 'a1' && waiting.vz < 1, '等待画面里人已经出去或球已经开了 ' + JSON.stringify(waiting));
console.log('PASS humans still inside before the kick', JSON.stringify(waiting));

const lofted = await desk.evaluate(() => {
  const m = window.__M();
  m.players.forEach(function (p) { if (p.team === 'home') p.x = 97; });
  m.restart.readyAt = Math.max(1, m.now - 2000);
  m.setPaused(false);
  var guard = 0;
  while (m.ball.ownerId && guard++ < 6) m.tick();
  const inside = m.players.filter(function (p) { return p.team === 'home' && m.inPenaltyArea(p.x, p.y, 'away'); }).length;
  m.players.forEach(function (p) { p.frozenUntil = m.now + 99999; });
  for (var i = 0; i < 6; i++) m.tick();
  m.setPaused(true);
  return {
    inside: inside,
    owner: m.ball.ownerId,
    z: m.ball.z,
    vz: m.ball.vz,
    phase: m.phase,
  };
});
assert(lofted.inside === 0 && !lofted.owner && lofted.z > 2, '球门球没有等高球或人还在禁区 ' + JSON.stringify(lofted));
await settle(desk);
await shot(desk, 'goalkick-lofted.png');
console.log('PASS lofted goal kick after box clear', JSON.stringify(lofted));

const hold = await desk.evaluate(() => {
  const m = window.__M();
  m.setPaused(true);
  m.decision = null;
  m.restart = null;
  m.phase = 'play';
  m.overlayUntil = m.now;
  m.lastAction = null;
  m.players.forEach(function (p) {
    if (p.team === 'home') { p.x = 40; p.y = 8 + p.num * 4; }
    else if (p.pos !== 'GK') { p.x = 70; p.y = 8 + (p.num % 8) * 6; }
  });
  m.byId.a1.x = 55; m.byId.a1.y = 34;
  m.ball.ownerId = 'a1'; m.ball.x = 55; m.ball.y = 34; m.ball.z = 0; m.ball.vx = 0; m.ball.vy = 0; m.ball.vz = 0;
  m.beginKeeperHold(m.byId.a1);
  m.lastAction = null;
  m.decision = null;
  return { x: m.byId.a1.x, y: m.byId.a1.y, holding: !!m.byId.a1.gkHolding, owner: m.ball.ownerId, z: m.ball.z };
});
assert(hold.holding && hold.owner === 'a1' && hold.x > 88.5, '门将抱球后还在中场 ' + JSON.stringify(hold));
await settle(desk);
await shot(desk, 'gk-hold-in-box.png');
const distributed = await desk.evaluate(() => {
  const m = window.__M();
  m.setPaused(false);
  var i = 0;
  while (m.ball.ownerId === 'a1' && i++ < 20) m.tick();
  m.setPaused(true);
  return { x: m.byId.a1.x, owner: m.ball.ownerId, z: m.ball.z, phase: m.phase, i: i };
});
assert(distributed.x > 88.5 && distributed.owner !== 'a1', '门将出球后还抱着球冲出来 ' + JSON.stringify(distributed));
await settle(desk);
await shot(desk, 'gk-distribute.png');
console.log('PASS keeper holds then distributes', JSON.stringify(hold), JSON.stringify(distributed));

const ref0 = await desk.evaluate(() => {
  const m = window.__M();
  m.setPaused(true);
  m.decision = null;
  m.restart = null;
  m.phase = 'play';
  m.overlayUntil = m.now;
  m.lastAction = null;
  m.players.forEach(function (p) {
    if (p.id !== 'h10') { p.x = 90; p.y = 6 + (p.num % 10) * 5; }
  });
  m.ball.ownerId = 'h10'; m.ball.x = 52; m.ball.y = 34; m.ball.z = 0; m.ball.vx = 0; m.ball.vy = 0;
  m.byId.h10.x = 52; m.byId.h10.y = 34;
  m.refereePos = { x: 18, y: 8 };
  var i;
  for (i = 0; i < 50; i++) m.stepReferee(0.1);
  m.decision = null;
  var dx = m.refereePos.x - 18, dy = m.refereePos.y - 8;
  return {
    x: m.refereePos.x, y: m.refereePos.y,
    moved: Math.hypot(dx, dy),
    ball: Math.hypot(m.refereePos.x - m.ball.x, m.refereePos.y - m.ball.y),
  };
});
assert(ref0.moved > 8 && ref0.ball > 8 && ref0.ball < 28, '裁判没有走到球附近 ' + JSON.stringify(ref0));
await settle(desk);
await shot(desk, 'referee-moved.png');
console.log('PASS referee moved', JSON.stringify(ref0));

async function poseMenu(page, kind) {
  await page.evaluate((kind) => {
    const m = window.__M();
    m.setPaused(true);
    m.decision = null;
    m.lastAction = null;
    m.overlayUntil = m.now;
    m.phase = 'play';
    if (kind === 'corner') {
      m.ball.x = 104; m.ball.y = 6; m.ball.lastTouchTeam = 'away';
      m.whistleCorner('home');
    } else if (kind === 'foul') {
      m.byId.h10.x = 70; m.byId.h10.y = 34;
      m.byId.a4.x = 71.1; m.byId.a4.y = 34;
      m.ball.ownerId = 'h10'; m.ball.x = 70; m.ball.y = 34;
      const f = {
        defender: m.byId.a4, victim: m.byId.h10, team: 'home',
        spot: { x: 70, y: 34 }, card: 'none', penalty: false, advantage: false, severity: 30,
      };
      m.applyFoulResult(f);
    } else {
      m.setupPenalty({
        defender: m.byId.a4, victim: m.byId.h10, team: 'home',
        spot: { x: 94, y: 34 }, card: 'none', penalty: true, advantage: false,
      }, '');
    }
    m.lastAction = null;
    m.overlayUntil = m.now;
    m.setPaused(true);
  }, kind);
  await page.waitForFunction((kind) => {
    const m = window.__M();
    const ui = window.__touchState && window.__touchState();
    return m.decision && m.decision.kind === 'taker' && m.decision.setpiece === kind && ui && ui.menu;
  }, kind === 'foul' ? 'foul' : kind, { timeout: 4000 });
}

const cornerMenu = await (async () => {
  await poseMenu(desk, 'corner');
  await settle(desk);
  return desk.evaluate(() => {
    const m = window.__M();
    const o = m.decision.options[0];
    const ui = window.__touchState();
    return { sub: o.sub, id: o.id, sel: ui.stack, n: m.decision.options.length };
  });
})();
assert(cornerMenu.sub.indexOf('角球') >= 0 && cornerMenu.sub.indexOf('长传') >= 0 && cornerMenu.sub.indexOf('传中') >= 0, '角球菜单属性不对 ' + cornerMenu.sub);
assert(cornerMenu.sel.indexOf('#0') >= 0, '角球光标不在第一名 ' + cornerMenu.sel);
await shot(desk, 'taker-corner.png');
console.log('PASS corner menu', JSON.stringify(cornerMenu));

await poseMenu(desk, 'foul');
await settle(desk);
const fkMenu = await desk.evaluate(() => window.__M().decision.options[0].sub);
assert(fkMenu.indexOf('射门') >= 0 && fkMenu.indexOf('长传') >= 0 && fkMenu.indexOf('任意球') >= 0, '任意球菜单属性不对 ' + fkMenu);
await shot(desk, 'taker-freekick.png');
console.log('PASS free kick menu', fkMenu);

await poseMenu(desk, 'penalty');
await settle(desk);
const pkMenu = await desk.evaluate(() => window.__M().decision.options[0].sub);
assert(pkMenu.indexOf('射门') >= 0 && pkMenu.indexOf('心理') >= 0, '点球菜单属性不对 ' + pkMenu);
await shot(desk, 'taker-penalty.png');
console.log('PASS penalty menu', pkMenu);

const phone = await openPage({ width: 844, height: 390 }, true);
await poseMenu(phone, 'corner');
await settle(phone);
await shot(phone, 'taker-corner-mobile.png');
await poseMenu(phone, 'foul');
await settle(phone);
await shot(phone, 'taker-freekick-mobile.png');
await poseMenu(phone, 'penalty');
await settle(phone);
await shot(phone, 'taker-penalty-mobile.png');
const phoneMenu = await phone.evaluate(() => {
  const m = window.__M();
  return { sub: m.decision.options[0].sub, piece: m.decision.setpiece };
});
assert(phoneMenu.piece === 'penalty' && phoneMenu.sub.indexOf('射门') >= 0, '手机点球菜单不对 ' + JSON.stringify(phoneMenu));
console.log('PASS mobile taker menus', JSON.stringify(phoneMenu));

await browser.close();
server.close();
console.log('ALL FLOW CHECKS PASSED');
