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
var api = window.__makeLocalApi();

// ---------------- 全局状态 ----------------
var screen = 'title';       // title | game
var matchId = null;
var state = null;           // 服务器状态快照
var renderPos = {};         // id -> {x,y} 插值渲染位置（让 300ms 轮询看起来平滑）
var ballR = { x: 52.5, y: 34 };
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

// ---------------- 直接操控输入 ----------------
// 桌面端：WASD 方向 / J 加速 / K 减速 / L或Tab 切换球员 / 空格 暂停菜单
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
function project(x, y) {
  var viewW = 66;
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
      c.action();
      return;
    }
  }
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && screen === 'game') {
    if (ui.passFlow) { passFlowBack(); return; } // 传球向导内：Esc = 返回上一步
    if (!ui.overlay) togglePause();
  }
  if (screen !== 'game') return;
  var k = (e.key || '').toLowerCase();
  if ([' ', 'tab', 'w', 'a', 's', 'd', 'j', 'k', 'l'].indexOf(k) >= 0) e.preventDefault();
  if (e.repeat) return;
  if (k === ' ') { togglePause(); return; }
  if (k === 'l' || k === 'tab') {
    sendInput({ switchPlayer: true });
    toast('切换操控球员');
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
  setPad(dx, dy, !!keys['j'], !!keys['k']);
}

// ---- 触屏虚拟手柄 ----

// ★ 传球力量条拖拽（桌面端鼠标；在向导第 5 步时力量条可拖动）
var passBarDrag = false;
function passBarSet(mx) {
  var f = ui.passFlow, r = ui.passBarRect;
  if (!f || f.step !== 5 || !r) return;
  var p = Math.round((mx - r.x) / r.w * 100);
  p = Math.max(5, Math.min(100, p));
  if (p !== f.power) { f.power = p; requestPassPreview(); }
}
cv.addEventListener('mousedown', function (e) {
  if (!ui.passFlow || ui.passFlow.step !== 5 || !ui.passBarRect) return;
  var r = ui.passBarRect, rect = cv.getBoundingClientRect();
  var mx = (e.clientX - rect.left) * (W / rect.width);
  var my = (e.clientY - rect.top) * (H / rect.height);
  if (mx >= r.x - 12 && mx <= r.x + r.w + 12 && my >= r.y - 18 && my <= r.y + r.h + 18) {
    passBarDrag = true;
    passBarSet(mx);
  }
});
cv.addEventListener('mousemove', function (e) {
  if (!passBarDrag) return;
  var rect = cv.getBoundingClientRect();
  passBarSet((e.clientX - rect.left) * (W / rect.width));
});
document.addEventListener('mouseup', function () { passBarDrag = false; });

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
cv.addEventListener('touchstart', function (e) {
  if (!isTouch || screen !== 'game') return;
  if (ui.pauseOpen || ui.overlay || ui.passFlow) return; // 菜单/覆盖层/传球向导打开时手柄让路，保证菜单可点
  var used = false;
  for (var i = 0; i < e.changedTouches.length; i++) {
    var t = e.changedTouches[i], p = touchPos(t), tid = t.identifier;
    var b = hitBtn(p);
    if (b) { btnTouchIds[tid] = b.id; pressBtn(b.id); used = true; }
    else if (padTouchId === null && Math.hypot(p.x - DPAD.x, p.y - DPAD.y) <= DPAD.r + 30) {
      padTouchId = tid; moveDpad(p); used = true;
    }
  }
  if (used) e.preventDefault();
}, { passive: false });
cv.addEventListener('touchmove', function (e) {
  if (padTouchId === null) return;
  for (var i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === padTouchId) {
      moveDpad(touchPos(e.changedTouches[i]));
      e.preventDefault();
    }
  }
}, { passive: false });
function touchEnd(e) {
  for (var i = 0; i < e.changedTouches.length; i++) {
    var tid = e.changedTouches[i].identifier;
    if (tid === padTouchId) { padTouchId = null; setPad(0, 0, pad.sprint, pad.slow); }
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
    selectedHomeIdx = 9;
    pad.dx = 0; pad.dy = 0; pad.sprint = false; pad.slow = false;
    padTouchId = null; btnTouchIds = {};
    for (var k in keys) keys[k] = false;
    ui.pauseOpen = false; ui.overlay = null; ui.choosing = false; ui.exitArm = 0;
    refresh();
    setInterval(refresh, 300);
  });
}
function refresh() {
  if (screen !== 'game' || !matchId) return;
  api.get('/api/match/' + matchId + '/state').then(function (r) {
    if (!r.ok) return;
    state = r.state;
    var hasDec = !!(state && state.decision);
    if (hasDec && !ui._hadDecision) ui.choosing = false; // 新决策到达：清掉旧标记
    if (!hasDec) ui.choosing = false;
    // 决策变化（新球员/决策结束）时关闭传球向导
    var decKey = hasDec ? state.decision.playerId : null;
    if (decKey !== ui._passDecisionKey) { ui.passFlow = null; ui._passDecisionKey = decKey; }
    ui._hadDecision = hasDec;
    // 首次同步渲染位置
    state.players.forEach(function (p) {
      if (!renderPos[p.id]) renderPos[p.id] = { x: p.x, y: p.y };
    });
    // 输入心跳：保持操控输入新鲜（服务器 2 秒无有效操作则 AI 接管）
    sendInput();
  }).catch(function () {});
}
function sendCommand(opt, params) {
  if (ui.choosing || !state || !state.decision) return;
  if (!opt.enabled) { toast('体能不足，无法使用该指令'); return; }
  ui.choosing = true;
  ui.passFlow = null; // 指令已发出，关闭传球向导
  var body = { commandId: opt.id };
  if (params) body.params = params;
  api.post('/api/match/' + matchId + '/command', body).then(function (r) {
    if (!r.ok) { toast(r.error || '指令发送失败'); ui.choosing = false; }
  }).catch(function () { ui.choosing = false; });
}
// ---------------- 传球多阶段向导 ----------------
// 流程：1 长/短传 → 2 方向（8向） → 3 脚法 → 4 高度 → 5 力量+预估落点 → 确认。
// 落点/散布全部由服务器计算（/pass-preview），客户端只提交选择意图。
var PASS_DIR_NAMES = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
var PASS_DIR_GRID = [3, 2, 1, 4, -1, 0, 5, 6, 7]; // 3x3 罗盘布局，-1 为中心空位
var PASS_HEIGHTS = [
  { id: 'low', name: '低', desc: '贴地快 · 易被断' },
  { id: 'mid', name: '中', desc: '标准弧线' },
  { id: 'high', name: '高', desc: '越过防守' },
  { id: 'vhigh', name: '超高', desc: '很飘 · 难控制' },
];

