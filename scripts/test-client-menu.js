// 回归测试：客户端头顶菜单逻辑（Node 沙盒跑真实 client/js/main.js）
// 覆盖 2026-09-27 的 FIELD 未定义 bug：Enter 确认传球必须无异常推入落点层
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var noop = function () {};
var ctxStub = new Proxy({}, { get: function (t, k) { if (k === 'canvas') return {}; return typeof k === 'string' ? noop : undefined; }, set: function () { return true; } });
var fakeWindow = {
  SharedConstants: require('../shared/constants'),
  SharedTeams: {},
  Sprites: null, // 由 sprites.js 填充
  location: { search: '' },
  addEventListener: noop,
  // 本地 API 桩：构建产物用 window.__makeLocalApi() 替代 fetch 版 api
  __makeLocalApi: function () {
    return {
      post: function (url, body) {
        if (/\/pass-preview$/.test(url)) return Promise.resolve({ ok: true, preview: { params: (body && body.params) || {} } });
        if (/\/command$/.test(url)) return Promise.resolve({ ok: true });
        return Promise.resolve({ ok: true });
      },
      get: function () { return Promise.resolve({ ok: false }); },
      del: function () { return Promise.resolve({}); },
    };
  },
};
var fakeDocument = {
  getElementById: function () {
    return { getContext: function () { return ctxStub; }, addEventListener: noop, getBoundingClientRect: function () { return { left: 0, top: 0, width: 1280, height: 720 }; }, width: 1280, height: 720, style: {} };
  },
  addEventListener: noop,
  createElement: function () { return { getContext: function () { return ctxStub; }, style: {} }; },
};
var sandbox = {
  window: fakeWindow, document: fakeDocument, location: fakeWindow.location,
  navigator: { maxTouchPoints: 0 }, requestAnimationFrame: noop,
  localStorage: { getItem: function () { return null; }, setItem: noop },
  Image: function () { this.src = ''; this.onload = null; },
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  console: console, Math: Math, JSON: JSON, Date: Date, Promise: Promise, Proxy: Proxy,
};
sandbox.global = sandbox;
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'js', 'sprites.js'), 'utf8'), sandbox);
// 测构建产物 docs/js/main.js（即实际上线的代码），而非 client 源码
var src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'main.js'), 'utf8');
// main.js 整体包在 (function(){...})() 里：在闭合前注入测试驱动
var driver = '\n;window.__T = { openHeadMenu: openHeadMenu, headMenuKey: headMenuKey, hmTop: hmTop, ' +
  'nudgeAim: nudgeAim, hmConfirmPass: hmConfirmPass, headMenuBack: headMenuBack, ' +
  'setState: function (s) { state = s; }, getState: function () { return state; }, ' +
  'setMatchId: function (id) { matchId = id; }, getUi: function () { return ui; } };\n';
if (!/\}\)\(\);\s*$/.test(src)) throw new Error('main.js 尾部 IIFE 未找到，注入失败');
src = src.replace(/\}\)\(\);\s*$/, driver + '})();');
vm.runInContext(src, sandbox);
var T = sandbox.window.__T;
if (!T) throw new Error('测试驱动注入失败');

var failures = [];
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) failures.push(name); }

function attackDecision() {
  return {
    playerId: 'h9', kind: 'attack',
    options: [
      { id: 'dribble', label: '突破', cost: 5, enabled: true },
      { id: 'pass', label: '传球', cost: 3, enabled: true, passOpts: { techniques: [{ id: 'inside', name: '内脚背', desc: '最稳', enabled: true, reason: '' }], suggest: { x: 75, y: 30 } } },
      { id: 'shoot', label: '射门', cost: 7, enabled: true },
    ],
  };
}
function baseState(decision) {
  return {
    tick: 10, half: 1, clock: 5, paused: true, score: { home: 0, away: 0 },
    players: [{ id: 'h9', team: 'home', pos: 'FW', num: 10, x: 60, y: 34, stamina: 90, controlled: true }],
    ball: { x: 60, y: 34, ownerId: 'h9' },
    decision: decision,
  };
}

