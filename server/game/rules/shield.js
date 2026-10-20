// server/game/rules/shield.js
// ============================================================
// 护球：身体对抗，不是「对手冻结」开关。
//
// 持球方：力量 / 平衡 / 身体（力量+平衡+勇猛）
// 防守方：力量 / 侵略性 / 抢断
//
// 结果四选一（同一 RNG 流，可复现）：
//   hold   护住。球还在脚下，但持球人减速。只有身体差距很大时
//          防守人短暂失去重心（≤280ms），不是 1 秒以上的定身。
//   poke   防守人把球捅出来。
//   foul   防守人犯规（牌面交给 foul.js，本模块不判牌）。
//   jostle 两人挤在一起，球还在，谁也不被冻住，双方都慢。
//
// 差距不大时 hold 只是小概率；差距拉开 hold 才成为主要结果。
// AI 默认仍选择上抢。只有「身体差一截且侵略性很低」才选择
// 保持距离盯防，而且是继续移动，不是站桩。
// ============================================================
'use strict';

var FM = require('../../../shared/fm');

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function eff(p) {
  var st = p.stamina == null ? 100 : p.stamina;
  var mx = p.maxStamina || 100;
  return 0.75 + 0.25 * clamp(st / mx, 0, 1);
}

// 身体：力量为主，平衡次之，勇猛代表对抗意愿和扛撞。
function bodyScore(p) {
  return FM.v(p, 'strength') * 0.42 + FM.v(p, 'balance') * 0.33 + FM.v(p, 'bravery') * 0.25;
}

function pressScore(p) {
  return FM.v(p, 'strength') * 0.30 + FM.aggr(p) * 0.30 + FM.v(p, 'tackling') * 0.40;
}

function preview(carrier, defender) {
  var gap = bodyScore(carrier) * eff(carrier) - pressScore(defender) * eff(defender);
  var aggr = FM.aggr(defender);
  var pHold = clamp(0.18 + gap * 0.009, 0.06, 0.80);
  var pPoke = clamp(0.34 - gap * 0.0045, 0.08, 0.55);
  var pFoul = clamp(0.08 + (aggr - 55) * 0.004, 0.04, 0.28);
  var pJostle = clamp(0.24 - gap * 0.004, 0.06, 0.30);
  var sum = pHold + pPoke + pFoul + pJostle;
  return {
    gap: gap,
    pHold: pHold / sum,
    pPoke: pPoke / sum,
    pFoul: pFoul / sum,
    pJostle: pJostle / sum,
    // 护球一定减速：身体越占优掉得越少，但到不了满速
    slow: clamp(0.60 + Math.max(0, gap) * 0.0016, 0.58, 0.78),
    defenderOffBalanceMs: gap >= 30 ? 280 : 0,
  };
}

// rng 是返回 [0,1) 的函数（比赛的 this.rng 即可）
function resolve(rng, carrier, defender) {
  var p = preview(carrier, defender);
  var r = rng();
  var outcome = 'jostle';
  if (r < p.pHold) outcome = 'hold';
  else if (r < p.pHold + p.pPoke) outcome = 'poke';
  else if (r < p.pHold + p.pPoke + p.pFoul) outcome = 'foul';
  var off = (outcome === 'hold') ? p.defenderOffBalanceMs : 0;
  return {
    outcome: outcome,
    gap: p.gap,
    slow: p.slow,
    defenderOffBalanceMs: off,
    pHold: p.pHold,
    pPoke: p.pPoke,
    pFoul: p.pFoul,
    pJostle: p.pJostle,
  };
}

// AI 是否还要做抢断决策。绝大多数情况要。
// 只有身体被完全压制、而且这个防守人侵略性很低，才改为保持距离。
function challengeDecision(defender, carrier) {
  var gap = bodyScore(carrier) * eff(carrier) - pressScore(defender) * eff(defender);
  var aggr = FM.aggr(defender);
  // 身体差一截而且还特别不爱出脚，才选择保持距离。普通的弱防守仍然上抢。
  if (gap >= 48 && aggr < 25) return { challenge: false, reason: 'stand-off', gap: gap };
  return { challenge: true, reason: 'press', gap: gap };
}

module.exports = {
  bodyScore: bodyScore,
  pressScore: pressScore,
  preview: preview,
  resolve: resolve,
  challengeDecision: challengeDecision,
};
