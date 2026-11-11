// 内置 mod：业余联赛。数值压在 3–8，和演示阵容的 10–17 拉开。
(function (root, factory) {
  var Career = (typeof module !== 'undefined' && module.exports) ? require('../career') : root.Career;
  var mod = factory(Career);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.SoccerModAmateur = mod;
})(typeof self !== 'undefined' ? self : this, function (Career) {
  'use strict';

  var CLUBS = [
    { id: 'riverside', name: '河畔业余', strength: 5 },
    { id: 'dock', name: '码头工人', strength: 4 },
    { id: 'market', name: '菜市场联', strength: 3 },
    { id: 'taxi', name: '夜班出租', strength: 6 },
    { id: 'warehouse', name: '旧仓库', strength: 4 },
    { id: 'garage', name: '河边修车', strength: 7 },
    { id: 'clinic', name: '社区医院', strength: 5 },
    { id: 'print', name: '印刷厂', strength: 6 },
  ];
  var XING = ['赵', '钱', '孙', '李', '周', '吴', '郑', '王', '冯', '陈', '褚', '卫', '蒋', '沈', '韩', '杨'];
  var MING = ['小海', '阿强', '大牛', '建国', '志国', '小平', '勇', '磊', '洋', '超', '军', '杰', '涛', '明', '辉', '鹏'];
  var OUT = ['pace', 'acceleration', 'agility', 'strength', 'jumping', 'stamina', 'balance', 'dribbling', 'passing', 'finishing', 'longShots', 'tackling', 'marking', 'heading', 'technique', 'firstTouch', 'crossing', 'corners', 'longPassing', 'freeKicks', 'setPieces', 'decisions', 'anticipation', 'offBall', 'positioning', 'vision', 'composure', 'determination', 'aggression', 'bravery', 'teamwork'];
  var GK = ['aerial', 'command', 'handling', 'kicking', 'oneOnOne', 'reflexes', 'rushing', 'throwing'];
  var SHAPE = { GK: 2, DF: 5, MF: 5, FW: 4 };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function statBlock(rng, pos, strength) {
    var base = clamp(2 + strength, 3, 6);
    var s = {};
    OUT.forEach(function (k) { s[k] = clamp(base + Math.floor(rng() * 3) - 1, 3, 8); });
    GK.forEach(function (k) { s[k] = pos === 'GK' ? clamp(base + 1 + Math.floor(rng() * 2), 4, 8) : clamp(2 + Math.floor(rng() * 2), 2, 4); });
    if (pos === 'GK') { s.reflexes = clamp(s.reflexes + 1, 4, 8); s.handling = clamp(s.handling + 1, 4, 8); }
    if (pos === 'DF') { s.tackling = clamp(s.tackling + 1, 4, 8); s.marking = clamp(s.marking + 1, 4, 8); }
    if (pos === 'MF') { s.passing = clamp(s.passing + 1, 4, 8); s.stamina = clamp(s.stamina + 1, 4, 8); }
    if (pos === 'FW') { s.finishing = clamp(s.finishing + 1, 4, 8); s.pace = clamp(s.pace + 1, 4, 8); }
    return s;
  }
  function ovr(p) {
    var s = p.stats;
    var keys = p.pos === 'GK' ? ['reflexes', 'handling', 'aerial', 'kicking'] : ['pace', 'passing', 'tackling', 'finishing', 'dribbling'];
    var t = 0;
    keys.forEach(function (k) { t += s[k] || 0; });
    return Math.round(t / keys.length);
  }
  function makePlayer(rng, club, pos, n) {
    var name = XING[Math.floor(rng() * XING.length)] + MING[Math.floor(rng() * MING.length)];
    var age = 18 + Math.floor(rng() * 18);
    var stats = statBlock(rng, pos, club.strength);
    var p = { id: club.id + '-' + n, name: name, age: age, pos: pos, stats: stats, clubId: club.id, level: 1 };
    p.ovr = ovr(p);
    p.fee = 400 + p.ovr * 700;
    p.wage = 40 + p.ovr * 15;
    return p;
  }
  function makeSquad(rng, club) {
    var squad = [];
    var n = 1;
    Object.keys(SHAPE).forEach(function (pos) {
      for (var i = 0; i < SHAPE[pos]; i++) squad.push(makePlayer(rng, club, pos, n++));
    });
    return squad;
  }

  var mod = {
    id: 'amateur-league',
    name: '业余联赛',
    hooks: {
      competitions: function (ctx) {
        ctx.competitions.push({
          id: 'amateur-league',
          name: '业余联赛',
          kind: 'league',
          teams: 8,
          points: { win: 3, draw: 1, loss: 0 },
          tiebreak: ['pts', 'gd', 'gf'],
        });
      },
      onSeasonStart: function (ctx) {
        var save = ctx.save;
        var rng = ctx.rng;
        save.clubId = 'riverside';
        save.budget = save.budget && ctx.rollover ? save.budget : 35000;
        save.teams = CLUBS.map(function (c) {
          return { id: c.id, name: c.name, strength: c.strength, squad: makeSquad(rng, c) };
        });
        var mine = null;
        save.teams.forEach(function (t) { if (t.id === save.clubId) mine = t; });
        save.squad = mine.squad.map(function (p) {
          var q = JSON.parse(JSON.stringify(p));
          return q;
        });
        save.xi = Career.autoXI(save.squad);
        save.calendar = Career.blankCalendar();
        Career.doubleRoundRobin(save.calendar, 'amateur-league', CLUBS.map(function (c) { return c.id; }));
        save.table = Career.blankTable(CLUBS.map(function (c) { return c.id; }));
        save.market = [];
        CLUBS.forEach(function (c) {
          if (c.id === save.clubId) return;
          var team = null;
          save.teams.forEach(function (t) { if (t.id === c.id) team = t; });
          var pool = team.squad.slice().sort(function (a, b) { return a.ovr - b.ovr; });
          pool.slice(0, 1).forEach(function (p) {
            save.market.push({ id: 'm-' + p.id, fee: p.fee, wage: p.wage, player: JSON.parse(JSON.stringify(p)) });
          });
        });
        for (var k = 0; k < 4; k++) {
          var fa = makePlayer(rng, { id: 'free', strength: 3 + (k % 3), name: '自由身' }, ['DF', 'MF', 'FW', 'GK'][k], 100 + k);
          fa.clubId = null;
          fa.fee = Math.max(300, fa.fee - 800);
          save.market.push({ id: 'm-' + fa.id, fee: fa.fee, wage: fa.wage, player: fa });
        }
      },
    },
  };

  if (Career && Career.registerMod) Career.registerMod(mod);
  return mod;
});
