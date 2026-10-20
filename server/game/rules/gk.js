// server/game/rules/gk.js
// ============================================================
// 门将选位。沿「球到两门柱夹角的角平分线」站，深度看球的距离和威胁，
// 数值（站位、指挥、出击、高空球）决定站多深、出不出击。
//
//   angle  常规：站在角平分线上，球远就贴近门线，球近就前迎。
//   cross  传中：球在宽位且进入本方危险区（或球在空中）时，
//          离开近门柱、站到能处理传中的深度，高空能力越好站得越靠前。
//   sweep  自由球直塞：球在无人控制、正滚向禁区，且门将按出击
//          属性算下来能比最近的对方先到，才弃门出击。对方能先到
//          就留在线上。
//   line   球在对方半场、没有威胁：回到门线附近的角平分线上。
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

// 球看向两门柱的角平分线方向（从球指向球门）。
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

// 球离球门中心的距离 → 理想深度。远球贴线，近球前迎，上限约 6 米。
function idealDepth(ballDist, pos01) {
  var base = 6.2 * Math.exp(-ballDist / 22) + 0.7;
  base = clamp(base, 0.7, 6.2);
  var k = 0.45 + 0.55 * pos01;
  return 1.2 + (base - 1.2) * k;
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

// 自由球直塞：能先到才弃门。返回目标或 null。
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
  // 球正在离开球门且速度不低：不追出去
  var vx = ball.vx || 0;
  var leaving = vx * inward > 2.5 && along > 16;
  if (leaving) return null;
  var tGk = dist / sprintSpeed(gk);
  var tOpp = nearestOpponentTime(match, gk, ball.x, ball.y);
  // 指挥好的门将要求更明显的时间差才出击，避免瞎冲
  var command = clamp(FM.v(gk, 'command') / 100, 0, 1);
  var need = 0.28 - rush * 0.22 + command * 0.08;
  if (tGk + Math.max(0.04, need) >= tOpp) return null;
  return {
    x: clamp(ball.x, 2, FIELD_W - 2),
    y: clamp(ball.y, 6, FIELD_H - 6),
    mode: 'sweep',
    sprint: true,
    speedMul: 0.98,
  };
}

function position(match, gk) {
  var ball = match.ball || { x: FIELD_W / 2, y: GOAL_Y, z: 0 };
  var sweep = sweepTarget(match, gk);
  if (sweep) return sweep;

  var goalX = goalXOf(gk.team);
  var bx = ball.x, by = ball.y;
  var ballDist = Math.hypot(bx - goalX, by - GOAL_Y);
  var pos01 = positioning01(gk);
  var depth = idealDepth(ballDist, pos01);
  var mode = ballDist > 55 ? 'line' : 'angle';

  var wide = Math.abs(by - GOAL_Y) > 16 && Math.abs(bx - goalX) < 30;
  var high = (ball.z || 0) > 1.2;
  if (wide && (high || Math.abs(bx - goalX) < 24)) {
    mode = 'cross';
    var aerial = clamp(FM.v(gk, 'aerial') / 100, 0, 1);
    depth = 1.5 + aerial * 2.6;
  }

  var spot = placeOnBisector(gk, bx, by, depth);
  if (mode === 'cross') {
    // 传中不要死钉近门柱：往球门中路收一截，准备起跳。
    spot.y = clamp(spot.y * 0.62 + GOAL_Y * 0.38, GOAL_Y - 8, GOAL_Y + 8);
  }
  return {
    x: spot.x,
    y: spot.y,
    mode: mode,
    sprint: false,
    speedMul: mode === 'cross' ? 0.62 : 0.55,
    depth: depth,
  };
}

module.exports = {
  bisector: bisector,
  idealDepth: idealDepth,
  sweepTarget: sweepTarget,
  position: position,
  sprintSpeed: sprintSpeed,
};
