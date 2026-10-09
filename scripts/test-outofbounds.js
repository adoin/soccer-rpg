// scripts/test-outofbounds.js
// 出界判罚测试（IFAB Law 15/16/17）：固定种子，可重复。
//   · 边线 → 界外球（最后触球方的对手掷，出界点，最近非门将执行）
//   · 球门线 + 进攻方最后触球 → 球门球（门将球，对方退出大禁区）
//   · 球门线 + 防守方最后触球 → 角球（就近角球弧，对方退 9.15 米）
//   · 入门 → 进球
//   · 界外球/球门球/角球直接发出 → 不判越位（Law 11）；带球走远后传按常规
'use strict';

var E = require('../server/game/engine');
var FIELD = require('../shared/constants').FIELD;

var failures = 0;
function ok(cond, name, extra) {
  if (cond) { console.log('  PASS ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

function newMatch(seed) {
  var m = new E.Match('t' + seed, { seed: seed, halfLength: 60 });
  m.destroy();
  m.phase = 'play';
  return m;
}
// 自由球滚出界：直接摆球+速度，调 whistleOutOfBounds
function outBall(m, x, y, lastTeam, lastId) {
  m.ball.ownerId = null;
  m.ball.x = x; m.ball.y = y;
  m.ball.vx = 0; m.ball.vy = 0;
  m.ball.lastTouchTeam = lastTeam;
  m.ball.lastTouchId = lastId || null;
  m.whistleOutOfBounds();
}

// ---- 1. 边线 → 界外球 ----
(function () {
  var m = newMatch(1);
  outBall(m, 60, -0.5, 'home', null); // 主队最后触球，球过下边线
  ok(m.lastAction && m.lastAction.kind === 'throwin', '边线出界判界外球', JSON.stringify(m.lastAction && m.lastAction.kind));
  ok(m.lastAction.team === 'away', '界外球给客队（最后触球方的对手）', m.lastAction.team);
  var taker = m.byId[m.ball.ownerId];
  ok(taker && taker.team === 'away' && taker.pos !== 'GK', '掷球者是客队非门将', taker && taker.name);
  ok(Math.abs(m.ball.y - 2) < 0.01, '球在边线内侧', m.ball.y);
  ok(m.ball.restartExempt && m.ball.restartExempt.takerId === taker.id, '设置越位豁免', JSON.stringify(m.ball.restartExempt));
  ok(m.phase === 'whistle', '进入 whistle 停表', m.phase);
})();

// ---- 2. 球门线 + 进攻方触球 → 球门球 ----
// 主队进攻右端 (x=W)，球过右球门线、主队最后触球 → 客队球门球
(function () {
  var m = newMatch(2);
  outBall(m, FIELD.W + 0.5, 20, 'home', null); // y=20 不在门内（门在 y=34±3.66）
  ok(m.lastAction && m.lastAction.kind === 'goalkick', '球门线+进攻方触球判球门球', JSON.stringify(m.lastAction && m.lastAction.kind));
  ok(m.lastAction.team === 'away', '球门球给防守方（客队）', m.lastAction.team);
  var keeper = m.byId[m.ball.ownerId];
  ok(keeper && keeper.pos === 'GK' && keeper.team === 'away', '球给客队门将', keeper && keeper.name);
  // 对方（主队）退出大禁区
  var bad = m.players.filter(function (q) { return q.team === 'home' && !q.sentOff && q.x > FIELD.W - 16.5; });
  ok(bad.length === 0, '对方退出大禁区', bad.length + '人还在禁区内');
})();

// ---- 3. 球门线 + 防守方触球 → 角球 ----
(function () {
  var m = newMatch(3);
  outBall(m, FIELD.W + 0.5, 20, 'away', null); // 客队（防守方）最后触球
  ok(m.lastAction && m.lastAction.kind === 'corner', '球门线+防守方触球判角球', JSON.stringify(m.lastAction && m.lastAction.kind));
  ok(m.lastAction.team === 'home', '角球给进攻方（主队）', m.lastAction.team);
  var taker = m.byId[m.ball.ownerId];
  ok(taker && taker.team === 'home', '主罚者是主队', taker && taker.name);
  ok(Math.abs(m.ball.x - (FIELD.W - 2)) < 0.01, '球在就近角球弧', m.ball.x + ',' + m.ball.y);
  // 对方退 9.15 米
  var bad = m.players.filter(function (q) {
    if (q.team === 'home' || q.sentOff) return false;
    var d = Math.sqrt((q.x - m.ball.x) * (q.x - m.ball.x) + (q.y - m.ball.y) * (q.y - m.ball.y));
    return d < 9.15 - 0.01;
  });
  ok(bad.length === 0, '对方退足 9.15 米', bad.length + '人太近');
})();

// ---- 4. 滚入球门 → 进球 ----
(function () {
  var m = newMatch(4);
  var s0 = m.score.home;
  outBall(m, FIELD.W + 0.5, FIELD.H / 2, 'home', null); // 门内
  ok(m.score.home === s0 + 1, '自由球滚入球门算进球', m.score.home + ' vs ' + (s0 + 1));
  ok(m.phase === 'goal', '进入进球庆祝', m.phase);
})();

// ---- 5. 界外球直接发出不越位 ----
// 掷球者在边线，队友站在越位位置，掷球者直接传 → 不吹
(function () {
  var m = newMatch(5);
  outBall(m, 60, -0.5, 'home', null); // 客队界外球
  var taker = m.byId[m.ball.ownerId];
  // 把一个客队前锋放到越位位置（主队半场深处）
  var fwd = null;
  m.players.forEach(function (q) { if (q.team === 'away' && q.pos === 'FW' && !q.sentOff && !fwd) fwd = q; });
  fwd.x = 90; fwd.y = 34;
  // 掷球者在原地，直接"传"（调豁免判定）
  ok(m.isRestartExempt(taker) === true, '掷球者在原地：豁免生效', m.isRestartExempt(taker));
  // 带球走远后豁免消失
  taker.x += 5;
  ok(m.isRestartExempt(taker) === false, '带球走远 5 米：豁免消失', m.isRestartExempt(taker));
  // 非掷球者无豁免
  taker.x -= 5;
  var other = null;
  m.players.forEach(function (q) { if (q.team === 'away' && q.id !== taker.id && !q.sentOff && !other) other = q; });
  ok(m.isRestartExempt(other) === false, '非掷球者无豁免', m.isRestartExempt(other));
})();

// ---- 6. 左端对称：客队进攻左端 ----
// 球过左球门线、客队最后触球 → 主队球门球
(function () {
  var m = newMatch(6);
  outBall(m, -0.5, 20, 'away', null);
  ok(m.lastAction && m.lastAction.kind === 'goalkick', '左端球门线+进攻方触球判球门球', JSON.stringify(m.lastAction && m.lastAction.kind));
  ok(m.lastAction.team === 'home', '球门球给主队', m.lastAction.team);
})();
// 球过左球门线、主队（防守方）最后触球 → 客队角球
(function () {
  var m = newMatch(7);
  outBall(m, -0.5, 50, 'home', null);
  ok(m.lastAction && m.lastAction.kind === 'corner', '左端球门线+防守方触球判角球', JSON.stringify(m.lastAction && m.lastAction.kind));
  ok(m.lastAction.team === 'away', '角球给客队', m.lastAction.team);
  ok(Math.abs(m.ball.x - 2) < 0.01, '球在左端角球弧', m.ball.x + ',' + m.ball.y);
})();

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
