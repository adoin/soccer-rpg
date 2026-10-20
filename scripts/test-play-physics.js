// scripts/test-play-physics.js
// 领球、弹跳、护球、回防切换、门将站位。固定种子，可重复。
'use strict';

var E = require('../server/game/engine');
var Ball = require('../server/game/rules/ballPhysics');
var Receive = require('../server/game/rules/receive');
var Shield = require('../server/game/rules/shield');
var GK = require('../server/game/rules/gk');
var Switch = require('../server/game/rules/switch');
var Behavior = require('../server/game/rules/behavior');
var mulberry32 = require('../server/rng').mulberry32;

var failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function newMatch(seed) {
  var m = new E.Match('p' + seed, { seed: seed, halfLength: 90 });
  m.destroy();
  m.phase = 'play';
  m.now = 10000;
  m.aiCooldownUntil = 1e15;
  m.nextDecisionAt = 1e15;
  m.nextDefDecisionAt = 1e15;
  return m;
}
function P(m, id) { return m.byId[id]; }
function set(m, id, x, y) {
  var p = P(m, id);
  p.x = x; p.y = y; p._px = x; p._py = y; p._vx = 0; p._vy = 0;
}
function freezeExcept(m, ids) {
  var keep = {};
  ids.forEach(function (id) { keep[id] = true; });
  m.players.forEach(function (p) {
    if (!keep[p.id]) p.frozenUntil = m.now + 60000;
  });
}
function setStat(p, key, v) { p.stats[key] = v; }

console.log('== 球物理：高球连跳，高度递减 ==');
(function () {
  var ball = { x: 50, y: 34, z: 0, vx: 7, vy: 0, vz: Math.sqrt(2 * Ball.G * 5.5), spin: 0 };
  var apexes = [];
  var prev = 0;
  var rising = false;
  for (var i = 0; i < 500; i++) {
    Ball.step(ball, 0.02, 'grass');
    if (ball.z > prev + 0.002) rising = true;
    else if (rising && prev > 0.35 && ball.z < prev - 0.002) {
      apexes.push(prev);
      rising = false;
    }
    prev = ball.z;
  }
  ok(apexes.length >= 3, '高球至少弹 3 次', 'apexes=' + apexes.map(function (z) { return z.toFixed(2); }).join(','));
  ok(apexes[1] < apexes[0] * 0.7 && apexes[2] < apexes[1] * 0.7, '每次回弹高度明显降低',
    apexes.slice(0, 3).map(function (z) { return z.toFixed(2); }).join(' > '));
  var wet = { x: 50, y: 34, z: 0, vx: 7, vy: 0, vz: Math.sqrt(2 * Ball.G * 5.5), spin: 0 };
  var wetApex = 0, wetPrev = 0, wetRise = false, wetN = 0;
  for (var j = 0; j < 500; j++) {
    Ball.step(wet, 0.02, 'wet');
    if (wet.z > wetPrev + 0.002) wetRise = true;
    else if (wetRise && wetPrev > 0.2 && wet.z < wetPrev - 0.002) {
      wetN++;
      if (wetN === 2) wetApex = wetPrev; // 第一次落地之后的那一跳
      wetRise = false;
    }
    wetPrev = wet.z;
  }
  ok(wetApex > 0 && wetApex < apexes[1], '湿地回弹低于草地', 'wet=' + wetApex.toFixed(2) + ' grass=' + apexes[1].toFixed(2));
})();

console.log('== 球物理：滚动摩擦、旋转、处理高度 ==');
(function () {
  var ball = { x: 40, y: 34, z: 0, vx: 9, vy: 0, vz: 0 };
  var x0 = ball.x;
  Ball.step(ball, 1.0, 'grass');
  ok(ball.x > x0 + 2, '落地后继续滚，不是瞬停', 'dx=' + (ball.x - x0).toFixed(2));
  ok(Math.hypot(ball.vx, ball.vy) < 9, '滚动摩擦把速度降下来', 'v=' + Math.hypot(ball.vx, ball.vy).toFixed(2));
  var straight = { x: 40, y: 30, z: 0, vx: 8, vy: 0, vz: 0, spin: 0 };
  var curve = { x: 40, y: 30, z: 0, vx: 8, vy: 0, vz: 0, spin: 1 };
  Ball.step(straight, 0.8, 'grass');
  Ball.step(curve, 0.8, 'grass');
  ok(Math.abs(curve.y - straight.y) > 0.15, '旋转让滚动轨迹偏开', 'dy=' + (curve.y - straight.y).toFixed(2));
  ok(Ball.controlBand(0.2) === 'foot' && Ball.controlBand(1.1) === 'chest' && Ball.controlBand(2.0) === 'header',
    '脚/胸/头高度带');
  ok(Ball.controlBand(3.0, false) === null && Ball.controlBand(3.0, true) === 'header',
    '过顶球只有门将还能够到');
  ok(Ball.controlBand(4.5, true) === null, '太高谁都处理不了');
})();

