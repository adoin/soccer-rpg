// server/game/rules/intercept.js
// ============================================================
// 实时拦截判定（2026-09-28，用户纠正）：
//   传球/射门不再开球瞬间掷骰定结果，改为飞行途中按 tick 实时判定。
//   判定依据：
//     1. 是否在线路上 —— 球本 tick 走过的线段（swept-segment，防高速隧道穿透）
//        与防守队员的横向距离；
//     2. 球的实际高度 —— z(k) = 4*peak*k*(1-k) 抛物线，peak 按高度档给：
//          低 0.4m / 中 2.2m / 高 5.5m / 超高 11m；
//        z<1.0m 地面可断（伸脚 1.6m）；1.0–2.6m 空中可争（起跳/头球 1.1m，
//        门将 3.4m）；再高够不着 —— 超高球中段在 5~11 米高空，无人能拦截，
//        只有初段（球未起）和末段（球落下）能断；
//     3. 球速 —— 球越快越难干净断下；
//     4. 防守能力 —— 断/弹开/扑空按 tackling+anticipation+positioning 掷骰。
//   当面（0.8m 内、球贴地）传球：必断或弹开，不存在"从容穿过"。
// ============================================================
'use strict';

var FM = require('../../../shared/fm');

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// 各高度档的抛物线顶点高度（米）
var PEAK = { low: 0.4, mid: 2.2, high: 5.5, vhigh: 11 };

// 抛物线高度：k=0..1 为飞行进度
function heightAt(peak, k) {
  if (k <= 0 || k >= 1) return 0;
  return 4 * peak * k * (1 - k);
}

// 点到线段的 2D 距离，返回 {d, t}（t 为最近点在线段上的参数 0..1）
function segDist(px, py, x0, y0, x1, y1) {
  var dx = x1 - x0, dy = y1 - y0;
  var len2 = dx * dx + dy * dy;
  var t = 0;
  if (len2 > 1e-9) t = clamp(((px - x0) * dx + (py - y0) * dy) / len2, 0, 1);
  var cx = x0 + dx * t, cy = y0 + dy * t;
  var ddx = px - cx, ddy = py - cy;
  return { d: Math.sqrt(ddx * ddx + ddy * ddy), t: t };
}

// 拦截包络：球在高度 z 时可拦截的横向半径；够不着返回 null
function envelope(z, isGK) {
  var headH = isGK ? 3.4 : 2.6;
  if (z < 1.0) return { radius: 1.6, aerial: false };
  if (z < headH) return { radius: 1.1, aerial: true };
  return null;
}

function staminaFactor(p) {
  var s = p.stamina == null ? 100 : p.stamina, m = p.maxStamina || 100;
  return 0.75 + 0.25 * clamp(s / m, 0, 1);
}

// 防守拦截能力（0-100）：tackling + anticipation + positioning
function defendAb(p) {
  var ab = (FM.v(p, 'tackling') + FM.v(p, 'anticipation') + FM.v(p, 'positioning')) / 3;
  return ab * staminaFactor(p);
}

// 每 tick 检查一次。
//   flight: {px,py（上 tick 球位）, x,y（本 tick 球位）,
//            k0,k1（起止飞行进度）, peak, team（进攻方）,
//            passerId, receiverId（跳过）}
//   match 需提供 players / now / rng。
// 返回最佳拦截者 {player, d, z, aerial, k}，无则 null。
function checkInterception(match, flight) {
  var best = null, bestScore = 1e9;
  for (var i = 0; i < match.players.length; i++) {
    var q = match.players[i];
    if (q.team === flight.team || q.sentOff) continue;
    if (q.id === flight.passerId || q.id === flight.receiverId) continue;
    if (match.now < q.frozenUntil || match.now < q.beatenUntil) continue; // 僵直/踉跄中够不着
    var sd = segDist(q.x, q.y, flight.px, flight.py, flight.x, flight.y);
    var k = flight.k0 + sd.t * (flight.k1 - flight.k0);
    var z = heightAt(flight.peak, k);
    var env = envelope(z, q.pos === 'GK');
    if (!env || sd.d > env.radius) continue;
    var score = sd.d + (env.aerial ? 0.4 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { player: q, d: sd.d, z: z, aerial: env.aerial, k: k };
    }
  }
  return best;
}

// 拦截对决 → 'clean'（干净断下）/ 'deflect'（弹开成自由球）/ 'miss'（扑空踉跄）
//   ballSpeed: 米/秒；kind: 'pass' | 'shot'
//   当面球绝不穿模：传球慢(d<0.8 贴地)→一定停下；射门快(27m/s)→贴身(d<0.5)一定碰到但多为弹开
function resolveContest(match, hit, ballSpeed, kind) {
  var def = hit.player;
  var defAb = defendAb(def);
  if (hit.aerial) defAb = (defAb + FM.v(def, 'jumping') * 5) / 2; // 空中看弹跳
  var dsp = Math.sqrt((def._vx || 0) * (def._vx || 0) + (def._vy || 0) * (def._vy || 0));
  var setBonus = dsp < 3 ? 8 : 0;                    // 站住位置的更好断
  var pbLimit = kind === 'shot' ? 0.5 : 0.8;
  var pointBlank = hit.d < pbLimit && hit.z < 1.0;   // 当面贴地球
  var closeBonus = pointBlank ? 30 : 0;
  var pClean = 52 + (defAb - 55) * 1.1 - ballSpeed * 1.1
             - (hit.aerial ? 12 : 0) + setBonus + closeBonus;
  if (kind === 'shot' && pointBlank) pClean -= 25;   // 27m/s 的球很难"干净抱住"，多为弹开
  pClean = clamp(pClean, 5, 97);
  var pDefl = clamp(26 - defAb * 0.15, 8, 26);       // 能力差的容易只蹭到
  var r = match.rng() * 100;
  if (r < pClean) return 'clean';
  if (r < pClean + pDefl) return 'deflect';
  return pointBlank ? 'deflect' : 'miss'; // 当面球：最差也是弹开，不存在从容穿过
}

module.exports = {
  PEAK: PEAK,
  heightAt: heightAt,
  segDist: segDist,
  envelope: envelope,
  defendAb: defendAb,
  checkInterception: checkInterception,
  resolveContest: resolveContest,
};
