// scripts/build-static.js
// 构建纯前端试玩版（用于 GitHub Pages / docs 目录）。
//
// 背景：github.io 是纯静态托管，跑不了 Node 服务器。于是把比赛引擎
// （server/game/engine.js，本身是纯逻辑、无 Node API）用 esbuild 打包
// 进浏览器，再用 js/api-local.js 把原来发往 /api/* 的请求转给页面内的
// 引擎实例。client/js/main.js 只做一处替换：var api = ... -> 本地适配器。
//
// 注意：这是试玩版。正式版仍保持「服务器权威」架构（见 README），
// 仓库根目录的 server/ 才是线上要用的实现。
'use strict';

var fs = require('fs');
var path = require('path');
var child = require('child_process');

var ROOT = path.join(__dirname, '..');
var DOCS = path.join(ROOT, 'docs');

function mkdirp(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
function copy(src, dst) {
  mkdirp(path.dirname(dst));
  fs.copyFileSync(src, dst);
}
function walk(dir, out, base) {
  out = out || [];
  base = base || dir;
  fs.readdirSync(dir).forEach(function (name) {
    if (name === 'node_modules' || name[0] === '.') return;
    var p = path.join(dir, name);
    var st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out, base);
    else out.push(path.relative(base, p));
  });
  return out;
}

// 1. 打包引擎（iife，全局变量 SoccerEngine）
mkdirp(DOCS);
console.log('> bundling engine...');
child.execSync(
  'npx --yes esbuild server/game/engine.js --bundle --format=iife --global-name=SoccerEngine --minify --outfile=docs/engine.bundle.js',
  { cwd: ROOT, stdio: 'inherit' }
);

// 2. 拷贝 shared / sprites / css
copy(path.join(ROOT, 'shared/constants.js'), path.join(DOCS, 'shared/constants.js'));
copy(path.join(ROOT, 'shared/teams.js'), path.join(DOCS, 'shared/teams.js'));
copy(path.join(ROOT, 'shared/kits.js'), path.join(DOCS, 'shared/kits.js')); // ★ 球衣调色板（2026-10-10）
copy(path.join(ROOT, 'client/js/sprites.js'), path.join(DOCS, 'js/sprites.js'));
walk(path.join(ROOT, 'client/css')).forEach(function (f) {
  copy(path.join(ROOT, 'client/css', f), path.join(DOCS, 'css', f));
});
// 2b. 拷贝静态美术资源（结算演出图等）
walk(path.join(ROOT, 'client/assets')).forEach(function (f) {
  copy(path.join(ROOT, 'client/assets', f), path.join(DOCS, 'assets', f));
});