console.log('== 领球：落点在身前，接球人跑上去，球还在滚 ==');
(function () {
  var m = newMatch(11);
  set(m, 'h10', 40, 34);
  set(m, 'h9', 48, 34);
  set(m, 'a4', 92, 34);
  ['pace', 'acceleration'].forEach(function (k) { setStat(P(m, 'h9'), k, 18); setStat(P(m, 'a4'), k, 8); });
  freezeExcept(m, ['h9', 'a4']);
  m.ball.ownerId = 'h10'; m.ball.x = 40; m.ball.y = 34;
  var x9 = P(m, 'h9').x;
  m.startPassFlight(P(m, 'h10'), {
    x1: 60, y1: 34, durMs: 800, height: 'low', receiverId: 'h9',
  });
  var guard = 0;
  while (m.phase === 'passflight' && guard++ < 40) m.tick();
  ok(m.phase === 'play', '飞行结束回到比赛');
  ok(!m.ball.ownerId, '落地时接球人还没到，球不钉死给别人', 'owner=' + m.ball.ownerId);
  ok(Math.hypot(m.ball.vx, m.ball.vy) > 2, '落地后沿传球方向继续滚', 'v=' + Math.hypot(m.ball.vx, m.ball.vy).toFixed(2));
  ok(P(m, 'h9').x > x9 + 3, '飞行中接球人已经朝落点启动', 'x=' + P(m, 'h9').x.toFixed(1));
  var xAfter = P(m, 'h9').x;
  guard = 0;
  while (!m.ball.ownerId && guard++ < 80) m.simulate(0.1);
  ok(m.ball.ownerId === 'h9', '接球人跑上滚动的球', 'owner=' + m.ball.ownerId + ' x=' + P(m, 'h9').x.toFixed(1));
  ok(P(m, 'h9').x > xAfter, '得球前仍在往前追');
})();

console.log('== 自由球：双方最近的人都追 ==');
(function () {
  var m = newMatch(12);
  m.players.forEach(function (p) { set(m, p.id, 10, 10); });
  set(m, 'h6', 42, 34);
  set(m, 'a6', 66, 34);
  freezeExcept(m, ['h6', 'a6']);
  m.ball.ownerId = null; m.ball.x = 52; m.ball.y = 34; m.ball.vx = 0; m.ball.vy = 0; m.ball.z = 0; m.ball.vz = 0;
  m._lastCarrierId = null;
  var h0 = P(m, 'h6').x, a0 = P(m, 'a6').x;
  m.simulate(0.4);
  ok(P(m, 'h6').x > h0 + 0.4, '主队最近的人朝自由球靠', 'dx=' + (P(m, 'h6').x - h0).toFixed(2));
  ok(P(m, 'a6').x < a0 - 0.4, '客队最近的人朝自由球靠', 'dx=' + (a0 - P(m, 'a6').x).toFixed(2));
  var guard = 0;
  while (!m.ball.ownerId && guard++ < 60) m.simulate(0.1);
  ok(m.ball.ownerId === 'h6' || m.ball.ownerId === 'a6', '追到的人把球捡起来', 'owner=' + m.ball.ownerId);
})();

