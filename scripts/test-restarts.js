// 犯规必须有接触；点球只在禁区内；定位球一旦判了就不能悄悄换边。
'use strict';

var E = require('../server/game/engine');
var Foul = require('../server/game/rules/foul');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function newMatch(seed) {
  var m = new E.Match('r' + seed, { seed: seed, halfLength: 90 });
  m.destroy();
  m.phase = 'play';
  m.aiCooldownUntil = 1e15;
  m.nextDecisionAt = 1e15;
  m.nextDefDecisionAt = 1e15;
  return m;
}
function P(m, id) { return m.byId[id]; }
function set(m, id, x, y) { var p = P(m, id); p.x = x; p.y = y; }
function placeFar(m) {
  m.players.forEach(function (p) {
    if (p.team === 'away') { p.x = 8; p.y = 6 + (p.num % 11) * 5; }
  });
}

console.log('== 没有接触就没有犯规 ==');
(function () {
  var m = newMatch(1);
  set(m, 'h10', 70, 34);
  placeFar(m);
  m.ball.ownerId = 'h10'; m.ball.x = 71; m.ball.y = 34;
  var near = m.nearestOpponent(P(m, 'h10'));
  ok(near.dist > 20, '最近的对手离得很远', near.dist.toFixed(1));
  m.phase = 'decision';
  m.decision = { playerId: 'h10', options: [{ id: 'dribble', enabled: true, cost: 0, rate: 1 }] };
  var res = m.applyCommand('h10', 'dribble');
  ok(res.ok, '远距离突破指令接受');
  ok(m.phase === 'play', '没有人贴身时突破不鸣哨', m.phase);
  ok(!m.restart, '没有凭空点球或任意球', m.restart && m.restart.kind);
  ok(m.ball.ownerId === 'h10', '球还在带球的人脚下', m.ball.ownerId);
})();

(function () {
  var m = newMatch(2);
  set(m, 'h10', 92, 34); set(m, 'a4', 70, 10);
  m.ball.ownerId = 'h10';
  var f = Foul.judgeFoul(m, P(m, 'a4'), P(m, 'h10'), {});
  ok(f.penalty === true, '人在对方禁区里，定级本身会标点球');
  var act = m.applyFoulResult(f);
  ok(m.phase === 'play' && act.kind === 'playon', '人离得远，判罚被丢掉', m.phase + '/' + act.kind);
  ok(!m.restart, '远距离假犯规不产生定位球');
})();

(function () {
  var m = newMatch(3);
  set(m, 'h10', 70, 34); set(m, 'a4', 71.2, 34);
  m.ball.ownerId = 'h10';
  var f = Foul.judgeFoul(m, P(m, 'a4'), P(m, 'h10'), { fromBehind: true });
  f.advantage = false;
  m.applyFoulResult(f);
  ok(m.restart && m.restart.kind === 'foul' && m.restart.team === 'home', '禁区外贴身犯规是主队任意球', m.restart && m.restart.kind);
  ok(m.restart.x < 88, '任意球点在禁区外', m.restart && m.restart.x);
  ok(m.phase === 'decision' && m.decision && m.decision.kind === 'taker', '主队任意球先选主罚', m.decision && m.decision.kind);
})();

(function () {
  var m = newMatch(4);
  set(m, 'h10', 94, 34); set(m, 'a4', 95, 34.4);
  m.ball.ownerId = 'h10';
  var f = Foul.judgeFoul(m, P(m, 'a4'), P(m, 'h10'), {});
  f.advantage = false;
  ok(Foul.inBox(f.spot.x, f.spot.y, 'away'), '犯规点在客队禁区内');
  m.applyFoulResult(f);
  ok(m.restart && m.restart.kind === 'penalty' && m.restart.team === 'home', '禁区内贴身犯规是主队点球', m.restart && m.restart.label);
  ok(Math.abs(m.restart.x - 94) < 0.2 && Math.abs(m.restart.y - 34) < 0.2, '球在点球点');
  var spot = { x: m.restart.x, y: m.restart.y, team: m.restart.team, kind: m.restart.kind };
  var i;
  for (i = 0; i < 30; i++) m.tick();
  ok(m.restart && m.restart.kind === spot.kind && m.restart.team === spot.team, '菜单等着的时候点球不会被清掉', m.phase + '/' + (m.restart && m.restart.kind));
  ok(Math.abs(m.ball.x - spot.x) < 0.3 && m.ball.ownerId && P(m, m.ball.ownerId).team === 'home', '球还在主队脚下的点球点', m.ball.ownerId + ' @' + m.ball.x.toFixed(1));
})();

