// server/game/rules/receive.js
// ============================================================
// 领球 / 直塞 / 落点争抢 / 自由球追球。
//
// 传球落地不再把球钉死在落点：
//   · 意向接球人按自己的冲刺速度承诺跑向「球会滚到的会合点」；
//   · 落地后球沿传球方向继续滚，摩擦见 ballPhysics；
//   · 高球第一次触地后还带着向上的 vz，会连跳几下；
//   · 谁先到、谁的预判/第一脚更好，谁处理球。高度不在
//     脚/胸/头范围内的人碰不到；
//   · 自由球时双方各派最近的几个人追，意向接球人即使不在
//     最近名单里也继续跑，不会中途折返阵型。
// 落点 1.6m 内已经站好的人仍按原规则立刻处理（含贴身能力对决），
// 这样人已经在落点上时不会被滚走。
// ============================================================
'use strict';

var FM = require('../../../shared/fm');
var Ball = require('./ballPhysics');

var FIELD_W = 105, FIELD_H = 68;
var LAND_RADIUS = 1.6;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function sprintSpeed(p) {
  var spd = (7.2 + FM.speed(p) * 0.094) * 0.72 * 1.10;
  var st = p.stamina == null ? 100 : p.stamina;
  var mx = p.maxStamina || 100;
  spd *= 0.7 + 0.3 * Math.max(0, Math.min(1, st / mx));
  return Math.max(3.2, spd);
}

function touchScore(p, isReceiver) {
  return FM.v(p, 'anticipation') + FM.v(p, 'firstTouch') + (isReceiver ? 3 : 0)
    + FM.v(p, 'offBall') * 0.15;
}

function accelOf(p) {
  return 25 * (0.55 + FM.v(p, 'acceleration') / 100);
}

// 考虑到当前速度和加速度，跑到 (tx,ty) 要几秒。背对目标要先掉速。
function timeToReach(p, tx, ty, speed) {
  speed = speed || sprintSpeed(p);
  var dx = tx - p.x, dy = ty - p.y;
  var d = Math.hypot(dx, dy);
  if (d < 0.28) return 0;
  var acc = accelOf(p);
  var closing = ((p._vx || 0) * dx + (p._vy || 0) * dy) / d;
  var v0 = closing > 0 ? Math.min(speed, closing) : 0;
  var turn = closing < -0.4 ? 0.18 : (closing < 0.4 ? 0.08 : 0);
  var tAcc = Math.max(0, (speed - v0) / acc);
  var dAcc = v0 * tAcc + 0.5 * acc * tAcc * tAcc;
  var t;
  if (d <= dAcc) {
    var disc = v0 * v0 + 2 * acc * d;
    t = (-v0 + Math.sqrt(Math.max(0, disc))) / acc;
  } else {
    t = tAcc + (d - dAcc) / speed;
  }
  return t + turn;
}

function controlRadius(p) {
  var skill = (FM.v(p, 'firstTouch') + FM.v(p, 'technique')) / 2;
  if (!(skill >= 0)) skill = 50;
  return 0.75 + (skill / 100) * 0.5;
}

function pickIntercept(p, samples) {
  var margin = 0.1;
  var i;
  for (i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (s.z > 0.65) continue;
    if (timeToReach(p, s.x, s.y) + margin <= s.t + 0.02) return s;
  }
  var best = samples[samples.length - 1];
  var late = 1e9;
  for (i = 0; i < samples.length; i++) {
    var q = samples[i];
    if (q.z > 0.65) continue;
    var l = timeToReach(p, q.x, q.y) - q.t;
    if (l < late) { late = l; best = q; }
  }
  return best || { x: p.x, y: p.y, z: 0, t: 0 };
}

