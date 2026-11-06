// 短视口 / 假地址栏：按键不叠、不全被挡住。全屏按钮。菜单里左摇杆翻选项。
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
async function drag(touch, page, x0, y0, x1, y1, steps) {
  await touch.send('touchStart', [{ id: 1, x: x0, y: y0 }]);
  for (let i = 1; i <= steps; i++) {
    await touch.send('touchMove', [{ id: 1, x: Math.round(x0 + (x1 - x0) * i / steps), y: Math.round(y0 + (y1 - y0) * i / steps) }]);
    await page.waitForTimeout(28);
  }
  await page.waitForTimeout(80);
  await touch.send('touchEnd', [{ id: 1, x: x1, y: y1 }]);
  await page.waitForTimeout(80);
}
async function keyBoxes(page) {
  return page.evaluate(() => {
    const keys = [];
    document.querySelectorAll('#vkey-layer .vkey').forEach((el) => {
      const r = el.getBoundingClientRect();
      keys.push({ id: el.getAttribute('data-id'), l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height });
    });
    const bar = document.getElementById('chrome-sim');
    const br = bar && !bar.hidden ? bar.getBoundingClientRect() : null;
    const wrap = document.getElementById('wrap').getBoundingClientRect();
    return { keys, bar: br, wrap: { t: wrap.top, b: wrap.bottom, h: wrap.height }, vh: window.innerHeight };
  });
}
function overlap(a, b) {
  const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return w > 1 && h > 1;
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const iphone = {
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

async function openGame(viewport, query) {
  const ctx = await browser.newContext({ ...iphone, viewport });
  const page = await ctx.newPage();
  const touch = makeTouch(page);
  await page.goto(base + query, { waitUntil: 'domcontentloaded' });
  await touch.init();
  await page.waitForFunction(() => {
    const ids = Object.keys(window.__matches || {});
    return ids.length && window.__matches[ids[0]].phase === 'play' && document.querySelectorAll('#vkey-layer .vkey').length === 5;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  return { ctx, page, touch };
}

try {
  const short = await openGame({ width: 844, height: 320 }, '/?debug=1&autostart=1');
  const shortKeys = await keyBoxes(short.page);
  assert(shortKeys.keys.length === 5, '短视口没有 5 个键');
  shortKeys.keys.forEach((k) => {
    assert(k.b <= shortKeys.wrap.b + 1 && k.t >= shortKeys.wrap.t - 1, '按键超出可见区域 ' + k.id + ' ' + JSON.stringify(k));
    assert(k.w >= 28 && k.h >= 28, '按键太小 ' + k.id);
  });
  for (let i = 0; i < shortKeys.keys.length; i++) {
    for (let j = i + 1; j < shortKeys.keys.length; j++) {
      assert(!overlap(shortKeys.keys[i], shortKeys.keys[j]), '短视口按键重叠 ' + shortKeys.keys[i].id + ' ' + shortKeys.keys[j].id);
    }
  }
  await short.ctx.close();

  const chrome = await openGame(iphone.viewport, '/?debug=1&autostart=1&chrome=70');
  const boxed = await keyBoxes(chrome.page);
  assert(boxed.bar && boxed.bar.height >= 68, '假地址栏没画出来 ' + JSON.stringify(boxed.bar));
  boxed.keys.forEach((k) => {
    assert(k.b <= boxed.bar.top + 1, '按键压进地址栏 ' + k.id + ' bottom=' + k.b.toFixed(1) + ' bar=' + boxed.bar.top.toFixed(1));
    assert(k.b <= boxed.wrap.b + 1, '按键超出画面 ' + k.id);
  });
  for (let i = 0; i < boxed.keys.length; i++) {
    for (let j = i + 1; j < boxed.keys.length; j++) {
      assert(!overlap(boxed.keys[i], boxed.keys[j]), '地址栏高度下按键重叠 ' + boxed.keys[i].id + ' ' + boxed.keys[j].id);
    }
  }
  await chrome.page.screenshot({ path: path.join(OUT, 'keys-above-chrome.png') });

  const fsBtn = chrome.page.locator('#fs-btn');
  await fsBtn.waitFor({ state: 'visible' });
  assert((await fsBtn.innerText()).indexOf('全屏') >= 0, '全屏按钮文案不对');
  await fsBtn.click();
  await chrome.page.waitForFunction(() => !!(document.fullscreenElement || document.webkitFullscreenElement), null, { timeout: 4000 });
  await chrome.page.waitForTimeout(200);
  assert((await fsBtn.innerText()).indexOf('退出全屏') >= 0, '进入全屏后没有退出按钮');
  await chrome.page.screenshot({ path: path.join(OUT, 'fullscreen-on.png') });

  await chrome.page.evaluate(() => window.__matches[Object.keys(window.__matches)[0]].debugPose('menu'));
  await chrome.page.waitForFunction(() => {
    const s = window.__touchState();
    return s && s.menu && s.kind === 'cmds';
  }, null, { timeout: 5000 });
  await chrome.page.waitForTimeout(200);
  const sel0 = (await chrome.page.evaluate(() => window.__touchState())).sel;
  await drag(chrome.touch, chrome.page, 150, 140, 150, 230, 6);
  const sel1 = (await chrome.page.evaluate(() => window.__touchState())).sel;
  assert(sel1 === sel0 + 1, '摇杆下拨没有走到下一项 ' + sel0 + ' -> ' + sel1);
  await chrome.page.screenshot({ path: path.join(OUT, 'menu-stick-down.png') });
  await drag(chrome.touch, chrome.page, 150, 220, 150, 120, 6);
  const sel2 = (await chrome.page.evaluate(() => window.__touchState())).sel;
  assert(sel2 === sel0, '摇杆上拨没有回到上一项 ' + sel1 + ' -> ' + sel2 + ' start ' + sel0);
  console.log('PASS chrome keys, fullscreen, stick menu', sel0, sel1, sel2);
  await chrome.ctx.close();
} catch (err) {
  console.error('FAIL', err.stack || err.message);
  await browser.close();
  server.close();
  process.exit(1);
}
await browser.close();
server.close();
console.log('ALL CHROME LAYOUT CHECKS PASSED');
