// server/game/engine.js
// ============================================================
// 比赛引擎：服务器权威（Server-Authoritative）的核心。
//
// 防作弊设计：
//  1. 全部关键数据（球员位置、体力/精神、比分、时钟）只存在服务器内存，
//     客户端只能通过轮询读取快照，不能写入。
//  2. 客户端唯一能发送的是 { matchId, commandId }，服务器会校验：
//     - 是否正处于「等待该用户决策」的阶段；
//     - 指令是否合法、精神是否足够；
//     - 结算全部使用服务器端 RNG（server/rng.js），客户端无法预测结果。
//  3. 对手 AI、无球跑位、成功率计算全部在服务器完成。
//
// ★ 体能设计（区别于《天使之翼》）：
//  - 技能只消耗「精神」，不消耗体能；
//  - 体能只因跑动缓慢下降、随时间缓慢恢复；
//  - 精神随时间缓慢恢复，鼓励持续使用技能。
// ============================================================
'use strict';

var C = require('../../shared/constants');
var T = require('../../shared/teams');
var mulberry32 = require('../rng').mulberry32;

var FIELD = C.FIELD;

// ---------- 小工具 ----------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist(a, b) {
  var dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
// 体能修正系数：体能越低，实际能力轻微下降（0.9 ~ 1.1）
function effFactor(p) {
  return 0.9 + 0.2 * (p.stamina / p.maxStamina);
}

function Match(id, options) {
  options = options || {};
  this.id = id;
  this.config = {
    halfLength: options.halfLength || C.DEFAULT_CONFIG.halfLength,
    tickMs: C.DEFAULT_CONFIG.tickMs,
  };
  // 每个比赛独立的随机数流，种子不暴露给客户端
  this.rng = mulberry32(
    typeof options.seed === 'number' ? options.seed : (Date.now() ^ (Math.random() * 1e9)) >>> 0
  );

  var teams = T.makeTeams();
  this.players = teams.home.concat(teams.away);
  this.byId = {};
  var self = this;
  this.players.forEach(function (p) { self.byId[p.id] = p; });

  this.ball = { x: FIELD.W / 2, y: FIELD.H / 2, ownerId: null };

  this.phase = 'kickoff';
  this.half = 1;
  this.clock = 0; // 当前半场已进行秒数（只在 play 阶段推进）
  this.score = { home: 0, away: 0 };
  this.shots = { home: 0, away: 0 };

  this.now = 0;            // 服务器模拟时钟（毫秒）
  this.phaseUntil = 1500;  // 当前阶段结束时间
  this.paused = false;     // 用户暂停（暂停菜单）
  this.mentality = options.mentality || 'balanced'; // 均衡 / 进攻 / 防守

  this.decision = null;     // 等待用户决策时的指令选项
  this.lastAction = null;   // 最近一次结算事件（供客户端播放动画/横幅）

  this.nextDecisionAt = 0;  // 下次允许触发决策点的时间
  this.lastDecisionPos = { x: 0, y: 0 };
  this.aiCooldownUntil = 0; // AI 决策冷却
  this.kickoffTeam = 'home';

  this.resetPositions('home');

  var self2 = this;
  this._timer = setInterval(function () { self2.tick(); }, this.config.tickMs);
}

// ---------- 比赛流程 ----------

Match.prototype.destroy = function () {
  clearInterval(this._timer);
};

Match.prototype.resetPositions = function (kickoffTeam) {
  var self = this;
  this.players.forEach(function (p) {
    p.x = p.hx; p.y = p.hy;
    p.frozenUntil = 0; p.beatenUntil = 0; p.retreatTarget = null;
  });
  this.ball.x = FIELD.W / 2; this.ball.y = FIELD.H / 2;
  // 开球球员：开球方的 10 号
  var kicker = this.byId[(kickoffTeam === 'home' ? 'h' : 'a') + '10'];
  this.ball.ownerId = kicker.id;
  this.phase = 'kickoff';
  this.phaseUntil = this.now + 1500;
  this.decision = null;
  this.lastAction = null;
  this.nextDecisionAt = this.now + 1200;
  this.lastDecisionPos = { x: kicker.x, y: kicker.y };
  this.aiCooldownUntil = this.now + 2500;
  this.kickoffTeam = kickoffTeam;
};

