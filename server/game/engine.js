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
var Intercept = require('./rules/intercept');

var FIELD = C.FIELD;

// ★ 全屏结算演出时长（墙钟 ms）：演出是客户端遮罩，引擎不停表，
//   被晃倒之类的计时状态必须盖住这段时间，否则演出播完状态就过期、用户看不到
var CUT_OVERLAY_MS = 2200;

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

  this.ball = { x: FIELD.W / 2, y: FIELD.H / 2, ownerId: null,
    z: 0,          // ★ 球高度（米）：传球/射门飞行时按抛物线起落，客户端按此画升空
    vx: 0, vy: 0, // ★ 自由球滚动速度（米/秒）：拦截弹开、无人接应的落点用
    lastTouchTeam: null, // ★ 最后触球的队伍：界外球/球门球/角球判罚用
    lastTouchId: null,   // ★ 最后触球的球员 id：滚入球门的记名用
    restartExempt: null  // ★ 界外球/球门球/角球豁免：直接发出的第一下不判越位（IFAB Law 11）
  };

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
  this.nextDefDecisionAt = 0; // 下次允许触发防守决策（上抢菜单）的时间
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
    p._vx = 0; p._vy = 0; // ★ 速度矢量清零（加速度模型用）
    p.frozenUntil = 0; p.beatenUntil = 0; p.retreatTarget = null;
    p.holdingUntil = 0; // 急停收步中（行为层）
  });
  this.ball.x = FIELD.W / 2; this.ball.y = FIELD.H / 2;
  // ★ 开球规则：非开球方球员必须在 9.15 米开外（之前客队前锋按阵型站在 5 米处，
  //   保护期一过决策菜单立刻弹出劫持键盘，用户还没带两步球）
  var bx = this.ball.x, by = this.ball.y;
  this.players.forEach(function (p) {
    if ((kickoffTeam === 'home' ? p.team !== 'home' : p.team !== 'away')) {
      var d = Math.sqrt(Math.pow(p.x - bx, 2) + Math.pow(p.y - by, 2));
      if (d < 9.15 && d > 0.001) {
        p.x = bx + (p.x - bx) / d * 9.15;
        p.y = by + (p.y - by) / d * 9.15;
      } else if (d <= 0.001) { p.x = bx + 9.15; }
    }
  });
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
    peak: 1.0, // ★ 射门弹道低平：线路上的后卫可堵枪眼（z<1.0m 地面可断）
    ballSpeed: ballSpd, // 米/秒
    kx: kx, ky: ky, kSpd: kSpd, chasers: chasers,
  };
  this.ball.ownerId = null;
  this.ball.x = x0; this.ball.y = y0; this.ball.z = 0;
  this.ball.vx = 0; this.ball.vy = 0;
  this.ball.lastTouchTeam = p.team; this.ball.lastTouchId = p.id; // ★ 射门出脚
  this.ball.restartExempt = null;
  this.lastInterceptK = null; // 测试用
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

// ★ 传球飞行（2026-09-28 改为实时拦截）：
//   开球瞬间不再掷骰定结果。球按高度抛物线飞向落点，飞行途中每 tick
//   做 swept-segment 实时拦截判定（rules/intercept）：
//     - 防守队员在线路上 + 球在其可及高度内 → 按能力掷骰 断/弹开/扑空；
//     - 超高球中段在高空无人能及，初段/末段才能断；
//   落地时按落点 1.6m 内最近球员归属（争抢看 anticipation+firstTouch），
//   无人则成自由球。完成/拦截都不播全屏演出 —— 断球是开放比赛的一部分，
//   场上看得见，不需要遮罩。
Match.prototype.startPassFlight = function (p, o) {
  var peak = (Pass.HEIGHTS[o.height] || Pass.HEIGHTS.mid).peak;
  var dx = o.x1 - p.x, dy = o.y1 - p.y;
  var dist = Math.sqrt(dx * dx + dy * dy) || 1;
  this.passFlight = {
    passerId: p.id, team: p.team,
    x0: p.x, y0: p.y, x1: o.x1, y1: o.y1,
    startAt: this.now, durMs: o.durMs,
    peak: peak, ballSpeed: dist / (o.durMs / 1000), // 米/秒，供拦截难度用
    receiverId: o.receiverId || null, // 意向接应者（跑落点用），不代表结果
    holderId: o.holderId || null,   // 收步者：不参与进攻，落点结算时排除
  };
  this.ball.ownerId = null;
  this.ball.x = p.x; this.ball.y = p.y; this.ball.z = 0;
  this.ball.vx = 0; this.ball.vy = 0;
  this.ball.lastTouchTeam = p.team; this.ball.lastTouchId = p.id; // ★ 传球出脚
  this.ball.restartExempt = null; // 传球是常规比赛行为，清除重启豁免
  this.lastInterceptK = null; // 测试用：本次飞行发生拦截时的进度
  this.lastAction = null; // 飞行期间不出演出遮罩，保证场上动作可见
  this.phase = 'passflight';
  this.phaseUntil = this.now + o.durMs;
};