console.log('== 每种定位球都由对的一方、在对的地点执行 ==');
function hold(m, ticks) {
  var before = m.restart ? { kind: m.restart.kind, team: m.restart.team, x: m.restart.x, y: m.restart.y } : null;
  var i;
  for (i = 0; i < ticks; i++) {
    if (m.phase === 'fulltime') break;
    m.tick();
  }
  return before;
}

(function () {
  var m = newMatch(10);
  m.whistleThrowIn('home', 40, -2);
  ok(m.restart && m.restart.kind === 'throwin' && m.restart.team === 'home', '界外球给主队');
  ok(Math.abs(m.ball.y - 2) < 0.05 && P(m, m.ball.ownerId).team === 'home', '界外球主罚者是主队、球在边线');
  var b = hold(m, 20);
  ok(m.phase === 'play' && m.ball.ownerId && P(m, m.ball.ownerId).team === 'home', '界外球恢复后仍是主队', m.ball.ownerId);
  ok(b.kind === 'throwin', '判的是界外球');
})();

(function () {
  var m = newMatch(11);
  m.whistleThrowIn('away', 40, 80);
  ok(m.restart.team === 'away' && P(m, m.ball.ownerId).team === 'away', '客队界外球不换边');
  hold(m, 20);
  ok(P(m, m.ball.ownerId).team === 'away', '恢复后仍是客队', m.ball.ownerId);
})();

(function () {
  var m = newMatch(12);
  m.ball.x = 106; m.ball.y = 20; m.ball.lastTouchTeam = 'home'; m.ball.lastTouchId = 'h10';
  m.whistleOutOfBounds();
  ok(m.restart && m.restart.kind === 'goalkick' && m.restart.team === 'away', '主队把球踢出底线，客队球门球', m.restart && (m.restart.kind + '/' + m.restart.team));
  ok(m.ball.ownerId === 'a1' && m.ball.x > 90, '球在客队球门球点', m.ball.x);
  hold(m, 25);
  ok(m.ball.ownerId === 'a1', '球门球开出后仍是客队门将', m.ball.ownerId);
})();

(function () {
  var m = newMatch(13);
  m.ball.x = -1; m.ball.y = 20; m.ball.lastTouchTeam = 'away'; m.ball.lastTouchId = 'a10';
  m.whistleOutOfBounds();
  ok(m.restart && m.restart.kind === 'goalkick' && m.restart.team === 'home', '客队把球踢出底线，主队球门球', m.restart && m.restart.team);
  ok(m.ball.ownerId === 'h1' && m.ball.x < 12, '球在主队球门球点', m.ball.x);
})();

(function () {
  var m = newMatch(14);
  m.ball.x = 106; m.ball.y = 20; m.ball.lastTouchTeam = 'away';
  m.whistleOutOfBounds();
  ok(m.restart && m.restart.kind === 'corner' && m.restart.team === 'home', '客队碰出底线，主队角球');
  ok(m.phase === 'decision' && m.decision.kind === 'taker', '主队角球先选主罚', m.decision && m.decision.kind);
  ok(m.ball.x > 100, '角球在对方底线角上', m.ball.x + ',' + m.ball.y);
  var x = m.ball.x, y = m.ball.y;
  hold(m, 25);
  ok(m.restart && m.restart.kind === 'corner' && m.restart.team === 'home', '不选人就一直是这个角球');
  ok(Math.abs(m.ball.x - x) < 0.2 && Math.abs(m.ball.y - y) < 0.2, '球没有自己跑掉');
})();

(function () {
  var m = newMatch(15);
  m.ball.x = -1; m.ball.y = 50; m.ball.lastTouchTeam = 'home';
  m.whistleOutOfBounds();
  ok(m.restart && m.restart.kind === 'corner' && m.restart.team === 'away', '主队碰出自己底线，客队角球');
  ok(m.ball.ownerId && P(m, m.ball.ownerId).team === 'away' && m.ball.x < 5, '客队在左边角球点', m.ball.ownerId);
})();

(function () {
  var m = newMatch(16);
  set(m, 'h10', 60, 34); set(m, 'h9', 82, 20);
  m.ball.ownerId = 'h10';
  m.whistleOffside({ player: P(m, 'h9'), reason: 'receive', spot: { x: 82, y: 20 } }, P(m, 'h10'));
  ok(m.restart && m.restart.kind === 'offside' && m.restart.team === 'away', '越位任意球给防守方');
  ok(m.restart.indirect === true, '越位是间接任意球');
  ok(P(m, m.ball.ownerId).team === 'away', '主罚者是客队', m.ball.ownerId);
  ok(Math.abs(m.ball.x - 82) < 0.1, '球在越位点');
})();

