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
var GKPos = require('./gk');
var FM = require('../../../shared/fm');
var Teams = require('../../../shared/teams');
var FIELD_W = 105, FIELD_H = 68;
var HALF = FIELD_W / 2;

var HOLD_BAR = 51; // 保持平行线的个人纪律阈值（FM 聚合量级：后卫 discipline 约 50~59）
var TRAP_BAR = 55; // 协同压上造越位的整线阈值（主队 55.9 可造，客队 52.3 不行）
var ANTI_BAR = 65; // 反越位跑位时机的阈值（前锋 antiAtt 约 65~75）

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

// ============================================================
// 三层 AI（2026-10-12 用户：PC 智商太低，满场乱跑）：
//   Layer 1 队形层：全队是"橡皮筋"阵型，整体随球平移压缩，不断裂
//   Layer 2 角色层：防守 1 抢 1 协 8 区域；进攻宽度+支援
//   Layer 3 个体层：数值决定执行质量（跑动/站位/纪律）
// ============================================================

// Layer 1：队形锚点——阵型位置随球整体偏移（橡皮筋）
//   不同位置线偏移系数不同：DF 稳（0.25），MF 跟（0.45），FW 活（0.6）
//   保证阵型不断裂，不再"球在哪人去哪"
function shapeAnchor(match, p) {
  var sx = (match.ball.x - HALF) / HALF; // -1~1，球偏哪边
  var sy = (match.ball.y - HALF) / HALF;
  var k = p.pos === 'DF' ? 0.25 : p.pos === 'MF' ? 0.45 : 0.6;
  // 阵型整体平移：x 方向 12 米，y 方向 8 米（按系数缩放）
  var ax = clamp(p.hx + sx * 12 * k, 4, FIELD_W - 4);
  var ay = clamp(p.hy + sy * 8 * k, 6, FIELD_H - 6);
  return { x: ax, y: ay };
}

