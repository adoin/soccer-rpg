// 提前量传球：接球人要跑到路线上把球停住。过长的提前量不能把球送到他够不着、对方站着等的地方。
'use strict';

var E = require('../server/game/engine');
var Pass = require('../server/game/rules/pass');

function newMatch(seed) {
  var m = new E.Match('recv' + seed, { seed: seed, halfLength: 60 });
  m.destroy();
  m.phase = 'play';
  m.now = 20000;
  m.nextDecisionAt = 1e15;
  m.nextDefDecisionAt = 1e15;
  return m;
}
function setP(m, id, x, y, vx, vy) {
  var p = m.byId[id];
  p.x = x; p.y = y;
  p._px = x - (vx || 0) * 0.1;
  p._py = y - (vy || 0) * 0.1;
  p._vx = vx || 0; p._vy = vy || 0;
  p.frozenUntil = 1e15;
  return p;
}
function park(m) {
  ['a2', 'a3', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11'].forEach(function (id, i) {
    setP(m, id, 10, 4 + i * 6, 0, 0);
  });
  setP(m, 'a1', 103, 34, 0, 0);
  ['h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'h11'].forEach(function (id, i) {
    setP(m, id, 16, 6 + i * 7, 0, 0);
  });
}

function legacyLanding(passer, ax, ay) {
  var best = null, bd = 1e9;
  var dx = ax - passer.x, dy = ay - passer.y;
  var L = Math.hypot(dx, dy) || 1;
  // 旧规则：14 米内最近的人（含门将），再按上一拍速度提前 0.6 秒。够不着就原瞄准点。
  return function (match) {
    match.players.forEach(function (q) {
      if (q.team !== passer.team || q.id === passer.id || q.sentOff) return;
      var d = Math.hypot(q.x - ax, q.y - ay);
      if (d < bd) { bd = d; best = q; }
    });
    if (!best || bd > 14) return { x: ax, y: ay, target: null };
    var vx = best._px != null ? best.x - best._px : 0;
    var vy = best._py != null ? best.y - best._py : 0;
    var idealX = Math.max(2, Math.min(103, best.x + vx * 6));
    var idealY = Math.max(2, Math.min(66, best.y + vy * 6));
    var k = 0.55;
    return {
      x: ax + (idealX - ax) * k,
      y: ay + (idealY - ay) * k,
      target: best,
    };
  };
}

var CASES = [
  { name: 'low-58', height: 'low', ax: 58, rx: 48, vx: 6 },
  { name: 'low-66', height: 'low', ax: 66, rx: 48, vx: 6 },
  { name: 'low-74', height: 'low', ax: 74, rx: 48, vx: 6 },
  { name: 'mid-58', height: 'mid', ax: 58, rx: 48, vx: 4 },
  { name: 'mid-66', height: 'mid', ax: 66, rx: 48, vx: 5 },
  { name: 'mid-74', height: 'mid', ax: 74, rx: 48, vx: 5 },
  { name: 'high-66', height: 'high', ax: 66, rx: 50, vx: 3 },
  { name: 'high-74', height: 'high', ax: 74, rx: 50, vx: 3 },
  { name: 'side', height: 'mid', ax: 60, ay: 40, rx: 50, ry: 32, vx: 1, vy: 3 },
  { name: 'still', height: 'mid', ax: 64, rx: 54, vx: 0, vy: 0 },
];

function play(seed, c, legacy) {
  var m = newMatch(seed);
  park(m);
  var passer = setP(m, 'h10', 36, 34, 0, 0);
  passer.frozenUntil = 0;
  var ry = c.ry == null ? 34 : c.ry;
  var recv = setP(m, 'h9', c.rx, ry, c.vx || 0, c.vy || 0);
  recv.frozenUntil = 0;
  var ay = c.ay == null ? 34 : c.ay;
  setP(m, 'a4', c.ax - 1, ay, 0, 0);
  m.control.playerId = 'h10';
  m.control.dx = 0; m.control.dy = 0; m.control.activeStamp = 0;
  m.ball.ownerId = passer.id;
  m.ball.x = passer.x; m.ball.y = passer.y; m.ball.z = 0;
  m.ball.vx = 0; m.ball.vy = 0; m.ball.vz = 0;
  var params = Pass.validateParams({
    aimX: c.ax, aimY: ay, technique: 'inside', height: c.height,
  }, passer);
  var land = Pass.computeLanding(passer, params, 70);
  var corr = legacy
    ? legacyLanding(passer, land.x, land.y)(m)
    : Pass.correctLanding(m, passer, land.x, land.y, { flightMs: land.flightMs, height: c.height });
  var rid = corr.target && corr.target.pos !== 'GK' ? corr.target.id : recv.id;
  if (legacy && corr.target) rid = corr.target.id;
  m.startPassFlight(passer, {
    x1: corr.x, y1: corr.y, durMs: land.flightMs, height: c.height, receiverId: rid,
  });
  var minD = 1e9, grew = 0, owned = null, steps = 0, past = false;
  while (steps < 160 && m.phase !== 'whistle' && m.phase !== 'fulltime') {
    m.tick();
    steps++;
    var d = Math.hypot(recv.x - m.ball.x, recv.y - m.ball.y);
    if (d < minD - 0.05) { minD = d; grew = 0; }
    else grew = Math.max(grew, d - minD);
    if (m.ball.ownerId) { owned = m.ball.ownerId; break; }
    var spd = Math.hypot(m.ball.vx || 0, m.ball.vy || 0);
    if (minD < 2.4 && grew > 2.2 && spd > 1.2 && !m.ball.ownerId) past = true;
  }
  if (owned !== 'h9') past = true;
  m.destroy();
  return {
    completed: owned === 'h9',
    ranPast: owned !== 'h9' && past,
    owner: owned,
    lead: +corr.x.toFixed(1),
    target: corr.target ? corr.target.id : null,
  };
}

function tally(legacy) {
  var n = 0, done = 0, past = 0;
  var lines = [];
  CASES.forEach(function (c) {
    var cd = 0, cp = 0, lead = 0;
    for (var s = 0; s < 4; s++) {
      var r = play(n * 17 + s + 3, c, legacy);
      n++;
      lead = r.lead;
      if (r.completed) { done++; cd++; }
      if (r.ranPast) { past++; cp++; }
    }
    lines.push(c.name + '  完成 ' + cd + '/4  漏过 ' + cp + '  落点x ' + lead);
  });
  return { n: n, done: done, past: past, lines: lines };
}

var before = tally(true);
var after = tally(false);
console.log('BEFORE');
console.log(before.lines.join('\n'));
console.log('完成 ' + before.done + '/' + before.n + ' (' + (100 * before.done / before.n).toFixed(1) + '%)  漏过 ' + before.past);
console.log('AFTER');
console.log(after.lines.join('\n'));
console.log('完成 ' + after.done + '/' + after.n + ' (' + (100 * after.done / after.n).toFixed(1) + '%)  漏过 ' + after.past);
if (after.done < after.n * 0.8) {
  console.log('FAIL 完成率太低');
  process.exit(1);
}
if (after.past > 0) {
  console.log('FAIL 还有漏过');
  process.exit(1);
}
console.log('PASS 接球提前量');
