// 菜单冻结、突破结算顺序、阵型截图。
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
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.js')) return 'text/javascript';
  if (p.endsWith('.css')) return 'text/css';
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
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });

async function openPage(viewport, mobile) {
  const ctx = await browser.newContext({ viewport, hasTouch: !!mobile, isMobile: !!mobile });
  const page = await ctx.newPage();
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
}

const desk = await openPage({ width: 1280, height: 720 }, false);
await desk.keyboard.press('KeyE');
await desk.waitForFunction(() => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  return m.decision && m.decision.voluntary;
}, null, { timeout: 5000 });
const before = await desk.evaluate(() => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  return {
    ref: { x: m.refereePos.x, y: m.refereePos.y },
    p: m.players.map(function (q) { return [q.id, q.x, q.y]; }),
    ball: [m.ball.x, m.ball.y],
    now: m.now,
  };
});
await desk.waitForTimeout(3000);
const after = await desk.evaluate(() => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  return {
    ref: { x: m.refereePos.x, y: m.refereePos.y },
    p: m.players.map(function (q) { return [q.id, q.x, q.y]; }),
    ball: [m.ball.x, m.ball.y],
    now: m.now,
    dec: !!m.decision,
  };
});
assert(after.dec, '菜单自己关了');
assert(after.now === before.now, '菜单开着时钟还在走 ' + before.now + ' -> ' + after.now);
assert(Math.hypot(after.ref.x - before.ref.x, after.ref.y - before.ref.y) < 0.05, '菜单开着裁判还在动');
assert(after.ball[0] === before.ball[0] && after.ball[1] === before.ball[1], '菜单开着球还在动');
let moved = 0;
after.p.forEach(function (row, i) {
  if (Math.hypot(row[1] - before.p[i][1], row[2] - before.p[i][2]) > 0.05) moved++;
});
assert(moved === 0, '菜单开着有人在动 ' + moved);
console.log('PASS menu freezes referee players ball and clock');
await desk.keyboard.press('Escape');

async function duelShot(page, name, kind) {
  const info = await page.evaluate((kind) => {
    const m = window.__matches[Object.keys(window.__matches)[0]];
    m.setPaused(true);
    m.decision = null;
    m.overlayUntilWall = 0;
    m.overlayUntil = 0;
    m.pendingOutcome = null;
    m.phase = 'play';
    m.lastAction = null;
    m.players.forEach(function (p) { p.x = p.team === 'home' ? 30 : 80; p.y = 8 + p.num * 3; });
    const att = kind === 'tackle' ? m.byId.a10 : m.byId.h10;
    const def = kind === 'tackle' ? m.byId.h4 : m.byId.a4;
    att.x = 50; att.y = 34;
    def.x = kind === 'tackle' ? 48.2 : 52; def.y = 34;
    m.ball.ownerId = att.id; m.ball.x = att.x; m.ball.y = att.y; m.ball.z = 0;
    const x0 = att.x;
    if (kind === 'tackle') {
      m.resolveDefSkill(def, att, { id: 'def-sweep', name: '横扫千军', cost: 7, reach: 5.5, power: 13, foul: 0, cut: 'def-skill-sweep' });
    } else {
      m.resolveAction(att, 'dribble', 80);
    }
    return {
      x: att.x, x0: x0,
      duel: !!(m.lastAction && m.lastAction.duel),
      label: m.lastAction && m.lastAction.duel && m.lastAction.duel.atkLabel,
      result: m.lastAction && m.lastAction.duel && m.lastAction.duel.result,
      pending: !!m.pendingOutcome,
    };
  }, kind);
  assert(info.duel && info.pending && info.x === info.x0, name + ' 结算前人不该动 ' + JSON.stringify(info));
  await page.waitForTimeout(400);
  await shot(page, name);
  const done = await page.evaluate(() => {
    const m = window.__matches[Object.keys(window.__matches)[0]];
    const id = m.ball.ownerId;
    const x = m.byId.h10.x;
    const beat0 = m.byId.h4.beatenUntil || 0;
    m.finishSettlement();
    return {
      x0: x, x: m.byId.h10.x, owner: m.ball.ownerId, was: id,
      cut: m.lastAction && m.lastAction.cut,
      text: m.lastAction && m.lastAction.text,
      beat: (m.byId.h4.beatenUntil || 0) !== beat0,
    };
  });
  assert(done.x !== done.x0 || done.owner !== done.was || done.beat || (done.text && done.text !== info.result), name + ' 结算后没有产生结果 ' + JSON.stringify(done));
  console.log('PASS', name, JSON.stringify(info), JSON.stringify(done));
}

await duelShot(desk, 'duel-breakthrough.png', 'dribble');
await duelShot(desk, 'duel-tackle.png', 'tackle');

const phone = await openPage({ width: 844, height: 390 }, true);
await duelShot(phone, 'duel-breakthrough-mobile.png', 'dribble');
await duelShot(phone, 'duel-tackle-mobile.png', 'tackle');

const shape = await desk.evaluate(() => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  m.setPaused(true);
  m.decision = null; m.pendingOutcome = null; m.overlayUntilWall = 0; m.overlayUntil = m.now;
  m.phase = 'play'; m.nextDecisionAt = 1e15; m.aiCooldownUntil = 1e15;
  m.players.forEach(function (p, i) { p.x = p.hx; p.y = p.hy; });
  m.ball.ownerId = 'h10'; m.ball.x = 70; m.ball.y = 34; m.byId.h10.x = 70; m.byId.h10.y = 34;
  var i;
  for (i = 0; i < 40; i++) m.simulate(0.1);
  return { anchors: m.players.filter(function (p) { return p._anchor; }).length };
});
await desk.waitForTimeout(300);
await shot(desk, 'shape-attack.png');
await desk.evaluate(() => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  m._possessTeam = 'home';
  m.ball.ownerId = 'a10'; m.ball.x = 62; m.ball.y = 30;
  m.byId.a10.x = 62; m.byId.a10.y = 30;
  m._lastCarrierId = 'h10';
  m.simulate(0.1);
  var i;
  for (i = 0; i < 18; i++) m.simulate(0.1);
});
await desk.waitForTimeout(250);
await shot(desk, 'shape-transition.png');
console.log('PASS shape screenshots', JSON.stringify(shape));

await browser.close();
server.close();
console.log('ALL DUEL SHAPE CHECKS PASSED');
