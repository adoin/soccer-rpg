// scripts/test-cutscene-prio.js
// 特写优先级测试（2026-10-11 试玩反馈：特写排队打断心流、进球特写被错过）：
//   高优先级特写（进球/红牌/点球）在窗口期内不被常规事件覆盖；
//   窗口过期后低优先级可正常覆盖；同级/低级可被高级覆盖。
'use strict';

var E = require('../server/game/engine');

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
function fakeAction(kind, label, cut) {
  return { kind: kind, label: label, playerName: '测试', team: 'home',
    success: true, text: 'x', cut: cut || null, until: Date.now() + 3000 };
}

// 1. 进球特写不被常规对决覆盖
(function () {
  var m = newMatch(1);
  m.setAction(fakeAction('goal', '进球！', 'shoot-goal'));
  var ret = m.setAction(fakeAction('dribble', '突破', 'dribble-win'));
  ok(m.lastAction.kind === 'goal', '进球特写不被突破特写覆盖');
  ok(ret === m.lastAction, 'setAction 返回当前显示的 action');
})();

// 2. 进球特写不被纯文字事件覆盖
(function () {
  var m = newMatch(2);
  m.setAction(fakeAction('goal', '进球！', 'shoot-goal'));
  m.setAction(fakeAction('intercept', '拦截', null));
  ok(m.lastAction.kind === 'goal', '进球特写不被拦截文字覆盖');
})();

// 3. 窗口过期后可被覆盖
(function () {
  var m = newMatch(3);
  var g = fakeAction('goal', '进球！', 'shoot-goal');
  g.until = Date.now() - 1; // 已过期
  m.lastAction = g;
  m.setAction(fakeAction('dribble', '突破', 'dribble-win'));
  ok(m.lastAction.kind === 'dribble', '过期后低优先级可覆盖');
})();

// 4. 红牌不被黄牌犯规覆盖，但可被进球覆盖
(function () {
  var m = newMatch(4);
  m.setAction(fakeAction('foul', '红牌', 'foul'));
  m.setAction(fakeAction('foul', '黄牌', 'foul'));
  ok(m.lastAction.label === '红牌', '红牌不被黄牌覆盖');
  m.setAction(fakeAction('goal', '进球！', 'shoot-goal'));
  ok(m.lastAction.kind === 'goal', '红牌可被进球覆盖');
})();

// 5. 同级可互相覆盖（常规对决之间）
(function () {
  var m = newMatch(5);
  m.setAction(fakeAction('dribble', '突破', 'dribble-win'));
  m.setAction(fakeAction('tackle', '上抢', 'dribble-lose'));
  ok(m.lastAction.kind === 'tackle', '同级对决可互相覆盖');
})();

// 6. 点球罚失（prio 90）不被越位覆盖
(function () {
  var m = newMatch(6);
  m.setAction(fakeAction('penalty', '点球罚失', 'shoot-save'));
  m.setAction(fakeAction('offside', '越位', 'offside'));
  ok(m.lastAction.kind === 'penalty', '点球特写不被越位覆盖');
})();

// 7. 真实路径：goal() 之后常规事件不顶掉
(function () {
  var m = newMatch(7);
  var scorer = m.byId['h10'];
  m.goal(scorer, 'home');
  ok(m.lastAction.kind === 'goal' && m.lastAction.prio === 100, 'goal() 写入 prio=100');
  m.setAction(fakeAction('throwin', '界外球', null));
  ok(m.lastAction.kind === 'goal', '进球后界外球不顶掉特写');
})();

// 8. prio 随状态序列化到客户端（客户端跳过逻辑依赖 until；prio 仅调试用，不断言传输细节，只断言字段存在）
(function () {
  var m = newMatch(8);
  m.setAction(fakeAction('goal', '进球！', 'shoot-goal'));
  ok(typeof m.lastAction.prio === 'number', 'action 带有 prio 字段');
})();

if (failures) { console.log('FAILURES: ' + failures); process.exit(1); }
console.log('ALL CUTSCENE PRIO TESTS PASSED');