// 传球飞行结束：按既定结果结算（接应队员得球 / 被拦截）
// ★ 落点结算（实时制）：落地瞬间看落点 1.6m 内最近的球员归属；
//   两人贴身争抢（0.4m 内）看 anticipation+firstTouch，意向接应者有身位优势；
//   无人 → 自由球。完成传球是常规动作，不播全屏演出。
Match.prototype.finishPassFlight = function () {
  var pf = this.passFlight;
  this.passFlight = null;
  if (!pf) {
    if (this.phase === 'passflight') this.phase = 'play';
    return;
  }
  this.ball.x = pf.x1; this.ball.y = pf.y1; this.ball.z = 0;
  var cands = [];
  for (var i = 0; i < this.players.length; i++) {
    var q = this.players[i];
    if (q.sentOff) continue;
    if (q.id === pf.holderId) continue; // ★ 收步者不参与进攻：不接球
    var d = Math.sqrt((q.x - pf.x1) * (q.x - pf.x1) + (q.y - pf.y1) * (q.y - pf.y1));
    if (d <= 1.6) cands.push({ p: q, d: d });
  }
  cands.sort(function (a, b) { return a.d - b.d; });
  var winner = null;
  if (cands.length === 1) {
    winner = cands[0].p;
  } else if (cands.length > 1) {
    var a0 = cands[0], a1 = cands[1];
    if (a0.p.team !== a1.p.team && (a1.d - a0.d) < 0.4) {
      // 贴身争抢：预判+停球，意向接应者占先
      var s0 = FM.v(a0.p, 'anticipation') + FM.v(a0.p, 'firstTouch') + (a0.p.id === pf.receiverId ? 3 : 0);
      var s1 = FM.v(a1.p, 'anticipation') + FM.v(a1.p, 'firstTouch') + (a1.p.id === pf.receiverId ? 3 : 0);
      winner = s0 >= s1 ? a0.p : a1.p;
    } else {
      winner = a0.p;
    }
  }
  if (winner) {
    this.ball.ownerId = winner.id;
  } else {
    this.ball.ownerId = null; // 无人接应 → 自由球
    this.ball.vx = 0; this.ball.vy = 0;
  }
  this.phase = 'play';
  this.nextDecisionAt = this.now + 2200;
  var c = this.carrier();
  this.lastDecisionPos = c ? { x: c.x, y: c.y } : { x: this.ball.x, y: this.ball.y };
};

// ★ 干净拦截：防守队员得球，比赛继续。不播全屏演出 ——
//   断球是开放比赛的一部分，场上动作本身就是演出；只留一条侧栏文字。
Match.prototype.interceptClean = function (def, kind) {
  this.passFlight = null;
  this.shotFlight = null;
  this.ball.ownerId = def.id;
  this.ball.z = 0; this.ball.vx = 0; this.ball.vy = 0;
  this.phase = 'play';
  this.nextDecisionAt = this.now + 2200;
  var verb = kind === 'shot' ? '挡下了这脚射门' : '断下了这脚传球';
  this.lastAction = {
    kind: 'intercept', label: '拦截', playerName: def.name, team: def.team,
    success: true, cut: null, text: def.name + ' ' + verb + '！',
    until: Date.now() + 1800,
  };
  var c = this.carrier();
  this.lastDecisionPos = c ? { x: c.x, y: c.y } : { x: this.ball.x, y: this.ball.y };
};

// ★ 弹开：球从防守队员身上弹出成自由球（带滚动速度），双方就近追球。
Match.prototype.interceptDeflect = function (hit, ballSpeed) {
  var def = hit.player;
  this.passFlight = null;
  this.shotFlight = null;
  var ang = Math.atan2(this.ball.y - def.y, this.ball.x - def.x) + (this.rng() - 0.5) * 1.2;
  var spd = Math.max(2, ballSpeed * 0.35);
  this.ball.ownerId = null;
  this.ball.vx = Math.cos(ang) * spd;
  this.ball.vy = Math.sin(ang) * spd;
  this.ball.z = 0;
  this.ball.lastTouchTeam = def.team; this.ball.lastTouchId = def.id; // ★ 挡球也算触球
  this.ball.restartExempt = null;
  def.beatenUntil = this.now + 600; // 挡了一下，顿一下
  this.phase = 'play';
  this.nextDecisionAt = this.now + 2200;
  this.lastAction = {
    kind: 'deflect', label: '挡出', playerName: def.name, team: def.team,
    success: true, cut: null, text: def.name + ' 把球挡了出去！',
    until: Date.now() + 1800,
  };
  this.lastDecisionPos = { x: this.ball.x, y: this.ball.y };
};

