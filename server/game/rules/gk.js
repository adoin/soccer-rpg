// server/game/rules/gk.js
// ============================================================
// 门将选位。沿「球到两门柱夹角的角平分线」站，再按现代习惯修正：
// 近门柱优先、射门前站定、1v1 封角度、传中先站远门柱、高位扫荡、
// 扑救按站位质量、拿到球后选择手抛或大脚。
//
//   angle    常规：角平分线，角度越紧越往近门柱收。
//   cross    传中：先略偏远门柱，再按指挥和禁区人数决定摘/拳击/留门。
//   cutback  低平回敲近门柱：从远门柱收回到近门柱。
//   onevone  单刀：能先封到角度就快速迎上，最后几米站住不提前扑。
//   sweep    自由球直塞：能比对方先到才弃门。
//   line     球在对方半场：回到门线；防线压上时门将也把出发线前提。
// ============================================================
'use strict';

var FM = require('../../../shared/fm');

var FIELD_W = 105, FIELD_H = 68;
var GOAL_Y = FIELD_H / 2;
var POST = 3.66;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function sprintSpeed(p) {
  var spd = (7.2 + FM.speed(p) * 0.094) * 0.72 * 1.10;
  var st = p.stamina == null ? 100 : p.stamina;
  var mx = p.maxStamina || 100;
  spd *= 0.7 + 0.3 * Math.max(0, Math.min(1, st / mx));
  return Math.max(3.2, spd);
}

function goalXOf(team) { return team === 'home' ? 0 : FIELD_W; }
function inwardOf(team) { return team === 'home' ? 1 : -1; }

function bisector(bx, by, goalX) {
  var a0 = Math.atan2((GOAL_Y - POST) - by, goalX - bx);
  var a1 = Math.atan2((GOAL_Y + POST) - by, goalX - bx);
  var ux = Math.cos(a0) + Math.cos(a1);
  var uy = Math.sin(a0) + Math.sin(a1);
  var n = Math.hypot(ux, uy) || 1;
  return { x: ux / n, y: uy / n };
}

function positioning01(gk) {
  return clamp((FM.v(gk, 'positioning') * 0.6 + FM.v(gk, 'command') * 0.4) / 100, 0, 1);
}

function reflex01(gk) {
  return clamp((FM.v(gk, 'reflexes') * 0.55 + FM.v(gk, 'positioning') * 0.45) / 100, 0, 1);
}

function idealDepth(ballDist, pos01) {
  var base = 6.2 * Math.exp(-ballDist / 22) + 0.7;
  base = clamp(base, 0.7, 6.2);
  var k = 0.45 + 0.55 * pos01;
  return 1.2 + (base - 1.2) * k;
}

// 角度越紧（又宽又近）越接近 1。正对球门接近 0。
function angleTightness(bx, by, goalX) {
  var along = Math.max(0.8, Math.abs(goalX - bx));
  var lat = Math.abs(by - GOAL_Y);
  return clamp(lat / (along + 6), 0, 1);
}

function nearPostY(by) {
  return by < GOAL_Y ? GOAL_Y - POST : GOAL_Y + POST;
}
function farPostY(by) {
  return by < GOAL_Y ? GOAL_Y + POST : GOAL_Y - POST;
}

function placeOnBisector(gk, bx, by, depth) {
  var goalX = goalXOf(gk.team);
  var inward = inwardOf(gk.team);
  var dir = bisector(bx, by, goalX);
  var gx = goalX + inward * depth;
  var gy = GOAL_Y;
  if (Math.abs(dir.x) > 1e-4) {
    var t = (gx - bx) / dir.x;
    gy = by + dir.y * t;
  }
  gy = clamp(gy, GOAL_Y - 11, GOAL_Y + 11);
  return {
    x: clamp(gx, 1.2, FIELD_W - 1.2),
    y: gy,
    dir: dir,
  };
}

// 在角平分线的基础上往近门柱收。站位越好、角度越紧，收得越多。
// 近门柱外侧最多再探 0.35 米，不把近角完全让开。
function applyNearPost(spot, bx, by, goalX, pos01) {
  var tight = angleTightness(bx, by, goalX);
  var nearY = nearPostY(by);
  var shift = tight < 0.16 ? 0 : tight * (0.48 + 0.7 * pos01);
  shift = clamp(shift, 0, 1);
  var y = spot.y + (nearY - spot.y) * shift;
  // 角度越紧，越不能站到近门柱外侧把近角让出去
  var cover = tight * (0.35 + 0.65 * pos01);
  var slack = (1 - cover) * 5.2 + 0.05;
  if (nearY < GOAL_Y) y = Math.max(y, nearY - slack);
  else y = Math.min(y, nearY + slack);
  y = clamp(y, GOAL_Y - 11, GOAL_Y + 11);
  return { y: y, tight: tight, shift: shift, nearY: nearY, farY: farPostY(by) };
}

