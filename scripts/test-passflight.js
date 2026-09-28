// scripts/test-passflight.js
// 传球飞行阶段测试（2026-09-28 实时拦截制）：
//   开球瞬间不再掷骰定结果。球按高度抛物线飞向落点，途中实时拦截判定，
//   落地按落点归属结算。完成/拦截都不播全屏演出（开放比赛的一部分）。
'use strict';

var E = require('../server/game/engine');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) { console.log('  PASS ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function newMatch(seed) {
  var m = new E.Match('p' + seed, { seed: seed, halfLength: 60 });
  m.destroy();
  m.phase = 'play';
  m.now = 10000;
  return m;
}
function P(m, id) { return m.byId[id]; }
function set(m, id, x, y) { var p = P(m, id); p.x = x; p.y = y; p._px = x; p._py = y; }

// 直接起飞（新签名）：{x1, y1, durMs, height, receiverId}
function kickoff(m, o) {
  var p = P(m, 'h10');
  set(m, 'h10', 50, 34);
  m.ball.ownerId = p.id; m.ball.x = p.x; m.ball.y = p.y;
  m.startPassFlight(p, {
    x1: o.x1 == null ? 66 : o.x1, y1: o.y1 == null ? 34 : o.y1,
    durMs: o.durMs || 800, height: o.height || 'mid',
    receiverId: o.receiverId === undefined ? 'h8' : o.receiverId,
  });
  return p;
}
function runFlight(m) {
  var guard = 0;
  while (m.phase === 'passflight' && guard++ < 500) m.tick();
  return guard;
}

console.log('== 传球飞行：干净接应（无防守在线路上） ==');
(function () {
  var m = newMatch(11);
  set(m, 'h8', 65.5, 34); // 接应者紧贴落点
  // 所有防守队员远离落点 15 米以上（800ms 内谁都冲不过来），测"干净接应"机制
  ['a2','a3','a4','a5','a6','a7','a8','a9','a10','a11'].forEach(function (id, i) { set(m, id, 40, 8 + i * 5); });
  kickoff(m, { height: 'mid' });
  ok(m.phase === 'passflight', '传球后进入 passflight 阶段');
  ok(m.ball.ownerId === null, '飞行中球无主人（不是瞬移给接应者）');
  ok(!m.lastAction, '飞行中不提前出文字/演出');
  var bx0 = m.ball.x;
  m.tick(); m.tick(); m.tick();
  ok(m.ball.x > bx0 + 0.5 && m.ball.x < 66, '球在飞向落点途中（非瞬移）', 'ball.x=' + m.ball.x.toFixed(1));
  ok(m.ball.z > 0.2, 'mid 高度球升空（抛物线）', 'z=' + m.ball.z.toFixed(2));
  var n = runFlight(m);
  ok(n < 500, '飞行阶段正常结束');
  ok(m.phase === 'play', '结束后回到 play', 'phase=' + m.phase);
  ok(m.ball.ownerId === 'h8', '落点最近的接应者得球', 'owner=' + m.ball.ownerId);
  ok(m.ball.z === 0, '落地后高度归零');
  ok(!m.lastAction || !m.lastAction.cut, '常规完成不播全屏演出');
})();

console.log('== 传球飞行：当面低球被断（2 米贴脸在线路上） ==');
(function () {
  var stopped = 0, N = 20;
  for (var s = 0; s < N; s++) {
    var m = newMatch(100 + s);
    set(m, 'h8', 63, 34);
    set(m, 'a4', 52, 34);   // 当面 2 米，正在线路上
    set(m, 'a5', 70, 20);
    kickoff(m, { height: 'low' });
    runFlight(m);
    // 被断（clean）或弹开（deflect→自由球）都算"没能从容穿过"
    var awayGot = m.ball.ownerId && m.byId[m.ball.ownerId].team === 'away';
    if (m.lastInterceptK != null || awayGot || m.ball.ownerId === null) stopped++;
  }
  ok(stopped >= 17, '当面低球 20 次至少 17 次被断/弹开（不穿过）', stopped + '/' + N);
})();

console.log('== 传球飞行：超高球中段无人能及 ==');
(function () {
  var bad = 0, N = 10, midZ0 = 0;
  for (var s = 0; s < N; s++) {
    var m = newMatch(200 + s);
    set(m, 'h8', 63, 34);
    set(m, 'a4', 52, 34);   // 同样站在 2 米线路上
    set(m, 'a5', 70, 20);
    kickoff(m, { height: 'vhigh', durMs: 1300 });
    // 飞到中段（k≈0.46）时球应在高空：只走 6 tick 就采样
    for (var ti = 0; ti < 6 && m.phase === 'passflight'; ti++) m.tick();
    if (s === 0) midZ0 = m.phase === 'passflight' ? m.ball.z : -1;
    runFlight(m);
    // 中段（k<0.7）绝不能发生拦截；只允许初段/末段
    if (m.lastInterceptK != null && m.lastInterceptK < 0.7) bad++;
  }
  ok(midZ0 > 4, '超高球中段在高空', 'z=' + midZ0.toFixed(1));
  ok(bad === 0, '超高球 10 次中段（k<0.7）零拦截', 'bad=' + bad);
})();

console.log('== 传球飞行：收步改传（无人接应→落点结算） ==');
(function () {
  var m = newMatch(33);
  set(m, 'h8', 40, 30);   // 接应者远离
  set(m, 'a4', 62, 38);
  set(m, 'a5', 64, 30);   // 防守靠近落点
  kickoff(m, { receiverId: null, height: 'mid' });
  runFlight(m);
  var owner = m.ball.ownerId;
  ok(owner && m.byId[owner].team === 'away', '无人接应时防守方得球', 'owner=' + owner);
})();

console.log('== 落点贴身争抢看能力（直接测落点结算） ==');
(function () {
  var m = newMatch(44);
  var h8 = P(m, 'h8'), a4 = P(m, 'a4');
  set(m, 'h8', 66, 34);
  set(m, 'a4', 66.3, 34); // 0.3m 贴身，不同队 → 能力对决
  set(m, 'a5', 70, 20);
  // 直接摆好落点局面测 finishPassFlight（不走飞行，避免 a4 在终点前被判拦截）
  m.ball.x = 66; m.ball.y = 34; m.ball.z = 0; m.ball.ownerId = null;
  m.passFlight = { passerId: 'h10', team: 'home', x0: 50, y0: 34, x1: 66, y1: 34,
    startAt: m.now - 800, durMs: 800, peak: 0.4, ballSpeed: 20, receiverId: 'h8' };
  m.phase = 'passflight'; m.phaseUntil = m.now;
  m.finishPassFlight();
  var sH = h8.stats.anticipation + h8.stats.firstTouch;
  var sA = a4.stats.anticipation + a4.stats.firstTouch;
  var expect = sH + 3 >= sA ? 'h8' : 'a4'; // 接应者 +3 身位优势
  ok(m.phase === 'play', '结算后回到 play');
  ok(m.ball.ownerId === expect, '能力高者得球', 'owner=' + m.ball.ownerId + ' expect=' + expect);
})();

console.log('== applyCommand 传球走飞行（非瞬移） ==');
(function () {
  var m = newMatch(55);
  var p = P(m, 'h10');
  set(m, 'h10', 50, 34);
  ['a2','a3','a4','a5','a6','a7','a8','a9','a10','a11'].forEach(function (id, i) { set(m, id, 60, 8 + i * 5); });
  ['h2','h3','h4','h5','h6','h7','h8','h9','h11'].forEach(function (id, i) { set(m, id, 45, 8 + i * 5); });
  m.ball.ownerId = p.id; m.ball.x = p.x; m.ball.y = p.y;
  m.phase = 'decision';
  m.decision = { playerId: p.id, options: [{ id: 'pass', rate: 90, enabled: true, cost: 3 }] };
  var r = m.applyCommand(p.id, 'pass', { aimX: 66, aimY: 34, technique: 'inside', height: 'mid' });
  ok(r.ok, '指令接受');
  ok(r.result && r.result.pending === true, '返回 pending（结果未瞬时结算）');
  ok(m.phase === 'passflight', '进入 passflight 阶段', 'phase=' + m.phase);
  ok(m.ball.ownerId === null, '球未瞬移给任何人');
  runFlight(m);
  ok(!m.lastAction || !m.lastAction.cut, '飞行后不出全屏演出（常规传球）');
})();

console.log('== 飞行时长来自传球高度 ==');
(function () {
  var Pass = require('../server/game/rules/pass');
  var m = newMatch(66);
  var p = P(m, 'h10');
  set(m, 'h10', 50, 34);
  ['low', 'mid', 'high', 'vhigh'].forEach(function (h) {
    var land = Pass.computeLanding(p, { technique: 'inside', height: h }, 80);
    var expect = { low: 450, mid: 650, high: 950, vhigh: 1300 }[h];
    ok(land.flightMs === expect, '高度 ' + h + ' → 飞行 ' + expect + 'ms', 'flightMs=' + land.flightMs);
  });
  void m;
})();

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
