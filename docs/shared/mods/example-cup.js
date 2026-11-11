// 示例 mod：一场小型杯赛插进第 3 轮，并推迟当天涉及这两队的联赛。
// 另外按年龄做一点点成长和衰退，赛季末补一名青训。
(function (root, factory) {
  var Career = (typeof module !== 'undefined' && module.exports) ? require('../career') : root.Career;
  var mod = factory(Career);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.SoccerModExampleCup = mod;
})(typeof self !== 'undefined' ? self : this, function (Career) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  var mod = {
    id: 'example-cup',
    name: '示例杯赛与年龄曲线',
    hooks: {
      schedule: function (ctx) {
        var save = ctx.save;
        if (!save || !save.calendar || !save.clubId) return;
        var opp = null;
        (save.teams || []).forEach(function (t) {
          if (!opp && t.id !== save.clubId) opp = t.id;
        });
        if (!opp) return;
        Career.insertAndPostpone(save.calendar, {
          competitionId: 'example-cup',
          round: 1,
          homeId: save.clubId,
          awayId: opp,
          date: 2,
          leagueId: 'amateur-league',
        });
      },
      growPlayers: function (ctx) {
        (ctx.players || []).forEach(function (p) {
          if (!p.stats) return;
          if (ctx.when === 'match') {
            if (p.age >= 33 && p.stats.pace > 3) p.stats.pace -= 1;
            else if (p.age <= 21 && p.stats.passing < 8) p.stats.passing += 1;
          }
        });
      },
      youthIntake: function (ctx) {
        var save = ctx.save;
        if (!save || !save.squad || save.squad.length >= Career.MAX_SQUAD) return;
        var p = {
          id: 'youth-' + save.season + '-' + save.squad.length,
          name: '青训小将',
          age: 17,
          pos: 'MF',
          youth: true,
          clubId: save.clubId,
          level: 1,
          fee: 0,
          wage: 20,
          stats: { pace: 6, acceleration: 6, passing: 5, finishing: 4, tackling: 4, dribbling: 5, stamina: 6, technique: 5, decisions: 4, composure: 4, reflexes: 3, handling: 3 },
        };
        save.squad.push(p);
      },
    },
  };

  if (Career && Career.registerMod) Career.registerMod(mod);
  return mod;
});
