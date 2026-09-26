// scripts/test-rules.js
// 规则系统测试：固定种子，可重复。
// 架构：行为层（behavior.js，数值→决策，确定性）→ 裁判层（offside.js，纯客观）
//   · 裁判层：同样的局面永远同样的哨声；数值再高也不能豁免越位。
//   · 行为层：同样的局面+数值永远同样的决策。
//   · 抢断/犯规：数值随机；犯规→判罚映射确定。
'use strict';

var E = require('../server/game/engine');
var Offside = require('../server/game/rules/offside');
var Behavior = require('../server/game/rules/behavior');
var Foul = require('../server/game/rules/foul');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) { console.log('  PASS ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

function newMatch(seed) {
  var m = new E.Match('t' + seed, { seed: seed, halfLength: 60 });
  m.destroy();
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
function parkHome(m) {
  ['h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'h11'].forEach(function (id, i) { set(m, id, 30, 8 + i * 6); });
}

console.log('== 越位裁判层：纯客观，数值零介入 ==');
// 1. 明显越位接球被吹——即使把数值拉满，裁判也不看数值
(function () {
  var m = newMatch(10);
  awayLine(m, 80, 78, 75);
  set(m, 'h10', 60, 34); ball(m, 60, 34);
  var t = P(m, 'h9'); set(m, 'h9', 84, 34);
  t.stats.anticipation = 20; t.stats.offBall = 20; t.stats.decisions = 20;
  t.stats.vision = 20; t.stats.composure = 20; t.stats.determination = 20; // 数值拉满（FM 1-20）
  var r = Offside.judgePass(m, P(m, 'h10'), t);
  ok(r.type === 'offside' && r.reason === 'receive', '数值拉满也照吹越位', JSON.stringify({ t: r.type, reason: r.reason }));
})();

// 2. 越位判定零随机、结果绝对一致
(function () {
  function runOnce() {
    var m = newMatch(11);
    awayLine(m, 80, 78, 75);
    set(m, 'h10', 60, 34); ball(m, 60, 34);
    set(m, 'h9', 83.7, 31.2);
    return JSON.stringify(Offside.judgePass(m, P(m, 'h10'), P(m, 'h9')), function (k, v) {
      return k === 'player' ? v.id : v;
    });
  }
  var a = runOnce(), b = runOnce(), c = runOnce();
  ok(a === b && b === c && JSON.parse(a).type === 'offside', '越位判定零随机、结果绝对一致');
})();

// 3. 干扰行为：遮挡门将视线
(function () {
  var m = newMatch(21);
  awayLine(m, 80, 78, 75, 100); // 越位线 = 80（门将 100 不影响倒数第二人）
  set(m, 'h10', 70, 34); ball(m, 70, 34);
  set(m, 'h11', 84, 34); // 越位，站在球→门将连线上
  var target = P(m, 'h7'); set(m, 'h7', 76, 44);
  var r = Offside.judgePass(m, P(m, 'h10'), target);
  ok(r.type === 'offside' && r.reason === 'sight', '越位位置遮挡门将视线被吹', JSON.stringify(r.reason));
})();

// 4. 干扰行为：卡位
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

// 5. 干扰行为：假装处理球 / 参与进攻
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

// 6. 射门瞬间：越位球员遮挡门将视线
(function () {
  var m = newMatch(24);
  awayLine(m, 88, 86, 84, 100);
  set(m, 'h9', 88.5, 34); ball(m, 88.5, 34); m.ball.ownerId = 'h9';
  set(m, 'h10', 90, 34); // 越位，站在射门→门将连线上
  var r = Offside.judgeShot(m, P(m, 'h9'));
  ok(r.type === 'offside' && r.reason === 'sight', '射门时越位遮挡视线被吹', JSON.stringify(r.reason));
})();

// 7. 反弹球获益：按射门瞬间快照判断越位位置
(function () {
  var m = newMatch(25);
  awayLine(m, 88, 86, 84, 100);
  set(m, 'h9', 88.5, 34); ball(m, 89.7, 34); // 射门瞬间
  set(m, 'h10', 90, 40); // 射门瞬间已处越位位置，但不干扰射门
  var shotSnap = Offside.snapshot(m, 'home');
  ball(m, 95, 34); // 扑救后反弹到门前
  var r = Offside.judgeRebound(m, 'home', shotSnap);
  ok(r.type === 'offside' && r.reason === 'rebound', '越位位置获益（反弹球）被吹', JSON.stringify(r.reason));
})();

console.log('== 行为层：数值驱动决策（确定性，零随机） ==');
// 8. attackerDecision：高球商心态 → 收步；低 → 前插；结果确定
(function () {
  var m = newMatch(30);
  awayLine(m, 80, 78, 75);
  set(m, 'h10', 60, 34); ball(m, 60, 34);
  set(m, 'h9', 82, 30); // 越位 2 米
  var snap = Offside.snapshot(m, 'home');
  var smart = P(m, 'h9'); ['decisions','vision','composure','determination'].forEach(function(k){ smart.stats[k] = 17; });
  var dull = P(m, 'h7'); set(m, 'h7', 82, 40); ['decisions','vision','composure','determination'].forEach(function(k){ dull.stats[k] = 8; });
  var d1 = Behavior.attackerDecision(smart, snap);
  var d2 = Behavior.attackerDecision(dull, snap);
  var d1b = Behavior.attackerDecision(smart, snap);
  ok(d1 === 'hold' && d2 === 'go' && d1 === d1b, '越位决策：聪明的收步、莽撞的前插、结果确定', JSON.stringify({ d1: d1, d2: d2 }));
})();

// 9. timeRunU：高反越位意识 → 钳制在越位线前；低 → 不干预
(function () {
  var snap = { attackingTeam: 'home', uSecondLast: 80, uBall: 60 };
  var sharp = { stats: { anticipation: 17, offBall: 17 }, stamina: 100, maxStamina: 100 };
  var blunt = { stats: { anticipation: 8, offBall: 8 }, stamina: 100, maxStamina: 100 };
  var r1 = Behavior.timeRunU(sharp, 84, snap);
  var r2 = Behavior.timeRunU(blunt, 84, snap);
  var r3 = Behavior.timeRunU(sharp, 78, snap);
  ok(r1 === 78.5 && r2 === null && r3 === null, '反越位时机：高手压线、低手照跑、安全目标不管', JSON.stringify({ r1: r1, r2: r2, r3: r3 }));
})();

// 10. defensiveShape：高纪律防线保持平行
(function () {
  var m = newMatch(31);
  m.now = 0;
  set(m, 'a2', 70, 36); set(m, 'a3', 66, 34); set(m, 'a4', 62, 30); // 参差不齐
  ['a2', 'a3', 'a4'].forEach(function (id) { var q = P(m, id); ['anticipation','positioning','decisions','vision'].forEach(function(k){ q.stats[k] = 17; }); });
  ball(m, 40, 34); // 球在远处
  var out = Behavior.defensiveShape(m, 'away', {});
  var xs = ['a2', 'a3', 'a4'].map(function (id) { return out[id].x; });
  ok(xs[0] === 62 && xs[1] === 62 && xs[2] === 62, '高纪律防线向锚点对齐保持平行', JSON.stringify(xs));
})();

// 11. defensiveShape：低纪律防线各回各家
(function () {
  var m = newMatch(32);
  m.now = 0;
  set(m, 'a2', 70, 36); set(m, 'a3', 66, 34); set(m, 'a4', 62, 30);
  ['a2', 'a3', 'a4'].forEach(function (id) { var q = P(m, id); ['anticipation','positioning','decisions','vision'].forEach(function(k){ q.stats[k] = 6; }); });
  ball(m, 40, 34);
  var out = Behavior.defensiveShape(m, 'away', {});
  ok(out.a2.x === P(m, 'a2').hx && out.a3.x === P(m, 'a3').hx,
    '低纪律防线各回阵型点、参差不齐', JSON.stringify({ a2: out.a2.x, a3: out.a3.x, hx2: P(m, 'a2').hx }));
})();

// 12. defensiveShape：整线协同高 + 无威胁 → 一起压上造越位
(function () {
  var m = newMatch(33);
  m.now = 0;
  set(m, 'a2', 70, 36); set(m, 'a3', 68, 34); set(m, 'a4', 66, 30);
  ['a2', 'a3', 'a4'].forEach(function (id) { var q = P(m, id); ['anticipation','positioning','decisions','vision'].forEach(function(k){ q.stats[k] = 17; }); });
  ball(m, 52.5, 34); // 球在中场，无紧迫威胁
  var out = Behavior.defensiveShape(m, 'away', {});
  var xs = ['a2', 'a3', 'a4'].map(function (id) { return out[id].x; });
  // vBall = 52.5 → 压上到 min(62.5,58)=58 → x = 105-58 = 47
  ok(xs[0] === 47 && xs[1] === 47 && xs[2] === 47, '高协同防线一起压上造越位', JSON.stringify(xs));
})();

console.log('== 引擎集成：行为 → 局面 → 判罚 ==');
// 13. 传球给越位目标：高球商目标急停收步，不改传他人，球成空传被防守方得到
(function () {
  var m = newMatch(41);
  awayLine(m, 80, 78, 75); parkAway(m);
  set(m, 'h10', 60, 34); ball(m, 60, 34); m.ball.ownerId = 'h10';
  var t9 = P(m, 'h9'); set(m, 'h9', 82, 30); ['decisions','vision','composure','determination'].forEach(function(k){ t9.stats[k] = 17; });
  set(m, 'h7', 58, 20); set(m, 'h11', 58, 48); set(m, 'h8', 55, 34); // 不越位的备选
  var r = m.resolveAction(P(m, 'h10'), 'pass', 100);
  ok(r.kind === 'pass' && /急停收步/.test(r.text) && m.ball.ownerId !== 'h9' && m.ball.ownerId[0] === 'a',
    '高球商目标收步，空传被防守方得到（不偷偷改传）', JSON.stringify({ kind: r.kind, owner: m.ball.ownerId }));
})();

// 14. 传球给越位目标：低球商目标继续前插，裁判照吹
(function () {
  var m = newMatch(42);
  awayLine(m, 80, 78, 75); parkAway(m);
  set(m, 'h10', 60, 34); ball(m, 60, 34); m.ball.ownerId = 'h10';
  var t9 = P(m, 'h9'); set(m, 'h9', 82, 30); ['decisions','vision','composure','determination'].forEach(function(k){ t9.stats[k] = 8; });
  set(m, 'h7', 58, 20); set(m, 'h11', 58, 48); set(m, 'h8', 55, 34);
  var r = m.resolveAction(P(m, 'h10'), 'pass', 100);
  ok(r.kind === 'offside', '低球商目标前插被吹越位', JSON.stringify({ kind: r.kind, label: r.label }));
})();

console.log('== 犯规 / 抢断 / 裁判 ==');
// 15. 抢断三种结果都出现
(function () {
  var seen = {};
  for (var s = 1; s <= 40; s++) {
    var m = newMatch(100 + s);
    var att = P(m, 'h10'), df = P(m, 'a4');
    set(m, 'h10', 60, 34); set(m, 'a4', 61, 34); ball(m, 60, 34);
    var t = Foul.judgeTackle(m, df, att, { fromBehind: false, speedHigh: false, attackPromising: false });
    seen[t.outcome] = true;
  }
  ok(seen.clean && seen.foul && seen.beaten, '抢断有干净/犯规/被过三种结果', JSON.stringify(Object.keys(seen)));
})();

// 16. 同种子犯规判罚完全一致
(function () {
  function once() {
    var m = newMatch(200);
    var att = P(m, 'h10'), df = P(m, 'a4');
    set(m, 'h10', 60, 34); set(m, 'a4', 61, 34); ball(m, 60, 34);
    var t = Foul.judgeTackle(m, df, att, { fromBehind: true, speedHigh: true, attackPromising: true });
    return JSON.stringify(t, function (k, v) { return v && v.id ? v.id : v; });
  }
  ok(once() === once(), '同种子犯规判罚完全一致');
})();

// 17. DOGSO 红牌+点球（直接调用定级，确定性）
(function () {
  var m = newMatch(201);
  m.players.forEach(function (p) { if (p.team === 'away' && p.pos !== 'GK') { p.x = 60; p.y = 34; } });
  set(m, 'a2', 89, 34); set(m, 'h10', 90, 34); // a2 身后犯规，身前只剩门将；90 在禁区内
  var f = Foul.judgeFoul(m, P(m, 'a2'), P(m, 'h10'), { fromBehind: true });
  ok(f.dogso === true && f.card === 'red' && f.penalty === true, 'DOGSO 红牌+点球',
    JSON.stringify({ d: f.dogso, c: f.card, p: f.penalty }));
})();

// 18. 两黄变一红（确定性：直接模拟两张黄牌的累计）
(function () {
  var m = newMatch(202);
  var att = P(m, 'h10'), df = P(m, 'a4');
  df.cards.yellow = 1; // 已有一黄
  var f2 = { type: 'foul', team: 'home', defender: df, victim: att, card: 'yellow', penalty: false, advantage: false, severity: 60, spot: { x: 60, y: 34 } };
  Foul.applyCards(f2);
  ok(df.sentOff === true && df.cards.red === true, '两黄变一红并罚下', JSON.stringify(df.cards));
})();

// 19. 点球流程：禁区内犯规走点球结算
(function () {
  var m = newMatch(203);
  set(m, 'a2', 90, 34); set(m, 'h10', 91, 34);
  m.ball.ownerId = 'h10';
  var f = Foul.judgeFoul(m, P(m, 'a2'), P(m, 'h10'), {});
  f.penalty = true; f.card = 'yellow'; f.advantage = false;
  var act = m.applyFoulResult(f);
  ok(m.phase === 'penalty' || m.phase === 'goal', '点球进入点球/进球阶段', m.phase);
  ok(act.kind === 'penalty' || act.kind === 'goal', '点球产生结算事件', act.kind);
})();

// 20. 进攻有利：轻微犯规不打断进攻
(function () {
  var m = newMatch(204);
  set(m, 'a2', 60, 34); set(m, 'h10', 61, 34);
  m.ball.ownerId = 'h10';
  var f = { defender: P(m, 'a2'), victim: P(m, 'h10'), team: 'home', spot: { x: 61, y: 34 },
            severity: 30, severityLabel: '一般犯规', card: 'none', dogso: false, penalty: false, advantage: true };
  var act = m.applyFoulResult(f);
  ok(act.kind === 'advantage' && m.phase === 'play', '进攻有利比赛继续', act.kind + '/' + m.phase);
})();

console.log('== 回归：完整比赛能跑完 ==');
(function () {
  var m = newMatch(500);
  m.config.halfLength = 30;
  var guard = 0, events = { offside: 0, foul: 0, penalty: 0, advantage: 0 };
  while (m.phase !== 'fulltime' && guard < 60000) {
    guard++;
    m.tick();
    if (m.phase === 'decision' && m.decision) {
      var opts = m.decision.options.filter(function (o) { return o.enabled; });
      var pick = opts[Math.floor(m.rng() * opts.length)];
      var res = m.applyCommand(m.decision.playerId, pick.id);
      if (res.ok && res.result && events[res.result.kind] !== undefined) events[res.result.kind]++;
    }
  }
  ok(m.phase === 'fulltime', '完整比赛正常结束');
  console.log('     比分 ' + m.score.home + ' - ' + m.score.away + '，规则事件：' + JSON.stringify(events));
  var badCards = m.players.filter(function (p) { return p.cards.yellow < 0 || (p.cards.red && !p.sentOff); });
  ok(badCards.length === 0, '牌面数据正常');
})();

console.log('== 单体能四档 + 持球/变向/爆发/对抗修正 ==');
(function () {
  // 以固定速度比直线跑 n 米，返回净消耗（已重置状态）
  function runMeters(m, p, meters, ratio) {
    var vmax = m.playerSpeed(p, true), v = vmax * ratio, dt = 0.1;
    var step = v * dt, n = Math.max(1, Math.round(meters / step));
    p.stamina = 100;
    p._px = null; p._py = null; p._ltier = null; p._ldx = null;
    p.x = 50; p.y = 34;
    m.updateEnergy(p, dt);
    for (var i = 0; i < n; i++) { p.x += step; m.updateEnergy(p, dt); }
    return 100 - p.stamina;
  }
  var m = newMatch(51);
  var p = P(m, 'h10');
  m.ball.ownerId = null;
  // 把客队全部拉远，隔离身体对抗消耗
  m.players.forEach(function (q) { if (q.team === 'away') { q.x = 100; q.y = 34; } });
  var walk100 = runMeters(m, p, 100, 0.2);   // 散步
  var jog10 = runMeters(m, p, 10, 0.45);     // 慢跑
  var fast10 = runMeters(m, p, 10, 0.7);     // 高速跑
  var sprint10 = runMeters(m, p, 10, 0.95);  // 冲刺（含一次爆发 0.4）
  ok(walk100 < 0.5, '散步 100 米基本不掉体能（散步带恢复）', walk100.toFixed(2));
  ok(sprint10 > 0.5, '冲刺 10 米明显消耗', sprint10.toFixed(2));
  ok(sprint10 > walk100, '硬约束：冲刺 10 米 > 散步 100 米', sprint10.toFixed(2) + ' > ' + walk100.toFixed(2));
  ok(jog10 < fast10 && fast10 < sprint10, '四档单调：慢跑 < 高速跑 < 冲刺',
    [jog10.toFixed(2), fast10.toFixed(2), sprint10.toFixed(2)].join(' < '));
  // 持球修正 ×1.35
  m.ball.ownerId = 'h10';
  var jog10ball = runMeters(m, p, 10, 0.45);
  m.ball.ownerId = null;
  ok(Math.abs(jog10ball / jog10 - 1.35) < 0.05, '持球跑动 ×1.35', (jog10ball / jog10).toFixed(2));
  // 急停变向：直行 vs 90° 转向
  function turnCost(m, p, turn) {
    var vmax = m.playerSpeed(p, true), dt = 0.1, step = vmax * 0.5 * dt;
    p.stamina = 100; p._px = null; p._py = null; p._ltier = null; p._ldx = null;
    p.x = 50; p.y = 34; m.updateEnergy(p, dt);
    p.x += step; m.updateEnergy(p, dt);
    if (turn) { p.y += step; } else { p.x += step; }
    m.updateEnergy(p, dt);
    return 100 - p.stamina;
  }
  var straight = turnCost(m, p, false), turned = turnCost(m, p, true);
  ok(turned - straight > 0.25 && turned - straight < 0.35, '急停变向一次 0.3', (turned - straight).toFixed(2));
  // 爆发：从非冲刺档突然提到冲刺档，精确多扣 0.4（直接设定上 tick 档位隔离单价差）
  function burstCase(m, p, prevTier) {
    var vmax = m.playerSpeed(p, true), dt = 0.1;
    p.stamina = 100; p._px = null; p._py = null; p._ldx = null;
    p.x = 50; p.y = 34; m.updateEnergy(p, dt); // 初始化 _px
    p._ltier = prevTier;
    p.x += vmax * 0.95 * dt; m.updateEnergy(p, dt); // 本 tick 冲刺
    return 100 - p.stamina;
  }
  var d = burstCase(m, p, 2) - burstCase(m, p, 3);
  ok(Math.abs(d - 0.4) < 0.01, '爆发跃迁多扣 0.4', d.toFixed(2));
  // 身体对抗：1.2 米内有对手，静止 1 秒扣 1.5
  var m2 = newMatch(52);
  var p2 = P(m2, 'h10');
  set(m2, 'h10', 50, 34); set(m2, 'a9', 50.8, 34);
  p2.stamina = 100; p2._px = null;
  for (var i = 0; i < 10; i++) m2.updateEnergy(p2, 0.1);
  ok(Math.abs((100 - p2.stamina) - (1.5 - 1.2)) < 0.05, '对抗 1.5/s 叠加静止恢复 1.2/s', (100 - p2.stamina).toFixed(2));
  // 静止恢复 1.2/s
  var m3 = newMatch(53);
  var p3 = P(m3, 'h10');
  p3.stamina = 50; p3._px = null;
  for (var j = 0; j < 10; j++) m3.updateEnergy(p3, 0.1);
  ok(Math.abs(p3.stamina - 51.2) < 0.05, '静止恢复 1.2/s', p3.stamina.toFixed(2));
})();

console.log('== 行为层：无球任务 / 协防 / 盯人 / 持球调整 ==');
(function () {
  var m = newMatch(61);
  var carrier = P(m, 'h10');
  set(m, 'h10', 55, 34); ball(m, 55, 34); m.ball.ownerId = 'h10';
  var snap = Offside.snapshot(m, 'home');
  var tasks = Behavior.attackTasks(m, carrier, snap);
  var types = {};
  Object.keys(tasks).forEach(function (id) { types[tasks[id].type] = true; });
  var nTypes = Object.keys(types).length;
  ok(nTypes >= 3, '无球队员任务多样（接应/前插/拉边/拖后至少三类）', JSON.stringify(types));
  // 任务粘性：短时间内重算不变
  var t2 = Behavior.attackTasks(m, carrier, snap);
  var same = Object.keys(tasks).every(function (id) { return t2[id] && t2[id].type === tasks[id].type; });
  ok(same, '任务粘性：1.2s 内不跳变');
  // 持球者被紧逼：减速护球
  set(m, 'a8', 56.5, 34);
  var adj = Behavior.carrierAdjust(m, carrier);
  ok(adj.spMul === 0.55, '被紧逼时持球者减速护球');
  m.players.forEach(function (q) { if (q.team === 'away') { q.x = 95; q.y = 34; } });
  ok(Behavior.carrierAdjust(m, carrier).spMul === 1, '无人紧逼时正常推进');
  // 防守盯人：MF 跟最近的对方无球队员
  set(m, 'a8', 40, 30); set(m, 'h8', 42, 32);
  var marks = Behavior.markTargets(m, 'away', carrier, {});
  ok(marks['a8'] && Math.abs(marks['a8'].x - 42) < 0.01, '中场盯人跟住最近目标');
  // 门将随球移动
  var kt = Behavior.keeperTarget(m, P(m, 'a1'));
  ok(kt.x !== P(m, 'a1').hx, '门将随球横向移动（不再钉死阵型点）');
  // 30 秒模拟：无球队员不再全员同步往返（位置方差大）
  var m2 = newMatch(62);
  for (var i = 0; i < 300; i++) m2.tick();
  var xs = m2.players.filter(function (p) { return p.team === 'home' && p.pos !== 'GK'; })
    .map(function (p) { return p.x; });
  var mean = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
  var sd = Math.sqrt(xs.reduce(function (a, x) { return a + (x - mean) * (x - mean); }, 0) / xs.length);
  ok(sd > 8, '跑位拉开层次（x 标准差 > 8 米）', sd.toFixed(1));
})();

console.log('== 传球 8 方向：DIRS/落点/自动选向一致（场地 +y 朝上） ==');
(function () {
  var Pass = require('../server/game/rules/pass');
  var m = newMatch(70);
  var passer = P(m, 'h10');
  set(m, 'h10', 50, 34);
  var names = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
  // 1) DIRS 与方向名一致：→(+x) ↗(+x+y) ↑(+y) ↖(-x+y) ←(-x) ↙(-x-y) ↓(-y) ↘(+x-y)
  var qx = [1, 1, 0, -1, -1, -1, 0, 1];
  var qy = [0, 1, 1, 1, 0, -1, -1, -1];
  for (var d = 0; d < 8; d++) {
    var dd = Pass.DIRS[d];
    ok(Math.sign(dd.dx) === qx[d] && Math.sign(dd.dy) === qy[d],
      'DIRS[' + d + ']=' + names[d] + ' 指向正确象限', JSON.stringify(dd));
  }
  // 2) computeLanding 落点沿所选方向偏移（短传 50% → 17 米）
  for (var d2 = 0; d2 < 8; d2++) {
    var land = Pass.computeLanding(passer, { kind: 'short', dir: d2, technique: 'inside', height: 'mid', power: 50 }, 80);
    ok(Math.sign(land.x - 50) === qx[d2] && Math.sign(land.y - 34) === qy[d2],
      '落点方向 dir=' + d2 + names[d2] + ' 正确', land.x.toFixed(1) + ',' + land.y.toFixed(1));
  }
  // 3) autoParams：四个斜向目标必须选中对应斜向（曾出现上下颠倒 bug）
  var diagCases = [
    { tx: 70, ty: 54, dir: 1, name: '↗' },
    { tx: 30, ty: 54, dir: 3, name: '↖' },
    { tx: 30, ty: 14, dir: 5, name: '↙' },
    { tx: 70, ty: 14, dir: 7, name: '↘' },
  ];
  diagCases.forEach(function (c) {
    m.bestPassTarget = function () { return { x: c.tx, y: c.ty }; };
    var pm = Pass.autoParams(m, passer);
    ok(pm.dir === c.dir, 'autoParams 目标' + c.name + ' 选中 dir=' + c.dir, '实际 dir=' + pm.dir);
  });
  // 4) 四个正向
  var cardCases = [
    { tx: 80, ty: 34, dir: 0, name: '→' },
    { tx: 50, ty: 64, dir: 2, name: '↑' },
    { tx: 20, ty: 34, dir: 4, name: '←' },
    { tx: 50, ty: 4, dir: 6, name: '↓' },
  ];
  cardCases.forEach(function (c) {
    m.bestPassTarget = function () { return { x: c.tx, y: c.ty }; };
    var pm = Pass.autoParams(m, passer);
    ok(pm.dir === c.dir, 'autoParams 目标' + c.name + ' 选中 dir=' + c.dir, '实际 dir=' + pm.dir);
  });
})();

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
