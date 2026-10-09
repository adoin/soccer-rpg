// client/js/main.js
// 客户端：只负责渲染与采集输入，不做任何权威运算。
// 能发送给服务器的只有：matchId + 指令 id（+ 暂停/战术等界面操作）。
// 成功率、掷骰、AI、位置模拟全部在服务器完成，客户端照单播放。
(function () {
'use strict';

var C = window.SharedConstants;
var T = window.SharedTeams;
var S = window.Sprites;

var cv = document.getElementById('game');
var ctx = cv.getContext('2d');
var W = 1280, H = 720;
ctx.imageSmoothingEnabled = false;

// ---------------- 工具 ----------------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function $(id) { return document.getElementById(id); }

// ---------------- 序列帧精灵（sprite-gen 管线产出，真像素风，非代码拼图） ----------------
// 4 套 × 5 帧：run_0..run_3（跑动循环）+ idle（站立），48×72/帧，整表 48×360 纵排
var SPR_V = 'spr1'; // 精灵资源版本，换图时 bump 防手机缓存
var spriteAtlas = {};
['home', 'away', 'gk_home', 'gk_away'].forEach(function (kit) {
  var im = new Image();
  im.src = 'assets/sprites/' + kit + '/sprite-sheet-alpha.png?v=' + SPR_V;
  spriteAtlas[kit] = im;
});
var animClock = {}; // playerId -> {x,y,lt,ph} 上一帧渲染位置/帧时间戳/累进相位（跑/站判定用）
// ★ 跑动周期：序列帧行选择 + 带球触球共用同一相位，保证"球—脚"同步
// ★ dt 归一化（2026-10-06）：位移按米/秒算帧率与跑/站判定，30/60/120/144Hz 同一速度同一节奏；
//   fps=6+min(10,v/2) 在 60Hz 下与旧公式 6+min(10,moved*30) 数学恒等（node 实测 1000 随机速度全等），手感不变；
//   相位改累进式（每帧推进 fps*dt），加减速不再跳帧。返回的 dx/dy 仍为本帧位移（带球触球只取方向）。
function runCycleFor(p, t) {
  var rp = renderPos[p.id] || p;
  var st = animClock[p.id] || (animClock[p.id] = { x: rp.x, y: rp.y, lt: t, ph: 0 });
  var dx = rp.x - st.x, dy = rp.y - st.y;
  var dt = (t - st.lt) / 1000;
  if (!(dt > 0)) dt = 0.001;   // 首帧/时间戳异常兜底
  else if (dt > 0.1) dt = 0.1; // 切后台回来钳到 100ms，避免相位乱跳
  var v = (Math.abs(dx) + Math.abs(dy)) / dt; // 米/秒，刷新率无关
  st.x = rp.x; st.y = rp.y; st.lt = t;
  var moving = v > 1.2;          // 原 0.02 米/帧在 60Hz 下 = 1.2 米/秒，现固定
  var fps = 6 + Math.min(10, v / 2);
  st.ph = (st.ph + fps * dt) % 4;
  return { moving: moving, fps: fps, phase: st.ph / 4, dx: dx, dy: dy };
}
function spriteFrameFor(p, t) {
  var kit = (p.pos === 'GK' ? 'gk_' : '') + p.team;
  var img = spriteAtlas[kit];
  if (!img || !img.complete || !img.naturalWidth) return null; // 未加载完→兜底代码帧
  var cyc = runCycleFor(p, t);
  p._cycle = cyc; // 暂存本帧周期，供带球触球读取（state 每轮询重建，帧内有效即可）
  var row;
  if (cyc.moving) {
    // 跑动循环：位移越大帧率越高（慢跑 6fps → 冲刺 16fps）
    row = Math.floor(cyc.phase * 4) % 4;
  } else {
    row = 4; // idle 站立帧
  }
  return { img: img, row: row };
}

// ---------------- 结算演出图（像素风拼贴特写） ----------------
// 引擎 lastAction.cut 给出键名，这里预加载对应图片；drawCutin 播全屏演出。
var CUT_KEYS = ['dribble-win', 'dribble-lose', 'pass-win', 'pass-lose',
  'shoot-goal', 'shoot-save', 'shoot-miss', 'special-goal', 'special-save',
  'feint-win', 'foul', 'offside'];
var CUT_IMGS = {};
CUT_KEYS.forEach(function (k) {
  var im = new Image();
  im.src = 'assets/cutscene/' + k + '.webp';
  CUT_IMGS[k] = im;
});

// ---------------- 服务器 API ----------------
var api = {
  post: function (url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  },
  get: function (url) { return fetch(url).then(function (r) { return r.json(); }); },
  del: function (url) { return fetch(url, { method: 'DELETE' }).then(function (r) { return r.json(); }); },
};

// ---------------- 全局状态 ----------------
var screen = 'title';       // title | game
var matchId = null;
var state = null;           // 服务器状态快照
var renderPos = {};         // id -> {x,y} 插值渲染位置（快照线性插值，60fps 匀速）
var ballR = { x: 52.5, y: 34 };
var ballTrail = []; // 离脚飞行的球轨迹残影（脚下球不清算、不绘制）
var snapPrev = null, snapCurr = null; // 快照插值：{t, px:{id:{x,y}}, ball:{x,y}}，基于墙钟线性插值
// 每次拿到新状态快照时调用：旧快照→新快照，渲染在两者之间按时间匀速过渡
function takeSnapshot() {
  if (!state) return;
  var now = performance.now();
  var px = {};
  state.players.forEach(function (p) { px[p.id] = { x: p.x, y: p.y }; });
  snapPrev = snapCurr;
  snapCurr = { t: now, px: px, ball: { x: state.ball.x, y: state.ball.y } };
  if (!snapPrev) snapPrev = snapCurr;
}
var selectedHomeIdx = 9;    // 阵容条选中的主队球员下标（默认 10 号）
var ui = {
  pauseOpen: false,
  overlay: null,            // null | 'status' | 'settings'
  tacticOpen: false,
  toast: '', toastUntil: 0,
  halfLength: 180,          // 建房选项
  mentality: 'balanced',
  choosing: false,          // 已发送指令、等待服务器确认
  exitArm: 0,               // 退出二次确认
};
var clickables = [];        // 本帧可点击区域（绘制时重建）
var frameNo = 0;
// ★ 调试开关：?debug=1 时在左上角显示按键/菜单/异常诊断（平时完全隐藏）
var DEBUG = /[?&]debug=1/.test(location.search);
var dbgKey = '', dbgErr = '';
if (DEBUG) window.addEventListener('error', function (e) { dbgErr = 'ERR: ' + (e.message || e.type); });

// ---------------- 直接操控输入 ----------------
// 桌面端：WASD 方向 / J或Shift 加速 / K 减速 / L或Tab 切换球员 / E 呼出指令菜单 / 空格 暂停
// 移动端/Pad：透明虚拟手柄覆盖（左方向盘 + 右按键）
var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
var pad = { dx: 0, dy: 0, sprint: false, slow: false };
var DPAD = { x: 140, y: 445, r: 95 };
var BTNS = [
  { id: 'sprint', x: 1060, y: 400, r: 44, label: '加速' },
  { id: 'slow',   x: 1170, y: 400, r: 44, label: '减速' },
  { id: 'switch', x: 1060, y: 505, r: 44, label: '切换' },
  { id: 'menu',   x: 1170, y: 505, r: 44, label: '菜单' },
];
var padTouchId = null;      // 方向盘上的触点 id
var btnTouchIds = {};       // 触点 id -> 按键 id
function sendInput(extra) {
  if (screen !== 'game' || !matchId) return;
  var body = { dx: +pad.dx.toFixed(3), dy: +pad.dy.toFixed(3), sprint: pad.sprint, slow: pad.slow };
  if (extra) for (var k in extra) body[k] = extra[k];
  api.post('/api/match/' + matchId + '/input', body).catch(function () {});
}
function setPad(dx, dy, sprint, slow) {
  if (dx !== pad.dx || dy !== pad.dy || sprint !== pad.sprint || slow !== pad.slow) {
    pad.dx = dx; pad.dy = dy; pad.sprint = sprint; pad.slow = slow;
    sendInput();
    pokeRefresh();
  }
}

// ---------------- 精灵 ----------------
var frameCache = {};
function framesFor(p) {
  var hairColors = ['#23232e', '#3a2a1a', '#101016', '#5a3a1a', '#6b6b7a'];
  var key = p.team + '_' + p.pos + '_' + (p.idx % hairColors.length);
  if (!frameCache[key]) {
    var shirt = p.pos === 'GK'
      ? (p.team === 'home' ? '#e8b923' : '#7a7f8a')
      : (p.team === 'home' ? '#2b5fe3' : '#d23b3b');
    var shorts = p.team === 'home' ? '#ffffff' : '#2b2b33';
    frameCache[key] = S.playerFrames({
      shirt: shirt, shorts: shorts, hair: hairColors[p.idx % hairColors.length],
    });
  }
  return frameCache[key];
}
var ballImg = S.ballSprite();

// 预渲染观众看台
var crowdCv = (function () {
  var c = S.makeCanvas(W, 92), g = c.getContext('2d');
  var cols = ['#c44', '#48c', '#ec8', '#8c8', '#c8c', '#ccc', '#a66', '#68c'];
  for (var y = 4; y < 88; y += 6) {
    for (var x = 0; x < W; x += 5) {
      if (Math.random() < 0.82) {
        g.fillStyle = cols[(Math.random() * cols.length) | 0];
        g.fillRect(x + ((Math.random() * 2) | 0), y, 3, 4);
      }
    }
  }
  return c;
})();

// ---------------- 2.5D 投影 ----------------
var HORIZON = 150, GROUND = 548;
// ★ 镜头：有限视野跟随球（场地显得大），全场只在小地图里看
//   传球选落点（aim 层）时临时拉远，方便点选远处落点
function curViewW() {
  var lvl = (typeof hmTop === 'function') ? hmTop() : null;
  if (ui.hmenu && lvl && lvl.kind === 'aim') return 70;
  return 38;
}
function project(x, y) {
  var viewW = curViewW();
  var cx = clamp(ballR.x - viewW * 0.45, -6, C.FIELD.W - viewW + 6);
  var depth = clamp(y / C.FIELD.H, 0, 1); // 0 近 1 远
  var persp = 0.5 + 0.5 * (1 - depth);
  var sx = W / 2 + ((x - cx - viewW / 2) / viewW) * W * persp;
  var sy = HORIZON + (1 - depth) * (GROUND - HORIZON);
  var s = 0.55 + 0.85 * (1 - depth);
  return { x: sx, y: sy, s: s, depth: depth };
}

// ---------------- 输入 ----------------
cv.addEventListener('click', function (e) {
  var rect = cv.getBoundingClientRect();
  var mx = (e.clientX - rect.left) * (W / rect.width);
  var my = (e.clientY - rect.top) * (H / rect.height);
  for (var i = clickables.length - 1; i >= 0; i--) {
    var c = clickables[i];
    if (mx >= c.x && mx <= c.x + c.w && my >= c.y && my <= c.y + c.h) {
      c.action(mx, my);
      return;
    }
  }
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && screen === 'game') {
    if (headMenuOpen()) { headMenuBack(); return; } // 头顶菜单内：Esc = 返回上一步
    if (!ui.overlay) togglePause();
  }
  if (screen !== 'game') return;
  if (DEBUG) { var _lt = hmTop(); dbgKey = 'key=' + e.key + ' menu=' + (headMenuOpen() ? 'open' : 'shut') + ' top=' + (_lt ? (_lt.kind + '#' + _lt.sel) : 'none'); }
  if (headMenuOpen() && headMenuKey(e)) return; // 头顶菜单打开时接管键盘（方向键/回车/空格选，Esc 返回）
  var k = (e.key || '').toLowerCase();
  if ([' ', 'tab', 'w', 'a', 's', 'd', 'j', 'k', 'l'].indexOf(k) >= 0) e.preventDefault();
  if (e.repeat) return;
  if (k === ' ') { togglePause(); return; }
  if (k === 'l' || k === 'tab') {
    sendInput({ switchPlayer: true });
    toast('切换操控球员');
    return;
  }
  if (k === 'e') { sendInput({ menu: true }); return; } // ★ 行进间手动呼出决策菜单（传球/射门等）
  // ★ debug 摆拍：?debug=1 时按 1/2/3/4 触发确定性拦截场景（低球贴脸/高球越过/超高球中段/弹开追抢），
  //   适配器内同步跑完关键 tick 并冻结，截图核对用。平时无此功能。
  if (DEBUG && !headMenuOpen() && (k === '1' || k === '2' || k === '3' || k === '4')) {
    api.post('/api/debug/scene', { matchId: matchId, scene: k }).then(function (r) {
      toast(r && r.ok ? '场景' + k + '就绪 ' + JSON.stringify(r.info) : '场景失败');
    }).catch(function () { toast('场景失败'); });
    return;
  }
  keys[k] = true;
  updatePadFromKeys();
});
document.addEventListener('keyup', function (e) {  var k = (e.key || '').toLowerCase();
  if (keys[k]) { keys[k] = false; updatePadFromKeys(); }
});
window.addEventListener('blur', function () {
  // 失焦松开所有键，避免球员一直跑
  for (var k in keys) keys[k] = false;
  setPad(0, 0, false, false);
});
var keys = {};
function updatePadFromKeys() {
  // 场地坐标：+x 朝对方球门（右），+y 朝屏幕上方
  var dx = (keys['d'] ? 1 : 0) - (keys['a'] ? 1 : 0);
  var dy = (keys['w'] ? 1 : 0) - (keys['s'] ? 1 : 0);
  setPad(dx, dy, !!(keys['j'] || keys['shift']), !!keys['k']); // ★ Shift 也加速（和 J 一样）
}

// ---- 触屏虚拟手柄 ----


function touchPos(t) {
  var rect = cv.getBoundingClientRect();
  return { x: (t.clientX - rect.left) * (W / rect.width), y: (t.clientY - rect.top) * (H / rect.height) };
}
function hitBtn(p) {
  for (var i = 0; i < BTNS.length; i++) {
    var b = BTNS[i];
    if (Math.hypot(p.x - b.x, p.y - b.y) <= b.r + 10) return b;
  }
  return null;
}
function moveDpad(p) {
  var dx = (p.x - DPAD.x) / DPAD.r, dy = (p.y - DPAD.y) / DPAD.r;
  var len = Math.hypot(dx, dy);
  if (len < 0.25) { setPad(0, 0, pad.sprint, pad.slow); return; } // 死区
  if (len > 1) { dx /= len; dy /= len; }
  // canvas 纵轴向下，场地 +y 朝上，故取反
  setPad(+dx.toFixed(3), +(-dy).toFixed(3), pad.sprint, pad.slow);
}
function pressBtn(id) {
  if (id === 'sprint') setPad(pad.dx, pad.dy, true, pad.slow);
  else if (id === 'slow') setPad(pad.dx, pad.dy, pad.sprint, true);
  else if (id === 'switch') { sendInput({ switchPlayer: true }); toast('切换操控球员'); }
  else if (id === 'menu') togglePause();
}
function releaseBtn(id) {
  if (id === 'sprint') setPad(pad.dx, pad.dy, false, pad.slow);
  else if (id === 'slow') setPad(pad.dx, pad.dy, pad.sprint, false);
}
// ★ 头顶菜单打开时：方向盘切成菜单导航（上/下/左/右），右侧按键变成 确定/返回（复用桌面端键盘逻辑）
function menuKeySynth(k) { headMenuKey({ key: k, preventDefault: function () {} }); }
var menuDpadDir = null;
function menuDpadStep(p) {
  var dx = p.x - DPAD.x, dy = p.y - DPAD.y;
  if (Math.hypot(dx, dy) < DPAD.r * 0.22) { menuDpadDir = null; return; } // 死区
  var lvl0 = hmTop();
  // ★ 落点层：方向盘推动光标（按住连推，touchmove 持续触发）
  if (lvl0 && lvl0.kind === 'aim' && ui.hmenu) {
    var ax = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1.4 : -1.4) : 0;
    var ay = Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? -1.4 : 1.4) : 0; // 屏幕下为正 → 场地 -y
    if (ax || ay) nudgeAim(ax, ay);
    return;
  }
  var dir = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft')
    : (dy > 0 ? 'ArrowDown' : 'ArrowUp');
  if (dir !== menuDpadDir) { menuDpadDir = dir; menuKeySynth(dir); } // 进入新方向扇区才走一步
}
function menuBtn(id) {
  if (id === 'sprint') menuKeySynth('Enter');                          // 确定
  else if (id === 'slow') { if (headMenuOpen()) headMenuBack(); }      // 返回
  else if (id === 'menu') togglePause();
  else toast('请先完成头顶菜单选择');
}
function menuBtnLabel(id, def) {
  if (!headMenuOpen()) return def;
  if (id === 'sprint') return '确定';
  if (id === 'slow') return '返回';
  return def;
}
cv.addEventListener('touchstart', function (e) {
  if (!isTouch || screen !== 'game') return;
  if (ui.pauseOpen || ui.overlay) return; // 暂停/覆盖层打开时手柄让路，保证可点
  var menuMode = headMenuOpen(); // 头顶菜单打开：方向盘=菜单导航，按键=确定/返回；其他触点放行以便直接点选菜单项
  var used = false;
  for (var i = 0; i < e.changedTouches.length; i++) {
    var t = e.changedTouches[i], p = touchPos(t), tid = t.identifier;
    var b = hitBtn(p);
    if (b) {
      if (menuMode) menuBtn(b.id);
      else { btnTouchIds[tid] = b.id; pressBtn(b.id); }
      used = true;
    }
    else if (padTouchId === null && Math.hypot(p.x - DPAD.x, p.y - DPAD.y) <= DPAD.r + 30) {
      padTouchId = tid;
      if (menuMode) { menuDpadDir = null; menuDpadStep(p); }
      else moveDpad(p);
      used = true;
    }
    // ★ 落点层：点场上任意位置直接放置落点光标（按钮/方向盘优先）
    else if (menuMode && hmTop() && hmTop().kind === 'aim' && p.y < 556) {
      setAimFromScreen(p.x, p.y);
      used = true;
    }
  }
  if (used) e.preventDefault();
}, { passive: false });
cv.addEventListener('touchmove', function (e) {
  for (var i = 0; i < e.changedTouches.length; i++) {
    var t = e.changedTouches[i];
    if (t.identifier === padTouchId) {
      if (headMenuOpen()) menuDpadStep(touchPos(t)); else moveDpad(touchPos(t));
      e.preventDefault();
    }
  }
}, { passive: false });
function touchEnd(e) {
  for (var i = 0; i < e.changedTouches.length; i++) {
    var tid = e.changedTouches[i].identifier;
    if (tid === padTouchId) { padTouchId = null; menuDpadDir = null; setPad(0, 0, pad.sprint, pad.slow); }
    if (btnTouchIds[tid]) { releaseBtn(btnTouchIds[tid]); delete btnTouchIds[tid]; }
  }
}
cv.addEventListener('touchend', touchEnd);
cv.addEventListener('touchcancel', touchEnd);
function addClick(x, y, w, h, action) {
  clickables.push({ x: x, y: y, w: w, h: h, action: action });
}
function toast(msg, ms) {
  ui.toast = msg;
  ui.toastUntil = Date.now() + (ms || 2200);
}

