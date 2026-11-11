// 标题、设置、俱乐部、积分榜、存档列表。桌面 / 844x390 / 844x320。
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
  await page.waitForTimeout(280);
  await page.screenshot({ path: path.join(OUT, name) });
}
async function press(page, key, n) {
  for (let i = 0; i < (n || 1); i++) await page.keyboard.press(key);
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
  await page.waitForTimeout(500);
  const bg = await page.evaluate(() => {
    const im = document.querySelector('canvas') && window.__menuBgReady;
    return im;
  });
  await shots(page, 'menu-title-' + name + '.png');
  await press(page, 's', 3);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().titleView === 'settings');
  await shots(page, 'menu-settings-' + name + '.png');
  await page.keyboard.press('ArrowLeft');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('soccer-rpg-settings') || '{}'));
  assert(saved.halfLength === 60, name + ' 半场时长没存住 ' + JSON.stringify(saved));
  await page.keyboard.press('s');
  await page.keyboard.press('ArrowLeft');
  const saved2 = await page.evaluate(() => JSON.parse(localStorage.getItem('soccer-rpg-settings') || '{}'));
  assert(saved2.mentality === 'defend', name + ' 战术倾向没存住 ' + JSON.stringify(saved2));
  await page.keyboard.press('q');
  await page.waitForFunction(() => window.__touchState().titleView === 'main');

  await page.keyboard.press('s');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().titleView === 'new');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().screen === 'career' && window.__touchState().careerView === 'hub');
  await shots(page, 'menu-hub-' + name + '.png');
  await press(page, 's', 3);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().careerView === 'table');
  await shots(page, 'menu-table-' + name + '.png');
  await page.keyboard.press('q');
  await press(page, 's', 6);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__touchState().careerView === 'save');
  await shots(page, 'menu-saves-' + name + '.png');
  if (logs.length) console.log(name, 'pageerrors', logs.join(' | '));
  console.log('PASS', name, JSON.stringify(saved2));
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
console.log('ALL MENU UI CHECKS PASSED');
