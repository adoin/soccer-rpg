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
var Offside = require('./rules/offside');
var Foul = require('./rules/foul');
var Behavior = require('./rules/behavior');

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

  // 裁判与规则：每场比赛随机一名裁判（执法尺度影响牌阈值，不影响判罚正确性）
  this.referee = Foul.pickReferee(this.rng);
  this.pendingResume = null; // 哨声/点球后的恢复信息 { ownerId }

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
    p.holdingUntil = 0; // 急停收步中（行为层）
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
    case 'whistle':
    case 'penalty':
      // 死球阶段：等哨声流程走完再恢复
      this.now += dt * 1000;
      if (this.now >= this.phaseUntil) this.resumeStoppage();
      break;
  }
};

// ---------- 死球恢复（越位 / 犯规哨声 / 点球之后） ----------

Match.prototype.enterStoppage = function (phase, ms, ownerId) {
  this.phase = phase; // 'whistle' 或 'penalty'
  this.phaseUntil = this.now + ms;
  this.decision = null;
  this.pendingResume = { ownerId: ownerId };
};

Match.prototype.resumeStoppage = function () {
  var r = this.pendingResume;
  this.pendingResume = null;
  if (r && r.ownerId && this.byId[r.ownerId] && !this.byId[r.ownerId].sentOff) {
    this.ball.ownerId = r.ownerId;
    this.ball.x = this.byId[r.ownerId].x;
    this.ball.y = this.byId[r.ownerId].y;
  }
  this.phase = 'play';
  this.nextDecisionAt = this.now + 1500;
  var c = this.carrier();
  if (c) this.lastDecisionPos = { x: c.x, y: c.y };
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
  return this.players.filter(function (p) { return p.team !== team && !p.sentOff; });
};

