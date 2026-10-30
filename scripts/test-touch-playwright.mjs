// 手机触控：Playwright 真实触摸（hasTouch + isMobile）。
// Chromium 用 CDP Input.dispatchTouchEvent。
// WebKit 用浏览器协议 Input.dispatchTouchEvent（经 touchscreen.tap(-1,-1) 转发）。
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const playwright = (() => {
  try { return require('playwright'); }
  catch (e) { return require('/tmp/pw/node_modules/playwright'); }
})();
const { chromium, webkit } = playwright;
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const OUT = '/opt/cursor/artifacts';
const GESTURE = '/tmp/touch-gesture.json';

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

function makeTouch(page, browserName) {
  let cdp = null;
  return {
    async init() {
      if (browserName === 'chromium') cdp = await page.context().newCDPSession(page);
      await page.evaluate(() => {
        window.__trusted = [];
        window.__trace = [];
        function note(e) {
          var changed = [], rest = [];
          if (e.changedTouches) for (var i = 0; i < e.changedTouches.length; i++) changed.push(e.changedTouches[i].identifier);
          if (e.touches) for (var j = 0; j < e.touches.length; j++) rest.push(e.touches[j].identifier);
          window.__trusted.push({ type: e.type, trusted: e.isTrusted, changed: changed, rest: rest });
          if (window.__trusted.length > 50) window.__trusted.shift();
        }
        document.addEventListener('touchstart', note, { capture: true });
        document.addEventListener('touchmove', note, { capture: true });
        document.addEventListener('touchend', note, { capture: true });
        document.addEventListener('pointermove', note, { capture: true });
      });
    },
    async send(type, points) {
      const touchPoints = points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), id: p.id }));
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
        return;
      }
      fs.writeFileSync(GESTURE, JSON.stringify([{ type, touchPoints }]));
      await page.touchscreen.tap(-1, -1);
    },
  };
}

async function waitPlay(page) {
  await page.waitForFunction(() => {
    const ids = Object.keys(window.__matches || {});
    return ids.length && window.__matches[ids[0]].phase === 'play' && window.__touchState;
  }, null, { timeout: 15000 });
}

async function matchInfo(page) {
  return page.evaluate(() => {
    const m = window.__matches[Object.keys(window.__matches)[0]];
    const id = m.control.playerId;
    const p = m.byId[id];
    return {
      id, x: p.x, y: p.y,
      dx: m.control.dx, dy: m.control.dy,
      phase: m.phase,
      dec: m.decision ? (m.decision.kind || 'command') : null,
      ui: window.__touchState(),
      trusted: window.__trusted || [],
      trace: window.__trace || [],
    };
  });
}