// ---------------- 比赛控制 ----------------
function startMatch() {
  api.post('/api/match', { halfLength: ui.halfLength, mentality: ui.mentality }).then(function (r) {
    if (!r.ok) { toast('创建比赛失败'); return; }
    matchId = r.matchId;
    screen = 'game';
    state = null;
    renderPos = {};
    ballR = { x: 52.5, y: 34 };
    ballTrail = []; snapPrev = null; snapCurr = null; animClock = {};
    selectedHomeIdx = 9;
    pad.dx = 0; pad.dy = 0; pad.sprint = false; pad.slow = false;
    padTouchId = null; btnTouchIds = {};
    for (var k in keys) keys[k] = false;
    ui.pauseOpen = false; ui.overlay = null; ui.choosing = false; ui.exitArm = 0;
    refresh();
    // ★ 状态轮询从 300ms 提到 120ms（与服务器 tick 对齐）：直接操控时按键→画面的延迟明显缩短
    if (ui.refreshTimer) clearInterval(ui.refreshTimer);
    ui.refreshTimer = setInterval(refresh, 120);
  });
}
// ★ 输入变化后 60ms 内补拉一次状态：让转向/启停立刻反映到画面上，而不是等下一个轮询周期
var _pokeT = null;
function pokeRefresh() {
  if (_pokeT || screen !== 'game' || !matchId) return;
  _pokeT = setTimeout(function () { _pokeT = null; refresh(); }, 60);
}
function refresh() {
  if (screen !== 'game' || !matchId) return;
  api.get('/api/match/' + matchId + '/state').then(function (r) {
    if (!r.ok) return;
    state = r.state;
    takeSnapshot(); // ★ 快照插值：记录带时间戳的位置快照，渲染按墙钟匀速过渡
    var hasDec = !!(state && state.decision);
    if (hasDec && !ui._hadDecision) ui.choosing = false; // 新决策到达：清掉旧标记
    if (!hasDec) ui.choosing = false;
    // 决策变化（新球员/决策结束）时关闭头顶菜单
    var decKey = hasDec ? state.decision.playerId : null;
    if (decKey !== ui._hmDecisionKey) { ui.hmenu = null; ui._hmDecisionKey = decKey; }
    ui._hadDecision = hasDec;
    // 首次同步渲染位置
    state.players.forEach(function (p) {
      if (!renderPos[p.id]) renderPos[p.id] = { x: p.x, y: p.y };
    });
    // ★ 球权转换提示：己方持球 → 对方持球（比赛中），toast 提示，避免"我的人被断了却没任何事件"的困惑
    //   说明：被动决策菜单只在"我方持球被压迫"时触发；对方断球后不弹菜单，直接继续比赛
    var homeBall = false, awayBall = false;
    state.players.forEach(function (p) {
      if (p.hasBall) { if (p.team === 'home') homeBall = true; else awayBall = true; }
    });
    if (ui._prevHomeBall && !homeBall && awayBall && state.phase === 'play') {
      toast('⚠️ 对方断球！');
    }
    if (ui._prevAwayBall && !awayBall && homeBall && state.phase === 'play') {
      toast('⚽ 夺回球权！');
    }
    ui._prevHomeBall = homeBall; ui._prevAwayBall = awayBall;
    // 输入心跳：保持操控输入新鲜（服务器 2 秒无有效操作则 AI 接管）
    sendInput();
  }).catch(function () {});
}
function sendCommand(opt, params) {
  if (ui.choosing || !state || !state.decision) return;
  if (!opt.enabled) { toast('体能不足，无法使用该指令'); return; }
  ui.choosing = true;
  ui.hmenu = null; // 指令已发出，关闭头顶菜单（等结算期间头顶显示"判定中"）
  var body = { commandId: opt.id };
  if (params) body.params = params;
  api.post('/api/match/' + matchId + '/command', body).then(function (r) {
    if (!r.ok) { toast(r.error || '指令发送失败'); ui.choosing = false; }
    pokeRefresh(); // 指令秒出结果（本地引擎），立刻拉状态播演出
  }).catch(function () { ui.choosing = false; });
}
// ---------------- 浮动头顶菜单（无背景、多级嵌套） ----------------
// 决策触发时，选项直接浮现在该球员头顶：零面板、零遮挡，场上内容全可见。
// ui.hmenu = { playerId, passOpt, pass:{aimX,aimY,technique,height}, preview, previewAt, stack:[level] }
// level: { kind:'cmds'|'tech'|'height'|'confirm', title, items:[{label,sub,enabled,back,fn}], sel }
//        { kind:'aim', title }（落点自由光标：方向键/WASD 微调、点击/触摸场上放置）
var PASS_HEIGHTS = [
  { id: 'low', name: '低球', desc: '贴地快 · 易被断' },
  { id: 'mid', name: '中球', desc: '标准弧线' },
  { id: 'high', name: '高球', desc: '越过防守' },
  { id: 'vhigh', name: '超高球', desc: '很飘 · 难控制' },
];
// 落点范围（米）：与服务端 pass.js 的 AIM_MIN/AIM_MAX 一致
var AIM_MIN = 4, AIM_MAX = 60;

