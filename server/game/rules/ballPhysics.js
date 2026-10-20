// server/game/rules/ballPhysics.js
// ============================================================
// 三维球：高度 z、垂直速度 vz、重力、地面回弹、滚动摩擦，可选旋转。
//
// 飞行中的传球/射门仍走 intercept.js 的抛物线进度（拦截包络要和
// 高度档对齐）。球第一次落地之后，以及任意自由球，改由本模块积分：
//   · 离地：z、vz 受重力 g=9.81；
//   · 触地：vz 反向乘以场地回弹系数，水平速度乘以触地抓地；
//   · 回弹高度一跳比一跳低，直到 vz 小到改为滚动；
//   · 滚动：指数摩擦减速，不再瞬停；
//   · spin（-1..1，可选）：滚动时侧向拐、触地时略改回弹。
// 头球 / 胸部停球只在对应高度带里成立，见 controlBand。
// ============================================================
'use strict';

var G = 9.81;

var SURFACES = {
  grass: { restitution: 0.55, rollMu: 1.6, bounceGrip: 0.82 },
  wet:   { restitution: 0.38, rollMu: 2.1, bounceGrip: 0.70 },
};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function surfaceOf(name) {
  return SURFACES[name] || SURFACES.grass;
}

// 这个高度谁能用身体哪个部位处理。够不着返回 null。
// 脚 <0.65m；胸 0.65–1.45m；头 1.45–2.55m（门将可到 3.3m）。
function controlBand(z, isGK) {
  z = z || 0;
  if (z < 0.65) return 'foot';
  if (z < 1.45) return 'chest';
  if (z <= (isGK ? 3.3 : 2.55)) return 'header';
  return null;
}

// 滚动解析解：v(t)=v0*e^{-μt}，位移 = v0*(1-e^{-μt})/μ。供跑位提前量用。
function rollPosition(x, y, vx, vy, t, mu) {
  vx = vx || 0; vy = vy || 0;
  mu = mu == null ? SURFACES.grass.rollMu : mu;
  t = Math.max(0, t);
  if (mu < 1e-6) return { x: x + vx * t, y: y + vy * t, vx: vx, vy: vy };
  var decay = Math.exp(-mu * t);
  var k = (1 - decay) / mu;
  return { x: x + vx * k, y: y + vy * k, vx: vx * decay, vy: vy * decay };
}

function stepOnce(ball, h, s) {
  ball.vx = +ball.vx || 0;
  ball.vy = +ball.vy || 0;
  ball.vz = +ball.vz || 0;
  ball.z = +ball.z || 0;
  ball.x = +ball.x || 0;
  ball.y = +ball.y || 0;
  var grounded = ball.z <= 0.02 && Math.abs(ball.vz) < 0.9;
  if (grounded) {
    ball.z = 0;
    ball.vz = 0;
    var sp0 = Math.hypot(ball.vx, ball.vy);
    if (ball.spin && sp0 > 0.4) {
      var nx = -ball.vy / sp0, ny = ball.vx / sp0;
      ball.vx += nx * ball.spin * 1.1 * h;
      ball.vy += ny * ball.spin * 1.1 * h;
    }
    var fr = Math.max(0, 1 - s.rollMu * h);
    ball.vx *= fr;
    ball.vy *= fr;
    ball.x += ball.vx * h;
    ball.y += ball.vy * h;
    if (Math.hypot(ball.vx, ball.vy) < 0.25) { ball.vx = 0; ball.vy = 0; }
    return 0;
  }
  ball.x += ball.vx * h;
  ball.y += ball.vy * h;
  var vz = ball.vz - G * h;
  var z = ball.z + ball.vz * h - 0.5 * G * h * h;
  var bounces = 0;
  if (z <= 0 && vz < 0) {
    var rest = s.restitution;
    if (ball.spin) rest = clamp(rest - ball.spin * 0.04, 0.18, 0.75);
    vz = -vz * rest;
    ball.vx *= s.bounceGrip;
    ball.vy *= s.bounceGrip;
    z = 0;
    bounces = 1;
    if (vz < 0.9) vz = 0;
  }
  if (z < 0) z = 0;
  ball.z = z;
  ball.vz = vz;
  return bounces;
}

// 推进 dt 秒。内部按 0.02s 切片，避免 100ms tick 穿透地面。
function step(ball, dt, surfaceName) {
  var s = surfaceOf(surfaceName);
  dt = Math.max(0, dt || 0);
  var n = Math.max(1, Math.ceil(dt / 0.02));
  var h = dt / n;
  var bounces = 0;
  for (var i = 0; i < n; i++) bounces += stepOnce(ball, h, s);
  return { bounces: bounces, grounded: (ball.z || 0) <= 0.02 && Math.abs(ball.vz || 0) < 0.9 };
}

module.exports = {
  G: G,
  SURFACES: SURFACES,
  controlBand: controlBand,
  rollPosition: rollPosition,
  step: step,
};
