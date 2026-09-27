// scripts/test-passflight.js
// 传球飞行阶段测试：掷骰定结果 → 球飞向落点 → 接应者跑位/防守追球 → 落地结算
// （回归：传球曾直接瞬移球到结果位置，全程无轨迹、无追球）
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
function set(m, id, x, y) { var p = P(m, id); p.x = x; p.y = y; }

// 直接起飞（绕过掷骰，outcome 指定）
function kickoff(m, o) {
  var p = P(m, 'h10');
  set(m, 'h10', 50, 34);
  set(m, 'h8', 40, 30);   // 接应者
  set(m, 'a4', 62, 38);   // 拦截者/防守
  set(m, 'a5', 70, 30);
  m.ball.ownerId = p.id; m.ball.x = p.x; m.ball.y = p.y;
  m.startPassFlight(p, {
    x1: 66, y1: 34, durMs: 800,
    outcome: o.outcome, receiverId: o.receiverId || 'h8', interceptorId: o.interceptorId || 'a4',
    text: o.text || '测试传球', cut: o.cut || 'pass-win', success: o.outcome === 'recv', label: '传球',
  });
  return p;
}
function runFlight(m) {
  var guard = 0;
  while (m.phase === 'passflight' && guard++ < 500) m.tick();
  return guard;
}

console.log('== 传球飞行：成功接应 ==');
(function () {
  var m = newMatch(11);
  kickoff(m, { outcome: 'recv' });
  ok(m.phase === 'passflight', '传球后进入 passflight 阶段');
  ok(m.ball.ownerId === null, '飞行中球无主人（不是瞬移给接应者）');
  ok(!m.lastAction, '飞行中不提前出文字/演出');
  var bx0 = m.ball.x;
  var rx0 = P(m, 'h8').x, ry0 = P(m, 'h8').y;
  var ax0 = P(m, 'a4').x;
  m.tick(); m.tick(); m.tick();
  ok(m.ball.x > bx0 + 0.5 && m.ball.x < 66, '球在飞向落点途中（非瞬移）', 'ball.x=' + m.ball.x.toFixed(1));
  ok(Math.abs(P(m, 'h8').x - rx0) + Math.abs(P(m, 'h8').y - ry0) > 0.1, '接应者跑向落点');
  ok(Math.abs(P(m, 'a4').x - ax0) > 0.05, '防守球员追球移动');
  var n = runFlight(m);
  ok(n < 500, '飞行阶段正常结束');
  ok(m.phase === 'play', '结束后回到 play', 'phase=' + m.phase);
  ok(m.ball.ownerId === 'h8', '球交给接应者', 'owner=' + m.ball.ownerId);
  ok(Math.abs(m.ball.x - 66) < 0.6 && Math.abs(m.ball.y - 34) < 0.6, '球停在落点');
  ok(m.lastAction && m.lastAction.cut === 'pass-win', '接应演出 cut=pass-win', m.lastAction && m.lastAction.cut);
})();

console.log('== 传球飞行：被拦截 ==');
(function () {
  var m = newMatch(22);
  kickoff(m, { outcome: 'intercept', text: '被断', cut: 'pass-lose' });
  runFlight(m);
  ok(m.phase === 'play', '拦截后回到 play');
  ok(m.ball.ownerId === 'a4', '球交给拦截者', 'owner=' + m.ball.ownerId);
  ok(m.lastAction && m.lastAction.cut === 'pass-lose', '被断演出 cut=pass-lose', m.lastAction && m.lastAction.cut);
  ok(/测试传球|被断/.test(m.lastAction.text), '被断文字正确', m.lastAction.text);
})();

console.log('== 传球飞行：收步改传（无人接应→防守得球） ==');
(function () {
  var m = newMatch(33);
  kickoff(m, { outcome: 'intercept', interceptorId: 'a5', receiverId: null, text: '滚向无人地带', cut: 'pass-lose' });
  runFlight(m);
  ok(m.ball.ownerId === 'a5', '无人接应时离落点最近的防守球员得球', 'owner=' + m.ball.ownerId);
})();

console.log('== applyCommand 传球走飞行（非瞬移） ==');
(function () {
  var m = newMatch(44);
  var p = P(m, 'h10');
  set(m, 'h10', 50, 34);
  ['a2','a3','a4','a5','a6','a7','a8','a9','a10','a11'].forEach(function (id, i) { set(m, id, 60, 8 + i * 5); });
  ['h2','h3','h4','h5','h6','h7','h8','h9','h11'].forEach(function (id, i) { set(m, id, 45, 8 + i * 5); });
  m.ball.ownerId = p.id; m.ball.x = p.x; m.ball.y = p.y;
  m.phase = 'decision';
  m.decision = { playerId: p.id, options: [{ id: 'pass', rate: 90, enabled: true, cost: 3 }] };
  var r = m.applyCommand(p.id, 'pass', { kind: 'short', dir: 0, technique: 'inside', height: 'mid', power: 60 });
  ok(r.ok, '指令接受');
  ok(r.result && r.result.pending === true, '返回 pending（结果未瞬时结算）');
  ok(m.phase === 'passflight', '进入 passflight 阶段', 'phase=' + m.phase);
  ok(m.ball.ownerId === null, '球未瞬移给任何人');
  var mid = null;
  m.tick(); m.tick();
  mid = { x: m.ball.x, y: m.ball.y };
  runFlight(m);
  ok(m.lastAction && (m.lastAction.cut === 'pass-win' || m.lastAction.cut === 'pass-lose'),
    '飞行后按掷骰结果出演出', m.lastAction && m.lastAction.cut);
  ok(m.lastAction && m.lastAction.text.length > 0, '飞行后才出文字', m.lastAction && m.lastAction.text);
  void mid;
})();

console.log('== 飞行时长来自传球高度 ==');
(function () {
  var Pass = require('../server/game/rules/pass');
  var m = newMatch(55);
  var p = P(m, 'h10');
  set(m, 'h10', 50, 34);
  ['low', 'mid', 'high', 'vhigh'].forEach(function (h) {
    var land = Pass.computeLanding(p, { kind: 'short', dir: 0, technique: 'inside', height: h, power: 50 }, 80);
    var expect = { low: 450, mid: 650, high: 950, vhigh: 1300 }[h];
    ok(land.flightMs === expect, '高度 ' + h + ' → 飞行 ' + expect + 'ms', 'flightMs=' + land.flightMs);
  });
  // startPassFlight 采用 computeLanding 的 flightMs
  var land2 = Pass.computeLanding(p, { kind: 'short', dir: 0, technique: 'inside', height: 'high', power: 50 }, 80);
  m.ball.ownerId = p.id;
  m.startPassFlight(p, { x1: 60, y1: 34, durMs: land2.flightMs, outcome: 'recv', receiverId: 'h8', text: 't', cut: 'pass-win', success: true, label: '传球' });
  ok(m.passFlight.durMs === 950, '高球飞行 950ms', 'dur=' + m.passFlight.durMs);
})();

if (failures) { console.log('\nFAILURES: ' + failures); process.exit(1); }
console.log('\nALL TESTS PASSED');