function headMenuOpen() { return !!(ui.hmenu && ui.hmenu.stack && ui.hmenu.stack.length && state && state.decision); }
function hmTop() { var h = ui.hmenu; return h ? h.stack[h.stack.length - 1] : null; }
function playerById(id) {
  for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i];
  return null;
}
function firstEnabled(items, from) {
  for (var i = 0; i < items.length; i++) { var j = (from + i) % items.length; if (items[j].enabled) return j; }
  return from;
}
function backItem() { return { label: '← 返回', sub: '', enabled: true, back: true, fn: popHmLevel }; }
function pushHmLevel(lvl) { if (lvl.items && lvl.sel == null) lvl.sel = firstEnabled(lvl.items, 0); ui.hmenu.stack.push(lvl); }
function popHmLevel() { if (ui.hmenu && ui.hmenu.stack.length > 1) ui.hmenu.stack.pop(); }
function headMenuBack() { popHmLevel(); } // 头顶菜单内 Esc = 返回上一步（第一级无返回，必须选）

function openHeadMenu(d) {
  var items = d.options.map(function (o) {
    return {
      label: (CMD_ICONS[o.id] || '•') + ' ' + o.name,
      sub: o.rate + '% · ' + o.cost + '体能',
      enabled: o.enabled,
      fn: function () {
        if (o.id === 'pass') { ui.hmenu.passOpt = o; initAim(ui.hmenu); pushHmLevel({ kind: 'aim', title: '落点', sel: 0 }); requestHmPreview(); }
        else sendCommand(o);
      }
    };
  });
  ui.hmenu = {
    playerId: d.playerId, passOpt: null,
    pass: { aimX: 0, aimY: 0, technique: 'inside', height: 'mid' },
    preview: null, previewAt: 0,
    stack: [{ kind: 'cmds', title: null, items: items, sel: firstEnabled(items, 0) }]
  };
}
// ★ 落点自由光标（天使之翼式）：方向+力量由"传球者→落点"向量同时决定。
//   输入是精确意图，能力只决定散布（与服务端 pass.js 一致）。
function initAim(hm) {
  var p = playerById(hm.playerId);
  if (!p) return;
  var s = hm.passOpt && hm.passOpt.passOpts && hm.passOpt.passOpts.suggest;
  hm.pass.aimX = s ? s.x : p.x + 15;
  hm.pass.aimY = s ? s.y : p.y;
  clampAim(hm);
}
function clampAim(hm) {
  var p = playerById(hm.playerId);
  if (!p) return;
  var dx = hm.pass.aimX - p.x, dy = hm.pass.aimY - p.y;
  var dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > AIM_MAX) { hm.pass.aimX = p.x + dx / dist * AIM_MAX; hm.pass.aimY = p.y + dy / dist * AIM_MAX; }
  else if (dist < AIM_MIN) {
    if (dist < 0.001) hm.pass.aimX = p.x + AIM_MIN;
    else { hm.pass.aimX = p.x + dx / dist * AIM_MIN; hm.pass.aimY = p.y + dy / dist * AIM_MIN; }
  }
  hm.pass.aimX = clamp(hm.pass.aimX, 2, C.FIELD.W - 2);
  hm.pass.aimY = clamp(hm.pass.aimY, 2, C.FIELD.H - 2);
}
function nudgeAim(dx, dy) {
  var hm = ui.hmenu;
  if (!hm) return;
  hm.pass.aimX += dx; hm.pass.aimY += dy;
  clampAim(hm);
  requestHmPreview();
}
// 屏幕坐标 → 场地坐标（project 的逆运算）
function unproject(sx, sy) {
  var depth = 1 - (sy - HORIZON) / (GROUND - HORIZON);
  depth = clamp(depth, 0, 1);
  var y = depth * C.FIELD.H;
  var persp = 0.5 + 0.5 * (1 - depth);
  var viewW = curViewW();
  var cx = clamp(ballR.x - viewW * 0.45, -6, C.FIELD.W - viewW + 6);
  var x = cx + viewW / 2 + (sx - W / 2) / (W * persp) * viewW;
  return { x: x, y: y };
}
function setAimFromScreen(sx, sy) {
  var hm = ui.hmenu;
  if (!hm) return;
  var f = unproject(sx, sy);
  hm.pass.aimX = f.x; hm.pass.aimY = f.y;
  clampAim(hm);
  requestHmPreview();
}
function techLevel() {
  var techs = (ui.hmenu.passOpt.passOpts && ui.hmenu.passOpt.passOpts.techniques) || [];
  var items = [backItem()];
  techs.forEach(function (t) {
    items.push({
      label: (t.enabled ? '' : '🔒 ') + t.name, sub: t.enabled ? t.desc : t.reason, enabled: t.enabled,
      fn: (function (id) { return function () { ui.hmenu.pass.technique = id; pushHmLevel(heightLevel()); requestHmPreview(); }; })(t.id)
    });
  });
  return { kind: 'tech', title: '脚法', items: items, sel: 1 };
}
function heightLevel() {
  var items = [backItem()];
  PASS_HEIGHTS.forEach(function (h) {
    items.push({
      label: h.name, sub: h.desc, enabled: true,
      fn: (function (id) { return function () { ui.hmenu.pass.height = id; pushHmLevel({ kind: 'confirm', title: '确认', sel: 0 }); requestHmPreview(); }; })(h.id)
    });
  });
  return { kind: 'height', title: '高度', items: items, sel: 1 };
}
function hmConfirmPass() {
  var hm = ui.hmenu;
  sendCommand(hm.passOpt, { aimX: Math.round(hm.pass.aimX * 10) / 10, aimY: Math.round(hm.pass.aimY * 10) / 10, technique: hm.pass.technique, height: hm.pass.height });
}
function requestHmPreview() {
  var hm = ui.hmenu;
  if (!hm || !matchId) return;
  var now = Date.now();
  if (now - hm.previewAt < 250) return; // 节流
  hm.previewAt = now;
  var body = { params: { aimX: Math.round(hm.pass.aimX * 10) / 10, aimY: Math.round(hm.pass.aimY * 10) / 10, technique: hm.pass.technique, height: hm.pass.height } };
  api.post('/api/match/' + matchId + '/pass-preview', body).then(function (r) {
    if (r.ok && ui.hmenu === hm) {
      hm.preview = r.preview;
      var p = (r.preview && r.preview.params) || {};
      if (p.technique) hm.pass.technique = p.technique; // 服务器按能力钳制脚法，同步回来
    }
  });
}

// 无背景描边文字：场上可读，不挡视线
function hmText(str, x, y, size, color, bold) {
  ctx.font = (bold === false ? '' : 'bold ') + size + 'px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(3, size / 4);
  ctx.strokeStyle = 'rgba(0,0,0,0.82)';
  ctx.strokeText(str, x, y);
  ctx.fillStyle = color || '#fff';
  ctx.fillText(str, x, y);
  return ctx.measureText(str).width;
}

function drawHeadMenu() {
  var d = state.decision;
  if (!d) { ui.hmenu = null; return; }
  if (!ui.hmenu || ui.hmenu.playerId !== d.playerId) openHeadMenu(d);
  var hm = ui.hmenu;
  if (ui.choosing) {
    // 指令已发出、等服务器结算：头顶只显示"判定中"
    var pc = playerById(hm.playerId);
    if (pc) {
      var rpc = renderPos[pc.id] || pc;
      var prc = project(rpc.x, rpc.y);
      hmText('判定中…', prc.x, prc.y - 24 * prc.s * 1.9 - 14, 20, '#ffd94a');
    }
    return;
  }
  var p = playerById(hm.playerId); if (!p) return;
  var rp = renderPos[p.id] || p;
  var pr = project(rp.x, rp.y);
  var s = pr.s;
  var headY = pr.y - 24 * s * 1.9 - 14;
  var cx = clamp(pr.x, 150, W - 150);
  var lvl = hmTop();
  if (lvl.kind === 'aim') drawHmAim(hm, lvl, pr, cx, headY);
  else if (lvl.kind === 'confirm') drawHmConfirm(hm, lvl, pr, cx, headY);
  else drawHmList(lvl, pr, cx, headY);
  drawHmLanding(hm);
}

function drawHmList(lvl, pr, cx, headY) {
  var items = lvl.items, lineH = 40, titleH = lvl.title ? 30 : 0;
  var totalH = items.length * lineH + titleH;
  var yTop = headY - totalH;
  if (yTop < 64) yTop = pr.y + 30; // 头顶空间不足 → 改放脚下
  if (lvl.title) hmText('— ' + lvl.title + ' —', cx, yTop + 15, 15, '#9fb4dd', false);
  items.forEach(function (it, i) {
    var y = yTop + titleH + i * lineH + lineH / 2;
    var sel = (i === lvl.sel);
    var color = !it.enabled ? '#5a6584' : it.back ? '#9fb4dd' : sel ? '#ffd94a' : '#ffffff';
    var w = hmText((sel ? '▶ ' : '') + it.label, cx, y - (it.sub ? 8 : 0), it.back ? 17 : 22, color);
    if (it.sub) hmText(it.sub, cx, y + 13, 13, it.enabled ? '#b9c8e8' : '#4a5468', false);
    (function (item, idx) {
      addClick(cx - w / 2 - 24, y - lineH / 2, w + 48, lineH, function () {
        if (!item.enabled) { toast('体能不足或该球员无法使用'); return; }
        lvl.sel = idx; item.fn();
      });
    })(it, i);
  });
}

