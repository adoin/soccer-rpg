// scripts/test-intercept.js
// 实时拦截系统专项测试（2026-09-28）：
//   高度包络 / swept 检查 / 能力对决 / 射门堵枪眼 / 弹开→自由球 / 线路成功率。
'use strict';

var E = require('../server/game/engine');
var mulberry32 = require('../server/rng').mulberry32;
var Intercept = require('../server/game/rules/intercept');
var Pass = require('../server/game/rules/pass');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) { console.log('  PASS ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function newMatch(seed) {
  var m = new E.Match('i' + seed, { seed: seed, halfLength: 60 });
  m.destroy();
  m.phase = 'play';
  m.now = 10000;
  return m;
}
function P(m, id) { return m.byId[id]; }
function set(m, id, x, y) { var p = P(m, id); p.x = x; p.y = y; p._px = x; p._py = y; p._vx = 0; p._vy = 0; }

console.log('== 高度包络 ==');
(function () {
  ok(Intercept.heightAt(11, 0.5) === 11, '超高球顶点 11m');
  ok(Intercept.heightAt(11, 0) === 0 && Intercept.heightAt(11, 1) === 0, '起落点高度 0');
  var zMid = Intercept.heightAt(11, 0.15);
  ok(zMid > 2.6, '超高球 k=0.15 已超 2.6m（常人够不着）', 'z=' + zMid.toFixed(2));
  ok(Intercept.envelope(0.5, false).radius === 1.6, '地面球包络 1.6m');
  ok(Intercept.envelope(2.0, false).radius === 1.1, '空中球包络 1.1m');
  ok(Intercept.envelope(3.0, false) === null, '3m 高空够不着');
  ok(Intercept.envelope(3.0, true).radius === 1.1, '门将 3m 能够到');
  ok(Intercept.envelope(5.0, true) === null, '门将 5m 也够不着');
})();

console.log('== swept-segment 防隧道 ==');
(function () {
  // 高速球一 tick 跨过防守队员：点检查会漏，线段检查必须命中
  var sd = Intercept.segDist(60, 34, 50, 34, 70, 34);
  ok(sd.d < 0.01 && sd.t > 0.4 && sd.t < 0.6, '线段中点命中', JSON.stringify(sd));
  var sd2 = Intercept.segDist(60, 36, 50, 34, 70, 34);
  ok(Math.abs(sd2.d - 2) < 0.01, '横向 2m 距离', 'd=' + sd2.d.toFixed(2));
})();

console.log('== 射门堵枪眼 ==');
(function () {
  var blocked = 0, N = 20;
  for (var s = 0; s < N; s++) {
    var m = newMatch(300 + s);
    var p = P(m, 'h9');
    set(m, 'h9', 85, 34);
    set(m, 'a4', 90, 34);   // 射门线路上 5 米
    set(m, 'a5', 70, 20);
    set(m, 'a1', 103, 34);
    m.ball.ownerId = p.id; m.ball.x = p.x; m.ball.y = p.y;
    m.startShotFlight(p, P(m, 'a1'), { outcome: 'goal', isSpecial: false, label: '射门', snap: null });
    var guard = 0;
    while (m.phase === 'shotflight' && guard++ < 300) m.tick();
    // 被干净挡下（防守得球）或弹开（自由球）都算堵住了
    var awayGot = m.ball.ownerId && m.byId[m.ball.ownerId].team === 'away';
    if (m.lastInterceptK != null || awayGot || m.ball.ownerId === null) blocked++;
  }
  ok(blocked >= 12, '线路上有后卫时 20 次至少 12 次被堵', blocked + '/' + N);
})();

console.log('== 弹开→自由球滚动→有人追到 ==');
(function () {
  var m = newMatch(400);
  var def = P(m, 'a4');
  set(m, 'a4', 60, 34);
  ['h8', 'h9', 'h10'].forEach(function (id, i) { set(m, id, 50 + i * 2, 30); });
  m.phase = 'play'; m.ball.ownerId = null;
  m.ball.x = 60; m.ball.y = 34;
  m.interceptDeflect({ player: def, d: 0.5, z: 0.3, aerial: false, k: 0.2 }, 20);
  ok(m.ball.ownerId === null, '弹开后成自由球');
  var spd0 = Math.sqrt(m.ball.vx * m.ball.vx + m.ball.vy * m.ball.vy);
  ok(spd0 > 1, '自由球带滚动速度', 'v=' + spd0.toFixed(1));
  ok(m.lastAction && !m.lastAction.cut, '弹开只有侧栏文字，不播全屏');
  var guard = 0;
  while (!m.ball.ownerId && guard++ < 100) m.tick(); // 追球
  ok(!!m.ball.ownerId, '自由球最终有人拿到', 'owner=' + m.ball.ownerId);
})();

console.log('== 自由球摩擦减速 ==');
(function () {
  var m = newMatch(401);
  m.ball.ownerId = null; m.ball.x = 50; m.ball.y = 34;
  m.ball.vx = 10; m.ball.vy = 0;
  // 把所有球员冻住，只看球滚
  m.players.forEach(function (p) { p.frozenUntil = m.now + 60000; });
  var v0 = Math.sqrt(m.ball.vx * m.ball.vx + m.ball.vy * m.ball.vy);
  for (var i = 0; i < 10; i++) m.tick();
  var v1 = Math.sqrt(m.ball.vx * m.ball.vx + m.ball.vy * m.ball.vy);
  ok(v1 < v0, '滚动摩擦减速', v0.toFixed(1) + '→' + v1.toFixed(1));
})();

console.log('== 线路成功率（菜单预估）诚实 ==');
(function () {
  var m = newMatch(500);
  var p = P(m, 'h10');
  set(m, 'h10', 50, 34);
  set(m, 'a4', 70, 20); // 远离
  var pp = { aimX: 66, aimY: 34, technique: 'inside', height: 'mid' };
  var land = Pass.computeLanding(p, pp, 80);
  var open = Pass.laneRate(m, p, pp, land);
  set(m, 'a4', 58, 34); // 站到线路上
  set(m, 'a5', 60, 35);
  var blocked = Pass.laneRate(m, p, pp, land);
  ok(open > blocked, '线路被封死时成功率更低', open + ' → ' + blocked);
  var highBall = Pass.laneRate(m, p, { aimX: 66, aimY: 34, technique: 'inside', height: 'high' }, land);
  ok(highBall > blocked, '同样线路用高球成功率回升', blocked + ' → ' + highBall);
})();

console.log('== AI 走廊避让 ==');
(function () {
  var m = newMatch(600);
  var p = P(m, 'h10');
  set(m, 'h10', 50, 34);
  set(m, 'a4', 58, 34); // 封死 mid 走廊
  var tgt = { x: 66, y: 34 };
  var nMid = Pass.corridorBlocked(m, p, tgt, Pass.HEIGHTS.mid);
  var nHigh = Pass.corridorBlocked(m, p, tgt, Pass.HEIGHTS.high);
  ok(nMid > 0, 'mid 走廊被封死（静态检查能发现）', 'n=' + nMid);
  ok(nHigh < nMid, 'high 走廊更安全', 'mid=' + nMid + ' high=' + nHigh);
})();

console.log('== 扑空踉跄（miss→beaten） ==');
(function () {
  // 构造必扑空：防守能力极低、球速极快 → resolveContest 掷骰分布检查
  var m = newMatch(700);
  var def = P(m, 'a4');
  def.stats.tackling = 1; def.stats.anticipation = 1; def.stats.positioning = 1;
  def.stamina = 100;
  var res = { clean: 0, deflect: 0, miss: 0 };
  for (var s = 0; s < 60; s++) {
    m.rng = mulberry32(7000 + s);
    var r = Intercept.resolveContest(m, { player: def, d: 1.2, z: 0.5, aerial: false, k: 0.3 }, 30);
    res[r]++;
  }
  ok(res.miss > res.clean, '弱防守+快球：扑空多于干净断下', JSON.stringify(res));
})();

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