(function () {
  var m = newMatch(17);
  set(m, 'a10', 40, 30); set(m, 'a9', 20, 24);
  m.ball.ownerId = 'a10';
  m.whistleOffside({ player: P(m, 'a9'), reason: 'receive', spot: { x: 20, y: 24 } }, P(m, 'a10'));
  ok(m.restart && m.restart.team === 'home' && m.restart.kind === 'offside', '客队越位，主队间接任意球');
  ok(m.decision && m.decision.kind === 'taker', '主队间接任意球先选人');
  var id = m.decision.options[0].id;
  var spot = { x: m.restart.x, y: m.restart.y };
  m.applyCommand(m.decision.playerId, id);
  ok(m.decision && m.decision.kind === 'setpiece', '选完人是传球/射门', m.decision && m.decision.kind);
  ok(m.ball.ownerId === id && Math.abs(m.ball.x - spot.x) < 0.2, '主罚人站在原来的点上', m.ball.ownerId);
  ok(m.restart.team === 'home', '换人不会把任意球送给对方');
})();

console.log('== 点球选人、射门、QTE ==');
(function () {
  var m = newMatch(20);
  set(m, 'h10', 94, 34); set(m, 'a4', 95.1, 34);
  m.ball.ownerId = 'h10';
  var f = Foul.judgeFoul(m, P(m, 'a4'), P(m, 'h10'), {});
  f.advantage = false; f.card = 'none';
  m.applyFoulResult(f);
  ok(m.decision && m.decision.kind === 'taker' && m.decision.options.length >= 8, '点球列出本队球员', m.decision && m.decision.options.length);
  ok(m.decision.options[0].sub && m.decision.options[0].sub.indexOf('射门') >= 0 && m.decision.options[0].sub.indexOf('心理') >= 0 && m.decision.options[0].sub.indexOf('体能') < 0, '主罚名单写射门和心理', m.decision.options[0].sub);
  var best = m.decision.options[0].id;
  m.applyCommand(m.decision.playerId, best);
  ok(m.decision && m.decision.kind === 'penalty-shot', '选完主罚列出射门', m.decision && m.decision.kind);
  var names = m.decision.options.map(function (o) { return o.name; });
  ok(names.indexOf('抽射') >= 0 && names.indexOf('推射') >= 0, '默认有抽射和推射', names.join(','));
  m.applyCommand(m.decision.playerId, 'shot-placed');
  ok(m.decision && m.decision.kind === 'qte' && m.decision.qte && m.decision.qte.segments.length >= 4, '推射之后进入 QTE', m.decision && m.decision.kind);
  ok(m.restart && m.restart.kind === 'penalty' && m.restart.team === 'home', 'QTE 期间点球还在');
  var before = m.phase;
  m.applyCommand(m.decision.playerId, 'qte-hit', { mark: 0.5 });
  ok(before === 'decision' && (m.phase === 'shotflight' || m.phase === 'goal'), '确定之后才主罚', m.phase);
  ok(!m.restart || m.restart.kind !== 'penalty', '球踢出后不再挂着点球横幅', m.restart && m.restart.kind);
})();

(function () {
  var hi = 0, lo = 0, i;
  for (i = 0; i < 40; i++) {
    var m = newMatch(300 + i);
    set(m, 'h9', 94, 34);
    m.players.forEach(function (p) { if (p.team === 'away' && p.pos !== 'GK') p.x = 40; });
    set(m, 'a1', 104, 34);
    var good = m.shotChance(P(m, 'h9'), P(m, 'a1'), null, { penalty: true, qte: 1 });
    var bad = m.shotChance(P(m, 'h9'), P(m, 'a1'), null, { penalty: true, qte: 0 });
    hi += good.pGoal; lo += bad.pGoal;
  }
  ok(hi / 40 > lo / 40 + 0.05, 'QTE 居中比打偏更有机会进', (hi / 40).toFixed(2) + ' vs ' + (lo / 40).toFixed(2));
})();

console.log('== 任意球菜单、远射、打飞 ==');
(function () {
  var m = newMatch(21);
  set(m, 'h10', 60, 34); set(m, 'a4', 61, 34);
  m.ball.ownerId = 'h10';
  m.applyFoulResult({
    defender: P(m, 'a4'), victim: P(m, 'h10'), team: 'home', live: false,
    spot: { x: 60, y: 34 }, card: 'none', penalty: false, advantage: false, severity: 30,
  });
  m.applyCommand(m.decision.playerId, 'h10');
  ok(m.decision.kind === 'setpiece', '任意球是传球或射门');
  var ids = m.decision.options.map(function (o) { return o.id; });
  ok(ids.indexOf('pass') >= 0 && ids.indexOf('shoot') >= 0, '菜单里有传球和射门', ids.join(','));
  var shoot = m.decision.options.filter(function (o) { return o.id === 'shoot'; })[0];
  ok(shoot.shots && shoot.shots.length >= 2, '射门下面有抽射和推射');
})();

