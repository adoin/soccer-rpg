// scripts/test-team-shape.js
// 控球人必须永远是主队；犯规/越位摆出任意球或点球；4-2-3-1 整体站位；临时补位后换回。
'use strict';

var fs = require('fs');
var E = require('../server/game/engine');
var Behavior = require('../server/game/rules/behavior');
var Teams = require('../shared/teams');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function newMatch(seed) {
  var m = new E.Match('t' + seed, { seed: seed, halfLength: 60 });
  m.destroy();
  m.phase = 'play';
  m.aiCooldownUntil = 1e15;
  m.nextDecisionAt = 1e15;
  m.nextDefDecisionAt = 1e15;
  return m;
}
function P(m, id) { return m.byId[id]; }
function set(m, id, x, y) { var p = P(m, id); p.x = x; p.y = y; }
function dist(a, b) {
  var dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
function controlledTeam(m) {
  var p = m.byId[m.control.playerId];
  return p ? p.team : null;
}

console.log('== 人类只控制主队 ==');
(function () {
  var m = newMatch(1);
  m.control.playerId = 'a4';
  m.tick();
  ok(controlledTeam(m) === 'home', '直接写成客队 id，tick 后拉回主队', m.control.playerId);
  var r = m.setInput({ playerId: 'a10', dx: 1, dy: 0 });
  ok(controlledTeam(m) === 'home' && r.controlledId[0] === 'h', 'setInput 拒绝客队球员', r.controlledId);
  m.control.playerId = 'a1';
  m.ball.ownerId = 'a9';
  m.ball.x = 40; m.ball.y = 34;
  set(m, 'a9', 40, 34);
  m._lastCarrierId = null;
  m.simulate(0.1);
  ok(controlledTeam(m) === 'home', '客队门将 id 不会因为“正在控门将”被留下', m.control.playerId);
})();

(function () {
  var seeds = [3, 7, 11, 19, 23, 31];
  var bad = 0, ticks = 0;
  seeds.forEach(function (seed) {
    var m = new E.Match('sim' + seed, { seed: seed, halfLength: 12 });
    m.destroy();
    var guard = 0;
    while (m.phase !== 'fulltime' && guard < 20000) {
      guard++;
      if (guard % 17 === 0) m.control.playerId = 'a' + ((guard % 11) + 1);
      if (guard % 29 === 0) m.setInput({ playerId: 'a10', dx: (guard % 3) - 1, dy: 0 });
      m.tick();
      if (m.phase === 'decision' && m.decision) {
        var opts = (m.decision.options || []).filter(function (o) { return o.enabled; });
        if (opts.length) {
          var pick = opts[Math.floor(m.rng() * opts.length)];
          try { m.applyCommand(m.decision.playerId, pick.id); } catch (e) { m.phase = 'play'; m.decision = null; }
        } else {
          m.phase = 'play'; m.decision = null; m.nextDecisionAt = m.now + 6000;
        }
      }
      var cp = m.byId[m.control.playerId];
      var homeLeft = m.players.some(function (p) { return p.team === 'home' && !p.sentOff; });
      if (homeLeft && (!cp || cp.team !== 'home')) bad++;
      ticks++;
    }
    if (m.phase !== 'fulltime') bad++;
    m.destroy();
  });
  ok(bad === 0, '多场比赛每次球权变化后控制的都是主队', 'bad=' + bad + ' ticks=' + ticks);
})();

console.log('== 任意球 / 点球 / 界外球 ==');
(function () {
  var m = newMatch(40);
  set(m, 'h10', 60, 34); set(m, 'a4', 61, 34);
  m.ball.ownerId = 'h10';
  var f = {
    defender: P(m, 'a4'), victim: P(m, 'h10'), team: 'home',
    spot: { x: 60, y: 34 }, card: 'none', penalty: false, advantage: false, severity: 40,
  };
  var act = m.applyFoulResult(f);
  ok((m.phase === 'whistle' || m.phase === 'decision') && act.kind === 'foul' && act.cut == null, '犯规停球且不盖住球场', m.phase + '/' + act.cut);
  ok(m.restart && m.restart.label === '犯规 → 任意球', '横幅是犯规 → 任意球', m.restart && m.restart.label);
  ok(Math.abs(m.ball.x - 60) < 0.05 && Math.abs(m.ball.y - 34) < 0.05, '球放在犯规点', m.ball.x + ',' + m.ball.y);
  var fkTaker = P(m, 'h10');
  ok(fkTaker.id === m.ball.ownerId && fkTaker.x < 58.5 && fkTaker.x > 54, '主罚者站在球后', fkTaker.x.toFixed(2));
  var close = m.players.filter(function (q) {
    return q.team === 'away' && !q.sentOff && dist(q, { x: 60, y: 34 }) < 9.1;
  });
  ok(close.length === 0, '对方退出 9.15 米', close.length + '人太近');
  var wall = m.players.filter(function (q) {
    return q.team === 'away' && !q.sentOff && Math.abs(dist(q, { x: 60, y: 34 }) - 9.15) < 0.4 && q.x > 66;
  });
  ok(wall.length >= 3, '任意球有人墙，站在球和球门之间', wall.length + '人');
  var wallYs = wall.map(function (q) { return q.y; });
  ok(wall.length < 2 || Math.max.apply(null, wallYs) - Math.min.apply(null, wallYs) > 2, '人墙横向排开', wall.map(function (q) { return q.y.toFixed(1); }).join(','));
  ok(controlledTeam(m) === 'home' && m.control.playerId === 'h10', '主队任意球由主队主罚者控制', m.control.playerId);
  ok(act.text === '哨响！爆裂 直人 犯规，青鹰高校 获得直接任意球。', '直接任意球文案', act.text);
  ok(act.text.split('青鹰高校').length === 2, '队名只出现一次', act.text);
})();

(function () {
  var m = newMatch(41);
  set(m, 'a10', 40, 30); set(m, 'h4', 39, 30);
  m.ball.ownerId = 'a10';
  m.control.playerId = 'h8';
  var f = {
    defender: P(m, 'h4'), victim: P(m, 'a10'), team: 'away',
    spot: { x: 40, y: 30 }, card: 'none', penalty: false, advantage: false, severity: 40,
  };
  m.applyFoulResult(f);
  ok(m.ball.ownerId && m.byId[m.ball.ownerId].team === 'away', '客队任意球由客队主罚', m.ball.ownerId);
  var awayTaker = m.byId[m.ball.ownerId];
  ok(awayTaker && awayTaker.team === 'away' && awayTaker.x > 41.2 && awayTaker.x < 45, '客队主罚者站在球后', awayTaker && awayTaker.x);
  ok(controlledTeam(m) === 'home', '客队定位球时人仍控制主队', m.control.playerId);
  ok(m.lastAction.text === '哨响！松本 勇 犯规，烈风学院 获得直接任意球。', '客队直接任意球文案', m.lastAction.text);
  ok(m.lastAction.text.split('烈风学院').length === 2, '客队队名只出现一次', m.lastAction.text);
})();

(function () {
  var m = newMatch(42);
  set(m, 'h10', 70, 34); set(m, 'h9', 82, 30);
  m.ball.ownerId = 'h10'; m.ball.x = 70; m.ball.y = 34;
  var os = { player: P(m, 'h9'), reason: 'receive', spot: { x: 82, y: 30 } };
  var act = m.whistleOffside(os, P(m, 'h10'));
  ok(act.kind === 'offside' && act.cut == null, '越位不播全屏', act.kind);
  ok(m.restart && m.restart.label === '越位 → 任意球', '横幅是越位 → 任意球', m.restart && m.restart.label);
  ok(Math.abs(m.ball.x - 82) < 0.05 && Math.abs(m.ball.y - 30) < 0.05, '球放在越位点', m.ball.x + ',' + m.ball.y);
  var taker = m.byId[m.ball.ownerId];
  ok(taker && taker.team === 'away' && taker.pos !== 'GK', '防守方外场球员主罚', taker && taker.id);
  ok(taker.x > 83 && taker.x < 87, '主罚者站在越位点后面', taker.x.toFixed(2) + ',' + taker.y.toFixed(2));
  var close = m.players.filter(function (q) {
    return q.team === 'home' && !q.sentOff && dist(q, { x: 82, y: 30 }) < 9.1;
  });
  ok(close.length === 0, '越位方退出 9.15 米', close.length + '人太近');
  ok(controlledTeam(m) === 'home', '越位任意球给对方时仍控制主队', m.control.playerId);
  ok(act.text === '🚩 越位！木村 雷 处于越位位置接球，裁判鸣哨。 烈风学院 获得间接任意球。', '越位文案队名和名字分开', act.text);
  ok(act.text.split('烈风学院').length === 2, '越位队名只出现一次', act.text);
})();

(function () {
  var m = newMatch(43);
  set(m, 'h10', 94, 34); set(m, 'a4', 95, 34);
  m.ball.ownerId = 'h10';
  var f = {
    defender: P(m, 'a4'), victim: P(m, 'h10'), team: 'home',
    spot: { x: 94, y: 34 }, card: 'yellow', penalty: true, advantage: false,
    severity: 70, severityLabel: '禁区内犯规',
  };
  var act = m.applyFoulResult(f);
  ok((m.phase === 'penalty' || m.phase === 'decision') && act.kind === 'penalty', '禁区内犯规进入点球', m.phase + '/' + act.kind);
  ok(act.text === '🟨 黄牌！爆裂 直人 禁区内犯规，放倒了 风间 隼。青鹰高校 获得点球。', '点球文案', act.text);
  ok(act.text.split('青鹰高校').length === 2 && act.text.indexOf('获得直接任意球') < 0, '点球队名只写一次', act.text);
  ok(m.restart && m.restart.label === '犯规 → 点球', '点球横幅', m.restart && m.restart.label);
  ok(Math.abs(m.ball.x - 94) < 0.05 && Math.abs(m.ball.y - 34) < 0.05, '球在点球点', m.ball.x + ',' + m.ball.y);
  ok(m.ball.ownerId === 'h10' && P(m, 'h10').x < 92.5 && P(m, 'h10').x > 89, '主罚者站在球后', P(m, 'h10').x.toFixed(2));
  var gk = P(m, 'a1');
  ok(gk.x > 104.4 && Math.abs(gk.y - 34) < 1, '门将站在球门线上', gk.x.toFixed(2) + ',' + gk.y.toFixed(2));
  var wall = m.players.filter(function (q) {
    if (q.sentOff || q.id === 'h10' || q.id === 'a1') return false;
    var inBox = q.x > 105 - 16.5 && Math.abs(q.y - 34) <= 20.2;
    var near = dist(q, { x: 94, y: 34 }) < 9.1;
    return inBox || near;
  });
  ok(wall.length === 0, '其余人退出禁区并离开点球点 9.15 米', wall.map(function (q) { return q.id; }).join(','));
  var guard = 0, left = m.phase;
  while (m.phase === 'penalty' && guard++ < 40) m.tick();
  ok(m.phase !== 'penalty', '点球摆完会主罚并离开点球阶段', left + ' → ' + m.phase);
})();

(function () {
  var m = newMatch(44);
  m.whistleThrowIn('home', 50, -1);
  ok(m.lastAction.kind === 'throwin' && Math.abs(m.ball.y - 2) < 0.01, '界外球仍落在边线', m.ball.y);
  ok(m.restart && m.restart.label === '界外球', '界外球有重启状态', m.restart && m.restart.label);
  var m2 = newMatch(45);
  m2.ball.x = 106; m2.ball.y = 20; m2.ball.lastTouchTeam = 'away';
  m2.whistleOutOfBounds();
  ok(m2.lastAction.kind === 'corner', '角球判罚还在', m2.lastAction.kind);
  var m3 = newMatch(46);
  m3.ball.x = 106; m3.ball.y = 20; m3.ball.lastTouchTeam = 'home';
  m3.whistleOutOfBounds();
  ok(m3.lastAction.kind === 'goalkick', '球门球判罚还在', m3.lastAction.kind);
  ok(m.lastAction.text.indexOf(' 获得界外球（') >= 0 && m.lastAction.text.indexOf(' 掷）。') >= 0, '界外球文案留出空格', m.lastAction.text);
  ok(m2.lastAction.text.indexOf(' 获得角球（') >= 0 && m2.lastAction.text.indexOf(' 主罚）。') >= 0, '角球文案留出空格', m2.lastAction.text);
  ok(m3.lastAction.text.indexOf(' 获得球门球（') >= 0 && m3.lastAction.text.indexOf(' 开）。') >= 0, '球门球文案留出空格', m3.lastAction.text);
  var red = newMatch(47);
  var rf = {
    defender: P(red, 'a4'), victim: P(red, 'h9'), team: 'home',
    spot: { x: 70, y: 34 }, card: 'red', penalty: false, advantage: false,
    severity: 90, severityLabel: '严重犯规',
  };
  var ra = red.applyFoulResult(rf);
  ok(ra.text === '🟥 红牌！爆裂 直人 严重犯规，被罚下场。青鹰高校 获得直接任意球。', '红牌文案', ra.text);
  ok(ra.text.split('青鹰高校').length === 2, '红牌队名只出现一次', ra.text);
  var adv = newMatch(48);
  adv.applyFoulResult({
    defender: P(adv, 'a4'), victim: P(adv, 'h10'), team: 'home',
    spot: { x: 50, y: 34 }, card: 'none', penalty: false, advantage: true, severity: 20,
  });
  ok(adv.lastAction.text === '🟢 爆裂 直人 犯规，但裁判示意进攻有利，比赛继续！', '有利文案', adv.lastAction.text);
  var cut = fs.readFileSync(require('path').join(__dirname, '../client/js/manga-cutin.js'), 'utf8');
  var parry = (cut.match(/'gk-parry':[^\n]+/) || [''])[0];
  var tip = (cut.match(/'gk-tip':[^\n]+/) || [''])[0];
  ok(parry.indexOf("sfx: '扑出底线！'") >= 0, '底线扑救横幅是扑出底线', parry);
  ok(tip.indexOf("sfx: '托出！'") >= 0, '托出横幅只留给高出', tip);
  ok(cut.split('托出！').length === 2, '托出！只出现在 gk-tip', cut.split('托出！').length - 1);
  var eng = fs.readFileSync(require('path').join(__dirname, '../server/game/engine.js'), 'utf8');
  ok(eng.indexOf('把球扑出底线！') >= 0 && eng.indexOf('把球托出横梁，球出了底线！') >= 0, '解说区分扑出底线和托出横梁');
})();

console.log('== 4-2-3-1 整体站位 ==');
(function () {
  ok(Teams.DEFAULT_FORMATION === '4-2-3-1' && Teams.FORMATIONS['4-2-3-1'], '默认阵型数据是 4-2-3-1');
  var m = newMatch(50);
  function count(team, pos) {
    return m.players.filter(function (p) { return p.team === team && p.pos === pos; }).length;
  }
  ok(count('home', 'DF') === 4 && count('away', 'DF') === 4, '两队都是四后卫', count('home', 'DF') + '/' + count('away', 'DF'));
  ok(count('home', 'MF') === 5 && count('home', 'FW') === 1 && count('home', 'GK') === 1, '主队 4-2-3-1 人数', count('home', 'MF') + ' MF / ' + count('home', 'FW') + ' FW');
  ok(count('away', 'FW') === 1 && count('away', 'MF') === 5, '客队同样 4-2-3-1');
})();

function settle(m, ownerId, x, y) {
  var owner = P(m, ownerId);
  owner.x = x; owner.y = y; owner.frozenUntil = 1e15;
  m.ball.ownerId = ownerId; m.ball.x = x; m.ball.y = y; m.ball.z = 0;
  m._lastCarrierId = ownerId;
  m.phase = 'play';
  var i;
  for (i = 0; i < 45; i++) {
    if (m.phase !== 'play') break;
    m.simulate(0.12);
  }
}

(function () {
  var m = newMatch(51);
  settle(m, 'h9', 78, 34);
  var dfs = m.players.filter(function (p) { return p.team === 'home' && p.pos === 'DF'; });
  var ys = dfs.map(function (p) { return p.y; });
  var span = Math.max.apply(null, ys) - Math.min.apply(null, ys);
  var avgX = dfs.reduce(function (s, p) { return s + p.x; }, 0) / dfs.length;
  var piled = m.players.filter(function (p) {
    return p.team === 'home' && p.id !== 'h9' && p.pos !== 'GK' && dist(p, m.ball) < 8;
  }).length;
  var press = m.players.filter(function (p) {
    return p.team === 'away' && p.pos !== 'GK' && dist(p, m.ball) < 8;
  }).length;
  ok(span > 16, '进攻时四后卫拉开宽度', 'span=' + span.toFixed(1));
  ok(avgX < 72, '进攻时后卫线留在球后面，不堆到球上', 'avgX=' + avgX.toFixed(1));
  ok(piled <= 2, '本方最多两人离开阵型靠近球', 'near=' + piled);
  ok(press <= 2, '对方只有一两个人上抢', 'press=' + press);
})();

(function () {
  var m = newMatch(52);
  settle(m, 'a10', 28, 40);
  var dfs = m.players.filter(function (p) { return p.team === 'home' && p.pos === 'DF'; });
  var ys = dfs.map(function (p) { return p.y; });
  var span = Math.max.apply(null, ys) - Math.min.apply(null, ys);
  var avgX = dfs.reduce(function (s, p) { return s + p.x; }, 0) / dfs.length;
  var press = m.players.filter(function (p) {
    return p.team === 'home' && p.pos !== 'GK' && dist(p, m.ball) < 8;
  }).length;
  ok(span > 14, '防守时四后卫仍保持宽度', 'span=' + span.toFixed(1));
  ok(avgX < 40, '防守时后卫线退到球门一侧', 'avgX=' + avgX.toFixed(1));
  ok(press <= 2, '防守时只有一两个人上抢', 'press=' + press);
})();

console.log('== 临时补位，松开后换回 ==');
(function () {
  var m = newMatch(60);
  m.ball.ownerId = 'h9'; m.ball.x = 70; m.ball.y = 34;
  set(m, 'h9', 70, 34);
  var slot = Behavior.blockTargets(m, 'home').h2;
  m.players.forEach(function (p) {
    if (p.team !== 'home' || p.pos === 'GK' || p.id === 'h2' || p.id === 'h6') return;
    var t = Behavior.blockTargets(m, 'home')[p.id];
    if (t) { p.x = t.x; p.y = t.y; }
  });
  set(m, 'h2', slot.x + 25, slot.y);
  set(m, 'h6', slot.x + 3, slot.y + 1);
  Behavior.updateSwaps(m, 'home', {}, 'h2');
  ok(P(m, 'h2').swapWith === 'h6' && P(m, 'h6').cover === 2, '边后卫拉出去后，近处队友补他的槽', P(m, 'h2').swapWith + ' cover=' + P(m, 'h6').cover);
  Behavior.updateSwaps(m, 'home', {}, 'h2');
  ok(P(m, 'h2').swapWith === 'h6', '补位的人还在持球，换位保持');
  Behavior.updateSwaps(m, 'home', { h2: true }, 'h9');
  ok(P(m, 'h2').swapWith === 'h6', '还有上抢任务时不换回');
  Behavior.updateSwaps(m, 'home', {}, 'h9');
  ok(!P(m, 'h2').swapWith && P(m, 'h2').cover === 2 && P(m, 'h6').cover === 6, '两人都不持球也不盯人时换回原位');
  Behavior.updateSwaps(m, 'home', {}, 'h9');
  ok(!P(m, 'h2').swapWith, '换回后不会因为还没跑回去而立刻再换');
})();

(function () {
  var m = newMatch(61);
  m.ball.ownerId = 'h2'; m.ball.x = 72; m.ball.y = 16;
  m._lastCarrierId = 'h2';
  m.control.playerId = 'h2';
  m.control.activeStamp = m.now;
  var slot = Behavior.slotPoint(P(m, 'h2'), 2, Behavior.blockShift(m, 'home'));
  set(m, 'h2', slot.x + 22, slot.y);
  set(m, 'h6', slot.x + 2, slot.y);
  m.players.forEach(function (p) {
    if (p.id === 'h2' || p.id === 'h6') return;
    if (p.team === 'away') { p.x = 20; p.y = 50; }
    else if (p.pos !== 'GK') {
      var t = Behavior.blockTargets(m, 'home')[p.id];
      if (t) { p.x = t.x; p.y = t.y; }
    }
  });
  m.simulate(0.12);
  ok(!!P(m, 'h2').swapWith, '比赛 tick 里边后卫持球前插会触发补位', P(m, 'h2').swapWith);
  var mate = P(m, 'h2').swapWith;
  m.ball.ownerId = 'h9';
  set(m, 'h9', 60, 34); m.ball.x = 60; m.ball.y = 34;
  m.simulate(0.12);
  ok(!P(m, 'h2').swapWith && P(m, mate).cover === P(m, mate).num, '球交出去且没人盯防后换回', mate);
})();

console.log('== 带球时队友跟上 ==');
(function () {
  var m = newMatch(70);
  m.players.forEach(function (p) {
    if (p.team === 'home') { p.x = p.hx; p.y = p.hy; }
    else { p.x = 96; p.y = p.hy; p.frozenUntil = 1e15; }
  });
  set(m, 'h10', 46, 34);
  m.ball.ownerId = 'h10'; m.ball.x = 47; m.ball.y = 34;
  m.control.playerId = 'h10';
  m._lastCarrierId = 'h10';
  var x9 = P(m, 'h9').x, x7 = P(m, 'h7').x, x11 = P(m, 'h11').x;
  var dfs0 = m.players.filter(function (p) { return p.team === 'home' && p.pos === 'DF'; });
  var dfx0 = dfs0.reduce(function (s, p) { return s + p.x; }, 0) / dfs0.length;
  var i;
  for (i = 0; i < 45; i++) {
    m.setInput({ dx: 1, dy: 0, sprint: true });
    if (m.phase !== 'play') break;
    m.simulate(0.1);
  }
  var carrier = P(m, 'h10');
  var dfs = m.players.filter(function (p) { return p.team === 'home' && p.pos === 'DF'; });
  var dfx = dfs.reduce(function (s, p) { return s + p.x; }, 0) / dfs.length;
  var lanes = m.players.filter(function (p) {
    return p.team === 'home' && p.id !== 'h10' && p.pos !== 'GK' && p.pos !== 'DF' &&
      dist(p, carrier) >= 8 && dist(p, carrier) <= 24;
  });
  ok(carrier.x > 62, '持球人向前推进', carrier.x.toFixed(1));
  ok(P(m, 'h9').x > x9 + 8 && P(m, 'h9').x > carrier.x + 1, '中锋领在球的前面', P(m, 'h9').x.toFixed(1) + ' vs ' + carrier.x.toFixed(1));
  ok(P(m, 'h7').y < 18 && P(m, 'h7').x > x7 + 8, '左边锋拉开并跟上', P(m, 'h7').x.toFixed(1) + ',' + P(m, 'h7').y.toFixed(1));
  ok(P(m, 'h11').y > 50 && P(m, 'h11').x > x11 + 8, '右边锋拉开并跟上', P(m, 'h11').x.toFixed(1) + ',' + P(m, 'h11').y.toFixed(1));
  ok(lanes.length >= 2, '中前场有人拉开给传球点', String(lanes.length));
  ok(dfx > dfx0 + 6 && dfx < carrier.x - 8, '后卫线整体前提并留在球后', dfx.toFixed(1) + ' ball ' + carrier.x.toFixed(1));
})();

console.log('== 防守不排成一列 ==');
(function () {
  var m = newMatch(80);
  m.ball.ownerId = 'h10';
  m.ball.x = 90; m.ball.y = 34;
  var t = Behavior.blockTargets(m, 'away');
  var ys = [], xs = [];
  Object.keys(t).forEach(function (id) {
    if (m.byId[id].pos === 'GK') return;
    ys.push(t[id].y); xs.push(t[id].x);
  });
  var ySpan = Math.max.apply(null, ys) - Math.min.apply(null, ys);
  var xSpan = Math.max.apply(null, xs) - Math.min.apply(null, xs);
  ok(ySpan > 30, '客队防守横向拉开', ySpan.toFixed(1));
  ok(xSpan > 8, '客队防守有纵深', xSpan.toFixed(1));
  var m2 = newMatch(81);
  m2.ball.x = 106; m2.ball.y = 12; m2.ball.lastTouchTeam = 'away';
  m2.whistleOutOfBounds();
  var cornerTaker = m2.byId[m2.ball.ownerId];
  var boxAtk = m2.players.filter(function (q) {
    return q.team === 'home' && q.id !== cornerTaker.id && q.x > 105 - 16.5 && Math.abs(q.y - 34) <= 20.2;
  });
  ok(boxAtk.length >= 3, '角球有进攻球员进禁区', boxAtk.length);
  ok(P(m2, 'a1').x > 104.4, '角球时客队门将在门线上', P(m2, 'a1').x.toFixed(2));
  var nearFlag = m2.players.filter(function (q) {
    if (q.team === 'home' || q.sentOff) return false;
    return dist(q, { x: m2.ball.x, y: m2.ball.y }) < 9.14;
  });
  ok(nearFlag.length === 0, '角球对方离开角旗 9.15 米', nearFlag.length);
})();

if (failures) {
  console.log('\n' + failures + ' TEST(S) FAILED');
  process.exit(1);
}
console.log('\nALL TEAM SHAPE TESTS PASSED');
