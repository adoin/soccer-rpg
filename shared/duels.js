// 对抗权重表。改这里就能调突破、假动作、抢断和射门的倾向。
// 分数 = 加权属性（1-20）+ 技能修正，再乘体能和 ±15% 摇摆。攻方高于守方则攻方赢。
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SharedDuels = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LABELS = {
    pace: '速度', acceleration: '加速', agility: '灵活', dribbling: '盘带', technique: '技巧',
    finishing: '射门', longShots: '远射', composure: '冷静', strength: '力量', balance: '平衡',
    tackling: '抢断', marking: '盯人', positioning: '位置', aggression: '侵略', bravery: '勇敢',
    reflexes: '反应', handling: '手控', oneOnOne: '单刀', passing: '传球', vision: '视野',
  };

  var ATTACK = {
    dribble: { name: '突破', weights: { pace: 0.22, acceleration: 0.18, dribbling: 0.4, agility: 0.2 }, bonus: 0.15 },
    burst: { name: '突然加速', weights: { pace: 0.55, acceleration: 0.35, agility: 0.1 }, bonus: 0.45 },
    feint: { name: '假动作', weights: { dribbling: 0.45, technique: 0.4, agility: 0.15 }, bonus: -0.7 },
    pass: { name: '传球', weights: { passing: 0.45, vision: 0.3, technique: 0.25 }, bonus: 0.2 },
    'shot-driven': { name: '抽射', weights: { finishing: 0.3, longShots: 0.15, strength: 0.3, composure: 0.25 }, bonus: 0.15 },
    'shot-placed': { name: '推射', weights: { finishing: 0.45, technique: 0.25, composure: 0.3 }, bonus: -0.1 },
    'shot-curl': { name: '弧线球', weights: { technique: 0.4, finishing: 0.3, composure: 0.2, agility: 0.1 }, bonus: 0.05 },
    special: { name: '必杀', weights: { finishing: 0.4, technique: 0.25, composure: 0.2, longShots: 0.15 }, bonus: 1.1 },
  };

  var DEFENCE = {
    mark: { name: '卡位', weights: { marking: 0.34, positioning: 0.36, tackling: 0.15, pace: 0.15 }, bonus: 0.2 },
    tackle: { name: '抢断', weights: { tackling: 0.5, pace: 0.28, positioning: 0.22 }, bonus: 0.85 },
    'def-flying': { name: '离地飞铲', weights: { tackling: 0.48, pace: 0.37, aggression: 0.15 }, bonus: 1.35 },
    'def-sweep': { name: '横扫千军', weights: { tackling: 0.46, pace: 0.34, agility: 0.2 }, bonus: 1.15 },
    'def-shoulder': { name: '铁山靠', weights: { strength: 0.5, balance: 0.3, tackling: 0.2 }, bonus: 1.05 },
    'def-elbow': { name: '铁索拦江', weights: { strength: 0.42, balance: 0.23, bravery: 0.15, tackling: 0.2 }, bonus: 1.25 },
    gk: { name: '扑救', weights: { reflexes: 0.42, handling: 0.18, positioning: 0.2, oneOnOne: 0.2 }, bonus: 0.45 },
  };

  function stat(p, key) {
    var s = (p && p.stats) || {};
    return s[key] == null ? 10 : s[key];
  }
  function fatigue(p) {
    var mx = (p && p.maxStamina) || 100;
    var st = p && p.stamina != null ? p.stamina : mx;
    return 0.84 + 0.16 * Math.max(0, Math.min(1, st / mx));
  }
  function weighted(p, weights) {
    var sum = 0, w = 0, bits = [];
    Object.keys(weights).forEach(function (k) {
      var wk = weights[k];
      var v = stat(p, k);
      sum += v * wk;
      w += wk;
      if (wk >= 0.18) bits.push({ k: LABELS[k] || k, v: v, w: wk });
    });
    bits.sort(function (a, b) { return b.w - a.w; });
    return { raw: w ? sum / w : 10, bits: bits.slice(0, 3) };
  }
  function pct(x) {
    var n = Math.round(x * 100);
    return (n > 0 ? '+' : '') + n + '%';
  }

  // forced: true 攻方必胜，false 守方必胜，null 正常比较。
  function resolve(rng, attacker, defender, atkId, defId, extras, forced) {
    var atk = ATTACK[atkId] || ATTACK.dribble;
    var def = DEFENCE[defId] || DEFENCE.mark;
    var aw = weighted(attacker, atk.weights);
    var dw = weighted(defender, def.weights);
    var support = 0;
    (extras || []).forEach(function (ex) {
      if (!ex) return;
      support += 0.22 * weighted(ex, DEFENCE.mark.weights).raw;
    });
    var aFat = fatigue(attacker);
    var dFat = fatigue(defender);
    var aSwing = (rng() * 2 - 1) * 0.15;
    var dSwing = (rng() * 2 - 1) * 0.15;
    var aScore = (aw.raw + atk.bonus) * aFat * (1 + aSwing);
    var dScore = (dw.raw + def.bonus + support) * dFat * (1 + dSwing);
    var attackWins = forced == null ? aScore > dScore : !!forced;
    return {
      attackWins: attackWins,
      aScore: aScore,
      dScore: dScore,
      view: {
        atkLabel: atk.name,
        defLabel: def.name,
        atkName: attacker.name || '',
        defName: defender.name || '',
        atkAttrs: aw.bits,
        defAttrs: dw.bits,
        swingA: pct(aSwing),
        swingD: pct(dSwing),
        fatA: aFat.toFixed(2),
        fatD: dFat.toFixed(2),
        aScore: aScore.toFixed(1),
        dScore: dScore.toFixed(1),
        support: (extras || []).length,
        result: attackWins ? atk.name + '成功' : def.name + '成功',
      },
    };
  }

  return { ATTACK: ATTACK, DEFENCE: DEFENCE, LABELS: LABELS, resolve: resolve, fatigue: fatigue };
});