// ★ 落点自由光标：场上十字光标 + 传球者→落点连线 + 距离/力量读数
//   点击/触摸场上任意点直接放置光标（兜底点击先注册，菜单按钮后注册优先）
function drawHmAim(hm, lvl, pr, cx, headY) {
  var p = playerById(hm.playerId);
  if (!p) return;
  // 兜底：点场上任意位置放置落点（先注册=低优先级，按钮优先；只覆盖场上区域 y<556，底部 UI 不受影响）
  addClick(0, 0, W, 556, function (mx, my) { setAimFromScreen(mx, my); });
  var rp = renderPos[p.id] || p;
  var pp = project(rp.x, rp.y);
  var ap = project(hm.pass.aimX, hm.pass.aimY);
  // 传球者→落点连线
  ctx.strokeStyle = 'rgba(255,217,74,0.6)'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
  ctx.beginPath(); ctx.moveTo(pp.x, pp.y - 8); ctx.lineTo(ap.x, ap.y); ctx.stroke();
  ctx.setLineDash([]);
  // 十字光标
  var cr = 15;
  ctx.strokeStyle = '#ffd94a'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(ap.x, ap.y, cr, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ap.x - cr - 9, ap.y); ctx.lineTo(ap.x - cr + 5, ap.y);
  ctx.moveTo(ap.x + cr - 5, ap.y); ctx.lineTo(ap.x + cr + 9, ap.y);
  ctx.moveTo(ap.x, ap.y - cr - 9); ctx.lineTo(ap.x, ap.y - cr + 5);
  ctx.moveTo(ap.x, ap.y + cr - 5); ctx.lineTo(ap.x, ap.y + cr + 9);
  ctx.stroke();
  // 距离·力量读数（力量由距离导出）
  var dx = hm.pass.aimX - p.x, dy = hm.pass.aimY - p.y;
  var dist = Math.sqrt(dx * dx + dy * dy);
  var pow = Math.round((dist - AIM_MIN) / (AIM_MAX - AIM_MIN) * 100);
  hmText('\u2014 落点 \u2014', cx, headY - 128, 15, '#9fb4dd', false);
  hmText(dist.toFixed(0) + '米 \u00b7 力量' + pow + '%', cx, headY - 100, 20, '#ffd94a');
  hmText('方向键/WASD 微调 \u00b7 Shift更精细 \u00b7 点击场上放置', cx, headY - 72, 13, '#9fb4dd', false);
  var items = [
    { label: '\u2705 继续', fn: function () { pushHmLevel(techLevel()); requestHmPreview(); } },
    { label: '\u2190 返回', back: true, fn: popHmLevel }
  ];
  items.forEach(function (it, i) {
    var y = headY - 32 + i * 38;
    var sel = (lvl.sel || 0) === i;
    hmText((sel ? '\u25b6 ' : '') + it.label, cx, y, 21, sel ? '#ffd94a' : (it.back ? '#9fb4dd' : '#fff'));
    (function (item, idx) {
      addClick(cx - 100, y - 19, 200, 38, function () { lvl.sel = idx; item.fn(); });
    })(it, i);
  });
}

// ★ 确认：预估落点 + 散布 + 踢出/返回
function drawHmConfirm(hm, lvl, pr, cx, headY) {
  var pv = hm.preview;
  var techName = '', heightName = '';
  var techs = (hm.passOpt.passOpts && hm.passOpt.passOpts.techniques) || [];
  techs.forEach(function (t) { if (t.id === hm.pass.technique) techName = t.name; });
  PASS_HEIGHTS.forEach(function (h) { if (h.id === hm.pass.height) heightName = h.name; });
  hmText('\u2014 确认 \u2014', cx, headY - 118, 15, '#9fb4dd', false);
  hmText(techName + ' \u00b7 ' + heightName, cx, headY - 90, 17, '#ffffff', false);
  hmText(pv ? ('预估落点 \u00b1' + pv.r.toFixed(1) + ' 米') : '正在计算落点\u2026', cx, headY - 62, 15, '#ffd94a', false);
  var items = [
    { label: '\u2705 踢出', fn: hmConfirmPass },
    { label: '\u2190 返回', back: true, fn: popHmLevel }
  ];
  items.forEach(function (it, i) {
    var y = headY - 22 + i * 38;
    var sel = (lvl.sel || 0) === i;
    hmText((sel ? '\u25b6 ' : '') + it.label, cx, y, 21, sel ? '#ffd94a' : (it.back ? '#9fb4dd' : '#fff'));
    (function (item, idx) {
      addClick(cx - 100, y - 19, 200, 38, function () { lvl.sel = idx; item.fn(); });
    })(it, i);
  });
}

