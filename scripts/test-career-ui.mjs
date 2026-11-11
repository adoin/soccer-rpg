// 浏览器里走一遍业余联赛：开档、转会、比赛、积分、读档。桌面和横屏短视口。
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
    const scale = Math.min(rect.width / W, rect.height / H) || 1;
    const offX = (rect.width - W * scale) / 2;
    const offY = (rect.height - H * scale) / 2;
    return { x: rect.left + offX + x * scale, y: rect.top + offY + y * scale };
  }, { x, y });
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
async function tap(page, x, y) {
  const p = await screenOf(page, x, y);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(200);
}
function makeTouch(page) {
  let cdp = null;
  return {
    async init() { cdp = await page.context().newCDPSession(page); },
    async send(type, points) {
      await cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y), id: pt.id })),
      });
    },
  };
}

async function nudgeCursorOffClub(page) {
  for (let i = 0; i < 4; i++) {
    const onOwn = await page.evaluate(() => {
      const t = window.__touchState();
      if (!t || t.careerView !== 'table') return false;
      const ranked = window.Career.ranked(window.__career);
      const row = ranked[t.menuSel];
      return !!(row && row.teamId === window.__career.clubId);
    });
    if (!onOwn) return;
    await page.keyboard.press('s');
    await page.waitForTimeout(80);
  }
}

async function fastForward(page) {
  return await page.evaluate(() => {
    var m = window.__matches[Object.keys(window.__matches)[0]];
    m.destroy();
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
      var pl = m.byId[d.playerId];
      var params = (pl && (leaf.id === 'pass' || d.kind === 'setpiece')) ? { aimX: pl.x + 12, aimY: pl.y, technique: 'inside', height: 'mid' } : null;
      try { m.applyCommand(d.playerId, leaf.id, params); } catch (e) { m.phase = 'play'; m.decision = null; }
    }
    for (var i = 0; i < 20000 && m.phase !== 'fulltime'; i++) {
      if (m.decision || m.phase === 'decision') pick();
      if (m.overlayUntilWall || m.pendingOutcome) { m.overlayUntilWall = 0; m.releaseFreeze(); }
      m.tick();
    }
    return m.phase;
  });
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });

async function run(name, viewport, touchMode) {
  const ctx = await browser.newContext({
    viewport: viewport,
    deviceScaleFactor: touchMode ? 2 : 1,
    isMobile: !!touchMode,
    hasTouch: !!touchMode,
    userAgent: touchMode
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on('pageerror', (e) => logs.push(e.message));
  const touch = makeTouch(page);
  await page.goto(base + '/?debug=1', { waitUntil: 'domcontentloaded' });
  if (touchMode) await touch.init();
  await page.waitForTimeout(700);
  await page.keyboard.press('s'); // 继续是灰的，会落到新建生涯
  await page.keyboard.press('Enter'); // 新建生涯
  await page.waitForFunction(() => window.__touchState().titleView === 'new');
  await page.keyboard.press('Enter'); // 空的自动存档
  await page.waitForFunction(() => window.__career && window.__career.clubId === 'riverside', null, { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'career-hub-' + name + '.png') });
  const info = await page.evaluate(() => {
    var s = window.__career;
    var cup = s.calendar.fixtures.filter(function (f) { return f.competitionId === 'example-cup'; }).length;
    var post = s.calendar.fixtures.filter(function (f) { return f.postponed; }).length;
    var maxStat = 0;
    s.squad.forEach(function (p) {
      ['pace', 'passing', 'tackling', 'finishing'].forEach(function (k) {
        if (p.stats[k] > maxStat) maxStat = p.stats[k];
      });
    });
    return { budget: s.budget, squad: s.squad.length, cup: cup, post: post, maxStat: maxStat, mods: window.Career.listMods().map(function (m) { return m.id; }) };
  });
  assert(info.cup === 1 && info.post >= 1, name + ' 示例杯赛没有推迟联赛 ' + JSON.stringify(info));
  assert(info.maxStat <= 8, name + ' 能力不像业余 ' + info.maxStat);
  assert(info.mods.indexOf('amateur-league') >= 0 && info.mods.indexOf('example-cup') >= 0, name + ' mod 没注册');

  await page.keyboard.press('s');
  await page.keyboard.press('s');
  await page.keyboard.press('s');
  await page.keyboard.press('Enter'); // 积分榜
  await page.waitForFunction(() => window.__touchState().careerView === 'table');
  await nudgeCursorOffClub(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'career-table-' + name + '.png') });
  await page.keyboard.press('q');
  await page.waitForTimeout(150);
  await page.keyboard.press('s'); // 从开踢到阵容（sel 回到 0 后按一次）
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().careerView === 'squad');
  await page.keyboard.press('s');
  await page.keyboard.press('s');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'career-squad-' + name + '.png') });
  await page.keyboard.press('q');
  await page.waitForTimeout(150);

  const before = await page.evaluate(() => ({ budget: window.__career.budget, n: window.__career.squad.length }));
  for (let i = 0; i < 4; i++) await page.keyboard.press('s'); // 转会
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'career-market-' + name + '.png') });
  await page.keyboard.press('Enter'); // 买第一人
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({ budget: window.__career.budget, n: window.__career.squad.length }));
  assert(after.n === before.n + 1 && after.budget < before.budget, name + ' 转会没成交 ' + JSON.stringify(before) + ' ' + JSON.stringify(after));

  await page.keyboard.press('q');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter'); // sel 0 开踢
  await page.waitForFunction(() => {
    const ids = Object.keys(window.__matches || {});
    return ids.length && window.__matches[ids[0]].phase;
  }, null, { timeout: 8000 });
  await page.waitForTimeout(400);
  const names = await page.evaluate(() => {
    const m = window.__matches[Object.keys(window.__matches)[0]];
    const pace = m.byId.h9 ? m.byId.h9.stats.pace : null;
    return { home: m.homeName, away: m.awayName, pace: pace };
  });
  assert(names.home === '河畔业余', name + ' 比赛没用生涯队名 ' + JSON.stringify(names));
  assert(names.pace != null && names.pace <= 8, name + ' 比赛没用业余能力 ' + names.pace);
  await page.screenshot({ path: path.join(OUT, 'career-match-' + name + '.png') });
  const phase = await fastForward(page);
  assert(phase === 'fulltime', name + ' 比赛没踢完 ' + phase);
  await page.waitForFunction(() => window.__career && window.__career.results && window.__career.results.length >= 1, null, { timeout: 5000 });
  const ft = await page.evaluate(() => window.__touchState());
  assert(ft.phase === 'fulltime', name + ' 全场阶段丢了 ' + JSON.stringify(ft));
  assert(!ft.hint, name + ' 全场还挂着提示 ' + ft.hint);
  await page.screenshot({ path: path.join(OUT, 'career-fulltime-' + name + '.png') });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().screen === 'career', null, { timeout: 4000 });
  await page.keyboard.press('s');
  await page.keyboard.press('s');
  await page.keyboard.press('s');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const t = window.__touchState();
    return t.screen === 'career' && t.careerView === 'table' &&
      window.__career.table.some(function (r) { return r.teamId === 'riverside' && r.p >= 1; });
  }, null, { timeout: 4000 });
  await nudgeCursorOffClub(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'career-table-after-' + name + '.png') });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.keyboard.press('s');
  await page.keyboard.press('Enter'); // 继续（最近存档）
  await page.waitForFunction(() => window.__career && window.__career.results && window.__career.results.length >= 1, null, { timeout: 5000 });
  await page.screenshot({ path: path.join(OUT, 'career-continue-' + name + '.png') });
  if (logs.length) console.log(name, 'pageerrors', logs.join(' | '));
  console.log('PASS', name, JSON.stringify(names), 'budget', before.budget, '->', after.budget);
  await ctx.close();
}

try {
  await run('desktop', { width: 1280, height: 720 }, false);
  await run('phone', { width: 844, height: 390 }, true);
  await run('short', { width: 844, height: 320 }, true);
} catch (err) {
  console.error('FAIL', err.stack || err.message);
  await browser.close();
  server.close();
  process.exit(1);
}
await browser.close();
server.close();
console.log('ALL CAREER UI CHECKS PASSED');