function nearestOpponentTime(match, gk, x, y) {
  var best = 99;
  for (var i = 0; i < match.players.length; i++) {
    var q = match.players[i];
    if (q.team === gk.team || q.sentOff || q.pos === 'GK') continue;
    var t = Math.hypot(q.x - x, q.y - y) / sprintSpeed(q);
    if (t < best) best = t;
  }
  return best;
}

// 本方后卫线离自家球门的距离（最靠近球门的那名后卫）。压上越大，这个数越大。
function defensiveLineAlong(match, team) {
  var goalX = goalXOf(team);
  var inward = inwardOf(team);
  var minAlong = 99;
  var n = 0;
  for (var i = 0; i < match.players.length; i++) {
    var p = match.players[i];
    if (p.team !== team || p.sentOff || p.pos !== 'DF') continue;
    var along = (p.x - goalX) * inward;
    if (along < minAlong) minAlong = along;
    n++;
  }
  return n ? minAlong : 20;
}

// 防线压上时，出发线跟着前提。出击属性越高，提得越多，最多约 8 米。
function sweeperBonus(match, gk) {
  var line = defensiveLineAlong(match, gk.team);
  var rush = clamp(FM.v(gk, 'rushing') / 100, 0, 1);
  var extra = Math.max(0, line - 28) * (0.10 + 0.28 * rush);
  return clamp(extra, 0, 8);
}

function boxTraffic(match, gk) {
  var goalX = goalXOf(gk.team);
  var inward = inwardOf(gk.team);
  var n = 0;
  for (var i = 0; i < match.players.length; i++) {
    var q = match.players[i];
    if (q.team === gk.team || q.sentOff || q.pos === 'GK') continue;
    var along = (q.x - goalX) * inward;
    if (along > 1.5 && along < 14 && Math.abs(q.y - GOAL_Y) < 12) n++;
  }
  return n;
}

function hasHelp(match, gk, ball) {
  for (var i = 0; i < match.players.length; i++) {
    var q = match.players[i];
    if (q.team !== gk.team || q.sentOff || q.pos === 'GK' || q.id === gk.id) continue;
    if (Math.hypot(q.x - ball.x, q.y - ball.y) < 7.5) return true;
  }
  return false;
}

// 球已经换到另一侧（大范围转移或飞行落点在远侧）：加快回到新的角平分线。
function ballSwitched(match, gk, ball) {
  var gap = (ball.y || GOAL_Y) - gk.y;
  if (Math.abs(gap) < 14) {
    var flight = match.passFlight;
    if (flight && Math.abs((flight.y1 || 0) - gk.y) > 16 && Math.abs((flight.y1 || 0) - (flight.y0 || 0)) > 12) {
      return true;
    }
    return false;
  }
  var vy = ball.vy || 0;
  if (Math.abs(vy) > 5 && vy * gap > 0) return true;
  var flight2 = match.passFlight;
  if (flight2 && Math.abs((flight2.y1 || 0) - gk.y) > 16) return true;
  if (Math.abs(ball.y - GOAL_Y) > 16 && Math.abs(gk.y - GOAL_Y) < 8) return true;
  return false;
}

function shotThreat(match, gk, ball) {
  if (!ball || !ball.ownerId) return null;
  var att = match.byId ? match.byId[ball.ownerId] : null;
  if (!att || att.team === gk.team || att.pos === 'GK') return null;
  var goalX = goalXOf(gk.team);
  var inward = inwardOf(gk.team);
  var along = (ball.x - goalX) * inward;
  return { att: att, along: along, goalX: goalX, inward: inward };
}

// 射门前站定。反应和站位好的人在射程内就停住微蹲；差的还在挪。
function applySetFeet(match, gk, spot) {
  var threat = shotThreat(match, gk, match.ball || {});
  spot.set = false;
  spot.crouch = false;
  if (!threat) return spot;
  if (spot.mode === 'sweep' || spot.mode === 'onevone') return spot;
  var quality = reflex01(gk);
  var range = 11 + quality * 14;
  if (threat.along < 4 || threat.along > range) return spot;
  var dist = Math.hypot(gk.x - spot.x, gk.y - spot.y);
  var plant = 0.2 + quality * 1.6;
  if (dist > plant) return spot;
  if (quality < 0.4) {
    spot.speedMul = Math.max(spot.speedMul == null ? 0.55 : spot.speedMul, 0.4);
    return spot;
  }
  spot.set = true;
  spot.crouch = true;
  spot.speedMul = 0.02;
  spot.sprint = false;
  return spot;
}