function drawHmLanding(hm) {
  var pv = hm.preview;
  if (!pv) return;
  var lp = project(pv.x, pv.y);
  var prad = Math.max(10, pv.r * 19 * lp.s);
  ctx.save();
  ctx.fillStyle = 'rgba(255,217,74,0.16)';
  ctx.beginPath(); ctx.arc(lp.x, lp.y, prad, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffd94a'; ctx.lineWidth = 3; ctx.setLineDash([10, 6]);
  ctx.beginPath(); ctx.arc(lp.x, lp.y, prad, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  var cpv = playerById(hm.playerId);
  if (cpv) {
    var cr = renderPos[cpv.id] || cpv;
    var spp = project(cr.x, cr.y);
    ctx.strokeStyle = 'rgba(255,217,74,0.55)'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(spp.x, spp.y - 10); ctx.lineTo(lp.x, lp.y); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  hmText('预估落点', lp.x, lp.y - prad - 12, 15, '#ffd94a');
}

// 头顶菜单键盘操作（决策暂停期间接管键盘）
function headMenuKey(e) {
  var hm = ui.hmenu, lvl = hmTop();
  if (!hm || !lvl) return false;
  var k = (e.key || '').toLowerCase();
  function moveList(d) {
    var n = lvl.items.length, i = lvl.sel == null ? 0 : lvl.sel;
    for (var c = 0; c < n; c++) { i = (i + d + n) % n; if (lvl.items[i].enabled) break; }
    lvl.sel = i;
  }
  function activateList() {
    var it = lvl.items[lvl.sel];
    if (it && it.enabled) it.fn();
    else if (it) toast('体能不足或该球员无法使用');
  }
  var handled = true;
  if (lvl.kind === 'aim') {
    // ★ 落点光标：方向键/WASD 精细移动（Shift 更精细），回车确认
    var step = e.shiftKey ? 0.4 : 1.5;
    if (k === 'arrowup' || k === 'w') nudgeAim(0, step);
    else if (k === 'arrowdown' || k === 's') nudgeAim(0, -step);
    else if (k === 'arrowleft' || k === 'a') nudgeAim(-step, 0);
    else if (k === 'arrowright' || k === 'd') nudgeAim(step, 0);
    else if (k === 'enter' || k === ' ') { pushHmLevel(techLevel()); requestHmPreview(); }
    else handled = false;
  } else if (lvl.kind === 'confirm') {
    if (k === 'arrowup' || k === 'w' || k === 'arrowdown' || k === 's') lvl.sel = (lvl.sel || 0) === 0 ? 1 : 0;
    else if (k === 'enter' || k === ' ') { if ((lvl.sel || 0) === 0) hmConfirmPass(); else popHmLevel(); }
    else handled = false;
  } else {
    // 普通列表（顶层指令/脚法/高度）：方向键/WASD 移动，回车/空格确认
    if (k === 'arrowup' || k === 'w') moveList(-1);
    else if (k === 'arrowdown' || k === 's') moveList(1);
    else if (k === 'enter' || k === ' ') activateList();
    else handled = false;
  }
  if (handled) e.preventDefault();
  return handled;
}
function togglePause(force) {
  var target = typeof force === 'boolean' ? force : !ui.pauseOpen;
  ui.pauseOpen = target;
  api.post('/api/match/' + matchId + '/pause', { paused: target });
}
function exitMatch() {
  api.del('/api/match/' + matchId).catch(function () {});
  matchId = null; state = null; screen = 'title';
}

// ---------------- 绘制：通用 ----------------
function rr(x, y, w, h, r) { // 圆角矩形路径
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function panel(x, y, w, h, fill) {
  ctx.fillStyle = 'rgba(8,12,26,0.92)';
  rr(x, y, w, h, 6); ctx.fill();
  ctx.strokeStyle = fill || '#3d5a99';
  ctx.lineWidth = 2; ctx.stroke();
}
function text(str, x, y, size, color, align, bold) {
  ctx.font = (bold ? 'bold ' : '') + size + 'px "PingFang SC","Microsoft YaHei",monospace';
  ctx.fillStyle = color || '#fff';
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
}
function bar(x, y, w, h, ratio, color, bg) {
  ctx.fillStyle = bg || '#20263c';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * clamp(ratio, 0, 1), h);
  ctx.strokeStyle = '#0a0d18'; ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}
// 通用按钮：绘制 + 注册点击；disabled 时置灰且点击只 toast
function drawButton(x, y, w, h, label, onClick, color, fontSize, disabled) {
  ctx.fillStyle = disabled ? '#232838' : (color || '#2b5fe3');
  rr(x, y, w, h, 8); ctx.fill();
  if (!disabled) { ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1.5; ctx.stroke(); }
  text(label, x + w / 2, y + h / 2 - 8, fontSize || 18, disabled ? '#5a6584' : '#fff', 'center', true);
  (function (fn, dis) {
    addClick(x, y, w, h, function () {
      if (dis) { toast('体能不足或该球员无法使用'); return; }
      fn();
    });
  })(onClick, disabled);
}

// ---------------- 绘制：标题 ----------------
var HALF_OPTS = [
  { label: '1 分钟', value: 60 },
  { label: '3 分钟', value: 180 },
  { label: '5 分钟', value: 300 },
];
var MENTALITY_OPTS = [
  { label: '均衡', value: 'balanced' },
  { label: '进攻', value: 'attack' },
  { label: '防守', value: 'defend' },
];
function drawTitle() {
  var g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0d1430'); g.addColorStop(1, '#131c3d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // 像素草地装饰
  ctx.fillStyle = '#1d7a3a'; ctx.fillRect(0, H - 120, W, 120);
  ctx.fillStyle = '#239244';
  for (var i = 0; i < 16; i++) ctx.fillRect(i * 80, H - 120, 40, 120);

  text('热 血 足 球 RPG', W / 2, 190, 84, '#ffd94a', 'center', true);
  text('天使之翼式 · 回合指令制 · 服务器权威判定', W / 2, 260, 24, '#9fb4dd', 'center');
  text('青鹰高校  vs  烈风学院', W / 2, 320, 30, '#ffffff', 'center', true);

  text('半场时长', W / 2 - 260, 380, 20, '#9fb4dd', 'center');
  HALF_OPTS.forEach(function (o, i) {
    var x = W / 2 - 200 + i * 150, y = 400, w = 130, h = 44;
    var sel = ui.halfLength === o.value;
    ctx.fillStyle = sel ? '#2b5fe3' : '#1a2340';
    rr(x, y, w, h, 6); ctx.fill();
    ctx.strokeStyle = sel ? '#8fb0ff' : '#3d5a99'; ctx.lineWidth = 2; ctx.stroke();
    text(o.label, x + w / 2, y + h / 2, 20, sel ? '#fff' : '#9fb4dd', 'center', sel);
    (function (v) { addClick(x, y, w, h, function () { ui.halfLength = v; }); })(o.value);
  });

  text('战术倾向', W / 2 - 260, 470, 20, '#9fb4dd', 'center');
  MENTALITY_OPTS.forEach(function (o, i) {
    var x = W / 2 - 200 + i * 150, y = 490, w = 130, h = 44;
    var sel = ui.mentality === o.value;
    ctx.fillStyle = sel ? '#2b8f5f' : '#1a2340';
    rr(x, y, w, h, 6); ctx.fill();
    ctx.strokeStyle = sel ? '#9fe8bf' : '#3d5a99'; ctx.lineWidth = 2; ctx.stroke();
    text(o.label, x + w / 2, y + h / 2, 20, sel ? '#fff' : '#9fb4dd', 'center', sel);
    (function (v) { addClick(x, y, w, h, function () { ui.mentality = v; }); })(o.value);
  });

  var bx = W / 2 - 130, by = 580, bw = 260, bh = 64;
  ctx.fillStyle = '#e8a923'; rr(bx, by, bw, bh, 8); ctx.fill();
  ctx.strokeStyle = '#fff2c8'; ctx.lineWidth = 3; ctx.stroke();
  text('⚽ 开 始 比 赛', W / 2, by + bh / 2, 28, '#3a2a00', 'center', true);
  addClick(bx, by, bw, bh, startMatch);

  text('电脑：WASD 移动 · J/Shift加速 K减速 · L切换球员 · E指令菜单 · 空格暂停', W / 2, 672, 16, '#5f7099', 'center');
  text('手机 / Pad：左虚拟方向盘移动 · 右侧按键加速/减速/切换/菜单', W / 2, 696, 16, '#5f7099', 'center');
}

// ---------------- 绘制：比赛 ----------------
function drawGame(t) {
  drawBackground();
  drawPitch();
  drawGoals();
  drawActors(t);
  drawScoreboard();
  drawMinimap(); // ★ 小地图：全场只在这里看（球员点/球/镜头框/被操控绿圈）
  drawPauseButton();
  if (isTouch) drawGamepad(); // 移动端/Pad：透明虚拟手柄（画在菜单下层）
  if (ui.pauseOpen) drawPauseMenu();
  drawBottomUI(t);
  drawCutin();
  // ★ 被动决策：头顶浮动菜单（无背景、多级嵌套，不遮挡场上内容）
  if (state && state.decision && !ui.pauseOpen && !ui.overlay) drawHeadMenu();
  if (ui.overlay === 'status') drawStatusOverlay();
  if (ui.overlay === 'settings') drawSettingsOverlay();
  if (state && state.phase === 'fulltime') drawFulltime();
  drawToast();
}

function drawBackground() {
  var g = ctx.createLinearGradient(0, 0, 0, HORIZON);
  g.addColorStop(0, '#7ec8f0'); g.addColorStop(1, '#cfe9f7');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, HORIZON);
  // 看台
  ctx.drawImage(crowdCv, 0, 56);
  ctx.fillStyle = '#2a3350'; ctx.fillRect(0, 52, W, 6);
  // 广告牌
  var ads = [
    { t: 'GO! GO!', c: '#2b5fe3' }, { t: 'FOOTBALL', c: '#e34a8b' }, { t: 'DREAM', c: '#d23b3b' },
    { t: 'GO! GO!', c: '#2b5fe3' }, { t: 'FOOTBALL', c: '#e34a8b' }, { t: 'DREAM', c: '#d23b3b' },
  ];
  var bw = W / ads.length;
  ads.forEach(function (a, i) {
    ctx.fillStyle = a.c;
    ctx.fillRect(i * bw + 3, 116, bw - 6, 28);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 17px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(a.t, i * bw + bw / 2, 131);
  });
}

function drawPitch() {
  // 草地条纹（透视四边形）
  var greens = ['#46b45f', '#3da855'];
  for (var i = 0; i < 14; i++) {
    var x0 = (i * C.FIELD.W) / 14, x1 = ((i + 1) * C.FIELD.W) / 14;
    var p0 = project(x0, 0), p1 = project(x1, 0), p2 = project(x1, C.FIELD.H), p3 = project(x0, C.FIELD.H);
    ctx.fillStyle = greens[i % 2];
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y);
    ctx.closePath(); ctx.fill();
  }
  // 白线
  function line(x1, y1, x2, y2) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (var i = 0; i <= 20; i++) {
      var p = project(x1 + ((x2 - x1) * i) / 20, y1 + ((y2 - y1) * i) / 20);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  function circle(cx, cy, r) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (var i = 0; i <= 40; i++) {
      var a = (i / 40) * Math.PI * 2;
      var p = project(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.62);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  var F = C.FIELD;
  line(0, 0, F.W, 0); line(0, F.H, F.W, F.H);       // 边线
  line(0, 0, 0, F.H); line(F.W, 0, F.W, F.H);       // 底线
  line(F.W / 2, 0, F.W / 2, F.H);                    // 中线
  circle(F.W / 2, F.H / 2, 9.15);                    // 中圈
  // 两侧禁区
  [[0, 1], [F.W, -1]].forEach(function (s) {
    var gx = s[0], d = s[1];
    line(gx, F.H / 2 - 20.16, gx + 16.5 * d, F.H / 2 - 20.16);
    line(gx + 16.5 * d, F.H / 2 - 20.16, gx + 16.5 * d, F.H / 2 + 20.16);
    line(gx + 16.5 * d, F.H / 2 + 20.16, gx, F.H / 2 + 20.16);
    line(gx, F.H / 2 - 9.16, gx + 5.5 * d, F.H / 2 - 9.16);
    line(gx + 5.5 * d, F.H / 2 - 9.16, gx + 5.5 * d, F.H / 2 + 9.16);
    line(gx + 5.5 * d, F.H / 2 + 9.16, gx, F.H / 2 + 9.16);
  });
}

function drawGoals() {
  // 简易球门：门柱 + 球网
  [[0, -1], [C.FIELD.W, 1]].forEach(function (s) {
    var gx = s[0], d = s[1];
    var w = 7.32, dep = 2.5;
    var p1 = project(gx, 34 - w / 2), p2 = project(gx, 34 + w / 2);
    var p3 = project(gx + dep * d, 34 - w / 2), p4 = project(gx + dep * d, 34 + w / 2);
    var top1 = { x: p1.x, y: p1.y - 26 * p1.s }, top2 = { x: p2.x, y: p2.y - 26 * p2.s };
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
    for (var i = 0; i <= 6; i++) {
      var t = i / 6;
      ctx.beginPath();
      ctx.moveTo(p1.x + (p3.x - p1.x) * t, p1.y + (p3.y - p1.y) * t - 26 * p1.s * (1 - t * 0.3));
      ctx.lineTo(p2.x + (p4.x - p2.x) * t, p2.y + (p4.y - p2.y) * t - 26 * p2.s * (1 - t * 0.3));
      ctx.stroke();
    }
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(top1.x, top1.y); ctx.lineTo(p1.x, p1.y);
    ctx.moveTo(top2.x, top2.y); ctx.lineTo(p2.x, p2.y);
    ctx.moveTo(top1.x, top1.y); ctx.lineTo(top2.x, top2.y);
    ctx.stroke();
  });
}

function drawActors(t) {
  if (!state) return;
  // ★ 基于时间的快照线性插值：两帧快照之间按墙钟匀速过渡，消除指数追赶的脉冲感；
  //   开球/重置等瞬移（>8 米）直接贴过去，不做滑行。
  var _ia = 1;
  if (snapPrev && snapCurr && snapCurr.t > snapPrev.t) {
    _ia = (t - snapPrev.t) / (snapCurr.t - snapPrev.t);
    if (_ia < 0) _ia = 0; else if (_ia > 1) _ia = 1;
  }
  state.players.forEach(function (p) {
    var rp = renderPos[p.id];
    if (!rp) { renderPos[p.id] = { x: p.x, y: p.y }; return; }
    var A = snapPrev && snapPrev.px[p.id], B = snapCurr && snapCurr.px[p.id];
    if (A && B) {
      var dx = B.x - A.x, dy = B.y - A.y;
      if (dx * dx + dy * dy > 64) { rp.x = B.x; rp.y = B.y; }
      else { rp.x = A.x + dx * _ia; rp.y = A.y + dy * _ia; }
    } else { rp.x = p.x; rp.y = p.y; }
  });
  if (snapPrev && snapCurr) {
    var bdx = snapCurr.ball.x - snapPrev.ball.x, bdy = snapCurr.ball.y - snapPrev.ball.y;
    if (bdx * bdx + bdy * bdy > 64) { ballR.x = snapCurr.ball.x; ballR.y = snapCurr.ball.y; }
    else { ballR.x = snapPrev.ball.x + bdx * _ia; ballR.y = snapPrev.ball.y + bdy * _ia; }
  } else if (state.ball) { ballR.x = state.ball.x; ballR.y = state.ball.y; }

  var order = state.players.slice().sort(function (a, b) {
    return renderPos[b.id].y - renderPos[a.id].y; // 远的先画
  });
  var animFrame = Math.floor(t / 280) % 2;
  var ownerBakedBall = false; // ★ 持球者序列帧里已 baked 了球（outfield 精灵每帧脚下有球），则不再单独画球，避免双球抖动
  order.forEach(function (p) {
    var rp = renderPos[p.id];
    var pr = project(rp.x, rp.y);
    var s = pr.s;
    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(pr.x, pr.y + 2, 13 * s, 4.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // 持球光环（用户球员）
    if (p.hasBall && p.team === 'home') {
      ctx.strokeStyle = '#7fd0ff'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(pr.x, pr.y + 2, 16 * s, 6 * s, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // ★ 被玩家直接操控标记（绿圈）改到所有球员画完后统一置顶绘制，避免被身前球员精灵遮挡
    //   （之前画在各自脚下，会被更靠前的对方球员盖住，看起来像"在控制红方"）
    // ★ 序列帧绘制：跑动播 run 循环 / 静止播 idle；精灵未就绪时兜底用旧代码帧
    var spr = spriteFrameFor(p, t);
    if (p.hasBall && spr && p.pos !== 'GK') ownerBakedBall = true; // 门将帧里没球，仍需单独画
    var dw = 16 * s * 1.9, dh = 24 * s * 1.9; // 2:3，与 48×72 帧同比例
    var stagger = !!p.beaten; // ★ 被晃倒：精灵倾斜踉跄，一眼看出被过了
    if (stagger) {
      ctx.save();
      ctx.translate(pr.x, pr.y - dh / 2);
      ctx.rotate(0.50 * ((p.num % 2) ? 1 : -1)); // ★ 2026-10-09 加大到 0.5（之前 0.3 精灵太小看不出）
      ctx.translate(-pr.x, -(pr.y - dh / 2));
    }
    if (spr) {
      var sy = spr.row * 72;
      if (p.team === 'away') {
        // 客队朝左：水平翻转
        ctx.save();
        ctx.translate(pr.x, pr.y - dh);
        ctx.scale(-1, 1);
        ctx.drawImage(spr.img, 0, sy, 48, 72, -dw / 2, 0, dw, dh);
        ctx.restore();
      } else {
        ctx.drawImage(spr.img, 0, sy, 48, 72, pr.x - dw / 2, pr.y - dh, dw, dh);
      }
    } else {
      var frames = framesFor(p);
      var img = frames[animFrame];
      if (p.team === 'away') {
        // 客队朝左：水平翻转
        ctx.save();
        ctx.translate(pr.x, pr.y - dh);
        ctx.scale(-1, 1);
        ctx.drawImage(img, -dw / 2, 0, dw, dh);
        ctx.restore();
      } else {
        ctx.drawImage(img, pr.x - dw / 2, pr.y - dh, dw, dh);
      }
    }
    // 冻结标记
    if (p.frozen) text('💫', pr.x, pr.y - dh - 8, 14 * s, '#fff', 'center');
    if (stagger) ctx.restore(); // ★ 踉跄倾斜结束
    if (stagger) {
      // ★ 眩晕星星：被晃倒头顶转星星，不用眯眼也能看出"这人被过了定住了"
      var swx = pr.x + Math.sin(t / 240) * 10 * s, swy = pr.y - dh - 14 * s + Math.cos(t / 310) * 4 * s;
      ctx.font = Math.round(20 * s) + 'px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('💫', swx, swy);
    }
  });

  // 球
  // ★ 带球触球：球不再焊死在固定偏移上，而是随持球者跑动步频做"趟—追"触球动作，
  //   与序列帧同一相位（球脚同步）；盘带越好，趟球距离越短（高手球不离脚）。
  //   只有球真正离脚飞行时（传球/射门/解围）才绘制轨迹残影。
  var bbx = ballR.x, bby = ballR.y, ballOwned = false;
  for (var boi = 0; boi < state.players.length; boi++) {
    if (state.players[boi].hasBall) {
      var owner = state.players[boi];
      ballOwned = true;
      var oc = owner._cycle, orp = renderPos[owner.id] || owner;
      if (oc && oc.moving) {
        var olen = Math.sqrt(oc.dx * oc.dx + oc.dy * oc.dy);
        if (olen > 1e-6) {
          var drib = (owner.stats && owner.stats.dribbling) || 10;
          var touchMax = 1.15 - (drib / 20) * 0.55;
          var lead = 0.32 + touchMax * (0.5 - 0.5 * Math.cos(oc.phase * Math.PI * 2));
          bbx = orp.x + (oc.dx / olen) * lead;
          bby = orp.y + (oc.dy / olen) * lead;
        } else { bbx = orp.x; bby = orp.y; }
      } else { bbx = orp.x; bby = orp.y; }
      break;
    }
  }
  // ★ 球高度（米）：飞行时按抛物线升空，画在地面位置上方 + 地面投影，
  //   高度在画面上可读 —— 超高球中段肉眼可见地飞在高空。
  var ballZ = (state.ball && state.ball.z) || 0;
  if (!ballOwned) {
    ballTrail.push({ x: bbx, y: bby, z: ballZ });
    if (ballTrail.length > 9) ballTrail.shift();
  } else if (ballTrail.length) {
    ballTrail.length = 0; // 脚下球不留轨迹
  }
  for (var bti = 0; bti < ballTrail.length; bti++) {
    var btp = project(ballTrail[bti].x, ballTrail[bti].y);
    var trz = Math.min(ballTrail[bti].z || 0, 5) * 30 * btp.s;
    ctx.fillStyle = 'rgba(255,255,255,' + (0.05 + 0.20 * bti / ballTrail.length) + ')';
    ctx.beginPath(); ctx.arc(btp.x, btp.y - 4 - trz, 3.2 * btp.s, 0, Math.PI * 2); ctx.fill();
  }
  var bp = project(bbx, bby);
  // ★ 视觉压缩：真实 11 米按 5 米封顶画（≈150px），保证球始终在画面内；
  //   球与地面阴影的分离距离仍能读出"很高"，不压缩会直接飞出视野。
  var rise = Math.min(ballZ, 5) * 30 * bp.s; // 1 米 ≈ 30*s px，封顶 5 米
  if (ballZ > 0.4) {
    // 地面投影：球飞得越高，影越淡越小，地面位置始终可读
    var shA = Math.max(0.10, 0.35 - ballZ * 0.02);
    ctx.fillStyle = 'rgba(0,0,0,' + shA.toFixed(2) + ')';
    ctx.beginPath(); ctx.ellipse(bp.x, bp.y + 2, 9 * bp.s, 3.6 * bp.s, 0, 0, Math.PI * 2); ctx.fill();
  }
  var bs = 8 * bp.s * 1.6 * (1 + Math.min(ballZ, 6) * 0.02);
  if (!ballOwned || !ownerBakedBall) ctx.drawImage(ballImg, bp.x - bs / 2, bp.y - bs - 2 - rise, bs, bs);

  // ★ 被玩家直接操控标记（绿圈）：置顶绘制，不被任何球员遮挡
  //   2 秒无操作被 AI 接管时变暗，提示"动一下方向键拿回控制"
  if (state.controlledId) {
    for (var ci2 = 0; ci2 < state.players.length; ci2++) {
      var cp = state.players[ci2];
      if (cp.id !== state.controlledId) continue;
      var crp = renderPos[cp.id] || cp;
      var cpr = project(crp.x, crp.y);
      ctx.save();
      if (!state.controlActive) ctx.globalAlpha = 0.35;
      ctx.strokeStyle = '#51ff9a'; ctx.lineWidth = 3;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.ellipse(cpr.x, cpr.y + 2, 22 * cpr.s, 9 * cpr.s, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // 头顶小三角，进一步标明"这是你的人"
      ctx.fillStyle = '#51ff9a';
      var ty = cpr.y - 34 * cpr.s - 10;
      ctx.beginPath();
      ctx.moveTo(cpr.x, ty + 10); ctx.lineTo(cpr.x - 7, ty); ctx.lineTo(cpr.x + 7, ty);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      break;
    }
  }

}

function drawScoreboard() {
  if (!state) return;
  var y = 8, h = 44;
  // 主队
  ctx.fillStyle = '#1d3fa0'; ctx.fillRect(14, y, 170, h);
  text('青鹰高校', 99, y + h / 2, 22, '#fff', 'center', true);
  // 比分
  ctx.fillStyle = '#0a0d18'; ctx.fillRect(184, y, 120, h);
  text(state.score.home + ' - ' + state.score.away, 244, y + h / 2, 26, '#ffd94a', 'center', true);
  // 客队
  ctx.fillStyle = '#a02a2a'; ctx.fillRect(304, y, 170, h);
  text('烈风学院', 389, y + h / 2, 22, '#fff', 'center', true);
  // 时间
  ctx.fillStyle = '#0a0d18'; ctx.fillRect(484, y, 150, h);
  text(state.halfLabel + '  ' + state.clockLabel, 559, y + h / 2, 22, '#fff', 'center', true);
}

// ★ 小地图：全场只在这里看。右上角：球员点（蓝/红）、球（白点）、
//   镜头视野框（白框）、被操控球员（绿圈）
function drawMinimap() {
  if (!state) return;
  var mw = 200, mh = mw * C.FIELD.H / C.FIELD.W;
  var mx = W - mw - 14, my = 60;
  var kx = mw / C.FIELD.W, ky = mh / C.FIELD.H;
  ctx.save();
  ctx.fillStyle = 'rgba(6,20,10,0.85)';
  ctx.fillRect(mx, my, mw, mh);
  ctx.strokeStyle = '#3f6b4f'; ctx.lineWidth = 2;
  ctx.strokeRect(mx + 1, my + 1, mw - 2, mh - 2);
  ctx.strokeStyle = 'rgba(220,235,220,0.45)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mx + mw / 2, my + 3); ctx.lineTo(mx + mw / 2, my + mh - 3); ctx.stroke();
  ctx.beginPath(); ctx.arc(mx + mw / 2, my + mh / 2, 9.15 * kx, 0, Math.PI * 2); ctx.stroke();
  state.players.forEach(function (p) {
    if (p.sentOff) return;
    ctx.fillStyle = p.team === 'home' ? '#5b8cff' : '#ff6b6b';
    ctx.beginPath();
    ctx.arc(mx + p.x * kx, my + p.y * ky, p.pos === 'GK' ? 3.4 : 2.6, 0, Math.PI * 2);
    ctx.fill();
  });
  if (state.controlledId) {
    for (var i = 0; i < state.players.length; i++) {
      var cp = state.players[i];
      if (cp.id !== state.controlledId) continue;
      ctx.strokeStyle = '#51ff9a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(mx + cp.x * kx, my + cp.y * ky, 5.5, 0, Math.PI * 2); ctx.stroke();
      break;
    }
  }
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(mx + state.ball.x * kx, my + state.ball.y * ky, 3, 0, Math.PI * 2); ctx.fill();
  var viewW = curViewW();
  var cx = clamp(ballR.x - viewW * 0.45, -6, C.FIELD.W - viewW + 6);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5;
  ctx.strokeRect(mx + cx * kx, my + 2, viewW * kx, mh - 4);
  ctx.restore();
}

function drawPauseButton() {
  var x = W - 120, y = 8, w = 106, h = 44;
  panel(x, y, w, h);
  text('⏸ 暂停', x + w / 2, y + h / 2, 20, '#fff', 'center', true);
  addClick(x, y, w, h, function () { togglePause(); });
}

function drawPauseMenu() {
  var x = W - 300, y = 62, w = 286, h = 320;
  panel(x, y, w, h);
  text('PAUSE', x + 20, y + 26, 20, '#9fb4dd', 'left', true);
  var items = [
    { label: '▶ 继续比赛', fn: function () {
        togglePause(false);
        // 决策点会暂停模拟：此时不是"暂停"，而是等玩家选指令
        if (state && state.decision) toast('请先在球员头顶选择指令');
      } },
    { label: '⚙ 战术指令', fn: function () { ui.tacticOpen = !ui.tacticOpen; } },
    { label: '👤 球员状态', fn: function () { ui.overlay = 'status'; ui.pauseOpen = false; api.post('/api/match/' + matchId + '/pause', { paused: false }); } },
    { label: '🔧 比赛设定', fn: function () { ui.overlay = 'settings'; } },
    { label: '⏪ 回放', fn: function () { toast('演示版暂未实现回放功能'); } },
    { label: '⏻ 退出比赛', fn: function () {
        if (Date.now() - ui.exitArm < 3000) { togglePause(false); exitMatch(); }
        else { ui.exitArm = Date.now(); toast('再点一次确认退出比赛'); }
      } },
  ];
  items.forEach(function (it, i) {
    var iy = y + 52 + i * 42, ih = 36;
    var hov = it.label.indexOf('战术指令') === 0 && ui.tacticOpen;
    ctx.fillStyle = hov ? '#2b5fe3' : '#141b34';
    rr(x + 12, iy, w - 24, ih, 5); ctx.fill();
    text(it.label, x + 28, iy + ih / 2, 18, '#fff', 'left');
    (function (fn) { addClick(x + 12, iy, w - 24, ih, fn); })(it.fn);
  });
  if (ui.tacticOpen) {
    var tys = y + 52 + 1 * 42;
    var topts = [
      { label: '均衡', v: 'balanced' }, { label: '进攻', v: 'attack' }, { label: '防守', v: 'defend' },
    ];
    topts.forEach(function (o, i) {
      var tx = x - 100, tw = 92, th = 36;
      var sel = state && state.mentality === o.v;
      ctx.fillStyle = sel ? '#2b8f5f' : '#141b34';
      rr(tx, tys + i * 40, tw, th, 5); ctx.fill();
      ctx.strokeStyle = sel ? '#9fe8bf' : '#3d5a99'; ctx.lineWidth = 1.5; ctx.stroke();
      text(o.label, tx + tw / 2, tys + i * 40 + th / 2, 16, '#fff', 'center');
      (function (v) {
        addClick(tx, tys + i * 40, tw, th, function () {
          api.post('/api/match/' + matchId + '/mentality', { mentality: v });
          toast('战术切换为：' + o.label);
        });
      })(o.v);
    });
  }
}

// ---------------- 底部 UI ----------------
function homePlayer(i) {
  if (!state) return null;
  var homes = state.players.filter(function (p) { return p.team === 'home'; });
  homes.sort(function (a, b) { return a.num - b.num; });
  return homes[i];
}
function focusPlayer() {
  // 指令决策中 -> 决策球员；否则实际被操控球员（绿圈）；再否则阵容条选中球员
  if (state && state.decision) {
    var dp = null;
    state.players.forEach(function (p) { if (p.id === state.decision.playerId) dp = p; });
    if (dp) return dp;
  }
  if (state && state.controlledId) {
    var cp = null;
    state.players.forEach(function (p) { if (p.id === state.controlledId) cp = p; });
    if (cp) return cp;
  }
  return homePlayer(selectedHomeIdx);
}

function drawBottomUI(t) {
  var y0 = 556;
  // 球员卡
  drawPlayerCard(8, y0, 288, 92);
  // 指令区：被动决策改为球员头顶浮动菜单（drawHeadMenu，无背景不遮挡），底部只保留待机提示
  drawIdleHint(304, y0, 636, 92);
  // 雷达 + 阵容条
  drawRadar(8, 654, 212, 58);
  drawRoster(228, 654, W - 236, 58);
}

function drawPlayerCard(x, y, w, h) {
  panel(x, y, w, h);
  var p = focusPlayer();
  if (!p) { text('连接中…', x + w / 2, y + h / 2, 16, '#9fb4dd', 'center'); return; }
  var frames = framesFor(p);
  ctx.drawImage(frames[0], x + 10, y + 8, 48, 72); // 头像
  text(p.num + ' ' + p.name, x + 68, y + 18, 19, '#fff', 'left', true);
  var posC = p.pos === 'GK' ? '#e8b923' : p.pos === 'DF' ? '#4a90e3' : p.pos === 'MF' ? '#2b8f5f' : '#e35f5f';
  ctx.fillStyle = posC; rr(x + w - 52, y + 8, 42, 22, 4); ctx.fill();
  text(p.pos, x + w - 31, y + 19, 15, '#fff', 'center', true);

  text('体能', x + 68, y + 42, 13, '#9fb4dd', 'left');
  bar(x + 108, y + 35, 140, 12, p.stamina / p.maxStamina, '#51d651');
  text(p.stamina + '/' + p.maxStamina, x + 254, y + 42, 12, '#cfe0ff', 'left');

  var skill = p.special ? '必杀技：' + p.special.name : '必杀技：无';
  text('Lv.' + p.level + '  ' + skill, x + 68, y + 66, 12, '#ffd94a', 'left');
}

var CMD_ICONS = { dribble: '💨', pass: '➡️', protect: '🛡️', shoot: '⚽', special: '🔥', feint: '🌀', retreat: '↩️', tackle: '🦵', jockey: '🧱' };

function drawIdleHint(x, y, w, h) {
  panel(x, y, w, h);
  var msg = isTouch ? '拖左盘移动（绿圈球员）；持球遇防守时在球员头顶选指令；防守贴近对方持球者可上抢'
                    : 'WASD 移动（绿圈球员）；持球遇防守时在球员头顶选指令；防守贴近对方持球者可上抢';
  if (state) {
    if (state.phase === 'kickoff') msg = '开球！';
    else if (state.phase === 'goal') msg = '⚽ 进球！';
    else if (state.phase === 'halftime') msg = '中场休息…';
    else if (state.paused) msg = '已暂停';
    else if (state.controlActive === false) msg = '绿圈球员正由 AI 接管——动一下方向键拿回控制';
  }
  text(msg, x + w / 2, y + h / 2, 17, '#9fb4dd', 'center');
}

function wrapText(str, x, y, maxW, size, color, maxLines) {
  ctx.font = size + 'px "PingFang SC","Microsoft YaHei",monospace';
  var line = '', ly = y, n = 0;
  for (var i = 0; i < str.length; i++) {
    var test = line + str[i];
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(line, x, ly);
      line = str[i]; ly += size + 5; n++;
      if (n >= maxLines - 1) break;
    } else line = test;
  }
  if (n < maxLines) {
    ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(line, x, ly);
  }
}

function drawRadar(x, y, w, h) {
  panel(x, y, w, h);
  var fx = x + 8, fy = y + 6, fw = w - 16, fh = h - 12;
  ctx.fillStyle = '#1d7a3a'; ctx.fillRect(fx, fy, fw, fh);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
  ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
  ctx.beginPath(); ctx.moveTo(fx + fw / 2, fy); ctx.lineTo(fx + fw / 2, fy + fh); ctx.stroke();
  if (!state) return;
  state.players.forEach(function (p) {
    var rp = renderPos[p.id] || p;
    ctx.fillStyle = p.team === 'home' ? '#4a90ff' : '#ff5a5a';
    ctx.fillRect(fx + (rp.x / C.FIELD.W) * fw - 2, fy + (rp.y / C.FIELD.H) * fh - 2, 4, 4);
  });
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(fx + (ballR.x / C.FIELD.W) * fw, fy + (ballR.y / C.FIELD.H) * fh, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawRoster(x, y, w, h) {
  panel(x, y, w, h);
  var n = 11, iw = (w - 16) / n;
  for (var i = 0; i < n; i++) {
    var p = homePlayer(i);
    if (!p) continue;
    var ix = x + 8 + i * iw;
    var sel = i === selectedHomeIdx;
    if (sel) { ctx.fillStyle = '#2b5fe3'; rr(ix, y + 4, iw - 6, h - 8, 4); ctx.fill(); }
    var frames = framesFor(p);
    ctx.drawImage(frames[0], ix + (iw - 6) / 2 - 11, y + 6, 22, 33);
    text(p.num + '', ix + 8, y + h - 12, 11, sel ? '#fff' : '#9fb4dd', 'left', true);
    var posC = p.pos === 'GK' ? '#e8b923' : p.pos === 'DF' ? '#4a90e3' : p.pos === 'MF' ? '#51d651' : '#ff7a7a';
    text(p.pos, ix + iw - 14, y + h - 12, 11, posC, 'right', true);
    if (p.hasBall) {
      ctx.strokeStyle = '#7fd0ff'; ctx.lineWidth = 2;
      rr(ix, y + 4, iw - 6, h - 8, 4); ctx.stroke();
    }
    (function (idx) { addClick(ix, y + 4, iw - 6, h - 8, function () {
      selectedHomeIdx = idx;
      var pl = homePlayer(idx);
      if (pl && pl.pos !== 'GK' && !pl.sentOff) {
        sendInput({ playerId: pl.id });
        toast('操控 ' + pl.num + '号 ' + pl.name);
      }
    }); })(i);
  }
}

// ---------------- 透明虚拟手柄（移动端 / Pad） ----------------
function drawGamepad() {
  if (screen !== 'game') return;
  // 左：方向盘
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.arc(DPAD.x, DPAD.y, DPAD.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 2; ctx.stroke();
  // 四方向刻度
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(function (d) {
    ctx.beginPath();
    ctx.arc(DPAD.x + d[0] * (DPAD.r - 14), DPAD.y + d[1] * (DPAD.r - 14), 5, 0, Math.PI * 2);
    ctx.fill();
  });
  // 摇杆头（跟随输入）
  var kx = DPAD.x + pad.dx * DPAD.r * 0.55, ky = DPAD.y - pad.dy * DPAD.r * 0.55;
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath(); ctx.arc(kx, ky, 34, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2; ctx.stroke();
  // 右：功能按键
  BTNS.forEach(function (b) {
    var active = (b.id === 'sprint' && pad.sprint) || (b.id === 'slow' && pad.slow);
    ctx.fillStyle = active ? 'rgba(120,255,160,0.28)' : 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 2; ctx.stroke();
    text(menuBtnLabel(b.id, b.label), b.x, b.y + 1, 20, 'rgba(255,255,255,0.75)', 'center', true);
  });
}

// ---------------- 事件横幅 / 指令演出 ----------------
function drawCutin() {
  if (!state || !state.lastAction) return;
  var a = state.lastAction;
  // ★ 有演出图键 → 全屏像素风结算演出（仿《天使之翼》指令结算画面）
  var im = a.cut && CUT_IMGS[a.cut];
  if (im && im.complete && im.naturalWidth) {
    drawCutscene(a, im);
    return;
  }
  if (a.kind === 'goal') {
    // 全屏进球横幅
    ctx.fillStyle = 'rgba(8,12,26,0.55)'; ctx.fillRect(0, 200, W, 130);
    text('⚽  G O A L  ⚽', W / 2, 245, 64, '#ffd94a', 'center', true);
    text(a.text, W / 2, 300, 22, '#fff', 'center');
    return;
  }
  if (a.kind === 'halftime' || a.kind === 'fulltime') {
    ctx.fillStyle = 'rgba(8,12,26,0.7)'; ctx.fillRect(0, 240, W, 90);
    text(a.label, W / 2, 272, 40, '#ffd94a', 'center', true);
    text(a.text, W / 2, 308, 20, '#fff', 'center');
    return;
  }
  // 右侧演出面板（仿效果图）
  var x = 950, y = 150, w = 316, h = 210;
  panel(x, y, w, h, a.success ? '#2b5fe3' : '#8a2b2b');
  text(a.label, x + 18, y + 30, 26, '#fff', 'left', true);
  text(a.success ? '成功！' : '失败…', x + 18, y + 62, 20, a.success ? '#7fd0ff' : '#ff9a9a', 'left', true);
  wrapText(a.text, x + 18, y + 92, w - 36, 14, '#e8eeff', 3);
  text(a.playerName, x + 18, y + h - 24, 15, '#ffd94a', 'left');
}

// ★ 全屏结算演出：暗场 + 像素风拼贴特写 + 标题 + 文字解说
function drawCutscene(a, im) {
  ctx.fillStyle = 'rgba(4,6,14,0.88)';
  ctx.fillRect(0, 0, W, H);
  // 图片 3:2，按屏宽自适应（手机竖屏也能看全）
  var iw = Math.min(680, W - 40), ih = iw * 2 / 3;
  var ix = (W - iw) / 2, iy = Math.max(50, (H - ih) / 2 - 70);
  ctx.drawImage(im, ix, iy, iw, ih);
  ctx.strokeStyle = '#ffd94a'; ctx.lineWidth = 3;
  ctx.strokeRect(ix - 2, iy - 2, iw + 4, ih + 4);
  // 标题：进球单独放大
  var isGoal = a.kind === 'goal' || a.kind === 'penalty' && a.success;
  var title = isGoal ? '⚽ G O A L ⚽' : (a.label || '');
  text(title, W / 2, iy + ih + 42, isGoal ? 52 : 34,
    isGoal ? '#ffd94a' : (a.success ? '#7fd0ff' : '#ff9a9a'), 'center', true);
  var tx = W / 2 - Math.min(430, W / 2 - 30);
  wrapText(a.text || '', tx, iy + ih + 76, Math.min(860, W - 60), 17, '#e8eeff', 2);
  text(a.playerName || '', W / 2, iy + ih + 118, 15, '#ffd94a', 'center');
}

// ---------------- 覆盖层 ----------------
function drawStatusOverlay() {
  ctx.fillStyle = 'rgba(4,6,14,0.75)'; ctx.fillRect(0, 0, W, H);
  var x = 250, y = 56, w = 780, h = 608;
  panel(x, y, w, h);
  text('球员状态 - 青鹰高校', x + w / 2, y + 30, 24, '#fff', 'center', true);
  text('号码  姓名        位置  Lv   体能', x + 30, y + 60, 15, '#9fb4dd', 'left');
  if (state) {
    for (var i = 0; i < 11; i++) {
      var p = homePlayer(i);
      var py = y + 88 + i * 46;
      text(p.num + '', x + 34, py, 15, '#fff', 'left', true);
      text(p.name, x + 80, py, 15, '#fff', 'left');
      text(p.pos, x + 200, py, 15, '#9fb4dd', 'left');
      text('' + p.level, x + 250, py, 15, '#ffd94a', 'left');
      bar(x + 290, py - 7, 120, 12, p.stamina / p.maxStamina, '#51d651');
      text(p.stamina + '/' + p.maxStamina, x + 416, py, 12, '#cfe0ff', 'left');
      // ★ 第二行：FM 关键属性（1-20）+ 必杀技，颜色区分强弱
      drawAttrChips(p, x + 80, py + 20);
      text(p.special ? p.special.name : '-', x + w - 24, py + 20, 13, '#ffd94a', 'right');
    }
  }
  ctx.fillStyle = '#2b5fe3'; rr(x + w / 2 - 70, y + h - 52, 140, 36, 6); ctx.fill();
  text('关闭', x + w / 2, y + h - 34, 18, '#fff', 'center', true);
  addClick(x + w / 2 - 70, y + h - 52, 140, 36, function () { ui.overlay = null; });
}

// FM 属性小标签：速/盘/传/射/防（门将显示扑救/制空/大脚），≥15 绿 ≥12 黄 ≥8 灰，否则红
function drawAttrChips(p, ax, ay) {
  var s = p.stats || {};
  function g(k) { var v = s[k]; return v == null ? 10 : v; }
  function avg(keys) { var t = 0; for (var i = 0; i < keys.length; i++) t += g(keys[i]); return Math.round(t / keys.length); }
  var chips = p.pos === 'GK'
    ? [['扑救', avg(['reflexes', 'handling', 'positioning', 'oneOnOne'])], ['制空', g('aerial')], ['大脚', g('kicking')]]
    : [['速', avg(['pace', 'acceleration'])], ['盘', avg(['dribbling', 'technique', 'agility'])],
       ['传', avg(['passing', 'vision', 'technique'])], ['射', avg(['finishing', 'longShots', 'composure'])],
       ['防', avg(['tackling', 'marking', 'positioning'])], ['体', g('stamina')]];
  var cx = ax;
  chips.forEach(function (c) {
    var col = c[1] >= 15 ? '#51d651' : c[1] >= 12 ? '#ffd94a' : c[1] >= 8 ? '#9fb4dd' : '#ff9a9a';
    text(c[0] + c[1], cx, ay, 13, col, 'left', true);
    cx += 52;
  });
}

function drawSettingsOverlay() {
  ctx.fillStyle = 'rgba(4,6,14,0.75)'; ctx.fillRect(0, 0, W, H);
  var x = 440, y = 200, w = 400, h = 320;
  panel(x, y, w, h);
  text('比赛设定', x + w / 2, y + 34, 24, '#fff', 'center', true);
  text('本场半场时长：' + (state ? Math.round(state.config.halfLength / 60) + ' 分钟' : '-'), x + 40, y + 90, 17, '#cfe0ff', 'left');
  text('下场半场时长：', x + 40, y + 130, 17, '#cfe0ff', 'left');
  HALF_OPTS.forEach(function (o, i) {
    var bx = x + 40 + i * 110, by = y + 150, bw = 100, bh = 36;
    var sel = ui.halfLength === o.value;
    ctx.fillStyle = sel ? '#2b5fe3' : '#1a2340';
    rr(bx, by, bw, bh, 5); ctx.fill();
    text(o.label, bx + bw / 2, by + bh / 2, 15, sel ? '#fff' : '#9fb4dd', 'center');
    (function (v) { addClick(bx, by, bw, bh, function () { ui.halfLength = v; }); })(o.value);
  });
  text('（半场时长在下场比赛生效）', x + 40, y + 210, 14, '#5f7099', 'left');
  text('战术倾向可在暂停菜单中随时切换', x + 40, y + 236, 14, '#5f7099', 'left');
  ctx.fillStyle = '#2b5fe3'; rr(x + w / 2 - 70, y + h - 52, 140, 36, 6); ctx.fill();
  text('关闭', x + w / 2, y + h - 34, 18, '#fff', 'center', true);
  addClick(x + w / 2 - 70, y + h - 52, 140, 36, function () { ui.overlay = null; });
}

function drawFulltime() {
  ctx.fillStyle = 'rgba(4,6,14,0.8)'; ctx.fillRect(0, 0, W, H);
  var x = 440, y = 190, w = 400, h = 340;
  panel(x, y, w, h, '#e8a923');
  text('全场比赛结束', x + w / 2, y + 44, 30, '#ffd94a', 'center', true);
  text('青鹰高校', x + w / 2 - 110, y + 110, 22, '#7fa8ff', 'center', true);
  text('烈风学院', x + w / 2 + 110, y + 110, 22, '#ff9a9a', 'center', true);
  text(state.score.home + '  -  ' + state.score.away, x + w / 2, y + 160, 54, '#fff', 'center', true);
  var res = state.score.home > state.score.away ? '🏆 胜利！' : state.score.home < state.score.away ? '失败…' : '平局';
  text(res, x + w / 2, y + 216, 26, '#fff', 'center', true);
  text('射门 ' + state.shots.home + ' - ' + state.shots.away, x + w / 2, y + 250, 16, '#9fb4dd', 'center');
  ctx.fillStyle = '#2b5fe3'; rr(x + w / 2 - 90, y + h - 64, 180, 44, 6); ctx.fill();
  text('返回标题', x + w / 2, y + h - 42, 19, '#fff', 'center', true);
  addClick(x + w / 2 - 90, y + h - 64, 180, 44, exitMatch);
}

function drawToast() {
  if (!ui.toast || Date.now() > ui.toastUntil) return;
  ctx.font = '17px "PingFang SC","Microsoft YaHei",monospace';
  var tw = ctx.measureText(ui.toast).width + 40;
  ctx.fillStyle = 'rgba(8,12,26,0.92)';
  rr(W / 2 - tw / 2, H - 40, tw, 32, 6); ctx.fill();
  ctx.strokeStyle = '#3d5a99'; ctx.lineWidth = 1.5; ctx.stroke();
  text(ui.toast, W / 2, H - 24, 17, '#ffd94a', 'center');
}

// ---------------- 主循环 ----------------
function frame(t) {
  frameNo++;
  clickables = [];
  ctx.clearRect(0, 0, W, H);
  if (screen === 'title') drawTitle();
  else {
    if (!state) {
      ctx.fillStyle = '#0b1020'; ctx.fillRect(0, 0, W, H);
      text('连接服务器中…', W / 2, H / 2, 24, '#9fb4dd', 'center');
    } else {
      drawGame(t);
    }
  }
  drawToast();
  if (DEBUG) { // 左上角诊断行：按键 / 菜单栈 / 异常
    var _dlt = hmTop();
    ctx.font = '14px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(8, 8, 460, 88);
    ctx.fillStyle = '#7dff9a';
    ctx.fillText(dbgKey || 'key=-', 14, 12);
    ctx.fillText('stack=' + (ui.hmenu ? ui.hmenu.stack.map(function (l) { return l.kind + '#' + l.sel; }).join('>') : 'null') + ' choosing=' + ui.choosing, 14, 32);
    ctx.fillStyle = dbgErr ? '#ff6b6b' : '#5a6584';
    ctx.fillText(dbgErr || 'err=-', 14, 52);
    // ★ 球诊断：逻辑位置/高度/渲染位置/相机，一眼定位"球去哪了"
    var _bb = (state && state.ball) || {}, _bp2 = null;
    try { _bp2 = project(ballR.x, ballR.y); } catch (e) { _bp2 = null; }
    ctx.fillStyle = '#ffd76a';
    ctx.fillText('ball=(' + (+(_bb.x || 0)).toFixed(1) + ',' + (+(_bb.y || 0)).toFixed(1) + ') z=' + (+(_bb.z || 0)).toFixed(2) +
      ' own=' + (_bb.ownerId || '-') + ' R=(' + ballR.x.toFixed(1) + ',' + ballR.y.toFixed(1) + ')' +
      (_bp2 ? ' scr=(' + _bp2.x.toFixed(0) + ',' + (_bp2.y - Math.min(+(_bb.z || 0), 5) * 30 * _bp2.s).toFixed(0) + ')' : ' scr=?'), 14, 72);
  }
  requestAnimationFrame(frame);
}

// ★ debug 自动开赛：?debug=1&autostart=1 时跳过标题界面直接开赛，
//   浏览器自动化测试不再依赖画布点击"开始比赛"按钮。
if (DEBUG && /[?&]autostart=1/.test(location.search)) {
  setTimeout(function () { if (screen === 'title') startMatch(); }, 600);
}

requestAnimationFrame(frame);
})();
