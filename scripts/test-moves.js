// 突破二级动作、无人时突然加速、防守技能、黄红牌。
'use strict';

var E = require('../server/game/engine');
var Foul = require('../server/game/rules/foul');
var Moves = require('../shared/moves');

var failed = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  PASS ' + name);
  else { failed++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

function fresh(seed) {
  var m = new E.Match('mv' + seed, { seed: seed, halfLength: 60 });
  m.destroy();
  m.phase = 'play';
  m.now = 8000;
  m.aiCooldownUntil = 1e15;
  m.nextDecisionAt = 1e15;
  m.nextDefDecisionAt = 1e15;
  m.players.forEach(function (p) {
    p.x = p.team === 'home' ? 16 : 94;
    p.y = 8 + (p.num % 10) * 5;
  });
  return m;
}

console.log('== 突然加速：没人时只位移，不播突破 ==');
(function () {
  var m = fresh(1);
  var h = m.byId.h10;
  h.x = 40; h.y = 34;
  m.ball.ownerId = 'h10'; m.ball.x = 41; m.ball.y = 34;
  var opts = m.buildOptions(h);
  var drib = opts.filter(function (o) { return o.id === 'dribble'; })[0];
  ok(drib && drib.moves && drib.moves[0].name === '突然加速', '突破下面有突然加速');
  ok(drib.moves.some(function (mv) { return mv.id === 'feint'; }), '10 号学过假动作');
  ok(!opts.some(function (o) { return o.id === 'feint'; }), '假动作不在顶层菜单');
  var plain = m.buildOptions(m.byId.h3);
  ok(plain.filter(function (o) { return o.id === 'dribble'; })[0].moves.length === 1, '没学过的人只有突然加速');
  m.phase = 'decision';
  m.decision = { playerId: 'h10', options: opts };
  var x0 = h.x;
  var r = m.applyCommand('h10', 'burst');
  ok(r.ok && m.lastAction.cut === null, '无人时没有突破分镜', m.lastAction && m.lastAction.cut);
  ok(m.lastAction.text.indexOf('突然加速') >= 0 && m.lastAction.text.indexOf('没有人') >= 0, '文案是突然加速', m.lastAction.text);
  ok(h.x > x0 + 3, '人往前冲了', h.x);
  ok(m.phase === 'play', '结算后回到比赛');
  var again = m.applyCommand('h10', 'burst');
  ok(again.ok === false, '同一次选择不能再结算一次');
})();

console.log('== 有人贴身时突然加速才会过人 ==');
(function () {
  var m = fresh(2);
  var h = m.byId.h10;
  h.x = 40; h.y = 34;
  m.byId.a4.x = 42; m.byId.a4.y = 34;
  m.ball.ownerId = 'h10'; m.ball.x = 41; m.ball.y = 34;
  m.phase = 'decision';
  m.decision = { playerId: 'h10', options: m.buildOptions(h) };
  m.resolveAction(h, 'burst', 100);
  ok(m.lastAction.cut === 'dribble-win', '贴身突然加速成功才播突破', m.lastAction.cut);
})();

console.log('== 防守技能 ==');
(function () {
  var m = fresh(3);
  var def = m.byId.h4;
  var atk = m.byId.a10;
  atk.x = 60; atk.y = 34;
  def.x = 58; def.y = 34;
  m.ball.ownerId = 'a10'; m.ball.x = 60; m.ball.y = 34;
  var skills = m.defSkillOptions(def, atk);
  ok(skills.length === 4, '后卫四个技能', skills.map(function (s) { return s.name; }).join(','));
  ok(skills.every(function (s) { return s.enabled; }), '贴身时都能出');
  def.beatenUntil = m.now + 5000;
  var beaten = m.defSkillOptions(def, atk);
  var sweep = beaten.filter(function (s) { return s.id === 'def-sweep'; })[0];
  var fly = beaten.filter(function (s) { return s.id === 'def-flying'; })[0];
  ok(sweep.enabled && !fly.enabled, '被过掉后只有横扫还能出');
  def.beatenUntil = 0;
  var sk = Object.assign({}, Moves.DEF_SKILLS.sweep, { foul: 0, power: 40 });
  def.beatenUntil = m.now + 5000;
  m.resolveDefSkill(def, atk, sk);
  ok(m.ball.ownerId === 'h4' && m.lastAction.cut === 'def-skill-sweep', '横扫在被过掉后仍能断球', m.lastAction && m.lastAction.cut);
  ok(m.lastAction.text.indexOf('横扫千军') >= 0, '横扫文案');
  var m2 = fresh(4);
  m2.byId.h4.x = 50; m2.byId.a10.x = 70; m2.byId.a10.y = 34; m2.byId.h4.y = 34;
  m2.ball.ownerId = 'a10';
  m2.resolveDefSkill(m2.byId.h4, m2.byId.a10, Moves.DEF_SKILLS.flying);
  ok(m2.lastAction.cut === null && m2.ball.ownerId === 'a10', '够不着的飞铲不播分镜也不断球');
  ['flying', 'sweep', 'shoulder', 'elbow'].forEach(function (key) {
    var mm = fresh(9);
    // 技能名不是数字种子，比赛会改用当前时间，断言会时好时坏。这里固定掷骰为成功断球。
    mm.rng = function () { return 0; };
    var info = mm.debugPose(key === 'flying' ? 'fly' : key);
    var cut = Moves.DEF_SKILLS[key].cut;
    ok(info.cut === cut && info.owner === 'h4', key + ' 断球并播自己的分镜', info.cut);
  });
})();

console.log('== 黄牌红牌 ==');
(function () {
  var m = fresh(5);
  m.rng = function () { return 0; };
  var mild = Foul.judgeFoul(m, m.byId.a4, m.byId.h10, {});
  var hard = Foul.judgeFoul(m, m.byId.a4, m.byId.h10, { reckless: true, cardBias: 20, speedHigh: true });
  ok(hard.severity > mild.severity, '鲁莽技能犯规更重', mild.severity + ' -> ' + hard.severity);
  var y = fresh(6).debugPose('yellow');
  ok(y.cut === null && y.text.indexOf('🟨 黄牌！') === 0 && y.sentOff === false, '黄牌文案且人不下场', y.text);
  ok(y.text.indexOf('获得直接任意球') >= 0, '黄牌给出任意球');
  var rd = fresh(7).debugPose('red');
  ok(rd.cut === null && rd.sentOff === true && rd.awayOn === 10, '红牌罚下，对方剩 10 人', rd.text + ' on=' + rd.awayOn);
  ok(rd.text.indexOf('🟥 红牌！') === 0 && rd.text.split('青鹰高校').length === 2, '红牌队名只出现一次', rd.text);
  var m3 = fresh(8);
  var d = m3.byId.a2;
  d.cards.yellow = 1;
  var f = Foul.judgeFoul(m3, d, m3.byId.h10, {});
  f.card = 'yellow';
  Foul.applyCards(f);
  ok(f.card === 'red' && d.sentOff === true, '两黄变一红并罚下');
})();

console.log(failed ? ('\n' + failed + ' FAILED') : '\nALL MOVE TESTS PASSED');
process.exit(failed ? 1 : 0);
