// server/rng.js
// 确定性随机数发生器（mulberry32）。
// 所有判定掷骰都在服务器用该 RNG 完成，客户端无法预测或篡改结果——这是防作弊的关键。
'use strict';

function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { mulberry32: mulberry32 };