// 3. 本地 API 适配器：拦截 /api/*，直接调用页面内引擎
var adapter = [
  '// js/api-local.js（构建产物，不要手改）',
  '// 纯前端试玩版：把原来发往 /api/* 的请求直接转给跑在页面里的引擎实例。',
  '// 接口形状与 server/index.js 的 REST 接口保持一致。',
  '(function () {',
  "'use strict';",
  '',
  'var matches = {};',
  '',
  'function newId() {',
  "  var h = '0123456789abcdef', s = '';",
  '  for (var i = 0; i < 16; i++) s += h[(Math.random() * 16) | 0];',
  '  return s;',
  '}',
  '',
  'function getMatch(id) { return matches[id] || null; }',
  '',
  '// ★ debug 摆拍场景：同步布阵→开球→跑完关键 tick→冻结，返回关键信息供 toast/截图核对',
  "function debugScene(m, name) {",
  "  function setup() {",
  "    m.players.forEach(function(p){ if(p.pos !== 'GK'){ p.x = (p.team === 'home' ? 15 : 90); p.y = 34; p.vx = 0; p.vy = 0; } });",
  "    var hp = m.byId['h10'], dp = m.byId['a4'];",
  "    hp.x = 50; hp.y = 34; dp.x = (name === '2' ? 60 : 52.5); dp.y = 34; // 高球越过:人摆线路中段",
  "    m.ball.ownerId = 'h10'; m.ball.x = 50; m.ball.y = 34; m.ball.z = 0; m.ball.vx = 0; m.ball.vy = 0;",
  "    m.phase = 'play'; m.decision = null;",
  "  }",
  "  var info = { scene: name };",
  "  m.setPaused(false);",
  "  if (name === '1' || name === '2') {",
  "    setup();",
  "    m.startPassFlight(m.byId['h10'], { x1: 70, y1: 34, durMs: name === '1' ? 600 : 700, height: name === '1' ? 'low' : 'high', receiverId: null });",
  "    var n = 0; while (m.phase === 'passflight' && n < 20) { m.tick(); n++; }",
  "    info.ticks = n; info.owner = m.ball.ownerId; info.bx = +m.ball.x.toFixed(1); info.by = +m.ball.y.toFixed(1);",
  "  } else if (name === '3') {",
  "    setup();",
  "    m.startPassFlight(m.byId['h10'], { x1: 80, y1: 34, durMs: 1300, height: 'vhigh', receiverId: null });",
  "    for (var i = 0; i < 6; i++) m.tick();",
  "    info.z = +m.ball.z.toFixed(2); info.bx = +m.ball.x.toFixed(1); info.phase = m.phase;",
  "  } else {",
  "    setup();",
  "    var tries = 0;",
  "    while (tries < 20) {",
  "      m.startPassFlight(m.byId['h10'], { x1: 70, y1: 34, durMs: 600, height: 'low', receiverId: null });",
  "      var n2 = 0; while (m.phase === 'passflight' && n2 < 20) { m.tick(); n2++; }",
  "      tries++;",
  "      if (!m.ball.ownerId) break;",
  "    }",
  "    info.tries = tries; info.free = !m.ball.ownerId;",
  "    for (var j = 0; j < 20; j++) { m.tick(); if (m.ball.ownerId) break; }",
  "    info.chased = m.ball.ownerId; info.bx = +m.ball.x.toFixed(1);",
  "  }",
  "  m.setPaused(true);",
  "  return info;",
  "}",
  '',
  "  if (/[?&]debug=1/.test(location.search)) { window.__getMatch = getMatch; window.__matches = matches; }",
  '',
  'window.__makeLocalApi = function () {',
  '  var Match = window.SoccerEngine.Match;',
  '  return {',
  '    post: function (url, body) {',
  '      body = body || {};',
  '      var m;',
  "      if (url === '/api/match') {",
  '        var halfLength = parseInt(body.halfLength, 10);',
  '        if (!(halfLength >= 30 && halfLength <= 1200)) halfLength = 180;',
  '        var id = newId();',
  "        matches[id] = new Match(id, { halfLength: halfLength, mentality: body.mentality || 'balanced' });",
  "        return Promise.resolve({ ok: true, matchId: id });",
  '      }',
  "      m = url.match(/^\\/api\\/match\\/([^\\/]+)\\/command$/);",
  '      if (m) {',
  '        var mm = getMatch(m[1]);',
  "        if (!mm || !mm.decision) return Promise.resolve({ ok: false, error: '当前不需要做决策' });",
  '        return Promise.resolve(mm.applyCommand(mm.decision.playerId, body.commandId, body.params));',
  '      }',
  "      m = url.match(/^\\/api\\/match\\/([^\\/]+)\\/pass-preview$/);",
  '      if (m) {',
  '        var pm = getMatch(m[1]);',
  "        if (!pm || !pm.decision) return Promise.resolve({ ok: false, error: '当前不需要做决策' });",
  '        return Promise.resolve(pm.passPreview(pm.decision.playerId, body.params));',
  '      }',
  "      m = url.match(/^\\/api\\/match\\/([^\\/]+)\\/pause$/);",
  '      if (m) {',
  '        var mm2 = getMatch(m[1]);',
  '        if (mm2) mm2.setPaused(!!body.paused);',
  "        return Promise.resolve({ ok: true, paused: !!body.paused });",
  '      }',
  "      m = url.match(/^\\/api\\/match\\/([^\\/]+)\\/mentality$/);",
  '      if (m) {',
  '        var mm3 = getMatch(m[1]);',
  "        if (mm3) mm3.setMentality(body.mentality);",
  "        return Promise.resolve({ ok: true, mentality: body.mentality });",
  '      }',
  "      m = url.match(/^\\/api\\/match\\/([^\\/]+)\\/input$/);",
  '      if (m) {',
  '        var mm4 = getMatch(m[1]);',
  "        if (mm4) return Promise.resolve(mm4.setInput(body));",
  "        return Promise.resolve({ ok: false, error: '比赛不存在或已结束' });",
  '      }',
  "      if (url === '/api/debug/scene') {",
  "        if (!/[?&]debug=1/.test(location.search)) return Promise.resolve({ ok: false, error: 'not in debug' });",
  '        var dm = getMatch(body.matchId) || (function(){ for (var k in matches) return matches[k]; return null; })();',
  "        if (!dm) return Promise.resolve({ ok: false, error: '无比赛' });",
  '        var sinfo = debugScene(dm, String(body.scene || \'1\'));',
  '        return Promise.resolve({ ok: true, info: sinfo });',
  '      }',
  "      return Promise.resolve({ ok: false, error: 'unknown api: ' + url });",
  '    },',
  '    get: function (url) {',
  "      var m = url.match(/^\\/api\\/match\\/([^\\/]+)\\/state$/);",
  '      if (m) {',
  '        var mm = getMatch(m[1]);',
  "        if (!mm) return Promise.resolve({ ok: false, error: '比赛不存在或已结束' });",
  "        return Promise.resolve({ ok: true, state: mm.serialize() });",
  '      }',
  "      return Promise.resolve({ ok: false, error: 'unknown api: ' + url });",
  '    },',
  '    del: function (url) {',
  "      var m = url.match(/^\\/api\\/match\\/([^\\/]+)$/);",
  '      if (m) {',
  '        var mm = getMatch(m[1]);',
  '        if (mm) { mm.destroy(); delete matches[m[1]]; }',
  '      }',
  "      return Promise.resolve({ ok: true });",
  '    }',
  '  };',
  '};',
  '})();',
  ''
].join('\n');
fs.writeFileSync(path.join(DOCS, 'js/api-local.js'), adapter);