function interceptForFlight(pf, player, now) {
  var dur = (pf.durMs || 600) / 1000;
  var elapsed = Math.max(0, ((now == null ? pf.startAt : now) - pf.startAt) / 1000);
  var remain = Math.max(0.04, dur - elapsed);
  var samples = [];
  var n = Math.max(2, Math.ceil(remain / 0.08));
  var i;
  for (i = 0; i <= n; i++) {
    var t = remain * i / n;
    var k = dur > 0 ? (elapsed + t) / dur : 1;
    if (k < 0) k = 0;
    if (k > 1) k = 1;
    var x = pf.x0 + (pf.x1 - pf.x0) * k;
    var y = pf.y0 + (pf.y1 - pf.y0) * k;
    var z = (k <= 0.001 || k >= 0.999) ? 0 : 4 * (pf.peak || 0) * k * (1 - k);
    if (z < 0.65) samples.push({ x: x, y: y, z: z, t: t });
  }
  samples.push({ x: pf.x1, y: pf.y1, z: 0, t: remain });
  var roll = residualRoll(pf);
  var mu = Ball.SURFACES.grass.rollMu;
  for (var j = 1; j <= 18; j++) {
    var rt = j * 0.12;
    var pos = Ball.rollPosition(pf.x1, pf.y1, roll.vx, roll.vy, rt, mu);
    samples.push({ x: pos.x, y: pos.y, z: 0, t: remain + rt });
    if (Math.hypot(pos.vx, pos.vy) < 0.3) break;
  }
  var hit = pickIntercept(player, samples);
  return {
    x: clamp(hit.x, 1.5, FIELD_W - 1.5),
    y: clamp(hit.y, 1.5, FIELD_H - 1.5),
    t: hit.t,
  };
}

function interceptForBall(ball, p) {
  var samples = [];
  var z = ball.z || 0;
  var vz = ball.vz || 0;
  var vx = ball.vx || 0;
  var vy = ball.vy || 0;
  if (z > 0.35 || Math.abs(vz) > 1.1) {
    var land = loftedLand(ball);
    if (land) {
      samples.push({ x: land.x, y: land.y, z: 0, t: land.t });
      var grip = Ball.SURFACES.grass.bounceGrip;
      for (var j = 1; j <= 16; j++) {
        var rt = j * 0.12;
        var pos = Ball.rollPosition(land.x, land.y, vx * grip, vy * grip, rt, Ball.SURFACES.grass.rollMu);
        samples.push({ x: pos.x, y: pos.y, z: 0, t: land.t + rt });
        if (Math.hypot(pos.vx, pos.vy) < 0.3) break;
      }
    }
  }
  if (!samples.length) {
    if (Math.hypot(vx, vy) < 0.3) samples.push({ x: ball.x, y: ball.y, z: 0, t: 0.05 });
    else {
      for (var i = 0; i <= 28; i++) {
        var t = i * 0.1;
        var pos2 = Ball.rollPosition(ball.x, ball.y, vx, vy, t, Ball.SURFACES.grass.rollMu);
        samples.push({ x: pos2.x, y: pos2.y, z: 0, t: Math.max(0.05, t) });
        if (Math.hypot(pos2.vx, pos2.vy) < 0.3) break;
      }
    }
  }
  var hit = pickIntercept(p, samples);
  return {
    x: clamp(hit.x, 1.5, FIELD_W - 1.5),
    y: clamp(hit.y, 1.5, FIELD_H - 1.5),
    t: hit.t,
  };
}

// 飞行中接球人要跑的点：落在他来得及先于皮球到达的路线上，不再顺着惯性冲过落点。
function flightRunTarget(pf, player) {
  if (!player) {
    return {
      x: clamp(pf.x1, 2, FIELD_W - 2),
      y: clamp(pf.y1, 2, FIELD_H - 2),
    };
  }
  return interceptForFlight(pf, player, pf.startAt || 0);
}

// 到达 (tx,ty) 需要的秒数。已经朝目标跑时用当前速度分量抬一点，避免起跑罚太重。
function timeTo(p, tx, ty, speed) {
  speed = speed || sprintSpeed(p);
  var dx = tx - p.x, dy = ty - p.y;
  var d = Math.hypot(dx, dy);
  if (d < 0.2) return 0;
  var closing = ((p._vx || 0) * dx + (p._vy || 0) * dy) / d;
  var eff = speed;
  if (closing > 0.8) eff = Math.min(speed, (closing + speed) * 0.5);
  else eff = speed * 0.82; // 还没转向，略慢
  return d / Math.max(2.4, eff);
}