Match.prototype.goal = function (scorer, team) {
  this.score[team]++;
  this.phase = 'goal';
  this.phaseUntil = this.now + 3500;
  this.decision = null;
  this.lastAction = {
    kind: 'goal',
    label: '进球！',
    playerName: scorer.name,
    team: team,
    success: true,
    text: '⚽ ' + scorer.name + ' 破门得分！' + T.HOME_NAME + ' ' + this.score.home + ' - ' + this.score.away + ' ' + T.AWAY_NAME,
    until: Date.now() + 3400,
  };
  this.concedeTeam = team === 'home' ? 'away' : 'home';
};

Match.prototype.tick = function () {
  if (this.paused) return;
  var dt = this.config.tickMs / 1000;

  switch (this.phase) {
    case 'kickoff':
      this.now += dt * 1000;
      if (this.now >= this.phaseUntil) this.phase = 'play';
      break;
    case 'play':
      this.now += dt * 1000;
      this.clock += dt;
      this.simulate(dt);
      if (this.clock >= this.config.halfLength) this.endHalf();
      break;
    case 'goal':
      this.now += dt * 1000;
      if (this.now >= this.phaseUntil) this.resetPositions(this.concedeTeam);
      break;
    case 'halftime':
      this.now += dt * 1000;
      if (this.now >= this.phaseUntil) {
        this.half = 2;
        this.clock = 0;
        // 体能/精神中场休息部分恢复
        this.players.forEach(function (p) {
          p.stamina = Math.min(p.maxStamina, p.stamina + p.maxStamina * 0.25);
          p.spirit = Math.min(p.maxSpirit, p.spirit + p.maxSpirit * 0.5);
        });
        this.resetPositions('away');
      }
      break;
    case 'decision':
    case 'fulltime':
      // decision：等待客户端指令，不推进模拟；fulltime：比赛结束
      break;
  }
};

Match.prototype.endHalf = function () {
  if (this.half === 1) {
    this.phase = 'halftime';
    this.phaseUntil = this.now + 8000;
    this.decision = null;
    this.lastAction = {
      kind: 'halftime', label: '中场休息', playerName: '', team: 'home', success: true,
      text: '上半场结束：' + T.HOME_NAME + ' ' + this.score.home + ' - ' + this.score.away + ' ' + T.AWAY_NAME,
      until: Date.now() + 7800,
    };
  } else {
    this.phase = 'fulltime';
    this.decision = null;
    this.clock = this.config.halfLength;
    this.lastAction = {
      kind: 'fulltime', label: '终场', playerName: '', team: 'home', success: true,
      text: '全场比赛结束！',
      until: Date.now() + 100000,
    };
  }
};

// ---------- 模拟 ----------

Match.prototype.carrier = function () {
  return this.ball.ownerId ? this.byId[this.ball.ownerId] : null;
};

Match.prototype.teamOf = function (p) { return p.team; };

Match.prototype.opponentsOf = function (team) {
  return this.players.filter(function (p) { return p.team !== team; });
};

Match.prototype.nearestOpponent = function (p) {
  var best = null, bd = 1e9, self = this;
  this.players.forEach(function (q) {
    if (q.team === p.team) return;
    var d = dist(p, q);
    if (d < bd) { bd = d; best = q; }
  });
  return { player: best, dist: bd };
};

Match.prototype.moveToward = function (p, tx, ty, speed, dt) {
  var dx = tx - p.x, dy = ty - p.y;
  var d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.05) return true;
  var step = Math.min(d, speed * dt);
  p.x += (dx / d) * step;
  p.y += (dy / d) * step;
  p.x = clamp(p.x, 1, FIELD.W - 1);
  p.y = clamp(p.y, 1, FIELD.H - 1);
  return step >= d - 0.01;
};