// 单刀：封角度，不扑到人身上。能先站到封堵点才迎上去，否则留在线上。
function oneOnOneTarget(match, gk) {
  var ball = match.ball;
  if (!ball || !ball.ownerId) return null;
  var att = match.byId[ball.ownerId];
  if (!att || att.team === gk.team) return null;
  var goalX = goalXOf(gk.team);
  var inward = inwardOf(gk.team);
  var along = (ball.x - goalX) * inward;
  if (along < 6 || along > 22) return null;
  if (Math.abs(ball.y - GOAL_Y) > 16) return null;
  if (hasHelp(match, gk, ball)) return null;
  var one = clamp(FM.v(gk, 'oneOnOne') / 100, 0, 1);
  var rush = clamp(FM.v(gk, 'rushing') / 100, 0, 1);
  var standOff = 4.0 + (1 - one) * 1.4;
  var bx = ball.x, by = ball.y;
  var gx = goalX + inward * 1.2;
  var gy = GOAL_Y;
  var dx = gx - bx, dy = gy - by;
  var len = Math.hypot(dx, dy) || 1;
  var blockX = clamp(bx + dx / len * standOff, 2, FIELD_W - 2);
  var blockY = clamp(by + dy / len * standOff, 8, FIELD_H - 8);
  var gap = Math.hypot(gk.x - att.x, gk.y - att.y);
  var tGk = Math.hypot(gk.x - blockX, gk.y - blockY) / sprintSpeed(gk);
  // 对手跑到门将身边才形成射门，不是跑到封堵点（封堵点本来就在他身前）
  var tAtt = Math.max(0.2, gap / sprintSpeed(att));
  var need = 0.2 - rush * 0.16 - one * 0.06;
  var holding = gap < 6.4;
  if (!holding && tGk + need >= tAtt) return null;
  return {
    x: blockX,
    y: blockY,
    mode: 'onevone',
    sprint: !holding,
    speedMul: holding ? 0.1 : 0.96,
    hold: holding,
    spread: true,
    set: false,
    crouch: holding,
    depth: Math.abs(blockX - goalX),
  };
}

function sweepTarget(match, gk) {
  var ball = match.ball;
  if (!ball || ball.ownerId) return null;
  var goalX = goalXOf(gk.team);
  var inward = inwardOf(gk.team);
  var along = (ball.x - goalX) * inward;
  if (along < 4 || along > 34) return null;
  if (Math.abs(ball.y - GOAL_Y) > 22) return null;
  var rush = clamp(FM.v(gk, 'rushing') / 100, 0, 1);
  var dist = Math.hypot(gk.x - ball.x, gk.y - ball.y);
  var maxDist = 8 + rush * 16;
  if (dist > maxDist) return null;
  var vx = ball.vx || 0;
  var leaving = vx * inward > 2.5 && along > 16;
  if (leaving) return null;
  var tGk = dist / sprintSpeed(gk);
  var tOpp = nearestOpponentTime(match, gk, ball.x, ball.y);
  var command = clamp(FM.v(gk, 'command') / 100, 0, 1);
  var need = 0.28 - rush * 0.22 + command * 0.08;
  if (tGk + Math.max(0.04, need) >= tOpp) return null;
  return {
    x: clamp(ball.x, 2, FIELD_W - 2),
    y: clamp(ball.y, 6, FIELD_H - 6),
    mode: 'sweep',
    sprint: true,
    speedMul: 0.98,
    set: false,
    crouch: false,
    spread: false,
  };
}

