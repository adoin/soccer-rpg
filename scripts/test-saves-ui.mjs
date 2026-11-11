// 存档槽：迁移旧档、新建、赛后存入手动 2、重载读取、删除。桌面 / 844x390 / 844x320。
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
async function shots(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, name) });
}
async function press(page, key, n) {
  for (let i = 0; i < (n || 1); i++) await page.keyboard.press(key);
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
  await page.goto(base + '/?debug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    var save = Career.newCareer(42);
    save.budget = 11111;
    localStorage.clear();
    localStorage.setItem('soccer-rpg-career', JSON.stringify(save));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await shots(page, 'save-title-' + name + '.png');
  const mig = await page.evaluate(() => {
    var auto = Career.listSlots().filter(function (s) { return s.slot === 'auto'; })[0];
    return {
      budget: auto && auto.career && auto.career.budget,
      club: auto && auto.summary && auto.summary.clubName,
      when: auto && auto.savedAt,
      legacy: localStorage.getItem('soccer-rpg-career'),
      damaged: !!(auto && auto.damaged),
    };
  });
  assert(mig.budget === 11111 && mig.club === '河畔业余' && mig.legacy == null && !mig.damaged && mig.when > 0, name + ' 旧档没迁进自动存档 ' + JSON.stringify(mig));
  await press(page, 's', 3);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().titleView === 'load');
  await shots(page, 'save-migrated-' + name + '.png');
  await page.keyboard.press('q');
  await page.waitForFunction(() => window.__touchState().titleView === 'main');

  await press(page, 's', 2);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().titleView === 'new');
  await shots(page, 'save-new-' + name + '.png');
  await press(page, 's', 2);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__career && window.__career.clubId === 'riverside' && window.__touchState().screen === 'career');

  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const ids = Object.keys(window.__matches || {});
    return ids.length && window.__matches[ids[0]].phase;
  }, null, { timeout: 8000 });
  const phase = await fastForward(page);
  assert(phase === 'fulltime', name + ' 比赛没踢完 ' + phase);
  await page.waitForFunction(() => window.__career && window.__career.results && window.__career.results.length >= 1);
  const hinted = await page.evaluate(() => window.__touchState().hint);
  assert(!hinted, name + ' 全场还挂着提示 ' + hinted);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().screen === 'career' && window.__touchState().careerView === 'hub');

  await press(page, 's', 6);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().careerView === 'files');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().careerView === 'save' && window.__touchState().saveMode === 'save');
  await shots(page, 'save-list-' + name + '.png');
  await press(page, 's', 2);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().careerView === 'save-ask');
  await shots(page, 'save-overwrite-' + name + '.png');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().careerView === 'hub');
  const saved = await page.evaluate(() => {
    var slot = Career.readSlot(null, '2');
    return { ok: slot.ok, n: slot.career && slot.career.results.length, when: slot.savedAt, round: slot.summary && slot.summary.round, rank: slot.summary && slot.summary.rank };
  });
  assert(saved.ok && saved.n >= 1 && saved.when > 0 && saved.rank > 0, name + ' 手动 2 没存上 ' + JSON.stringify(saved));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await press(page, 's', 3);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().titleView === 'load');
  await shots(page, 'save-load-' + name + '.png');
  await page.keyboard.press('s');
  await page.waitForFunction(() => window.__touchState().slotFocus === '2');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__career && window.__career.results && window.__career.results.length >= 1 && window.__touchState().screen === 'career');

  await press(page, 's', 6);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().careerView === 'files');
  await press(page, 's', 2);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().saveMode === 'delete');
  await page.keyboard.press('s');
  await page.waitForFunction(() => window.__touchState().slotFocus === '2');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().careerView === 'save-ask');
  await shots(page, 'save-delete-' + name + '.png');
  await page.keyboard.press('Enter');
  const gone = await page.evaluate(() => Career.readSlot(null, '2'));
  assert(gone.empty, name + ' 手动 2 没删掉 ' + JSON.stringify(gone));
  if (logs.length) console.log(name, 'pageerrors', logs.join(' | '));
  console.log('PASS', name, 'migrated budget', mig.budget, 'slot2', JSON.stringify(saved));
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
console.log('ALL SAVE UI CHECKS PASSED');