Match.prototype.playerSpeed = function (p, sprint) {
  var base = 13 * (0.8 + p.stats.speed / 250);
  if (sprint) base *= 1.08;
  base *= 0.85 + 0.3 * (p.stamina / p.maxStamina); // 体能影响速度
  return base;
};

// ★ 体能/精神更新：体能只因跑动缓慢下降、随时间缓慢恢复；精神随时间缓慢恢复。
Match.prototype.updateEnergy = function (p, moving, isCarrier, dt) {
  if (moving) {
    // 持球跑动消耗稍快，无球跑动很慢
    p.stamina -= (isCarrier ? 1.0 : 0.3) * dt;
  }
  // 体能随时间缓慢恢复
  p.stamina += 0.5 * dt;
  // 精神随时间缓慢恢复（技能消耗精神，靠时间回上来）
  p.spirit += 1.2 * dt;
  p.stamina = clamp(p.stamina, 0, p.maxStamina);
  p.spirit = clamp(p.spirit, 0, p.maxSpirit);
};

Match.prototype.simulate = function (dt) {
  var self = this;
  var carrier = this.carrier();
  if (!carrier) return;

  var dir = carrier.team === 'home' ? 1 : -1; // 进攻方向
  var goalX = carrier.team === 'home' ? FIELD.W - 2 : 2;

  // --- 持球者移动 ---
  var frozen = this.now < carrier.frozenUntil;
  var cSpeed = this.playerSpeed(carrier, true);
  var moving = false;
  if (!frozen) {
    if (carrier.retreatTarget) {
      var arrived = this.moveToward(carrier, carrier.retreatTarget.x, carrier.retreatTarget.y, cSpeed * 0.9, dt);
      moving = true;
      if (arrived) carrier.retreatTarget = null;
    } else {
      // 向对方球门推进，略微向中路靠拢
      var ty = carrier.y * 0.75 + (FIELD.H / 2) * 0.25;
      this.moveToward(carrier, goalX, ty, cSpeed, dt);
      moving = true;
    }
  }
  this.updateEnergy(carrier, moving, true, dt);

  // --- 其他球员移动 ---
  var chaseCount = 0;
  var sortedOpp = this.opponentsOf(carrier.team).slice().sort(function (a, b) {
    return dist(a, carrier) - dist(b, carrier);
  });
  this.players.forEach(function (p) {
    if (p.id === carrier.id) return;
    var pFrozen = self.now < p.frozenUntil;
    var beaten = self.now < p.beatenUntil;
    var tx, ty, sp;
    if (p.team !== carrier.team) {
      // 防守方：最近的 2 人（被晃过的不算）上抢，其余回位
      var rank = sortedOpp.indexOf(p);
      if (rank >= 0 && rank < 2 && !beaten && !pFrozen) {
        tx = carrier.x; ty = carrier.y;
        sp = self.playerSpeed(p, true) * 0.94;
        chaseCount++;
      } else {
        tx = p.hx; ty = p.hy;
        sp = self.playerSpeed(p, false) * 0.7;
      }
    } else {
      // 进攻方无球跑位：前插接应
      var push = self.mentality === 'attack' ? 16 : self.mentality === 'defend' ? 6 : 11;
      tx = clamp(carrier.x + push * dir, 4, FIELD.W - 4);
      ty = clamp(p.hy * 0.5 + carrier.y * 0.5 + (p.hy - FIELD.H / 2) * 0.35, 4, FIELD.H - 4);
      if (p.pos === 'GK') { tx = p.hx; ty = p.hy; }
      sp = self.playerSpeed(p, false) * 0.8;
    }
    var moved = false;
    if (!pFrozen) {
      var ox = p.x, oy = p.y;
      self.moveToward(p, tx, ty, sp, dt);
      moved = Math.abs(p.x - ox) + Math.abs(p.y - oy) > 0.001;
    }
    self.updateEnergy(p, moved, false, dt);
  });

  // 球跟随持球者
  this.ball.x = carrier.x + (dir * 1.2);
  this.ball.y = carrier.y + 1.0;

  // --- 决策点判定（仅用户球队） ---
  if (carrier.team === 'home' && this.now >= this.nextDecisionAt) {
    var near = this.nearestOpponent(carrier);
    var traveled = dist(carrier, this.lastDecisionPos);
    if (near.dist < 15 || carrier.x > 76 || traveled > 24) {
      this.enterDecision(carrier);
      return;
    }
  }

  // --- AI 决策（客队持球） ---
  if (carrier.team === 'away' && this.now >= this.aiCooldownUntil) {
    this.aiDecide(carrier);
  }
};