async function runDevice(browserType, name, opts, base, shots) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    viewport: opts.viewport,
    userAgent: opts.userAgent,
    deviceScaleFactor: opts.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const logs = [];
  page.on('pageerror', (e) => logs.push('PAGE ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') logs.push('CON ' + m.text()); });
  const touch = makeTouch(page, browserType.name());
  try {
    await page.goto(base + '/?debug=1&autostart=1', { waitUntil: 'domcontentloaded' });
    await touch.init();
    const prompt = await page.locator('#rotate-prompt').evaluate((el) => getComputedStyle(el).display);
    assert(prompt === 'none', name + ' 横屏仍显示请横屏: ' + prompt);
    const touchOn = await page.evaluate(() => window.isTouch === true && /touch-keys-v1/.test(document.documentElement.innerHTML + '') || true);
    const marker = await page.evaluate(() => {
      const s = document.querySelector('script[src*="main.js"]');
      return s ? s.src : '';
    });
    const bodyHas = await page.evaluate(() => document.documentElement.outerHTML.includes('touch-keys-v1') || true);
    void touchOn; void bodyHas; void marker;
    const code = await page.evaluate(async () => {
      const src = document.querySelector('script[src*="main.js"]').src;
      const t = await (await fetch(src)).text();
      return t.includes('touch-keys-v1');
    });
    assert(code, name + ' 页面没有新的触控代码');
    await waitPlay(page);
    const layout = await page.evaluate(() => window.__touchLayout());
    const keys = layout.keys.map((k) => k.key);
    assert(keys.indexOf('k') < 0 && keys.indexOf('j') < 0, name + ' 触控不应有加速或减速键 ' + keys.join(','));
    assert(layout.keys.some((k) => k.key === 'e' && k.label === '确定'), name + ' 缺少确定 E');
    assert(layout.keys.some((k) => k.key === 'w'), name + ' 缺少上 W');
    assert(layout.keys.some((k) => k.key === 's'), name + ' 缺少下 S');
    assert(layout.keys.some((k) => k.key === 'q'), name + ' 缺少取消 Q');
    assert(layout.menu.y < 50 && layout.menu.x > 1000, name + ' 菜单不在角落 ' + JSON.stringify(layout.menu));

    const stick = await screenOf(page, layout.stick.x, layout.stick.y);
    const left = await screenOf(page, layout.stick.x - layout.stick.r * 0.92, layout.stick.y);
    const before = await matchInfo(page);
    await touch.send('touchStart', [{ id: 1, x: stick.x, y: stick.y }]);
    for (let i = 1; i <= 8; i++) {
      const x = Math.round(stick.x + (left.x - stick.x) * (i / 8));
      const y = Math.round(stick.y + (left.y - stick.y) * (i / 8));
      await touch.send('touchMove', [{ id: 1, x, y }]);
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(800);
    const mid = await matchInfo(page);
    assert(mid.trusted.some((e) => e.type === 'touchmove' && e.trusted === true), name + ' 没有真实 touchmove ' + JSON.stringify(mid.trusted));
    assert(mid.dx < -0.45, name + ' 拖摇杆后 dx=' + mid.dx + ' stick=' + JSON.stringify(mid.ui.stick));
    assert(mid.x < before.x - 1.2, name + ' 球员没有向左移动 ' + before.x.toFixed(2) + ' -> ' + mid.x.toFixed(2));
    await touch.send('touchEnd', [{ id: 1, x: left.x, y: left.y }]);
    await page.waitForTimeout(80);
    const released = await matchInfo(page);
    assert(Math.abs(released.dx) < 0.2, name + ' 松手后方向没归零 dx=' + released.dx);

    await page.waitForFunction(() => window.__touchState() && !window.__touchState().hint, null, { timeout: 10000 });
    await page.waitForTimeout(250);
    if (shots.hud) await page.screenshot({ path: shots.hud });

    await touch.send('touchStart', [{ id: 1, x: stick.x, y: stick.y }]);
    await touch.send('touchMove', [{ id: 1, x: left.x, y: left.y }]);
    await page.waitForTimeout(60);
    const sw = layout.keys.filter((k) => k.key === 'l')[0];
    const swp = await screenOf(page, sw.x, sw.y);
    await touch.send('touchStart', [
      { id: 1, x: left.x, y: left.y },
      { id: 2, x: swp.x, y: swp.y },
    ]);
    await page.waitForTimeout(80);
    const both = await matchInfo(page);
    assert(both.dx < -0.45, name + ' 同时按键时摇杆被清掉 dx=' + both.dx + ' ev=' + JSON.stringify(both.trusted.slice(-4)));
    await touch.send('touchEnd', [{ id: 2, x: swp.x, y: swp.y }]);
    await page.waitForTimeout(40);
    const still = await matchInfo(page);
    assert(still.dx < -0.45, name + ' 松开按键后摇杆丢了 dx=' + still.dx + ' trace=' + JSON.stringify(still.trace));
    await touch.send('touchEnd', [{ id: 1, x: left.x, y: left.y }]);
    await page.waitForTimeout(80);
    const up = await matchInfo(page);
    assert(Math.abs(up.dx) < 0.2 && Math.abs(up.dy) < 0.2, name + ' 松手后方向没归零 dx=' + up.dx + ' dy=' + up.dy);

    if (!shots.menu && !shots.full) {
      console.log('PASS', name, 'move', before.x.toFixed(2), '->', mid.x.toFixed(2), 'dx', mid.dx);
      await browser.close();
      return;
    }

    await page.evaluate(() => {
      const m = window.__matches[Object.keys(window.__matches)[0]];
      m.debugPose('menu');
    });
    await page.waitForFunction(() => {
      const s = window.__touchState();
      return s && s.menu && s.kind === 'cmds';
    }, null, { timeout: 5000 });
    await page.waitForTimeout(400);
    const down = layout.keys.filter((k) => k.key === 's')[0];
    const upKey = layout.keys.filter((k) => k.key === 'w')[0];
    const confirm = layout.keys.filter((k) => k.key === 'e')[0];
    const cancel = layout.keys.filter((k) => k.key === 'q')[0];
    async function tapKey(k) {
      const p = await screenOf(page, k.x, k.y);
      await touch.send('touchStart', [{ id: 3, x: p.x, y: p.y }]);
      await page.waitForTimeout(40);
      await touch.send('touchEnd', [{ id: 3, x: p.x, y: p.y }]);
      await page.waitForTimeout(80);
    }
    const sel0 = (await matchInfo(page)).ui.sel;
    await tapKey(down);
    const sel1 = (await matchInfo(page)).ui;
    assert(sel1.kind === 'cmds' && sel1.sel === sel0 + 1, name + ' 下键没有移动菜单 ' + sel0 + ' -> ' + JSON.stringify(sel1));
    await page.waitForTimeout(150);
    if (shots.menu) await page.screenshot({ path: shots.menu });
    await tapKey(confirm);
    await page.waitForTimeout(200);
    const aimed = (await matchInfo(page)).ui;
    assert(aimed.kind === 'aim', name + ' 确定没有进入传球落点 ' + JSON.stringify(aimed));
    await tapKey(cancel);
    await page.waitForTimeout(150);
    const back = (await matchInfo(page)).ui;
    assert(back.kind === 'cmds', name + ' 取消没有返回 ' + JSON.stringify(back));
    const beforeDbl = back.sel;
    assert(beforeDbl > 0, name + ' 连点测试需要先停在非第一项 sel=' + beforeDbl);
    const pUp = await screenOf(page, upKey.x, upKey.y);
    await touch.send('touchStart', [{ id: 4, x: pUp.x, y: pUp.y }]);
    await touch.send('touchEnd', [{ id: 4, x: pUp.x, y: pUp.y }]);
    await touch.send('touchStart', [{ id: 5, x: pUp.x, y: pUp.y }]);
    await touch.send('touchEnd', [{ id: 5, x: pUp.x, y: pUp.y }]);
    await page.waitForTimeout(120);
    const afterDbl = (await matchInfo(page)).ui.sel;
    assert(afterDbl === beforeDbl - 1, name + ' 快速连点走了多格 ' + beforeDbl + ' -> ' + afterDbl);

    await page.evaluate(() => {
      const m = window.__matches[Object.keys(window.__matches)[0]];
      const p = m.byId.h10;
      m.restart = { kind: 'penalty', team: 'home', x: 94, y: 34, takerId: p.id, label: '点球', held: false };
      m.openPenaltyQte(p, 'shot-placed');
      m.setPaused(true);
    });
    await page.waitForFunction(() => window.__touchState() && window.__touchState().dec === 'qte', null, { timeout: 5000 });
    await page.waitForTimeout(350);
    if (shots.qte) await page.screenshot({ path: shots.qte });
    await page.waitForTimeout(200);
    await tapKey(confirm);
    await page.waitForFunction(() => {
      const ids = Object.keys(window.__matches || {});
      const m = window.__matches[ids[0]];
      return m && !m.decision;
    }, null, { timeout: 5000 });
    const done = await matchInfo(page);
    assert(!done.dec, name + ' 点球确定没有结算 ' + done.dec + ' phase=' + done.phase);
    console.log('PASS', name, 'move', before.x.toFixed(2), '->', mid.x.toFixed(2), 'menu', sel0, '->', sel1.sel, 'qte', done.phase);
  } catch (err) {
    const dump = '/tmp/touch-fail-' + name + '.png';
    try { await page.screenshot({ path: dump }); } catch (e) {}
    let extra = '';
    try { extra = JSON.stringify(await matchInfo(page)); } catch (e) { extra = String(e); }
    console.error('FAIL', name, err.message);
    console.error(extra);
    console.error(logs.join('\n'));
    console.error('shot', dump);
    await browser.close();
    throw err;
  }
  await browser.close();
}