// 防线落位：返回 { playerId: {x, y} }（只包含参与落位的 DF）。
// pressing: 正在上抢的球员 id 集合（这些人不参与落位）。
// ★ 2026-10-12 三层重构：防线以队形锚点为基准，再按球做微调；
//   造越位：整线协同前压（trap），低纪律者掉队则陷阱失败（真实）。
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

  var teamTrap = trapAbility(match.players, team);
  var vBall = vOf(match.ball.x);
  var danger = vBall < 38; // 球进入本方 38 米才是危险

  // ★ 造越位触发判定：对方持球在中场（距我门 40~65 米）、持球超 1 秒（在找传球线路）、
  //   我方无紧迫威胁（最近对方距球 >6 米）、整线造越位能力达标
  var carrier = match.ball.ownerId ? match.byId[match.ball.ownerId] : null;
  var trapNow = false;
  if (!danger && teamTrap >= TRAP_BAR && carrier && carrier.team !== team) {
    var vCarrier = vOf(carrier.x);
    var carrierHold = match.now - (carrier._gotBallAt || 0) > 1000;
    var nearestThreat = 1e9;
    match.players.forEach(function (q) {
      if (q.team !== team && !q.sentOff && q.id !== carrier.id) {
        var d = Math.sqrt((q.x - match.ball.x) * (q.x - match.ball.x) + (q.y - match.ball.y) * (q.y - match.ball.y));
        if (d < nearestThreat) nearestThreat = d;
      }
    });
    // 中场区域 + 持球观察 + 无近端威胁 = 造越位窗口
    if (vCarrier > 40 && vCarrier < 65 && carrierHold && nearestThreat > 6) trapNow = true;
  }

  backs.forEach(function (p) {
    var anchor = shapeAnchor(match, p); // Layer 1：队形锚点
    var vT;
    var disc = discipline(p);
    if (disc >= HOLD_BAR) {
      // 以球为锚 + 队形锚点融合：防线在球门一侧 8 米，但横向跟随队形
      vT = clamp(vBall + 8, 10, 58);
      // ★ 造越位：整线协同前压 4 米（不是 12 米，4 米足够让前锋越位又不至于失位太多）
      //   纪律差的跟不上——陷阱失败，这就是真实足球
      if (trapNow && disc >= TRAP_BAR) {
        vT = clamp(vT + 4, 10, 62);
        p._trapStep = match.now; // 标记这次前压，用于视觉/日志
      }
    } else {
      vT = null; // 纪律差：回队形锚点，防线参差不齐
    }
    if (vT == null) {
      out[p.id] = anchor;
    } else {
      // 纵向按 vT，横向按队形锚点（防线整体平行移动，不断裂）
      out[p.id] = { x: clamp(xOf(vT), 4, FIELD_W - 4), y: anchor.y };
    }
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
  shapeAnchor: shapeAnchor, // ★ 2026-10-12 三层 AI：队形锚点
  attackTasks: attackTasks,
  markTargets: markTargets,
  carrierAdjust: carrierAdjust,
  keeperTarget: keeperTarget,
  blockShift: blockShift,
  blockTargets: blockTargets,
  updateSwaps: updateSwaps,
  slotPoint: slotPoint,
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
      var isDF = p.pos === 'DF';
      // ★ 数值驱动选角：offBall+pace 决定谁有资格前插，vision+teamwork 决定谁配做接应点
      //   没脑子的前锋跑不出好时机（转 cover），没视野的去接应也是站死位
      var runScore = FM.v(p, 'offBall') / 100 * 0.55 + FM.v(p, 'pace') / 100 * 0.30 + (p.pos === 'FW' ? 0.15 : 0);
      var supScore = FM.v(p, 'vision') / 100 * 0.50 + FM.v(p, 'teamwork') / 100 * 0.30 + (p.pos === 'MF' ? 0.20 : 0);
      // ★ 后卫不参与前插/拉边：只拖后保护，避免整条后防线跟着压上（之前边后卫会被 width 任务带到对方半场）
      if (!tired && !isDF && nRun < 2 && idx >= 1 && runScore > 0.45 &&
          (p.pos === 'FW' || p.pos === 'MF') && runScore >= supScore) { task = 'run'; nRun++; }
      else if (!tired && !isDF && nSupport < 2 && idx < 4 && supScore > 0.35) { task = 'support'; nSupport++; }
      else if (!isDF && Math.abs(p.hy - FIELD_H / 2) > 13) { task = 'width'; }
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
    // ★ 视野越好，找的空当越大（躲避半径 3.5→7.5 米），站死位的接应等于没有接应
    if (idx % 2 === 0) { tx = carrier.x - dir * 7; ty = carrier.y + side * 7; }
    else { tx = carrier.x + dir * 9; ty = carrier.y - side * 8; }
    var no = nearestOpp(match, tx, ty, carrier.team);
    var avoidR = 3.5 + (FM.v(p, 'vision') / 100) * 4;
    if (no && no.d < avoidR) { tx += (tx - no.q.x) * 1.2; ty += (ty - no.q.y) * 1.2; }
  } else if (task === 'run') {
    // 纵深前插：★ 快的、会跑位的插得更深（pace 20 比 pace 5 深约 7 米），目标带个人差避免站一条线
    tx = carrier.x + dir * (14 + (FM.v(p, 'pace') / 100) * 10 + (idHash(p.id) % 4));
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
    // 拖后保护：以阵型点为锚，只随球小幅移动；前压按球队进攻方向限幅（后卫至多 8 米），绝不盲目前压
    var want = (carrier.x - dir * 22 - p.hx) * 0.3;
    var fwdCap = p.pos === 'DF' ? 8 : 12;
    if (want * dir > fwdCap) want = fwdCap * dir;
    if (want * dir < -6) want = -6 * dir;
    tx = p.hx + want;
    ty = p.hy;
  }
  return { x: clamp(tx, 4, FIELD_W - 4), y: clamp(ty, 4, FIELD_H - 4) };
}

