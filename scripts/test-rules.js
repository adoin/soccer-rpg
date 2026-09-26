// scripts/test-rules.js
// 越位 / 犯规 / 裁判规则的确定性测试。全部用固定种子，可重复运行。
// 用法：node scripts/test-rules.js
'use strict';

var E = require('../server/game/engine');
var Offside = require('../server/game/rules/offside');
var Foul = require('../server/game/rules/foul');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) { console.log('  PASS ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

function newMatch(seed) {
  var m = new E.Match('test', { seed: seed, halfLength: 60 });
  m.destroy(); // 关掉定时器，手动 tick
  m.phase = 'play';
  return m;
}
function P(m, id) { return m.byId[id]; }
function set(m, id, x, y) { var p = P(m, id); p.x = x; p.y = y; }
function ball(m, x, y) { m.ball.x = x; m.ball.y = y; }

// 主队（home）向 +x 进攻，客队球门在 x=105，客队门将 a1 应在 x≈100 附近
function awayLine(m, x2, x3, x4, gkX) {
  set(m, 'a2', x2, 36); set(m, 'a3', x3, 34); set(m, 'a4', x4, 30);
  set(m, 'a1', gkX == null ? 100 : gkX, 34);
}
// 把防线之外的客队球员摆到远处，避免干扰越位线 / 最近防守人计算
function parkAway(m) {
  ['a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11'].forEach(function (id, i) { set(m, id, 40, 8 + i * 6); });
}

console.log('== 越位：位置与反越位 ==');
// 1. 明显越位位置接球 → 吹越位（目标数值调低，确保既不反越位也不收步）
(function () {
  var m = newMatch(11);
  awayLine(m, 80, 78, 75);
  set(m, 'h10', 60, 34); ball(m, 60, 34);
  set(m, 'h9', 85, 30);
  var t = P(m, 'h9'); t.stats.anti = 40; t.stats.iq = 40; t.stats.nerve = 40;
  var r = Offside.judgePass(m, P(m, 'h10'), t);
  ok(r.type === 'offside' && r.reason === 'receive', '明显越位接球被吹', JSON.stringify(r.type));
})();

// 2. 确定性：同样局面两次判定完全一致（零随机）
(function () {
  var m = newMatch(11);
  awayLine(m, 80, 78, 75);
  set(m, 'h10', 60, 34); ball(m, 60, 34);
  set(m, 'h9', 85, 30);
  var t = P(m, 'h9'); t.stats.anti = 40; t.stats.iq = 40; t.stats.nerve = 40;
  var r1 = Offside.judgePass(m, P(m, 'h10'), t);
  var r2 = Offside.judgePass(m, P(m, 'h10'), t);
  ok(r1.type === r2.type && r1.reason === r2.reason && r1.player.id === r2.player.id, '越位判定零随机、结果绝对一致');
})();

// 3. 反越位成功：王牌前锋毫厘不越位（注意门将也算防守球员，越位线=除门将外最后一名防守球员）
(function () {
  var m = newMatch(12);
  awayLine(m, 80, 78, 75);
  set(m, 'h10', 60, 34); ball(m, 60, 34);
  set(m, 'h9', 81.5, 30); // 只超越位线（80）1.5 米
  var r = Offside.judgePass(m, P(m, 'h10'), P(m, 'h9'));
  ok(r.type === 'playon' && r.beatTrap === true, '反越位成功继续比赛', JSON.stringify({ t: r.type, b: r.beatTrap }));
})();

// 4. 收步：球商心态好 → 急停不参与，引擎改传
(function () {
  var m = newMatch(13);
  awayLine(m, 80, 78, 75);
  set(m, 'h10', 60, 34); ball(m, 60, 34);
  set(m, 'h9', 81, 30); // 超越位线 1 米
  var t = P(m, 'h9'); t.stats.anti = 40; t.stats.iq = 85; t.stats.nerve = 85;
  var r = Offside.judgePass(m, P(m, 'h10'), t);
  ok(r.type === 'hold', '高球商球员急停收步', r.type);
  if (r.type === 'hold') {
    var alt = m.bestOnsideTarget(P(m, 'h10'), r.snap);
    ok(!!alt && !Offside.isOffsidePosition(alt, r.snap), '改传目标不越位', alt && alt.id);
  }
})();

console.log('== 越位：干扰行为 ==');
// 5. 遮挡门将视线
(function () {
  var m = newMatch(21);
  awayLine(m, 80, 78, 75, 100);
  set(m, 'h10', 60, 34); ball(m, 60, 34);
  set(m, 'h11', 88, 34); // 越位位置，处在球→门将视线走廊上
  var target = P(m, 'h7'); set(m, 'h7', 76, 40); // 不越位，进入进攻三区
  var r = Offside.judgePass(m, P(m, 'h10'), target);
  ok(r.type === 'offside' && r.reason === 'sight', '越位位置遮挡门将视线被吹', JSON.stringify(r.reason));
})();

// 6. 卡位：越位位置贴住追球的防守球员
(function () {
  var m = newMatch(22);
  awayLine(m, 70, 68, 66, 100); // 越位线 = 70
  parkAway(m);
  set(m, 'h10', 60, 34); ball(m, 60, 34);
  set(m, 'h11', 70.2, 34.2); // 越位，贴住追球的 a3（68,34）
  var target = P(m, 'h7'); set(m, 'h7', 66, 40);
  var r = Offside.judgePass(m, P(m, 'h10'), target);
  ok(r.type === 'offside' && r.reason === 'screen', '越位位置卡位被吹', JSON.stringify(r.reason));
})();

// 7. 假装处理球（在传球线路附近干扰）
(function () {
  var m = newMatch(23);
  awayLine(m, 64, 62, 60, 100); // 越位线 = 64
  parkAway(m);
  set(m, 'h10', 58, 34); ball(m, 58, 34);
  set(m, 'h11', 64.3, 38.5); // 越位，距传球线路约 3.6 米
  var target = P(m, 'h7'); set(m, 'h7', 61, 40);
  var r = Offside.judgePass(m, P(m, 'h10'), target);
  ok(r.type === 'offside' && (r.reason === 'dummy' || r.reason === 'interfere-play'), '假装处理球/参与进攻被吹', JSON.stringify(r.reason));
})();

// 8. 射门瞬间：越位球员挡门将视线
(function () {
  var m = newMatch(24);
  awayLine(m, 88, 86, 84, 100);
  set(m, 'h10', 80, 34); ball(m, 80, 34);
  set(m, 'h11', 90, 34);
  var r = Offside.judgeShot(m, P(m, 'h10'));
  ok(r.type === 'offside' && r.reason === 'sight', '射门时越位遮挡视线被吹', JSON.stringify(r.reason));
})();

// 9. 门将扑救反弹：越位球员获益
(function () {
  var m = newMatch(25);
  awayLine(m, 88, 86, 84, 85); // 门将出击到 85 扑救
  ball(m, 85, 34); // 球在门将处（扑救后）
  set(m, 'h9', 90, 34); // 越位位置等反弹
  var r = Offside.judgeRebound(m, 'home');
  ok(r.type === 'offside' && r.reason === 'rebound', '越位位置获益（反弹球）被吹', JSON.stringify(r.reason));
})();

console.log('== 犯规 / 抢断 / 裁判 ==');
// 10. 抢断三种结果都可能出现（分布 sanity）
(function () {
  var counts = { clean: 0, foul: 0, beaten: 0 };
  for (var s = 0; s < 40; s++) {
    var m = newMatch(100 + s);
    var t = Foul.judgeTackle(m, P(m, 'a2'), P(m, 'h10'), { speedHigh: true });
    counts[t.outcome]++;
  }
  ok(counts.clean > 0 && counts.foul > 0 && counts.beaten > 0, '抢断有干净/犯规/被过三种结果', JSON.stringify(counts));
})();

// 11. 犯规定级确定性：同种子同局面 → 同样的牌
(function () {
  function foulCard(seed) {
    var m = newMatch(seed);
    set(m, 'a2', 60, 34); set(m, 'h10', 61, 34);
    return Foul.judgeFoul(m, P(m, 'a2'), P(m, 'h10'), { fromBehind: true, speedHigh: true });
  }
  var f1 = foulCard(77), f2 = foulCard(77);
  ok(f1.card === f2.card && f1.severity === f2.severity, '同种子犯规判罚完全一致', f1.card + '/' + f1.severity);
})();

// 12. DOGSO：最后一人禁区内犯规 → 红牌 + 点球
(function () {
  var m = newMatch(31);
  m.players.forEach(function (p) { if (p.team === 'away' && p.pos !== 'GK') { p.x = 60; p.y = 34; } });
  set(m, 'a2', 89, 34); set(m, 'h10', 90, 34); // a2 身后犯规，身前只剩门将
  var f = Foul.judgeFoul(m, P(m, 'a2'), P(m, 'h10'), { fromBehind: true });
  ok(f.dogso === true && f.card === 'red' && f.penalty === true, 'DOGSO 红牌+点球', JSON.stringify({ d: f.dogso, c: f.card, p: f.penalty }));
})();

// 13. 两黄变一红
(function () {
  var m = newMatch(32);
  var d = P(m, 'a4');
  var f1 = { defender: d, victim: P(m, 'h9'), card: 'yellow' };
  Foul.applyCards(f1);
  var f2 = { defender: d, victim: P(m, 'h9'), card: 'yellow' };
  Foul.applyCards(f2);
  ok(f2.card === 'red' && d.sentOff === true && f2.secondYellow === true, '两黄变一红并罚下');
})();

// 14. 点球流程：禁区内犯规走点球结算
(function () {
  var m = newMatch(33);
  set(m, 'a2', 90, 34); set(m, 'h10', 91, 34);
  m.ball.ownerId = 'h10';
  var f = Foul.judgeFoul(m, P(m, 'a2'), P(m, 'h10'), {});
  f.penalty = true; f.card = 'yellow'; f.advantage = false;
  var act = m.applyFoulResult(f);
  ok(m.phase === 'penalty' || m.phase === 'goal', '点球进入点球/进球阶段', m.phase);
  ok(act.kind === 'penalty' || act.kind === 'goal', '点球产生结算事件', act.kind);
})();

// 15. 进攻有利：轻微犯规不打断进攻
(function () {
  var m = newMatch(34);
  set(m, 'a2', 60, 34); set(m, 'h10', 61, 34);
  m.ball.ownerId = 'h10';
  var f = { defender: P(m, 'a2'), victim: P(m, 'h10'), team: 'home', spot: { x: 61, y: 34 },
            severity: 30, severityLabel: '一般犯规', card: 'none', dogso: false, penalty: false, advantage: true };
  var act = m.applyFoulResult(f);
  ok(act.kind === 'advantage' && m.phase === 'play', '进攻有利比赛继续', act.kind + '/' + m.phase);
})();

console.log('== 回归：完整比赛能跑完 ==');
// 16. 自动踢完整场比赛（AI + 自动选指令），验证新规则不破坏流程
(function () {
  var m = new E.Match('full', { seed: 2026, halfLength: 30 });
  m.destroy();
  var guard = 0;
  var events = { offside: 0, foul: 0, penalty: 0, advantage: 0 };
  while (m.phase !== 'fulltime' && guard < 20000) {
    guard++;
    m.tick();
    if (m.phase === 'decision' && m.decision) {
      var opts = m.decision.options.filter(function (o) { return o.enabled; });
      var pick = opts[Math.floor(m.rng() * opts.length)];
      var res = m.applyCommand(m.decision.playerId, pick.id);
      if (res.ok && res.result) {
        var k = res.result.kind;
        if (events[k] !== undefined) events[k]++;
      }
    }
  }
  ok(m.phase === 'fulltime', '完整比赛正常结束', 'phase=' + m.phase + ' guard=' + guard);
  console.log('     比分 ' + m.score.home + ' - ' + m.score.away + '，规则事件：' + JSON.stringify(events));
  var badCards = m.players.filter(function (p) { return p.cards.yellow < 0; });
  ok(badCards.length === 0, '牌面数据正常');
})();

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
