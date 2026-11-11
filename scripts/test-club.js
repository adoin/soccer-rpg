// 俱乐部经营：财务、合同、租借、青训、成长、体力惩罚、停赛。
'use strict';

var Career = require('../shared/career');
require('../shared/mods/amateur');
require('../shared/mods/example-cup');
var Club = require('../shared/mods/club');
var FM = require('../shared/fm');

var failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

var save = Career.newCareer(3);
Club.attach(save);
ok(save.schema === 2 && save.club && save.club.cash === save.budget, '新档带上俱乐部账本', save.schema);
ok(save.squad.every(function (p) { return p.contractEnd && p.condition === 100; }), '人人有合同和状态');
ok(Club.windowOpen(save), '业余联赛整季窗口开着');

var before = save.budget;
var bill = Club.wageBill(save);
var fx = Career.nextFixture(save.calendar, save.clubId);
Career.recordResult(save, fx.id, 1, 0);
ok(save.budget === before - bill + 800 + 400, '主场胜：扣工资、加门票和奖金', save.budget + ' bill ' + bill);
ok(save.club.history.length >= 3, '流水写下来了');

var kid = save.squad.filter(function (p) { return save.xi.indexOf(p.id) < 0; })[0];
var ask = Club.askWage(kid);
var yes = Club.renew(save, kid.id, ask, 2);
ok(yes.result === 'accept' && kid.contractEnd >= save.season + 1, '出到要价就续约', yes.result);
var no = Club.renew(save, kid.id, Math.round(ask * 0.5), 2);
ok(no.result === 'refuse', '出价太低会被拒绝', no.result);

var other = save.teams.filter(function (t) { return t.id !== save.clubId; })[0];
var target = other.squad[0];
var cheap = Club.offerFor(save, other.id, target.id, 10);
ok(cheap.result === 'refuse' || cheap.result === 'counter', '低报价买不到', cheap.result);
var deal = Club.offerFor(save, other.id, target.id, cheap.want || target.fee || 5000);
ok(deal.result === 'accept' || deal.ok === false, '加钱有结果', JSON.stringify(deal).slice(0, 80));

var spare = save.squad.filter(function (p) { return save.xi.indexOf(p.id) < 0 && !(p.loan && p.loan.dir); })[0];
var lent = Club.loanOut(save, spare.id, other.id, 1, 0.5);
ok(lent.ok && Club.unavailable(spare).indexOf('外租') >= 0, '租出去就不能进自己的名单');
Club.matchday(save, { date: (save.club.date || 0) + 1, homeId: 'x', awayId: 'y', hg: 0, ag: 0 });
ok(!spare.loan, '租借一场后到期回来');

var youth = Club.intake(save, Career && (function () {
  var a = 9;
  return function () { a = (a * 17 + 3) % 1000; return a / 1000; };
})());
ok(youth.length === 3 && save.club.academy.players.length >= 3, '一年进三个青训', youth.length);
var up = Club.promote(save, youth[0].id);
ok(up.ok && save.squad.indexOf(up.player) >= 0, '青训可以提拔');

var young = save.squad.filter(function (p) { return p.age < 23; })[0];
young.potential = 10;
young.stats.passing = 4;
young.ovr = 4;
Club.trainOne(young, 'technical', 2, 0.2);
ok(young.stats.passing >= 4, '年轻球员训练不掉技术');
var old = save.squad.filter(function (p) { return p.age >= 30; })[0];
if (!old) { old = save.squad[0]; old.age = 32; }
old.stats.pace = 6;
Club.trainOne(old, 'physical', 0, 0);
ok(old.stats.pace <= 6, '30 岁以后身体训练不会变强', old.stats.pace);
ok(old.growth && (old.growth.pace === -1 || old.growth.pace === 0 || old.growth.pace === 1), '成长箭头有记录');

var fresh = { stats: { pace: 10 }, stamina: 100, maxStamina: 100, condition: 100, morale: 70 };
var tired = { stats: { pace: 10 }, stamina: 10, maxStamina: 100, condition: 40, morale: 40 };
ok(FM.fitness(tired) < FM.fitness(fresh) * 0.75, '没体力时属性打折', FM.fitness(tired).toFixed(2));
ok(FM.v(tired, 'pace') < FM.v(fresh, 'pace'), '速度属性跟着掉');

var banned = save.squad[0];
banned.ban = 1;
var xi = save.xi.slice();
save.xi = Career.autoXI(save.squad);
ok(save.xi.indexOf(banned.id) < 0, '停赛的人排不进首发');
ok(Career.lineupPlayers(save.squad, xi) === null, '硬塞停赛的人，首发无效');
banned.ban = 0;

var mem = { bag: {}, setItem: function (k, v) { this.bag[k] = String(v); }, getItem: function (k) { return this.bag[k] || null; }, removeItem: function (k) { delete this.bag[k]; } };
ok(Career.writeSlot(mem, '1', save).ok, '新档能写入');
var back = Career.loadSlot(mem, '1');
ok(back.ok && back.career.schema === 2 && back.career.club && back.career.club.history.length >= 1, '读档带回财务流水');

console.log(failures ? failures + ' FAILED' : 'ALL CLUB TESTS PASSED');
process.exit(failures ? 1 : 0);
