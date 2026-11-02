// 主动菜单可取消、定位球摆位、球场线和球衣。真实触摸 + 桌面键盘。
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
const { chromium, webkit } = playwright;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, '..', 'docs');
const OUT = '/opt/cursor/artifacts';
const GESTURE = '/tmp/touch-gesture.json';

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
    return ids.length && window.__matches[ids[0]].phase === 'play';
  }, null, { timeout: 15000 });
}
function match(page) {
  return page.evaluate(() => {
    const m = window.__matches[Object.keys(window.__matches)[0]];
    const id = m.control.playerId;
    const p = m.byId[id];
    return {
      id, x: p.x, y: p.y, dx: m.control.dx, phase: m.phase, paused: m.paused,
      dec: m.decision ? { kind: m.decision.kind || 'command', voluntary: !!m.decision.voluntary } : null,
      ui: window.__touchState ? window.__touchState() : null,
    };
  });
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: false });
const desk = await desktop.newPage();
await desk.goto(base + '/?debug=1&autostart=1&wide=1', { waitUntil: 'domcontentloaded' });
await waitPlay(desk);

const before = await match(desk);
await desk.keyboard.press('KeyE');
await desk.waitForFunction(() => {
  const s = window.__touchState && window.__touchState();
  const m = window.__matches[Object.keys(window.__matches)[0]];
  return s && s.menu && m.decision && m.decision.voluntary;
}, null, { timeout: 5000 });
await desk.keyboard.press('Escape');
await desk.waitForFunction(() => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  return !m.decision && m.phase === 'play' && !m.paused;
}, null, { timeout: 4000 });
await desk.keyboard.down('KeyD');
await desk.waitForTimeout(700);
await desk.keyboard.up('KeyD');
const after = await match(desk);
assert(after.x > before.x + 1, '桌面取消后面板还在或人没动 ' + before.x.toFixed(2) + ' -> ' + after.x.toFixed(2) + ' ' + JSON.stringify(after));
console.log('PASS desktop cancel then move', before.x.toFixed(2), '->', after.x.toFixed(2));

async function pose(page, fnSource) {
  await page.evaluate(fnSource);
  await page.waitForTimeout(350);
}
async function shot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  return file;
}

await pose(desk, () => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  m.setPaused(true);
  m.lastAction = null;
  m.decision = null;
  m.ball.x = 106; m.ball.y = 8; m.ball.lastTouchTeam = 'away';
  m.whistleCorner('home');
  m.lastAction = null;
  m.setPaused(true);
});
await shot(desk, 'setpiece-corner.png');

await pose(desk, () => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  m.setPaused(true);
  m.lastAction = null;
  const f = {
    defender: m.byId.a4, victim: m.byId.h10, team: 'home',
    spot: { x: 80, y: 34 }, card: 'none', penalty: false, advantage: false, severity: 30,
  };
  m.byId.h10.x = 80; m.byId.h10.y = 34;
  m.applyFoulResult(f);
  m.lastAction = null;
  m.setPaused(true);
});
await shot(desk, 'setpiece-freekick.png');

await pose(desk, () => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  m.whistleThrowIn('home', 48, -3);
  m.lastAction = null;
  m.decision = null;
  m.setPaused(true);
});
await shot(desk, 'setpiece-throwin.png');

await pose(desk, () => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  m.setupPenalty({
    defender: m.byId.a4, victim: m.byId.h10, team: 'home',
    spot: { x: 94, y: 34 }, card: 'none', penalty: true, advantage: false,
  }, '');
  m.lastAction = null;
  m.setPaused(true);
});
await shot(desk, 'setpiece-penalty.png');

await pose(desk, () => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  m.whistleGoalKick('home');
  m.lastAction = null;
  m.decision = null;
  m.setPaused(true);
});
await shot(desk, 'setpiece-goalkick.png');

await pose(desk, () => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  m.resetPositions('home');
  m.lastAction = null;
  m.decision = null;
  m.setPaused(true);
});
await shot(desk, 'setpiece-kickoff.png');
await shot(desk, 'pitch-overview.png');

