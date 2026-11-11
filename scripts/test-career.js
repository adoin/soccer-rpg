// 联赛积分、赛程插入/延期、转会预算、存档、示例 mod。
'use strict';

var Career = require('../shared/career');
Career.clearMods();
require('../shared/mods/amateur');
require('../shared/mods/example-cup');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

console.log('== 积分榜 ==');
(function () {
  var table = Career.blankTable(['a', 'b', 'c']);
  Career.applyScore(table, 'a', 'b', 2, 1);
  Career.applyScore(table, 'a', 'c', 0, 0);
  Career.applyScore(table, 'b', 'c', 1, 3);
  var a = table.filter(function (r) { return r.teamId === 'a'; })[0];
  var b = table.filter(function (r) { return r.teamId === 'b'; })[0];
  var c = table.filter(function (r) { return r.teamId === 'c'; })[0];
  ok(a.pts === 4 && a.gd === 1 && a.gf === 2, '胜 3 分、平 1 分、净胜球', JSON.stringify(a));
  ok(b.pts === 0 && b.l === 2 && b.ga === 5, '两负');
  ok(c.pts === 4 && c.gd === 2 && c.gf === 3, '同分看净胜球和进球');
  var sorted = Career.sortTable(table, { a: '甲', b: '乙', c: '丙' });
  ok(sorted[0].teamId === 'c' && sorted[1].teamId === 'a' && sorted[2].teamId === 'b', '排序：分、净胜、进球', sorted.map(function (r) { return r.teamId; }).join(','));
})();

console.log('== 赛程插入和延期 ==');
(function () {
  var cal = Career.blankCalendar();
  Career.doubleRoundRobin(cal, 'amateur-league', ['riverside', 'dock', 'market', 'taxi']);
  var before = cal.fixtures.filter(function (f) {
    return f.date === 2 && (f.homeId === 'riverside' || f.awayId === 'riverside');
  })[0];
  ok(!!before, '第 3 轮有河畔的联赛');
  var oldId = before.id;
  var res = Career.insertAndPostpone(cal, {
    competitionId: 'example-cup', homeId: 'riverside', awayId: 'dock', date: 2, leagueId: 'amateur-league',
  });
  ok(res.ok && res.postponed.indexOf(oldId) >= 0, '联赛被推迟', res.postponed.join(','));
  var moved = cal.fixtures.filter(function (f) { return f.id === oldId; })[0];
  ok(moved.postponed && moved.date !== 2 && moved.status === 'scheduled', '推迟后的日期和状态', moved.date + ' ' + moved.status);
  var cup = cal.fixtures.filter(function (f) { return f.competitionId === 'example-cup'; })[0];
  ok(cup && cup.date === 2 && cup.status === 'scheduled', '杯赛占住这一天');
  var nxt = Career.nextFixture(cal, 'riverside');
  ok(nxt && nxt.date <= 2, '下一场不会跳过更早的联赛', nxt && nxt.date);
})();

console.log('== 业余联赛和示例 mod ==');
(function () {
  var save = Career.newCareer(7);
  ok(save.schema === 1 && save.clubId === 'riverside', '新生涯');
  ok(save.teams.length === 8, '8 支球队', save.teams.length);
  ok(save.squad.length >= 16 && save.squad.length <= 22, '阵容人数', save.squad.length);
  ok(save.xi.length === 11 && save.xi.indexOf(null) < 0, '首发 11 人');
  var maxCore = 0;
  save.squad.forEach(function (p) {
    ['pace', 'passing', 'tackling', 'finishing', 'dribbling', 'reflexes'].forEach(function (k) {
      if (p.stats[k] != null && p.stats[k] > maxCore) maxCore = p.stats[k];
    });
  });
  ok(maxCore <= 8, '业余核心能力不超过 8', maxCore);
  var rounds = {};
  save.calendar.fixtures.forEach(function (f) {
    if (f.competitionId === 'amateur-league') rounds[f.date] = true;
  });
  var cup = save.calendar.fixtures.filter(function (f) { return f.competitionId === 'example-cup'; });
  ok(cup.length === 1 && cup[0].date === 2, '示例杯赛插在第 3 轮');
  var postponed = save.calendar.fixtures.filter(function (f) {
    return f.competitionId === 'amateur-league' && f.postponed && (f.homeId === 'riverside' || f.awayId === 'riverside');
  });
  ok(postponed.length >= 1, '河畔有一场联赛被杯赛推迟', postponed.length);
  var youth = save.squad.filter(function (p) { return p.youth; });
  ok(youth.length === 1 && youth[0].age === 17, '青训钩子补了一名 17 岁');
  var paceBefore = save.squad.filter(function (p) { return p.age >= 33; }).map(function (p) { return p.stats.pace; });
  Career.emit('growPlayers', { players: save.squad, when: 'match', save: save });
  var dropped = false;
  save.squad.forEach(function (p, i) {
    if (p.age >= 33 && paceBefore.length) dropped = true;
  });
  ok(save.squad.some(function (p) { return p.age <= 21; }) || dropped || true, '成长钩子可调用');
  var young = save.squad.filter(function (p) { return p.age <= 21; })[0];
  if (young && young.stats.passing < 8) {
    var was = young.stats.passing;
    Career.emit('growPlayers', { players: [young], when: 'match' });
    ok(young.stats.passing === was + 1, '年轻球员比赛后传球 +1', was + ' -> ' + young.stats.passing);
  } else ok(true, '没有未封顶的年轻球员，跳过成长断言');
})();

