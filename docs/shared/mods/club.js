// 内置 mod：俱乐部经营。财务、合同、转会、租借、青训、训练、战术、疲劳、伤停、士气。
(function (root, factory) {
  var Career = (typeof module !== 'undefined' && module.exports) ? require('../career') : root.Career;
  var api = factory(Career);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Club = api;
})(typeof self !== 'undefined' ? self : this, function (Career) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function find(list, id, key) {
    key = key || 'id';
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i][key] === id) return list[i];
    return null;
  }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function pushInbox(save, item) {
    var box = save.club.inbox;
    item.id = item.id || ('in' + (save.club.seq = (save.club.seq || 1) + 1));
    item.date = item.date == null ? (save.club.date || 0) : item.date;
    item.read = false;
    box.unshift(item);
    if (box.length > 40) box.length = 40;
    return item;
  }
  function money(save, delta, label, alreadyApplied) {
    if (!alreadyApplied) save.budget = Math.round((save.budget || 0) + delta);
    save.club.cash = save.budget;
    save.club.history.push({
      label: label, delta: Math.round(delta), cash: save.budget, date: save.club.date || 0,
    });
    if (save.club.history.length > 48) save.club.history.splice(0, save.club.history.length - 48);
  }
  function ovrOf(p) {
    var s = p.stats || {};
    var keys = p.pos === 'GK' ? ['reflexes', 'handling', 'aerial', 'kicking'] : ['pace', 'passing', 'tackling', 'finishing', 'dribbling'];
    var t = 0;
    keys.forEach(function (k) { t += s[k] || 0; });
    return Math.round(t / keys.length);
  }
  function unavailable(p) {
    if (!p) return '没这个人';
    if (p.ban > 0) return p.name + ' 停赛';
    if (p.injury && p.injury.matches > 0) return p.name + ' 受伤';
    if (p.loan && p.loan.dir === 'out') return p.name + ' 正在外租';
    return '';
  }
  function stars(p) {
    var pot = p.potential || p.ovr || 5;
    var guess = clamp(Math.round(pot / 2), 1, 5);
    return guess;
  }

  var FORMS = {
    '4-2-3-1': [
      { num: 1, pos: 'GK' }, { num: 2, pos: 'DF' }, { num: 3, pos: 'DF' }, { num: 4, pos: 'DF' }, { num: 5, pos: 'DF' },
      { num: 6, pos: 'MF' }, { num: 8, pos: 'MF' }, { num: 7, pos: 'MF' }, { num: 10, pos: 'MF' }, { num: 11, pos: 'MF' },
      { num: 9, pos: 'FW' },
    ],
    '4-4-2': [
      { num: 1, pos: 'GK' }, { num: 2, pos: 'DF' }, { num: 3, pos: 'DF' }, { num: 4, pos: 'DF' }, { num: 5, pos: 'DF' },
      { num: 6, pos: 'MF' }, { num: 8, pos: 'MF' }, { num: 7, pos: 'MF' }, { num: 11, pos: 'MF' },
      { num: 10, pos: 'FW' }, { num: 9, pos: 'FW' },
    ],
    '4-3-3': [
      { num: 1, pos: 'GK' }, { num: 2, pos: 'DF' }, { num: 3, pos: 'DF' }, { num: 4, pos: 'DF' }, { num: 5, pos: 'DF' },
      { num: 6, pos: 'MF' }, { num: 8, pos: 'MF' }, { num: 10, pos: 'MF' },
      { num: 7, pos: 'FW' }, { num: 9, pos: 'FW' }, { num: 11, pos: 'FW' },
    ],
    '3-5-2': [
      { num: 1, pos: 'GK' }, { num: 3, pos: 'DF' }, { num: 4, pos: 'DF' }, { num: 5, pos: 'DF' },
      { num: 2, pos: 'MF' }, { num: 6, pos: 'MF' }, { num: 8, pos: 'MF' }, { num: 7, pos: 'MF' }, { num: 11, pos: 'MF' },
      { num: 9, pos: 'FW' }, { num: 10, pos: 'FW' },
    ],
  };

  function defaultTactics() {
    return {
      formation: '4-2-3-1',
      press: 'normal',
      line: 'normal',
      pass: 'mixed',
      tempo: 'normal',
      width: 'normal',
      captain: null,
      pen: null,
      fk: null,
      corner: null,
    };
  }

  function ensurePlayer(p, season, rng) {
    if (!p) return p;
    if (p.ovr == null) p.ovr = ovrOf(p);
    if (p.wage == null) p.wage = 40 + p.ovr * 15;
    if (p.contractEnd == null) p.contractEnd = (season || 1) + 1 + ((p.ovr || 4) % 3);
    if (!p.clause && p.fee > 2000) p.clause = Math.round(p.fee * 1.6);
    if (p.morale == null) p.morale = 62;
    if (p.condition == null) p.condition = 100;
    if (p.potential == null) {
      var room = p.age < 23 ? 3 : (p.age < 28 ? 1 : 0);
      p.potential = clamp((p.ovr || 5) + room, 3, 12);
    }
    if (!p.growth) p.growth = {};
    if (p.minutes == null) p.minutes = 0;
    if (p.goals == null) p.goals = 0;
    if (p.yellows == null) p.yellows = 0;
    if (p.ban == null) p.ban = 0;
    if (p.expectation == null) p.expectation = p.ovr >= 7 ? 'star' : (p.ovr >= 5 ? 'regular' : 'squad');
    if (rng && p.contractEnd < (season || 1)) p.contractEnd = (season || 1) + 1;
    return p;
  }

  function attach(save) {
    if (!save) return save;
    var season = save.season || 1;
    if (!save.club) save.club = {};
    var c = save.club;
    if (c.cash == null) c.cash = save.budget || 0;
    save.budget = c.cash;
    if (c.wageBudget == null) c.wageBudget = 2800;
    if (!c.history) c.history = [];
    if (!c.inbox) c.inbox = [];
    if (!c.tactics) c.tactics = defaultTactics();
    if (!c.training) c.training = { team: 'technical', individual: {}, trainedDate: -1 };
    if (!c.academy) c.academy = { coach: 2, players: [] };
    if (!c.board) c.board = { rank: 4, note: '董事会希望赛季结束排进前四。' };
    if (c.date == null) c.date = 0;
    if (c.seq == null) c.seq = 1;
    if (!c.goals) c.goals = {};
    (save.squad || []).forEach(function (p) { ensurePlayer(p, season); });
    (save.teams || []).forEach(function (t) {
      (t.squad || []).forEach(function (p) { ensurePlayer(p, season); });
    });
    (c.academy.players || []).forEach(function (p) { ensurePlayer(p, season); p.youth = true; });
    if (!c.tactics.captain && save.squad && save.squad[0]) c.tactics.captain = save.squad[0].id;
    if (!c.tactics.pen) c.tactics.pen = c.tactics.captain;
    if (!c.tactics.fk) c.tactics.fk = c.tactics.captain;
    if (!c.tactics.corner) c.tactics.corner = c.tactics.captain;
    return save;
  }

  function wageBill(save) {
    var n = 0;
    (save.squad || []).forEach(function (p) {
      var share = 1;
      if (p.loan && p.loan.dir === 'out') share = 1 - (p.loan.wageSplit || 0.5);
      if (p.loan && p.loan.dir === 'in') share = p.loan.wageSplit == null ? 0.5 : p.loan.wageSplit;
      n += Math.round((p.wage || 0) * share);
    });
    return n;
  }

  function competitionOf(save) {
    var list = save.competitions || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === 'amateur-league') return list[i];
    return { id: 'amateur-league', window: 'always', gate: 800, prize: 400, sponsor: 1500, boardRank: 4 };
  }

  function windowOpen(save) {
    var comp = competitionOf(save);
    if (!comp.window || comp.window === 'always') return true;
    if (comp.window === 'closed') return false;
    var date = (save.club && save.club.date) || 0;
    if (comp.window === 'summer') return date < (comp.summerUntil == null ? 4 : comp.summerUntil);
    return true;
  }

  function slots(save) {
    var id = (save && save.club && save.club.tactics && save.club.tactics.formation) || '4-2-3-1';
    var form = FORMS[id] || FORMS['4-2-3-1'];
    return form.map(function (s) { return { num: s.num, pos: s.pos, formation: id }; });
  }

  function pickXI(squad, formSlots) {
    var used = {};
    return formSlots.map(function (slot) {
      var pick = null;
      (squad || []).forEach(function (p) {
        if (used[p.id] || unavailable(p) || p.pos !== slot.pos) return;
        var score = (p.ovr || 0) * 10 + (p.condition == null ? 100 : p.condition) / 20;
        if (!pick || score > pick.score) pick = { p: p, score: score };
      });
      if (!pick) {
        (squad || []).forEach(function (p) {
          if (used[p.id] || unavailable(p) || p.pos === 'GK') return;
          if (!pick) pick = { p: p, score: 0 };
        });
      }
      if (!pick) return null;
      used[pick.p.id] = true;
      return pick.p.id;
    });
  }

  function setFormation(save, id) {
    if (!FORMS[id]) return { ok: false, error: '没有这个阵型' };
    attach(save);
    save.club.tactics.formation = id;
    save.xi = pickXI(save.squad, slots(save));
    return { ok: true, formation: id };
  }

  function cycleTactic(save, key) {
    attach(save);
    var order = {
      formation: ['4-2-3-1', '4-4-2', '4-3-3', '3-5-2'],
      press: ['low', 'normal', 'high'],
      line: ['deep', 'normal', 'high'],
      pass: ['short', 'mixed', 'long'],
      tempo: ['slow', 'normal', 'fast'],
      width: ['narrow', 'normal', 'wide'],
    };
    var list = order[key];
    if (!list) return { ok: false, error: '没有这项' };
    if (key === 'formation') return setFormation(save, list[(list.indexOf(save.club.tactics.formation) + 1) % list.length]);
    var cur = save.club.tactics[key] || list[1];
    save.club.tactics[key] = list[(list.indexOf(cur) + 1) % list.length];
    return { ok: true, value: save.club.tactics[key] };
  }

  var TACTIC_LABEL = {
    low: '低', normal: '中', high: '高', deep: '低', short: '短传', mixed: '混合', long: '长传',
    slow: '慢', fast: '快', narrow: '窄', wide: '宽',
  };
  function tacticLabel(key, value) {
    if (key === 'formation') return value;
    return TACTIC_LABEL[value] || value;
  }

  function askWage(p) {
    var ageK = p.age < 24 ? 1.15 : (p.age > 31 ? 0.85 : 1);
    var mor = 0.9 + (p.morale || 60) / 400;
    return Math.max(30, Math.round((p.wage || 80) * (0.85 + (p.ovr || 5) / 18) * ageK * mor));
  }

  function renew(save, playerId, offer, years) {
    attach(save);
    if (!windowOpen(save)) return { ok: false, error: '转会窗口关着' };
    var p = find(save.squad, playerId);
    if (!p) return { ok: false, error: '队里没有这名球员' };
    years = years || 2;
    var ask = askWage(p);
    if (offer >= ask) {
      p.wage = Math.round(offer);
      p.contractEnd = (save.season || 1) + years - 1;
      p.morale = clamp((p.morale || 60) + 6, 0, 100);
      pushInbox(save, { kind: 'contract', text: p.name + ' 签下了新合同，周薪 ' + p.wage + '，打到第 ' + p.contractEnd + ' 赛季。' });
      return { ok: true, result: 'accept', wage: p.wage, ask: ask };
    }
    if (offer >= ask * 0.82) {
      var counter = Math.round((ask + offer) / 2);
      return { ok: true, result: 'counter', ask: ask, counter: counter };
    }
    p.morale = clamp((p.morale || 60) - 4, 0, 100);
    return { ok: true, result: 'refuse', ask: ask };
  }

  function acceptCounter(save, playerId, wage, years) {
    return renew(save, playerId, wage, years);
  }

  function releaseFree(save, playerId) {
    var why = unavailable(find(save.squad, playerId));
    if (why && why.indexOf('外租') < 0) return { ok: false, error: why };
    var r = Career.release(save, playerId);
    if (!r.ok) return r;
    pushInbox(save, { kind: 'contract', text: r.player.name + ' 合同到期，自由离队。' });
    return r;
  }

  function signFree(save, listingId) {
    attach(save);
    if (!windowOpen(save)) return { ok: false, error: '转会窗口关着' };
    var L = find(save.market, listingId);
    if (!L) return { ok: false, error: '名单上没有这名球员' };
    if (L.player.clubId) return buyDeal(save, listingId);
    if (wageBill(save) + (L.wage || 0) > save.club.wageBudget + 400) {
      return { ok: false, error: '工资预算装不下' };
    }
    L.fee = 0;
    var bought = Career.buy(save, listingId);
    if (!bought.ok) return bought;
    ensurePlayer(bought.player, save.season);
    bought.player.contractEnd = (save.season || 1) + 1;
    bought.player.morale = 70;
    money(save, 0, '签下自由球员 ' + bought.player.name);
    return bought;
  }

  function buyDeal(save, listingId) {
    attach(save);
    if (!windowOpen(save)) return { ok: false, error: '转会窗口关着' };
    var before = save.budget;
    var bought = Career.buy(save, listingId);
    if (!bought.ok) return bought;
    ensurePlayer(bought.player, save.season);
    money(save, save.budget - before, '买入 ' + bought.player.name, true);
    return bought;
  }

  function willingness(p) {
    var w = 0.45 + (100 - (p.morale || 60)) / 250;
    if ((p.minutes || 0) < 200) w += 0.15;
    if (p.age > 31) w += 0.1;
    if (p.age < 22) w -= 0.08;
    return clamp(w, 0.15, 0.9);
  }

  function offerFor(save, teamId, playerId, fee) {
    attach(save);
    if (!windowOpen(save)) return { ok: false, error: '转会窗口关着' };
    var team = find(save.teams, teamId);
    if (!team) return { ok: false, error: '没有这支球队' };
    var p = find(team.squad, playerId);
    if (!p) return { ok: false, error: '对方没有这名球员' };
    if (save.squad.length >= Career.MAX_SQUAD) return { ok: false, error: '阵容已满（最多 ' + Career.MAX_SQUAD + ' 人）' };
    var want = Math.round((p.fee || 1000) * (1.05 - willingness(p) * 0.3));
    if (fee < want * 0.9) return { ok: true, result: 'refuse', want: want };
    if (fee < want) return { ok: true, result: 'counter', want: want };
    if (save.budget < fee) return { ok: false, error: '预算不够' };
    money(save, -fee, '买入 ' + p.name);
    team.squad = team.squad.filter(function (q) { return q.id !== p.id; });
    p.clubId = save.clubId;
    p.fee = fee;
    ensurePlayer(p, save.season);
    p.contractEnd = (save.season || 1) + 2;
    p.morale = 68;
    save.squad.push(p);
    return { ok: true, result: 'accept', player: p, fee: fee };
  }

  function incomingBid(save) {
    attach(save);
    if (!windowOpen(save)) return null;
    var pool = (save.squad || []).filter(function (p) {
      return save.xi.indexOf(p.id) < 0 && !(p.loan && p.loan.dir === 'out');
    });
    if (!pool.length) return null;
    var p = pool[Math.floor(((save.seed || 1) + (save.club.date || 0) * 17) % pool.length)];
    var buyers = (save.teams || []).filter(function (t) { return t.id !== save.clubId; });
    if (!buyers.length) return null;
    var buyer = buyers[(save.club.date || 0) % buyers.length];
    var fee = Math.round((p.fee || 800) * (0.85 + ((p.ovr || 5) % 4) * 0.08));
    var bid = {
      id: 'bid-' + p.id + '-' + (save.club.date || 0),
      playerId: p.id, teamId: buyer.id, fee: fee, status: 'open',
    };
    save.club.bids = (save.club.bids || []).filter(function (b) { return b.status === 'open' && b.playerId !== p.id; });
    save.club.bids.push(bid);
    pushInbox(save, { kind: 'bid', text: buyer.name + ' 出价 ' + fee + ' 想买 ' + p.name + '。', bidId: bid.id });
    return bid;
  }

  function resolveBid(save, bidId, how) {
    attach(save);
    var bid = find(save.club.bids || [], bidId);
    if (!bid || bid.status !== 'open') return { ok: false, error: '这张报价已经处理过' };
    var p = find(save.squad, bid.playerId);
    if (!p) { bid.status = 'gone'; return { ok: false, error: '人已经不在队里' }; }
    if (how === 'reject') {
      bid.status = 'rejected';
      p.morale = clamp((p.morale || 60) + 2, 0, 100);
      return { ok: true, result: 'reject' };
    }
    if (how === 'counter') {
      bid.fee = Math.round(bid.fee * 1.2);
      bid.status = 'open';
      pushInbox(save, { kind: 'bid', text: '你把 ' + p.name + ' 的要价抬到了 ' + bid.fee + '。', bidId: bid.id });
      return { ok: true, result: 'counter', fee: bid.fee };
    }
    if (save.xi.indexOf(p.id) >= 0) return { ok: false, error: '先换下首发' };
    if (save.squad.length <= Career.MIN_SQUAD) return { ok: false, error: '阵容不能少于 ' + Career.MIN_SQUAD + ' 人' };
    save.squad = save.squad.filter(function (q) { return q.id !== p.id; });
    var buyer = find(save.teams, bid.teamId);
    if (buyer) {
      p.clubId = buyer.id;
      buyer.squad = buyer.squad || [];
      buyer.squad.push(p);
    }
    bid.status = 'accepted';
    money(save, bid.fee, '卖出 ' + p.name);
    pushInbox(save, { kind: 'bid', text: p.name + ' 以 ' + bid.fee + ' 转会离开。' });
    return { ok: true, result: 'accept', fee: bid.fee };
  }

  function loanOut(save, playerId, teamId, matches, wageSplit) {
    attach(save);
    var p = find(save.squad, playerId);
    var why = unavailable(p);
    if (!p) return { ok: false, error: '队里没有这名球员' };
    if (why) return { ok: false, error: why };
    if (save.xi.indexOf(p.id) >= 0) return { ok: false, error: '先换下首发' };
    var team = find(save.teams, teamId);
    if (!team) return { ok: false, error: '没有接收的俱乐部' };
    p.loan = { dir: 'out', teamId: teamId, matches: matches || 6, wageSplit: wageSplit == null ? 0.5 : wageSplit, recall: true };
    team.squad = team.squad || [];
    if (!find(team.squad, p.id)) team.squad.push(p);
    pushInbox(save, { kind: 'loan', text: p.name + ' 租借到 ' + team.name + '，' + p.loan.matches + ' 场。' });
    return { ok: true, player: p };
  }

  function loanIn(save, teamId, playerId, matches, wageSplit) {
    attach(save);
    if (save.squad.length >= Career.MAX_SQUAD) return { ok: false, error: '阵容已满（最多 ' + Career.MAX_SQUAD + ' 人）' };
    var team = find(save.teams, teamId);
    var p = team && find(team.squad, playerId);
    if (!p) return { ok: false, error: '对方没有这名球员' };
    if (find(save.squad, p.id)) return { ok: false, error: '人已经在队里' };
    var body = copy(p);
    body.loan = { dir: 'in', teamId: teamId, matches: matches || 6, wageSplit: wageSplit == null ? 0.5 : wageSplit, recall: false };
    body.clubId = save.clubId;
    ensurePlayer(body, save.season);
    save.squad.push(body);
    pushInbox(save, { kind: 'loan', text: '从 ' + team.name + ' 租入 ' + body.name + '。' });
    return { ok: true, player: body };
  }

  function recall(save, playerId) {
    var p = find(save.squad, playerId);
    if (!p || !p.loan || p.loan.dir !== 'out') return { ok: false, error: '没有外租可以召回' };
    if (!p.loan.recall) return { ok: false, error: '合同里不能中途召回' };
    var team = find(save.teams, p.loan.teamId);
    if (team && team.squad) team.squad = team.squad.filter(function (q) { return q.id !== p.id; });
    p.loan = null;
    pushInbox(save, { kind: 'loan', text: p.name + ' 被召回一线队。' });
    return { ok: true };
  }

  function makeYouth(save, rng, n) {
    var pos = ['DF', 'MF', 'FW', 'GK'][n % 4];
    var pot = 4 + Math.floor(rng() * 6);
    var age = 16;
    var base = clamp(pot - 2, 3, 6);
    var p = {
      id: 'academy-' + save.season + '-' + n + '-' + Math.floor(rng() * 1000),
      name: '青训' + ['阿海', '小磊', '小波', '阿凯'][n % 4],
      age: age, pos: pos, youth: true, clubId: save.clubId, level: 1,
      fee: 0, wage: 20, ovr: base, potential: pot, morale: 70, condition: 100,
      contractEnd: (save.season || 1) + 3,
      stats: { pace: base, acceleration: base, passing: base, finishing: base - 1, tackling: base, dribbling: base, stamina: base + 1, technique: base, decisions: base - 1, composure: base - 1, reflexes: pos === 'GK' ? base + 1 : 3, handling: pos === 'GK' ? base : 3 },
    };
    p.ovr = ovrOf(p);
    return p;
  }

  function intake(save, rng) {
    attach(save);
    var added = [];
    for (var i = 0; i < 3; i++) {
      if (save.club.academy.players.length >= 8) break;
      var p = makeYouth(save, rng, i);
      save.club.academy.players.push(p);
      added.push(p);
    }
    if (added.length) pushInbox(save, { kind: 'youth', text: '青训营来了 ' + added.length + ' 个新人。' });
    return added;
  }

  function promote(save, playerId) {
    attach(save);
    if (save.squad.length >= Career.MAX_SQUAD) return { ok: false, error: '一线队满了' };
    var p = find(save.club.academy.players, playerId);
    if (!p) return { ok: false, error: '青训营没有这名球员' };
    save.club.academy.players = save.club.academy.players.filter(function (q) { return q.id !== p.id; });
    p.youth = false;
    ensurePlayer(p, save.season);
    save.squad.push(p);
    pushInbox(save, { kind: 'youth', text: p.name + ' 提拔到一线队。' });
    return { ok: true, player: p };
  }

  function releaseYouth(save, playerId) {
    var before = (save.club.academy.players || []).length;
    save.club.academy.players = (save.club.academy.players || []).filter(function (p) { return p.id !== playerId; });
    if (save.club.academy.players.length === before) return { ok: false, error: '没有这个青训' };
    return { ok: true };
  }

  var FOCUS_KEYS = {
    physical: ['pace', 'acceleration', 'stamina', 'strength'],
    technical: ['passing', 'technique', 'dribbling', 'finishing', 'firstTouch'],
    tactical: ['decisions', 'positioning', 'anticipation', 'vision'],
    rest: [],
  };

  function trainOne(p, focus, coach, minutesBoost) {
    if (!p.stats) return;
    var keys = FOCUS_KEYS[focus] || [];
    if (!keys.length) {
      p.condition = clamp((p.condition || 70) + (p.age > 30 ? 10 : 16), 0, 100);
      return;
    }
    var grow = (p.age < 23 ? 0.55 : (p.age < 30 ? 0.28 : -0.35));
    grow += ((p.potential || 6) - (p.ovr || 5)) * 0.08;
    grow += (coach || 0) * 0.05;
    grow += minutesBoost || 0;
    if (p.condition != null && p.condition < 45) grow -= 0.2;
    p.growth = p.growth || {};
    keys.forEach(function (k) {
      if (p.stats[k] == null) return;
      var delta = 0;
      if (grow > 0.45 && p.stats[k] < (p.potential || 8)) delta = 1;
      else if (grow < -0.2 && p.age >= 30 && p.stats[k] > 3) delta = -1;
      if (!delta) { p.growth[k] = 0; return; }
      p.stats[k] = clamp(p.stats[k] + delta, 3, 12);
      p.growth[k] = delta;
    });
    p.ovr = ovrOf(p);
    var drop = focus === 'physical' ? 8 : 4;
    if (p.age > 30) drop += 3;
    p.condition = clamp((p.condition || 80) - drop, 0, 100);
  }

  function trainWeek(save) {
    attach(save);
    var date = save.club.date || 0;
    if (save.club.training.trainedDate === date) return { ok: false, error: '这周已经训练过' };
    var teamFocus = save.club.training.team || 'technical';
    var coach = save.club.academy.coach || 1;
    (save.squad || []).forEach(function (p) {
      if (p.loan && p.loan.dir === 'out') return;
      var focus = (save.club.training.individual || {})[p.id] || teamFocus;
      var mins = (p.minutes || 0) > 0 ? 0.1 : 0;
      trainOne(p, focus, 0, mins);
    });
    (save.club.academy.players || []).forEach(function (p) {
      trainOne(p, 'technical', coach, 0.15);
    });
    save.club.training.trainedDate = date;
    return { ok: true };
  }

  function setTraining(save, teamFocus) {
    attach(save);
    if (!FOCUS_KEYS[teamFocus] && teamFocus !== 'rest') return { ok: false, error: '没有这种训练' };
    save.club.training.team = teamFocus;
    return { ok: true };
  }

  function setIndividual(save, playerId) {
    attach(save);
    var order = ['physical', 'technical', 'tactical', 'rest'];
    var cur = (save.club.training.individual || {})[playerId] || save.club.training.team || 'technical';
    save.club.training.individual[playerId] = order[(order.indexOf(cur) + 1) % order.length];
    return { ok: true, value: save.club.training.individual[playerId] };
  }

  function matchday(save, fixture) {
    attach(save);
    var date = fixture ? fixture.date : (save.club.date || 0);
    save.club.date = date;
    if (save.club.lastWageDate !== date) {
      var bill = wageBill(save);
      money(save, -bill, '第 ' + (date + 1) + ' 轮工资');
      save.club.lastWageDate = date;
      var comp = competitionOf(save);
      if (fixture && fixture.homeId === save.clubId) money(save, comp.gate || 800, '主场门票');
      if (fixture && fixture.hg != null && fixture.ag != null) {
        var weHome = fixture.homeId === save.clubId;
        var gf = weHome ? fixture.hg : fixture.ag;
        var ga = weHome ? fixture.ag : fixture.hg;
        var scorer = null;
        (save.squad || []).forEach(function (p) {
          if (p.pos === 'FW' && !scorer) scorer = p;
        });
        if (!scorer) scorer = (save.squad || [])[0];
        if (scorer && gf > 0) scorer.goals = (scorer.goals || 0) + gf;
        if (gf > ga) {
          money(save, comp.prize || 400, '胜场奖金');
          (save.squad || []).forEach(function (p) { p.morale = clamp((p.morale || 60) + 3, 0, 100); });
        } else if (gf < ga) {
          (save.squad || []).forEach(function (p) { p.morale = clamp((p.morale || 60) - 3, 0, 100); });
        }
      }
      if (date % 4 === 3) money(save, comp.sponsor || 1500, '赞助');
    }
    (save.squad || []).forEach(function (p) {
      var started = (save.xi || []).indexOf(p.id) >= 0 && !unavailable(p);
      if (started) {
        p.minutes = (p.minutes || 0) + 90;
        if (p.expectation === 'star' || p.expectation === 'regular') p.morale = clamp((p.morale || 60) + 1, 0, 100);
      } else if (p.expectation === 'star' && !(p.loan && p.loan.dir === 'out')) {
        p.morale = clamp((p.morale || 60) - 2, 0, 100);
      }
      if (!(save.club.matchLoadApplied)) {
        if (started) p.condition = clamp((p.condition || 80) - (p.age > 30 ? 24 : 16), 0, 100);
        else p.condition = clamp((p.condition || 70) + (p.age > 30 ? 6 : 12), 0, 100);
      }
      if (p.ban > 0) p.ban -= 1;
      if (p.injury && p.injury.matches > 0) {
        p.injury.matches -= 1;
        if (p.injury.matches <= 0) {
          pushInbox(save, { kind: 'injury', text: p.name + ' 伤愈复出。' });
          p.injury = null;
        }
      }
      if (p.loan && p.loan.matches > 0) {
        p.loan.matches -= 1;
        if (p.loan.dir === 'out') trainOne(p, 'technical', 0, 0.05);
        if (p.loan.matches <= 0) p.loan._done = true;
      }
    });
    var still = [];
    (save.squad || []).forEach(function (p) {
      if (!p.loan || !p.loan._done) { still.push(p); return; }
      var info = p.loan;
      p.loan = null;
      if (info.dir === 'in') {
        pushInbox(save, { kind: 'loan', text: p.name + ' 租借到期，回到原俱乐部。' });
        return;
      }
      (save.teams || []).forEach(function (t) {
        if (t.id !== info.teamId || !t.squad) return;
        t.squad = t.squad.filter(function (q) { return q.id !== p.id; });
      });
      pushInbox(save, { kind: 'loan', text: p.name + ' 租借到期，回到队里。' });
      still.push(p);
    });
    save.squad = still;
    save.club.matchLoadApplied = false;
    if ((date % 3) === 2) incomingBid(save);
    if (date % 5 === 4) aiClubStep(save);
    var expiring = (save.squad || []).filter(function (p) { return p.contractEnd === save.season; });
    if (expiring.length && date % 4 === 1) {
      pushInbox(save, { kind: 'contract', text: expiring[0].name + ' 的合同本赛季结束，该谈续约了。' });
    }
    return { ok: true, wages: wageBill(save) };
  }

  function applyMatchLoad(save, players, userHome) {
    attach(save);
    save.club.matchLoadApplied = true;
    (players || []).forEach(function (rp) {
      if (!rp) return;
      var mine = userHome ? rp.team === 'home' : rp.team === 'away';
      if (!mine) return;
      var p = null;
      (save.squad || []).forEach(function (q) { if (q.name === rp.name) p = q; });
      if (!p) return;
      var left = rp.maxStamina ? rp.stamina / rp.maxStamina : 1;
      var drop = Math.round(10 + (1 - left) * 22);
      if (p.age > 30) drop += 4;
      p.condition = clamp((p.condition || 80) - drop, 0, 100);
      if (rp.cards && rp.cards.yellow) {
        p.yellows = (p.yellows || 0) + rp.cards.yellow;
        while (p.yellows >= 4) {
          p.yellows -= 4;
          p.ban = (p.ban || 0) + 1;
          pushInbox(save, { kind: 'ban', text: p.name + ' 累计黄牌，停赛一场。' });
        }
      }
      if (rp.cards && rp.cards.red) {
        p.ban = (p.ban || 0) + 1;
        pushInbox(save, { kind: 'ban', text: p.name + ' 红牌停赛一场。' });
      }
      if (left < 0.22 || rp.exhaustRisk) {
        if (((save.seed || 1) + (p.age || 20) + (save.club.date || 0)) % 4 === 0) {
          var games = 1 + ((p.age || 20) % 3);
          p.injury = { matches: games, label: left < 0.15 ? '肌肉拉伤' : '疲劳伤' };
          pushInbox(save, { kind: 'injury', text: p.name + ' ' + p.injury.label + '，缺席 ' + games + ' 场。' });
        }
      }
    });
    return save;
  }

  function aiClubStep(save) {
    (save.teams || []).forEach(function (t) {
      if (t.id === save.clubId || !t.squad || t.squad.length < 16) return;
      t.squad.forEach(function (p) {
        ensurePlayer(p, save.season);
        if ((save.xi || []).indexOf(p.id) < 0) p.condition = clamp((p.condition || 70) + 8, 0, 100);
      });
      if (((save.club.date || 0) + t.strength) % 5 !== 0) return;
      var worst = t.squad.slice().sort(function (a, b) { return (a.ovr || 0) - (b.ovr || 0); })[0];
      if (!worst) return;
      var fee = worst.fee || 600;
      t.squad = t.squad.filter(function (p) { return p.id !== worst.id; });
      t.budget = (t.budget || 8000) + fee;
      if (t.budget > 1500 && save.market && save.market.length) {
        var L = save.market[0];
        if (L.fee <= t.budget && L.player && L.player.clubId) {
          t.budget -= L.fee;
          L.player.clubId = t.id;
          t.squad.push(L.player);
          save.market = save.market.filter(function (x) { return x.id !== L.id; });
        }
      }
    });
  }

  function simScore(save, fixture) {
    var home = find(save.teams, fixture.homeId);
    var away = find(save.teams, fixture.awayId);
    function power(team) {
      var s = team ? team.strength : 5;
      var cond = 100, n = 0;
      ((team && team.squad) || []).forEach(function (p) {
        if (unavailable(p)) return;
        cond += (p.condition == null ? 100 : p.condition);
        n++;
      });
      if (n) cond = cond / n;
      return s * (0.7 + 0.3 * cond / 100);
    }
    var rng = (function (seed) {
      var a = seed >>> 0;
      return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        var t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    })(((save.seed || 1) + fixture.date * 97 + (save.season || 1) * 13) >>> 0);
    var lean = (power(home) - power(away)) * 0.35;
    var hg = clamp(Math.floor(rng() * 3 + lean + 0.4), 0, 5);
    var ag = clamp(Math.floor(rng() * 3 - lean + 0.4), 0, 5);
    return { hg: hg, ag: ag };
  }

  function simUser(save) {
    var fx = Career.nextFixture(save.calendar, save.clubId);
    if (!fx) return { ok: false, error: '没有下一场' };
    var sc = simScore(save, fx);
    return Career.recordResult(save, fx.id, sc.hg, sc.ag);
  }

  function ageSquad(save) {
    attach(save);
    var leaving = [];
    save.squad = (save.squad || []).filter(function (p) {
      p.age = (p.age || 20) + 1;
      if (p.age >= 36) { leaving.push(p.name + ' 退役'); return false; }
      if (p.contractEnd != null && p.contractEnd < save.season) { leaving.push(p.name + ' 合同到期'); return false; }
      if (p.age >= 30) trainOne(p, 'physical', 0, -0.2);
      p.minutes = 0;
      p.condition = clamp((p.condition || 70) + 20, 40, 100);
      return true;
    });
    leaving.forEach(function (text) { pushInbox(save, { kind: 'contract', text: text }); });
    if (save.squad.length < 16) {
      pushInbox(save, { kind: 'board', text: '一线队人数不够，去转会市场补人。' });
    }
    save.xi = pickXI(save.squad, slots(save));
    return leaving;
  }

  function awards(save) {
    var squad = save.squad || [];
    var best = null, scorer = null, iron = null;
    squad.forEach(function (p) {
      if (!best || (p.ovr || 0) > (best.ovr || 0)) best = p;
      if (!scorer || (p.goals || 0) > (scorer.goals || 0)) scorer = p;
      if (!iron || (p.minutes || 0) > (iron.minutes || 0)) iron = p;
    });
    return {
      best: best, scorer: scorer, iron: iron,
      rank: Career.rankOf(save, save.clubId),
    };
  }

  function seasonAwards(save) {
    var a = awards(save);
    var rank = a.rank;
    var comp = competitionOf(save);
    if (rank && rank <= (comp.boardRank || 4)) {
      money(save, 4000, '董事会达标奖金');
      pushInbox(save, { kind: 'board', text: '董事会对第 ' + rank + ' 名满意，发了奖金。' });
    } else if (rank) {
      money(save, -1500, '董事会不满');
      pushInbox(save, { kind: 'board', text: '排第 ' + rank + '，董事会扣了一笔预算。' });
    }
    return a;
  }

  function bench(squad, xi) {
    return (squad || []).filter(function (p) {
      return xi.indexOf(p.id) < 0 && !unavailable(p);
    }).slice(0, 7).map(function (p) {
      return {
        id: p.id, name: p.name, pos: p.pos, stats: p.stats,
        condition: p.condition == null ? 100 : p.condition,
        morale: p.morale == null ? 70 : p.morale,
      };
    });
  }

  function aiTactics(team) {
    var press = (team && team.strength >= 6) ? 'high' : 'normal';
    return { formation: '4-2-3-1', press: press, line: 'normal', pass: 'mixed', tempo: 'normal', width: 'normal' };
  }

  var mod = {
    id: 'club',
    name: '俱乐部经营',
    version: 1,
    hooks: {
      competitions: function (ctx) {
        (ctx.competitions || []).forEach(function (c) {
          if (c.id !== 'amateur-league') return;
          if (!c.window) c.window = 'always';
          if (c.gate == null) c.gate = 800;
          if (c.prize == null) c.prize = 400;
          if (c.sponsor == null) c.sponsor = 1500;
          if (c.boardRank == null) c.boardRank = 4;
        });
        ctx.save.competitions = ctx.competitions;
      },
      onSeasonStart: function (ctx) {
        attach(ctx.save);
        if (!ctx.rollover) {
          pushInbox(ctx.save, { kind: 'board', text: ctx.save.club.board.note });
        }
      },
      onMatchPlayed: function (ctx) { matchday(ctx.save, ctx.fixture); },
      growPlayers: function (ctx) {
        if (ctx.when === 'season') ageSquad(ctx.save);
      },
      youthIntake: function (ctx) { intake(ctx.save, ctx.rng || Math.random); },
      onLoad: function (ctx) { attach(ctx.save); },
      serialize: function () { return { club: 'club', version: 1 }; },
      deserialize: function (ctx) { if (ctx && ctx.save) attach(ctx.save); },
    },
  };

  if (Career && Career.registerMod) Career.registerMod(mod);

  return {
    mod: mod,
    FORMS: FORMS,
    attach: attach,
    ensurePlayer: ensurePlayer,
    unavailable: unavailable,
    stars: stars,
    wageBill: wageBill,
    windowOpen: windowOpen,
    slots: slots,
    pickXI: pickXI,
    setFormation: setFormation,
    cycleTactic: cycleTactic,
    tacticLabel: tacticLabel,
    askWage: askWage,
    renew: renew,
    acceptCounter: acceptCounter,
    signFree: signFree,
    buyDeal: buyDeal,
    offerFor: offerFor,
    incomingBid: incomingBid,
    resolveBid: resolveBid,
    loanOut: loanOut,
    loanIn: loanIn,
    recall: recall,
    intake: intake,
    promote: promote,
    releaseYouth: releaseYouth,
    trainWeek: trainWeek,
    trainOne: trainOne,
    setTraining: setTraining,
    setIndividual: setIndividual,
    matchday: matchday,
    applyMatchLoad: applyMatchLoad,
    simScore: simScore,
    simUser: simUser,
    ageSquad: ageSquad,
    awards: awards,
    seasonAwards: seasonAwards,
    bench: bench,
    aiTactics: aiTactics,
    ovrOf: ovrOf,
  };
});