T.setMatchId('test1');
function key(k, shift) { return { key: k, shiftKey: !!shift, preventDefault: noop }; }

// ---- 1. 方向键/WASD 导航 + Enter 确认"传球"：无异常 + 推入落点层 ----
try {
  var dec = attackDecision();
  T.setState(baseState(dec));
  T.openHeadMenu(dec);
  check('菜单打开 (top=cmds)', T.hmTop().kind === 'cmds');
  T.headMenuKey(key('s')); // 突破 -> 传球
  check('s 下移高亮到传球', T.hmTop().sel === 1);
  T.headMenuKey(key('Enter')); // = 按 Enter 确认传球
  check('Enter 确认传球无异常', true);
  check('落点层被推入 (top=aim)', T.hmTop().kind === 'aim');
} catch (e) {
  check('Enter 确认传球无异常', false);
  console.log('  threw: ' + e.message);
}

// ---- 2. 落点层：方向键微调 + Enter 进脚法层 + 脚法/高度/确认 ----
try {
  T.headMenuKey(key('ArrowUp')); T.headMenuKey(key('d')); // 微调落点
  var ax = T.getUi().hmenu.pass.aimX, ay = T.getUi().hmenu.pass.aimY;
  check('落点可微调', typeof ax === 'number' && typeof ay === 'number');
  T.headMenuKey(key('Enter')); // aim -> 脚法层
  check('进入脚法层 (top=tech)', T.hmTop().kind === 'tech');
  T.headMenuKey(key('Enter')); // 选默认脚法 -> 高度层
  check('进入高度层 (top=height)', T.hmTop().kind === 'height');
  T.headMenuKey(key('Enter')); // 选默认高度 -> 确认层
  check('进入确认层 (top=confirm)', T.hmTop().kind === 'confirm');
  T.headMenuKey(key('Enter')); // 确认 -> 发出传球
  check('确认传球发出 (choosing=true)', T.getUi().choosing === true);
} catch (e) {
  check('落点全流程无异常', false);
  console.log('  threw: ' + e.message);
}

// ---- 3. Esc 返回 ----
try {
  var dec3 = attackDecision();
  T.setState(baseState(dec3));
  T.getUi().choosing = false;
  T.openHeadMenu(dec3);
  T.getUi().hmenu.stack[0].sel = 1;
  T.headMenuKey(key('Enter'));
  check('落点层已推入', T.hmTop().kind === 'aim');
  T.headMenuBack();
  check('Esc 返回根层 (top=cmds)', T.hmTop().kind === 'cmds');
} catch (e) { check('Esc 返回根层 (top=cmds)', false); console.log('  threw: ' + e.message); }

// ---- 4. 非传球指令直接发送 ----
try {
  var dec4 = attackDecision();
  T.setState(baseState(dec4));
  T.getUi().choosing = false;
  T.openHeadMenu(dec4);
  T.getUi().hmenu.stack[0].sel = 0; // 突破
  T.headMenuKey(key('Enter'));
  check('突破指令发出 (choosing=true)', T.getUi().choosing === true);
} catch (e) { check('突破指令发出 (choosing=true)', false); console.log('  threw: ' + e.message); }

// ---- 5. 防守菜单确认无异常 ----
try {
  var dec5 = {
    playerId: 'h9', kind: 'defense', def: true,
    options: [
      { id: 'tackle', label: '上抢', cost: 4, enabled: true },
      { id: 'jockey', label: '卡位', cost: 1, enabled: true },
    ],
  };
  T.getUi().choosing = false;
  T.setState(baseState(dec5));
  T.openHeadMenu(dec5);
  T.headMenuKey(key('s')); // 上抢 -> 卡位
  T.headMenuKey(key('w')); // 卡位 -> 上抢
  T.headMenuKey(key('Enter')); // 上抢
  check('防守上抢确认无异常', true);
} catch (e) { check('防守上抢确认无异常', false); console.log('  threw: ' + e.message); }

console.log(failures.length ? ('\nREGRESSION FAIL: ' + failures.join(', ')) : '\nALL CLIENT MENU TESTS PASSED');
process.exit(failures.length ? 1 : 0);