function crossPlan(match, gk, ball, goalX) {
  var inward = inwardOf(gk.team);
  var bx = ball.x, by = ball.y;
  var wide = Math.abs(by - GOAL_Y) > 16 && Math.abs(bx - goalX) < 30;
  var high = (ball.z || 0) > 1.2;
  var nearY = nearPostY(by);
  var low = (ball.z || 0) < 0.9;
  var close = Math.abs(bx - goalX) < 22;
  var inwardVy = (GOAL_Y - by) * (ball.vy || 0) > 1.5;
  var cutback = wide && low && close && (inwardVy || Math.abs(by - nearY) < 7);
  // 脚下的小角度射门不是传中。传中要球在空中，或是没人控制的宽位传送。
  var delivery = high || !ball.ownerId;
  if (!cutback && !(wide && delivery)) return null;
  var command = clamp(FM.v(gk, 'command') / 100, 0, 1);
  var aerial = clamp(FM.v(gk, 'aerial') / 100, 0, 1);
  var traffic = boxTraffic(match, gk);
  var farY = farPostY(by);
  var shade = 0.65 + command * 1.35;
  var y = GOAL_Y + (farY > GOAL_Y ? 1 : -1) * shade;
  var depth = 1.5 + aerial * 2.6;
  var act = 'stay';
  if (cutback) {
    act = 'cutback';
    y = nearY + (GOAL_Y - nearY) * 0.25;
    depth = 1.3 + aerial * 1.2;
  } else if (command > 0.68 && traffic <= 1 && aerial > 0.45) {
    act = 'claim';
    depth = 5 + aerial * 3.5;
    y = y * 0.45 + by * 0.55;
  } else if (traffic >= 2 && (command > 0.4 || aerial > 0.55)) {
    act = 'punch';
    depth = 2.4 + aerial * 1.6;
  }
  y = clamp(y, GOAL_Y - 8, GOAL_Y + 8);
  return {
    x: clamp(goalX + inward * depth, 1.2, FIELD_W - 1.2),
    y: y,
    mode: cutback ? 'cutback' : 'cross',
    crossAct: act,
    sprint: act === 'claim',
    speedMul: act === 'claim' ? 0.84 : (act === 'punch' ? 0.7 : 0.62),
    depth: depth,
    nearY: nearY,
    farY: farY,
    traffic: traffic,
  };
}

function position(match, gk) {
  var ball = match.ball || { x: FIELD_W / 2, y: GOAL_Y, z: 0, ownerId: null };
  var duel = oneOnOneTarget(match, gk);
  if (duel) return duel;
  var sweep = sweepTarget(match, gk);
  if (sweep) return sweep;

  var goalX = goalXOf(gk.team);
  var bx = ball.x, by = ball.y;
  var ballDist = Math.hypot(bx - goalX, by - GOAL_Y);
  var pos01 = positioning01(gk);
  var depth = idealDepth(ballDist, pos01) + sweeperBonus(match, gk);
  depth = clamp(depth, 0.7, 14);
  var mode = ballDist > 55 ? 'line' : 'angle';

  var cross = crossPlan(match, gk, ball, goalX);
  var spot;
  var near = null;
  if (cross) {
    spot = { x: cross.x, y: cross.y, mode: cross.mode };
    mode = cross.mode;
    depth = cross.depth;
  } else {
    spot = placeOnBisector(gk, bx, by, depth);
    near = applyNearPost(spot, bx, by, goalX, pos01);
    spot.y = near.y;
    mode = mode;
  }

  var speedMul = cross ? cross.speedMul : 0.55;
  var sprint = cross ? !!cross.sprint : false;
  if (!cross && ballSwitched(match, gk, ball)) {
    speedMul = Math.max(speedMul, 0.92);
    sprint = true;
    mode = mode === 'line' ? 'line' : 'angle';
  }

  var out = {
    x: spot.x,
    y: spot.y,
    mode: mode,
    sprint: sprint,
    speedMul: speedMul,
    depth: depth,
    set: false,
    crouch: false,
    spread: false,
    tight: near ? near.tight : angleTightness(bx, by, goalX),
    nearY: near ? near.nearY : nearPostY(by),
    farY: near ? near.farY : farPostY(by),
    crossAct: cross ? cross.crossAct : null,
    recover: !cross && ballSwitched(match, gk, ball),
  };
  return applySetFeet(match, gk, out);
}