// 球落地后的残余滚动 + 高球第一次回弹。
function residualRoll(pf) {
  var dx = pf.x1 - pf.x0, dy = pf.y1 - pf.y0;
  var len = Math.hypot(dx, dy) || 1;
  var h = pf.height || 'mid';
  var retain = { low: 0.40, mid: 0.28, high: 0.10, vhigh: 0.05 }[h] || 0.28;
  // 高球的水平速度要小：弹跳本身会把球往前带，太大就滚出底线，没人抢到。
  var cap = { low: 8.2, mid: 6.2, high: 2.0, vhigh: 1.2 }[h] || 6;
  var floor = { low: 3.4, mid: 2.2, high: 0.5, vhigh: 0.15 }[h] || 2;
  var spd = (pf.ballSpeed || 12) * retain;
  spd = Math.max(floor, Math.min(cap, spd));
  var peak = pf.peak || 0;
  var vz = 0;
  if (h === 'high' || h === 'vhigh') {
    var apex = Math.min(4.2, peak * (h === 'vhigh' ? 0.32 : 0.40));
    vz = Math.sqrt(2 * Ball.G * Math.max(0.4, apex));
  }
  return { vx: dx / len * spd, vy: dy / len * spd, vz: vz, z: 0 };
}

// 接球人追上滚动球的会合点。追不上就跑向球最终停下的地方。
function meetPoint(ball, p, speed) {
  speed = speed || sprintSpeed(p);
  var vx = ball.vx || 0, vy = ball.vy || 0;
  var mu = Ball.SURFACES.grass.rollMu;
  if (Math.hypot(vx, vy) < 0.35 && (ball.z || 0) < 0.5) {
    return { x: ball.x, y: ball.y, t: timeTo(p, ball.x, ball.y, speed) };
  }
  var last = { x: ball.x, y: ball.y, t: 0 };
  for (var i = 1; i <= 40; i++) {
    var t = i * 0.1;
    var pos = Ball.rollPosition(ball.x, ball.y, vx, vy, t, mu);
    last = { x: pos.x, y: pos.y, t: t };
    if (timeTo(p, pos.x, pos.y, speed) <= t + 0.08) return last;
  }
  return last;
}

// 落点瞬间：1.6m 内的人立刻争球。贴身（0.4m 内）不同队看能力，意向接球人 +3。
// 无人在范围内 → immediate false，引擎改成滚动自由球。
function settleLanding(players, x, y, receiverId, holderId) {
  var cands = [];
  for (var i = 0; i < players.length; i++) {
    var q = players[i];
    if (q.sentOff) continue;
    if (holderId && q.id === holderId) continue;
    var d = Math.hypot(q.x - x, q.y - y);
    if (d <= LAND_RADIUS) cands.push({ p: q, d: d });
  }
  cands.sort(function (a, b) { return a.d - b.d; });
  if (!cands.length) return { immediate: false, winner: null };
  if (cands.length === 1) return { immediate: true, winner: cands[0].p };
  var a0 = cands[0], a1 = cands[1];
  if (a0.p.team !== a1.p.team && (a1.d - a0.d) < 0.4) {
    var s0 = touchScore(a0.p, a0.p.id === receiverId);
    var s1 = touchScore(a1.p, a1.p.id === receiverId);
    return { immediate: true, winner: s0 >= s1 ? a0.p : a1.p, contested: true };
  }
  return { immediate: true, winner: a0.p };
}

// 双方各最近 perTeam 人。GK 不参与地面追球（门将走 gk.js）。
function looseChasers(players, ball, perTeam) {
  var by = { home: [], away: [] };
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    if (p.sentOff || p.pos === 'GK') continue;
    var d = Math.hypot(p.x - ball.x, p.y - ball.y);
    (by[p.team] || (by[p.team] = [])).push({ id: p.id, d: d });
  }
  var ids = [];
  ['home', 'away'].forEach(function (t) {
    var list = by[t] || [];
    list.sort(function (a, b) { return a.d - b.d; });
    for (var k = 0; k < list.length && k < perTeam; k++) ids.push(list[k].id);
  });
  return ids;
}

