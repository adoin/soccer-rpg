// 门将不能被阵型、传球或摇杆带走。除了禁区附近能先拿到的自由球，人必须留在本方球门前。
'use strict';

var E = require('../server/game/engine');

function along(p) {
  var goalX = p.team === 'home' ? 0 : 105;
  var inward = p.team === 'home' ? 1 : -1;
  return (p.x - goalX) * inward;
}
function clearDecision(m) {
  if (!m.decision) return;
  var d = m.decision;
  if (d.kind === 'gk-distribute') {
    m.keeperDistribute(m.byId[d.playerId], 'gk-punt');
    return;
  }
  if (d.kind === 'taker' && d.options && d.options[0]) {
    m.chooseSetPieceTaker(d.options[0].id);
    return;
  }
  if (d.kind === 'qte') {
    try { m.strikePenalty(m.byId[d.playerId], { timing: 0.5 }); } catch (e) { m.decision = null; if (m.phase === 'decision') m.phase = 'play'; }
    return;
  }
  var opt = null;
  (d.options || []).forEach(function (o) {
    if (opt || !o.enabled) return;
    if (o.shots || o.moves || o.skills) return;
    opt = o;
  });
  if (!opt) {
    m.decision = null;
    if (m.phase === 'decision') m.phase = 'play';
    return;
  }
  try { m.applyCommand(d.playerId, opt.id, { model: true }); }
  catch (e) {
    m.decision = null;
    if (m.phase === 'decision') m.phase = 'play';
  }
}

var violations = [];
function watch(m, tag) {
  ['h1', 'a1'].forEach(function (id) {
    var gk = m.byId[id];
    var a = along(gk);
    var sweeping = gk._gkMode === 'sweep' || gk._gkMode === 'onevone';
    var loose = !m.ball.ownerId;
    var max = (sweeping && loose) ? 18.4 : 16.7;
    if (a > max) violations.push(tag + ' ' + id + ' along ' + a.toFixed(1) + ' mode ' + gk._gkMode + ' ball ' + m.ball.x.toFixed(1));
  });
}

var m = new E.Match('gkmin', { seed: 11, halfLength: 180 });
m.destroy();
m.phase = 'play';
m.now = 5000;
m.clock = 0;
var steps = 0;
while (m.clock < 180 && steps < 8000 && m.phase !== 'fulltime') {
  if (m.decision) clearDecision(m);
  m.tick();
  steps++;
  if (m.phase === 'play' || m.phase === 'passflight' || m.phase === 'shotflight') watch(m, 'min');
}
console.log('minutes', m.clock.toFixed(1), 'steps', steps, 'violations', violations.length);
if (violations.length) console.log(violations.slice(0, 8).join('\n'));

// 对方门将把球开过半场：本方门将就算被摆到中圈，也要在球到自己半场之前回到门前。
var m2 = new E.Match('gkpunt', { seed: 4, halfLength: 180 });
m2.destroy();
m2.phase = 'play';
m2.now = 8000;
m2.decision = null;
m2.nextDecisionAt = 1e15;
var home = m2.byId.h1;
var away = m2.byId.a1;
home.x = 52; home.y = 34; home._vx = 5; home._vy = 0;
away.x = 100; away.y = 34;
m2.ball.ownerId = 'a1';
m2.ball.x = 100; m2.ball.y = 34; m2.ball.z = 0; m2.ball.vx = 0; m2.ball.vy = 0; m2.ball.vz = 0;
away.gkHolding = true;
away.gkReleaseAt = m2.now;
m2.keeperDistribute(away, 'gk-punt');
var sawHomeHalf = false;
var homeWhenBallArrived = null;
for (var k = 0; k < 80; k++) {
  m2.tick();
  watch(m2, 'punt');
  if (!sawHomeHalf && m2.ball.x < 52 && !m2.ball.ownerId) {
    sawHomeHalf = true;
    homeWhenBallArrived = along(home);
  }
}
console.log('punt home', along(home).toFixed(2), 'away', along(away).toFixed(2),
  'ball', m2.ball.x.toFixed(1), 'arrived', homeWhenBallArrived == null ? '-' : homeWhenBallArrived.toFixed(2),
  'control', m2.control.playerId);

// 摇杆推着门将也不许出禁区。切换不会自动选上门将。
m2.control.playerId = 'h1';
m2.control.dx = 1; m2.control.dy = 0; m2.control.activeStamp = m2.now;
m2.ball.ownerId = 'a9';
m2.byId.a9.x = 70; m2.byId.a9.y = 34;
m2.ball.x = 70; m2.ball.y = 34; m2.ball.vx = 0; m2.ball.vy = 0; m2.ball.z = 0;
for (var s = 0; s < 20; s++) m2.tick();
console.log('stick home', along(home).toFixed(2), 'control', m2.control.playerId);
if (m2.control.playerId === 'h1') {
  console.log('FAIL 摇杆还停在门将身上');
  process.exit(1);
}
if (along(home) > 16.7) {
  console.log('FAIL 摇杆把门将带出禁区');
  process.exit(1);
}

// 扑住之后大脚：射门队的门将要在球飞回来时站在自己门前。
var m3 = new E.Match('gksave', { seed: 9, halfLength: 180 });
m3.destroy();
m3.forceSettle = true;
m3.phase = 'play';
m3.now = 12000;
m3.decision = null;
m3.nextDecisionAt = 1e15;
m3.byId.h1.x = 40; m3.byId.h1.y = 30;
m3.byId.h9.x = 92; m3.byId.h9.y = 34;
m3.ball.ownerId = 'h9';
m3.ball.x = 92; m3.ball.y = 34;
m3.startShotFlight(m3.byId.h9, m3.byId.a1, { outcome: 'catch', label: '抽射', isSpecial: false });
var guard = 0;
while (m3.phase === 'shotflight' && guard++ < 40) m3.tick();
var afterSave = along(m3.byId.h1);
guard = 0;
while (m3.ball.ownerId === 'a1' && guard++ < 40) m3.tick();
var atRelease = along(m3.byId.h1);
guard = 0;
while (m3.ball.x > 40 && guard++ < 50 && m3.phase !== 'whistle') m3.tick();
var atCross = along(m3.byId.h1);
console.log('save along', afterSave.toFixed(2), 'release', atRelease.toFixed(2), 'cross', atCross.toFixed(2),
  'ball', m3.ball.x.toFixed(1), 'phase', m3.phase);
watch(m3, 'save');

if (violations.length) {
  console.log('FAIL 门将离开球门', violations.length);
  process.exit(1);
}
if (along(home) > 12 || (homeWhenBallArrived != null && homeWhenBallArrived > 16.7)) {
  console.log('FAIL 大脚时本方门将不在门前');
  process.exit(1);
}
if (atRelease > 12 || atCross > 16.7) {
  console.log('FAIL 扑救后本方门将没回到球门');
  process.exit(1);
}
console.log('PASS 门将站位');
m.destroy(); m2.destroy(); m3.destroy();