function startPassFlow(opt) {
  ui.passFlow = { step: 1, kind: 'short', dir: 0, technique: 'inside', height: 'mid', power: 50, preview: null, opt: opt, previewAt: 0 };
  requestPassPreview();
}
function passFlowParams() {
  var f = ui.passFlow;
  return { kind: f.kind, dir: f.dir, technique: f.technique, height: f.height, power: f.power };
}
function requestPassPreview() {
  var f = ui.passFlow;
  if (!f || !matchId) return;
  var now = Date.now();
  if (now - f.previewAt < 250) return; // 节流
  f.previewAt = now;
  api.post('/api/match/' + matchId + '/pass-preview', { params: passFlowParams() }).then(function (r) {
    if (r.ok && ui.passFlow) {
      ui.passFlow.preview = r.preview;
      // 服务器会按球员能力钳制脚法（如外脚背被锁），同步回来
      var p = r.preview.params || {};
      if (p.technique) ui.passFlow.technique = p.technique;
    }
  });
}
function passFlowBack() {
  var f = ui.passFlow;
  if (!f) return;
  if (f.step > 1) { f.step--; requestPassPreview(); }
  else ui.passFlow = null;
}

function drawPassWizard(d) {
  var f = ui.passFlow;
  var pw = 368, ph = 560, px = W - pw - 16, py = 84;
  panel(px, py, pw, ph);
  var carrier = null;
  for (var i = 0; i < state.players.length; i++) {
    if (state.players[i].id === d.playerId) { carrier = state.players[i]; break; }
  }
  text('➡️ 传球', px + 24, py + 34, 26, '#fff', 'left', true);
  text((carrier ? carrier.num + ' ' + carrier.name : d.playerName) + ' 持球', px + 24, py + 62, 15, '#ffd94a', 'left');
  var steps = ['长短', '方向', '脚法', '高度', '力量'];
  text(steps.map(function (s, i) { return (i + 1 === f.step ? '●' : '○') + s; }).join('  '), px + pw / 2, py + 92, 14, '#8fa3c8', 'center');

  var bx = px + 24, bw = pw - 48;
  function row(y, h, label, action, color, disabled) {
    drawButton(bx, y, bw, h, label, action, color || '#12325e', 20, disabled);
  }

  if (f.step === 1) {
    text('选择传球距离', px + pw / 2, py + 130, 18, '#cfe0ff', 'center');
    row(py + 152, 76, '⚡ 短传（6~28 米）', function () { f.kind = 'short'; f.step = 2; requestPassPreview(); });
    row(py + 240, 76, '🚀 长传（12~60 米）', function () { f.kind = 'long'; f.step = 2; requestPassPreview(); });
    text('长传更远但落点更飘', px + pw / 2, py + 350, 14, '#8fa3c8', 'center');
  } else if (f.step === 2) {
    text('选择传球方向', px + pw / 2, py + 130, 18, '#cfe0ff', 'center');
    var gs = 84, gap = 10, gx = px + (pw - (gs * 3 + gap * 2)) / 2, gy = py + 152;
    PASS_DIR_GRID.forEach(function (dirIdx, cell) {
      var cx = gx + (cell % 3) * (gs + gap), cy = gy + Math.floor(cell / 3) * (gs + gap);
      if (dirIdx < 0) return;
      (function (dd) {
        drawButton(cx, cy, gs, gs, PASS_DIR_NAMES[dd], function () { f.dir = dd; f.step = 3; requestPassPreview(); }, '#12325e', 30);
      })(dirIdx);
    });
    text('→ 为对方球门方向', px + pw / 2, gy + gs * 3 + gap * 2 + 30, 14, '#8fa3c8', 'center');
  } else if (f.step === 3) {
    text('选择击球部位', px + pw / 2, py + 130, 18, '#cfe0ff', 'center');
    var techs = (f.opt.passOpts && f.opt.passOpts.techniques) || [];
    var ty = py + 152;
    techs.forEach(function (t) {
      var sub = t.enabled ? t.desc : '🔒 ' + t.reason;
      if (t.enabled) {
        row(ty, 64, t.name, (function (id) { return function () { f.technique = id; f.step = 4; requestPassPreview(); }; })(t.id));
      } else {
        row(ty, 64, t.name + '（未解锁）', function () {}, '#1a2030', true);
      }
      text(sub, px + pw / 2, ty + 52, 13, t.enabled ? '#9fc0ff' : '#5a6584', 'center');
      ty += 84;
    });
    text('脚法按 technique 能力解锁', px + pw / 2, ty + 16, 14, '#8fa3c8', 'center');
  } else if (f.step === 4) {
    text('选择传球高度', px + pw / 2, py + 130, 18, '#cfe0ff', 'center');
    var hy = py + 152;
    PASS_HEIGHTS.forEach(function (h) {
      row(hy, 60, h.name + '球', (function (id) { return function () { f.height = id; f.step = 5; requestPassPreview(); }; })(h.id));
      text(h.desc, px + pw / 2, hy + 48, 13, '#9fc0ff', 'center');
      hy += 78;
    });
  } else if (f.step === 5) {
    text('拖动力量条 · 场上黄圈为预估落点', px + pw / 2, py + 130, 17, '#cfe0ff', 'center');
    var barX = bx, barY = py + 160, barW = bw - 96, barH = 26;
    // 轨道
    ctx.fillStyle = '#0a0d18';
    ctx.fillRect(barX, barY, barW, barH);
    var fillW = barW * (f.power - 5) / 95;
    var grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    grad.addColorStop(0, '#2f9e5b'); grad.addColorStop(0.6, '#ffd94a'); grad.addColorStop(1, '#e05252');
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, fillW, barH);
    ctx.strokeStyle = '#3a4a6e'; ctx.lineWidth = 2;
    ctx.strokeRect(barX, barY, barW, barH);
    // 旋钮
    var kx = barX + fillW;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(kx, barY + barH / 2, 13, 0, Math.PI * 2); ctx.fill();
    ui.passBarRect = { x: barX, y: barY, w: barW, h: barH };
    addClick(barX - 8, barY - 14, barW + 16, barH + 28, function () {});
    text(f.power + '%', barX + barW + 48, barY + barH / 2, 24, '#ffd94a', 'center', true);
    drawButton(bx, barY + 52, 44, 44, '−', function () { f.power = Math.max(5, f.power - 5); requestPassPreview(); }, '#1d3fa0', 24);
    drawButton(bx + bw - 44, barY + 52, 44, 44, '+', function () { f.power = Math.min(100, f.power + 5); requestPassPreview(); }, '#1d3fa0', 24);
    // 预估落点信息
    var pv = f.preview;
    if (pv) {
      text('预估落点 ±' + pv.r.toFixed(1) + ' 米', px + pw / 2, barY + 130, 17, '#ffd94a', 'center');
      text('落点精度取决于传球能力', px + pw / 2, barY + 156, 13, '#8fa3c8', 'center');
    } else {
      text('正在计算落点…', px + pw / 2, barY + 130, 16, '#8fa3c8', 'center');
    }
    drawButton(bx, py + ph - 150, bw, 64, '✅ 确认传球', function () { sendCommand(f.opt, passFlowParams()); }, '#1f7a3d', 22);
  }

  // 底部：返回 / 取消
  drawButton(bx, py + ph - 70, bw, 52, f.step === 1 ? '✕ 取消' : '← 返回上一步', function () { passFlowBack(); }, '#2a3350', 18);
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

  text('电脑：WASD 移动 · J加速 K减速 · L切换球员 · 空格暂停', W / 2, 672, 16, '#5f7099', 'center');
  text('手机 / Pad：左虚拟方向盘移动 · 右侧按键加速/减速/切换/菜单', W / 2, 696, 16, '#5f7099', 'center');
}

