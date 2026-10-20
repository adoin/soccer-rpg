// server/game/rules/switch.js
// ============================================================
// 回防时切到「最有机会拦截 / 压迫」的自己人，不是单纯离球最近的人。
//
// 评分（越高越好）：
//   · 到达球或球 0.5 秒后位置的时间（速度来自球员属性）；
//   · 站在球和本方球门之间（球门侧）有加分；
//   · 比球更靠近对方球门超过 10 米 = 远在进攻方向的身后，
//     直接出局，避免切到前场一个够不着球的人。
//
// 滞回：当前控制的人如果只差一截（默认 0.35 分），不切换，
// 免得每 tick 在两个人之间闪。球权刚易手时引擎用 margin=0，
// 立刻切到最优。手动切换由引擎写 manualUntil，本模块不读输入。
// ============================================================
'use strict';

var FM = require('../../../shared/fm');

var FIELD_W = 105, FIELD_H = 68;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function sprintSpeed(p) {
  var spd = (7.2 + FM.speed(p) * 0.094) * 0.72 * 1.10;
  var st = p.stamina == null ? 100 : p.stamina;
  var mx = p.maxStamina || 100;
  spd *= 0.7 + 0.3 * Math.max(0, Math.min(1, st / mx));
  return Math.max(3.2, spd);
}

function rank(match, team) {
  var ball = match.ball;
  var attack = team === 'home' ? 1 : -1;
  var look = 0.5;
  var tx = clamp(ball.x + (ball.vx || 0) * look, 1, FIELD_W - 1);
  var ty = clamp(ball.y + (ball.vy || 0) * look, 1, FIELD_H - 1);
  var out = [];
  for (var i = 0; i < match.players.length; i++) {
    var p = match.players[i];
    if (p.team !== team || p.sentOff || p.pos === 'GK') continue;
    var dBall = Math.hypot(p.x - ball.x, p.y - ball.y);
    var dPath = Math.hypot(p.x - tx, p.y - ty);
    var t = Math.min(dBall, dPath) / sprintSpeed(p);
    var behind = (p.x - ball.x) * attack; // >0：比球更靠近对方球门，人已经落在球的身后
    var goalSide = Math.max(0, -behind);
    var farBehind = behind > 10;
    var score;
    if (farBehind) score = -1000 - behind;
    else {
      score = -t;
      // 人在球的进攻侧：得绕到球前面才挡得住，固定罚一截，避免切给前场最近的人
      if (behind > 0.8) score -= 0.85;
      else if (goalSide > 0) score += Math.min(goalSide, 6) * 0.04;
    }
    out.push({
      id: p.id, score: score, t: t, behind: behind, farBehind: farBehind,
    });
  }
  out.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

// currentId 为空：直接返回最优。margin>0：当前人落后不足 margin 则保持。
function pick(match, team, currentId, margin) {
  var ranked = rank(match, team);
  if (!ranked.length) return null;
  var best = ranked[0];
  if (!currentId) return best.id;
  var cur = null;
  for (var i = 0; i < ranked.length; i++) {
    if (ranked[i].id === currentId) { cur = ranked[i]; break; }
  }
  if (!cur) return best.id;
  var m = margin == null ? 0.35 : margin;
  if (best.id !== cur.id && best.score < cur.score + m) return cur.id;
  return best.id;
}

module.exports = {
  sprintSpeed: sprintSpeed,
  rank: rank,
  pick: pick,
};