Match.prototype.nearestOpponent = function (p) {
  var best = null, bd = 1e9, self = this;
  this.players.forEach(function (q) {
    if (q.team === p.team || q.sentOff) return;
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
  // ★ 行为层输入（每 tick 计算一次，确定性）：
  //   - pressing：正在上抢的防守球员（不参与防线落位）
  //   - lineTargets：防线落位目标（纪律/造越位协同驱动）
  //   - snapAtt：进攻方视角的越位快照（跑位时机/收步决策用）
  var pressing = {};
  sortedOpp.forEach(function (q, idx) {
    if (idx < 2 && self.now >= q.beatenUntil && self.now >= q.frozenUntil) pressing[q.id] = true;
  });
  var defTeam = carrier.team === 'home' ? 'away' : 'home';
  var lineTargets = Behavior.defensiveShape(self, defTeam, pressing);
  var snapAtt = Offside.snapshot(self, carrier.team);
  this.players.forEach(function (p) {
    if (p.id === carrier.id) return;
    if (p.sentOff) return; // 罚下球员不再参与模拟
    var pFrozen = self.now < p.frozenUntil;
    var beaten = self.now < p.beatenUntil;
    var tx, ty, sp;
    if (p.team !== carrier.team) {
      // 防守方：最近的 2 人（被晃过的不算）上抢，其余按防线行为落位
      var rank = sortedOpp.indexOf(p);
      if (rank >= 0 && rank < 2 && !beaten && !pFrozen) {
        tx = carrier.x; ty = carrier.y;
        sp = self.playerSpeed(p, true) * 0.94;
        chaseCount++;
      } else {
        // ★ 行为层：纪律好的后卫保持平行/协同压上，纪律差的各回阵型点
        var lt = (p.pos === 'DF' && lineTargets[p.id]) ? lineTargets[p.id] : null;
        if (lt) { tx = lt.x; ty = lt.y; }
        else { tx = p.hx; ty = p.hy; }
        sp = self.playerSpeed(p, false) * 0.7;
      }
    } else if (p.pos === 'GK') {
      tx = p.hx; ty = p.hy;
      sp = self.playerSpeed(p, false) * 0.7;
    } else if (self.now < p.holdingUntil) {
      // ★ 行为层：急停收步中——原地不动，不参与这次进攻
      tx = p.x; ty = p.y;
      sp = 0;
    } else {
      // 进攻方无球跑位：前插接应
      var push = self.mentality === 'attack' ? 16 : self.mentality === 'defend' ? 6 : 11;
      tx = clamp(carrier.x + push * dir, 4, FIELD.W - 4);
      ty = clamp(p.hy * 0.5 + carrier.y * 0.5 + (p.hy - FIELD.H / 2) * 0.35, 4, FIELD.H - 4);
      if (p.pos === 'FW' || p.pos === 'MF') {
        // ★ 行为层·反越位时机：高 anti 球员把前插目标钳制在越位线之前
        var wantU = p.team === 'home' ? tx : FIELD.W - tx;
        var fixedU = Behavior.timeRunU(p, wantU, snapAtt);
        if (fixedU != null) tx = p.team === 'home' ? fixedU : FIELD.W - fixedU;
        // ★ 行为层·越位后的决策：收步的球员快速回位，不越位/选择前插的不管
        if (Offside.isOffsidePosition(p, snapAtt) && Behavior.attackerDecision(p, snapAtt) === 'hold') {
          tx = clamp(p.x - 14 * dir, 4, FIELD.W - 4);
          ty = p.hy;
        }
      }
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
    // 门将不参与射门：避免出现"门将 1% 成功率射门"这种无意义选项，引导玩家用传球组织
    if (p.pos === 'GK' && (id === 'shoot' || id === 'special')) enabled = false;
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
        // ★ 抢断对决：干净抢断 / 犯规 / 被过掉（基于数值随机）
        var t = Foul.judgeTackle(this, def, p, {
          fromBehind: false,
          speedHigh: true,
          attackPromising: Foul.distGoal(p, p.team) < 30,
        });
        if (t.outcome === 'clean') {
          this.ball.ownerId = def.id;
          text = p.name + ' 的突破被 ' + def.name + ' 干净地断下！';
        } else if (t.outcome === 'beaten') {
          def.beatenUntil = this.now + 2000;
          p.x = clamp(def.x + 7 * dir, 2, FIELD.W - 2);
          text = p.name + ' 强行抹过了 ' + def.name + '！';
        } else {
          return this.applyFoulResult(t.foul);
        }
      }
      break;
    }
    case 'pass': {
      var target = this.bestPassTarget(p);
      // ★ 行为层先行：接应目标若处越位位置，先看他自己的决策——
      //   急停收步（hold）还是继续前插（go）。这是球员的行为选择，
      //   不是裁判的豁免：选择前插而实际越位，哨声照吹。
      var snapPass = Offside.snapshot(this, p.team);
      if (Offside.isOffsidePosition(target, snapPass) &&
          Behavior.attackerDecision(target, snapPass) === 'hold') {
        target.holdingUntil = this.now + 2500;
        var alt = this.bestOnsideTarget(p, snapPass);
        if (alt) {
          text = '⚠ ' + target.name + '识破越位陷阱，急停收步！' + p.name + '改传' + alt.name + '。';
          target = alt;
        } else {
          var interceptor = this.nearestOpponent(p).player;
          this.ball.ownerId = interceptor.id;
          text = '⚠ ' + target.name + '急停收步，但' + p.name + '的传球线路已被' + interceptor.name + '封死！';
          break;
        }
      }
      // ★ 裁判层：纯客观判定，不看任何数值
      var os = Offside.judgePass(this, p, target);
      if (os.type === 'offside') {
        return this.whistleOffside(os, p);
      }
      if (success) {
        this.ball.ownerId = target.id;
        if (!text) text = p.name + ' 把球传给了 ' + target.name + '。';
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
      // ★ 射门瞬间：越位位置球员遮挡门将视线 / 挡在射门线路上 → 直接吹越位
      var osShot = Offside.judgeShot(this, p);
      if (osShot.type === 'offside') {
        return this.whistleOffside(osShot, p);
      }
      this.shots[p.team]++;
      if (success) {
        this.goal(p, p.team);
        return { kind: commandId, label: label, playerName: p.name, success: true, text: this.lastAction.text };
      }
      // 失败：被扑出或偏出
      this.ball.ownerId = keeper.id;
      var saved = this.rng() < 0.55;
      if (saved) {
        // 球反弹到门前区域
        this.ball.x = clamp(keeper.x - 6 * dir, 2, FIELD.W - 2);
        this.ball.y = clamp(keeper.y + (this.rng() - 0.5) * 10, 2, FIELD.H - 2);
        // ★ 门将扑救反弹：以射门瞬间快照判断越位位置获益 → 吹越位
        var osReb = Offside.judgeRebound(this, p.team, osShot.snap);
        if (osReb.type === 'offside') {
          return this.whistleOffside(osReb, p);
        }
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
        // ★ 假动作被看穿：防守方上抢，同样走抢断对决
        var t2 = Foul.judgeTackle(this, d2, p, {
          fromBehind: false,
          speedHigh: false,
          attackPromising: false,
        });
        if (t2.outcome === 'clean') {
          this.ball.ownerId = d2.id;
          text = p.name + ' 的假动作被 ' + d2.name + ' 看穿并断下！';
        } else if (t2.outcome === 'beaten') {
          d2.beatenUntil = this.now + 1500;
          text = p.name + ' 的假动作没晃开 ' + d2.name + '，但顺势抹了过去！';
        } else {
          return this.applyFoulResult(t2.foul);
        }
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
    if (q.team !== p.team || q.id === p.id || q.pos === 'GK' || q.sentOff) return;
    var forward = (q.x - p.x) * dir;
    var open = self.nearestOpponent(q).dist;
    var score = forward * 1.5 + open * 2.0;
    if (score > bestScore) { bestScore = score; best = q; }
  });
  return best || p;
};

// 选择不越位位置的传球目标（收步改传用）
Match.prototype.bestOnsideTarget = function (p, snap) {
  var dir = p.team === 'home' ? 1 : -1;
  var self = this;
  var best = null, bestScore = -1e9;
  this.players.forEach(function (q) {
    if (q.team !== p.team || q.id === p.id || q.pos === 'GK' || q.sentOff) return;
    if (Offside.isOffsidePosition(q, snap)) return;
    var forward = (q.x - p.x) * dir;
    var open = self.nearestOpponent(q).dist;
    var score = forward * 1.5 + open * 2.0;
    if (score > bestScore) { bestScore = score; best = q; }
  });
  return best;
};

// ---------- 越位哨声：间接任意球 ----------
Match.prototype.whistleOffside = function (os, passer) {
  var defendingTeam = passer.team === 'home' ? 'away' : 'home';
  var taker = null, bd = 1e9, self = this;
  this.players.forEach(function (q) {
    if (q.team !== defendingTeam || q.sentOff) return;
    var d = dist(q, os.spot);
    if (d < bd) { bd = d; taker = q; }
  });
  if (taker) {
    this.ball.ownerId = taker.id;
    this.ball.x = taker.x; this.ball.y = taker.y;
  }
  this.enterStoppage('whistle', 2200, this.ball.ownerId);
  var teamName = defendingTeam === 'home' ? T.HOME_NAME : T.AWAY_NAME;
  this.lastAction = {
    kind: 'offside',
    label: '越位',
    playerName: os.player.name,
    team: defendingTeam,
    success: false,
    text: Offside.reasonText(os.reason, os.player) + ' ' + teamName + '获得间接任意球。',
    until: Date.now() + 2200,
  };
  return this.lastAction;
};

// ---------- 犯规处理：任意球 / 点球 / 进攻有利 ----------
Match.prototype.applyFoulResult = function (foul) {
  Foul.applyCards(foul);
  var vName = foul.victim.name;

  if (foul.advantage) {
    this.lastAction = {
      kind: 'advantage',
      label: '进攻有利',
      playerName: vName,
      team: foul.team,
      success: true,
      text: '🟢 ' + foul.defender.name + '犯规，但裁判示意进攻有利，比赛继续！',
      until: Date.now() + 2200,
    };
    return this.lastAction;
  }

  var text = Foul.cardText(foul);
  var teamName = foul.team === 'home' ? T.HOME_NAME : T.AWAY_NAME;
  if (!foul.penalty) text += teamName + '获得直接任意球。';

  if (foul.penalty) {
    return this.resolvePenalty(foul, text);
  }

  // 直接任意球：受害方在犯规地点重新组织
  this.ball.ownerId = foul.victim.id;
  this.ball.x = foul.spot.x; this.ball.y = foul.spot.y;
  this.enterStoppage('whistle', 2400, foul.victim.id);
  var cardLabel = foul.card === 'red' ? '红牌' : (foul.card === 'yellow' ? '黄牌' : '犯规');
  this.lastAction = {
    kind: 'foul',
    label: cardLabel,
    playerName: foul.defender.name,
    team: foul.team,
    success: false,
    text: text,
    until: Date.now() + 2400,
  };
  return this.lastAction;
};

// ---------- 点球 ----------
Match.prototype.resolvePenalty = function (foul, prefixText) {
  var shooter = foul.victim;
  var keeperTeam = shooter.team === 'home' ? 'away' : 'home';
  var keeper = this.byId[shooter.team === 'home' ? 'a1' : 'h1'];
  if (!keeper || keeper.sentOff) {
    // 极端情况：门将被罚下过，找一名场上球员客串
    keeper = null;
    this.players.forEach(function (q) {
      if (q.team === keeperTeam && !q.sentOff && !keeper) keeper = q;
    });
  }
  this.shots[shooter.team]++;
  var sEff = effFactor(shooter), kEff = effFactor(keeper);
  var pGoal = clamp(
    0.74 + (shooter.stats.shoot * sEff - keeper.stats.keep * kEff) * 0.01 +
    (shooter.stats.nerve - keeper.stats.nerve) * 0.004,
    0.4, 0.95
  );
  var roll = this.rng();
  var call = prefixText + ' ' + shooter.name + '主罚点球……';
  if (roll < pGoal) {
    this.goal(shooter, shooter.team);
    this.lastAction.kind = 'penalty';
    this.lastAction.label = '点球命中';
    this.lastAction.text = call + '球进了！' + shooter.name + '顶住压力罚入点球！';
    return this.lastAction;
  }
  this.ball.ownerId = keeper.id;
  this.enterStoppage('whistle', 2000, keeper.id);
  this.lastAction = {
    kind: 'penalty',
    label: '点球罚失',
    playerName: shooter.name,
    team: shooter.team,
    success: false,
    text: call + (roll < pGoal + 0.12 ? '被门将' + keeper.name + '神勇扑出！' : '偏出了球门！'),
    until: Date.now() + 2000,
  };
  return this.lastAction;
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
        cards: p.cards,
        sentOff: !!p.sentOff,
      };
    }),
    referee: { name: this.referee.name, strictness: this.referee.strictness },
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
