// server/game/engine.js
// ============================================================
// 比赛引擎：服务器权威（Server-Authoritative）的核心。
//
// 防作弊设计：
//  1. 全部关键数据（球员位置、体能、比分、时钟）只存在服务器内存，
//     客户端只能通过轮询读取快照，不能写入。
//  2. 客户端唯一能发送的是 { matchId, commandId }，服务器会校验：
//     - 是否正处于「等待该用户决策」的阶段；
//     - 指令是否合法、体能是否足够；
//     - 结算全部使用服务器端 RNG（server/rng.js），客户端无法预测结果。
//  3. 对手 AI、无球跑位、成功率计算全部在服务器完成。
//
// ★ 体能设计（单资源制，无精神力，2026-09-27 起）：
//  - 全场只有「体能」一条资源（0~100）；技能与跑动统一消耗体能；
//  - 定价按现实耗能：走 0.02/m，跑动 0.08/m，冲刺 0.25/m；
//    静止恢复 1.2/s，中场休息恢复 45；
//  - 体能越低实际能力越弱（系数 0.75~1.0），体能不足无法使用指令/冲刺。
// ============================================================
'use strict';

var C = require('../../shared/constants');
var T = require('../../shared/teams');
var FM = require('../../shared/fm');
var mulberry32 = require('../rng').mulberry32;
var Offside = require('./rules/offside');
var Foul = require('./rules/foul');
var Behavior = require('./rules/behavior');
var Pass = require('./rules/pass');

var FIELD = C.FIELD;

// ---------- 小工具 ----------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist(a, b) {
  var dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