// 4. main.js：只替换 api 定义块
var mainSrc = fs.readFileSync(path.join(ROOT, 'client/js/main.js'), 'utf8');
var apiRe = /var api = \{[\s\S]*?\n\};/;
if (!apiRe.test(mainSrc)) {
  throw new Error('在 client/js/main.js 中没找到 api 定义块，构建中止');
}
var mainStatic = mainSrc.replace(apiRe, 'var api = window.__makeLocalApi();');
if (/fetch\(url/.test(mainStatic)) {
  throw new Error('api 替换可能不完整，main.js 里还残留 fetch 调用');
}
mkdirp(path.join(DOCS, 'js'));
fs.writeFileSync(path.join(DOCS, 'js/main.js'), mainStatic);

// 5. index.html：相对路径 + 引擎包 + 本地适配器
var html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
// ★ 缓存击穿：每次构建带上版本号，避免手机浏览器沿用旧 JS
var ver = Date.now().toString(36);
html = html
  .replace('src="/shared/constants.js"', 'src="shared/constants.js?v=' + ver + '"')
  .replace('src="/shared/teams.js"', 'src="shared/teams.js?v=' + ver + '"')
  .replace('src="/shared/kits.js"', 'src="shared/kits.js?v=' + ver + '"')
  .replace('src="js/sprites.js"', 'src="js/sprites.js?v=' + ver + '"')
  .replace('src="js/main.js"', 'src="js/main.js?v=' + ver + '"')
  .replace(
    '<!-- 客户端 -->',
    '<!-- 纯前端试玩版：引擎跑在浏览器里（正式版走服务器，见 README） -->\n' +
    '<script src="engine.bundle.js?v=' + ver + '"></script>\n' +
    '<script src="js/api-local.js?v=' + ver + '"></script>\n' +
    '<!-- 客户端 -->'
  );
fs.writeFileSync(path.join(DOCS, 'index.html'), html);

// 6. .nojekyll（GitHub Pages 不走 Jekyll 处理）
fs.writeFileSync(path.join(DOCS, '.nojekyll'), '');

console.log('> static build done -> docs/');
console.log('  本地预览: cd docs && python3 -m http.server 8080');