// 高球落点。球还在上升或离地时，用来判断谁才站在落点附近。
function loftedLand(ball) {
  var z = ball.z || 0;
  var vz = ball.vz || 0;
  if (z < 0.35 && Math.abs(vz) < 1.2) return null;
  var g = 9.81;
  var disc = vz * vz + 2 * g * z;
  var t = (vz + Math.sqrt(Math.max(0, disc))) / g;
  if (!(t > 0)) return null;
  return {
    x: (ball.x || 0) + (ball.vx || 0) * t,
    y: (ball.y || 0) + (ball.vy || 0) * t,
    t: t,
  };
}

// 自由球拾取。高度不对的人进不了名单；高球只有贴着落点、或球还很低时贴着球的人能争。
function claim(match) {
  var ball = match.ball;
  var recv = ball.receive && match.now < ball.receive.until ? ball.receive.id : null;
  var land = loftedLand(ball);
  var cands = [];
  for (var i = 0; i < match.players.length; i++) {
    var p = match.players[i];
    if (p.sentOff) continue;
    if (match.now < (p.frozenUntil || 0)) continue;
    if (match.now < (p.holdingUntil || 0)) continue;
    var dead = ball.deadTo;
    if (dead && match.now < dead.until && p.id === dead.id) continue;
    var inBox = p.pos === 'GK' && match.inPenaltyArea && match.inPenaltyArea(p.x, p.y, p.team);
    var band = Ball.controlBand(ball.z || 0, p.pos === 'GK', inBox);
    if (!band) continue;
    if (p.pos === 'GK') {
      var gX = p.team === 'home' ? 0 : FIELD_W;
      var along = Math.abs(ball.x - gX);
      if (along > 20) continue;
    }
    var reach = controlRadius(p);
    if (band === 'chest') reach = Math.max(reach, 1.0);
    if (band === 'header') reach = Math.max(reach, 1.1);
    if (p.id === recv) reach += 0.12;
    var d = Math.hypot(p.x - ball.x, p.y - ball.y);
    var rel = Math.hypot((ball.vx || 0) - (p._vx || 0), (ball.vy || 0) - (p._vy || 0));
    var skill = (FM.v(p, 'firstTouch') + FM.v(p, 'technique')) / 2;
    var maxRel = 3.2 + (skill / 100) * 8.5;
    if (rel > maxRel && d > 0.4) continue;
    if (land && land.t > 0.2) {
      var dLand = Math.hypot(p.x - land.x, p.y - land.y);
      var lowAtBall = (ball.z || 0) < 1.2 && d <= 1.15;
      if (dLand > 2.6 && !lowAtBall) continue;
    }
    if (d <= reach) cands.push({ p: p, d: d, band: band });
  }
  if (!cands.length) return null;
  cands.sort(function (a, b) { return a.d - b.d; });
  if (cands.length === 1) return cands[0].p;
  var a0 = cands[0], a1 = cands[1];
  if (a0.p.team !== a1.p.team && (a1.d - a0.d) < 0.4) {
    var s0 = touchScore(a0.p, a0.p.id === recv);
    var s1 = touchScore(a1.p, a1.p.id === recv);
    return s0 >= s1 ? a0.p : a1.p;
  }
  return a0.p;
}

module.exports = {
  LAND_RADIUS: LAND_RADIUS,
  sprintSpeed: sprintSpeed,
  touchScore: touchScore,
  flightRunTarget: flightRunTarget,
  timeToReach: timeToReach,
  controlRadius: controlRadius,
  interceptForFlight: interceptForFlight,
  interceptForBall: interceptForBall,
  timeTo: timeTo,
  residualRoll: residualRoll,
  meetPoint: meetPoint,
  settleLanding: settleLanding,
  looseChasers: looseChasers,
  claim: claim,
};
