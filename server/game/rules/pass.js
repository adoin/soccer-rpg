// server/game/rules/pass.js
// ============================================================
// 多阶段传球规则（纯函数，确定性部分；实际落点散布由引擎掷骰）。
//
// 流程：落点选择（场上自由光标，方向键/点击/拖拽精细移动）
//       → 脚法（内脚背/脚面/外脚背，按 technique 能力解锁）
//       → 高度（低/中/高/超高） → 预估落点 → 确认。
//
// 天使之翼式：落点光标同时决定方向与力量（传球者→落点的向量），
// 不再有点数式的 8 向罗盘和力量条。
// 输入与能力分开：玩家输入的是"我想传到哪"（精确意图），
// 球员能力只决定两件事——
//   · 实际落点散布半径（传球/视野/技术聚合，距离越远越飘）；
//   · 脚法修正散布（内脚背最稳、外脚背带弧线但更飘）。
// 实际落点掷骰后，再按 technique/firstTouch 向最近队友的理想接球点修正。
// ============================================================
'use strict';

var FM = require('../../../shared/fm');

var FIELD_W = 105, FIELD_H = 68;

// 落点距离范围（米）：统一 4~60，远近即力量；能力只影响散布，不锁距离
var AIM_MIN = 4, AIM_MAX = 60;

var TECHNIQUES = {
  inside:  { name: '内脚背', scatterMul: 0.8,  curve: 0,   minTec: 1,  desc: '最稳，不带弧线' },
  instep:  { name: '脚面',   scatterMul: 1.0,  curve: 0,   minTec: 8,  desc: '标准，大力远传' },
  outside: { name: '外脚背', scatterMul: 1.15, curve: 3.2, minTec: 13, desc: '带弧线，更飘' },
};

var HEIGHTS = {
  low:   { name: '低',   flightMs: 450,  scatterMul: 0.9,  rateAdj: -5, peak: 0.4,  desc: '贴地，易被断' },
  mid:   { name: '中',   flightMs: 650,  scatterMul: 1.0,  rateAdj: 0,  peak: 2.2,  desc: '标准' },
  high:  { name: '高',   flightMs: 950,  scatterMul: 1.1,  rateAdj: 2,  peak: 5.5,  desc: '越过防守' },
  vhigh: { name: '超高', flightMs: 1300, scatterMul: 1.25, rateAdj: -2, peak: 11,   desc: '很飘，难控制' },
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

// 清洗客户端传来的 params（防作弊：落点钳制到场内 + 合法距离范围）
function validateParams(raw, p) {
  raw = raw || {};
  var ax = clamp(+raw.aimX || p.x, 2, FIELD_W - 2);
  var ay = clamp(+raw.aimY || p.y, 2, FIELD_H - 2);
  var dx = ax - p.x, dy = ay - p.y;
  var dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > AIM_MAX) {
    ax = p.x + dx / dist * AIM_MAX; ay = p.y + dy / dist * AIM_MAX; dist = AIM_MAX;
  } else if (dist < AIM_MIN) {
    if (dist < 0.001) { ax = p.x + AIM_MIN; ay = p.y; }
    else { ax = p.x + dx / dist * AIM_MIN; ay = p.y + dy / dist * AIM_MIN; }
    dist = AIM_MIN;
  }
  var techs = availableTechniques(p);
  var technique = 'inside';
  techs.forEach(function (t) { if (t.id === raw.technique && t.enabled) technique = t.id; });
  var heights = { low: 1, mid: 1, high: 1, vhigh: 1 };
  var height = heights[raw.height] ? raw.height : 'mid';
  return { aimX: ax, aimY: ay, technique: technique, height: height };
}

// 由落点向量导出的力量（0-100，供显示与成功率用）：距离即力量
function aimPower(p, params) {
  var dx = params.aimX - p.x, dy = params.aimY - p.y;
  var dist = Math.sqrt(dx * dx + dy * dy);
  return clamp(Math.round((dist - AIM_MIN) / (AIM_MAX - AIM_MIN) * 100), 0, 100);
}

// AI / 默认：朝最佳接应队友传球，瞄准其当前位置（correctLanding 会再做移动提前量）。
//   若 mid 高度走廊被防守队员封死，改用高球越过，而不是一头撞进拦截网。
function autoParams(match, p) {
  var target = match.bestPassTarget(p);
  var techs = availableTechniques(p);
  var technique = 'inside';
  for (var i = techs.length - 1; i >= 0; i--) {
    if (techs[i].enabled) { technique = techs[i].id; break; }
  }
  var height = 'mid';
  if (corridorBlocked(match, p, target, HEIGHTS.mid) > 0) height = 'high';
  return { aimX: target.x, aimY: target.y, technique: technique, height: height };
}