// ---------- 决策点 ----------

Match.prototype.enterDecision = function (carrier) {
  this.phase = 'decision';
  this.decision = {
    playerId: carrier.id,
    options: this.buildOptions(carrier),
  };
  this.lastDecisionPos = { x: carrier.x, y: carrier.y };
};

// 为持球者生成 6 个指令（含服务器计算的成功率与精神消耗）
Match.prototype.buildOptions = function (p) {
  var self = this;
  var near = this.nearestOpponent(p);
  var keeper = this.byId[p.team === 'home' ? 'a1' : 'h1'];
  var goalX = p.team === 'home' ? FIELD.W : 0;
  var distGoal = Math.abs(goalX - p.x);

  function opt(id, rate, extra) {
    var def = C.COMMANDS.filter(function (c) { return c.id === id; })[0];
    var name = def.name;
    if (id === 'special' && p.special) name = '必杀技·' + p.special.name;
    var enabled = p.spirit >= def.cost;
    if (id === 'special' && (!p.special || (p.pos !== 'FW' && p.pos !== 'MF'))) enabled = false;
    return {
      id: id, name: name, cost: def.cost, desc: def.desc,
      rate: Math.round(clamp(rate, 1, 99)),
      enabled: enabled,
    };
  }

  var ef = effFactor(p);
  var defEf = effFactor(near.player);
  var keepEf = effFactor(keeper);
  var pressure = Math.max(0, 12 - near.dist) * 1.2;

  return [
    opt('dribble', 58 + ((p.stats.dribble + p.stats.speed) * ef - (near.player.stats.defend + near.player.stats.speed) * defEf) * 0.9),
    opt('pass', 72 + (p.stats.pass * ef - 60) * 0.7 - pressure),
    opt('shoot', 78 + (p.stats.shoot * ef - keeper.stats.keep * keepEf) * 1.1 - distGoal * 0.5),
    opt('special', 84 + ((p.stats.shoot * ef + 8) - keeper.stats.keep * keepEf) * 1.1 - distGoal * 0.32),
    opt('feint', 62 + (p.stats.dribble * ef - near.player.stats.defend * defEf) * 0.9),
    opt('retreat', 100),
  ];
};

// ---------- 指令结算（全部在服务器用服务器 RNG 完成） ----------

// 客户端指令入口：做严格的合法性校验（防作弊）
Match.prototype.applyCommand = function (playerId, commandId) {
  // 1. 必须是等待决策阶段
  if (this.phase !== 'decision' || !this.decision) {
    return { ok: false, error: '当前不需要做决策' };
  }
  // 2. 必须是轮到该球员（且是用户球队）
  if (this.decision.playerId !== playerId) {
    return { ok: false, error: '还没轮到你决策' };
  }
  var p = this.byId[playerId];
  if (!p || p.team !== 'home') {
    return { ok: false, error: '非法球员' };
  }
  // 3. 指令必须存在且可用
  var option = null;
  this.decision.options.forEach(function (o) { if (o.id === commandId) option = o; });
  if (!option) return { ok: false, error: '未知指令' };
  if (!option.enabled) return { ok: false, error: '精神不足或该球员无法使用此指令' };
  if (p.spirit < option.cost) return { ok: false, error: '精神不足' };

  // 4. 扣除精神（体能不受影响——体能设计）
  p.spirit = Math.max(0, p.spirit - option.cost);

  var result = this.resolveAction(p, commandId, option.rate);

  // 结算后恢复比赛；若刚进了球（phase 已被 goal() 置为 'goal'），则保持进球庆祝流程
  this.decision = null;
  if (this.phase === 'decision') {
    this.phase = 'play';
    this.nextDecisionAt = this.now + 2200;
    this.lastDecisionPos = { x: p.x, y: p.y };
    if (this.ball.ownerId && this.byId[this.ball.ownerId]) {
      var nc = this.byId[this.ball.ownerId];
      this.lastDecisionPos = { x: nc.x, y: nc.y };
    }
  }
  return { ok: true, result: result };
};