console.log('== 高球：引擎里落地后弹起，高度不够不能用脚停 ==');
(function () {
  var m = newMatch(13);
  m.players.forEach(function (p) { set(m, p.id, 12, 8); p.frozenUntil = m.now + 60000; });
  set(m, 'h10', 40, 34);
  m.ball.ownerId = 'h10';
  m.startPassFlight(P(m, 'h10'), { x1: 62, y1: 34, durMs: 950, height: 'high', receiverId: null });
  var guard = 0;
  while (m.phase === 'passflight' && guard++ < 40) m.tick();
  ok(m.ball.vz > 2, '高球落地带向上速度', 'vz=' + m.ball.vz.toFixed(2));
  var peak = 0;
  for (var i = 0; i < 12; i++) {
    m.simulate(0.1);
    if (m.ball.z > peak) peak = m.ball.z;
  }
  ok(peak > 1.2, '落地后弹起超过 1.2 米', 'peak=' + peak.toFixed(2));
  var m2 = newMatch(14);
  m2.players.forEach(function (p) { p.frozenUntil = m2.now + 60000; });
  set(m2, 'h8', 50, 34);
  P(m2, 'h8').frozenUntil = 0;
  m2.ball.ownerId = null; m2.ball.x = 50; m2.ball.y = 34; m2.ball.z = 3.2; m2.ball.vz = 0.2; m2.ball.vx = 0; m2.ball.vy = 0;
  m2._lastCarrierId = null;
  m2.simulate(0.1);
  ok(m2.ball.ownerId !== 'h8', '球在 3 米高时前场球员停不下来', 'owner=' + m2.ball.ownerId + ' z=' + m2.ball.z.toFixed(2));
  m2.ball.z = 1.9; m2.ball.vz = 0; m2.ball.ownerId = null;
  set(m2, 'h8', 50, 34);
  m2.simulate(0.05);
  ok(m2.ball.ownerId === 'h8', '球落到头球高度且人在下面，可以顶到', 'owner=' + m2.ball.ownerId + ' z=' + m2.ball.z.toFixed(2));
})();

console.log('== 护球：弱防守大多护住但不冻住；强防守大多捅走 ==');
(function () {
  function make(stats, id) {
    return { id: id, stamina: 100, maxStamina: 100, stats: stats };
  }
  var strong = make({ strength: 19, balance: 18, bravery: 16, tackling: 8, aggression: 8 }, 'c');
  var weak = make({ strength: 5, balance: 5, bravery: 6, tackling: 4, aggression: 5 }, 'd');
  var bully = make({ strength: 18, balance: 14, bravery: 16, tackling: 18, aggression: 17 }, 'b');
  var soft = make({ strength: 6, balance: 6, bravery: 6, tackling: 6, aggression: 6 }, 's');
  var holdW = 0, pokeB = 0, freeze = 0, N = 80;
  for (var s = 0; s < N; s++) {
    var rng = mulberry32(3000 + s);
    var a = Shield.resolve(function () { return rng(); }, strong, weak);
    if (a.outcome === 'hold') holdW++;
    if (a.defenderOffBalanceMs > 400) freeze++;
    var rng2 = mulberry32(4000 + s);
    var b = Shield.resolve(function () { return rng2(); }, soft, bully);
    if (b.outcome === 'poke') pokeB++;
  }
  ok(holdW >= 56, '身体差距大时护球大多成立', holdW + '/' + N);
  ok(pokeB >= 32, '面对强防守，捅球是常见结果', pokeB + '/' + N);
  ok(freeze === 0, '即使护住，失去重心也不超过 400ms', 'n=' + freeze);
  ok(Shield.preview(strong, weak).slow <= 0.78, '护球一定让持球人减速', Shield.preview(strong, weak).slow.toFixed(2));
  ok(Shield.challengeDecision(weak, strong).challenge === true, '普通弱防守仍然选择上抢');
  var timid = make({ strength: 4, balance: 4, bravery: 4, tackling: 4, aggression: 4 }, 't');
  var wall = make({ strength: 20, balance: 20, bravery: 18, tackling: 6, aggression: 6 }, 'w');
  ok(Shield.challengeDecision(timid, wall).challenge === false, '只有身体差一截且侵略性极低才选择保持距离');
  var rngA = mulberry32(42), rngB = mulberry32(42);
  var ra = Shield.resolve(function () { return rngA(); }, strong, weak);
  var rb = Shield.resolve(function () { return rngB(); }, strong, weak);
  ok(JSON.stringify(ra) === JSON.stringify(rb), '同一种子护球结果一致');
})();

