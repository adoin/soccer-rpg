// shared/fm.js
// FM 式属性（1-20）→ 对决能力值（约 40~85 量级）的聚合层。
// 球员 stats 里存的是细粒度 FM 属性；引擎/规则层做数值博弈时用这里的聚合值，
// 公式量级与旧体系兼容（1-20 × 5 ≈ 旧 40~85 区间）。
'use strict';

function v(p, key) {
  var s = p.stats || {};
  var x = s[key];
  return (x == null ? 10 : x) * 5;
}
function avg(p, keys) {
  var s = 0;
  for (var i = 0; i < keys.length; i++) s += v(p, keys[i]);
  return s / keys.length;
}

module.exports = {
  v: v,
  avg: avg,
  // 绝对速度（跑动、追击、回追）
  speed:   function (p) { return avg(p, ['pace', 'acceleration']); },
  // 盘带突破
  dribble: function (p) { return avg(p, ['dribbling', 'technique', 'agility']); },
  // 传球组织
  pass:    function (p) { return avg(p, ['passing', 'vision', 'technique']); },
  // 射门终结
  shoot:   function (p) { return avg(p, ['finishing', 'longShots', 'composure']); },
  // 防守（抢断/盯人/站位）
  defend:  function (p) { return avg(p, ['tackling', 'marking', 'positioning']); },
  // 守门（仅门将）
  keep:    function (p) { return avg(p, ['reflexes', 'handling', 'positioning', 'oneOnOne']); },
  // 大心脏（点球/关键球）
  nerve:   function (p) { return avg(p, ['composure', 'determination']); },
  // 侵略性（抢断尺度/犯规倾向）
  aggr:    function (p) { return avg(p, ['aggression', 'bravery']); },
  // 球商
  iq:      function (p) { return avg(p, ['decisions', 'vision']); },
  // 进攻反越位（跑位时机）
  antiAtt: function (p) { return avg(p, ['anticipation', 'offBall']); },
  // 防守协同（保持平行线/造越位）
  antiDef: function (p) { return avg(p, ['anticipation', 'positioning', 'decisions']); },
  // 体能属性（跑动能力上限相关）
  stamina: function (p) { return v(p, 'stamina'); },
};