// ---------------- 绘制：比赛 ----------------
function drawGame(t) {
  drawBackground();
  drawPitch();
  drawGoals();
  drawActors(t);
  drawScoreboard();
  drawPauseButton();
  if (isTouch) drawGamepad(); // 移动端/Pad：透明虚拟手柄（画在菜单下层）
  if (ui.pauseOpen) drawPauseMenu();
  drawBottomUI(t);
  drawCutin();
  // ★ 被动决策：直接中央弹窗 + 比赛暂停（模拟在 decision 阶段本就停止）
  if (state && state.decision && !ui.pauseOpen && !ui.overlay) drawDecisionModal(t);
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
  // 插值更新渲染位置
  state.players.forEach(function (p) {
    var rp = renderPos[p.id];
    if (!rp) { renderPos[p.id] = { x: p.x, y: p.y }; return; }
    rp.x += (p.x - rp.x) * 0.22;
    rp.y += (p.y - rp.y) * 0.22;
  });
  ballR.x += (state.ball.x - ballR.x) * 0.3;
  ballR.y += (state.ball.y - ballR.y) * 0.3;

  var order = state.players.slice().sort(function (a, b) {
    return renderPos[b.id].y - renderPos[a.id].y; // 远的先画
  });
  var animFrame = Math.floor(t / 280) % 2;
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
    // 被玩家直接操控标记（绿圈）
    if (state.controlledId && p.id === state.controlledId) {
      ctx.strokeStyle = '#51ff9a'; ctx.lineWidth = 3;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.ellipse(pr.x, pr.y + 2, 22 * s, 9 * s, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    var frames = framesFor(p);
    var img = frames[animFrame];
    var dw = 16 * s * 1.9, dh = 24 * s * 1.9;
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
    // 冻结标记
    if (p.frozen) text('💫', pr.x, pr.y - dh - 8, 14 * s, '#fff', 'center');
  });

  // 球
  var bp = project(ballR.x, ballR.y);
  var bs = 8 * bp.s * 1.6;
  ctx.drawImage(ballImg, bp.x - bs / 2, bp.y - bs - 2, bs, bs);

  // ★ 传球预估落点（向导第 2 步起，在球场上画黄圈 + 持球者到落点的虚线）
  var pf = ui.passFlow;
  if (pf && pf.preview && pf.step >= 2 && state && state.decision) {
    var pv = pf.preview;
    var lp = project(pv.x, pv.y);
    var prad = Math.max(10, pv.r * 19 * lp.s);
    ctx.save();
    ctx.fillStyle = 'rgba(255,217,74,0.16)';
    ctx.beginPath(); ctx.arc(lp.x, lp.y, prad, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffd94a'; ctx.lineWidth = 3; ctx.setLineDash([10, 6]);
    ctx.beginPath(); ctx.arc(lp.x, lp.y, prad, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    var cpv = null;
    state.players.forEach(function (pl) { if (pl.id === state.decision.playerId) cpv = pl; });
    if (cpv) {
      var spp = project(cpv.x, cpv.y);
      ctx.strokeStyle = 'rgba(255,217,74,0.55)'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.moveTo(spp.x, spp.y - 10); ctx.lineTo(lp.x, lp.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
    text('预估落点', lp.x, lp.y - prad - 12, 15, '#ffd94a', 'center', true);
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
        if (state && state.decision) toast('请先在下方指令菜单选择行动');
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
  // 指令决策中 -> 决策球员；否则阵容条选中球员
  if (state && state.decision) {
    var dp = null;
    state.players.forEach(function (p) { if (p.id === state.decision.playerId) dp = p; });
    if (dp) return dp;
  }
  return homePlayer(selectedHomeIdx);
}

function drawBottomUI(t) {
  var y0 = 556;
  // 球员卡
  drawPlayerCard(8, y0, 288, 92);
  // 指令区：被动决策改为中央弹窗（drawDecisionModal），底部只保留待机提示
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

var CMD_ICONS = { dribble: '💨', pass: '➡️', shoot: '⚽', special: '🔥', feint: '🌀', retreat: '↩️' };

// ★ 被动决策：直接中央弹窗 + 比赛暂停（点选即执行）
function drawDecisionModal(t) {
  var d = state.decision;
  if (ui.passFlow) { drawPassWizard(d); return; } // 传球多阶段向导（右侧面板，球场保持可见以显示预估落点）
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(0, 0, W, H);
  var pw = 660, ph = 540, px = (W - pw) / 2, py = (H - ph) / 2;
  panel(px, py, pw, ph);
  var carrier = null;
  for (var i = 0; i < state.players.length; i++) {
    if (state.players[i].id === d.playerId) { carrier = state.players[i]; break; }
  }
  text('⏸ 请选择指令', px + 30, py + 46, 27, '#fff', 'left', true);
  text((carrier ? carrier.num + ' ' + carrier.name : d.playerName) + ' 持球 · 比赛已暂停', px + 30, py + 78, 16, '#ffd94a', 'left');
  if (ui.choosing) {
    text('判定中…', px + pw / 2, py + ph / 2 + 20, 22, '#ffd94a', 'center');
    return;
  }
  var cols = 2, bw = 280, bh = 92, gapX = 28, gapY = 18;
  var sx = px + (pw - (bw * cols + gapX * (cols - 1))) / 2, sy = py + 112;
  d.options.forEach(function (o, idx) {
    var cx = sx + (idx % cols) * (bw + gapX), cy = sy + Math.floor(idx / cols) * (bh + gapY);
    var label = (CMD_ICONS[o.id] || '•') + ' ' + o.name;
    var sub = o.rate + '% · ' + o.cost + '体能';
    if (o.enabled) {
      if (o.id === 'pass') drawButton(cx, cy, bw, bh, label, function () { startPassFlow(o); }, '#12325e', 22);
      else drawButton(cx, cy, bw, bh, label, function () { sendCommand(o); }, '#12325e', 22);
      text(sub, cx + bw / 2, cy + bh - 16, 14, '#9fc0ff', 'center');
    } else {
      drawButton(cx, cy, bw, bh, label, function () {}, '#1a2030', 22, true);
      text(sub, cx + bw / 2, cy + bh - 16, 14, '#5a6584', 'center');
    }
  });
  text('点选即执行', px + pw / 2, py + ph - 24, 14, '#8fa3c8', 'center');
}

function drawIdleHint(x, y, w, h) {
  panel(x, y, w, h);
  var msg = isTouch ? '拖左盘移动（绿圈球员）；持球遇防守时在下方选指令'
                    : 'WASD 移动（绿圈球员）；持球遇防守时在下方选指令';
  if (state) {
    if (state.phase === 'kickoff') msg = '开球！';
    else if (state.phase === 'goal') msg = '⚽ 进球！';
    else if (state.phase === 'halftime') msg = '中场休息…';
    else if (state.paused) msg = '已暂停';
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
    text(b.label, b.x, b.y + 1, 20, 'rgba(255,255,255,0.75)', 'center', true);
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
  var x = 340, y = 110, w = 600, h = 500;
  panel(x, y, w, h);
  text('球员状态 - 青鹰高校', x + w / 2, y + 32, 24, '#fff', 'center', true);
  text('号码  姓名        位置  Lv   体能          必杀技', x + 30, y + 66, 15, '#9fb4dd', 'left');
  if (state) {
    for (var i = 0; i < 11; i++) {
      var p = homePlayer(i);
      var py = y + 92 + i * 36;
      text(p.num + '', x + 34, py, 15, '#fff', 'left', true);
      text(p.name, x + 80, py, 15, '#fff', 'left');
      text(p.pos, x + 200, py, 15, '#9fb4dd', 'left');
      text('' + p.level, x + 250, py, 15, '#ffd94a', 'left');
      bar(x + 290, py - 7, 130, 12, p.stamina / p.maxStamina, '#51d651');
      text(p.special ? p.special.name : '-', x + 440, py, 14, '#ffd94a', 'left');
    }
  }
  ctx.fillStyle = '#2b5fe3'; rr(x + w / 2 - 70, y + h - 52, 140, 36, 6); ctx.fill();
  text('关闭', x + w / 2, y + h - 34, 18, '#fff', 'center', true);
  addClick(x + w / 2 - 70, y + h - 52, 140, 36, function () { ui.overlay = null; });
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
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
})();
