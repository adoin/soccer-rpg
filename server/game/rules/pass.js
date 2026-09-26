// server/game/rules/pass.js
// ============================================================
// 多阶段传球规则（纯函数，确定性部分；实际落点散布由引擎掷骰）。
//
// 流程：长传/短传 → 方向（8向） → 脚法（内脚背/脚面/外脚背，按 technique 能力解锁）
//       → 高度（低/中/高/超高） → 力量条（任意力量） → 预估落点 → 确认。
//
// 数值影响：
//   · 落点散布半径由传球能力（passing/vision/technique 聚合）决定；
//   · 脚法修正散布（内脚背最稳、外脚背带弧线但更飘）；
//   · 高度影响飞行时间与被拦截风险；
//   · 实际落点掷骰后，再按 technique/firstTouch 向最近队友的理想接球点修正。
// ============================================================
'use strict';

var FM = require('../../../shared/fm');

var FIELD_W = 105, FIELD_H = 68;

// 8 向（field 坐标：x 向右（对方球门），y 向上；与客户端 project()/手柄一致）。0=→，逆时针。
var DIRS = [
  { dx: 1, dy: 0 },
  { dx: 0.7071, dy: 0.7071 },
  { dx: 0, dy: 1 },
  { dx: -0.7071, dy: 0.7071 },
  { dx: -1, dy: 0 },
  { dx: -0.7071, dy: -0.7071 },
  { dx: 0, dy: -1 },
  { dx: 0.7071, dy: -0.7071 },
];
var DIR_NAMES = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];

var TECHNIQUES = {
  inside:  { name: '内脚背', scatterMul: 0.8,  curve: 0,   minTec: 1,  desc: '最稳，不带弧线' },
  instep:  { name: '脚面',   scatterMul: 1.0,  curve: 0,   minTec: 8,  desc: '标准，大力远传' },
  outside: { name: '外脚背', scatterMul: 1.15, curve: 3.2, minTec: 13, desc: '带弧线，更飘' },
};

