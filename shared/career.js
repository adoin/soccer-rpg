// 生涯层：联赛表、赛程（可插入、可延期）、转会、存档、mod 钩子。
// 不改比赛引擎的默认对局。职业模式把选好的阵容交给 Match。
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Career = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA = 1;
  var SLOT_SCHEMA = 2;
  var SAVE_KEY = 'soccer-rpg-career';
  var INDEX_KEY = 'soccer-rpg-saves';
  var SLOT_IDS = ['auto', '1', '2', '3'];
  var MIN_SQUAD = 16;
  var MAX_SQUAD = 22;
  // 生涯正文从 schema 1 往上爬。现在就是 1，以后加步骤写在这里。
  var CAREER_MIGRATIONS = {};
  var HOOKS = [
    'competitions',   // 登记联赛 / 杯赛规则
    'onSeasonStart',  // 生成赛季：球队、积分榜、联赛赛程
    'schedule',       // 插入或延期赛程（杯赛打乱联赛）
    'transferMarket', // 补转会名单
    'onMatchPlayed',  // 一场打完
    'growPlayers',    // 成长 / 衰退
    'youthIntake',    // 青训入队
    'serialize',      // 把 mod 自己的状态交出来，写进存档
    'deserialize',    // 读档时把 mod 状态还回去
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

  function resolveStorage(storage) {
    if (storage) return storage;
    return (typeof localStorage !== 'undefined') ? localStorage : null;
  }
  function slotKey(id) { return 'soccer-rpg-save-' + id; }
  function slotTitle(id) { return id === 'auto' ? '自动存档' : ('手动 ' + id); }
  function freshIndex() {
    return { schema: SLOT_SCHEMA, active: null, legacyMigrated: false, legacyDamaged: false };
  }
  function loadIndex(storage) {
    try {
      var raw = storage.getItem(INDEX_KEY);
      if (!raw) return freshIndex();
      var idx = JSON.parse(raw);
      if (!idx || typeof idx !== 'object') return freshIndex();
      return idx;
    } catch (e) {
      return freshIndex();
    }
  }
  function saveIndex(storage, idx) {
    idx.schema = SLOT_SCHEMA;
    storage.setItem(INDEX_KEY, JSON.stringify(idx));
  }
  function isQuota(err) {
    if (!err) return false;
    if (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014) return true;
    return /quota/i.test(String(err.message || err.name || ''));
  }
  function failWrite(err) {
    if (isQuota(err)) return { ok: false, quota: true, error: '存储空间不够，存档没写上' };
    return { ok: false, error: '存档写不进去' };
  }
  function migrateCareer(career) {
    if (!career || typeof career !== 'object') return null;
    if (!career.squad || !career.clubId) return null;
    var schema = career.schema == null ? 1 : (career.schema | 0);
    if (schema > SCHEMA) return null;
    var guard = 0;
    while (schema < SCHEMA && guard < 8) {
      guard++;
      var step = CAREER_MIGRATIONS[schema];
      if (typeof step !== 'function') return null;
      career = step(career);
      if (!career || typeof career !== 'object') return null;
      schema = career.schema == null ? schema : (career.schema | 0);
    }
    if ((career.schema == null ? 1 : career.schema) !== SCHEMA) return null;
    career.schema = SCHEMA;
    return career;
  }
  function careerFromStored(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.schema === SLOT_SCHEMA && data.career) return migrateCareer(data.career);
    if (typeof data.schema === 'number' && data.schema > SLOT_SCHEMA) return null;
    if ((data.schema === SCHEMA || data.schema == null) && data.squad && data.clubId) {
      return migrateCareer(data);
    }
    return null;
  }
  function summarize(save) {
    var round = '赛季结束';
    try {
      var nxt = nextFixture(save.calendar, save.clubId);
      if (nxt) {
        var oppId = nxt.homeId === save.clubId ? nxt.awayId : nxt.homeId;
        var where = nxt.homeId === save.clubId ? '主' : '客';
        var comp = nxt.competitionId === 'example-cup' ? '杯赛' : '联赛';
        round = '第' + ((nxt.date || 0) + 1) + '轮 ' + comp + ' ' + where + ' ' + teamName(save, oppId);
      }
    } catch (e) {}
    var rank = null;
    try { rank = rankOf(save, save.clubId); } catch (e2) {}
    var clubName = teamName(save, save.clubId);
    return {
      clubName: clubName || '未知球队',
      clubId: save.clubId || null,
      season: save.season || 1,
      round: round,
      rank: rank,
      budget: save.budget || 0,
    };
  }
  function collectModPack(save) {
    var versions = [];
    var state = {};
    mods.forEach(function (m) {
      versions.push({ id: m.id, version: m.version || 1, name: m.name || m.id });
      var fn = m.hooks && m.hooks.serialize;
      if (typeof fn !== 'function') return;
      try {
        var data = fn({ save: save });
        if (data !== undefined) state[m.id] = data;
      } catch (e) {
        state[m.id] = null;
      }
    });
    return { mods: versions, modState: state };
  }
  function applyModPack(save, pack) {
    var warnings = [];
    var have = {};
    mods.forEach(function (m) { have[m.id] = m; });
    (pack.mods || []).forEach(function (m) {
      if (!m || !m.id || have[m.id]) return;
      warnings.push('缺少模组 ' + (m.name || m.id));
    });
    var st = (pack && pack.modState) || {};
    Object.keys(st).forEach(function (id) {
      var live = have[id];
      if (!live) {
        var msg = '缺少模组 ' + id;
        if (warnings.indexOf(msg) < 0) warnings.push(msg);
        return;
      }
      var fn = live.hooks && live.hooks.deserialize;
      if (typeof fn !== 'function') return;
      try { fn({ save: save, data: st[id] }); }
      catch (e) { warnings.push((live.name || id) + ' 的数据读不出来'); }
    });
    return warnings;
  }
  function emptySlot(id) {
    return { ok: true, empty: true, damaged: false, slot: id, label: slotTitle(id), warnings: [] };
  }
  function damagedSlot(id, error, savedAt) {
    return {
      ok: false, empty: false, damaged: true, slot: id, label: slotTitle(id),
      error: error || '存档损坏', savedAt: savedAt || null, warnings: [],
    };
  }
  function inspectSlot(storage, slotId) {
    if (SLOT_IDS.indexOf(slotId) < 0) return { ok: false, error: '没有这个存档位', slot: slotId };
    var raw;
    try { raw = storage.getItem(slotKey(slotId)); }
    catch (e) { return damagedSlot(slotId, '存档读不出来'); }
    if (!raw) return emptySlot(slotId);
    var data;
    try { data = JSON.parse(raw); }
    catch (e) { return damagedSlot(slotId, '存档损坏'); }
    if (!data || typeof data !== 'object') return damagedSlot(slotId, '存档损坏');
    if (typeof data.schema === 'number' && data.schema > SLOT_SCHEMA && data.career) {
      return damagedSlot(slotId, '存档版本太新', data.savedAt);
    }
    var career = careerFromStored(data);
    if (!career) return damagedSlot(slotId, data.schema > SLOT_SCHEMA ? '存档版本太新' : '存档版本无法读取', data.savedAt);
    var summary = data.summary;
    if (!summary || !summary.clubName) summary = summarize(career);
    return {
      ok: true,
      empty: false,
      damaged: false,
      slot: slotId,
      label: slotTitle(slotId),
      savedAt: data.savedAt || null,
      summary: summary,
      career: career,
      pack: { mods: data.mods || [], modState: data.modState || {} },
      warnings: [],
    };
  }
  var migrating = false;
  function ensureMigrated(storage) {
    storage = resolveStorage(storage);
    if (!storage) return { ok: false, error: '没有本地存储' };
    if (migrating) return { ok: true };
    var idx = loadIndex(storage);
    if (idx.legacyMigrated) return { ok: true, migrated: false, legacyDamaged: !!idx.legacyDamaged };
    migrating = true;
    try {
      var raw = null;
      try { raw = storage.getItem(SAVE_KEY); }
      catch (e) {
        idx.legacyMigrated = true;
        idx.legacyDamaged = true;
        try { saveIndex(storage, idx); } catch (e2) {}
        return { ok: false, damaged: true, error: '旧存档读不出来' };
      }
      if (!raw) {
        idx.legacyMigrated = true;
        try { saveIndex(storage, idx); } catch (e3) {}
        return { ok: true, migrated: false };
      }
      var parsed;
      try { parsed = JSON.parse(raw); }
      catch (e4) {
        idx.legacyMigrated = true;
        idx.legacyDamaged = true;
        try { saveIndex(storage, idx); } catch (e5) {}
        return { ok: false, damaged: true, error: '旧存档损坏' };
      }
      var career = careerFromStored(parsed);
      if (!career) {
        idx.legacyMigrated = true;
        idx.legacyDamaged = true;
        try { saveIndex(storage, idx); } catch (e6) {}
        return { ok: false, damaged: true, error: '旧存档版本无法读取' };
      }
      var existing = inspectSlot(storage, 'auto');
      if (existing.ok && !existing.empty && !existing.damaged) {
        idx = loadIndex(storage);
        idx.legacyMigrated = true;
        try { saveIndex(storage, idx); } catch (e7) {}
        return { ok: true, migrated: false, kept: 'auto' };
      }
      var wrote = writeSlot(storage, 'auto', career, { fromLegacy: true });
      if (!wrote.ok) return wrote;
      try { storage.removeItem(SAVE_KEY); } catch (e8) {}
      idx = loadIndex(storage);
      idx.legacyMigrated = true;
      idx.legacyDamaged = false;
      idx.active = 'auto';
      try { saveIndex(storage, idx); } catch (e9) {}
      return { ok: true, migrated: true, slot: 'auto' };
    } finally {
      migrating = false;
    }
  }
  function writeSlot(storage, slotId, career, opt) {
    storage = resolveStorage(storage);
    if (!storage) return { ok: false, error: '没有本地存储' };
    if (SLOT_IDS.indexOf(slotId) < 0) return { ok: false, error: '没有这个存档位' };
    if (!career || !career.clubId) return { ok: false, error: '没有可存的生涯' };
    if (!migrating) ensureMigrated(storage);
    opt = opt || {};
    career.schema = SCHEMA;
    var pack = opt.pack || collectModPack(career);
    var envelope = {
      schema: SLOT_SCHEMA,
      slot: slotId,
      savedAt: opt.savedAt || Date.now(),
      summary: summarize(career),
      mods: pack.mods || [],
      modState: pack.modState || {},
      career: career,
    };
    var text;
    try { text = JSON.stringify(envelope); }
    catch (e) { return { ok: false, error: '存档内容没法写成文本' }; }
    try {
      storage.setItem(slotKey(slotId), text);
      var idx = loadIndex(storage);
      idx.active = slotId;
      if (opt.fromLegacy) idx.legacyMigrated = true;
      saveIndex(storage, idx);
      return { ok: true, slot: slotId, savedAt: envelope.savedAt, summary: envelope.summary };
    } catch (err) {
      return failWrite(err);
    }
  }
  function readSlot(storage, slotId) {
    storage = resolveStorage(storage);
    if (!storage) return { ok: false, error: '没有本地存储', slot: slotId };
    if (!migrating) ensureMigrated(storage);
    return inspectSlot(storage, slotId);
  }
  function loadSlot(storage, slotId) {
    var info = readSlot(storage, slotId);
    if (!info.ok || info.empty || info.damaged) return info;
    info.warnings = applyModPack(info.career, info.pack || {});
    try {
      var storageRef = resolveStorage(storage);
      var idx = loadIndex(storageRef);
      idx.active = slotId;
      saveIndex(storageRef, idx);
    } catch (e) {}
    return info;
  }
  function listSlots(storage) {
    storage = resolveStorage(storage);
    if (!storage) return SLOT_IDS.map(emptySlot);
    if (!migrating) ensureMigrated(storage);
    return SLOT_IDS.map(function (id) { return inspectSlot(storage, id); });
  }
  function latestSlot(storage) {
    storage = resolveStorage(storage);
    if (!storage) return null;
    if (!migrating) ensureMigrated(storage);
    var idx = loadIndex(storage);
    if (idx.active) {
      var active = inspectSlot(storage, idx.active);
      if (active.ok && !active.empty && !active.damaged) return active;
    }
    var best = null;
    SLOT_IDS.forEach(function (id) {
      var info = inspectSlot(storage, id);
      if (!info.ok || info.empty || info.damaged) return;
      if (!best || (info.savedAt || 0) >= (best.savedAt || 0)) best = info;
    });
    return best;
  }
  function deleteSlot(storage, slotId) {
    storage = resolveStorage(storage);
    if (!storage) return { ok: false, error: '没有本地存储' };
    if (SLOT_IDS.indexOf(slotId) < 0) return { ok: false, error: '没有这个存档位' };
    try {
      storage.removeItem(slotKey(slotId));
      var idx = loadIndex(storage);
      if (idx.active === slotId) idx.active = null;
      saveIndex(storage, idx);
      return { ok: true, slot: slotId };
    } catch (err) {
      return failWrite(err);
    }
  }
  function exportSlot(storage, slotId) {
    storage = resolveStorage(storage);
    if (!storage) return { ok: false, error: '没有本地存储' };
    var info = readSlot(storage, slotId);
    if (!info.ok) return { ok: false, error: info.error || '存档损坏，导不出来', damaged: !!info.damaged };
    if (info.empty) return { ok: false, error: '这个位置是空的' };
    try {
      var text = storage.getItem(slotKey(slotId));
      if (!text) return { ok: false, error: '这个位置是空的' };
      return { ok: true, text: text, filename: 'soccer-rpg-' + slotId + '.json', summary: info.summary };
    } catch (e) {
      return { ok: false, error: '导出失败' };
    }
  }
  function peekImport(text) {
    var data;
    try { data = JSON.parse(text); }
    catch (e) { return { ok: false, error: '这不是存档文件' }; }
    if (data && typeof data.schema === 'number' && data.schema > SLOT_SCHEMA) {
      return { ok: false, error: '存档版本太新' };
    }
    var career = careerFromStored(data);
    if (!career) return { ok: false, error: '存档读不出来' };
    return {
      ok: true,
      career: career,
      summary: (data && data.summary) || summarize(career),
      pack: { mods: (data && data.mods) || [], modState: (data && data.modState) || {} },
      savedAt: data && data.savedAt,
    };
  }
  function importSlot(storage, slotId, text) {
    var peek = peekImport(text);
    if (!peek.ok) return peek;
    applyModPack(peek.career, peek.pack);
    return writeSlot(storage, slotId, peek.career, { savedAt: peek.savedAt || Date.now(), pack: collectModPack(peek.career) });
  }
  function persist(save, storage) {
    var wrote = writeSlot(storage, 'auto', save);
    return !!wrote.ok;
  }
  function restore(storage) {
    var info = latestSlot(storage);
    if (!info || !info.career) return null;
    applyModPack(info.career, info.pack || {});
    return info.career;
  }
  function clearSave(storage) {
    storage = resolveStorage(storage);
    if (!storage) return;
    try { storage.removeItem(SAVE_KEY); } catch (e) {}
    try { storage.removeItem(INDEX_KEY); } catch (e2) {}
    SLOT_IDS.forEach(function (id) {
      try { storage.removeItem(slotKey(id)); } catch (e3) {}
    });
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
    SLOT_SCHEMA: SLOT_SCHEMA,
    SAVE_KEY: SAVE_KEY,
    INDEX_KEY: INDEX_KEY,
    SLOT_IDS: SLOT_IDS,
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
    slotKey: slotKey,
    slotTitle: slotTitle,
    ensureMigrated: ensureMigrated,
    writeSlot: writeSlot,
    readSlot: readSlot,
    loadSlot: loadSlot,
    listSlots: listSlots,
    latestSlot: latestSlot,
    deleteSlot: deleteSlot,
    exportSlot: exportSlot,
    peekImport: peekImport,
    importSlot: importSlot,
  };
});
