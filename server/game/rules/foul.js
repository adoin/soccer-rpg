// server/game/rules/foul.js
// ============================================================
// 抢断 / 犯规 / 裁判引擎。
//
// 两层设计：
//  1. 抢断结果——基于数值的随机：
//       干净抢断率 = f(防守方defend, 进攻方dribble, 侵略性, 场景修正)
//       犯规率     = f(侵略性, 背后/高速/战术犯规等场景修正)
//       其余       = 被过掉
//     用比赛独立 RNG 掷骰，客户端无法预测。
//  2. 判罚映射——100% 确定、零误判：
//     一旦判定为犯规，严重程度 → 判罚是一一映射：
//       严重程度 = aggr×0.45 + 场景修正 + rng×30（动作本身带随机性）
//       裁判只按"执法尺度"（宽松/标准/严格）平移黄牌/红牌阈值，
//       同样的犯规永远得到同样的牌，不存在"误判"。
//  3. 特殊规则（确定性）：
//       - 禁区内犯规 → 点球；禁区外 → 直接任意球；
//       - DOGSO（破坏明显进球机会，最后一人犯规）→ 直接红牌；
//       - 两黄变一红；红牌罚下后该队少打一人；
//       - 轻微犯规 + 进攻有利 → 进攻有利，比赛继续（黄牌以上一律鸣哨）。
// ============================================================
'use strict';

var FM = require('../../../shared/fm');

var FIELD_W = 105;
var FIELD_H = 68;

function effFactor(p) {
  return 0.75 + 0.25 * (p.stamina / p.maxStamina);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function dist(ax, ay, bx, by) {
  var dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// 裁判执法尺度 → 牌阈值
var STRICTNESS = {
  lenient:  { yellow: 66, red: 86, label: '宽松' },
  standard: { yellow: 58, red: 78, label: '标准' },
  strict:   { yellow: 50, red: 70, label: '严格' },
};

var REFEREES = [
  { name: '山本 健一', strictness: 'standard' },
  { name: '高木 铁男', strictness: 'strict' },
  { name: '约翰·史密斯', strictness: 'lenient' },
];

function pickReferee(rng) {
  return REFEREES[Math.floor(rng() * REFEREES.length)];
}

// 犯规地点是否在防守方禁区内（防守方 team 的禁区）
function inBox(x, y, defendingTeam) {
  var inX = defendingTeam === 'home' ? x < 16.5 : x > FIELD_W - 16.5;
  return inX && Math.abs(y - FIELD_H / 2) <= 20.2;
}

function distGoal(p, attackingTeam) {
  var gx = attackingTeam === 'home' ? FIELD_W : 0;
  return dist(p.x, p.y, gx, FIELD_H / 2);
}

// ---------- 抢断判定（随机层） ----------
// ctx: { fromBehind, speedHigh, tactical, attackPromising }
function judgeTackle(match, defender, attacker, ctx) {
  ctx = ctx || {};
  var dEff = FM.defend(defender) * effFactor(defender);
  var aEff = FM.dribble(attacker) * effFactor(attacker);
  var aggr = FM.aggr(defender);

  var pClean = clamp(0.40 + (dEff - aEff) * 0.012 - (aggr - 55) * 0.004, 0.05, 0.88);
  var pFoul = clamp(
    0.08 + (aggr - 55) * 0.010 + (ctx.fromBehind ? 0.18 : 0) + (ctx.speedHigh ? 0.06 : 0) + (ctx.tactical ? 0.05 : 0),
    0.02, 0.55
  );

  var r = match.rng();
  if (r < pClean) return { outcome: 'clean', pClean: pClean, pFoul: pFoul };
  if (r < pClean + pFoul) {
    return { outcome: 'foul', pClean: pClean, pFoul: pFoul, foul: judgeFoul(match, defender, attacker, ctx) };
  }
  return { outcome: 'beaten', pClean: pClean, pFoul: pFoul };
}

// ---------- 犯规定级（确定层 + 动作随机） ----------
function judgeFoul(match, defender, victim, ctx) {
  ctx = ctx || {};
  var strict = STRICTNESS[match.referee.strictness] || STRICTNESS.standard;

  var ctxMod = (ctx.fromBehind ? 18 : 0) + (ctx.speedHigh ? 8 : 0) + (ctx.tactical ? 6 : 0);
  var severity = FM.aggr(defender) * 0.45 + ctxMod + match.rng() * 30;

  var defendingTeam = defender.team;
  var penalty = inBox(victim.x, victim.y, defendingTeam);

  // DOGSO：破坏明显进球机会（确定性）——最后一人 + 近距离 + 身后犯规
  var dogso = isDogso(match, defender, victim);

  var card = 'none';
  var severityLabel = '一般犯规';
  if (dogso || severity >= strict.red) {
    card = 'red';
    severityLabel = dogso ? '破坏明显进球机会' : (severity >= strict.red + 14 ? '暴力行为' : '严重犯规');
  } else if (severity >= strict.yellow) {
    card = 'yellow';
    severityLabel = '鲁莽犯规';
  }

  // 进攻有利：只有无牌的轻微犯规才继续比赛
  var advantage = card === 'none' && !!ctx.attackPromising;

  return {
    defender: defender,
    victim: victim,
    team: victim.team, // 获利方
    spot: { x: victim.x, y: victim.y },
    severity: Math.round(severity),
    severityLabel: severityLabel,
    card: card,
    dogso: dogso,
    penalty: penalty,
    advantage: advantage,
    strictLabel: strict.label,
  };
}

// DOGSO 确定性检查：受害者距球门 <24 米，且除门将和犯规者外没有防守球员在其身前
function isDogso(match, defender, victim) {
  if (distGoal(victim, victim.team) > 24) return false;
  var uVictim = victim.team === 'home' ? victim.x : FIELD_W - victim.x;
  var cover = match.players.filter(function (p) {
    if (p.team !== defender.team || p.sentOff || p.id === defender.id || p.pos === 'GK') return false;
    var u = victim.team === 'home' ? p.x : FIELD_W - p.x;
    return u > uVictim - 2;
  });
  return cover.length === 0;
}

// ---------- 牌面执行（变异球员状态） ----------
function applyCards(foul) {
  var d = foul.defender;
  d.cards = d.cards || { yellow: 0, red: false };
  var secondYellow = false;
  if (foul.card === 'yellow') {
    d.cards.yellow++;
    if (d.cards.yellow >= 2) {
      secondYellow = true;
      foul.card = 'red';
      foul.severityLabel = '两黄变一红';
    }
  }
  if (foul.card === 'red') {
    d.cards.red = true;
    d.sentOff = true;
  }
  foul.secondYellow = secondYellow;
  return foul;
}

function cardText(foul) {
  var d = foul.defender, v = foul.victim;
  var t = '';
  if (foul.card === 'red') {
    t = '🟥 红牌！' + d.name + foul.severityLabel + '，被罚下场！';
  } else if (foul.card === 'yellow') {
    t = '🟨 黄牌！' + d.name + foul.severityLabel + '放倒了' + v.name + '。';
  } else {
    t = '哨响，' + d.name + '犯规。';
  }
  if (foul.penalty) t += '禁区内犯规——点球！';
  else if (!foul.advantage) t += v.team === 'home' ? '青鹰高校' : '烈风学院';
  return t;
}

module.exports = {
  STRICTNESS: STRICTNESS,
  pickReferee: pickReferee,
  inBox: inBox,
  distGoal: distGoal,
  judgeTackle: judgeTackle,
  judgeFoul: judgeFoul,
  applyCards: applyCards,
  cardText: cardText,
};