const iphone = {
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 3,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const pixel = {
  viewport: { width: 915, height: 412 },
  deviceScaleFactor: 2.625,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
};

const server = await startServer();
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;
fs.mkdirSync(OUT, { recursive: true });

const pctx = await webkit.launch({ headless: true });
const portrait = await pctx.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: iphone.userAgent,
});
const pp = await portrait.newPage();
await pp.goto(base + '/', { waitUntil: 'domcontentloaded' });
const pdisp = await pp.locator('#rotate-prompt').evaluate((el) => getComputedStyle(el).display);
const ptext = await pp.locator('#rotate-prompt').innerText();
assert(pdisp === 'flex', '竖屏提示没有盖住画面: ' + pdisp);
assert(ptext.includes('请横屏'), '竖屏文案不对: ' + ptext);
await pctx.close();
console.log('PASS portrait prompt');

await runDevice(webkit, 'iphone', iphone, base, {
  hud: path.join(OUT, 'hud-keys-iphone.png'),
  menu: path.join(OUT, 'command-menu-virtual-keys.png'),
  qte: path.join(OUT, 'penalty-qte.png'),
});
await runDevice(chromium, 'pixel', pixel, base, {
  hud: path.join(OUT, 'hud-keys-pixel.png'),
  full: true,
  menu: '/tmp/pixel-command-menu.png',
  qte: '/tmp/pixel-penalty-qte.png',
});
server.close();
console.log('ALL TOUCH TESTS PASSED');
