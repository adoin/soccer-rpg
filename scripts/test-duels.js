// 1 万次对抗，看平均人和弱假动作的胜率。
'use strict';
var D = require('../shared/duels');
function P(stats) { return { name: 'p', stats: stats, stamina: 100, maxStamina: 100 }; }
function rate(n, atk, def, aid, did) {
  var w = 0;
  for (var i = 0; i < n; i++) {
    var s = (i + 1) * 997 + 3;
    var rng = function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    if (D.resolve(rng, atk, def, aid, did, [], null).attackWins) w++;
  }
  return +(w / n * 100).toFixed(1);
}
var A = P({
  pace: 10, acceleration: 10, dribbling: 10, agility: 10, technique: 10,
  finishing: 10, strength: 10, composure: 10, passing: 10, vision: 10,
});
var Df = P({
  marking: 10, positioning: 10, tackling: 10, pace: 10, strength: 10,
  balance: 10, reflexes: 10, handling: 10, oneOnOne: 10, agility: 10, aggression: 10, bravery: 10,
});
var weak = P({ dribbling: 8, technique: 8, agility: 8, pace: 8 });
var good = P({ tackling: 16, pace: 15, positioning: 15, marking: 15, strength: 16, balance: 15 });
var N = 10000;
var rows = [
  ['平均突破 vs 平均卡位', rate(N, A, Df, 'dribble', 'mark')],
  ['平均突然加速 vs 平均卡位', rate(N, A, Df, 'burst', 'mark')],
  ['平均假动作 vs 平均卡位', rate(N, A, Df, 'feint', 'mark')],
  ['弱假动作 vs 好防守', rate(N, weak, good, 'feint', 'mark')],
  ['平均抽射 vs 平均门将', rate(N, A, Df, 'shot-driven', 'gk')],
  ['平均突破 vs 飞铲', rate(N, A, Df, 'dribble', 'def-flying')],
];
var fail = 0;
rows.forEach(function (r) { console.log(r[0] + '\t' + r[1] + '%'); });
if (rows[0][1] < 40 || rows[0][1] > 50) { console.log('FAIL 平均突破不在 40-50'); fail++; }
if (rows[3][1] > 20) { console.log('FAIL 弱假动作对好防守太容易'); fail++; }
if (fail) process.exit(1);
console.log('ALL DUEL RATES OK');