console.log('== 护球：引擎里对方不被定身，强人仍会挑战 ==');
(function () {
  var holds = 0, longFreeze = 0, moved = 0, N = 24;
  for (var s = 0; s < N; s++) {
    var m = newMatch(5000 + s);
    var c = P(m, 'h10'), d = P(m, 'a4');
    set(m, 'h10', 60, 34); set(m, 'a4', 61.2, 34);
    m.players.forEach(function (p) { if (p.id !== 'h10' && p.id !== 'a4') set(m, p.id, 15, 8); });
    ['strength', 'balance', 'bravery'].forEach(function (k) { setStat(c, k, 19); });
    ['strength', 'balance', 'tackling', 'aggression', 'bravery'].forEach(function (k) { setStat(d, k, 5); });
    m.ball.ownerId = 'h10'; m.ball.x = 60; m.ball.y = 34;
    m._lastCarrierId = 'h10';
    m.resolveAction(c, 'protect', 90);
    if (d.beatenUntil - m.now > 400) longFreeze++;
    if (m.ball.ownerId === 'h10' && m.phase === 'play') {
      holds++;
      var x0 = d.x, y0 = d.y;
      // tick 才会推进 now，280ms 的失去重心才会结束，防守人接着上抢
      for (var k = 0; k < 6; k++) m.tick();
      if (Math.abs(d.x - x0) > 0.4 || Math.abs(d.y - y0) > 0.4) moved++;
    }
  }
  ok(longFreeze === 0, '24 次护球没有一次把对手冻超过 400ms', 'n=' + longFreeze);
  ok(holds >= 14, '对弱防守，持球方经常还保得住球', holds + '/' + N);
  ok(moved === holds, '护住之后防守人 0.5 秒内仍在移动', moved + '/' + holds);
  var ch = 0;
  for (var i = 0; i < 20; i++) {
    var m2 = newMatch(6000 + i);
    var d2 = P(m2, 'a8');
    ['strength', 'tackling', 'aggression', 'bravery', 'balance'].forEach(function (k) { setStat(d2, k, 16); });
    setStat(P(m2, 'h10'), 'strength', 8);
    setStat(P(m2, 'h10'), 'balance', 8);
    setStat(P(m2, 'h10'), 'bravery', 8);
    if (Shield.challengeDecision(d2, P(m2, 'h10')).challenge) ch++;
  }
  ok(ch === 20, '强防守面对普通持球人 20 次全部选择挑战');
})();

console.log('== 回防切换：球门侧、滞回、不切身后远处、手动锁 ==');
(function () {
  var m = newMatch(21);
  m.players.forEach(function (p) { set(m, p.id, 8, 8); });
  m.ball.x = 60; m.ball.y = 34; m.ball.vx = -4; m.ball.vy = 0; m.ball.ownerId = 'a9';
  set(m, 'a9', 60, 34);
  set(m, 'h11', 73, 34); // 比球更靠近对方球门 13 米，虽然不是最近也算远在身前
  set(m, 'h9', 62.2, 34); // 离球最近，但在球的进攻侧
  set(m, 'h4', 48, 36); // 球门侧，能卡住来球路线
  var id = Switch.pick(m, 'home', null, 0);
  ok(id === 'h4', '切到球门侧能拦截的人，而不是身前更近的人', id);
  var again = Switch.pick(m, 'home', 'h4', 0.4);
  set(m, 'h3', 47.2, 34); // 只好一点点
  var stay = Switch.pick(m, 'home', 'h4', 0.4);
  ok(stay === 'h4', '差距不够时保持当前人，不来回闪', stay);
  set(m, 'h3', 55, 34); // 明显更好：就在球门侧贴着球
  var flip = Switch.pick(m, 'home', 'h4', 0.4);
  ok(flip === 'h3', '明显更有利时才切过去', flip);
  void again;
  m.control.playerId = 'h8';
  m.control.manualUntil = 0;
  m._lastCarrierId = null;
  m.autoSwitchToDefender();
  ok(m.control.playerId === 'h4' || m.control.playerId === 'h3', '球权易手走同一套选择', m.control.playerId);
  m.control.playerId = 'h8';
  m.control.manualUntil = m.now + 3000;
  m._lastCarrierId = 'h8';
  m.ball.ownerId = 'a10';
  m.autoSwitchToDefender();
  ok(m.control.playerId === 'h8', '手动切换锁定期间自动切换不抢', m.control.playerId);
})();

