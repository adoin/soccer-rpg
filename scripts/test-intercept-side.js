// scripts/test-intercept-side.js
// 侧面跑入线路的拦截（2026-10-09）：之前 4 个拦截场景已浏览器验收，
// 唯独"侧面跑入线路"没有确定性验证。本脚本用真实引擎 tick 做确定性复现：
//   防守队员从线路侧面启动，飞行途中跑入线路，swept-segment 实时判定必须捕捉到。
// 断言的是"被判定捕捉到"（lastInterceptK != null），与掷骰结果（断/弹开/扑空）无关。
'use strict';

var E = require('../server/game/engine');
var Intercept = require('../server/game/rules/intercept');

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
function set(m, id, x, y) {
  var p = P(m, id);
  p.x = x; p.y = y; p._px = x; p._py = y; p._vx = 0; p._vy = 0;
  p.frozenUntil = 0; p.beatenUntil = 0;
}
function freezeAllBut(m, keep) {
  m.players.forEach(function (p) {
    if (keep.indexOf(p.id) < 0) { p.frozenUntil = m.now + 60000; p.x = 8; p.y = 8; }
  });
}
// 跑一次完整的低球传球飞行，返回 { interceptedK, outcome }
function runSideEntry(seed, defX, defY) {
  var m = newMatch(seed);
  var passer = P(m, 'h10'), recv = P(m, 'h9'), def = P(m, 'a4');
  set(m, 'h10', 50, 34);
  set(m, 'h9', 62, 34);
  set(m, 'a4', defX, defY);
  freezeAllBut(m, ['h10', 'h9', 'a4']);
  m.ball.ownerId = passer.id; m.ball.x = 50; m.ball.y = 34; m.ball.z = 0;
  m.startPassFlight(passer, { x1: 62, y1: 34, durMs: 450, height: 'low', receiverId: recv.id });
  var guard = 0, minD = 1e9;
  while (m.phase === 'passflight' && guard++ < 200) {
    m.tick();
    if (m.passFlight) {
      var d = Intercept.segDist(def.x, def.y, m.ball.x, m.ball.y, m.ball.x, m.ball.y).d;
      if (d < minD) minD = d;
    }
  }
  return { k: m.lastInterceptK, minD: minD, phase: m.phase, owner: m.ball.ownerId };
}

console.log('== 单元层：swept-segment 捕捉侧面切入 ==');
(function () {
  // 球本 tick 从 (56,34) 走到 (56.5,34)；防守队员上一 tick 在 1.8m 外，这一 tick 切到 0.5m
  var m = newMatch(1);
  var def = P(m, 'a4');
  set(m, 'a4', 56, 32.2); // 距线路 1.8m
  var flight = { px: 56, py: 34, x: 56.5, y: 34, k0: 0.5, k1: 0.54, peak: 0.4, team: 'home', passerId: 'h10', receiverId: 'h9' };
  ok(Intercept.checkInterception(m, flight) === null, '1.8m 外不触发');
  set(m, 'a4', 56, 33.5); // 距线路 0.5m：侧面切入
  var hit = Intercept.checkInterception(m, flight);
  ok(hit && hit.player.id === 'a4', '0.5m 侧面切入被捕捉', hit ? 'd=' + hit.d.toFixed(2) + ' z=' + hit.z.toFixed(2) : 'null');
})();

console.log('== 集成层：真实飞行中侧面跑入被断 ==');
(function () {
  // 场景 A：防守队员在线路侧面 2m、稍靠前，球经过时他正好切入
  var seeds = [11, 12, 13, 14, 15];
  var allHit = true, ks = [];
  seeds.forEach(function (s) {
    var r = runSideEntry(s, 59, 32);
    ks.push(r.k == null ? 'x' : r.k.toFixed(2));
    if (r.k == null) allHit = false;
  });
  ok(allHit, '5 个种子下侧面 2m 切入全部被捕捉', 'k=[' + ks.join(',') + ']');

  // 场景 B：防守队员在线路侧面 2m、稍靠后（回追身位），同样应被捕捉
  var allHitB = true, ksB = [];
  seeds.forEach(function (s) {
    var r = runSideEntry(100 + s, 57, 32);
    ksB.push(r.k == null ? 'x' : r.k.toFixed(2));
    if (r.k == null) allHitB = false;
  });
  ok(allHitB, '5 个种子下侧面 2m 回追切入全部被捕捉', 'k=[' + ksB.join(',') + ']');
})();

console.log('== 对照：远离线路的防守队员不应触发 ==');
(function () {
  var m = newMatch(21);
  var passer = P(m, 'h10'), recv = P(m, 'h9');
  set(m, 'h10', 50, 34);
  set(m, 'h9', 62, 34);
  set(m, 'a4', 58, 26); // 侧面 8m：追不上
  freezeAllBut(m, ['h10', 'h9', 'a4']);
  m.ball.ownerId = passer.id; m.ball.x = 50; m.ball.y = 34;
  m.startPassFlight(passer, { x1: 62, y1: 34, durMs: 450, height: 'low', receiverId: recv.id });
  var guard = 0;
  while (m.phase === 'passflight' && guard++ < 200) m.tick();
  ok(m.lastInterceptK == null, '8m 外追不上：无拦截', 'k=' + m.lastInterceptK);
  ok(m.ball.ownerId === recv.id, '球正常到达接应队员', 'owner=' + m.ball.ownerId);
})();

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