(function () {
  var over = 0, wide = 0, goal = 0, n = 36;
  var i;
  for (i = 0; i < n; i++) {
    var m = newMatch(400 + i);
    set(m, 'h4', 40, 34);
    m.players.forEach(function (p) {
      if (p.id === 'h4' || p.id === 'a1') return;
      p.x = p.team === 'home' ? 18 : 30;
      p.y = 6 + (p.num % 10) * 5;
    });
    set(m, 'a1', 103, 34);
    m.ball.ownerId = 'h4';
    var shot = m.shotChance(P(m, 'h4'), P(m, 'a1'), require('../shared/moves').shotById('shot-driven'), { freeKick: true });
    m.phase = 'play';
    m.resolveAction(P(m, 'h4'), 'shot-driven', shot.pGoal * 100, { model: true, freeKick: true });
    var outcome = m.shotFlight && m.shotFlight.outcome;
    if (outcome === 'over') over++;
    else if (outcome === 'wide') wide++;
    else if (outcome === 'goal') goal++;
  }
  ok(over + wide > n * 0.25, '远距离抽射经常打高或打偏', 'over=' + over + ' wide=' + wide + ' goal=' + goal);
  ok(over > 0 && wide > 0, '高出和偏出都会出现', over + '/' + wide);
})();

(function () {
  var m = newMatch(22);
  set(m, 'h10', 78, 34); set(m, 'a1', 103, 34);
  m.players.forEach(function (p) { if (p.team === 'away' && p.id !== 'a1') p.x = 30; });
  m.startShotFlight(P(m, 'h10'), P(m, 'a1'), { outcome: 'over', label: '抽射', snap: null });
  var guard = 0;
  while (m.phase === 'shotflight' && guard++ < 400) m.tick();
  ok(m.restart && m.restart.kind === 'goalkick' && m.restart.team === 'away', '高出横梁是客队球门球', m.restart && (m.restart.kind + '/' + m.restart.team));
  ok(m.ball.ownerId === 'a1' && m.ball.x > 90, '球门球在客队门口', m.ball.ownerId + '@' + m.ball.x.toFixed(1));
  ok(m.lastAction && m.lastAction.cut === 'shot-over', '演出是高出', m.lastAction && m.lastAction.cut);
})();

(function () {
  var m = newMatch(23);
  set(m, 'h10', 78, 40); set(m, 'a1', 103, 34);
  m.players.forEach(function (p) { if (p.team === 'away' && p.id !== 'a1') p.x = 30; });
  m.startShotFlight(P(m, 'h10'), P(m, 'a1'), { outcome: 'wide', label: '推射', snap: null });
  var guard = 0;
  while (m.phase === 'shotflight' && guard++ < 400) m.tick();
  ok(m.restart && m.restart.kind === 'goalkick' && m.restart.team === 'away', '打偏也是客队球门球', m.phase + '/' + (m.restart && m.restart.kind));
})();

(function () {
  var placed = 0, driven = 0, i;
  for (i = 0; i < 25; i++) {
    var m = newMatch(500 + i);
    set(m, 'h10', 80, 34); set(m, 'a1', 103, 34);
    var pk = m.shotChance(P(m, 'h10'), P(m, 'a1'), require('../shared/moves').SHOTS.placed, {});
    var dk = m.shotChance(P(m, 'h10'), P(m, 'a1'), require('../shared/moves').SHOTS.driven, {});
    placed += pk.pOn; driven += dk.pOn;
  }
  ok(placed / 25 > driven / 25, '推射比抽射更不容易打飞', (placed / 25).toFixed(2) + ' vs ' + (driven / 25).toFixed(2));
})();

console.log('== 开球 ==');
(function () {
  var m = newMatch(30);
  m.resetPositions('home');
  ok(m.phase === 'kickoff' && m.ball.ownerId === 'h10', '开球是主队 10 号');
  ok(!m.restart, '开球不是一条会丢的定位球');
  var guard = 0;
  while (m.phase === 'kickoff' && guard++ < 40) m.tick();
  ok(m.phase === 'play' && m.ball.ownerId === 'h10', '开球结束后球还在主队', m.ball.ownerId);
})();

if (failures) {
  console.log('\n' + failures + ' TEST(S) FAILED');
  process.exit(1);
}
console.log('\nALL RESTART TESTS PASSED');
