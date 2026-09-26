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
  if (e.key === 'Escape' && screen === 'game' && !ui.overlay) togglePause();
});
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
    if (!state.decision) ui.choosing = false;
    // 首次同步渲染位置
    state.players.forEach(function (p) {
      if (!renderPos[p.id]) renderPos[p.id] = { x: p.x, y: p.y };
    });
  }).catch(function () {});
}
function sendCommand(opt) {
  if (ui.choosing || !state || !state.decision) return;
  if (!opt.enabled) { toast('精神不足，无法使用该指令'); return; }
  ui.choosing = true;
  api.post('/api/match/' + matchId + '/command', { commandId: opt.id }).then(function (r) {
    if (!r.ok) { toast(r.error || '指令发送失败'); ui.choosing = false; }
  }).catch(function () { ui.choosing = false; });
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

  text('操作：在持球球员遇到防守时选择指令，服务器结算后播放动画', W / 2, 680, 16, '#5f7099', 'center');
}

// ---------------- 绘制：比赛 ----------------
function drawGame(t) {
  drawBackground();
  drawPitch();
  drawGoals();
  drawActors(t);
  drawScoreboard();
  drawPauseButton();
  if (ui.pauseOpen) drawPauseMenu();
  drawBottomUI(t);
  drawCutin();
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
    { label: '▶ 继续比赛', fn: function () { togglePause(false); } },
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
  // 指令菜单 + 详情
  if (state && state.decision) drawCommandMenu(304, y0, 300, 92, 612, y0, 330, 92);
  else drawIdleHint(304, y0, 636, 92);
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

  text('体力', x + 68, y + 42, 13, '#9fb4dd', 'left');
  bar(x + 108, y + 35, 110, 12, p.stamina / p.maxStamina, '#51d651');
  text(p.stamina + '/' + p.maxStamina, x + 224, y + 42, 12, '#cfe0ff', 'left');

  text('精神', x + 68, y + 62, 13, '#9fb4dd', 'left');
  bar(x + 108, y + 55, 110, 12, p.spirit / p.maxSpirit, '#a06ee8');
  text(p.spirit + '/' + p.maxSpirit, x + 224, y + 62, 12, '#cfe0ff', 'left');

  var skill = p.special ? '必杀技：' + p.special.name : '必杀技：无';
  text('Lv.' + p.level + '  ' + skill, x + 68, y + 80, 12, '#ffd94a', 'left');
}

var CMD_ICONS = { dribble: '💨', pass: '➡️', shoot: '⚽', special: '🔥', feint: '🌀', retreat: '↩️' };

function drawCommandMenu(x, y, w, h, dx, dy, dw, dh) {
  var d = state.decision;
  panel(x, y, w, h, '#2b5fe3');
  var rh = (h - 8) / 6;
  d.options.forEach(function (o, i) {
    var oy = y + 4 + i * rh;
    var en = o.enabled && !ui.choosing;
    ctx.fillStyle = !o.enabled ? '#10142a' : (ui.choosing ? '#1a2340' : (i % 2 ? '#16204a' : '#1a2450'));
    ctx.fillRect(x + 4, oy, w - 8, rh - 2);
    var col = o.enabled ? '#fff' : '#5a6584';
    text((CMD_ICONS[o.id] || '•') + ' ' + o.name, x + 12, oy + rh / 2 - 1, 12.5, col, 'left', o.id === 'special');
    text(o.cost + '', x + w - 14, oy + rh / 2 - 1, 12.5, o.enabled ? '#ffd94a' : '#5a6584', 'right', true);
    if (o.enabled) {
      (function (opt) { addClick(x + 4, oy, w - 8, rh - 2, function () { sendCommand(opt); }); })(o);
    }
  });
  // 详情面板
  panel(dx, dy, dw, dh, '#2b5fe3');
  var sel = d.options[0];
  text(sel.name, dx + 16, dy + 22, 20, '#fff', 'left', true);
  wrapText(sel.desc, dx + 16, dy + 44, dw - 32, 13, '#cfe0ff', 2);
  text('成功率', dx + 16, dy + dh - 34, 15, '#9fb4dd', 'left');
  text(sel.rate + '%', dx + 110, dy + dh - 32, 30, '#7fd0ff', 'left', true);
  text('消耗精神', dx + 200, dy + dh - 34, 15, '#9fb4dd', 'left');
  text(sel.cost + '', dx + 290, dy + dh - 32, 30, '#ffd94a', 'left', true);
  if (ui.choosing) text('判定中…', dx + dw / 2, dy + dh / 2, 16, '#ffd94a', 'center');
}

function drawIdleHint(x, y, w, h) {
  panel(x, y, w, h);
  var msg = '比赛中… 持球球员接近防守时将弹出指令菜单';
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
    (function (idx) { addClick(ix, y + 4, iw - 6, h - 8, function () { selectedHomeIdx = idx; }); })(i);
  }
}

// ---------------- 事件横幅 / 指令演出 ----------------
function drawCutin() {
  if (!state || !state.lastAction) return;
  var a = state.lastAction;
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

// ---------------- 覆盖层 ----------------
function drawStatusOverlay() {
  ctx.fillStyle = 'rgba(4,6,14,0.75)'; ctx.fillRect(0, 0, W, H);
  var x = 340, y = 110, w = 600, h = 500;
  panel(x, y, w, h);
  text('球员状态 - 青鹰高校', x + w / 2, y + 32, 24, '#fff', 'center', true);
  text('号码  姓名        位置  Lv   体力      精神      必杀技', x + 30, y + 66, 15, '#9fb4dd', 'left');
  if (state) {
    for (var i = 0; i < 11; i++) {
      var p = homePlayer(i);
      var py = y + 92 + i * 36;
      text(p.num + '', x + 34, py, 15, '#fff', 'left', true);
      text(p.name, x + 80, py, 15, '#fff', 'left');
      text(p.pos, x + 200, py, 15, '#9fb4dd', 'left');
      text('' + p.level, x + 250, py, 15, '#ffd94a', 'left');
      bar(x + 290, py - 7, 80, 12, p.stamina / p.maxStamina, '#51d651');
      bar(x + 385, py - 7, 60, 12, p.spirit / p.maxSpirit, '#a06ee8');
      text(p.special ? p.special.name : '-', x + 460, py, 14, '#ffd94a', 'left');
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