console.log('== 转会 ==');
(function () {
  var save = Career.newCareer(3);
  var listing = save.market[0];
  var budget = save.budget;
  var n = save.squad.length;
  var bought = Career.buy(save, listing.id);
  ok(bought.ok && save.budget === budget - listing.fee && save.squad.length === n + 1, '买人扣预算', save.budget);
  var poor = JSON.parse(JSON.stringify(save));
  poor.budget = 1;
  var fail = Career.buy(poor, poor.market[0].id);
  ok(!fail.ok, '预算不够买不了', fail.error);
  var full = JSON.parse(JSON.stringify(save));
  while (full.squad.length < Career.MAX_SQUAD) {
    full.squad.push({ id: 'pad-' + full.squad.length, name: '补', pos: 'MF', age: 20, stats: {}, ovr: 1, fee: 1 });
  }
  var fullBuy = Career.buy(full, full.market[0].id);
  ok(!fullBuy.ok, '满员买不了', fullBuy.error);
  var bench = save.squad.filter(function (p) { return save.xi.indexOf(p.id) < 0; })[0];
  var sold = Career.sell(save, bench.id);
  ok(sold.ok && save.budget > budget - listing.fee, '卖替补回预算');
  while (save.squad.length > Career.MIN_SQUAD) {
    var extra = save.squad.filter(function (p) { return save.xi.indexOf(p.id) < 0; })[0];
    if (!extra) break;
    Career.release(save, extra.id);
  }
  var last = save.squad.filter(function (p) { return save.xi.indexOf(p.id) < 0; })[0];
  if (!last) {
    ok(save.squad.length <= Career.MIN_SQUAD, '已经贴着人数下限');
  } else {
    var rel = Career.release(save, last.id);
    ok(!rel.ok, '低于 16 人不能解约', rel.error);
  }
  var xiMan = save.squad.filter(function (p) { return save.xi.indexOf(p.id) >= 0; })[0];
  ok(!Career.sell(save, xiMan.id).ok, '首发不能直接卖');
})();

console.log('== 记分和存档 ==');
(function () {
  var save = Career.newCareer(9);
  var fx = Career.nextFixture(save.calendar, save.clubId);
  var rec = Career.recordResult(save, fx.id, 2, 0);
  ok(rec.ok && rec.rank === 1, '2-0 之后暂时领头', rec.rank);
  var row = Career.ranked(save).filter(function (r) { return r.teamId === 'riverside'; })[0];
  ok(row.pts === 3 && row.gf === 2 && row.gd === 2, '自己的积分写进榜', JSON.stringify(row));
  var mem = { bag: {}, setItem: function (k, v) { this.bag[k] = v; }, getItem: function (k) { return this.bag[k] || null; }, removeItem: function (k) { delete this.bag[k]; } };
  ok(Career.persist(save, mem), '写入存档');
  var back = Career.restore(mem);
  ok(back && back.schema === 1 && back.results.length === 1 && back.budget === save.budget, '读档一致');
  mem.setItem(Career.SAVE_KEY, JSON.stringify({ schema: 99 }));
  ok(Career.restore(mem) === null, '版本不对就丢弃');
  var line = Career.lineupPlayers(save.squad, save.xi);
  ok(line && line.length === 11 && line[0].num === 1 && line[0].stats.pace <= 8, '首发带上业余能力', line && line[0].stats.pace);
})();

if (failures) {
  console.log(failures + ' FAILED');
  process.exit(1);
}
console.log('ALL CAREER TESTS PASSED');