console.log('== 门将：角平分线、深度、出击、传中、回线 ==');
(function () {
  ok(GK.idealDepth(48, 0.8) < GK.idealDepth(14, 0.8) - 0.8, '球远贴门线，球近站出来');
  ok(GK.idealDepth(18, 1) > GK.idealDepth(18, 0.2) + 0.4, '站位好的门将深度更合理');
  var m = newMatch(31);
  m.players.forEach(function (p) { if (p.team !== 'away' || p.pos === 'GK') set(m, p.id, 20, 34); });
  set(m, 'a1', 100, 34);
  m.ball.x = 88; m.ball.y = 22; m.ball.z = 0; m.ball.ownerId = 'h10';
  set(m, 'h10', 88, 22);
  var pos = GK.position(m, P(m, 'a1'));
  ok(pos.mode === 'angle' || pos.mode === 'line', '中路偏一侧是角平分线站位', pos.mode);
  var dir = GK.bisector(88, 22, 105);
  var vx = pos.x - 88, vy = pos.y - 22;
  var distLine = Math.abs(vx * dir.y - vy * dir.x) / (Math.hypot(dir.x, dir.y) || 1);
  ok(distLine < 1.2, '站在球到球门夹角的平分线上', 'dist=' + distLine.toFixed(2) + ' y=' + pos.y.toFixed(1));
  ok(pos.y < 34 && pos.y > 22, '横向偏向球，但不跑到球的身边', 'y=' + pos.y.toFixed(1));
  ok(pos.x > 100 && pos.x < 104.5, '深度在门线前面一点点', 'x=' + pos.x.toFixed(2));
  m.ball.x = 30; m.ball.y = 34; m.ball.ownerId = 'h9'; set(m, 'h9', 30, 34);
  var back = GK.position(m, P(m, 'a1'));
  ok(back.mode === 'line' && back.x > 102, '球在对方半场时回到门线', back.mode + ' x=' + back.x.toFixed(2));
  m.ball.ownerId = null; m.ball.x = 90; m.ball.y = 34; m.ball.vx = 3; m.ball.vy = 0; m.ball.z = 0;
  m.players.forEach(function (p) { if (p.team === 'home') set(m, p.id, 25, 34); });
  set(m, 'a1', 101, 34);
  var sweep = GK.position(m, P(m, 'a1'));
  ok(sweep.mode === 'sweep' && sweep.x < 98, '直塞自由球、门将能先到就出击', sweep.mode + ' x=' + sweep.x.toFixed(1));
  set(m, 'h9', 90.4, 34);
  var stay = GK.position(m, P(m, 'a1'));
  ok(stay.mode !== 'sweep' && stay.x > 99, '对方能先到球时门将留在门前', stay.mode + ' x=' + stay.x.toFixed(1));
  m.ball.ownerId = 'h7'; m.ball.x = 96; m.ball.y = 8; m.ball.z = 2.4; m.ball.vx = 0; m.ball.vy = 0;
  set(m, 'h7', 96, 8);
  var cross = GK.position(m, P(m, 'a1'));
  ok(cross.mode === 'cross', '宽位高球按传中站位', cross.mode);
  ok(cross.y > 18 && cross.y < 36, '传中时离开边线、收向球门中路', 'y=' + cross.y.toFixed(1));
  var wired = Behavior.keeperTarget(m, P(m, 'a1'));
  ok(wired.mode === 'cross' && Math.abs(wired.x - cross.x) < 0.01, '行为层门将入口转发到 gk.js');

  // 引擎：门将是最近的人时也不弃门去上抢
  var live = newMatch(32);
  live.players.forEach(function (p) { p.frozenUntil = live.now + 60000; });
  set(live, 'h10', 86, 22);
  P(live, 'h10').frozenUntil = live.now + 60000;
  set(live, 'a1', 100, 34);
  P(live, 'a1').frozenUntil = 0;
  live.ball.ownerId = 'h10';
  live.ball.x = 87.2; live.ball.y = 23; live.ball.z = 0; live.ball.vx = 0; live.ball.vy = 0; live.ball.vz = 0;
  live.paused = false;
  for (var gi = 0; gi < 60; gi++) live.tick();
  var gkLive = P(live, 'a1');
  ok(gkLive.x > 99.5, '模拟中门将留在门前，不冲向持球人', gkLive.x.toFixed(2) + ',' + gkLive.y.toFixed(2));
  ok(gkLive.y < 33.2 && gkLive.y > 30, '模拟中门将横向收到球的一侧', 'y=' + gkLive.y.toFixed(2));
})();

console.log(failures === 0 ? 'ALL PLAY-PHYSICS TESTS PASSED' : failures + ' PLAY-PHYSICS FAILURES');
process.exit(failures === 0 ? 0 : 1);
