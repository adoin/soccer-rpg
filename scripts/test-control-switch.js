// scripts/test-control-switch.js
// 控制权自动切换（引擎级）：球权变化时玩家操控目标的跟随规则。
// 来源：2026-10-10 用户报"传球后控制没跟到接球人身上"（修：autoSwitchToCarrier）
//      + 用户要求"对方得球后切到最近防守人"（修：autoSwitchToDefender）。
// 注意：这是引擎级确定性测试；绿圈渲染/跟手体感仍需浏览器实测（本环境截图通道不可用时记未覆盖）。
'use strict';

var E = require('../server/game/engine');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) { console.log('  PASS ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

function newMatch(seed) {
  var m = new E.Match('t' + seed, { seed: seed, halfLength: 60 });
  m.destroy();
  m.phase = 'play';
  m.aiCooldownUntil = 1e15; // 本测试不测 AI 决策，只测球权变化→控制切换
  return m;
}
function P(m, id) { return m.byId[id]; }
function set(m, id, x, y) { var p = P(m, id); p.x = x; p.y = y; p._px = x; p._py = y; }
function parkAll(m) {
  // 把所有人都摆到远离球的位置，避免压迫判定/盯人逻辑干扰
  var ids = ['h1','h2','h3','h4','h5','h6','h7','h8','h9','h10','h11',
             'a1','a2','a3','a4','a5','a6','a7','a8','a9','a10','a11'];
  ids.forEach(function (id, i) { set(m, id, 10 + (i % 6) * 3, 8 + Math.floor(i / 6) * 8); });
}
function tick(m) { m.simulate(0.12); }

console.log('== 控制权自动切换 ==');

// 1. 主队新持球人（非门将）→ 控制自动跟过去，且给玩家操作窗口（controlActive）
(function () {
  var m = newMatch(101);
  parkAll(m);
  set(m, 'h10', 50, 34); set(m, 'h9', 60, 34);
  m.ball.x = 50; m.ball.y = 34; m.ball.ownerId = 'h10';
  m._lastCarrierId = 'h10';
  m.control.playerId = 'h10'; m.control.activeStamp = m.now - 5000; // 之前已 AI 接管
  m.ball.ownerId = 'h9'; // h9 接到球
  tick(m);
  ok(m.control.playerId === 'h9', '主队得球→控制跟到持球人', m.control.playerId);
  ok((m.now - m.control.activeStamp) <= 2000, '刚切换给玩家操作窗口（controlActive=true）');
})();

// 2. 对方得球 → 控制切到离球最近的主队非门将防守人
(function () {
  var m = newMatch(102);
  parkAll(m);
  set(m, 'a9', 55, 34); // 客队 a9 拿球
  set(m, 'h4', 53, 34); // 主队 h4 离球最近（2 米）
  set(m, 'h5', 40, 34); // h5 较远
  set(m, 'h1', 54, 34); // 门将 h1 虽然近（1 米）但必须排除
  m.ball.x = 55; m.ball.y = 34; m.ball.ownerId = 'a9';
  m._lastCarrierId = null;
  m.control.playerId = 'h8';
  tick(m);
  ok(m.control.playerId === 'h4', '对方得球→控制切到最近的非门将防守人', m.control.playerId);
})();

// 3. 对方得球但当前控制的是门将 → 不抢控制（测试/特殊状态保护）
(function () {
  var m = newMatch(103);
  parkAll(m);
  set(m, 'a9', 55, 34);
  m.ball.x = 55; m.ball.y = 34; m.ball.ownerId = 'a9';
  m._lastCarrierId = null;
  m.control.playerId = 'h1'; // 当前在控门将
  tick(m);
  ok(m.control.playerId === 'h1', '当前控门将时对方得球不抢控制', m.control.playerId);
})();

// 4. 主队门将得球 → 控制不变（门将排除在自动跟随外）
(function () {
  var m = newMatch(104);
  parkAll(m);
  set(m, 'h1', 8, 34);
  m.ball.x = 8; m.ball.y = 34; m.ball.ownerId = 'h1';
  m._lastCarrierId = null;
  m.control.playerId = 'h4';
  tick(m);
  ok(m.control.playerId === 'h4', '主队门将得球→控制不跟门将', m.control.playerId);
})();

// 5. 自由球（拦截弹开/无人接应，ownerId=null）→ 控制不变
(function () {
  var m = newMatch(105);
  parkAll(m);
  m.ball.x = 55; m.ball.y = 34; m.ball.ownerId = null; m.ball.vx = 0; m.ball.vy = 0;
  m._lastCarrierId = 'h10';
  m.control.playerId = 'h10';
  tick(m);
  ok(m.control.playerId === 'h10', '自由球→控制不变', m.control.playerId);
})();

// 6. 球权未变化 → 控制不变（不误触）
(function () {
  var m = newMatch(106);
  parkAll(m);
  set(m, 'h10', 50, 34);
  m.ball.x = 50; m.ball.y = 34; m.ball.ownerId = 'h10';
  m._lastCarrierId = 'h10';
  m.control.playerId = 'h10';
  var stampBefore = m.control.activeStamp;
  tick(m);
  ok(m.control.playerId === 'h10' && m.control.activeStamp === stampBefore,
    '球权未变→控制与操作窗口都不动');
})();

if (failures > 0) { console.log('\nFAIL: ' + failures + ' 项未通过'); process.exit(1); }
console.log('\nALL CONTROL SWITCH TESTS PASSED');