var HEIGHTS = {
  low:   { name: '低',   flightMs: 450,  scatterMul: 0.9,  rateAdj: -5, desc: '贴地，易被断' },
  mid:   { name: '中',   flightMs: 650,  scatterMul: 1.0,  rateAdj: 0,  desc: '标准' },
  high:  { name: '高',   flightMs: 950,  scatterMul: 1.1,  rateAdj: 2,  desc: '越过防守' },
  vhigh: { name: '超高', flightMs: 1300, scatterMul: 1.25, rateAdj: -2, desc: '很飘，难控制' },
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 球员 technique（1-20 原始值）
function rawTechnique(p) {
  var s = p.stats || {};
  return s.technique == null ? 10 : s.technique;
}

// 该球员可用的脚法（按能力解锁）
function availableTechniques(p) {
  var t = rawTechnique(p);
  return Object.keys(TECHNIQUES).map(function (id) {
    var def = TECHNIQUES[id];
    return {
      id: id, name: def.name, desc: def.desc,
      enabled: t >= def.minTec,
      reason: t >= def.minTec ? '' : 'technique ' + t + ' < ' + def.minTec,
    };
  });
}

// 清洗客户端传来的 params（防作弊：全部钳制到合法范围）
function validateParams(raw, p) {
  raw = raw || {};
  var kinds = { long: 1, short: 1 };
  var kind = kinds[raw.kind] ? raw.kind : 'short';
  var dir = clamp(Math.round(+raw.dir) || 0, 0, 7);
  var techs = availableTechniques(p);
  var technique = 'inside';
  techs.forEach(function (t) { if (t.id === raw.technique && t.enabled) technique = t.id; });
  var heights = { low: 1, mid: 1, high: 1, vhigh: 1 };
  var height = heights[raw.height] ? raw.height : 'mid';
  var power = clamp(Math.round(+raw.power) || 50, 5, 100);
  return { kind: kind, dir: dir, technique: technique, height: height, power: power };
}

// AI / 默认：朝最佳接应队友传球，自动生成 params
function autoParams(match, p) {
  var target = match.bestPassTarget(p);
  var dx = target.x - p.x, dy = target.y - p.y;
  var dist = Math.sqrt(dx * dx + dy * dy) || 1;
  // 选最接近目标方向的 8 向
  var ang = Math.atan2(dy, dx);
  var dir = Math.round(ang / (Math.PI / 4));
  dir = ((dir % 8) + 8) % 8;
  var kind = dist > 26 ? 'long' : 'short';
  var power = kind === 'long'
    ? clamp(Math.round((dist - 12) / 48 * 100), 5, 100)
    : clamp(Math.round((dist - 6) / 22 * 100), 5, 100);
  var techs = availableTechniques(p);
  var technique = 'inside';
  for (var i = techs.length - 1; i >= 0; i--) {
    if (techs[i].enabled) { technique = techs[i].id; break; }
  }
  return { kind: kind, dir: dir, technique: technique, height: 'mid', power: power };
}

// 预估落点（确定性）：给客户端画预估圈用。返回 { x, y, r, flightMs, dist }
function computeLanding(passer, params, passAb) {
  var d = DIRS[params.dir];
  var dist = params.kind === 'long'
    ? 12 + (params.power / 100) * 48
    : 6 + (params.power / 100) * 22;
  var x = passer.x + d.dx * dist;
  var y = passer.y + d.dy * dist;
  var tech = TECHNIQUES[params.technique];
  var h = HEIGHTS[params.height];
  // 外脚背弧线：落点向垂直方向偏
  if (tech.curve) {
    x += -d.dy * tech.curve * (params.power / 100);
    y += d.dx * tech.curve * (params.power / 100);
  }
  x = clamp(x, 2, FIELD_W - 2);
  y = clamp(y, 2, FIELD_H - 2);
  var baseR = params.kind === 'long' ? 2.5 + 5 * (1 - passAb / 100) : 1.2 + 2.5 * (1 - passAb / 100);
  var r = baseR * tech.scatterMul * h.scatterMul;
  return { x: x, y: y, r: r, flightMs: h.flightMs, dist: dist, rateAdj: h.rateAdj };
}

// 传球成功率（0-100），供引擎掷骰
function passRate(passer, params, land, nearestOppDist) {
  var ab = FM.pass(passer); // 0-100 量级
  var rate = 78 + (ab - 60) * 0.5 - land.dist * 0.35 + land.rateAdj;
  if (params.technique === 'inside') rate += 3;
  if (nearestOppDist < 3) rate -= 12;
  else if (nearestOppDist < 6) rate -= 6;
  return clamp(rate, 5, 97);
}

// 球感修正：实际落点向最近队友的理想接球点靠拢。
// 返回 { x, y, target }（target 可能为 null）
function correctLanding(match, passer, ax, ay) {
  var best = null, bd = 1e9;
  match.players.forEach(function (q) {
    if (q.team !== passer.team || q.id === passer.id || q.sentOff) return;
    var d = Math.sqrt(Math.pow(q.x - ax, 2) + Math.pow(q.y - ay, 2));
    if (d < bd) { bd = d; best = q; }
  });
  if (!best || bd > 14) return { x: ax, y: ay, target: null };
  var s = passer.stats || {};
  var touch = (s.firstTouch == null ? 10 : s.firstTouch);
  var k = 0.35 + 0.45 * (rawTechnique(passer) / 20) * (0.6 + 0.4 * touch / 20);
  k = clamp(k, 0, 0.85);
  return {
    x: ax + (best.x - ax) * k,
    y: ay + (best.y - ay) * k,
    target: best,
  };
}

module.exports = {
  DIRS: DIRS,
  DIR_NAMES: DIR_NAMES,
  TECHNIQUES: TECHNIQUES,
  HEIGHTS: HEIGHTS,
  rawTechnique: rawTechnique,
  availableTechniques: availableTechniques,
  validateParams: validateParams,
  autoParams: autoParams,
  computeLanding: computeLanding,
  passRate: passRate,
  correctLanding: correctLanding,
};
