// shared/moves.js
// 突破动作和防守技能。突破在没人贴身时只是加速，不播过人分镜。
// 防守技能按距离、力量和犯规风险分开，横扫在被过掉之后仍能出脚。
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SharedMoves = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CHALLENGE_RANGE = 3.5;

  var BURST = { id: 'burst', name: '突然加速', cost: 3, power: 6 };
  var FEINT = { id: 'feint', name: '假动作', cost: 4, power: 12 };

  var DEF_SKILLS = {
    flying: {
      id: 'def-flying', name: '离地飞铲', cost: 8, reach: 8, power: 14,
      foul: 0.40, cardBias: 18, reckless: true, speedHigh: true,
      cut: 'def-skill-flying-tackle', worksWhenBeaten: false,
    },
    sweep: {
      id: 'def-sweep', name: '横扫千军', cost: 7, reach: 5.5, power: 13,
      foul: 0.22, cardBias: 8, speedHigh: true,
      cut: 'def-skill-sweep', worksWhenBeaten: true,
    },
    shoulder: {
      id: 'def-shoulder', name: '铁山靠', cost: 6, reach: 2.4, power: 11,
      foul: 0.16, cardBias: 6, strength: true,
      cut: 'def-skill-shoulder', worksWhenBeaten: false,
    },
    elbow: {
      id: 'def-elbow', name: '铁索拦江', cost: 6, reach: 2.6, power: 14,
      foul: 0.48, cardBias: 20, reckless: true,
      cut: 'def-skill-elbow', worksWhenBeaten: false,
    },
  };

  function attackMoves(player) {
    var list = [BURST];
    var known = (player && player.moves) || [];
    if (known.indexOf('feint') >= 0) list.push(FEINT);
    return list;
  }

  function defSkillsOf(player) {
    var ids = (player && player.defSkills) || [];
    var out = [];
    ids.forEach(function (id) {
      if (DEF_SKILLS[id]) out.push(DEF_SKILLS[id]);
    });
    return out;
  }

  return {
    CHALLENGE_RANGE: CHALLENGE_RANGE,
    BURST: BURST,
    FEINT: FEINT,
    DEF_SKILLS: DEF_SKILLS,
    attackMoves: attackMoves,
    defSkillsOf: defSkillsOf,
  };
});