// 体能修正系数（单资源制）：体能越低，实际能力越弱（0.75 ~ 1.0）
function effFactor(p) {
  return 0.75 + 0.25 * (p.stamina / p.maxStamina);
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

  // ★ 直接操控：玩家实时操控一名主队球员（WASD / 虚拟手柄）。
  // 服务器只接受「方向向量 + 加速/减速 + 切换」，位置仍由服务器模拟（防作弊）。
  this.control = {
    playerId: null,  // 被操控的球员 id
    dx: 0, dy: 0,    // 输入方向（-1..1）
    sprint: false, slow: false,
    stamp: -1e9,     // 最近一次输入包时间（服务器时钟）
    activeStamp: -1e9, // 最近一次“有效操作”时间；超时无操作则 AI 接管该球员
  };

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
    p._px = p.hx; p._py = p.hy; // 体能计费用的上一 tick 位置
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
  // nextDecisionAt 在 kickoff→play 切换时设置（见 tick），保证 4.5 秒是纯比赛时间
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

// ★ 射门飞行阶段：球按瞄准点飞向球门，门将飞身扑救、防守球员回追，落地后按既定结果结算
Match.prototype.startShotFlight = function (p, keeper, o) {
  var dir = p.team === 'home' ? 1 : -1;
  var goalX = p.team === 'home' ? FIELD.W : 0;
  var gy = FIELD.H / 2, goalHalf = 3.66;
  var x0 = p.x, y0 = p.y, x1, y1;
  var shotSide = this.rng() < 0.5 ? -1 : 1;
  if (o.outcome === 'goal') {
    // 瞄死角：打进球门内
    x1 = goalX;
    y1 = clamp(gy + shotSide * (goalHalf - 0.5 - this.rng() * 1.4), gy - goalHalf + 0.3, gy + goalHalf - 0.3);
  } else if (o.outcome === 'saved') {
    // 朝门将方向打：落点在门将可及范围
    x1 = goalX;
    y1 = clamp(keeper.y + (this.rng() - 0.5) * 5, gy - goalHalf + 0.3, gy + goalHalf - 0.3);
  } else {
    // 偏出：飞出门框范围
    x1 = goalX + dir * 2.5;
    y1 = gy + shotSide * (goalHalf + 1.4 + this.rng() * 2.6);
  }
  var dist = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
  var ballSpd = o.isSpecial ? 34 : 27;
  var durMs = clamp(Math.round(dist / ballSpd * 1000), 450, 1500);
  // 门将扑救目标：
  //   goal → 大概率判断错方向（扑反角 / 扑近角但够不着），演出"门将尽力但鞭长莫及"；
  //   saved/miss → 扑向来球线路
  var kx, ky, kSpd;
  if (o.outcome === 'goal') {
    var wrongSide = this.rng() < 0.7 ? -shotSide : shotSide;
    kx = goalX - dir * 1.2;
    ky = clamp(gy + wrongSide * (goalHalf - 1.2), gy - goalHalf, gy + goalHalf);
    kSpd = 13;
  } else {
    kx = clamp(x1 - dir * 0.8, 2, FIELD.W - 2);
    ky = clamp(y1, 2, FIELD.H - 2);
    var kd = Math.sqrt((kx - keeper.x) * (kx - keeper.x) + (ky - keeper.y) * (ky - keeper.y));
    kSpd = clamp(kd / (durMs / 1000) * (o.outcome === 'saved' ? 1.02 : 0.9), 8, 24);
  }
  // 两名回追的防守球员（不含门将）：离落点最近的对方球员
  var chasers = [];
  var cands = this.players.filter(function (q) {
    return q.team !== p.team && q.id !== keeper.id && !q.sentOff;
  });
  cands.sort(function (a, b) {
    var da = (a.x - x1) * (a.x - x1) + (a.y - y1) * (a.y - y1);
    var db = (b.x - x1) * (b.x - x1) + (b.y - y1) * (b.y - y1);
    return da - db;
  });
  for (var i = 0; i < Math.min(2, cands.length); i++) chasers.push(cands[i].id);
  this.shotFlight = {
    shooterId: p.id, keeperId: keeper.id, team: p.team,
    isSpecial: o.isSpecial, label: o.label, outcome: o.outcome, snap: o.snap,
    x0: x0, y0: y0, x1: x1, y1: y1,
    startAt: this.now, durMs: durMs,
    kx: kx, ky: ky, kSpd: kSpd, chasers: chasers,
  };
  this.ball.ownerId = null;
  this.ball.x = x0; this.ball.y = y0;
  this.lastAction = null; // 飞行期间不出演出遮罩，保证场上动作可见
  this.phase = 'shotflight';
  this.phaseUntil = this.now + durMs;
};

// 射门飞行结束：按既定结果结算（进球 / 被扑 / 偏出门球）
Match.prototype.finishShotFlight = function () {
  var sf = this.shotFlight;
  this.shotFlight = null;
  if (!sf) {
    if (this.phase === 'shotflight') this.phase = 'play';
    return;
  }
  var shooter = this.byId[sf.shooterId];
  var keeper = this.byId[sf.keeperId];
  this.ball.x = sf.x1; this.ball.y = sf.y1;
  if (sf.outcome === 'goal') {
    this.goal(shooter, sf.team);
    this.lastAction.cut = sf.isSpecial ? 'special-goal' : 'shoot-goal';
    return;
  }
  if (sf.outcome === 'saved') {
    this.ball.ownerId = keeper.id;
    // ★ 门将扑救反弹：以射门瞬间快照判断越位位置获益 → 吹越位
    var osReb = Offside.judgeRebound(this, sf.team, sf.snap);
    if (osReb.type === 'offside') return this.whistleOffside(osReb, shooter);
    this.lastAction = {
      kind: 'shoot', label: '射门', playerName: shooter.name, team: sf.team, success: false,
      cut: sf.isSpecial ? 'special-save' : 'shoot-save',
      text: shooter.name + ' 的' + sf.label + '被门将 ' + keeper.name + ' 扑出！',
      until: Date.now() + 2600,
    };
  } else {
    // 偏出 → 门球
    this.lastAction = {
      kind: 'shoot', label: '射门', playerName: shooter.name, team: sf.team, success: false,
      cut: 'shoot-miss',
      text: shooter.name + ' 的' + sf.label + '偏出了球门……',
      until: Date.now() + 2600,
    };
    this.enterStoppage('whistle', 1600, keeper.id);
    return;
  }
  this.phase = 'play';
  this.nextDecisionAt = this.now + 2200;
  var c = this.carrier();
  this.lastDecisionPos = c ? { x: c.x, y: c.y } : { x: this.ball.x, y: this.ball.y };
};

Match.prototype.tick = function () {
  if (this.paused) return;
  var dt = this.config.tickMs / 1000;

  switch (this.phase) {
    case 'kickoff':
      this.now += dt * 1000;
      if (this.now >= this.phaseUntil) {
        this.phase = 'play';
        // 开球保护：从真正开球（进入 play）起算 4.5 秒，避免对方 10 号贴脸瞬间触发决策
        this.nextDecisionAt = this.now + 4500;
      }
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
    case 'shotflight': {
      // ★ 射门飞行：球飞向瞄准点，门将飞身扑救、防守球员回追；落地后按既定结果结算
      this.now += dt * 1000;
      this.clock += dt;
      var sf = this.shotFlight;
      if (sf) {
        var k = clamp((this.now - sf.startAt) / sf.durMs, 0, 1);
        this.ball.x = sf.x0 + (sf.x1 - sf.x0) * k;
        this.ball.y = sf.y0 + (sf.y1 - sf.y0) * k;
        var kp = this.byId[sf.keeperId];
        if (kp && !kp.sentOff) this.moveToward(kp, sf.kx, sf.ky, sf.kSpd, dt);
        for (var ci = 0; ci < sf.chasers.length; ci++) {
          var ch = this.byId[sf.chasers[ci]];
          if (ch && !ch.sentOff && this.now >= ch.frozenUntil) {
            this.moveToward(ch, this.ball.x, this.ball.y, this.playerSpeed(ch, true), dt);
          }
        }
      }
      if (this.now >= this.phaseUntil) this.finishShotFlight();
      break;
    }
    case 'halftime':
      this.now += dt * 1000;
      if (this.now >= this.phaseUntil) {
        this.half = 2;
        this.clock = 0;
        // 体能中场休息大幅恢复（单资源制）
        this.players.forEach(function (p) {
          p.stamina = Math.min(p.maxStamina, p.stamina + C.STAMINA.HALFTIME_RECOVER);
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

// ★ 直接操控：若该球员正被玩家操控且 2 秒内有有效操作，用输入方向移动，跳过 AI。
// 返回 true 表示本 tick 的移动已由输入接管（含冻结/松手的情况，避免 AI 顶替）。
Match.prototype.controlMove = function (p, dt) {
  var c = this.control;
  if (p.id !== c.playerId) return false;
  if (this.now - c.activeStamp > 2000) return false; // 超时无操作：AI 接管
  if (this.now < p.frozenUntil) return true;
  if (c.dx === 0 && c.dy === 0) return true; // 松手：原地不动
  // 体能过低蹬不动：低于阈值时加速键失效，只能普通跑
  var wantSprint = c.sprint && p.stamina >= C.STAMINA.SPRINT_MIN;
  var sp = this.playerSpeed(p, wantSprint);
  if (c.slow) sp *= 0.45;
  this.moveToward(p, p.x + c.dx * 30, p.y + c.dy * 30, sp, dt);
  return true;
};

Match.prototype.playerSpeed = function (p, sprint) {
  var base = 13 * (0.8 + FM.speed(p) / 250);
  if (sprint) base *= 1.08;
  base *= 0.7 + 0.3 * (p.stamina / p.maxStamina); // 体能影响速度：见底时只剩 7 成
  return base;
};

// ★ 体能更新（单资源制，无精神力）：
//   四档：散步 0.004/m、慢跑 0.010/m、高速跑 0.022/m、冲刺 0.060/m（档位 = 实际速度/个人极限）。
//   修正：持球 ×1.35；急停变向（单 tick 转向 >70°）0.3/次；
//   爆发（从非冲刺档突然提到冲刺档）0.4/次；身体对抗（1.2m 内有对手）1.5/s。
//   静止恢复 1.2/s，散步一边走一边小幅恢复 0.4/s。
Match.prototype.updateEnergy = function (p, dt) {
  var ox = (p._px != null ? p._px : p.x), oy = (p._py != null ? p._py : p.y);
  var dx = p.x - ox, dy = p.y - oy;
  var moved = Math.sqrt(dx * dx + dy * dy);
  p._px = p.x; p._py = p.y;
  var T = C.STAMINA;
  if (moved > 0.001 && dt > 0) {
    var vmax = this.playerSpeed(p, true) || 1;
    var r = (moved / dt) / vmax;
    var tier = T.MOVE_TIERS.length - 1, perMeter = T.MOVE_TIERS[tier].perMeter;
    for (var i = 0; i < T.MOVE_TIERS.length; i++) {
      if (r <= T.MOVE_TIERS[i].upTo) { tier = i; perMeter = T.MOVE_TIERS[i].perMeter; break; }
    }
    var mul = (this.ball.ownerId === p.id) ? T.DRIBBLE_MUL : 1; // ★ 持球修正
    p.stamina -= moved * perMeter * mul;
    // ★ 急停变向：本 tick 位移方向相对上 tick 偏转超过阈值
    if (p._ldx != null && moved > 0.15) {
      var l1 = Math.sqrt(p._ldx * p._ldx + p._ldy * p._ldy);
      if (l1 > 0.05) {
        var cos = (p._ldx * dx + p._ldy * dy) / (l1 * moved);
        if (Math.acos(clamp(cos, -1, 1)) > T.TURN_ANGLE) p.stamina -= T.TURN_COST;
      }
    }
    p._ldx = dx; p._ldy = dy;
    // ★ 爆发：从非冲刺档突然提到冲刺档
    if (p._ltier != null && p._ltier < T.MOVE_TIERS.length - 1 && tier === T.MOVE_TIERS.length - 1) {
      p.stamina -= T.BURST_COST;
    }
    p._ltier = tier;
    // 散步档一边走一边小幅恢复
    if (tier === 0) p.stamina += T.RECOVER_WALK * dt;
  } else {
    p.stamina += T.RECOVER_IDLE * dt;
    p._ltier = null; p._ldx = null;
  }
  // ★ 身体对抗：1.2 米内有对手紧贴（动静都算，拼抢消耗）
  if (this.nearestOpponent(p).dist < T.CONTACT_DIST) p.stamina -= T.CONTACT_DRAIN * dt;
  p.stamina = clamp(p.stamina, 0, p.maxStamina);
};

Match.prototype.simulate = function (dt) {
  var self = this;
  var carrier = this.carrier();
  if (!carrier) return;

  var dir = carrier.team === 'home' ? 1 : -1; // 进攻方向

  // --- 持球者移动 ---
  var frozen = this.now < carrier.frozenUntil;
  var cSpeed = this.playerSpeed(carrier, true);
  if (!frozen) {
    if (this.controlMove(carrier, dt)) {
      // ★ 被玩家直接操控：按输入方向移动，不自动推进
    } else if (carrier.retreatTarget) {
      var arrived = this.moveToward(carrier, carrier.retreatTarget.x, carrier.retreatTarget.y, cSpeed * 0.9, dt);
      if (arrived) carrier.retreatTarget = null;
    } else {
      // ★ 行为层·持球者：被紧逼时减速护球并向空侧微调，不再无脑直线冲门
      var adj = Behavior.carrierAdjust(self, carrier);
      self.moveToward(carrier, adj.tx, adj.ty, cSpeed * adj.spMul, dt);
    }
  }
  this.updateEnergy(carrier, dt);

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
  // ★ 行为层·无球任务：进攻方接应/前插/拉边/拖后（带任务粘性），防守方中场盯人
  var atkTasks = Behavior.attackTasks(self, carrier, snapAtt);
  var manMarks = Behavior.markTargets(self, defTeam, carrier, pressing);
  this.players.forEach(function (p) {
    if (p.id === carrier.id) return;
    if (p.sentOff) return; // 罚下球员不再参与模拟
    // ★ 被玩家直接操控：按输入移动，跳过 AI 跑位
    if (self.controlMove(p, dt)) {
      self.updateEnergy(p, dt);
      return;
    }
    var pFrozen = self.now < p.frozenUntil;
    var beaten = self.now < p.beatenUntil;
    var tx, ty, sp;
    if (p.team !== carrier.team) {
      // 防守方：第 1 人上抢，第 2 人协防卡传球线路，其余按行为落位
      var rank = sortedOpp.indexOf(p);
      if (rank === 0 && !beaten && !pFrozen) {
        tx = carrier.x; ty = carrier.y;
        sp = self.playerSpeed(p, true) * 0.94;
        chaseCount++;
      } else if (rank === 1 && !beaten && !pFrozen) {
        // ★ 协防：卡持球者与球门连线中点偏后，断传球/推进线路
        var gx2 = carrier.team === 'home' ? FIELD.W : 0;
        tx = (carrier.x + gx2) / 2; ty = (carrier.y + FIELD.H / 2) / 2;
        sp = self.playerSpeed(p, false) * 0.8;
      } else {
        // ★ 行为层：DF 按防线纪律落位/造越位，MF 盯人，都没有则回阵型点
        var lt = (p.pos === 'DF' && lineTargets[p.id]) ? lineTargets[p.id] : null;
        var mk = manMarks[p.id];
        if (lt) { tx = lt.x; ty = lt.y; }
        else if (mk) { tx = mk.x; ty = mk.y; }
        else { tx = p.hx; ty = p.hy; }
        sp = self.playerSpeed(p, false) * (mk ? 0.85 : 0.7);
      }
    } else if (p.pos === 'GK') {
      // ★ 行为层·门将：随球横向小范围移动
      var kt = Behavior.keeperTarget(self, p);
      tx = kt.x; ty = kt.y;
      sp = self.playerSpeed(p, false) * 0.7;
    } else if (self.now < p.holdingUntil) {
      // ★ 行为层：急停收步中——原地不动，不参与这次进攻
      tx = p.x; ty = p.y;
      sp = 0;
    } else {
      // ★ 行为层·无球任务：接应/前插/拉边/拖后（带任务粘性，不再全员同步前压）
      var at = atkTasks[p.id];
      if (at) { tx = at.x; ty = at.y; }
      else { tx = p.hx; ty = p.hy; }
      sp = self.playerSpeed(p, false) * (at && at.type === 'run' ? 0.9 : 0.8);
    }
    if (!pFrozen) {
      self.moveToward(p, tx, ty, sp, dt);
    }
    self.updateEnergy(p, dt);
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

// 为持球者生成 6 个指令（含服务器计算的成功率与体能消耗）
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
    var enabled = p.stamina >= def.cost;
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
    opt('dribble', 58 + ((FM.dribble(p) + FM.speed(p)) * ef - (FM.defend(near.player) + FM.speed(near.player)) * defEf) * 0.9),
    (function (o) {
      // ★ 传球多阶段菜单：把该球员可用的脚法告诉客户端（按 technique 能力解锁）
      o.passOpts = { techniques: Pass.availableTechniques(p) };
      return o;
    })(opt('pass', 72 + (FM.pass(p) * ef - 60) * 0.7 - pressure)),
    // ★ 护球：身体对抗（强壮+平衡）对抢断，成功则卡住逼抢者
    opt('protect', 68 + ((FM.v(p, 'strength') + FM.v(p, 'balance')) / 2 * ef - FM.defend(near.player) * defEf) * 0.7),
    opt('shoot', 78 + (FM.shoot(p) * ef - FM.keep(keeper) * keepEf) * 1.1 - distGoal * 0.5),
    opt('special', 84 + ((FM.shoot(p) * ef + 8) - FM.keep(keeper) * keepEf) * 1.1 - distGoal * 0.32),
    opt('feint', 62 + (FM.dribble(p) * ef - FM.defend(near.player) * defEf) * 0.9),
    opt('retreat', 100),
  ];
};

// ★ 传球预估落点（供客户端在确认前显示）：纯计算，不掷骰、不改状态
Match.prototype.passPreview = function (playerId, rawParams) {
  if (this.phase !== 'decision' || !this.decision || this.decision.playerId !== playerId) {
    return { ok: false, error: '当前不需要做决策' };
  }
  var p = this.byId[playerId];
  if (!p || p.team !== 'home') return { ok: false, error: '非法球员' };
  var pp = Pass.validateParams(rawParams, p);
  var land = Pass.computeLanding(p, pp, FM.pass(p) * effFactor(p));
  return { ok: true, preview: { x: land.x, y: land.y, r: land.r, params: pp } };
};

// ---------- 指令结算（全部在服务器用服务器 RNG 完成） ----------

// 客户端指令入口：做严格的合法性校验（防作弊）
Match.prototype.applyCommand = function (playerId, commandId, params) {
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
  if (!option.enabled) return { ok: false, error: '体能不足或该球员无法使用此指令' };
  if (p.stamina < option.cost) return { ok: false, error: '体能不足' };

  // 4. 扣除体能（单资源制）
  p.stamina = Math.max(0, p.stamina - option.cost);

  var result = this.resolveAction(p, commandId, option.rate, params);

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
Match.prototype.resolveAction = function (p, commandId, rate, params) {
  var roll = this.rng() * 100;
  var success = roll < rate;
  var near = this.nearestOpponent(p);
  var dir = p.team === 'home' ? 1 : -1;
  var text = '';
  var cut = null; // ★ 结算演出图键（客户端全屏像素风演出），无则用旧版侧栏面板

  switch (commandId) {
    case 'dribble': {
      var def = near.player;
      if (success) {
        p.x = clamp(def.x + 7 * dir, 2, FIELD.W - 2);
        p.y = clamp(def.y + (this.rng() - 0.5) * 6, 2, FIELD.H - 2);
        def.beatenUntil = this.now + 2000;
        text = p.name + ' 用突破晃过了 ' + def.name + '！';
        cut = 'dribble-win';
      } else {
        // ★ 抢断对决：干净抢断 / 犯规 / 被过掉（基于数值随机）；上抢的防守方消耗体能
        var t = Foul.judgeTackle(this, def, p, {
          fromBehind: false,
          speedHigh: true,
          attackPromising: Foul.distGoal(p, p.team) < 30,
        });
        def.stamina = Math.max(0, def.stamina - C.STAMINA.TACKLE_COST);
        if (t.outcome === 'clean') {
          this.ball.ownerId = def.id;
          text = p.name + ' 的突破被 ' + def.name + ' 干净地断下！';
          cut = 'dribble-lose';
        } else if (t.outcome === 'beaten') {
          def.beatenUntil = this.now + 2000;
          p.x = clamp(def.x + 7 * dir, 2, FIELD.W - 2);
          text = p.name + ' 强行抹过了 ' + def.name + '！';
          cut = 'dribble-win';
        } else {
          return this.applyFoulResult(t.foul);
        }
      }
      break;
    }
    case 'pass': {
      // ★ 多阶段传球：params{长/短,方向8向,脚法,高度,力量} → 预估落点 → 散布掷骰 → 球感修正
      //   无 params（AI/测试）时自动朝最佳接应队友生成
      var pp = Pass.validateParams(params || Pass.autoParams(this, p), p);
      var passAb = FM.pass(p) * effFactor(p);
      var land = Pass.computeLanding(p, pp, passAb);
      // 实际落点：散布圈内掷骰（传球能力决定圈大小）
      var ax = clamp(land.x + (this.rng() * 2 - 1) * land.r, 2, FIELD.W - 2);
      var ay = clamp(land.y + (this.rng() * 2 - 1) * land.r, 2, FIELD.H - 2);
      // ★ 球感修正：实际落点向最近队友的理想接球点靠拢
      var corr = Pass.correctLanding(this, p, ax, ay);
      var target = corr.target;
      var techName = Pass.TECHNIQUES[pp.technique].name;
      var kindName = pp.kind === 'long' ? '长传' : '短传';
      // ★ 行为层先行：接应目标若处越位位置，先看他自己的决策——
      //   急停收步（hold）还是继续前插（go）。这是球员的行为选择，
      //   不是裁判的豁免：选择前插而实际越位，哨声照吹。
      var targetHeld = false;
      var snapPass = null;
      if (target) {
        snapPass = Offside.snapshot(this, p.team);
        targetHeld = Offside.isOffsidePosition(target, snapPass) &&
            Behavior.attackerDecision(target, snapPass) === 'hold';
      }
      if (targetHeld) {
        target.holdingUntil = this.now + 2500; // 收步：停止触球、回位、不参与
        // ★ 收步者不参与进攻：跳过他的"越位接球"检查（skipReceive），
        //   其他越位位置队友的干扰照常吹罚
        var osHeld = Offside.judgePass(this, p, target, true);
        if (osHeld.type === 'offside') {
          return this.whistleOffside(osHeld, p);
        }
        // ★ 目标收步：不偷偷改传其他人。球仍沿原线路飞出，无人接应 → 被离落点最近的防守球员得到
        var oppTeam = p.team === 'home' ? 'away' : 'home';
        var best = null, bd = 1e9;
        this.players.forEach(function (q) {
          if (q.team !== oppTeam || q.sentOff) return;
          var d = Math.sqrt((q.x - corr.x) * (q.x - corr.x) + (q.y - corr.y) * (q.y - corr.y));
          if (d < bd) { bd = d; best = q; }
        });
        this.ball.ownerId = best.id;
        this.ball.x = corr.x; this.ball.y = corr.y;
        text = '⚠ ' + target.name + '识破越位陷阱，急停收步！' + p.name + '的' + techName + kindName + '滚向无人地带，被' + best.name + '得到。';
        success = false;
        cut = 'pass-lose';
        break;
      }
      // ★ 裁判层：纯客观判定，不看任何数值（目标前插参与 → 越位照吹）
      if (target) {
        var os = Offside.judgePass(this, p, target);
        if (os.type === 'offside') {
          return this.whistleOffside(os, p);
        }
      }
      // ★ 成功率按本次传球参数重算（距离/高度/脚法/压迫），取代菜单预估值
      var prate = Pass.passRate(p, pp, land, near.dist);
      success = this.rng() * 100 < prate;
      if (success) {
        var recv = target;
        if (!recv) {
          // 无人接应：落点附近最近的本方球员上前拿球
          var rb = null, rd = 1e9;
          this.players.forEach(function (q) {
            if (q.team !== p.team || q.sentOff) return;
            var d = Math.sqrt((q.x - corr.x) * (q.x - corr.x) + (q.y - corr.y) * (q.y - corr.y));
            if (d < rd) { rd = d; rb = q; }
          });
          recv = rb || p;
        }
        this.ball.ownerId = recv.id;
        this.ball.x = corr.x; this.ball.y = corr.y;
        text = p.name + '一脚' + techName + kindName + '，' + recv.name + '稳稳接应。';
        cut = 'pass-win';
      } else {
        this.ball.ownerId = near.player.id;
        this.ball.x = corr.x; this.ball.y = corr.y;
        text = p.name + ' 的' + techName + kindName + '被 ' + near.player.name + ' 拦截！';
        cut = 'pass-lose';
      }
      break;
    }
    case 'protect': {
      // ★ 护球：用身体卡住位置，不推进；成功则逼抢者被挡开 1.8 秒，为队友跑位争取时间
      var presser = near.player;
      if (success) {
        presser.beatenUntil = this.now + 1800;
        var awayA = Math.atan2(p.y - presser.y, p.x - presser.x);
        p.x = clamp(p.x + Math.cos(awayA) * 1.2, 2, FIELD.W - 2);
        p.y = clamp(p.y + Math.sin(awayA) * 1.2, 2, FIELD.H - 2);
        text = p.name + ' 用身体护住皮球，' + presser.name + ' 被卡在身后！';
      } else {
        this.ball.ownerId = presser.id;
        text = p.name + ' 护球失误，被 ' + presser.name + ' 从身后捅掉！';
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
      // ★ 掷骰只决定结果，过程走"射门飞行"阶段演出：
      //   球按瞄准点飞向球门、门将飞身扑救、防守球员回追，落地后再按既定结果结算。
      //   （解决"中圈射门直接判进球、全程没有任何动作"的问题）
      var outcome = success ? 'goal' : (this.rng() < 0.55 ? 'saved' : 'miss');
      this.startShotFlight(p, keeper, {
        isSpecial: isSpecial, label: label, outcome: outcome,
        snap: osShot.snap,
      });
      return { kind: commandId, label: label, playerName: p.name, success: success, pending: true, text: '' };
    }
    case 'feint': {
      var d2 = near.player;
      if (success) {
        d2.frozenUntil = this.now + 2500;
        p.x = clamp(p.x + 3 * dir, 2, FIELD.W - 2);
        text = p.name + ' 的假动作晃晕了 ' + d2.name + '！';
        cut = 'feint-win';
      } else {
        // ★ 假动作被看穿：防守方上抢，同样走抢断对决；上抢消耗体能
        var t2 = Foul.judgeTackle(this, d2, p, {
          fromBehind: false,
          speedHigh: false,
          attackPromising: false,
        });
        d2.stamina = Math.max(0, d2.stamina - C.STAMINA.TACKLE_COST);
        if (t2.outcome === 'clean') {
          this.ball.ownerId = d2.id;
          text = p.name + ' 的假动作被 ' + d2.name + ' 看穿并断下！';
          cut = 'dribble-lose';
        } else if (t2.outcome === 'beaten') {
          d2.beatenUntil = this.now + 1500;
          text = p.name + ' 的假动作没晃开 ' + d2.name + '，但顺势抹了过去！';
          cut = 'dribble-win';
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
    cut: cut,
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
    cut: 'offside',
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
    cut: 'foul',
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
    0.74 + (FM.shoot(shooter) * sEff - FM.keep(keeper) * kEff) * 0.01 +
    (FM.nerve(shooter) - FM.nerve(keeper)) * 0.004,
    0.4, 0.95
  );
  var roll = this.rng();
  var call = prefixText + ' ' + shooter.name + '主罚点球……';
  if (roll < pGoal) {
    this.goal(shooter, shooter.team);
    this.lastAction.kind = 'penalty';
    this.lastAction.label = '点球命中';
    this.lastAction.text = call + '球进了！' + shooter.name + '顶住压力罚入点球！';
    this.lastAction.cut = 'shoot-goal';
    return this.lastAction;
  }
  this.ball.ownerId = keeper.id;
  this.enterStoppage('whistle', 2000, keeper.id);
  var pSaved = roll < pGoal + 0.12;
  this.lastAction = {
    kind: 'penalty',
    label: '点球罚失',
    playerName: shooter.name,
    team: shooter.team,
    success: false,
    text: call + (pSaved ? '被门将' + keeper.name + '神勇扑出！' : '偏出了球门！'),
    cut: pSaved ? 'shoot-save' : 'shoot-miss',
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
    // 射程内：有必杀技且体能够则用必杀，否则射门
    var specialDef = C.COMMANDS.filter(function (c) { return c.id === 'special'; })[0];
    if (p.special && p.stamina >= specialDef.cost && this.rng() < 0.55) choice = 'special';
    else choice = 'shoot';
  } else if (p.pos === 'GK') {
    // 门将得球：大脚开给前场队友
    choice = 'pass';
  } else if (near.dist < 12) {
    choice = this.rng() < 0.6 ? 'pass' : 'dribble';
  } else {
    choice = 'dribble';
  }

  // AI 同样受体能限制
  var def = C.COMMANDS.filter(function (c) { return c.id === choice; })[0];
  if (!def || p.stamina < def.cost || (choice === 'special' && !p.special)) choice = 'pass';
  var def2 = C.COMMANDS.filter(function (c) { return c.id === choice; })[0];
  p.stamina = Math.max(0, p.stamina - def2.cost);

  var rate = this.buildOptions(p).filter(function (o) { return o.id === choice; })[0].rate;
  this.resolveAction(p, choice, rate);
  this.aiCooldownUntil = this.now + 2500 + this.rng() * 1500;
};

// ---------- 对外接口 ----------

Match.prototype.setPaused = function (paused) {
  this.paused = !!paused;
};

// ★ 直接操控：接收客户端输入（方向/加速/减速/切换），只接受意图，不接受位置。
Match.prototype.setInput = function (data) {
  var c = this.control;
  data = data || {};
  var dz = function (v) {
    v = +v || 0;
    if (v > 1) v = 1; if (v < -1) v = -1;
    return Math.abs(v) < 0.15 ? 0 : v; // 死区
  };
  c.dx = dz(data.dx); c.dy = dz(data.dy);
  c.sprint = !!data.sprint; c.slow = !!data.slow;
  c.stamp = this.now;
  if (c.dx !== 0 || c.dy !== 0 || c.sprint || c.slow) c.activeStamp = this.now;
  var cur = this.byId[c.playerId];
  var wantSwitch = !!data.switchPlayer;
  if (data.playerId && this.byId[data.playerId]) {
    // 点名操控：只接受主队非门将、未罚下球员
    var want = this.byId[data.playerId];
    if (want.team === 'home' && want.pos !== 'GK' && !want.sentOff && want.id !== c.playerId) {
      c.playerId = want.id;
      c.activeStamp = this.now;
      return { ok: true, controlledId: c.playerId };
    }
  }
  if (!cur || cur.team !== 'home' || cur.sentOff || wantSwitch) {
    c.playerId = this.selectControlled(cur && wantSwitch ? cur.id : null);
    if (wantSwitch) c.activeStamp = this.now;
  }
  return { ok: true, controlledId: c.playerId };
};

// 选择被操控球员：默认离球最近的主队非门将；switch 时按离球距离轮换下一名。
Match.prototype.selectControlled = function (fromId) {
  var cands = this.players.filter(function (p) {
    return p.team === 'home' && p.pos !== 'GK' && !p.sentOff;
  });
  if (!cands.length) return null;
  var bx = this.ball.x, by = this.ball.y;
  cands.sort(function (a, b) {
    var da = (a.x - bx) * (a.x - bx) + (a.y - by) * (a.y - by);
    var db = (b.x - bx) * (b.x - bx) + (b.y - by) * (b.y - by);
    return da - db;
  });
  if (!fromId) return cands[0].id;
  for (var i = 0; i < cands.length; i++) {
    if (cands[i].id === fromId) return cands[(i + 1) % cands.length].id;
  }
  return cands[0].id;
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
        special: p.special ? { name: p.special.name } : null,
        hasBall: self.ball.ownerId === p.id,
        frozen: self.now < p.frozenUntil,
        cards: p.cards,
        sentOff: !!p.sentOff,
      };
    }),
    referee: { name: this.referee.name, strictness: this.referee.strictness },
    controlledId: this.control.playerId, // 当前被玩家直接操控的球员
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