// 统一的动作结算：掷骰 -> 生效 -> 生成事件
Match.prototype.resolveAction = function (p, commandId, rate) {
  var roll = this.rng() * 100;
  var success = roll < rate;
  var near = this.nearestOpponent(p);
  var dir = p.team === 'home' ? 1 : -1;
  var text = '';

  switch (commandId) {
    case 'dribble': {
      var def = near.player;
      if (success) {
        p.x = clamp(def.x + 7 * dir, 2, FIELD.W - 2);
        p.y = clamp(def.y + (this.rng() - 0.5) * 6, 2, FIELD.H - 2);
        def.beatenUntil = this.now + 2000;
        text = p.name + ' 用突破晃过了 ' + def.name + '！';
      } else {
        this.ball.ownerId = def.id;
        text = p.name + ' 的突破被 ' + def.name + ' 断下！';
      }
      break;
    }
    case 'pass': {
      var target = this.bestPassTarget(p);
      if (success) {
        this.ball.ownerId = target.id;
        text = p.name + ' 把球传给了 ' + target.name + '。';
      } else {
        this.ball.ownerId = near.player.id;
        text = p.name + ' 的传球被 ' + near.player.name + ' 拦截！';
      }
      break;
    }
    case 'shoot':
    case 'special': {
      var isSpecial = commandId === 'special';
      var keeper = this.byId[p.team === 'home' ? 'a1' : 'h1'];
      var label = isSpecial && p.special ? p.special.name : '射门';
      this.shots[p.team]++;
      if (success) {
        this.goal(p, p.team);
        return { kind: commandId, label: label, playerName: p.name, success: true, text: this.lastAction.text };
      }
      // 失败：被扑出或偏出（球权给对方门将）
      this.ball.ownerId = keeper.id;
      if (this.rng() < 0.55) {
        text = p.name + ' 的' + label + '被门将 ' + keeper.name + ' 扑出！';
      } else {
        text = p.name + ' 的' + label + '偏出了球门……';
      }
      break;
    }
    case 'feint': {
      var d2 = near.player;
      if (success) {
        d2.frozenUntil = this.now + 2500;
        p.x = clamp(p.x + 3 * dir, 2, FIELD.W - 2);
        text = p.name + ' 的假动作晃晕了 ' + d2.name + '！';
      } else {
        d2.x = clamp(d2.x + (p.x - d2.x) * 0.4, 2, FIELD.W - 2);
        d2.y = clamp(d2.y + (p.y - d2.y) * 0.4, 2, FIELD.H - 2);
        text = p.name + ' 的假动作被 ' + d2.name + ' 看穿了。';
      }
      break;
    }
    case 'retreat': {
      p.retreatTarget = { x: clamp(p.x - 16 * dir, 6, FIELD.W - 6), y: FIELD.H / 2 };
      text = p.name + ' 带球回撤，稳住节奏。';
      success = true;
      break;
    }
  }

  this.lastAction = {
    kind: commandId,
    label: labelOf(commandId, p),
    playerName: p.name,
    team: p.team,
    success: success,
    text: text,
    until: Date.now() + 2200,
  };
  return this.lastAction;
};

function labelOf(commandId, p) {
  var def = C.COMMANDS.filter(function (c) { return c.id === commandId; })[0];
  if (commandId === 'special' && p.special) return '必杀技·' + p.special.name;
  return def.name;
}

