// scripts/test-offside-dribble.js
// 回归测试（2026-10-10 用户报告）：带球突破后"啥都没干、往中间走"被莫名吹越位。
// 根因调查结论（见本文件注释）：
//   引擎的 4 个越位哨触发点全部要求传球/射门/扑救反弹事件——
//     engine.js: judgeRebound(扑救后) / judgePass(传球, 2处) / judgeShot(射门)。
//   纯带球（无任何传球/射门）不可能触发越位哨；且球恒定跟在持球者身前 1.2 米，
//   持球人的 u 恒小于球的 u，几何上永不可能处于越位位置。
//   因此用户看到的哨声必定来自一次被实际处理的传球/射门（手机误触头顶菜单走完
//   传球多级确认是最可能的路径：菜单打开时 sprint 键变为"确定"、方向盘变为菜单
//   导航，aim 光标默认落在 AI 推荐目标上，连按确定即发出传球）。
//   已上线的"持球人永不越位"只是最后一道防线，不改变上述结论。
// 本测试锁定：纯带球流程永远不出越位哨；并记录"误传越位队友"时哨声点名的是接球人。
'use strict';

var E = require('../server/game/engine');
var Offside = require('../server/game/rules/offside');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) { console.log('  PASS ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// 插桩：记录每一次越位哨（球员/原因/触发点行号/当时球权）
var whistles = [];
var origWhistle = E.Match.prototype.whistleOffside;
E.Match.prototype.whistleOffside = function (os, passer) {
  var site = new Error().stack.split('\n')
    .filter(function (l) { return l.indexOf('engine.js') >= 0; })
    .map(function (l) { var m = l.match(/engine\.js:(\d+)/); return m ? 'L' + m[1] : '?'; })
    .join('<-');
  whistles.push({
    player: os.player ? os.player.id : null, reason: os.reason,
    passer: passer ? passer.id : null, ballOwner: this.ball.ownerId, site: site,
  });
  return origWhistle.call(this, os, passer);
};

function newMatch(seed) {
  var m = new E.Match('t-od' + seed, { seed: seed, halfLength: 600 });
  m.destroy();
  m.phase = 'play';
  m.now = 120000;
  m.nextDecisionAt = 1e12;    // 不弹决策菜单：纯移动复现
  m.nextDefDecisionAt = 1e12;
  m.aiCooldownUntil = 1e12;   // 冻结客队 AI：不传球不射门
  m.control.playerId = 'h10';
  m.control.activeStamp = m.now;
  return m;
}
function P(m, id) { return m.byId[id]; }
function set(m, id, x, y) { var p = P(m, id); p.x = x; p.y = y; }
function awayLine(m) { // 越位线 uSecondLast = 80
  set(m, 'a2', 80, 38); set(m, 'a3', 78, 34); set(m, 'a4', 75, 30);
  set(m, 'a1', 100, 34);
  ['a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11'].forEach(function (id, i) { set(m, id, 30, 6 + i * 6); });
}
function parkHome(m) {
  ['h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'h9', 'h11'].forEach(function (id, i) { set(m, id, 25, 6 + i * 6); });
  set(m, 'h1', 5, 34);
}

console.log('== 1. 持球突破过掉防守队员，随后 4 秒只往中间带球：无越位哨 ==');
(function () {
  whistles = [];
  var m = newMatch(1);
  awayLine(m); parkHome(m);
  var me = P(m, 'h10');
  set(m, 'h10', 40, 34);
  m.ball.ownerId = 'h10'; m.ball.x = 40; m.ball.y = 34;
  set(m, 'a4', 42, 34);
  m.resolveAction(me, 'dribble', 100); // 强制突破成功
  ok(m.ball.ownerId === 'h10', '突破后球权仍在自己脚下');
  for (var i = 0; i < 40; i++) { // 4 秒纯带球（越过越位线但不进禁区）
    m.setInput({ dx: 0.8, dy: 0.1 });
    m.control.activeStamp = m.now;
    m.tick();
  }
  ok(whistles.length === 0, '纯带球 4 秒无越位哨', JSON.stringify(whistles));
  ok(m.phase === 'play', '全程未进入异常阶段', m.phase);
})();

console.log('== 2. 突破传送瞬间几何检查：持球人不可能处于越位位置 ==');
(function () {
  var m = newMatch(2);
  awayLine(m); parkHome(m);
  var me = P(m, 'h10');
  set(m, 'h10', 72, 34);
  m.ball.ownerId = 'h10'; m.ball.x = 72; m.ball.y = 34;
  set(m, 'a4', 74, 34);
  m.resolveAction(me, 'dribble', 100); // 传送到 (81, ~32)，球尚未跟上
  var snapBefore = Offside.snapshot(m, 'home');
  var geoBefore = Offside.isOffsidePosition(me, snapBefore); // 传送窗口内几何上"越位"
  m.tick(); // 球跟上：ball.x = carrier.x + 1.2
  var geoAfter = Offside.isOffsidePosition(me, Offside.snapshot(m, 'home'));
  ok(geoBefore === true, '传送窗口内几何越位为真（记录该窗口存在）', 'h10.x=' + me.x.toFixed(1));
  ok(geoAfter === false, 'tick 后球跟上，持球人几何越位恒为假');
})();

console.log('== 3. 对照：突破后传给越位位置队友 → 哨声点名接球人 ==');
(function () {
  whistles = [];
  var m = newMatch(3);
  awayLine(m); parkHome(m);
  var me = P(m, 'h10');
  set(m, 'h10', 40, 34);
  m.ball.ownerId = 'h10';
  set(m, 'a4', 42, 34);
  m.resolveAction(me, 'dribble', 100);
  m.tick();
  set(m, 'h9', 85, 40); // 队友站在越位位置
  m.resolveAction(me, 'pass', 100, { aimX: 85, aimY: 40, height: 'low' });
  ok(whistles.length === 1 && whistles[0].player === 'h9' && whistles[0].reason === 'receive',
    '误传越位队友：哨声点名的是接球人而非传球人', JSON.stringify(whistles));
})();

E.Match.prototype.whistleOffside = origWhistle;
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