// 防守方中场盯人：★ 2026-10-12 三层重构——不再追着人跑，而是站"人和球门之间"
//   卡住传球线路。位置 = 对手与本方球门连线的中点偏球门侧，
//   再按球的位置微调。14 米内才盯，远了回队形。
function markTargets(match, defTeam, carrier, pressing) {
  var out = {};
  var goalX = defTeam === 'home' ? 0 : FIELD_W;
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
    if (best) {
      // ★ 球门侧站位：站在对手和球门之间，偏向球一侧 1.5 米（卡传球线路）
      //   不是站在对手身上（那是跟屁虫，会被一脚出球打穿）
      var mx = (best.x + goalX) / 2, my = (best.y + FIELD_H / 2) / 2;
      // 向球侧微调：离球越近，越靠近对手（压迫）；离球远，越靠近球门（保护）
      var dBall = Math.sqrt((match.ball.x - mx) * (match.ball.x - mx) + (match.ball.y - my) * (match.ball.y - my));
      var k = clamp(dBall / 20, 0.3, 1); // 球远→0.3（靠球门），球近→1（贴对手）
      var tx = mx + (best.x - mx) * k;
      var ty = my + (best.y - my) * k;
      // ★ 位置感好的卡得更准（站位更靠近最佳点），差的站偏一点
      var posQ = FM.v(p, 'positioning') / 100;
      tx += (mx - tx) * (1 - posQ) * 0.5;
      ty += (my - ty) * (1 - posQ) * 0.5;
      out[p.id] = { x: clamp(tx, 4, FIELD_W - 4), y: clamp(ty, 4, FIELD_H - 4) };
    }
  });
  return out;
}

// 持球者调整：被紧逼（5 米内有防守人）时减速护球并向空侧微调
function carrierAdjust(match, carrier) {
  var near = nearestOpp(match, carrier.x, carrier.y, carrier.team);
  var goalX = carrier.team === 'home' ? FIELD_W - 2 : 2;
  var tx = goalX, ty = carrier.y * 0.75 + (FIELD_H / 2) * 0.25, spMul = 1;
  if (near && near.d < 5) {
    // ★ 冷静度：被紧逼时 composure 高的只降到 0.8x 从容摆脱，慌的掉到 0.55x 护球
    var comp = FM.v(carrier, 'composure') / 100;
    spMul = 0.55 + 0.25 * comp;
    ty = carrier.y + (carrier.y >= near.q.y ? 5 : -5);
    ty = clamp(ty, 6, FIELD_H - 6);
  }
  return { tx: tx, ty: ty, spMul: spMul };
}