const kitReport = await desk.evaluate(async () => {
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('sprite'));
    im.src = 'assets/sprites/home/run-8dir-v3-without-ball.png?v=spr6';
  });
  const src = document.createElement('canvas');
  src.width = img.naturalWidth; src.height = img.naturalHeight;
  const sx = src.getContext('2d');
  sx.drawImage(img, 0, 0);
  const id = sx.getImageData(0, 0, src.width, src.height);
  if (SharedKits.markShoePlaceholders) SharedKits.markShoePlaceholders(id, 48, 72);
  const mask = SharedKits.classifyPlaceholders(id, 32);
  const centers = SharedKits.sheetCenters(mask, id.width, id.height, 48, 72);
  const kits = [
    ['青鹰外场', SharedKits.resolveKit('home')],
    ['烈风外场', SharedKits.resolveKit('away')],
    ['青鹰门将', SharedKits.resolveKit('gkHome')],
    ['烈风门将', SharedKits.resolveKit('gkAway')],
    ['裁判', SharedKits.resolveKit('ref')],
  ];
  const scale = 4;
  const cellW = 48 * scale, cellH = 72 * scale;
  const old = document.getElementById('kitzoom');
  if (old) old.remove();
  const out = document.createElement('canvas');
  out.id = 'kitzoom';
  out.width = cellW * 2 + 160;
  out.height = cellH * kits.length;
  out.style.cssText = 'position:fixed;inset:0;z-index:200;background:#123024;image-rendering:pixelated';
  document.body.appendChild(out);
  const ox = out.getContext('2d');
  ox.imageSmoothingEnabled = false;
  ox.fillStyle = '#123024';
  ox.fillRect(0, 0, out.width, out.height);
  const report = [];
  kits.forEach((row, i) => {
    const copy = new ImageData(new Uint8ClampedArray(id.data), id.width, id.height);
    SharedKits.recolorImageData(copy, { home: row[1] }, 32, {
      cellW: 48, cellH: 72, pattern: row[1].pattern, mask: mask, centers: centers,
    });
    const c2 = document.createElement('canvas');
    c2.width = copy.width; c2.height = copy.height;
    c2.getContext('2d').putImageData(copy, 0, 0);
    ox.drawImage(c2, 2 * 48, 4 * 72, 48, 72, 150, i * cellH + 8, cellW, cellH - 16);
    ox.drawImage(c2, 3 * 48, 4 * 72, 48, 72, 150 + cellW + 12, i * cellH + 8, cellW, cellH - 16);
    ox.fillStyle = '#ffd94a';
    ox.font = 'bold 28px sans-serif';
    ox.fillText(row[0], 16, i * cellH + 80);
    const sample = ox.getImageData(150, i * cellH + 8, cellW, cellH - 16).data;
    let white = 0, opaque = 0;
    for (let p = 0; p < sample.length; p += 4) {
      if (sample[p + 3] < 200) continue;
      opaque++;
      if (sample[p] > 236 && sample[p + 1] > 236 && sample[p + 2] > 236) white++;
    }
    report.push({
      name: row[0], pattern: row[1].pattern, primary: row[1].primary,
      shorts: row[1].shorts, white: white, opaque: opaque,
    });
  });
  const players = window.__matches[Object.keys(window.__matches)[0]].players;
  const kinds = {};
  players.forEach((p) => {
    const key = p.pos === 'GK' ? p.team + '-GK' : p.team;
    kinds[key] = (kinds[key] || 0) + 1;
  });
  return { report: report, kinds: kinds };
});
await desk.locator('#kitzoom').screenshot({ path: path.join(OUT, 'kits-zoom.png') });
const home = kitReport.report[0];
assert(home.pattern === 'solid' && home.white < 30, '青鹰球衣有杂白 ' + JSON.stringify(home));
const away = kitReport.report[1];
assert(away.pattern === 'hoops', '烈风应是同一套横条 ' + away.pattern);
assert(kitReport.report[2].primary !== home.primary, '门将和青鹰外场撞色');
assert(kitReport.report[4].primary !== home.primary && kitReport.report[4].primary !== away.primary, '裁判不独立');
assert(kitReport.kinds.home === 10 && kitReport.kinds.away === 10, '外场人数 ' + JSON.stringify(kitReport.kinds));
assert(kitReport.kinds['home-GK'] === 1 && kitReport.kinds['away-GK'] === 1, '门将人数');
console.log('PASS kits', JSON.stringify(kitReport.report.map((r) => r.name + ':' + r.pattern + ' white=' + r.white)));

await browser.close();

const iphone = await webkit.launch({ headless: true });
const ictx = await iphone.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});
const ip = await ictx.newPage();
const touch = makeTouch(ip, 'webkit');
await ip.goto(base + '/?debug=1&autostart=1', { waitUntil: 'domcontentloaded' });
await touch.init();
await waitPlay(ip);
const layout = await ip.evaluate(() => window.__touchLayout());
const eKey = layout.keys.filter((k) => k.key === 'e')[0];
const qKey = layout.keys.filter((k) => k.key === 'q')[0];
async function tapKey(k) {
  const p = await screenOf(ip, k.x, k.y);
  await touch.send('touchStart', [{ id: 7, x: p.x, y: p.y }]);
  await ip.waitForTimeout(40);
  await touch.send('touchEnd', [{ id: 7, x: p.x, y: p.y }]);
  await ip.waitForTimeout(80);
}
await tapKey(eKey);
await ip.waitForFunction(() => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  return m.decision && m.decision.voluntary;
}, null, { timeout: 4000 });
await tapKey(qKey);
await ip.waitForFunction(() => {
  const m = window.__matches[Object.keys(window.__matches)[0]];
  return !m.decision && m.phase === 'play' && !m.paused;
}, null, { timeout: 4000 });
const stick = await screenOf(ip, layout.stick.x, layout.stick.y);
const left = await screenOf(ip, layout.stick.x - layout.stick.r * 0.9, layout.stick.y);
const x0 = (await match(ip)).x;
await touch.send('touchStart', [{ id: 1, x: stick.x, y: stick.y }]);
for (let i = 1; i <= 6; i++) {
  await touch.send('touchMove', [{ id: 1, x: Math.round(stick.x + (left.x - stick.x) * i / 6), y: left.y }]);
  await ip.waitForTimeout(30);
}
await ip.waitForTimeout(1200);
const moved = await match(ip);
await touch.send('touchEnd', [{ id: 1, x: left.x, y: left.y }]);
assert(!moved.dec && moved.phase === 'play' && !moved.paused && moved.dx < -0.4 && moved.x < x0 - 1.5, '触屏取消后没有恢复移动 ' + x0.toFixed(2) + ' -> ' + JSON.stringify(moved));
console.log('PASS touch cancel then move', x0.toFixed(2), '->', moved.x.toFixed(2));
await iphone.close();
server.close();
console.log('ALL PITCH TESTS PASSED');
