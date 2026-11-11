// 生涯层：联赛表、赛程（可插入、可延期）、转会、存档、mod 钩子。
// 不改比赛引擎的默认对局。职业模式把选好的阵容交给 Match。
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Career = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA = 1;
  var SAVE_KEY = 'soccer-rpg-career';
  var MIN_SQUAD = 16;
  var MAX_SQUAD = 22;
  var HOOKS = [
    'competitions',   // 登记联赛 / 杯赛规则
    'onSeasonStart',  // 生成赛季：球队、积分榜、联赛赛程
    'schedule',       // 插入或延期赛程（杯赛打乱联赛）
    'transferMarket', // 补转会名单
    'onMatchPlayed',  // 一场打完
    'growPlayers',    // 成长 / 衰退
    'youthIntake',    // 青训入队
  ];

  var mods = [];

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function find(list, id, key) {
    key = key || 'id';
    for (var i = 0; i < list.length; i++) if (list[i][key] === id) return list[i];
    return null;
  }

  function registerMod(mod) {
    if (!mod || !mod.id) throw new Error('mod 需要 id');
    mods = mods.filter(function (m) { return m.id !== mod.id; });
    mods.push(mod);
    return mod;
  }
  function clearMods() { mods = []; }
  function listMods() { return mods.map(function (m) { return { id: m.id, name: m.name || m.id }; }); }
  function emit(hook, ctx) {
    var out = [];
    mods.forEach(function (m) {
      var fn = m.hooks && m.hooks[hook];
      if (typeof fn === 'function') out.push(fn(ctx));
    });
    return out;
  }

  // ---------- 赛程 ----------
  function blankCalendar() { return { seq: 1, fixtures: [] }; }

  function addFixture(cal, spec) {
    var f = {
      id: 'f' + (cal.seq++),
      competitionId: spec.competitionId,
      round: spec.round == null ? 0 : spec.round,
      homeId: spec.homeId,
      awayId: spec.awayId,
      date: spec.date,
      status: 'scheduled',
      postponed: false,
      hg: null,
      ag: null,
    };
    cal.fixtures.push(f);
    return f;
  }

  function maxDate(cal) {
    var m = 0;
    cal.fixtures.forEach(function (f) { if (f.date > m) m = f.date; });
    return m;
  }

  function postpone(cal, fixtureId, newDate) {
    var f = find(cal.fixtures, fixtureId);
    if (!f) return { ok: false, error: '没有这场比赛' };
    if (f.status === 'played') return { ok: false, error: '已经踢完' };
    f.date = newDate;
    f.postponed = true;
    f.status = 'scheduled';
    return { ok: true, fixture: f };
  }

  // 在某一天插入一场，并把当天牵扯到的联赛场次推到赛程末尾。
  function insertAndPostpone(cal, spec) {
    var leagueId = spec.leagueId || 'amateur-league';
    var bumped = [];
    var involved = {};
    involved[spec.homeId] = true;
    involved[spec.awayId] = true;
    cal.fixtures.forEach(function (f) {
      if (f.status !== 'scheduled' || f.competitionId !== leagueId || f.date !== spec.date) return;
      if (!involved[f.homeId] && !involved[f.awayId]) return;
      f.date = maxDate(cal) + 1;
      f.postponed = true;
      bumped.push(f.id);
    });
    var created = addFixture(cal, spec);
    return { ok: true, fixture: created, postponed: bumped };
  }

  function nextFixture(cal, teamId) {
    var best = null;
    cal.fixtures.forEach(function (f) {
      if (f.status !== 'scheduled') return;
      if (f.homeId !== teamId && f.awayId !== teamId) return;
      if (!best || f.date < best.date || (f.date === best.date && f.id < best.id)) best = f;
    });
    return best;
  }

  function roundRobin(ids) {
    var teams = ids.slice();
    if (teams.length % 2) teams.push(null);
    var n = teams.length;
    var half = n / 2;
    var dates = [];
    for (var r = 0; r < n - 1; r++) {
      var pairs = [];
      for (var i = 0; i < half; i++) {
        var a = teams[i], b = teams[n - 1 - i];
        if (a && b) pairs.push(r % 2 ? [b, a] : [a, b]);
      }
      dates.push(pairs);
      var rest = teams.slice(1);
      rest.unshift(rest.pop());
      teams = [teams[0]].concat(rest);
    }
    return dates;
  }

  function doubleRoundRobin(cal, competitionId, ids) {
    var first = roundRobin(ids);
    var second = first.map(function (pairs) {
      return pairs.map(function (p) { return [p[1], p[0]]; });
    });
    var all = first.concat(second);
    all.forEach(function (pairs, date) {
      pairs.forEach(function (p) {
        addFixture(cal, { competitionId: competitionId, round: date + 1, homeId: p[0], awayId: p[1], date: date });
      });
    });
    return all.length;
  }

  // ---------- 积分榜 ----------
  function blankTable(ids) {
    return ids.map(function (id) {
      return { teamId: id, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
    });
  }
  function row(table, id) {
    var r = find(table, id, 'teamId');
    if (!r) throw new Error('积分榜没有 ' + id);
    return r;
  }
  function applyScore(table, homeId, awayId, hg, ag) {
    hg = hg | 0; ag = ag | 0;
    var h = row(table, homeId), a = row(table, awayId);
    h.p++; a.p++;
    h.gf += hg; h.ga += ag; a.gf += ag; a.ga += hg;
    h.gd = h.gf - h.ga; a.gd = a.gf - a.ga;
    if (hg > ag) { h.w++; h.pts += 3; a.l++; }
    else if (hg < ag) { a.w++; a.pts += 3; h.l++; }
    else { h.d++; a.d++; h.pts += 1; a.pts += 1; }
    return table;
  }
  function sortTable(table, names) {
    names = names || {};
    return table.slice().sort(function (a, b) {
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      var na = names[a.teamId] || a.teamId;
      var nb = names[b.teamId] || b.teamId;
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
  }
  function teamName(save, id) {
    var t = find(save.teams, id);
    return t ? t.name : id;
  }
  function nameMap(save) {
    var m = {};
    (save.teams || []).forEach(function (t) { m[t.id] = t.name; });
    return m;
  }
  function ranked(save) {
    return sortTable(save.table, nameMap(save));
  }
  function rankOf(save, teamId) {
    var list = ranked(save);
    for (var i = 0; i < list.length; i++) if (list[i].teamId === teamId) return i + 1;
    return null;
  }

  // ---------- 转会 ----------
  function buy(save, listingId) {
    var L = find(save.market, listingId);
    if (!L) return { ok: false, error: '名单上没有这名球员' };
    if (save.budget < L.fee) return { ok: false, error: '预算不够' };
    if (save.squad.length >= MAX_SQUAD) return { ok: false, error: '阵容已满（最多 ' + MAX_SQUAD + ' 人）' };
    save.budget -= L.fee;
    var player = L.player;
    player.clubId = save.clubId;
    save.squad.push(player);
    save.market = save.market.filter(function (x) { return x.id !== listingId; });
    (save.teams || []).forEach(function (t) {
      if (!t.squad) return;
      t.squad = t.squad.filter(function (p) { return p.id !== player.id; });
    });
    return { ok: true, player: player };
  }
  function inXI(save, playerId) {
    return (save.xi || []).indexOf(playerId) >= 0;
  }
  function removeFromSquad(save, playerId, refund) {
    if (save.squad.length <= MIN_SQUAD) return { ok: false, error: '阵容不能少于 ' + MIN_SQUAD + ' 人' };
    if (inXI(save, playerId)) return { ok: false, error: '先换下首发' };
    var p = find(save.squad, playerId);
    if (!p) return { ok: false, error: '队里没有这名球员' };
    save.squad = save.squad.filter(function (q) { return q.id !== playerId; });
    if (refund) save.budget += (p.fee || 0);
    return { ok: true, player: p };
  }
  function sell(save, playerId) { return removeFromSquad(save, playerId, true); }
  function release(save, playerId) { return removeFromSquad(save, playerId, false); }

  var XI_SLOTS = [
    { num: 1, pos: 'GK' },
    { num: 2, pos: 'DF' }, { num: 3, pos: 'DF' }, { num: 4, pos: 'DF' }, { num: 5, pos: 'DF' },
    { num: 6, pos: 'MF' }, { num: 8, pos: 'MF' }, { num: 7, pos: 'MF' }, { num: 10, pos: 'MF' }, { num: 11, pos: 'MF' },
    { num: 9, pos: 'FW' },
  ];

  function autoXI(squad) {
    var used = {};
    var ids = [];
    XI_SLOTS.forEach(function (slot) {
      var pick = null;
      squad.forEach(function (p) {
        if (used[p.id] || p.pos !== slot.pos) return;
        if (!pick || (p.ovr || 0) > (pick.ovr || 0)) pick = p;
      });
      if (!pick) {
        squad.forEach(function (p) {
          if (used[p.id] || p.pos === 'GK') return;
          if (!pick) pick = p;
        });
      }
      if (pick) { used[pick.id] = true; ids.push(pick.id); }
      else ids.push(null);
    });
    return ids;
  }

  function cycleXI(save, slotIndex) {
    var slot = XI_SLOTS[slotIndex];
    if (!slot) return { ok: false, error: '没有这个位置' };
    var cur = save.xi[slotIndex];
    var pool = save.squad.filter(function (p) {
      if (p.pos !== slot.pos) return false;
      var at = save.xi.indexOf(p.id);
      return at < 0 || at === slotIndex;
    });
    if (!pool.length) return { ok: false, error: '没有可换的' + slot.pos };
    var i = 0;
    pool.forEach(function (p, idx) { if (p.id === cur) i = idx; });
    var next = pool[(i + 1) % pool.length];
    save.xi[slotIndex] = next.id;
    return { ok: true, player: next };
  }

  function lineupPlayers(squad, xi) {
    var out = [];
    for (var i = 0; i < XI_SLOTS.length; i++) {
      var p = find(squad, xi[i]);
      if (!p) return null;
      out.push({
        num: XI_SLOTS[i].num,
        name: p.name,
        pos: XI_SLOTS[i].pos,
        level: p.level || 1,
        stats: p.stats,
        special: null,
        shots: [],
      });
    }
    return out;
  }

  function simRestOfDate(save, date, skipId) {
    var rng = mulberry32((save.seed + date * 97 + save.season * 13) >>> 0);
    save.calendar.fixtures.forEach(function (f) {
      if (f.id === skipId || f.status === 'played' || f.date !== date) return;
      if (f.competitionId !== 'amateur-league') return;
      var th = find(save.teams, f.homeId);
      var ta = find(save.teams, f.awayId);
      var sh = th ? th.strength : 5;
      var sa = ta ? ta.strength : 5;
      var lean = (sh - sa) * 0.35;
      var hg = clamp(Math.floor(rng() * 3 + lean + 0.4), 0, 5);
      var ag = clamp(Math.floor(rng() * 3 - lean + 0.4), 0, 5);
      f.status = 'played';
      f.hg = hg; f.ag = ag;
      applyScore(save.table, f.homeId, f.awayId, hg, ag);
    });
  }

  function recordResult(save, fixtureId, hg, ag) {
    var f = find(save.calendar.fixtures, fixtureId);
    if (!f) return { ok: false, error: '赛程里没有这场' };
    if (f.status === 'played') return { ok: false, error: '已经记过分' };
    f.status = 'played';
    f.hg = hg | 0;
    f.ag = ag | 0;
    if (f.competitionId === 'amateur-league') applyScore(save.table, f.homeId, f.awayId, f.hg, f.ag);
    save.results.push({ id: f.id, competitionId: f.competitionId, hg: f.hg, ag: f.ag });
    simRestOfDate(save, f.date, f.id);
    emit('onMatchPlayed', { save: save, fixture: f, hg: f.hg, ag: f.ag });
    emit('growPlayers', { save: save, players: save.squad, when: 'match' });
    var done = !nextFixture(save.calendar, save.clubId);
    return { ok: true, done: done, rank: rankOf(save, save.clubId), table: ranked(save) };
  }

  function newCareer(seed) {
    seed = (seed == null ? (Date.now() % 100000) : seed) >>> 0;
    var save = {
      schema: SCHEMA,
      seed: seed,
      season: 1,
      budget: 0,
      clubId: null,
      squad: [],
      xi: [],
      teams: [],
      calendar: blankCalendar(),
      table: [],
      market: [],
      results: [],
    };
    var ctx = { save: save, rng: mulberry32(seed), competitions: [] };
    emit('competitions', ctx);
    emit('onSeasonStart', ctx);
    emit('schedule', ctx);
    emit('transferMarket', ctx);
    emit('youthIntake', ctx);
    if (!save.xi || save.xi.length !== 11) save.xi = autoXI(save.squad);
    return save;
  }

  function rollSeason(save) {
    save.season += 1;
    save.results = [];
    save.calendar = blankCalendar();
    save.table = [];
    save.market = [];
    var ctx = { save: save, rng: mulberry32((save.seed + save.season * 1009) >>> 0), competitions: [], rollover: true };
    emit('onSeasonStart', ctx);
    emit('schedule', ctx);
    emit('transferMarket', ctx);
    emit('youthIntake', ctx);
    emit('growPlayers', { save: save, players: save.squad, when: 'season' });
    return save;
  }

  function persist(save, storage) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!storage) return false;
    save.schema = SCHEMA;
    storage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  }
  function restore(storage) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!storage) return null;
    try {
      var raw = storage.getItem(SAVE_KEY);
      if (!raw) return null;
      var save = JSON.parse(raw);
      if (!save || save.schema !== SCHEMA) return null;
      return save;
    } catch (e) { return null; }
  }
  function clearSave(storage) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (storage) storage.removeItem(SAVE_KEY);
  }

  // 可选：从 JSON 描述注册一个数据 mod（没有函数，只宣布 id）。
  function loadJSON(data) {
    if (!data || !data.id) return { ok: false, error: '需要 id' };
    registerMod({
      id: data.id,
      name: data.name || data.id,
      hooks: data.hooks || {},
      data: data,
    });
    return { ok: true };
  }

  return {
    SCHEMA: SCHEMA,
    SAVE_KEY: SAVE_KEY,
    MIN_SQUAD: MIN_SQUAD,
    MAX_SQUAD: MAX_SQUAD,
    HOOKS: HOOKS,
    XI_SLOTS: XI_SLOTS,
    registerMod: registerMod,
    clearMods: clearMods,
    listMods: listMods,
    emit: emit,
    loadJSON: loadJSON,
    mulberry32: mulberry32,
    blankCalendar: blankCalendar,
    addFixture: addFixture,
    postpone: postpone,
    insertAndPostpone: insertAndPostpone,
    nextFixture: nextFixture,
    doubleRoundRobin: doubleRoundRobin,
    blankTable: blankTable,
    applyScore: applyScore,
    sortTable: sortTable,
    ranked: ranked,
    rankOf: rankOf,
    teamName: teamName,
    buy: buy,
    sell: sell,
    release: release,
    autoXI: autoXI,
    cycleXI: cycleXI,
    lineupPlayers: lineupPlayers,
    recordResult: recordResult,
    newCareer: newCareer,
    rollSeason: rollSeason,
    persist: persist,
    restore: restore,
    clearSave: clearSave,
  };
});