// 静态走廊检查：按给定高度档，传球线段上有多少对方球员处在可拦截包络内。
// 用于 AI 选高度、菜单成功率预估（确定性，不掷骰）。
function corridorBlocked(match, passer, target, hDef) {
  var peak = hDef.peak;
  var n = 0;
  for (var i = 0; i < match.players.length; i++) {
    var q = match.players[i];
    if (q.team === passer.team || q.sentOff || q.id === passer.id) continue;
    var sd = segDistTo(q.x, q.y, passer.x, passer.y, target.x, target.y);
    if (sd.d > 2.0) continue;
    var z = 4 * peak * sd.t * (1 - sd.t);
    if (z < (q.pos === 'GK' ? 3.4 : 2.6)) n++;
  }
  return n;
}

function segDistTo(px, py, x0, y0, x1, y1) {
  var dx = x1 - x0, dy = y1 - y0;
  var len2 = dx * dx + dy * dy, t = 0;
  if (len2 > 1e-9) t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  var cx = x0 + dx * t, cy = y0 + dy * t;
  var ddx = px - cx, ddy = py - cy;
  return { d: Math.sqrt(ddx * ddx + ddy * ddy), t: t };
}

// 线路成功率预估（菜单显示用，确定性）：
//   走廊内可拦截的对方球员越多、贴身压迫越近，成功率越低。
//   这是"线路危险度"的诚实估计，不再是开球掷骰的伪成功率。
function laneRate(match, passer, params, land) {
  var hDef = HEIGHTS[params.height] || HEIGHTS.mid;
  var n = corridorBlocked(match, passer, { x: land.x, y: land.y }, hDef);
  var nearD = 99;
  for (var i = 0; i < match.players.length; i++) {
    var q = match.players[i];
    if (q.team === passer.team || q.sentOff) continue;
    var d = Math.sqrt((q.x - passer.x) * (q.x - passer.x) + (q.y - passer.y) * (q.y - passer.y));
    if (d < nearD) nearD = d;
  }
  var rate = 90 - n * 15 - (nearD < 3 ? 12 : 0);
  return Math.max(5, Math.min(97, rate));
}

// 预估落点（确定性）：给客户端画预估圈用。返回 { x, y, r, flightMs, dist }
function computeLanding(passer, params, passAb) {
  var x = params.aimX, y = params.aimY;
  var dx = x - passer.x, dy = y - passer.y;
  var dist = Math.sqrt(dx * dx + dy * dy) || 1;
  var tech = TECHNIQUES[params.technique];
  var h = HEIGHTS[params.height];
  // 外脚背弧线：落点向传球方向的垂直方向偏，距离越远偏得越多
  if (tech.curve) {
    var k = tech.curve * clamp(dist / 48, 0, 1);
    x += -dy / dist * k;
    y += dx / dist * k;
  }
  x = clamp(x, 2, FIELD_W - 2);
  y = clamp(y, 2, FIELD_H - 2);
  // 散布：距离越远越飘；能力越高圈越小（与输入分开，纯能力项）
  var baseR = (1.2 + dist * 0.09) * (1.5 - passAb / 100);
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
  // ★ 理想接球点：按接应队员的移动方向做提前量（lead），而不是他的当前位置。
  //   _px/_py 是上一 tick 位置（tick=100ms），提前 0.6 秒（6 tick），钳制在场内。
  var vx = (best._px != null ? best.x - best._px : 0);
  var vy = (best._py != null ? best.y - best._py : 0);
  var idealX = clamp(best.x + vx * 6, 2, FIELD_W - 2);
  var idealY = clamp(best.y + vy * 6, 2, FIELD_H - 2);
  return {
    x: ax + (idealX - ax) * k,
    y: ay + (idealY - ay) * k,
    target: best,
  };
}

module.exports = {
  AIM_MIN: AIM_MIN,
  AIM_MAX: AIM_MAX,
  TECHNIQUES: TECHNIQUES,
  HEIGHTS: HEIGHTS,
  rawTechnique: rawTechnique,
  availableTechniques: availableTechniques,
  validateParams: validateParams,
  aimPower: aimPower,
  autoParams: autoParams,
  computeLanding: computeLanding,
  passRate: passRate,
  laneRate: laneRate,           // ★ 线路成功率预估（菜单显示，确定性）
  corridorBlocked: corridorBlocked,
  correctLanding: correctLanding,
};