// 选择传球目标：前插 + 空当综合最优的队友
Match.prototype.bestPassTarget = function (p) {
  var dir = p.team === 'home' ? 1 : -1;
  var self = this;
  var best = null, bestScore = -1e9;
  this.players.forEach(function (q) {
    if (q.team !== p.team || q.id === p.id || q.pos === 'GK') return;
    var forward = (q.x - p.x) * dir;
    var open = self.nearestOpponent(q).dist;
    var score = forward * 1.5 + open * 2.0;
    if (score > bestScore) { bestScore = score; best = q; }
  });
  return best || p;
};

// ---------- AI（客队） ----------
Match.prototype.aiDecide = function (p) {
  var near = this.nearestOpponent(p);
  var goalX = 0;
  var distGoal = Math.sqrt(Math.pow(p.x - goalX, 2) + Math.pow(p.y - FIELD.H / 2, 2));
  var choice;

  if (distGoal < 24) {
    // 射程内：有必杀技且精神够则用必杀，否则射门
    if (p.special && p.spirit >= 60 && this.rng() < 0.55) choice = 'special';
    else choice = 'shoot';
  } else if (p.pos === 'GK') {
    // 门将得球：大脚开给前场队友
    choice = 'pass';
  } else if (near.dist < 12) {
    choice = this.rng() < 0.6 ? 'pass' : 'dribble';
  } else {
    choice = 'dribble';
  }

  // AI 同样受精神限制
  var def = C.COMMANDS.filter(function (c) { return c.id === choice; })[0];
  if (!def || p.spirit < def.cost || (choice === 'special' && !p.special)) choice = 'pass';
  var def2 = C.COMMANDS.filter(function (c) { return c.id === choice; })[0];
  p.spirit = Math.max(0, p.spirit - def2.cost);

  var rate = this.buildOptions(p).filter(function (o) { return o.id === choice; })[0].rate;
  this.resolveAction(p, choice, rate);
  this.aiCooldownUntil = this.now + 2500 + this.rng() * 1500;
};

// ---------- 对外接口 ----------

Match.prototype.setPaused = function (paused) {
  this.paused = !!paused;
};

Match.prototype.setMentality = function (m) {
  if (['balanced', 'attack', 'defend'].indexOf(m) >= 0) this.mentality = m;
};

function fmtClock(sec) {
  var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
}

// 客户端可见的状态快照（只读，不含随机种子等敏感信息）
Match.prototype.serialize = function () {
  var self = this;
  var nowMs = Date.now();
  return {
    id: this.id,
    phase: this.phase,
    half: this.half,
    halfLabel: this.half === 1 ? '前半' : '后半',
    clock: this.clock,
    clockLabel: fmtClock(this.clock),
    score: { home: this.score.home, away: this.score.away },
    shots: { home: this.shots.home, away: this.shots.away },
    paused: this.paused,
    mentality: this.mentality,
    config: { halfLength: this.config.halfLength },
    players: this.players.map(function (p) {
      return {
        id: p.id, team: p.team, num: p.num, name: p.name, pos: p.pos,
        level: p.level, x: +p.x.toFixed(2), y: +p.y.toFixed(2),
        stats: p.stats,
        stamina: Math.round(p.stamina), maxStamina: p.maxStamina,
        spirit: Math.round(p.spirit), maxSpirit: p.maxSpirit,
        special: p.special ? { name: p.special.name } : null,
        hasBall: self.ball.ownerId === p.id,
        frozen: self.now < p.frozenUntil,
      };
    }),
    ball: { x: +this.ball.x.toFixed(2), y: +this.ball.y.toFixed(2) },
    decision: this.decision ? {
      playerId: this.decision.playerId,
      playerName: this.byId[this.decision.playerId].name,
      options: this.decision.options,
    } : null,
    lastAction: this.lastAction && this.lastAction.until > nowMs ? this.lastAction : null,
  };
};

module.exports = { Match: Match };
