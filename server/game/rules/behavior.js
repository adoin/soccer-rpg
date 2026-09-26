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
var FM = require('../../../shared/fm');
var FIELD_W = 105, FIELD_H = 68;
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
  return (FM.antiDef(p) * 0.7 + FM.iq(p) * 0.3) * staminaFactor(p);
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
  var score = (FM.iq(player) * 0.6 + FM.nerve(player) * 0.4) * staminaFactor(player);
  return score >= 55 + depth * 6 ? 'hold' : 'go';
}

// 反越位跑位时机：无球前插的目标若会越过越位线，高 anti 球员将其
// 钳制在越位线之前（留余量）。返回修正后的 u 坐标；无需修正返回 null。
// 这是行为，不是判罚豁免——钳制后的实际位置由裁判客观判定。
function timeRunU(player, wantU, snap) {
  var riskLine = Math.max(snap.uSecondLast, snap.uBall, HALF + 0.001);
  if (wantU <= riskLine) return null;
  var timing = FM.antiAtt(player) * staminaFactor(player);
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
  attackTasks: attackTasks,
  markTargets: markTargets,
  carrierAdjust: carrierAdjust,
  keeperTarget: keeperTarget,
  HOLD_BAR: HOLD_BAR,
  TRAP_BAR: TRAP_BAR,
  ANTI_BAR: ANTI_BAR,
};

// ============================================================
// 无球跑位任务系统（消除全员按阵型同步往返的机械感）。
// 任务类型：support（接应）、run（纵深前插）、width（拉边）、cover（拖后保护）、hold（收步）。
// 任务粘性：每人每 ~1.2-1.7s 才重选一次任务（按 id 错开），期间目标点每 tick 跟随局面更新。
// 全确定性：排序/选择只用距离、位置、体能、id 哈希，无随机。
// ============================================================

