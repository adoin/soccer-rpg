// server/game/rules/behavior.js
// ============================================================
// 行为层：数值驱动球员的「决策与跑位」。确定性，零随机。
//
// 架构：
//   行为层（本文件，数值 → 球员怎么做）
//     → 产生场上实际局面
//     → 裁判层（offside.js，纯客观几何 → 怎么吹）
//
// 数值绝不参与判罚：裁判看到什么吹什么。
//
// 进攻方行为：
//   · 反越位跑位时机：高 anti 的前锋在前插时把目标钳制在越位线之前，
//     传球瞬间实际不越位——这是"行为产生的位置"，裁判客观判定为不越位；
//   · 越位后的决策：已处越位位置时，「急停收步不参与」(hold)
//     还是「继续前插参与进攻」(go)，由 iq/nerve 与越位深度决定；
//   · 收步后快速回位：回到不越位位置重新接应。
// 防守方行为：
//   · 防线纪律：高 anti/iq 的后卫紧紧跟住防线锚点，保持平行；
//   · 造越位协同：整条防线能力高、且无紧迫威胁时，一起压上造越位；
//   · 纪律差的后卫各回各的阵型点——防线参差不齐会如实反映在站位上，
//     裁判照单全收（可能把对方"放"成不越位）。
// ============================================================
'use strict';

var Offside = require('./offside');
var FIELD_W = 105;
var HALF = FIELD_W / 2;

var HOLD_BAR = 65; // 保持平行线的个人纪律阈值
var TRAP_BAR = 70; // 协同压上造越位的整线阈值
var ANTI_BAR = 65; // 反越位跑位时机的阈值

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function staminaFactor(p) {
  var m = p.maxStamina || 100;
  var s = p.stamina == null ? m : p.stamina;
  return 0.75 + 0.25 * (s / m);
}

// 防守球员防线纪律分（确定性）
function discipline(p) {
  return (p.stats.anti * 0.7 + p.stats.iq * 0.3) * staminaFactor(p);
}

// 整条防线（DF）的造越位协同能力（确定性）
function trapAbility(players, team) {
  var sum = 0, n = 0;
  players.forEach(function (p) {
    if (p.team === team && !p.sentOff && p.pos === 'DF') { sum += discipline(p); n++; }
  });
  return n ? sum / n : 50;
}

// ---------- 进攻 ----------

// 越位位置上的决策（确定性）：
//   'hold' —— 急停收步，不参与这次进攻（随后快速回位）；
//   'go'   —— 继续前插参与进攻。若裁判认定越位，哨声照吹，数值不救。
function attackerDecision(player, snap) {
  var depth = Offside.uOf(player, snap.attackingTeam) - Math.max(snap.uSecondLast, snap.uBall);
  if (depth <= 0.001) return 'go';
  var score = (player.stats.iq * 0.6 + player.stats.nerve * 0.4) * staminaFactor(player);
  return score >= 55 + depth * 6 ? 'hold' : 'go';
}

// 反越位跑位时机：无球前插的目标若会越过越位线，高 anti 球员将其
// 钳制在越位线之前（留余量）。返回修正后的 u 坐标；无需修正返回 null。
// 这是行为，不是判罚豁免——钳制后的实际位置由裁判客观判定。
function timeRunU(player, wantU, snap) {
  var riskLine = Math.max(snap.uSecondLast, snap.uBall, HALF + 0.001);
  if (wantU <= riskLine) return null;
  var timing = player.stats.anti * staminaFactor(player);
  if (timing < ANTI_BAR) return null; // 时机感差：照跑，听天由命
  return riskLine - 1.5;
}

// ---------- 防守 ----------

// 防线落位：返回 { playerId: {x, y} }（只包含参与落位的 DF）。
// pressing: 正在上抢的球员 id 集合（这些人不参与落位）。
function defensiveShape(match, team, pressing) {
  var goalX = team === 'home' ? 0 : FIELD_W;
  function vOf(x) { return Math.abs(x - goalX); }       // 距本方球门距离
  function xOf(v) { return team === 'home' ? v : FIELD_W - v; }
  pressing = pressing || {};

  var backs = match.players.filter(function (p) {
    return p.team === team && !p.sentOff && p.pos === 'DF' && !pressing[p.id] &&
      match.now >= (p.beatenUntil || 0) && match.now >= (p.frozenUntil || 0);
  });
  var out = {};
  if (!backs.length) return out;

  // 锚点：落位后卫中最靠前（距本方球门最远）的一个
  var anchorV = -1e9;
  backs.forEach(function (p) { var v = vOf(p.x); if (v > anchorV) anchorV = v; });

  var teamTrap = trapAbility(match.players, team);
  var vBall = vOf(match.ball.x);
  var danger = vBall > 62; // 球已进入本方三区：只求平行站住，不压上

  backs.forEach(function (p) {
    var vT;
    if (discipline(p) >= HOLD_BAR) {
      vT = anchorV; // 紧紧保持与防线平行
      if (!danger && teamTrap >= TRAP_BAR) {
        vT = Math.max(anchorV, Math.min(vBall + 10, 58)); // 整条线一起压上造越位
      }
    } else {
      vT = null; // 纪律差：各回各的阵型点，防线参差不齐
    }
    out[p.id] = vT == null
      ? { x: p.hx, y: p.hy }
      : { x: clamp(xOf(vT), 4, FIELD_W - 4), y: p.hy };
  });
  return out;
}

module.exports = {
  staminaFactor: staminaFactor,
  discipline: discipline,
  trapAbility: trapAbility,
  attackerDecision: attackerDecision,
  timeRunU: timeRunU,
  defensiveShape: defensiveShape,
  HOLD_BAR: HOLD_BAR,
  TRAP_BAR: TRAP_BAR,
  ANTI_BAR: ANTI_BAR,
};