// 门将：站位、近门柱、单刀、传中、扫荡都在 rules/gk.js。这里只做转发。
function keeperTarget(match, p) {
  return GKPos.position(match, p);
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

// ============================================================
// 4-2-3-1 整体移动：全队共用一个平移量，只有最近的 1～2 人离开阵型去抢球。
// 阵型槽位在 shared/teams.js 的 FORMATIONS 里。换阵型只换数据。
// ============================================================

var LINE_U = {
  GK: { min: 2, max: 16 },
  DF: { min: 8, max: 62 },
  DM: { min: 18, max: 74 },
  AM: { min: 30, max: 88 },
  ST: { min: 40, max: 98 },
};

function formationOf(p) {
  var id = (p && p.formation) || Teams.DEFAULT_FORMATION || '4-2-3-1';
  return Teams.FORMATIONS[id] || Teams.FORMATIONS['4-2-3-1'];
}

function slotDef(p, num) {
  var form = formationOf(p);
  return form.slots[num] || form.slots[String(num)] || { u: p.formU || 40, y: p.formY || 34, pos: p.pos, line: 'DM' };
}

// 整队平移：进攻时后腰线落在球后约 10 米，防守时约 16 米。宽度一起收放。
function blockShift(match, team) {
  var form = formationOf(match.players.filter(function (p) { return p.team === team; })[0]);
  var carrier = match.ball.ownerId ? match.byId[match.ball.ownerId] : null;
  var attack = !!(carrier && carrier.team === team);
  var ballU = team === 'home' ? match.ball.x : (FIELD_W - match.ball.x);
  var behind = attack ? 10 : 16;
  var du = clamp(ballU - behind - form.refU, -16, 40);
  if (match.mentality === 'attack') du += attack ? 4 : 1;
  if (match.mentality === 'defend') du -= attack ? 1 : 4;
  du = clamp(du, -18, 42);
  var width = attack ? 1 : 0.82;
  var yShift = clamp((match.ball.y - FIELD_H / 2) * (attack ? 0.42 : 0.28), -8, 8);
  return { du: du, width: width, yShift: yShift, attack: attack, refU: form.refU };
}

// 某个槽位在本队坐标系下的场地坐标（已含整块平移）。
function slotPoint(p, num, shift) {
  var slot = slotDef(p, num == null ? p.num : num);
  var line = LINE_U[slot.line] || LINE_U.DM;
  var u, y;
  if (slot.line === 'GK' || slot.pos === 'GK') {
    u = clamp(slot.u + shift.du * 0.08, line.min, line.max);
    y = clamp(FIELD_H / 2 + (matchBallY(shift) - FIELD_H / 2) * 0.12, 28, 40);
  } else {
    u = clamp(slot.u + shift.du, line.min, line.max);
    y = clamp(FIELD_H / 2 + (slot.y - FIELD_H / 2) * shift.width + shift.yShift, 6, FIELD_H - 6);
  }
  var x = p.team === 'home' ? u : FIELD_W - u;
  return { x: clamp(x, 2, FIELD_W - 2), y: y, u: u };
}

function matchBallY(shift) {
  return shift._ballY == null ? FIELD_H / 2 : shift._ballY;
}

function blockTargets(match, team) {
  var shift = blockShift(match, team);
  shift._ballY = match.ball.y;
  var out = {};
  match.players.forEach(function (p) {
    if (p.team !== team || p.sentOff) return;
    out[p.id] = slotPoint(p, p.cover || p.num, shift);
  });
  return out;
}

var SWAP_OUT = 16;  // 离开自己槽位超过这么远，才找人补
var SWAP_NEAR = 18; // 补位的人自己得到这个槽位的距离上限
var SWAP_HOME = 12; // 回到自己槽位这个范围内，才允许再次换位

// 临时换位。两人都不持球、且都没有当前的上抢/协防任务时换回。
// 换回后先锁住，等本人回到自己的槽位附近才允许再换，避免一帧换上、一帧换回。
function updateSwaps(match, team, pressing, carrierId) {
  if (match.autoSwap === false) return;
  pressing = pressing || {};
  var shift = blockShift(match, team);
  shift._ballY = match.ball.y;
  var mates = match.players.filter(function (p) {
    return p.team === team && !p.sentOff && p.pos !== 'GK';
  });
  mates.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });

  var seen = {};
  mates.forEach(function (p) {
    if (!p.swapWith || seen[p.id]) return;
    var q = match.byId[p.swapWith];
    seen[p.id] = true;
    if (!q || q.swapWith !== p.id || q.team !== team || q.sentOff) {
      p.swapWith = null;
      p.cover = p.num;
      return;
    }
    seen[q.id] = true;
    var onBall = !!(carrierId && (carrierId === p.id || carrierId === q.id));
    var marking = !!(pressing[p.id] || pressing[q.id]);
    if (!onBall && !marking) {
      p.swapWith = null;
      q.swapWith = null;
      p.cover = p.num;
      q.cover = q.num;
      p._swapHold = true;
      q._swapHold = true;
    }
  });

  mates.forEach(function (p) {
    if (!p._swapHold || p.swapWith) return;
    var home = slotPoint(p, p.num, shift);
    var back = Math.sqrt((p.x - home.x) * (p.x - home.x) + (p.y - home.y) * (p.y - home.y));
    if (back < SWAP_HOME || carrierId === p.id || pressing[p.id]) p._swapHold = false;
  });

  var used = {};
  mates.forEach(function (p) { if (p.swapWith) used[p.id] = true; });
  mates.forEach(function (p) {
    if (used[p.id] || p._swapHold) return;
    var slot = slotPoint(p, p.cover || p.num, shift);
    var dOwn = Math.sqrt((p.x - slot.x) * (p.x - slot.x) + (p.y - slot.y) * (p.y - slot.y));
    if (dOwn <= SWAP_OUT) return;
    var best = null, bd = dOwn;
    mates.forEach(function (q) {
      if (q.id === p.id || used[q.id] || q._swapHold) return;
      if (carrierId && q.id === carrierId) return;
      var dq = Math.sqrt((q.x - slot.x) * (q.x - slot.x) + (q.y - slot.y) * (q.y - slot.y));
      if (dq >= bd || dq > SWAP_NEAR) return;
      if (!best || dq < bd - 0.001 || (Math.abs(dq - bd) < 0.001 && q.id < best.id)) {
        best = q;
        bd = dq;
      }
    });
    if (!best) return;
    var pc = p.cover || p.num;
    var bc = best.cover || best.num;
    p.cover = bc;
    best.cover = pc;
    p.swapWith = best.id;
    best.swapWith = p.id;
    used[p.id] = true;
    used[best.id] = true;
  });
}
