// 球权变化后 5 秒（50 个比赛 tick）的间距。
// 只统计连续进行中的公开比赛，定位球和哨声不计入。
'use strict';

var E = require('../server/game/engine');
var Behavior = require('../server/game/rules/behavior');

function ownerTeam(m) {
  var id = m.ball.ownerId;
  if (!id || !m.byId[id]) return null;
  return m.byId[id].team;
}
function hypot(ax, ay, bx, by) {
  var dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}
function pickCommand(m) {
  var d = m.decision;
  if (!d) return;
  if (d.kind === 'gk-distribute') {
    try { m.applyCommand(d.playerId, 'gk-punt'); } catch (e) { m.phase = 'play'; m.decision = null; }
    return;
  }
  if (d.kind === 'qte') {
    try { m.strikePenalty(m.byId[d.playerId], { mark: 0.5 }); } catch (e) {}
    if (m.phase === 'decision') { m.phase = 'play'; m.decision = null; }
    return;
  }
  var leaf = null;
  function consider(o) {
    if (!o || !o.enabled || leaf) return;
    if (o.moves || o.skills || o.shots) {
      (o.moves || []).forEach(consider);
      (o.skills || []).forEach(consider);
      (o.shots || []).forEach(consider);
      return;
    }
    leaf = o;
  }
  (d.options || []).forEach(consider);
  if (!leaf) {
    m.phase = 'play';
    m.decision = null;
    m.nextDecisionAt = m.now + 1500;
    return;
  }
  var params = null;
  var p = m.byId[d.playerId];
  if (p && (leaf.id === 'pass' || d.kind === 'setpiece')) {
    params = {
      aimX: p.x + (p.team === 'home' ? 16 : -16),
      aimY: p.y,
      technique: 'inside',
      height: 'mid',
    };
  }
  try { m.applyCommand(d.playerId, leaf.id, params); }
  catch (e) { m.phase = 'play'; m.decision = null; }
}

function sample(m) {
  var ball = m.ball;
  var nearH = 0, nearA = 0;
  m.players.forEach(function (p) {
    if (p.sentOff) return;
    if (hypot(p.x, p.y, ball.x, ball.y) <= 15) {
      if (p.team === 'home') nearH++; else nearA++;
    }
  });
  var homeA = Behavior.blockTargets(m, 'home');
  var awayA = Behavior.blockTargets(m, 'away');
  var dev = 0, n = 0;
  m.players.forEach(function (p) {
    if (p.sentOff || p.pos === 'GK') return;
    var a = p.team === 'home' ? homeA[p.id] : awayA[p.id];
    if (!a) return;
    dev += hypot(p.x, p.y, a.x, a.y);
    n++;
  });
  function clustered(team) {
    var list = m.players.filter(function (p) { return p.team === team && !p.sentOff && p.pos !== 'GK'; });
    for (var i = 0; i < list.length; i++) {
      var near = 0;
      for (var j = 0; j < list.length; j++) {
        if (i === j) continue;
        if (hypot(list[i].x, list[i].y, list[j].x, list[j].y) <= 5) near++;
      }
      if (near >= 2) return true;
    }
    return false;
  }
  return {
    nearH: nearH,
    nearA: nearA,
    dev: n ? dev / n : 0,
    cluster: clustered('home') || clustered('away'),
  };
}

function runSeed(seed) {
  var m = new E.Match('m' + seed, { seed: seed, halfLength: 70 });
  m.destroy();
  m.control.activeStamp = -1e15;
  m.control.dx = 0;
  m.control.dy = 0;
  var windows = [];
  var cur = null;
  var prev = { team: null, open: false, n: -99 };
  var guard = 0;
  while (m.phase !== 'fulltime' && guard < 9000 && windows.length < 8) {
    guard++;
    if (m.decision || m.phase === 'decision') pickCommand(m);
    var beforeTeam = ownerTeam(m);
    var beforeOpen = m.phase === 'play' && !m.restart;
    m.control.activeStamp = -1e15;
    m.control.dx = 0;
    m.control.dy = 0;
    var now0 = m.now;
    m.tick();
    var open = m.phase === 'play' && !m.restart && m.now !== now0;
    var team = ownerTeam(m);
    if (open && beforeOpen && prev.open && beforeTeam && team && beforeTeam !== team && (guard - prev.n) <= 2) {
      if (cur && cur.n >= 20) windows.push(cur);
      cur = { n: 0, nearH: 0, nearA: 0, dev: 0, cluster: 0 };
    }
    if (cur && open) {
      var s = sample(m);
      cur.n++;
      cur.nearH += s.nearH;
      cur.nearA += s.nearA;
      cur.dev += s.dev;
      if (s.cluster) cur.cluster++;
      if (cur.n >= 50) {
        windows.push(cur);
        cur = null;
      }
    } else if (cur && !open) {
      if (cur.n >= 20) windows.push(cur);
      cur = null;
    }
    if (open) { prev.team = team; prev.open = true; prev.n = guard; }
    else prev.open = false;
  }
  if (cur && cur.n >= 20) windows.push(cur);
  m.destroy();
  return windows;
}

var seeds = [2, 5, 8, 13, 21];
var all = [];
seeds.forEach(function (s) { all = all.concat(runSeed(s)); });
function avg(key, div) {
  if (!all.length) return 0;
  var t = 0;
  all.forEach(function (w) { t += div ? w[key] / w.n : w[key]; });
  return t / all.length;
}
var out = {
  windows: all.length,
  nearHome: +avg('nearH', true).toFixed(2),
  nearAway: +avg('nearA', true).toFixed(2),
  deviation: +avg('dev', true).toFixed(2),
  clusterFrames: +avg('cluster', false).toFixed(2),
};
console.log(JSON.stringify(out));