// ★ 飞行阶段全员跑位：意向接应者跑落点；防守方（除门将）追球；
//   门将按 Behavior 选位；进攻方其余人向落点方向移动接应。
Match.prototype.moveFlightPlayers = function (pf, dt) {
  var self = this;
  this.players.forEach(function (p) {
    if (p.sentOff) return;
    if (self.now < p.frozenUntil) { p._vx = 0; p._vy = 0; return; }
    if (p.id === pf.receiverId) {
      self.moveToward(p, pf.x1, pf.y1, self.playerSpeed(p, true), dt);
    } else if (p.team !== pf.team && p.pos !== 'GK') {
      self.moveToward(p, self.ball.x, self.ball.y, self.playerSpeed(p, true) * 0.9, dt);
    } else if (p.pos === 'GK') {
      var kt = Behavior.keeperTarget(self, p);
      self.moveToward(p, kt.x, kt.y, self.playerSpeed(p, false) * 0.7, dt);
    } else {
      self.moveToward(p, (p.x + pf.x1) / 2, (p.y + pf.y1) / 2, self.playerSpeed(p, false) * 0.6, dt);
    }
    self.updateEnergy(p, dt);
  });
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
        this.nextDefDecisionAt = this.now + 4500;
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
      // ★ 射门飞行：球低平飞向瞄准点，门将飞身扑救；
      //   线路上的防守队员可实时堵枪眼（同传球拦截规则，门将走自己的扑救演出不参与）。
      this.now += dt * 1000;
      this.clock += dt;
      var sf = this.shotFlight;
      if (sf) {
        var k0 = clamp((this.now - dt * 1000 - sf.startAt) / sf.durMs, 0, 1);
        var k = clamp((this.now - sf.startAt) / sf.durMs, 0, 1);
        var spx = this.ball.x, spy = this.ball.y;
        this.ball.x = sf.x0 + (sf.x1 - sf.x0) * k;
        this.ball.y = sf.y0 + (sf.y1 - sf.y0) * k;
        this.ball.z = Intercept.heightAt(sf.peak, k);
        // ★ 堵枪眼：门将跳过（keeperId 借 receiverId 位），其余防守队员实时判定
        var blk = Intercept.checkInterception(this, {
          px: spx, py: spy, x: this.ball.x, y: this.ball.y,
          k0: k0, k1: k, peak: sf.peak, team: sf.team,
          passerId: sf.shooterId, receiverId: sf.keeperId,
        });
        if (blk) {
          this.lastInterceptK = blk.k; // 测试用
          var bres = Intercept.resolveContest(this, blk, sf.ballSpeed, 'shot');
          if (bres === 'clean') { this.interceptClean(blk.player, 'shot'); break; }
          if (bres === 'deflect') { this.interceptDeflect(blk, sf.ballSpeed); break; }
          blk.player.beatenUntil = this.now + 700;
        }
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
    case 'passflight': {
      // ★ 传球飞行（实时拦截）：球按高度抛物线飞向落点；
      //   每 tick 用 swept-segment 检查防守队员是否在线路上且球在其可及高度内，
      //   触发则按能力掷骰：干净断下 / 弹开（自由球）/ 扑空（踉跄 0.7s）。
      //   全员参与跑位（不再只动 3 人、其余冻结）。
      this.now += dt * 1000;
      this.clock += dt;
      var pf = this.passFlight;
      if (pf) {
        var pk0 = clamp((this.now - dt * 1000 - pf.startAt) / pf.durMs, 0, 1);
        var pk = clamp((this.now - pf.startAt) / pf.durMs, 0, 1);
        var ppx = this.ball.x, ppy = this.ball.y; // 上 tick 球位：swept 起点
        this.ball.x = pf.x0 + (pf.x1 - pf.x0) * pk;
        this.ball.y = pf.y0 + (pf.y1 - pf.y0) * pk;
        this.ball.z = Intercept.heightAt(pf.peak, pk);
        var hit = Intercept.checkInterception(this, {
          px: ppx, py: ppy, x: this.ball.x, y: this.ball.y,
          k0: pk0, k1: pk, peak: pf.peak, team: pf.team,
          passerId: pf.passerId, receiverId: pf.receiverId,
        });
        if (hit) {
          this.lastInterceptK = hit.k; // 测试用：记录拦截发生时的飞行进度
          var res = Intercept.resolveContest(this, hit, pf.ballSpeed, 'pass');
          if (res === 'clean') { this.interceptClean(hit.player, 'pass'); break; }
          if (res === 'deflect') { this.interceptDeflect(hit, pf.ballSpeed); break; }
          hit.player.beatenUntil = this.now + 700; // 扑空：踉跄一下
        }
        this.moveFlightPlayers(pf, dt);
      }
      if (this.now >= this.phaseUntil) this.finishPassFlight();
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
  if (d < 0.05) { p._vx = 0; p._vy = 0; return true; }
  // ★ 加速度模型：acceleration 属性决定起速快慢（爆发好的一步蹬出去，糙的要多踩两步）
  //   速度矢量每 tick 向目标速度靠拢，而不是瞬时达到——急停变向自然掉速
  var acc = 34 * (0.55 + FM.v(p, 'acceleration') / 100); // m/s²，acceleration 5→20 对应约 20→53
  var tvx = (dx / d) * speed, tvy = (dy / d) * speed;
  var vx = p._vx || 0, vy = p._vy || 0;
  var dvx = tvx - vx, dvy = tvy - vy;
  var dv = Math.sqrt(dvx * dvx + dvy * dvy), maxDv = acc * dt;
  if (dv > maxDv) { vx += dvx / dv * maxDv; vy += dvy / dv * maxDv; }
  else { vx = tvx; vy = tvy; }
  p._vx = vx; p._vy = vy;
  p.x += vx * dt; p.y += vy * dt;
  p.x = clamp(p.x, 1, FIELD.W - 1);
  p.y = clamp(p.y, 1, FIELD.H - 1);
  return d < 0.5 && (vx * vx + vy * vy) < speed * speed * 0.09;
};

// ★ 直接操控：若该球员正被玩家操控且 2 秒内有有效操作，用输入方向移动，跳过 AI。
// 返回 true 表示本 tick 的移动已由输入接管（含冻结/松手的情况，避免 AI 顶替）。
Match.prototype.controlMove = function (p, dt) {
  var c = this.control;
  if (p.id !== c.playerId) return false;
  // ★ 手机手柄按住不动时 touchmove 不触发、无新输入——但 dx/dy 非零就是"正在操作"，
  //   不能算无操作而 AI 接管（否则按住方向 2 秒后 AI 抢走闷头往前带，用户再推也没用）。
  //   只有方向归零且 2 秒无新输入，才判无操作。
  if (this.now - c.activeStamp > 2000 && c.dx === 0 && c.dy === 0) return false; // 超时无操作：AI 接管
  if (this.now < p.frozenUntil) { p._vx = 0; p._vy = 0; return true; }
  if (this.now < p.beatenUntil) {
    // ★ 被晃倒：踉跄，只能挪 2 成速度——不能马上满速反抢（之前直接操控无视 beaten，立刻回追）
    if (c.dx === 0 && c.dy === 0) { p._vx *= 0.85; p._vy *= 0.85; }
    else this.moveToward(p, p.x + c.dx * 30, p.y + c.dy * 30, this.playerSpeed(p, false) * 0.2, dt);
    return true;
  }
  if (c.dx === 0 && c.dy === 0) { p._vx = 0; p._vy = 0; return true; } // 松手：原地停住，速度清零
  // 体能过低蹬不动：低于阈值时加速键失效，只能普通跑
  var wantSprint = c.sprint && p.stamina >= C.STAMINA.SPRINT_MIN;
  var sp = this.playerSpeed(p, wantSprint);
  if (this.ball.ownerId === p.id) sp *= this.dribbleFactor(p); // ★ 持球：盘带差的蹬不快
  if (c.slow) sp *= 0.45;
  this.moveToward(p, p.x + c.dx * 30, p.y + c.dy * 30, sp, dt);
  return true;
};

Match.prototype.playerSpeed = function (p, sprint) {
  // ★ 速度由数值决定：pace 主导，FM.speed 40→约 11.0 m/s，85→约 15.2 m/s，快慢肉眼可见
  //   （之前 13*(0.8+FM/250)，40 与 85 只差 18%，用户批评"速度不体现"）
  // ★ 2026-10-09 整体放慢（用户：速度太快了）：PACE_SCALE 0.72，
  //   40→约 7.9 m/s，85→约 10.9 m/s，相对差保持，数值可读性不变
  var base = (7.2 + FM.speed(p) * 0.094) * 0.72;
  if (sprint) base *= 1.10;
  base *= 0.7 + 0.3 * (p.stamina / p.maxStamina); // 体能影响速度：见底时只剩 7 成
  return base;
};

// ★ 带球减速：盘带属性决定带球掉速（盘带 20 几乎不掉速，盘带 5 掉到约 7 成）
//   只在持球者移动调用点使用，不污染无球速度/体能档位计算
Match.prototype.dribbleFactor = function (p) {
  return 0.62 + 0.38 * (FM.dribble(p) / 95);
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
  if (!carrier) {
    // ★ 自由球（拦截弹开 / 无人接应的落点）：球按速度滚动、摩擦减速；
    //   双方最近的 3 人追球，其余回位。
    var bv = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
    if (bv > 0.25) {
      this.ball.x += this.ball.vx * dt;
      this.ball.y += this.ball.vy * dt;
      var fr = Math.max(0, 1 - 3.2 * dt);
      this.ball.vx *= fr; this.ball.vy *= fr;
      if (this.ball.x < 1 || this.ball.x > FIELD.W - 1 ||
          this.ball.y < 1 || this.ball.y > FIELD.H - 1) {
        // ★ 球出界：按 IFAB 规则判界外球/球门球/角球/进球（不再撞隐形墙）
        this.whistleOutOfBounds();
        return;
      }
    } else {
      this.ball.vx = 0; this.ball.vy = 0;
    }
    var byTeam = { home: [], away: [] };
    this.players.forEach(function (p) {
      if (p.sentOff) return;
      var d = Math.sqrt((p.x - self.ball.x) * (p.x - self.ball.x) + (p.y - self.ball.y) * (p.y - self.ball.y));
      byTeam[p.team].push({ p: p, d: d });
    });
    ['home', 'away'].forEach(function (t) {
      byTeam[t].sort(function (a, b) { return a.d - b.d; });
      byTeam[t].forEach(function (e, idx) {
        var p = e.p;
        if (self.now < p.frozenUntil) { p._vx = 0; p._vy = 0; return; }
        if (idx < 3 && p.pos !== 'GK') {
          self.moveToward(p, self.ball.x, self.ball.y, self.playerSpeed(p, true) * 0.95, dt);
        } else if (p.pos === 'GK') {
          var kt = Behavior.keeperTarget(self, p);
          self.moveToward(p, kt.x, kt.y, self.playerSpeed(p, false) * 0.7, dt);
        } else {
          self.moveToward(p, p.hx, p.hy, self.playerSpeed(p, false) * 0.7, dt);
        }
        self.updateEnergy(p, dt);
      });
    });
    // ★ 拾取：进入 0.9m 控制半径的最近球员得球（之前引擎从没有自由球，无此机制）
    //   收步中（holdingUntil）的球员不参与进攻，不捡球；
    //   收步造出的死球对收步者"死亡"（deadTo，未过期则跳过）
    var deadTo = this.ball.deadTo;
    var bestP = null, bestD = 0.9;
    this.players.forEach(function (p) {
      if (p.sentOff || self.now < p.frozenUntil) return;
      if (self.now < p.holdingUntil) return;
      if (deadTo && self.now < deadTo.until && p.id === deadTo.id) return;
      var d = Math.sqrt((p.x - self.ball.x) * (p.x - self.ball.x) + (p.y - self.ball.y) * (p.y - self.ball.y));
      if (d < bestD) { bestD = d; bestP = p; }
    });
    if (bestP) {
      this.ball.ownerId = bestP.id;
      this.ball.vx = 0; this.ball.vy = 0; this.ball.z = 0;
    }
    return;
  }

  var dir = carrier.team === 'home' ? 1 : -1; // 进攻方向

  // --- 持球者移动 ---
  var frozen = this.now < carrier.frozenUntil;
  if (frozen) { carrier._vx = 0; carrier._vy = 0; }
  var cSpeed = this.playerSpeed(carrier, true);
  if (!frozen) {
    if (this.controlMove(carrier, dt)) {
      // ★ 被玩家直接操控：按输入方向移动，不自动推进
    } else if (carrier.retreatTarget) {
      var arrived = this.moveToward(carrier, carrier.retreatTarget.x, carrier.retreatTarget.y, cSpeed * 0.9, dt);
      if (arrived) carrier.retreatTarget = null;
    } else {
      // ★ 行为层·持球者：被紧逼时减速护球并向空侧微调，不再无脑直线冲门
      //   ★ 盘带差的带球本身就慢（dribbleFactor），不再是人人一个速度
      var adj = Behavior.carrierAdjust(self, carrier);
      self.moveToward(carrier, adj.tx, adj.ty, cSpeed * adj.spMul * self.dribbleFactor(carrier), dt);
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
    if (pFrozen) { p._vx = 0; p._vy = 0; } // ★ 冻结中速度清零，解冻不乱窜
    var beaten = self.now < p.beatenUntil;
    var tx, ty, sp;
    if (p.team !== carrier.team) {
      // 防守方：第 1 人上抢（看侵略性），第 2 人协防（看防守站位），其余慢跑落位
      // ★ 2026-10-09 用户：全员狂动不像足球——落位是慢跑，只有上抢才冲刺
      var rank = sortedOpp.indexOf(p);
      var aggr = FM.aggr(p) / 100, defAb = FM.defend(p) / 100; // 0-1（FM 能力值×5 后为 5-100）
      if (rank === 0 && !beaten && !pFrozen) {
        // ★ 上抢强度吃侵略性：莽夫全力扑，冷静的保持距离封线路（不再无脑全速）
        var pressK = 0.65 + aggr * 0.35;
        tx = carrier.x; ty = carrier.y;
        sp = self.playerSpeed(p, true) * 0.94 * pressK;
        chaseCount++;
      } else if (rank === 1 && !beaten && !pFrozen) {
        // ★ 协防：防守能力高的站位更深更稳，慢跑到位（之前 0.8 冲刺，一过人就撞上）
        var gx2 = carrier.team === 'home' ? FIELD.W : 0;
        var depth = 0.55 + (1 - defAb) * 0.15; // 能力差的站位靠前（容易失位）
        tx = carrier.x + (gx2 - carrier.x) * depth;
        ty = (carrier.y + FIELD.H / 2) / 2;
        sp = self.playerSpeed(p, false) * 0.5;
      } else {
        // ★ 行为层：DF 按防线纪律落位/造越位，MF 盯人，都没有则回阵型点
        //   慢跑（0.4/0.55），不是冲刺——阵地战就该是这个节奏
        var lt = (p.pos === 'DF' && lineTargets[p.id]) ? lineTargets[p.id] : null;
        var mk = manMarks[p.id];
        if (lt) { tx = lt.x; ty = lt.y; }
        else if (mk) { tx = mk.x; ty = mk.y; }
        else { tx = p.hx; ty = p.hy; }
        sp = self.playerSpeed(p, false) * (mk ? 0.55 : 0.4);
        if (beaten) sp *= 0.08; // ★ 被晃倒：原地踉跄定住（2026-10-09 用户：过完人被过掉的要在原地一段时间，不然过人没意义；之前 0.45 还在跑，看着像马上反抢）
      }
    } else if (p.pos === 'GK') {
      // ★ 行为层·门将：随球横向小范围移动（慢速横移）
      var kt = Behavior.keeperTarget(self, p);
      tx = kt.x; ty = kt.y;
      sp = self.playerSpeed(p, false) * 0.4;
    } else if (self.now < p.holdingUntil) {
      // ★ 行为层：急停收步中——原地不动，不参与这次进攻
      tx = p.x; ty = p.y;
      sp = 0;
    } else {
      // ★ 行为层·无球任务：接应/前插/拉边/拖后（带任务粘性，不再全员同步前压）
      //   无球跑位是慢跑穿插，只有明确前插才加速——阵地战节奏
      var at = atkTasks[p.id];
      if (at) { tx = at.x; ty = at.y; }
      else { tx = p.hx; ty = p.hy; }
      sp = self.playerSpeed(p, false) * (at && at.type === 'run' ? 0.75 : 0.45);
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
  // ★ 逼近半径 6 米：防守队员真贴上来才暂停弹菜单（之前 15 米，开球 4 秒就弹，键盘全被菜单劫持）
  if (carrier.team === 'home' && this.now >= this.nextDecisionAt) {
    var near = this.nearestOpponent(carrier);
    var traveled = dist(carrier, this.lastDecisionPos);
    if (near.dist < 6 || carrier.x > 76 || traveled > 24) {
      this.enterDecision(carrier);
      return;
    }
  }

  // --- 防守决策（用户球队）：玩家正直接操控的防守球员贴近对方持球者 → 暂停并弹出上抢/卡位菜单
  //   与进攻决策对称：触发权在玩家手里（贴上去才会弹，不想抢就别贴），AI 接管/门将/被晃倒时不触发
  if (carrier.team === 'away' && this.now >= this.nextDefDecisionAt) {
    var c = this.control;
    var dp = this.byId[c.playerId];
    if (dp && dp.team === 'home' && dp.pos !== 'GK' && !dp.sentOff &&
        this.now >= dp.beatenUntil && this.now >= dp.frozenUntil &&
        this.now - c.activeStamp <= 2000 && dist(dp, carrier) < 4) {
      this.enterDefDecision(dp, carrier);
      return;
    }
  }

  // --- AI 决策（客队持球） ---
  if (carrier.team === 'away' && this.now >= this.aiCooldownUntil) {
    this.aiDecide(carrier);
  }
};

// ---------- 决策点 ----------

// ★ 手动呼出决策菜单（PC 按 E）：仅主队持球、操控的正是持球者、play 阶段时生效
//   之前只有被动触发（6 米逼近/进 76 米/跑 24 米），行进间想主动传球射门没有键，是漏掉的
//   ★ 2026-10-09 用户：手动触发不要冷却（"没意义"），按了就弹
Match.prototype.tryManualDecision = function () {
  if (this.phase !== 'play') return;
  var carrier = this.carrier();
  if (!carrier || carrier.team !== 'home' || carrier.id !== this.control.playerId) return;
  this.enterDecision(carrier);
};

Match.prototype.enterDecision = function (carrier) {
  this.phase = 'decision';
  this.decision = {
    playerId: carrier.id,
    options: this.buildOptions(carrier),
  };
  this.lastDecisionPos = { x: carrier.x, y: carrier.y };
};

// ★ 防守决策：玩家操控的防守球员贴近对方持球者时触发（对称于进攻决策）。
//   选项：上抢（抢断对决，干净断下/被过掉/犯规）/ 卡位（不贸然出脚，继续比赛）。
Match.prototype.enterDefDecision = function (defender, carrier) {
  this.phase = 'decision';
  // 从身后下脚更容易犯规：防守方在持球者身后（远离对方进攻方向一侧）则 fromBehind
  var behind = defender.x > carrier.x + 1; // 客队向左攻，身后 = 更靠右
  var prev = Foul.tacklePreview(this, defender, carrier, { fromBehind: behind, speedHigh: true });
  function dopt(id, rate) {
    var def = C.COMMANDS.filter(function (c) { return c.id === id; })[0];
    return {
      id: id, name: def.name, cost: def.cost, desc: def.desc,
      rate: Math.round(clamp(rate, 1, 99)),
      enabled: defender.stamina >= def.cost,
    };
  }
  this.decision = {
    playerId: defender.id,
    def: true, // 防守决策标记：结算后走防守冷却，不影响进攻决策计时
    options: [
      dopt('tackle', prev.pClean * 100),
      dopt('jockey', 100),
    ],
  };
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
      // ★ 传球多阶段菜单：该球员可用的脚法（按 technique 解锁）+ 推荐落点（AI 选的最佳接应点，光标初始位置）
      //   成功率 = 线路危险度估计（走廊内可拦截的防守队员越多越低），确定性，不掷骰
      var tgt = self.bestPassTarget(p);
      var pp0 = { aimX: tgt.x, aimY: tgt.y, technique: 'inside', height: 'mid' };
      var land0 = Pass.computeLanding(p, pp0, FM.pass(p) * ef);
      o.rate = Math.round(clamp(Pass.laneRate(self, p, pp0, land0), 1, 99));
      o.passOpts = {
        techniques: Pass.availableTechniques(p),
        suggest: { x: Math.round(tgt.x * 10) / 10, y: Math.round(tgt.y * 10) / 10 },
      };
      return o;
    })(opt('pass', 80)),
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
  var wasDef = !!(this.decision && this.decision.def);

  // 结算后恢复比赛；若刚进了球（phase 已被 goal() 置为 'goal'），则保持进球庆祝流程
  this.decision = null;
  if (wasDef) this.nextDefDecisionAt = this.now + 4000; // 防守决策冷却，避免菜单连弹
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
        // ★ 全屏演出期间引擎不停表：踉跄时长盖住演出，否则演完用户就看不到了
        def.beatenUntil = this.now + 2000 + CUT_OVERLAY_MS;
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
          def.beatenUntil = this.now + 2000 + CUT_OVERLAY_MS; // ★ 盖住全屏演出
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
      // ★ 掷骰只定结果（接到 / 被断），过程走"传球飞行"阶段演出：
      //   球按高度飞行时间飞向落点、接应者跑向落点、拦截者与防守球员追球，落地再结算。
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
      var kindName = land.dist > 26 ? '长传' : '短传'; // 距离即力量：远为长传、近为短传
      var passLabel = labelOf(commandId, p);
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
        // ★ 界外球/球门球/角球直接发出不判越位（IFAB Law 11）
        var osHeld = this.isRestartExempt(p) ? { type: 'playon' } : Offside.judgePass(this, p, target, true);
        if (osHeld.type === 'offside') {
          return this.whistleOffside(osHeld, p);
        }
        // ★ 目标收步：不偷偷改传其他人。球仍沿原线路飞出，无人接应 →
        //   实时制下由防守方就近追球、落点结算归属（大概率被防守方得到）。
        //   收步者不参与进攻：落点结算时排除他（"收步球员不接球"铁律），
        //   且之后 8 秒内这个自由球对他"死亡"（自过期，无需生命周期管理）。
        this.ball.deadTo = { id: target.id, until: this.now + 8000 };
        this.startPassFlight(p, {
          x1: corr.x, y1: corr.y, durMs: land.flightMs,
          height: pp.height, receiverId: null, holderId: target.id,
        });
        this.lastAction = {
          kind: 'pass', label: passLabel, playerName: p.name, team: p.team,
          success: false, cut: null,
          text: '⚠ ' + target.name + '识破越位陷阱，急停收步！' + p.name + '的传球滚向无人地带。',
          until: Date.now() + 1800,
        };
        return { kind: commandId, label: passLabel, playerName: p.name, success: false, pending: true, text: '' };
      }
      // ★ 裁判层：纯客观判定，不看任何数值（目标前插参与 → 越位照吹）
      // ★ 界外球/球门球/角球直接发出不判越位（IFAB Law 11）
      if (target) {
        var os = this.isRestartExempt(p) ? { type: 'playon' } : Offside.judgePass(this, p, target);
        if (os.type === 'offside') {
          return this.whistleOffside(os, p);
        }
      }
      // ★ 实时制：开球瞬间不再掷骰定结果。意向接应者 = 传球目标（只决定谁跑落点），
      //   实际归属看飞行途中的实时拦截（线路+高度+球速+防守能力）与落地争抢。
      var recvId = target ? target.id : null;
      this.startPassFlight(p, {
        x1: corr.x, y1: corr.y, durMs: land.flightMs,
        height: pp.height, receiverId: recvId,
      });
      return { kind: commandId, label: passLabel, playerName: p.name, success: true, pending: true, text: '' };
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
          d2.beatenUntil = this.now + 1500 + CUT_OVERLAY_MS; // ★ 盖住全屏演出
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
    case 'tackle': {
      // ★ 防守决策·上抢：与持球者的抢断对决（干净断下 / 被过掉 / 犯规），直接走 judgeTackle 的三段掷骰
      var carrier = this.byId[this.ball.ownerId];
      if (!carrier || carrier.team !== 'away' || carrier.id === p.id) {
        text = p.name + ' 收住动作，继续卡位。';
        success = true;
        break;
      }
      var behind = p.x > carrier.x + 1;
      var t = Foul.judgeTackle(this, p, carrier, { fromBehind: behind, speedHigh: true });
      if (t.outcome === 'clean') {
        this.ball.ownerId = p.id;
        text = p.name + ' 干净地从 ' + carrier.name + ' 脚下断下皮球！';
        cut = 'dribble-lose'; // 复用拼抢对决演出图（防守方获胜视角）
        success = true;
      } else if (t.outcome === 'beaten') {
        p.beatenUntil = this.now + 2000 + CUT_OVERLAY_MS; // ★ 盖住全屏演出
        text = p.name + ' 上抢落空，被 ' + carrier.name + ' 闪了过去！';
        cut = 'dribble-win'; // 复用拼抢对决演出图（进攻方获胜视角）
        success = false;
      } else {
        return this.applyFoulResult(t.foul);
      }
      break;
    }
    case 'jockey': {
      // ★ 防守决策·卡位：不贸然出脚，继续比赛
      text = p.name + ' 稳住重心，继续卡位防守。';
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
    until: Date.now() + CUT_OVERLAY_MS,
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
  // ★ 视野：好视野的传球手会"看到"前插队友的无球跑动并提前量给球；
  //   视野差的只看眼前空位，跑出好时机的前锋也接不到球
  var vis = FM.v(p, 'vision') / 100;
  var best = null, bestScore = -1e9;
  this.players.forEach(function (q) {
    if (q.team !== p.team || q.id === p.id || q.pos === 'GK' || q.sentOff) return;
    var forward = (q.x - p.x) * dir;
    var open = self.nearestOpponent(q).dist;
    var runBonus = (q._task === 'run' ? FM.v(q, 'offBall') / 100 : 0) * vis * 8;
    var score = forward * 1.5 + open * 2.0 + runBonus;
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
  // ★ 间接任意球：越位方球员必须退到 9.15 米外（真实规则，同开球）。
  //   否则越位的前锋就站在发球者 2 米外（哨响全员冻结），哨一停直接反抢回来射门，越位白吹了
  //   （2026-10-09 用户报"离谱"：越位→对方发球→下一秒自己拿球射门）。
  var sx = this.ball.x, sy = this.ball.y;
  this.players.forEach(function (q) {
    if (q.team !== passer.team || q.sentOff) return;
    var dd = Math.sqrt(Math.pow(q.x - sx, 2) + Math.pow(q.y - sy, 2));
    if (dd < 9.15 && dd > 0.001) {
      q.x = sx + (q.x - sx) / dd * 9.15;
      q.y = sy + (q.y - sy) / dd * 9.15;
    } else if (dd <= 0.001) { q.x = sx + 9.15; }
  });
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

// ---------- 出界判罚（IFAB Law 15/16/17，标准规则） ----------
// 自由球整体越过边界时调用（simulate 自由球物理中），不再撞隐形墙。
// 边线 → 界外球；球门线（非进球）→ 进攻方碰出=球门球，防守方碰出=角球；入门=进球。
Match.prototype.whistleOutOfBounds = function () {
  var bx = this.ball.x, by = this.ball.y;
  var lastTeam = this.ball.lastTouchTeam || (bx < FIELD.W / 2 ? 'away' : 'home');
  var gy = FIELD.H / 2, goalHalf = 3.66;
  var outL = bx < 1, outR = bx > FIELD.W - 1;

  if (outL || outR) {
    // 右端 (x=W)：主队进攻方向、客队球门；左端 (x=0)：客队进攻方向、主队球门
    var attackTeam = outR ? 'home' : 'away';
    var defendTeam = outR ? 'away' : 'home';
    if (Math.abs(by - gy) <= goalHalf) {
      // ★ 滚入球门 → 进球（自由球，非射门飞行；乌龙也算进攻方得分）
      var scorer = this.byId[this.ball.lastTouchId];
      if (!scorer || scorer.team !== attackTeam || scorer.sentOff) {
        var best = null, bd = 1e9;
        this.players.forEach(function (q) {
          if (q.team !== attackTeam || q.sentOff) return;
          var d = Math.abs(q.x - bx) + Math.abs(q.y - by);
          if (d < bd) { bd = d; best = q; }
        });
        scorer = best;
      }
      if (scorer) { this.goal(scorer, attackTeam); return; }
      this.phase = 'play'; return;
    }
    if (lastTeam === attackTeam) return this.whistleGoalKick(defendTeam); // 进攻方碰出 → 球门球
    return this.whistleCorner(attackTeam); // 防守方碰出 → 角球
  }
  // 边线 → 界外球（最后触球方的对手掷）
  var throwTeam = lastTeam === 'home' ? 'away' : 'home';
  return this.whistleThrowIn(throwTeam, bx, by);
};

// ★ 界外球（Law 15）：出界点掷，最近的非门将球员执行；掷出的一下不越位（Law 11）
Match.prototype.whistleThrowIn = function (team, bx, by) {
  var sx = clamp(bx, 2, FIELD.W - 2);
  var sy = by < 1 ? 2 : FIELD.H - 2;
  var taker = null, bd = 1e9;
  this.players.forEach(function (q) {
    if (q.team !== team || q.sentOff || q.pos === 'GK') return;
    var d = Math.sqrt((q.x - sx) * (q.x - sx) + (q.y - sy) * (q.y - sy));
    if (d < bd) { bd = d; taker = q; }
  });
  if (!taker) { this.phase = 'play'; return; }
  taker.x = sx; taker.y = sy;
  this.ball.ownerId = taker.id;
  this.ball.x = sx; this.ball.y = sy; this.ball.vx = 0; this.ball.vy = 0; this.ball.z = 0;
  this.ball.restartExempt = { takerId: taker.id, x: sx, y: sy }; // ★ 界外球直接发出不越位
  this.ball.lastTouchTeam = team; this.ball.lastTouchId = taker.id;
  this.enterStoppage('whistle', 1400, taker.id);
  var teamName = team === 'home' ? T.HOME_NAME : T.AWAY_NAME;
  this.lastAction = {
    kind: 'throwin', label: '界外球', playerName: taker.name, team: team, success: true,
    text: '球出边线，' + teamName + '获得界外球（' + taker.name + '掷）。',
    cut: null, until: Date.now() + 1400,
  };
};

// ★ 球门球（Law 16）：门将小禁区开球；对方须退出大禁区；直接发出不越位（Law 11）
Match.prototype.whistleGoalKick = function (team) {
  var keeper = null;
  this.players.forEach(function (q) {
    if (q.team === team && q.pos === 'GK' && !q.sentOff) keeper = q;
  });
  if (!keeper) { this.phase = 'play'; return; }
  var gx = team === 'home' ? 5.5 : FIELD.W - 5.5;
  keeper.x = gx; keeper.y = FIELD.H / 2;
  this.ball.ownerId = keeper.id;
  this.ball.x = gx; this.ball.y = FIELD.H / 2;
  this.ball.vx = 0; this.ball.vy = 0; this.ball.z = 0;
  this.ball.restartExempt = { takerId: keeper.id, x: gx, y: FIELD.H / 2 }; // ★ 球门球直接发出不越位
  this.ball.lastTouchTeam = team; this.ball.lastTouchId = keeper.id;
  // 对方退出大禁区（真实规则：球发出前对方不得在大禁区内）
  var dir = team === 'home' ? 1 : -1;
  var boxX = team === 'home' ? 16.5 : FIELD.W - 16.5;
  this.players.forEach(function (q) {
    if (q.team === team || q.sentOff) return;
    var inBox = dir > 0 ? q.x < boxX : q.x > boxX;
    if (inBox) q.x = boxX + dir * 1.5;
  });
  this.enterStoppage('whistle', 1600, keeper.id);
  var teamName = team === 'home' ? T.HOME_NAME : T.AWAY_NAME;
  this.lastAction = {
    kind: 'goalkick', label: '球门球', playerName: keeper.name, team: team, success: true,
    text: teamName + '获得球门球（' + keeper.name + '开）。',
    cut: null, until: Date.now() + 1600,
  };
};

// ★ 角球（Law 17）：就近角球弧，最近的非门将球员主罚；对方退 9.15 米；直接发出不越位（Law 11）
Match.prototype.whistleCorner = function (team) {
  var bx = this.ball.x, by = this.ball.y;
  var cx = bx > FIELD.W / 2 ? FIELD.W - 2 : 2;
  var cy = by < FIELD.H / 2 ? 2 : FIELD.H - 2;
  var taker = null, bd = 1e9;
  this.players.forEach(function (q) {
    if (q.team !== team || q.sentOff || q.pos === 'GK') return;
    var d = Math.sqrt((q.x - cx) * (q.x - cx) + (q.y - cy) * (q.y - cy));
    if (d < bd) { bd = d; taker = q; }
  });
  if (!taker) { this.phase = 'play'; return; }
  taker.x = cx; taker.y = cy;
  this.ball.ownerId = taker.id;
  this.ball.x = cx; this.ball.y = cy;
  this.ball.vx = 0; this.ball.vy = 0; this.ball.z = 0;
  this.ball.restartExempt = { takerId: taker.id, x: cx, y: cy }; // ★ 角球直接发出不越位
  this.ball.lastTouchTeam = team; this.ball.lastTouchId = taker.id;
  // 对方退 9.15 米（真实规则）
  this.players.forEach(function (q) {
    if (q.team === team || q.sentOff) return;
    var dd = Math.sqrt((q.x - cx) * (q.x - cx) + (q.y - cy) * (q.y - cy));
    if (dd < 9.15 && dd > 0.001) {
      q.x = cx + (q.x - cx) / dd * 9.15;
      q.y = cy + (q.y - cy) / dd * 9.15;
    } else if (dd <= 0.001) { q.x = cx + 9.15; }
  });
  this.enterStoppage('whistle', 1800, taker.id);
  var teamName = team === 'home' ? T.HOME_NAME : T.AWAY_NAME;
  this.lastAction = {
    kind: 'corner', label: '角球', playerName: taker.name, team: team, success: true,
    text: teamName + '获得角球（' + taker.name + '主罚）。',
    cut: null, until: Date.now() + 1800,
  };
};

// ★ 重启豁免判定（IFAB Law 11）：界外球/球门球/角球，掷/罚球者在原地直接发出的第一下不判越位。
//   带球走远（>3米）后再传按常规越位处理。
Match.prototype.isRestartExempt = function (p) {
  var re = this.ball.restartExempt;
  if (!re || !p || p.id !== re.takerId) return false;
  var d = Math.sqrt((p.x - re.x) * (p.x - re.x) + (p.y - re.y) * (p.y - re.y));
  return d < 3;
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
  // ★ 直接任意球：犯规方球员必须退到 9.15 米外（同越位，同开球），否则犯规者站在球点上哨一停就反抢
  var fbx = this.ball.x, fby = this.ball.y;
  this.players.forEach(function (q) {
    if (q.team !== foul.defender.team || q.sentOff) return;
    var fdd = Math.sqrt(Math.pow(q.x - fbx, 2) + Math.pow(q.y - fby, 2));
    if (fdd < 9.15 && fdd > 0.001) {
      q.x = fbx + (q.x - fbx) / fdd * 9.15;
      q.y = fby + (q.y - fby) / fdd * 9.15;
    } else if (fdd <= 0.001) { q.x = fbx + 9.15; }
  });
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
    // ★ 决断驱动：decisions 高的被压迫先找传球点（有空位就传），低的容易上头莽带；
    //   不再是固定 6/4 开的掷骰，球商肉眼可见
    var dec = FM.v(p, 'decisions') / 100;
    var tgt = this.bestPassTarget(p);
    var tgtOpen = (tgt && tgt.id !== p.id) ? this.nearestOpponent(tgt).dist : 0;
    var passBias = 0.30 + dec * 0.45 + (tgtOpen > 6 ? 0.15 : 0);
    choice = this.rng() < passBias ? 'pass' : 'dribble';
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
  if (data.menu) this.tryManualDecision(); // ★ E 键手动呼出决策菜单（行进间主动传球/射门）
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
        beaten: self.now < p.beatenUntil, // ★ 被晃倒：客户端画踉跄倾斜
        cards: p.cards,
        sentOff: !!p.sentOff,
      };
    }),
    referee: { name: this.referee.name, strictness: this.referee.strictness },
    controlledId: this.control.playerId, // 当前被玩家直接操控的球员
    controlActive: (this.now - this.control.activeStamp) <= 2000, // 2 秒内有有效操作→玩家实控，否则 AI 接管
    ball: { x: +this.ball.x.toFixed(2), y: +this.ball.y.toFixed(2),
      z: +(this.ball.z || 0).toFixed(2), ownerId: this.ball.ownerId },
    decision: this.decision ? {
      playerId: this.decision.playerId,
      playerName: this.byId[this.decision.playerId].name,
      options: this.decision.options,
    } : null,
    lastAction: this.lastAction && this.lastAction.until > nowMs ? this.lastAction : null,
  };
};

module.exports = { Match: Match };