function dist2(a, b) {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}
function idHash(id) {
  var h = 0;
  for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

// 进攻方无球任务分配：返回 { playerId: { type, x, y } }
function attackTasks(match, carrier, snap) {
  var dir = carrier.team === 'home' ? 1 : -1;
  var now = match.now;
  var mates = match.players.filter(function (p) {
    return p.team === carrier.team && p.id !== carrier.id && !p.sentOff &&
      p.pos !== 'GK' && now >= (p.frozenUntil || 0);
  });
  mates.sort(function (a, b) { return dist2(a, carrier) - dist2(b, carrier); });

  var out = {};
  var nSupport = 0, nRun = 0;
  mates.forEach(function (p, idx) {
    // 收步中的球员：原地不动，不参与这次进攻
    if (now < (p.holdingUntil || 0)) {
      out[p.id] = { type: 'hold', x: p.x, y: p.y };
      p._task = 'hold';
      return;
    }
    // 任务粘性：未到期沿用旧任务
    var task = (p._task && now < (p._taskUntil || 0)) ? p._task : null;
    if (!task) {
      var tired = (p.stamina == null ? 100 : p.stamina) < 25;
      if (!tired && nSupport < 2 && idx < 4) { task = 'support'; nSupport++; }
      else if (!tired && (p.pos === 'FW' || (p.pos === 'MF' && nRun < 1)) && idx >= 1) { task = 'run'; nRun++; }
      else if (Math.abs(p.hy - FIELD_H / 2) > 13) { task = 'width'; }
      else { task = 'cover'; }
      p._task = task;
      p._taskUntil = now + 1200 + (idHash(p.id) % 500);
    } else {
      // 沿用旧任务时也要占名额，避免新选任务挤占
      if (task === 'support') nSupport++;
      if (task === 'run') nRun++;
    }
    var t = taskTarget(match, p, carrier, dir, task, snap, idx);
    out[p.id] = { type: task, x: t.x, y: t.y };
  });
  return out;
}

// 各任务的目标点（每 tick 按实时局面更新）
function taskTarget(match, p, carrier, dir, task, snap, idx) {
  var side = (idHash(p.id) % 2 === 0) ? 1 : -1;
  var tx, ty;
  if (task === 'support') {
    // 接应：轮流站持球者身后（出球点）和侧前方（推进点），并主动避开防守人
    if (idx % 2 === 0) { tx = carrier.x - dir * 7; ty = carrier.y + side * 7; }
    else { tx = carrier.x + dir * 9; ty = carrier.y - side * 8; }
    var no = nearestOpp(match, tx, ty, carrier.team);
    if (no && no.d < 3.5) { tx += (tx - no.q.x) * 1.2; ty += (ty - no.q.y) * 1.2; }
  } else if (task === 'run') {
    // 纵深前插：目标带个人差，避免站一条线
    tx = carrier.x + dir * (17 + (idHash(p.id) % 6));
    ty = p.hy * 0.45 + carrier.y * 0.3 + side * 6;
    // ★ 反越位时机：高 anti 球员把前插目标钳制在越位线之前（行为，不是豁免）
    var wantU = p.team === 'home' ? tx : FIELD_W - tx;
    var fixedU = timeRunU(p, wantU, snap);
    if (fixedU != null) tx = p.team === 'home' ? fixedU : FIELD_W - fixedU;
    // ★ 越位后的决策：选择收步的快速回位
    if (Offside.isOffsidePosition(p, snap) && attackerDecision(p, snap) === 'hold') {
      tx = p.x - 14 * dir; ty = p.hy;
    }
  } else if (task === 'width') {
    // 拉边：贴边线保持宽度
    tx = carrier.x + dir * 4;
    ty = p.hy < FIELD_H / 2 ? 8 : FIELD_H - 8;
  } else {
    // 拖后保护：阵型点与持球者之间偏后，不盲目前压
    tx = p.hx * 0.7 + (carrier.x - dir * 18) * 0.3;
    ty = p.hy;
  }
  return { x: clamp(tx, 4, FIELD_W - 4), y: clamp(ty, 4, FIELD_H - 4) };
}

// 防守方中场盯人：非上抢 MF 1 对 1 跟最近的对方无球队员（14 米内才跟）
function markTargets(match, defTeam, carrier, pressing) {
  var out = {};
  match.players.forEach(function (p) {
    if (p.team !== defTeam || p.sentOff || p.pos !== 'MF') return;
    if (pressing[p.id]) return;
    if (match.now < (p.beatenUntil || 0) || match.now < (p.frozenUntil || 0)) return;
    var best = null, bd = 14;
    match.players.forEach(function (q) {
      if (q.team !== defTeam && q.id !== carrier.id && !q.sentOff && q.pos !== 'GK' &&
          match.now >= (q.frozenUntil || 0)) {
        var d = dist2(p, q);
        if (d < bd) { bd = d; best = q; }
      }
    });
    if (best) out[p.id] = { x: best.x, y: best.y };
  });
  return out;
}

// 持球者调整：被紧逼（5 米内有防守人）时减速护球并向空侧微调
function carrierAdjust(match, carrier) {
  var near = nearestOpp(match, carrier.x, carrier.y, carrier.team);
  var goalX = carrier.team === 'home' ? FIELD_W - 2 : 2;
  var tx = goalX, ty = carrier.y * 0.75 + (FIELD_H / 2) * 0.25, spMul = 1;
  if (near && near.d < 5) {
    spMul = 0.55;
    ty = carrier.y + (carrier.y >= near.q.y ? 5 : -5);
    ty = clamp(ty, 6, FIELD_H - 6);
  }
  return { tx: tx, ty: ty, spMul: spMul };
}

// 门将：随球横向小范围移动，不再钉死在阵型点
function keeperTarget(match, p) {
  var tx = p.hx + clamp((match.ball.x - p.hx) * 0.12, -6, 6);
  var ty = p.hy + clamp((match.ball.y - p.hy) * 0.25, -8, 8);
  return { x: tx, y: ty };
}

function nearestOpp(match, x, y, team) {
  var best = null, bd = 1e9;
  match.players.forEach(function (q) {
    if (q.team === team || q.sentOff) return;
    var d = Math.sqrt((q.x - x) * (q.x - x) + (q.y - y) * (q.y - y));
    if (d < bd) { bd = d; best = q; }
  });
  return best ? { q: best, d: bd } : null;
}
