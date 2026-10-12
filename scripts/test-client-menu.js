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
  'setScreen: function (s) { screen = s; }, getDbgErr: function () { return dbgErr; }, ' +
  'frame: frame, ' +
  'setMatchId: function (id) { matchId = id; }, getUi: function () { return ui; }, ' +
  'showingCutscene: showingCutscene, skipCutscene: skipCutscene, ' +
  'setCutImg: function (k, v) { CUT_IMGS[k] = v; } };\n';
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

// ---- 6. 全屏特写跳过（2026-10-11：特写排队打断心流） ----
try {
  T.setCutImg('dribble-win', { complete: true, naturalWidth: 100 });
  function cutState(label, until) {
    var s = baseState(null);
    s.lastAction = { kind: 'dribble', label: label, playerName: '风间隼', team: 'home',
      success: true, text: 'x', cut: 'dribble-win', until: until };
    return s;
  }
  T.setState(cutState('突破', Date.now() + 5000));
  check('特写显示中 showingCutscene 非空', !!T.showingCutscene());
  check('skipCutscene 返回 true', T.skipCutscene() === true);
  check('跳过后 showingCutscene 为空', !T.showingCutscene());
  check('ui.cutSkipId 已记录', !!T.getUi().cutSkipId);
  // 新事件（id 不同）自动解除跳过
  T.setState(cutState('上抢', Date.now() + 9000));
  check('新特写到达后跳过自动解除', !!T.showingCutscene());
  // 无 cut 键的纯文字事件：showingCutscene 为空（不拦截按键）
  var s2 = baseState(null);
  s2.lastAction = { kind: 'intercept', label: '拦截', playerName: 'x', team: 'home',
    success: true, text: 'x', cut: null, until: Date.now() + 5000 };
  T.setState(s2);
  check('纯文字事件不算特写', !T.showingCutscene());
  check('无特写时 skipCutscene 返回 false', T.skipCutscene() === false);
} catch (e) { check('特写跳过逻辑无异常', false); console.log('  threw: ' + e.message); }

console.log('== 渲染循环永不死（2026-10-12：偶发"判定中…"冻屏） ==');
try {
  // 强制 frameInner 抛异常：state.players 置空，drawActors 的 forEach 必抛 TypeError
  var rafCalls = 0;
  sandbox.requestAnimationFrame = function () { rafCalls++; };
  T.setScreen('game');
  T.setState({ players: null, ball: { x: 52.5, y: 34, z: 0 } });
  var threw = false;
  try { T.frame(0); } catch (e) { threw = true; }
  check('frame 内异常不抛到外层（循环载体存活）', threw === false);
  check('异常被记入 dbgErr（可见、可排查）', T.getDbgErr().indexOf('ERR') === 0);
  check('异常后仍调度下一帧（循环继续）', rafCalls === 1);
  // 恢复：正常 state 下 frame 照常工作且不再抛
  T.setState(null);
  var rafBefore2 = rafCalls;
  T.frame(0);
  check('恢复后 frame 正常执行', rafCalls === rafBefore2 + 1);
} catch (e) { check('渲染循环保护测试无异常', false); console.log('  threw: ' + e.message); }

console.log(failures.length ? ('\nREGRESSION FAIL: ' + failures.join(', ')) : '\nALL CLIENT MENU TESTS PASSED');
process.exit(failures.length ? 1 : 0);