// 扑救：近角（被站位覆盖的一侧）很难进；站在该站的点上，扑救概率更高。
function shotStop(match, gk, shooter) {
  var goalX = goalXOf(gk.team);
  var by = shooter.y;
  var central = Math.abs(by - GOAL_Y) < 4.5;
  var nearY = central ? GOAL_Y : nearPostY(by);
  var farY = central ? (by >= GOAL_Y ? GOAL_Y - POST : GOAL_Y + POST) : farPostY(by);
  var reach = 1.15 + clamp(FM.v(gk, 'reflexes') / 100, 0, 1) * 1.65;
  if (gk.gkSet) reach += 0.3;
  var gapNear = Math.abs(gk.y - nearY);
  var covered = gapNear <= reach + 0.35;
  var ideal = position(match, gk);
  var posErr = Math.hypot((gk.x || 0) - ideal.x, (gk.y || 0) - ideal.y);
  var posQ = clamp(1 - posErr / 5.5, 0, 1);
  if (!central) {
    var centerGap = Math.abs(GOAL_Y - nearY);
    var shadeQ = clamp(1 - gapNear / (centerGap + 0.8), 0, 1);
    posQ = clamp(posQ * 0.45 + shadeQ * 0.55, 0, 1);
  }
  var reflex = clamp((FM.v(gk, 'reflexes') - 50) / 100, -0.4, 0.4);
  var pSave = covered
    ? clamp(0.74 + 0.18 * posQ + reflex * 0.25, 0.62, 0.96)
    : clamp(0.16 + 0.2 * posQ + reflex * 0.2, 0.06, 0.42);
  var openGap = Math.abs(gk.y - farY);
  return {
    pSave: pSave,
    covered: covered,
    posQ: posQ,
    gapNear: gapNear,
    gapFar: openGap,
    nearY: nearY,
    farY: farY,
    reach: reach,
    aimY: covered ? nearY : farY,
  };
}

// 1v1 或近距离射门：一对一好的门将晚扑，差的一起脚就扑。远射不拖。
function diveDelay(gk, shooter) {
  if (!gk || !shooter) return 0;
  var goalX = goalXOf(gk.team);
  var inward = inwardOf(gk.team);
  var along = (shooter.x - goalX) * inward;
  if (along > 24 || along < 5) return 0;
  var one = clamp(FM.v(gk, 'oneOnOne') / 100, 0, 1);
  var reflex = clamp(FM.v(gk, 'reflexes') / 100, 0, 1);
  if (one < 0.35 && reflex < 0.4) return 0.05;
  return clamp(0.12 + one * 0.42 - (1 - reflex) * 0.08, 0, 0.55);
}

// 拿到球以后：视野和手抛好、身前有空当后卫 → 短传；否则看开大脚能力找前场。
function distribution(match, gk) {
  var vision = clamp(FM.v(gk, 'vision') / 100, 0, 1);
  var thr = clamp(FM.v(gk, 'throwing') / 100, 0, 1);
  var kick = clamp(FM.v(gk, 'kicking') / 100, 0, 1);
  var goalX = goalXOf(gk.team);
  var inward = inwardOf(gk.team);
  var best = null;
  var bestScore = -1;
  var long = null;
  var longAlong = -1;
  for (var i = 0; i < match.players.length; i++) {
    var q = match.players[i];
    if (q.team !== gk.team || q.sentOff || q.pos === 'GK' || q.id === gk.id) continue;
    var d = Math.hypot(q.x - gk.x, q.y - gk.y);
    var along = (q.x - goalX) * inward;
    if (along > longAlong) { longAlong = along; long = q; }
    if (d < 5 || d > 30) continue;
    var opp = 99;
    for (var j = 0; j < match.players.length; j++) {
      var o = match.players[j];
      if (o.team === gk.team || o.sentOff) continue;
      var od = Math.hypot(o.x - q.x, o.y - q.y);
      if (od < opp) opp = od;
    }
    if (opp < 6.5) continue;
    var score = opp + (d < 20 ? 3 : 0) + vision * 4;
    if (score > bestScore) { bestScore = score; best = { p: q, d: d, opp: opp }; }
  }
  var preferThrow = vision * 0.62 + thr * 0.38 - kick * 0.55;
  if (best && best.d < 16 + vision * 12 && preferThrow > 0.02) {
    return { kind: 'throw', targetId: best.p.id, x: best.p.x, y: best.p.y };
  }
  var tgt = long || best && best.p;
  return {
    kind: 'kick',
    targetId: tgt ? tgt.id : null,
    x: tgt ? tgt.x : goalX + inward * 50,
    y: tgt ? tgt.y : GOAL_Y,
  };
}

module.exports = {
  bisector: bisector,
  idealDepth: idealDepth,
  angleTightness: angleTightness,
  nearPostY: nearPostY,
  farPostY: farPostY,
  sweeperBonus: sweeperBonus,
  defensiveLineAlong: defensiveLineAlong,
  sweepTarget: sweepTarget,
  oneOnOneTarget: oneOnOneTarget,
  position: position,
  shotStop: shotStop,
  diveDelay: diveDelay,
  distribution: distribution,
  sprintSpeed: sprintSpeed,
};
