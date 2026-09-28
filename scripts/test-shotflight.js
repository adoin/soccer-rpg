// scripts/test-shotflight.js
// 射门飞行阶段测试：掷骰定结果 → 球飞行 → 门将扑救动作 → 落地结算
'use strict';

var E = require('../server/game/engine');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) { console.log('  PASS ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function newMatch(seed) {
  var m = new E.Match('s' + seed, { seed: seed, halfLength: 60 });
  m.destroy();
  m.phase = 'play';
  m.now = 10000;
  return m;
}
function P(m, id) { return m.byId[id]; }
function set(m, id, x, y) { var p = P(m, id); p.x = x; p.y = y; }

// 把一次射门打到飞行阶段：直接调 startShotFlight（绕过掷骰，outcome 指定）
// ★ 新机制下射门线路上的防守者会真实堵枪眼，所以默认把所有客场外场球员清出线路
function kick(m, outcome, shooterId, isSpecial) {
  var p = P(m, shooterId || 'h10');
  set(m, 'h10', 60, 34); set(m, 'a1', 102, 34);
  ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11'].forEach(function (id, i) { set(m, id, 45, 8 + i * 5); });
  m.ball.ownerId = p.id; m.ball.x = p.x; m.ball.y = p.y;
  m.startShotFlight(p, P(m, 'a1'), {
    isSpecial: !!isSpecial, label: isSpecial ? '必杀' : '射门',
    outcome: outcome, snap: null,
  });
  return p;
}
function runFlight(m) {
  var guard = 0;
  while (m.phase === 'shotflight' && guard++ < 500) m.tick();
  return guard;
}

console.log('== 射门飞行阶段 ==');
(function () {
  var m = newMatch(11);
  var p = kick(m, 'goal');
  ok(m.phase === 'shotflight', '射门后进入 shotflight 阶段');
  ok(m.ball.ownerId === null, '飞行中球无主人');
  ok(m.shotFlight && m.shotFlight.outcome === 'goal', 'shotFlight 记录既定结果');
  var kx0 = P(m, 'a1').x, ky0 = P(m, 'a1').y;
  var bx0 = m.ball.x;
  m.tick(); m.tick(); m.tick();
  ok(m.ball.x > bx0 + 1, '球向对方球门飞行', 'ball.x=' + m.ball.x.toFixed(1));
  ok(Math.abs(P(m, 'a1').x - kx0) + Math.abs(P(m, 'a1').y - ky0) > 0.2, '门将做出扑救移动');
  var n = runFlight(m);
  ok(n < 500, '飞行阶段正常结束');
  ok(m.phase === 'goal', 'goal 结果 → 进球阶段', 'phase=' + m.phase);
  ok(m.score.home === 1, '比分+1');
  ok(m.lastAction && m.lastAction.cut === 'shoot-goal', '进球演出 cut=shoot-goal', m.lastAction && m.lastAction.cut);
})();

console.log('== 扑救结果 ==');
(function () {
  var m = newMatch(22);
  kick(m, 'saved');
  runFlight(m);
  ok(m.phase === 'play', 'saved 结果 → 回到 play', 'phase=' + m.phase);
  ok(m.ball.ownerId === 'a1', '球被门将得到', 'owner=' + m.ball.ownerId);
  ok(m.lastAction && m.lastAction.cut === 'shoot-save', '扑救演出 cut=shoot-save', m.lastAction && m.lastAction.cut);
  ok(/扑出/.test(m.lastAction.text), '扑救文字正确', m.lastAction.text);
})();

console.log('== 偏出结果 ==');
(function () {
  var m = newMatch(33);
  kick(m, 'miss');
  runFlight(m);
  ok(m.phase === 'whistle', 'miss 结果 → 哨声（门球）', 'phase=' + m.phase);
  ok(m.lastAction && m.lastAction.cut === 'shoot-miss', '偏出演出 cut=shoot-miss');
  // 哨声走完 → 门球给门将
  var guard = 0;
  while (m.phase === 'whistle' && guard++ < 500) m.tick();
  ok(m.phase === 'play' && m.ball.ownerId === 'a1', '门球开出，球权给门将', 'phase=' + m.phase + ' owner=' + m.ball.ownerId);
})();

console.log('== 必杀技飞行 ==');
(function () {
  var m = newMatch(44);
  var p = kick(m, 'goal', 'h10', true);
  ok(m.shotFlight.durMs > 0 && m.shotFlight.isSpecial, '必杀飞行参数正常');
  runFlight(m);
  ok(m.lastAction && m.lastAction.cut === 'special-goal', '必杀进球演出 cut=special-goal', m.lastAction && m.lastAction.cut);
})();

console.log('== 堵枪眼：线路上有防守者 ==');
(function () {
  var stopped = 0, attempted = 0, N = 20;
  for (var s = 0; s < N; s++) {
    var m = newMatch(500 + s);
    kick(m, 'goal');
    set(m, 'a4', 75, 34); // 站住射门线路（15 米处）
    P(m, 'a4')._vx = 0; P(m, 'a4')._vy = 0;
    runFlight(m);
    if (m.lastInterceptK != null) attempted++;
    if (m.phase !== 'goal') stopped++; // 被干净断下或弹开 → 没进
  }
  ok(attempted === N, '线路上有防守者时每次都有拦截尝试（不穿模）', attempted + '/' + N);
  ok(stopped > 0 && stopped < N, '堵截率合理（不是 0 也不是 100%）', stopped + '/' + N);
})();

console.log('== 落点合理性 ==');
(function () {
  var m = newMatch(55);
  kick(m, 'goal');
  var sf = m.shotFlight;
  ok(sf.x1 === 105, '进球落点在对方门线 x=105', 'x1=' + sf.x1);
  ok(Math.abs(sf.y1 - 34) < 3.66, '进球落点在门框内', 'y1=' + sf.y1.toFixed(1));
  ok(sf.durMs >= 450 && sf.durMs <= 1500, '飞行时长 0.45~1.5s', 'dur=' + sf.durMs);
})();

console.log('== resolveAction 射门走飞行 ==');
(function () {
  var m = newMatch(66);
  var p = P(m, 'h10');
  set(m, 'h10', 70, 34); set(m, 'a1', 102, 34);
  parkRest(m);
  m.ball.ownerId = p.id; m.ball.x = p.x; m.ball.y = p.y;
  m.phase = 'decision';
  m.decision = { playerId: p.id, options: [{ id: 'shoot', rate: 100, enabled: true, cost: 7 }] };
  var r = m.applyCommand(p.id, 'shoot');
  ok(r.ok, '指令接受');
  ok(m.phase === 'shotflight', 'applyCommand 后进入飞行阶段', 'phase=' + m.phase);
  ok(!m.lastAction, '飞行中不提前出演出/文字');
  runFlight(m);
  ok(m.phase === 'goal' && m.score.home === 1, 'rate=100 → 飞行后进球');
  function parkRest(mm) {
    ['a2','a3','a4','a5','a6','a7','a8','a9','a10','a11'].forEach(function (id, i) { set(mm, id, 55, 4 + i * 6.5); });
    ['h2','h3','h4','h5','h6','h7','h8','h9','h11'].forEach(function (id, i) { set(mm, id, 50, 4 + i * 6.5); });
  }
})();

if (failures) { console.log('\nFAILURES: ' + failures); process.exit(1); }
console.log('\nALL TESTS PASSED');
