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
var menuBg = new Image();
menuBg.src = 'assets/menu/menu-bg.webp';
menuBg.onerror = function () { menuBg.onerror = null; menuBg.src = 'assets/menu/menu-bg.jpg'; };

// ---------------- 工具 ----------------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function $(id) { return document.getElementById(id); }

// ---------------- 序列帧精灵（sprite-gen 管线产出，真像素风，非代码拼图） ----------------
// ★ 2026-10-12 8 方向：run-8dir-v3-with-ball / without-ball
//   8 行（方向）× 8 列（跑动帧），48×72/帧，整表 384×576
//   方向顺序：0=up, 1=upright, 2=right, 3=downright, 4=down, 5=downleft, 6=left, 7=upleft
//   带球不再按颜色从 with-ball 图里抠球，也不再使用那张图。抠近白色会误伤角色。
//   身体一律用 without-ball（眼睛是不透明的黑像素），球由代码画在脚前。只量脚底锚点，不改任何像素。
var SPR_V = 'spr6';
var runPack = { anchors: null, data: null, w: 0, h: 0, ready: false };
var kitCache = {}; // 球衣+肤色 → 画好的整表
var SPR_CW = 48, SPR_CH = 72, SPR_COLS = 8, SPR_ROWS = 8;

// 只量每帧脚底锚点。不按颜色删像素。
function prepareRunSheet(id) {
  var d = id.data, w = id.width;
  var anchors = new Array(SPR_ROWS * SPR_COLS);
  function at(x, y) { return (y * w + x) * 4; }
  for (var row = 0; row < SPR_ROWS; row++) {
    for (var col = 0; col < SPR_COLS; col++) {
      var ox = col * SPR_CW, oy = row * SPR_CH;
      var maxFoot = -1, sumX = 0, nFoot = 0;
      for (var fy = 0; fy < SPR_CH; fy++) {
        for (var fx = 0; fx < SPR_CW; fx++) {
          var fi = at(ox + fx, oy + fy);
          if (d[fi + 3] > 40 && fy > maxFoot) maxFoot = fy;
        }
      }
      if (maxFoot < 0) { anchors[row * SPR_COLS + col] = { x: 24, y: 71 }; continue; }
      var y0 = Math.max(0, maxFoot - 2);
      for (var gy = y0; gy <= maxFoot; gy++) {
        for (var gx = 0; gx < SPR_CW; gx++) {
          var gi = at(ox + gx, oy + gy);
          if (d[gi + 3] > 40) { sumX += gx; nFoot++; }
        }
      }
      anchors[row * SPR_COLS + col] = { x: nFoot ? sumX / nFoot : 24, y: maxFoot };
    }
  }
  return anchors;
}
// 同一张无球图按球衣和肤色现画。先标球鞋占位符，再换球衣图案，最后换皮肤。
function paintRunSheet(skinId, kitSpec) {
  var copy = new ImageData(new Uint8ClampedArray(runPack.data.data), runPack.w, runPack.h);
  if (typeof SharedKits !== 'undefined') {
    SharedKits.recolorImageData(copy, { home: kitSpec }, 32, {
      cellW: SPR_CW, cellH: SPR_CH, pattern: kitSpec.pattern,
      mask: runPack.mask, centers: runPack.centers,
    });
    if (SharedKits.recolorSkin) SharedKits.recolorSkin(copy, skinId);
  }
  var c2 = document.createElement('canvas');
  c2.width = runPack.w; c2.height = runPack.h;
  c2.getContext('2d').putImageData(copy, 0, 0);
  return c2;
}
function kitSpecFor(p) {
  if (typeof SharedKits === 'undefined') return null;
  if (!p || p.team === 'ref' || p.pos === 'REF') return SharedKits.resolveKit('ref');
  if (p.pos === 'GK') return SharedKits.resolveKit(p.team === 'away' ? 'gkAway' : 'gkHome');
  return SharedKits.resolveKit(p.team, null);
}
function sheetForPlayer(p) {
  if (!runPack.ready || typeof SharedKits === 'undefined') return null;
  var skinId = (p.skin && SharedKits.SKIN_PRESETS && SharedKits.SKIN_PRESETS[p.skin]) ? p.skin : 'fair';
  var spec = kitSpecFor(p);
  var key = [p.team, skinId, spec.pattern, spec.primary, spec.secondary, spec.shorts, spec.socks, spec.shoes].join('|');
  if (!kitCache[key]) kitCache[key] = paintRunSheet(skinId, spec);
  return kitCache[key];
}
function loadRunSource(url) {
  var im = new Image();
  im.onload = function () {
    if (runPack.ready) return;
    try {
      var cv = document.createElement('canvas');
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      var cx = cv.getContext('2d');
      cx.drawImage(im, 0, 0);
      var id = cx.getImageData(0, 0, cv.width, cv.height);
      runPack.anchors = prepareRunSheet(id);
      if (typeof SharedKits !== 'undefined' && SharedKits.markShoePlaceholders) {
        SharedKits.markShoePlaceholders(id, SPR_CW, SPR_CH);
      }
      if (typeof SharedKits !== 'undefined' && SharedKits.classifyPlaceholders) {
        runPack.mask = SharedKits.classifyPlaceholders(id, 32);
        runPack.centers = SharedKits.sheetCenters(runPack.mask, id.width, id.height, SPR_CW, SPR_CH);
      }
      runPack.data = id;
      runPack.w = id.width; runPack.h = id.height;
      runPack.ready = true;
    } catch (e) {}
  };
  im.src = url;
  if (im.complete && im.naturalWidth) im.onload();
}
loadRunSource('assets/sprites/home/run-8dir-v3-without-ball.png?v=' + SPR_V);
function paintSkinVariants(id) {
  var skins = {};
  var ids = (typeof SharedKits !== 'undefined' && SharedKits.SKIN_PRESETS)
    ? Object.keys(SharedKits.SKIN_PRESETS) : ['fair'];
  ids.forEach(function (sid) {
    var copy = new ImageData(new Uint8ClampedArray(id.data), id.width, id.height);
    if (typeof SharedKits !== 'undefined' && SharedKits.recolorSkin) SharedKits.recolorSkin(copy, sid);
    var c2 = document.createElement('canvas');
    c2.width = id.width; c2.height = id.height;
    c2.getContext('2d').putImageData(copy, 0, 0);
    skins[sid] = c2;
  });
  return skins;
}
// 旧表保留给门将。球衣已经是成品色，只换肤。
var spriteAtlas = {};
['home', 'away', 'gk_home', 'gk_away'].forEach(function (kit) {
  var im = new Image();
  im._skins = {};
  im.onload = function () {
    if (im._skinReady) return;
    try {
      var cv = document.createElement('canvas');
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      var cx = cv.getContext('2d');
      cx.drawImage(im, 0, 0);
      var id = cx.getImageData(0, 0, cv.width, cv.height);
      im._skins = paintSkinVariants(id);
      im._skinReady = true;
    } catch (e) {}
  };
  im.src = 'assets/sprites/' + kit + '/sprite-sheet-alpha.png?v=spr5';
  if (im.complete && im.naturalWidth) im.onload();
  spriteAtlas[kit] = im;
});
var animClock = {}; // playerId -> {x,y,lt,ph} 上一帧渲染位置/帧时间戳/累进相位（跑/站判定用）

// 八向的单位向量（世界坐标，+y 朝屏幕上方）。球只跟这个离散朝向走，不跟每帧速度抖动。
var DIR_UNIT = [
  { x: 0, y: 1 },
  { x: 0.7071, y: 0.7071 },
  { x: 1, y: 0 },
  { x: 0.7071, y: -0.7071 },
  { x: 0, y: -1 },
  { x: -0.7071, y: -0.7071 },
  { x: -1, y: 0 },
  { x: -0.7071, y: 0.7071 }
];
// ★ 8 方向判定：按移动向量角度选行（0=up 顺时针，屏幕空间）
// 场地 +y 朝屏幕上方（见 updatePadFromKeys），不是画布的 +y 向下。
// 之前用 atan2(dy, dx) 把“往上跑”判成 down 行，人物脸朝镜头倒着跑。
function dirRowFor(dx, dy) {
  if (!dx && !dy) return -1;
  var ang = Math.atan2(-dy, dx); // 屏幕 y 向下，故取反世界 dy。0=右，-PI/2=上
  var t = (ang + Math.PI / 2) / (Math.PI * 2); // 0=up, 0.25=right, 0.5=down, 0.75=left
  if (t < 0) t += 1;
  if (t >= 1) t -= 1;
  var idx = Math.round(t * 8) % 8;
  return idx; // 0=up,1=upright,2=right,3=downright,4=down,5=downleft,6=left,7=upleft
}
// 连续朝向角 0~1（0=上），给方向迟滞用，避免贴着扇区边界来回翻
function heading01(dx, dy) {
  var ang = Math.atan2(-dy, dx);
  var t = (ang + Math.PI / 2) / (Math.PI * 2);
  if (t < 0) t += 1;
  if (t >= 1) t -= 1;
  return t;
}
// ★ 跑动周期：序列帧行选择 + 带球触球共用同一相位，保证"球—脚"同步
// ★ dt 归一化（2026-10-06）：位移按米/秒算帧率与跑/站判定，30/60/120/144Hz 同一速度同一节奏；
//   fps=6+min(10,v/2) 在 60Hz 下与旧公式 6+min(10,moved*30) 数学恒等（node 实测 1000 随机速度全等），手感不变；
//   相位改累进式（每帧推进 fps*dt），加减速不再跳帧。返回的 dx/dy 仍为本帧位移（带球触球只取方向）。
function runCycleFor(p, t) {
  var rp = renderPos[p.id] || p;
  var st = animClock[p.id] || (animClock[p.id] = { x: rp.x, y: rp.y, lt: t, ph: 0, svx: 0, svy: 0 });
  var dx = rp.x - st.x, dy = rp.y - st.y;
  var dt = (t - st.lt) / 1000;
  if (!(dt > 0)) dt = 0.001;   // 首帧/时间戳异常兜底
  else if (dt > 0.1) dt = 0.1; // 切后台回来钳到 100ms，避免相位乱跳
  var v = (Math.abs(dx) + Math.abs(dy)) / dt; // 米/秒，刷新率无关
  // ★ 平滑速度（指数滑动平均，约120ms时间常数）：方向判定用平滑值，
  //   过滤快照插值在新旧快照交接时的瞬间反向抖动，避免精灵来回翻转（"回退"感）
  var k = Math.min(1, dt / 0.12);
  st.svx += (dx / dt - st.svx) * k;
  st.svy += (dy / dt - st.svy) * k;
  st.x = rp.x; st.y = rp.y; st.lt = t;
  var moving = v > 1.2;          // 原 0.02 米/帧在 60Hz 下 = 1.2 米/秒，现固定
  var fps = 6 + Math.min(10, v / 2);
  // ★ v3 8 帧：外场球员 8 帧（主/客队各按自家颜色换色），门将沿用旧表
  var nF = 8;
  // 停步时冻住相位，保持落地的那一帧。若立刻切回第 0 帧，姿势会跳一下。
  if (moving) st.ph = (st.ph + fps * dt) % nF;
  return { moving: moving, fps: fps, phase: st.ph / nF, dx: dx, dy: dy, svx: st.svx, svy: st.svy, nFrames: nF, dt: dt };
}
function spriteFrameFor(p, t) {
  var cyc = runCycleFor(p, t);
  p._cycle = cyc; // 暂存本帧周期，供带球触球读取（state 每轮询重建，帧内有效即可）
  var st = animClock[p.id];

  // 外场、门将、裁判都用同一张跑动图按球衣换色，避免旧表烤进去的杂色。
  if (p.pos !== 'SKIP') {
    var sheet = sheetForPlayer(p);
    if (!runPack.anchors || !sheet) return null;
    // 方向行：平滑速度 + 扇区迟滞。低速保持上次朝向。
    var sSpd = Math.sqrt(cyc.svx * cyc.svx + cyc.svy * cyc.svy);
    if (sSpd > 1.5) {
      var dRow = dirRowFor(cyc.svx, cyc.svy);
      if (st.dirRow == null) st.dirRow = dRow;
      else if (dRow !== st.dirRow && dRow >= 0) {
        var center = st.dirRow / 8;
        var delta = heading01(cyc.svx, cyc.svy) - center;
        if (delta > 0.5) delta -= 1;
        if (delta < -0.5) delta += 1;
        // 半个扇区是 22.5°。越过边界再多约 8° 才换行，贴边不会来回翻。
        if (Math.abs(delta) > 0.085) st.dirRow = dRow;
      }
    }
    else if (st.dirRow == null) st.dirRow = 2; // 默认朝右
    if (st.dirRow != null && DIR_UNIT[st.dirRow]) {
      st.fx = DIR_UNIT[st.dirRow].x;
      st.fy = DIR_UNIT[st.dirRow].y;
    }
    var col = Math.floor(cyc.phase * cyc.nFrames) % cyc.nFrames;
    var frac = cyc.phase * cyc.nFrames - col;
    if (frac < 0) frac = 0;
    // 身体用无球图（眼睛和嘴是实心的）。球由 drawActors 画在脚前，不再按颜色抠烤进图里的球。
    return {
      img: sheet, anchors: runPack.anchors, dirRow: st.dirRow, col: col, frac: frac,
      is8dir: true, hasBall: !!p.hasBall, moving: cyc.moving
    };
  }
  return null;
}

// ---------------- 结算演出图（像素风拼贴特写） ----------------
// 引擎 lastAction.cut 给出键名，这里预加载对应图片；drawCutin 播全屏演出。
var CUT_IMGS = {};
// 旧像素特写按需加载。开球时整表换色会卡在 matchPlaceholder 上几秒，
// 漫画分镜才是现在的演出，这些 webp 只在漫画还没好时兜底。
function ensureCutImg(k) {
  if (!k) return null;
  if (CUT_IMGS[k]) return CUT_IMGS[k];
  var im = new Image();
  im.src = 'assets/cutscene/' + k + '.webp';
  CUT_IMGS[k] = im;
  return im;
}
// ★ 漫画分镜资源预加载（动态判定动画）
if (typeof mangaInit === 'function') mangaInit();

// ---------------- 服务器 API ----------------
var api = window.__makeLocalApi();

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
  var ref = state.referee && state.referee.x != null
    ? { x: state.referee.x, y: state.referee.y }
    : { x: C.FIELD.W / 2, y: 12 };
  snapPrev = snapCurr;
  snapCurr = { t: now, px: px, ball: { x: state.ball.x, y: state.ball.y }, ref: ref };
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
  tutorialUntil: 0,         // 开场操作说明只显示几秒
  hintClosed: false,        // 玩家手动关掉提示
};
var clickables = [];        // 本帧可点击区域（绘制时重建）
var frameNo = 0;
// ★ 调试开关：?debug=1 打开自动开赛和比赛句柄。诊断条会挡住记分牌，
//   只有再加 hud=1 才画。正式对局和普通试玩都看不到它。
var DEBUG = /[?&]debug=1/.test(location.search);
var DEBUG_HUD = DEBUG && /[?&]hud=1/.test(location.search);
var dbgKey = '', dbgErr = '';
if (DEBUG) window.addEventListener('error', function (e) { dbgErr = 'ERR: ' + (e.message || e.type); });

// ---------------- 直接操控输入 ----------------
// 桌面端：WASD 方向 / J或Shift 加速 / K 减速 / L或Tab 切换球员 / E 呼出指令菜单 / 空格 暂停 / Q 取消
// 触屏：左摇杆 = 同一路方向输入（360°），右侧虚拟键和键盘一一对应。不放加速，也不放减速 K。
// touch-keys-v1
var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
var pad = { dx: 0, dy: 0, sprint: false, slow: false };
// 摇杆在左下：事件条到底是 y=336，球员卡从 y=556 开始，摇杆落在这道缝里。
var STICK = { x: 170, y: 448, r: 84 };
// 右侧按键同样躲开小地图（底边约 y=190）、球员卡和事件条。
var VKEYS = [
  { id: 'up', key: 'w', code: 'KeyW', label: '上', keyLabel: 'W', x: 1206, y: 250, r: 40 },
  { id: 'cancel', key: 'q', code: 'KeyQ', label: '取消', keyLabel: 'Q', x: 1206, y: 352, r: 42 },
  { id: 'down', key: 's', code: 'KeyS', label: '下', keyLabel: 'S', x: 1206, y: 454, r: 40 },
  { id: 'confirm', key: 'e', code: 'KeyE', label: '确定', keyLabel: 'E', x: 1084, y: 352, r: 56 },
  { id: 'switch', key: 'l', code: 'KeyL', label: '切换', keyLabel: 'L', x: 1084, y: 478, r: 38 },
];
var MENU_BTN = { x: 1192, y: 10, w: 72, h: 30 };
// 摇杆向量和按键触点分开记。键盘没按 WASD 时，摇杆方向不会被其它键清掉。
var stickVec = { dx: 0, dy: 0, on: false };
var contacts = {};
var idMap = {};
var recentDown = [];
var keyLockUntil = {};
function sendInput(extra) {
  if (screen !== 'game' || !matchId) return;
  var body = { dx: +pad.dx.toFixed(3), dy: +pad.dy.toFixed(3), sprint: pad.sprint, slow: pad.slow };
  if (extra) for (var k in extra) body[k] = extra[k];
  api.post('/api/match/' + matchId + '/input', body).catch(function () {});
}
function noteTutorialInput() {
  if (ui.tutorialDone || ui.hintClosed || ui.tutorialSeenInput) return;
  ui.tutorialSeenInput = true;
  ui.tutorialArmed = true;
  ui.tutorialUntil = Date.now() + 4000;
}
function setPad(dx, dy, sprint, slow) {
  if (dx || dy) noteTutorialInput();
  if (dx !== pad.dx || dy !== pad.dy || sprint !== pad.sprint || slow !== pad.slow) {
    pad.dx = dx; pad.dy = dy; pad.sprint = sprint; pad.slow = slow;
    sendInput();
    pokeRefresh();
  }
}

// ---------------- 精灵 ----------------
var frameCache = {};
function framesFor(p) {
  var hairHex = '#1a1a1a';
  if (typeof SharedKits !== 'undefined' && SharedKits.HAIR_PRESETS) {
    var hp = SharedKits.HAIR_PRESETS[p.hair] || SharedKits.HAIR_PRESETS.black;
    if (hp) hairHex = hp.color;
  }
  var skinHex = (typeof SharedKits !== 'undefined' && SharedKits.SKIN_PRESETS && SharedKits.SKIN_PRESETS[p.skin])
    ? SharedKits.SKIN_PRESETS[p.skin].color : '#f2c89b';
  var spec = kitSpecFor(p);
  var key = p.team + '_' + p.pos + '_' + (p.hair || 'black') + '_' + (p.skin || 'fair') + '_' +
    (spec ? spec.pattern + spec.primary + spec.shorts + spec.socks + spec.shoes : '');
  if (!frameCache[key]) {
    var shirt = spec ? spec.primary : (p.team === 'home' ? '#2b5fe3' : '#d23b3b');
    var shorts = spec ? spec.shorts : '#1a1a1a';
    frameCache[key] = S.playerFrames({
      shirt: shirt, shorts: shorts, socks: spec ? spec.socks : '#ffffff',
      shoes: spec ? spec.shoes : '#22222a',
      hair: hairHex, skin: skinHex,
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
  if (/[?&]wide=1/.test(location.search)) return 120;
  var lvl = (typeof hmTop === 'function') ? hmTop() : null;
  if (ui.hmenu && lvl && lvl.kind === 'aim') return 70;
  return 38;
}
// 底线外的草坪和围挡。镜头最远的那条边（透视最开）也不能看出这块范围。
var SURROUND = 22;
function cameraX() {
  var viewW = curViewW();
  var lvl = (typeof hmTop === 'function') ? hmTop() : null;
  var aiming = !!(ui.hmenu && lvl && lvl.kind === 'aim' && ui.hmenu.pass);
  var minCx = aiming ? -8 : (-SURROUND + viewW * 0.5);
  var maxCx = aiming ? (C.FIELD.W + 8 - viewW * 0.45) : (C.FIELD.W + SURROUND - viewW * 1.5);
  if (maxCx < minCx) return (C.FIELD.W - viewW) / 2;
  var focus = ballR.x;
  if (aiming) focus = ui.hmenu.pass.aimX * 0.72 + ballR.x * 0.28;
  var cx = clamp(focus - viewW * (aiming ? 0.38 : 0.45), minCx, maxCx);
  if (!aiming) return cx;
  return clamp(shiftCameraForAim(cx, viewW, ui.hmenu.pass.aimX, ui.hmenu.pass.aimY), minCx, maxCx);
}
// 落点光标不要钻进右侧按键，也不要停在左侧摇杆底下。
function shiftCameraForAim(cx, viewW, ax, ay) {
  var depth = clamp(ay / C.FIELD.H, 0, 1);
  var persp = 0.5 + 0.5 * (1 - depth);
  if (!(persp > 0.05)) return cx;
  var SAFE_R = 960;
  var SAFE_L = 520;
  var limitR = (SAFE_R - W / 2) * viewW / (W * persp);
  var cxMin = ax - viewW / 2 - limitR;
  if (cx < cxMin) cx = cxMin;
  var limitL = (SAFE_L - W / 2) * viewW / (W * persp);
  var cxMax = ax - viewW / 2 - limitL;
  if (cx > cxMax && cxMax >= cxMin) cx = cxMax;
  return cx;
}
function safeAimScreen(sx, sy) {
  if (!isTouch) return { x: sx, y: sy };
  var x = sx, y = sy;
  if (x > 960) x = 960;
  if (x < 340) x = 340;
  if (y > 530) y = 512;
  if (y < 78) y = 78;
  return { x: x, y: y };
}
function project(x, y) {
  var viewW = curViewW();
  var cx = cameraX();
  var depth = clamp(y / C.FIELD.H, 0, 1); // 0 近 1 远
  var persp = 0.5 + 0.5 * (1 - depth);
  var sx = W / 2 + ((x - cx - viewW / 2) / viewW) * W * persp;
  var sy = HORIZON + (1 - depth) * (GROUND - HORIZON);
  var s = 0.55 + 0.85 * (1 - depth);
  return { x: sx, y: sy, s: s, depth: depth };
}

// ---------------- 输入 ----------------
cv.addEventListener('click', function (e) {
  // ★ 全屏特写显示时：点任意位置只关闭特写（根治特写排队，2026-10-11）
  if (screen === 'game' && state && state.lastAction && state.lastAction.duel) { skipCutscene(); sendInput({ dismissOverlay: true }); return; }
  if (screen === 'game' && typeof showingCutscene === 'function' && showingCutscene()) { skipCutscene(); return; }
  var pt = canvasPoint(e.clientX, e.clientY);
  var mx = pt.x, my = pt.y;
  // 虚拟键和摇杆走指针/触摸，不把同一次点击再交给底下的界面。
  if (isTouch && screen === 'game' && touchInControl(e.clientX, e.clientY, pt)) return;
  for (var i = clickables.length - 1; i >= 0; i--) {
    var c = clickables[i];
    if (mx >= c.x && mx <= c.x + c.w && my >= c.y && my <= c.y + c.h) {
      c.action(mx, my);
      return;
    }
  }
});
document.addEventListener('keydown', function (e) {
  var held = (e.key || '').toLowerCase();
  if (held) keysDown[held] = true;
  if (screen === 'title' || screen === 'career') {
    var ck = (e.key || '').toLowerCase();
    if (inSettings() && (ck === 'a' || ck === 'arrowleft')) { nudgeSetting(-1); e.preventDefault(); return; }
    if (inSettings() && (ck === 'd' || ck === 'arrowright')) { nudgeSetting(1); e.preventDefault(); return; }
    if (ck === 'w' || ck === 'arrowup') { stepCareer(-1); e.preventDefault(); return; }
    if (ck === 's' || ck === 'arrowdown') { stepCareer(1); e.preventDefault(); return; }
    if (ck === 'e' || ck === 'enter') { activateCareer(); e.preventDefault(); return; }
    if (ck === 'q' || ck === 'escape') { backCareer(); e.preventDefault(); return; }
    return;
  }
  if (screen === 'game' && state && state.phase === 'fulltime') {
    var fk0 = (e.key || '').toLowerCase();
    if (fk0 === 'e' || fk0 === 'enter' || fk0 === ' ' || fk0 === 'q' || fk0 === 'escape') {
      if (ui.careerFix) returnToCareer();
      else exitMatch();
      e.preventDefault();
    }
    return;
  }
  if (e.key === 'Escape' && screen === 'game') {
    if (state && state.lastAction && state.lastAction.duel) { sendInput({ dismissOverlay: true }); return; }
    if (headMenuOpen()) { headMenuBack(); return; } // 头顶菜单内：Esc = 返回上一步
    if (showingCutscene()) { skipCutscene(); return; } // ★ 全屏特写：Esc 只关闭特写
    if (!ui.overlay) togglePause();
    return;
  }
  if (screen !== 'game') return;
  if (state && state.decision && state.decision.kind === 'qte' && !e.repeat) {
    var qk = (e.key || '').toLowerCase();
    if (qk === 'e' || qk === 'enter' || qk === ' ') { confirmQte(); e.preventDefault(); return; }
  }
  if (DEBUG) { var _lt = hmTop(); dbgKey = 'key=' + e.key + ' menu=' + (headMenuOpen() ? 'open' : 'shut') + ' top=' + (_lt ? (_lt.kind + '#' + _lt.sel) : 'none'); }
  if (headMenuOpen() && headMenuKey(e)) return; // 头顶菜单打开时接管键盘（方向键/回车/空格选，Esc 返回）
  var k = (e.key || '').toLowerCase();
  if (ui.pauseOpen && !ui.overlay) {
    if (k === 'q') { togglePause(false); e.preventDefault(); return; }
    if (k === 'e' || k === 'enter') { activatePause(); e.preventDefault(); return; }
    if (k === 'w' || k === 'arrowup') { stepSelection(function () { return ui.pauseSel || 0; }, function (i) { ui.pauseSel = i; }, function () { return pauseItems().length; }, null, -1); e.preventDefault(); return; }
    if (k === 's' || k === 'arrowdown') { stepSelection(function () { return ui.pauseSel || 0; }, function (i) { ui.pauseSel = i; }, function () { return pauseItems().length; }, null, 1); e.preventDefault(); return; }
  }
  // ★ 全屏特写显示时：Enter/空格只关闭特写，不触发下层动作（根治特写排队打断心流，2026-10-11）
  if (state && state.lastAction && state.lastAction.duel && (k === 'enter' || k === ' ' || k === 'e' || k === 'q')) {
    sendInput({ dismissOverlay: true }); e.preventDefault(); return;
  }
  if (showingCutscene() && (k === 'enter' || k === ' ')) { skipCutscene(); e.preventDefault(); return; }
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
document.addEventListener('keyup', function (e) {
  var k = (e.key || '').toLowerCase();
  keysDown[k] = false;
  if (ui.menuNeedKeyUp === k) ui.menuNeedKeyUp = null;
  if (keys[k]) { keys[k] = false; updatePadFromKeys(); }
});
window.addEventListener('blur', function () {
  // 失焦松开所有键，避免球员一直跑
  for (var k in keys) keys[k] = false;
  for (var k2 in keysDown) keysDown[k2] = false;
  contacts = {};
  idMap = {};
  stickVec.on = false; stickVec.dx = 0; stickVec.dy = 0;
  setPad(0, 0, false, false);
});
var keys = {};
var keysDown = {};
function updatePadFromKeys() {
  // 场地坐标：+x 朝对方球门（右），+y 朝屏幕上方。Shift 也加速（和 J 一样）。
  // 键盘方向优先。没有 WASD 时保留摇杆的模拟量，避免点一下「确定」把摇杆清零。
  var dx = (keys['d'] ? 1 : 0) - (keys['a'] ? 1 : 0);
  var dy = (keys['w'] ? 1 : 0) - (keys['s'] ? 1 : 0);
  var sprint = !!(keys['j'] || keys['shift']);
  var slow = !!keys['k'];
  if (dx || dy) setPad(dx, dy, sprint, slow);
  else if (stickVec.on) setPad(stickVec.dx, stickVec.dy, sprint, slow);
  else setPad(0, 0, sprint, slow);
}

// ---- 触屏：摇杆 + 与键盘一一对应的虚拟键 ----
// touch-keys-v1
// touch-float-v1：左 40% 屏幕落下即生成摇杆；按键是画布之上的一层，触摸不进球场。
// 指针 setPointerCapture，再加 passive:false 的 touch 兜底。iOS 抓不到指针时走 touch。

cv.style.touchAction = 'none';
var STICK_CSS_R = 74;
var stickOrigin = null;
var touchDbg = { n: 0, line: '尚无触摸' };
var vkeysReady = false;

function canvasPoint(clientX, clientY) {
  var rect = cv.getBoundingClientRect();
  var rw = rect.width || W, rh = rect.height || H;
  var scale = Math.min(rw / W, rh / H);
  if (!(scale > 0)) scale = 1;
  var offX = (rw - W * scale) / 2;
  var offY = (rh - H * scale) / 2;
  return {
    x: (clientX - rect.left - offX) / scale,
    y: (clientY - rect.top - offY) / scale,
  };
}
function clientOfCanvas(x, y) {
  var rect = cv.getBoundingClientRect();
  var rw = rect.width || W, rh = rect.height || H;
  var scale = Math.min(rw / W, rh / H);
  if (!(scale > 0)) scale = 1;
  var offX = (rw - W * scale) / 2;
  var offY = (rh - H * scale) / 2;
  return { x: rect.left + offX + x * scale, y: rect.top + offY + y * scale, scale: scale };
}
function portraitLock() {
  try {
    return !!(window.matchMedia && window.matchMedia('(orientation: portrait) and (max-width: 900px)').matches);
  } catch (err) { return false; }
}
function inStickScreen(cx, cy) {
  var w = window.innerWidth || 1280;
  var h = window.innerHeight || 720;
  return cx >= 0 && cy >= 0 && cx <= w * 0.40 && cy <= h;
}
function inKeyColumn(p) {
  return !!(p && p.x >= 990 && p.y >= 150 && p.y <= 560);
}
function touchInControl(cx, cy, p) {
  if (cx != null && cy != null && inStickScreen(cx, cy)) return true;
  if (p && (hitVKey(p) || inKeyColumn(p))) return true;
  return false;
}
function hitVKey(p) {
  var best = null, bestD = 1e9;
  for (var i = 0; i < VKEYS.length; i++) {
    var b = VKEYS[i];
    var d = Math.hypot(p.x - b.x, p.y - b.y);
    if (d <= b.r + 10 && d < bestD) { best = b; bestD = d; }
  }
  return best;
}
function hitStick(p) {
  if (!p) return false;
  var c = clientOfCanvas(p.x, p.y);
  return inStickScreen(c.x, c.y);
}
function stickOwned() {
  for (var k in contacts) if (contacts[k].role === 'stick') return true;
  return false;
}
function lookupId(ns, id) {
  var key = ns + ':' + id;
  return idMap[key] != null ? idMap[key] : key;
}
function beginId(ns, id, p) {
  var key = ns + ':' + id;
  if (idMap[key] != null) return idMap[key];
  var now = Date.now();
  for (var i = recentDown.length - 1; i >= 0; i--) {
    var r = recentDown[i];
    if (now - r.t > 70) continue;
    if (Math.hypot(p.x - r.x, p.y - r.y) < 28) {
      idMap[key] = r.id;
      return r.id;
    }
  }
  idMap[key] = key;
  recentDown.push({ id: key, x: p.x, y: p.y, t: now });
  if (recentDown.length > 8) recentDown.shift();
  return key;
}
function noteTouchDbg(type, x, y, role) {
  touchDbg.n += 1;
  touchDbg.line = type + ' ' + (role || '') + ' ' + Math.round(x) + ',' + Math.round(y) +
    '  n=' + touchDbg.n + '  dx=' + (stickVec.dx || 0).toFixed(2) + ' dy=' + (stickVec.dy || 0).toFixed(2);
  if (!DEBUG) return;
  var el = document.getElementById('touch-debug');
  if (el && 'hidden' in el) {
    el.hidden = false;
    el.textContent = touchDbg.line;
  }
}
function uiOrigin() {
  var ui = document.getElementById('touch-ui');
  if (!ui || !ui.getBoundingClientRect) return { left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 };
  var r = ui.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
}
function showFloatStick(x, y) {
  var el = document.getElementById('float-stick');
  var knob = document.getElementById('float-stick-knob');
  if (!el || !el.style) return;
  var o = uiOrigin();
  el.hidden = false;
  el.style.width = (STICK_CSS_R * 2) + 'px';
  el.style.height = (STICK_CSS_R * 2) + 'px';
  el.style.marginLeft = (-STICK_CSS_R) + 'px';
  el.style.marginTop = (-STICK_CSS_R) + 'px';
  el.style.left = (x - o.left) + 'px';
  el.style.top = (y - o.top) + 'px';
  if (knob && knob.style) {
    var px = stickVec.dx * STICK_CSS_R * 0.62;
    var py = -stickVec.dy * STICK_CSS_R * 0.62;
    knob.style.transform = 'translate(' + px + 'px,' + py + 'px)';
  }
}
function hideFloatStick() {
  var el = document.getElementById('float-stick');
  if (el && 'hidden' in el) el.hidden = true;
}
function applyStickClient(cx, cy) {
  if (!stickOrigin) stickOrigin = { x: cx, y: cy };
  var dx = (cx - stickOrigin.x) / STICK_CSS_R;
  var dy = (cy - stickOrigin.y) / STICK_CSS_R;
  var len = Math.hypot(dx, dy);
  if (len < 0.16) { dx = 0; dy = 0; }
  else if (len > 1) { dx /= len; dy /= len; }
  stickVec.on = true;
  stickVec.dx = Math.round(dx * 1000) / 1000;
  stickVec.dy = Math.round(-dy * 1000) / 1000;
  updatePadFromKeys();
  showFloatStick(stickOrigin.x, stickOrigin.y);
}
function releaseStick() {
  stickVec.on = false;
  stickVec.dx = 0;
  stickVec.dy = 0;
  stickOrigin = null;
  hideFloatStick();
  updatePadFromKeys();
}
function endContact(ns, rawId) {
  var id = lookupId(ns, rawId);
  var c = contacts[id];
  if (!c) return;
  delete contacts[id];
  if (c.role === 'stick') releaseStick();
}
function clearContacts() {
  contacts = {};
  idMap = {};
  recentDown = [];
  releaseStick();
}
function synthTap(key, code) {
  noteTutorialInput();
  var now = Date.now();
  if (now < (keyLockUntil[key] || 0)) return;
  keyLockUntil[key] = now + 280;
  if (!document.dispatchEvent || typeof KeyboardEvent !== 'function') return;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: code, bubbles: true, cancelable: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: key, code: code, bubbles: true, cancelable: true }));
}
function capturePointer(nativeEvent, el) {
  if (!nativeEvent || nativeEvent.pointerId == null || !el || typeof el.setPointerCapture !== 'function') return;
  try { el.setPointerCapture(nativeEvent.pointerId); } catch (err) {}
}
function controlStickDown(ns, rawId, cx, cy, nativeEvent, el) {
  if (!isTouch || portraitLock() || (screen !== 'game' && screen !== 'career' && screen !== 'title')) return false;
  noteTouchDbg(nativeEvent && nativeEvent.type ? nativeEvent.type : 'touchstart', cx, cy, 'stick');
  if (nativeEvent && nativeEvent.cancelable) nativeEvent.preventDefault();
  if (nativeEvent && nativeEvent.stopPropagation) nativeEvent.stopPropagation();
  if (typeof showingCutscene === 'function' && showingCutscene() && !headMenuOpen()) skipCutscene();
  var id = beginId(ns, rawId, { x: cx, y: cy });
  if (contacts[id]) {
    if (ns === 't') contacts[id].touchId = rawId;
    return true;
  }
  if (stickOwned()) return true;
  contacts[id] = { role: 'stick', touchId: ns === 't' ? rawId : null };
  stickOrigin = { x: cx, y: cy };
  capturePointer(nativeEvent, el);
  applyStickClient(cx, cy);
  return true;
}
function controlKeyDown(ns, rawId, key, nativeEvent, el, cx, cy) {
  if (!isTouch || portraitLock() || !key || (screen !== 'game' && screen !== 'career' && screen !== 'title')) return false;
  var x = cx != null ? cx : (nativeEvent ? nativeEvent.clientX : 0);
  var y = cy != null ? cy : (nativeEvent ? nativeEvent.clientY : 0);
  noteTouchDbg(nativeEvent && nativeEvent.type ? nativeEvent.type : 'touchstart', x, y, key.id);
  if (nativeEvent && nativeEvent.cancelable) nativeEvent.preventDefault();
  if (nativeEvent && nativeEvent.stopPropagation) nativeEvent.stopPropagation();
  if (typeof showingCutscene === 'function' && showingCutscene() && !headMenuOpen()) skipCutscene();
  var id = beginId(ns, rawId, { x: x, y: y });
  if (contacts[id]) {
    if (ns === 't') contacts[id].touchId = rawId;
    return true;
  }
  contacts[id] = { role: 'key', id: key.id, touchId: ns === 't' ? rawId : null };
  capturePointer(nativeEvent, el);
  synthTap(key.key, key.code);
  return true;
}
function handleDown(ns, rawId, p, nativeEvent, clientX, clientY) {
  if (!isTouch || portraitLock() || (screen !== 'game' && screen !== 'career' && screen !== 'title')) return false;
  var cx = clientX != null ? clientX : (nativeEvent ? nativeEvent.clientX : null);
  var cy = clientY != null ? clientY : (nativeEvent ? nativeEvent.clientY : null);
  if (typeof showingCutscene === 'function' && showingCutscene() && !headMenuOpen()) skipCutscene();
  var key = hitVKey(p);
  if (key) return controlKeyDown(ns, rawId, key, nativeEvent, nativeEvent && nativeEvent.currentTarget, cx, cy);
  if (cx != null && inStickScreen(cx, cy)) return controlStickDown(ns, rawId, cx, cy, nativeEvent, nativeEvent && nativeEvent.currentTarget);
  if (touchInControl(cx, cy, p)) {
    if (nativeEvent && nativeEvent.cancelable) nativeEvent.preventDefault();
    if (nativeEvent && nativeEvent.stopPropagation) nativeEvent.stopPropagation();
    noteTouchDbg('blocked', cx || 0, cy || 0, 'field');
    return true;
  }
  var lvl = (typeof hmTop === 'function') ? hmTop() : null;
  if (headMenuOpen() && lvl && lvl.kind === 'aim' && p.y > 0 && p.y < 556 && p.x > 0 && p.x < W) {
    setAimFromScreen(p.x, p.y);
    if (nativeEvent && nativeEvent.cancelable) nativeEvent.preventDefault();
    return true;
  }
  return false;
}
function eventOnControl(e) {
  var t = e && e.target;
  return !!(t && t.closest && t.closest('#touch-ui'));
}
function onPointerDown(e) {
  if (!e || e.pointerType === 'mouse') return;
  if (eventOnControl(e)) return;
  handleDown('p', e.pointerId, canvasPoint(e.clientX, e.clientY), e);
}
function onPointerMove(e) {
  if (!e || e.pointerType === 'mouse') return;
  var c = contacts[lookupId('p', e.pointerId)];
  if (!c || c.role !== 'stick') return;
  if (e.cancelable) e.preventDefault();
  applyStickClient(e.clientX, e.clientY);
  noteTouchDbg('pointermove', e.clientX, e.clientY, 'stick');
}
function onPointerUp(e) {
  if (!e || e.pointerType === 'mouse') return;
  if ('ontouchstart' in window) return;
  endContact('p', e.pointerId);
}
function onTouchStart(e) {
  if (eventOnControl(e)) return;
  var used = false;
  for (var i = 0; i < e.changedTouches.length; i++) {
    var t = e.changedTouches[i];
    if (handleDown('t', t.identifier, canvasPoint(t.clientX, t.clientY), e, t.clientX, t.clientY)) used = true;
  }
  if (used && e.cancelable) e.preventDefault();
}
function onTouchMove(e) {
  if ((stickVec.on || stickOwned()) && e.cancelable) e.preventDefault();
  var moved = false;
  for (var i = 0; i < e.changedTouches.length; i++) {
    var t = e.changedTouches[i];
    var c = contacts[lookupId('t', t.identifier)];
    if (c && c.role === 'stick') {
      if (e.cancelable) e.preventDefault();
      applyStickClient(t.clientX, t.clientY);
      noteTouchDbg('touchmove', t.clientX, t.clientY, 'stick');
      moved = true;
    }
  }
  if (!moved && stickVec.on && stickOrigin) {
    for (var j = 0; j < e.changedTouches.length; j++) {
      var t2 = e.changedTouches[j];
      if (contacts[lookupId('t', t2.identifier)]) continue;
      if (inStickScreen(t2.clientX, t2.clientY) || Math.hypot(t2.clientX - stickOrigin.x, t2.clientY - stickOrigin.y) < 220) {
        if (e.cancelable) e.preventDefault();
        applyStickClient(t2.clientX, t2.clientY);
      }
    }
  }
}
function onTouchEnd(e) {
  var ended = [];
  for (var i = 0; i < e.changedTouches.length; i++) ended.push(e.changedTouches[i].identifier);
  for (var n = 0; n < ended.length; n++) endContact('t', ended[n]);
  if (e.touches.length) return;
  if (!stickOwned()) { releaseStick(); return; }
  var stick = null;
  for (var k in contacts) if (contacts[k].role === 'stick') stick = contacts[k];
  if (!stick || stick.touchId == null) { releaseStick(); return; }
  for (var m = 0; m < ended.length; m++) if (ended[m] === stick.touchId) { releaseStick(); return; }
}
function onTouchCancel(e) {
  onTouchEnd(e);
  clearContacts();
}
function bindControl(el, kind, keyBtn) {
  if (!el || typeof el.addEventListener !== 'function') return;
  el.addEventListener('pointerdown', function (e) {
    if (!e || e.pointerType === 'mouse') return;
    if (kind === 'key') controlKeyDown('p', e.pointerId, keyBtn, e, el);
    else controlStickDown('p', e.pointerId, e.clientX, e.clientY, e, el);
  }, { passive: false });
  el.addEventListener('pointermove', function (e) {
    if (!e || e.pointerType === 'mouse') return;
    var c = contacts[lookupId('p', e.pointerId)];
    if (!c || c.role !== 'stick') return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    applyStickClient(e.clientX, e.clientY);
    noteTouchDbg('pointermove', e.clientX, e.clientY, 'stick');
  }, { passive: false });
  el.addEventListener('pointerup', function (e) {
    if (!e || e.pointerType === 'mouse') return;
    if ('ontouchstart' in window) return;
    endContact('p', e.pointerId);
  }, { passive: false });
  el.addEventListener('pointercancel', function (e) {
    if (!e || e.pointerType === 'mouse') return;
    if ('ontouchstart' in window) return;
    endContact('p', e.pointerId);
  }, { passive: false });
  el.addEventListener('touchstart', function (e) {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (kind === 'key') controlKeyDown('t', t.identifier, keyBtn, e, el, t.clientX, t.clientY);
      else controlStickDown('t', t.identifier, t.clientX, t.clientY, e, el);
    }
  }, { passive: false });
  el.addEventListener('touchmove', function (e) {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var c = contacts[lookupId('t', t.identifier)];
      if (c && c.role === 'stick') {
        applyStickClient(t.clientX, t.clientY);
        noteTouchDbg('touchmove', t.clientX, t.clientY, 'stick');
      }
    }
  }, { passive: false });
  el.addEventListener('touchend', function (e) {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    onTouchEnd(e);
  }, { passive: false });
  el.addEventListener('touchcancel', function (e) {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    onTouchCancel(e);
  }, { passive: false });
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); }, { passive: false });
}
function ensureVKeyButtons() {
  if (vkeysReady) return;
  var layer = document.getElementById('vkey-layer');
  var zone = document.getElementById('stick-zone');
  if (!layer || typeof layer.appendChild !== 'function' || !zone) return;
  if (typeof document.createElement !== 'function') return;
  var probe = document.createElement('div');
  if (!probe || typeof probe.addEventListener !== 'function') return;
  VKEYS.forEach(function (b) {
    var btn = document.createElement('div');
    btn.className = 'vkey' + (b.id === 'confirm' ? ' vkey-confirm' : '');
    btn.setAttribute('data-id', b.id);
    btn.innerHTML = '<span class="vkey-label">' + b.label + '</span><span class="vkey-key">' + b.keyLabel + '</span>';
    bindControl(btn, 'key', b);
    layer.appendChild(btn);
  });
  bindControl(zone, 'stick', null);
  vkeysReady = true;
}
function layoutVKeys() {
  var origin = uiOrigin();
  if (!stickVec.on) {
    var vh = origin.height || window.innerHeight || 390;
    STICK_CSS_R = Math.max(46, Math.min(74, vh * 0.18));
  }
  var hint = document.getElementById('stick-hint');
  if (hint && hint.style) {
    var hs = clientOfCanvas(STICK.x, STICK.y);
    var d = STICK_CSS_R * 2;
    hint.style.width = d + 'px';
    hint.style.height = d + 'px';
    hint.style.marginLeft = (-STICK_CSS_R) + 'px';
    hint.style.marginTop = (-STICK_CSS_R) + 'px';
    hint.style.left = (hs.x - origin.left) + 'px';
    hint.style.top = (hs.y - origin.top) + 'px';
    if ('hidden' in hint) hint.hidden = !!stickVec.on || screen !== 'game';
  }
  var layer = document.getElementById('vkey-layer');
  if (!layer || !layer.children) return;
  var items = [];
  for (var i = 0; i < layer.children.length; i++) {
    var btn = layer.children[i];
    if (!btn.getAttribute) continue;
    var id = btn.getAttribute('data-id');
    var spec = null;
    for (var k = 0; k < VKEYS.length; k++) if (VKEYS[k].id === id) spec = VKEYS[k];
    if (!spec) continue;
    var p = clientOfCanvas(spec.x, spec.y);
    items.push({
      btn: btn, id: id,
      x: p.x - origin.left, y: p.y - origin.top,
      rad: Math.max(14, spec.r * p.scale),
    });
  }
  var fit = 1;
  for (var a = 0; a < items.length; a++) {
    for (var b = a + 1; b < items.length; b++) {
      var dist = Math.hypot(items[a].x - items[b].x, items[a].y - items[b].y);
      var span = items[a].rad + items[b].rad;
      if (span > 1 && dist < span + 8) fit = Math.min(fit, Math.max(0.45, (dist - 8) / span));
    }
  }
  var bottom = origin.height || 0;
  for (var n = 0; n < items.length; n++) {
    var it = items[n];
    var rad = Math.max(15, it.rad * fit);
    if (bottom && it.y + rad > bottom - 4) rad = Math.max(14, bottom - 4 - it.y);
    it.btn.style.left = (it.x - rad) + 'px';
    it.btn.style.top = (it.y - rad) + 'px';
    it.btn.style.width = (rad * 2) + 'px';
    it.btn.style.height = (rad * 2) + 'px';
    it.btn.style.fontSize = Math.max(11, Math.round(rad * 0.32)) + 'px';
    var held = false;
    for (var ck in contacts) if (contacts[ck].role === 'key' && contacts[ck].id === it.id) held = true;
    if (it.btn.classList) it.btn.classList.toggle('held', held);
  }
}
function syncTouchLayer() {
  var el = document.getElementById('touch-ui');
  if (!el || !('hidden' in el)) return;
  var on = !!(isTouch && (screen === 'game' || screen === 'career' || screen === 'title') && !portraitLock());
  el.hidden = !on;
  if (!on) return;
  ensureVKeyButtons();
  layoutVKeys();
}
function driveStickAim() {
  if (!stickVec.on || screen !== 'game') return;
  var lvl = (typeof hmTop === 'function') ? hmTop() : null;
  if (!lvl || lvl.kind !== 'aim' || !ui.hmenu || !ui.hmenu.pass) return;
  if (Math.hypot(stickVec.dx, stickVec.dy) < 0.12) return;
  nudgeAim(stickVec.dx * 0.18, stickVec.dy * 0.18);
}
// stick-menu-v1：菜单打开时，左摇杆上一下一格、下一下一格。拨一下只走一格。
var stickNav = { dir: 0, until: 0 };
function stepSelection(get, set, len, enabled, dir) {
  var n = len();
  if (!n) return;
  var i = get();
  if (i == null || isNaN(i)) i = 0;
  for (var c = 0; c < n; c++) {
    i = (i + dir + n) % n;
    if (!enabled || enabled(i)) break;
  }
  set(i);
}
function menuListTarget() {
  if ((screen === 'title' || screen === 'career') && typeof careerRowCount === 'function') {
    return {
      get: function () { return ui.menuSel || 0; },
      set: function (i) { ui.menuSel = i; },
      len: function () { return careerRowCount(); },
      enabled: function (i) {
        var rows = screen === 'title' ? titleActions() : careerRows();
        return !rows[i] || rows[i].enabled !== false;
      },
    };
  }
  var lvl = (typeof hmTop === 'function') ? hmTop() : null;
  if (headMenuOpen() && lvl && lvl.kind !== 'aim') {
    if (lvl.kind === 'confirm') {
      return {
        get: function () { return lvl.sel || 0; },
        set: function (i) { lvl.sel = i; },
        len: function () { return 2; },
      };
    }
    if (lvl.items && lvl.items.length) {
      return {
        get: function () { return lvl.sel || 0; },
        set: function (i) { lvl.sel = i; },
        len: function () { return lvl.items.length; },
        enabled: function (i) { return !!(lvl.items[i] && lvl.items[i].enabled); },
      };
    }
  }
  if (ui.pauseOpen && !ui.overlay) {
    return {
      get: function () { return ui.pauseSel || 0; },
      set: function (i) { ui.pauseSel = i; },
      len: function () { return pauseItems().length; },
    };
  }
  return null;
}
function driveStickList() {
  var target = menuListTarget();
  if (!target || !stickVec.on) { stickNav.dir = 0; return; }
  var now = Date.now();
  if (inSettings()) {
    var ax = stickVec.dx;
    var ay = stickVec.dy;
    if (Math.abs(ax) > 0.48 && Math.abs(ax) >= Math.abs(ay)) {
      var hdir = ax > 0 ? 1 : -1;
      if (stickNav.dir === hdir && now < stickNav.until) return;
      stickNav.dir = hdir;
      stickNav.until = now + 360;
      nudgeSetting(hdir);
      return;
    }
  }
  var dy = stickVec.dy;
  var dir = dy > 0.48 ? -1 : (dy < -0.48 ? 1 : 0);
  if (!dir) { stickNav.dir = 0; return; }
  if (stickNav.dir === dir && now < stickNav.until) return;
  stickNav.dir = dir;
  stickNav.until = now + 360;
  stepSelection(target.get, target.set, target.len, target.enabled, dir);
}
document.addEventListener('pointerdown', onPointerDown, { passive: false, capture: true });
document.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
document.addEventListener('pointerup', onPointerUp, { passive: false, capture: true });
document.addEventListener('pointercancel', onPointerUp, { passive: false, capture: true });
document.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
document.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
document.addEventListener('touchcancel', onTouchCancel, { passive: false, capture: true });
['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
  document.addEventListener(type, function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
});

function addClick(x, y, w, h, action) {
  clickables.push({ x: x, y: y, w: w, h: h, action: action });
}
function clearToast() {
  ui.toast = '';
  ui.toastUntil = 0;
}
function toast(msg, ms) {
  ui.toast = msg || '';
  ui.toastUntil = Date.now() + (ms == null ? 2000 : ms);
}
// toast-current-v1：只提示当前这一下事件，约 2 秒后消失。球权轮询不再造一句「对方断球」。
function syncEventToast(st) {
  if (!st) return;
  var a = st.lastAction;
  if (a && a.duel) { clearToast(); ui._toastKey = 'duel'; return; }
  if (st.phase === 'kickoff' || st.phase === 'goal' || st.phase === 'whistle' || st.phase === 'penalty' || st.restart) {
    if (ui.toast && (ui.toast.indexOf('断球') >= 0 || ui.toast.indexOf('夺回') >= 0)) clearToast();
  }
  var key = a ? ((a.kind || '') + '|' + (a.label || '') + '|' + (a.text || '') + '|' + (a.until || 0)) : '';
  if (key === ui._toastKey) return;
  ui._toastKey = key;
  clearToast();
  if (!a || st.phase !== 'play' || st.restart) return;
  var blob = (a.kind || '') + (a.label || '') + (a.text || '');
  var takeover = a.kind === 'tackle' || a.kind === 'intercept' || /断球|抢断|断下/.test(blob);
  if (!takeover) return;
  if (a.duel && a.duel.result && a.duel.result.indexOf('成功') >= 0 && a.team === 'home' && a.kind !== 'tackle') return;
  if (a.team === 'away') toast('⚠️ 对方断球！', 2000);
  else if (a.team === 'home') toast('⚽ 夺回球权！', 2000);
}

// ---------------- 比赛控制 ----------------
function startMatch(extra) {
  var body = { halfLength: ui.halfLength, mentality: ui.mentality };
  if (extra) for (var k in extra) body[k] = extra[k];
  api.post('/api/match', body).then(function (r) {
    if (!r.ok) { toast('创建比赛失败'); return; }
    matchId = r.matchId;
    screen = 'game';
    state = null;
    renderPos = {};
    ballR = { x: 52.5, y: 34 };
    ballTrail = []; snapPrev = null; snapCurr = null; animClock = {};
    selectedHomeIdx = 9;
    pad.dx = 0; pad.dy = 0; pad.sprint = false; pad.slow = false;
    stickVec.on = false; stickVec.dx = 0; stickVec.dy = 0;
    contacts = {}; idMap = {}; recentDown = [];
    for (var k in keys) keys[k] = false;
    ui.pauseOpen = false; ui.overlay = null; ui.choosing = false; ui.exitArm = 0;
    ui.tutorialUntil = Date.now() + 6000;
    ui.tutorialArmed = true;
    ui.tutorialDone = false;
    ui.tutorialSeenInput = false;
    ui.hintClosed = false;
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
    var decSig = '';
    if (hasDec) {
      var decIds = (state.decision.options || []).map(function (o) { return o.id; }).join(',');
      decSig = (state.decision.kind || '') + '|' + state.decision.playerId + '|' + (state.decision.shotId || '') + '|' + decIds;
    }
    if (decSig !== ui._decSig) {
      ui.choosing = false; // 新的一层菜单（选人 / 射门 / QTE）不能停在「判定中」
      ui.hmenu = null;
      ui._decSig = decSig;
    }
    if (!hasDec) ui.choosing = false;
    // ★ 看门狗（2026-10-12 试玩：偶发"判定中…"永久卡死）：本地引擎指令毫秒级结算，
    //   5 秒还没清掉 choosing 必是状态错乱，强制恢复 + 提示，不让玩家只能刷新
    if (ui.choosing && Date.now() - (ui._chooseAt || 0) > 5000) {
      ui.choosing = false; ui.hmenu = null; toast('指令超时，已恢复');
    }
    // 决策变化（新球员/决策结束）时关闭头顶菜单
    var decKey = hasDec ? state.decision.playerId : null;
    if (decKey !== ui._hmDecisionKey) { ui.hmenu = null; ui._hmDecisionKey = decKey; }
    ui._hadDecision = hasDec;
    // 首次同步渲染位置
    state.players.forEach(function (p) {
      if (!renderPos[p.id]) renderPos[p.id] = { x: p.x, y: p.y };
    });
    syncEventToast(state);
    finishCareerIfDone();
    // 输入心跳：保持操控输入新鲜（服务器 2 秒无有效操作则 AI 接管）
    sendInput();
  }).catch(function () {});
}
function sendCommand(opt, params) {
  if (ui.choosing || !state || !state.decision) return;
  if (!opt.enabled) { toast('体能不足，无法使用该指令'); return; }
  ui.choosing = true;
  ui._chooseAt = Date.now(); // ★ 指令发出时间戳（配下面的看门狗，防"判定中…"永久卡死）
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
function cancelVoluntaryMenu() {
  if (!state || !state.decision || !state.decision.voluntary) return false;
  ui.hmenu = null;
  ui.choosing = false;
  ui.pauseOpen = false;
  state.decision = null;
  state.phase = 'play';
  state.paused = false;
  sendInput({ cancelMenu: true });
  if (matchId) api.post('/api/match/' + matchId + '/pause', { paused: false });
  return true;
}
function headMenuBack() {
  // 自己打开的指令面板：Q / Esc / 取消直接关掉，马上恢复摇杆和 WASD。
  if (cancelVoluntaryMenu()) return;
  popHmLevel();
}

function optionSub(o) {
  if (o.sub) return o.sub;
  if (o.moves) return '选择动作';
  if (o.shots) return '选择射门';
  if (o.skills) return '选择技能';
  if (o.rate == null && (o.cost == null || o.cost === 0)) return '';
  return (o.rate != null ? o.rate + '% · ' : '') + (o.cost != null ? o.cost + '体能' : '');
}
function commandItem(o) {
  return {
    label: (CMD_ICONS[o.id] || '•') + ' ' + o.name,
    sub: optionSub(o),
    stats: o.stats || null,
    enabled: o.enabled !== false,
    fn: function () {
      if (ui.choosing) return;
      if (o.id === 'pass') {
        ui.hmenu.passOpt = o;
        initAim(ui.hmenu);
        if (o.presetHeight) ui.hmenu.pass.height = o.presetHeight;
        pushHmLevel({ kind: 'aim', title: '落点', sel: 0 });
        requestHmPreview();
      }
      else if (o.moves && o.moves.length) pushHmLevel(moveLevel(o));
      else if (o.shots && o.shots.length) pushHmLevel(shotLevel(o));
      else if (o.skills && o.skills.length) pushHmLevel(skillLevel(o));
      else sendCommand(o);
    }
  };
}
function moveLevel(o) {
  var items = [backItem()];
  o.moves.forEach(function (mv) {
    items.push({
      label: (CMD_ICONS[mv.id] || '💨') + ' ' + mv.name,
      sub: (mv.rate != null ? mv.rate + '% · ' : '') + mv.cost + '体能',
      enabled: mv.enabled !== false,
      fn: function () { sendCommand(mv); }
    });
  });
  return { kind: 'moves', title: o.name, items: items, sel: 1 };
}
function shotLevel(o) {
  var items = [backItem()];
  o.shots.forEach(function (sh) {
    items.push({
      label: (CMD_ICONS[sh.id] || '⚽') + ' ' + sh.name,
      sub: (sh.rate != null ? sh.rate + '% · ' : '') + sh.cost + '体能',
      enabled: sh.enabled !== false,
      fn: function () { sendCommand(sh); }
    });
  });
  return { kind: 'shots', title: o.name, items: items, sel: 1 };
}
function skillLevel(o) {
  var items = [backItem()];
  o.skills.forEach(function (sk) {
    items.push({
      label: (CMD_ICONS[sk.id] || '🛡️') + ' ' + sk.name,
      sub: (sk.enabled ? (sk.rate + '% · ' + sk.cost + '体能') : '够不着或体能不足'),
      enabled: sk.enabled !== false,
      fn: function () { sendCommand(sk); }
    });
  });
  return { kind: 'skills', title: o.name, items: items, sel: 1 };
}
function openHeadMenu(d) {
  var items = d.options.map(commandItem);
  ui.hmenu = {
    playerId: d.playerId, passOpt: null,
    pass: { aimX: 0, aimY: 0, technique: 'inside', height: 'mid' },
    preview: null, previewAt: 0,
    stack: [{ kind: 'cmds', title: null, items: items, sel: firstEnabled(items, 0) }]
  };
  // 打开菜单的那下 E 不能同时当成确认。松开之前，以及刚打开的一小段，E 都不算。
  ui.menuArmUntil = Date.now() + 280;
  ui.menuNeedKeyUp = keysDown.e ? 'e' : null;
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
  hm.pass.aimX = clamp(hm.pass.aimX, -4, C.FIELD.W + 4);
  hm.pass.aimY = clamp(hm.pass.aimY, -4, C.FIELD.H + 4);
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
  var cx = cameraX();
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

function qteMark(qte, now) {
  var segs = (qte && qte.segments) || [0.6, 1.1, 0.3];
  var segMs = (qte && qte.segMs) || 640;
  var elapsed = Math.max(0, now - (ui.qteStart || now));
  var idx = Math.floor(elapsed / segMs) % segs.length;
  var u = (elapsed % segMs) / segMs;
  var phase = (u * segs[idx]) % 2;
  return phase <= 1 ? phase : 2 - phase;
}
function confirmQte() {
  if (!state || !state.decision || state.decision.kind !== 'qte' || ui.choosing) return;
  var mark = qteMark(state.decision.qte, Date.now());
  sendCommand({ id: 'qte-hit', enabled: true, cost: 0 }, { mark: Math.round(mark * 1000) / 1000 });
}
function drawPenaltyQte(d) {
  var key = (d.playerId || '') + ':' + (d.shotId || '') + ':' + ((d.qte && d.qte.segments) || []).join(',');
  if (ui.qteKey !== key) { ui.qteKey = key; ui.qteStart = Date.now(); }
  var mark = qteMark(d.qte, Date.now());
  var bw = 520, bh = 36, bx = (W - bw) / 2, by = 470;
  ctx.fillStyle = 'rgba(8,12,26,0.88)';
  rr(bx - 16, by - 78, bw + 32, 150, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(255,217,74,0.85)'; ctx.lineWidth = 2;
  rr(bx - 16, by - 78, bw + 32, 150, 12); ctx.stroke();
  text('点球 · 光标靠近中间时按确定', W / 2, by - 48, 22, '#ffd94a', 'center', true);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  rr(bx, by, bw, bh, 8); ctx.fill();
  var sweet = bw * 0.12;
  ctx.fillStyle = 'rgba(90,220,120,0.55)';
  ctx.fillRect(bx + bw / 2 - sweet / 2, by, sweet, bh);
  var mx = bx + mark * bw;
  ctx.fillStyle = '#ffd94a';
  ctx.beginPath();
  ctx.moveTo(mx, by - 8);
  ctx.lineTo(mx - 10, by - 22);
  ctx.lineTo(mx + 10, by - 22);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(mx - 3, by, 6, bh);
  text('确定  =  E', W / 2, by + 58, 20, '#fff', 'center', true);
}

function drawHeadMenu() {
  var d = state.decision;
  if (!d) { ui.hmenu = null; return; }
  if (d.kind === 'qte') { drawPenaltyQte(d); return; }
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
  else if (d.kind === 'taker' || d.kind === 'penalty-shot' || d.kind === 'setpiece') drawSetPieceMenu(lvl, d);
  else drawHmList(lvl, pr, cx, headY);
  drawHmLanding(hm);
}

// setpiece-menu-v2：小屏按 CSS 像素放大主罚名单，躲开摇杆和虚拟键。
function paintScale() {
  var cv = document.getElementById('game');
  if (!cv || !cv.getBoundingClientRect) return 1;
  var r = cv.getBoundingClientRect();
  var s = Math.min(r.width / W, r.height / H);
  if (!(s > 0.2 && s < 4)) return 1;
  return s;
}
function drawSetPieceMenu(lvl, d) {
  var items = lvl.items || [];
  var title = '定位球';
  if (d.kind === 'taker') title = '选择主罚';
  else if (d.kind === 'penalty-shot' || lvl.kind === 'shots') title = '选择射门';
  else if (lvl.title) title = lvl.title;
  var cols = 0;
  items.forEach(function (it) {
    if (it.stats && it.stats.length > cols) cols = it.stats.length;
  });
  var scale = paintScale();
  var cssPx = function (css) { return Math.ceil(css / scale); };
  var nameSize = Math.max(16, cssPx(14));
  var statSize = Math.max(15, cssPx(14));
  var titleSize = Math.max(18, cssPx(15));
  var shortStat = { '角球': '角', '长传': '长', '传中': '传', '射门': '射', '任意球': '任', '心理': '心' };
  var useShort = false;
  var left = 332;
  if (isTouch) {
    try {
      var wrap = document.getElementById('wrap').getBoundingClientRect();
      var cvb = cv.getBoundingClientRect();
      var sc = Math.min(cvb.width / W, cvb.height / H) || 1;
      var offX = (cvb.width - W * sc) / 2;
      var zoneRight = (wrap.left + wrap.width * 0.40 - cvb.left - offX) / sc + 18;
      if (zoneRight > left) left = Math.min(560, zoneRight);
    } catch (err) {}
  }
  var right = isTouch ? 1000 : 1044;
  var top = 148;
  var bottom = 544;
  function statText(st) {
    var k = useShort && shortStat[st.k] ? shortStat[st.k] : st.k;
    return k + ' ' + st.v;
  }
  function layout() {
    var fontName = 'bold ' + nameSize + 'px "PingFang SC","Microsoft YaHei",monospace';
    ctx.font = fontName;
    var nameW = 96;
    items.forEach(function (it) {
      var label = String(it.label || '').replace(/^[•·]\s*/, '');
      var tw = ctx.measureText('▶ ' + label).width + 8;
      if (tw > nameW) nameW = tw;
    });
    var colW = 0;
    if (cols) {
      ctx.font = statSize + 'px "PingFang SC","Microsoft YaHei",monospace';
      items.forEach(function (it) {
        (it.stats || []).forEach(function (st) {
          var tw = ctx.measureText(statText(st)).width + Math.ceil(statSize * 0.65);
          if (tw > colW) colW = tw;
        });
      });
    }
    var w = cols ? (18 + nameW + cols * colW + 14) : 420;
    return { nameW: nameW, colW: colW, w: w };
  }
  var box = layout();
  if (box.w > right - left && cols) {
    useShort = true;
    box = layout();
  }
  var maxW = right - left;
  if (box.w > maxW) box.w = maxW;
  var headH = Math.max(40, titleSize + 18);
  var rowH = Math.max(nameSize + 10, statSize + 10);
  var maxRows = Math.max(4, Math.floor((bottom - top - headH - 14) / rowH));
  var visible = Math.min(items.length, maxRows);
  var scroll = 0;
  if (visible < items.length) {
    var sel = lvl.sel || 0;
    scroll = sel - Math.floor((visible - 1) / 2);
    if (scroll < 0) scroll = 0;
    if (scroll > items.length - visible) scroll = items.length - visible;
  }
  var h = headH + visible * rowH + 12;
  var x = left;
  var y = top;
  if (y + h > bottom) y = Math.max(top, bottom - h);
  ctx.fillStyle = 'rgba(8,12,26,0.97)';
  rr(x, y, box.w, h, 10); ctx.fill();
  ctx.strokeStyle = '#ffd94a'; ctx.lineWidth = 2;
  rr(x, y, box.w, h, 10); ctx.stroke();
  text(title, x + 16, y + headH / 2, titleSize, '#ffd94a', 'left', true);
  var hint = visible < items.length ? '上/下翻' : '确定 = E';
  text(hint, x + box.w - 14, y + headH / 2, Math.max(13, cssPx(12)), '#9fb4dd', 'right');
  for (var vi = 0; vi < visible; vi++) {
    var i = scroll + vi;
    var it = items[i];
    var ry = y + headH + vi * rowH;
    if (i === lvl.sel) {
      ctx.fillStyle = 'rgba(255,217,74,0.18)';
      ctx.fillRect(x + 8, ry + 2, box.w - 16, rowH - 4);
    }
    var color = !it.enabled ? '#5a6584' : it.back ? '#9fb4dd' : (i === lvl.sel ? '#ffd94a' : '#ffffff');
    var label = String(it.label || '').replace(/^[•·]\s*/, '');
    text((i === lvl.sel ? '▶ ' : '') + label, x + 14, ry + rowH / 2, nameSize, color, 'left', true);
    if (it.stats && it.stats.length) {
      it.stats.forEach(function (st, si) {
        text(statText(st), x + 12 + box.nameW + si * box.colW, ry + rowH / 2, statSize, it.enabled ? '#d5e2ff' : '#4a5468', 'left');
      });
    } else if (it.sub) {
      text(it.sub, x + box.w - 12, ry + rowH / 2, statSize, it.enabled ? '#d5e2ff' : '#4a5468', 'right');
    }
    (function (item, idx) {
      addClick(x + 8, ry, box.w - 16, rowH, function () {
        if (!item.enabled) { toast('体能不足或该球员无法使用'); return; }
        lvl.sel = idx; item.fn();
      });
    })(it, i);
  }
  if (DEBUG) {
    window.__menuBox = {
      x: x, y: y, w: box.w, h: h, nameSize: nameSize, statSize: statSize,
      scale: scale, css: +(nameSize * scale).toFixed(2), rows: visible, total: items.length, short: useShort,
    };
  }
}

function drawHmList(lvl, pr, cx, headY) {
  var items = lvl.items, lineH = 40, titleH = lvl.title ? 30 : 0;
  var totalH = items.length * lineH + titleH;
  var yTop = headY - totalH;
  if (yTop < 64) yTop = pr.y + 30; // 头顶空间不足 → 改放脚下
  if (yTop + totalH > 540) yTop = 540 - totalH; // ★ 不遮挡底部 UI 区
  if (yTop < 64) yTop = 64;
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
  addClick(0, 0, W, 556, function (mx, my) {
    var c = clientOfCanvas(mx, my);
    if (isTouch && touchInControl(c.x, c.y, { x: mx, y: my })) return;
    setAimFromScreen(mx, my);
  });
  var rp = renderPos[p.id] || p;
  var pp = project(rp.x, rp.y);
  var ap0 = project(hm.pass.aimX, hm.pass.aimY);
  var ap = safeAimScreen(ap0.x, ap0.y);
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
  var dx = hm.pass.aimX - p.x, dy = hm.pass.aimY - p.y;
  var dist = Math.sqrt(dx * dx + dy * dy);
  var pow = Math.round((dist - AIM_MIN) / (AIM_MAX - AIM_MIN) * 100);
  drawAimReadout(ap, cx, headY, dist, pow);
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
  var lp0 = project(pv.x, pv.y);
  var lpSafe = safeAimScreen(lp0.x, lp0.y);
  var lp = { x: lpSafe.x, y: lpSafe.y, s: lp0.s };
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
}

// 落点读数单独成块：一行距离和力量，提示小一号放在下面，躲开继续/返回。
function drawAimReadout(ap, cx, headY, dist, pow) {
  var scale = paintScale();
  var size1 = Math.max(22, Math.ceil(15 / scale));
  var size2 = Math.max(16, Math.ceil(12 / scale));
  var line1 = dist.toFixed(0) + '米 · 力量' + pow + '%';
  var line2 = isTouch ? '摇杆移动落点 · 确定确认' : '方向键/WASD 微调 · Shift 更精细';
  ctx.font = 'bold ' + size1 + 'px "PingFang SC","Microsoft YaHei",sans-serif';
  var w1 = ctx.measureText(line1).width;
  ctx.font = size2 + 'px "PingFang SC","Microsoft YaHei",sans-serif';
  var w2 = ctx.measureText(line2).width;
  var w = Math.max(w1, w2);
  var gap = Math.max(12, Math.ceil(8 / scale));
  var h = size1 + gap + size2;
  var menu = { l: cx - 150, r: cx + 150, t: headY - 58, b: headY + 40 };
  function hits(x, top) {
    var l = x - w / 2 - 8, r = x + w / 2 + 8;
    return l < menu.r && r > menu.l && top < menu.b && top + h > menu.t;
  }
  var grass = 176;
  var floor = 508;
  function fit(cx0, top0) {
    var x0 = clamp(cx0, w / 2 + 16, Math.min(960, W - 16) - w / 2);
    if (top0 < grass || top0 + h > floor) return null;
    if (hits(x0, top0)) return null;
    return { x: x0, top: top0 };
  }
  var place = fit(ap.x, ap.y - 36 - h)
    || fit(ap.x, ap.y + 36)
    || fit(ap.x - w / 2 - 52, ap.y - h / 2)
    || fit(ap.x + w / 2 + 52, ap.y - h / 2)
    || fit(cx, menu.t - h - 18)
    || fit(cx, menu.b + 16)
    || { x: clamp(ap.x, w / 2 + 16, 720), top: grass };
  hmText(line1, place.x, place.top + size1 / 2, size1, '#ffd94a');
  hmText(line2, place.x, place.top + size1 + gap + size2 / 2, size2, '#d6e6ff', false);
}

// 头顶菜单键盘操作（决策暂停期间接管键盘）
function headMenuKey(e) {
  var hm = ui.hmenu, lvl = hmTop();
  if (!hm || !lvl) return false;
  var k = (e.key || '').toLowerCase();
  // 打开菜单的 E，以及刚弹出的 280ms 内，不确认。回车和空格不受这道锁影响。
  if (k === 'e' && (ui.menuNeedKeyUp === 'e' || Date.now() < (ui.menuArmUntil || 0))) {
    e.preventDefault();
    return true;
  }
  // ★ Q = 取消/返回上一级（和 Esc 一样）
  if (k === 'q') { headMenuBack(); e.preventDefault(); return true; }
  // ★ 按住 E 开菜单时 repeat 不触发确认，松开重按才确认（防"一按就连开带确认"误触）
  var eConfirm = (k === 'enter' || k === ' ' || (k === 'e' && !e.repeat));
  function moveList(d) {
    var n = lvl.items.length, i = lvl.sel == null ? 0 : lvl.sel;
    for (var c = 0; c < n; c++) { i = (i + d + n) % n; if (lvl.items[i].enabled) break; }
    lvl.sel = i;
  }
  function activateList() {
    if (ui.choosing) return;
    var it = lvl.items[lvl.sel];
    if (it && it.enabled) it.fn();
    else if (it) toast('体能不足或该球员无法使用');
  }
  var handled = true;
  if (lvl.kind === 'aim') {
    // ★ 落点光标：方向键/WASD 精细移动（Shift 更精细），回车/E 确认
    var step = e.shiftKey ? 0.4 : 1.5;
    if (k === 'arrowup' || k === 'w') nudgeAim(0, step);
    else if (k === 'arrowdown' || k === 's') nudgeAim(0, -step);
    else if (k === 'arrowleft' || k === 'a') nudgeAim(-step, 0);
    else if (k === 'arrowright' || k === 'd') nudgeAim(step, 0);
    else if (eConfirm) { pushHmLevel(techLevel()); requestHmPreview(); }
    else handled = false;
  } else if (lvl.kind === 'confirm') {
    if (k === 'arrowup' || k === 'w' || k === 'arrowdown' || k === 's') lvl.sel = (lvl.sel || 0) === 0 ? 1 : 0;
    else if (eConfirm) { if ((lvl.sel || 0) === 0) hmConfirmPass(); else popHmLevel(); }
    else handled = false;
  } else {
    // 普通列表（顶层指令/脚法/高度）：方向键/WASD 移动，回车/E/空格确认
    if (k === 'arrowup' || k === 'w') moveList(-1);
    else if (k === 'arrowdown' || k === 's') moveList(1);
    else if (eConfirm) activateList();
    else handled = false;
  }
  if (handled) e.preventDefault();
  return handled;
}
function togglePause(force) {
  var target = typeof force === 'boolean' ? force : !ui.pauseOpen;
  ui.pauseOpen = target;
  if (target) ui.pauseSel = 0;
  api.post('/api/match/' + matchId + '/pause', { paused: target });
}
function pauseItems() {
  return [
    { label: '继续比赛', fn: function () {
        togglePause(false);
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
}
function activatePause() {
  var items = pauseItems();
  var it = items[ui.pauseSel || 0];
  if (it) it.fn();
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
// ---------------- 业余联赛生涯 ----------------
var careerSave = null;
function careerApi() { return (typeof Career !== 'undefined') ? Career : (typeof window !== 'undefined' ? window.Career : null); }
function rememberCareer(why) {
  var C = careerApi();
  window.__career = careerSave;
  if (!C || !careerSave) return { ok: false };
  var wrote = C.writeSlot(null, 'auto', careerSave);
  if (!wrote.ok) toast(wrote.error || '自动保存失败', 2800);
  else if (why === 'auto') toast('已自动保存', 1500);
  return wrote;
}
function loadCareer() {
  var C = careerApi();
  if (!C) return null;
  var latest = C.latestSlot();
  if (!latest || latest.empty || latest.damaged || !latest.career) return null;
  var loaded = C.loadSlot(null, latest.slot);
  if (!loaded.ok || !loaded.career) return null;
  careerSave = loaded.career;
  window.__career = careerSave;
  ui.slotFocus = loaded.slot;
  return careerSave;
}
function formatSaveTime(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function slotRecords() {
  var C = careerApi();
  if (!C) return [];
  try { return C.listSlots(); } catch (e) { return []; }
}
function slotRowView(info) {
  var title = info.label || info.slot;
  if (info.damaged) return { title: title, sub: '存档损坏  ·  ' + (info.error || '无法读取'), time: '', tone: 'bad' };
  if (info.empty) return { title: title, sub: '空位', time: '', tone: 'empty' };
  var s = info.summary || {};
  var rank = s.rank ? ('第' + s.rank + '名') : '未排名';
  return {
    title: title,
    time: formatSaveTime(info.savedAt),
    tone: 'ok',
    sub: (s.clubName || '未知球队') + '  第' + (s.season || 1) + '赛季  ' + rank + '  ·  ' + (s.round || '赛季结束') + '   预算 ' + (s.budget != null ? s.budget : 0),
  };
}
function focusedSlotId() {
  var rows = screen === 'title' ? titleActions() : careerRows();
  var sel = ui.menuSel || 0;
  if (rows[sel] && rows[sel].slotId) return rows[sel].slotId;
  return ui.slotFocus || 'auto';
}
function downloadSave(filename, text) {
  try {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 1500);
  } catch (e) {
    toast('导出失败');
  }
}
function exportFocused() {
  var C = careerApi();
  if (!C) return;
  var id = focusedSlotId();
  ui.slotFocus = id;
  var r = C.exportSlot(null, id);
  if (!r.ok) { toast(r.error || '导不出'); return; }
  downloadSave(r.filename, r.text);
  toast('已导出 ' + C.slotTitle(id));
}
function importFocused() {
  var id = focusedSlotId();
  ui.slotFocus = id;
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json,text/plain';
  input.onchange = function () {
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      var C = careerApi();
      var peek = C.peekImport(text);
      if (!peek.ok) { toast(peek.error || '读不了这个文件'); return; }
      var existing = C.readSlot(null, id);
      if (existing && !existing.empty && !existing.damaged) {
        openSaveAsk('import', { slot: id, text: text, summary: peek.summary, savedAt: peek.savedAt, empty: false, damaged: false });
        return;
      }
      var r = C.importSlot(null, id, text);
      toast(r.ok ? ('已导入到' + C.slotTitle(id)) : (r.error || '导入失败'));
    };
    reader.readAsText(file);
  };
  input.click();
}
function saveActionRows(mode) {
  var rows = slotRecords().map(function (info) {
    var view = slotRowView(info);
    var enabled = true;
    if (mode === 'load' && (info.empty || info.damaged)) enabled = false;
    if (mode === 'delete' && info.empty) enabled = false;
    return {
      slotId: info.slot,
      slotInfo: info,
      label: view.title,
      sub: view.sub,
      time: view.time,
      tone: view.tone,
      enabled: enabled,
      fn: function () { activateSlot(mode, info); },
    };
  });
  if (mode === 'save' || mode === 'load' || mode === 'new') {
    rows.push({ label: '导出选中的存档', utility: true, fn: exportFocused });
    rows.push({ label: '导入到选中的位置', utility: true, fn: importFocused });
  }
  rows.push({
    back: true,
    label: '返回',
    fn: function () {
      ui.saveAsk = null;
      if (screen === 'title') { ui.titleView = 'main'; ui.menuSel = 0; }
      else { ui.careerView = 'hub'; ui.menuSel = 0; }
    },
  });
  return rows;
}
function askRows() {
  var ask = ui.saveAsk || {};
  var danger = ask.mode === 'delete';
  return [
    { label: danger ? '确定删除' : '确定覆盖', danger: danger, fn: confirmSaveAsk },
    { label: '取消', fn: cancelSaveAsk },
  ];
}
function openSaveAsk(mode, info) {
  ui.saveAsk = { mode: mode, slot: info.slot, info: info, text: info.text || '', summary: info.summary || null };
  ui.menuSel = 0;
  if (screen === 'title') {
    ui.titleReturn = ui.titleView === 'ask' ? (ui.titleReturn || 'new') : (ui.titleView || 'new');
    ui.titleView = 'ask';
  } else {
    ui.careerView = 'save-ask';
  }
}
function cancelSaveAsk() {
  ui.saveAsk = null;
  ui.menuSel = 0;
  if (screen === 'title') ui.titleView = ui.titleReturn || 'new';
  else ui.careerView = 'save';
}
function confirmSaveAsk() {
  var ask = ui.saveAsk;
  if (!ask) return;
  var C = careerApi();
  if (ask.mode === 'delete') {
    var removed = C.deleteSlot(null, ask.slot);
    toast(removed.ok ? ('已删除' + C.slotTitle(ask.slot)) : (removed.error || '删不掉'));
    cancelSaveAsk();
    return;
  }
  if (ask.mode === 'new') { createInto(ask.slot); return; }
  if (ask.mode === 'save') { commitManualSave(ask.slot); return; }
  if (ask.mode === 'import') {
    var imported = C.importSlot(null, ask.slot, ask.text);
    toast(imported.ok ? ('已导入到' + C.slotTitle(ask.slot)) : (imported.error || '导入失败'));
    cancelSaveAsk();
  }
}
function activateSlot(mode, info) {
  var C = careerApi();
  if (!C) return;
  ui.slotFocus = info.slot;
  if (mode === 'load') {
    if (info.empty) { toast('这个位置是空的'); return; }
    if (info.damaged) { toast(info.error || '这份存档损坏了'); return; }
    var loaded = C.loadSlot(null, info.slot);
    if (!loaded.ok || !loaded.career) { toast((loaded && loaded.error) || '读不出来'); return; }
    adoptCareer(loaded);
    return;
  }
  if (mode === 'delete') {
    if (info.empty) { toast('这个位置是空的'); return; }
    openSaveAsk('delete', info);
    return;
  }
  if ((mode === 'save' || mode === 'new') && !info.empty && !info.damaged) {
    openSaveAsk(mode, info);
    return;
  }
  if (mode === 'new') createInto(info.slot);
  else commitManualSave(info.slot);
}
function createInto(slotId) {
  var C = careerApi();
  if (!C) { toast('生涯模块没载入'); return; }
  careerSave = C.newCareer((Date.now() % 99991) >>> 0);
  var wrote = C.writeSlot(null, slotId, careerSave);
  if (!wrote.ok) { toast(wrote.error || '新档没写上'); return; }
  if (slotId !== 'auto') {
    var auto = C.writeSlot(null, 'auto', careerSave);
    if (!auto.ok) toast(auto.error || '自动存档没写上', 2800);
  }
  ui.saveAsk = null;
  ui.titleView = 'main';
  ui.slotFocus = slotId;
  screen = 'career';
  ui.careerView = 'hub';
  ui.menuSel = 0;
  ui.careerFix = null;
  window.__career = careerSave;
  toast('新档已写入' + C.slotTitle(slotId));
}
function commitManualSave(slotId) {
  var C = careerApi();
  if (!C || !careerSave) { toast('没有进行中的生涯'); return; }
  var wrote = C.writeSlot(null, slotId, careerSave);
  if (!wrote.ok) { toast(wrote.error || '保存失败', 2800); return; }
  ui.saveAsk = null;
  ui.slotFocus = slotId;
  ui.careerView = 'hub';
  ui.menuSel = 0;
  toast('已保存到' + C.slotTitle(slotId));
}
function adoptCareer(loaded) {
  careerSave = loaded.career;
  window.__career = careerSave;
  ui.slotFocus = loaded.slot;
  ui.saveAsk = null;
  ui.titleView = 'main';
  screen = 'career';
  ui.careerView = 'hub';
  ui.menuSel = 0;
  var warn = loaded.warnings && loaded.warnings.length ? ('  ' + loaded.warnings[0]) : '';
  toast('已读取' + (loaded.label || '') + warn, warn ? 3200 : 1600);
}
function askNoteLines() {
  var ask = ui.saveAsk;
  if (!ask) return [];
  var C = careerApi();
  var name = C ? C.slotTitle(ask.slot) : ask.slot;
  var info = ask.info || {};
  var s = info.summary || ask.summary || {};
  var when = formatSaveTime(info.savedAt || ask.savedAt);
  var who = s.clubName ? (s.clubName + '  第' + (s.season || 1) + '赛季' + (s.rank ? ('  第' + s.rank + '名') : '')) : '';
  if (ask.mode === 'delete') return ['删除' + name + '？删了就找不回来', who, when];
  if (ask.mode === 'import') return ['把备份导入' + name + '？会盖掉现在这份', who, when];
  if (ask.mode === 'new') return ['在' + name + '新开生涯？会盖掉现在这份', who, when];
  return ['覆盖' + name + '？', who, when];
}
function inSettings() {
  return (screen === 'title' && ui.titleView === 'settings') || (screen === 'career' && ui.careerView === 'settings');
}
function currentHalfOpt() {
  for (var i = 0; i < HALF_OPTS.length; i++) if (HALF_OPTS[i].value === ui.halfLength) return HALF_OPTS[i];
  return HALF_OPTS[1];
}
function currentMentalityOpt() {
  for (var i = 0; i < MENTALITY_OPTS.length; i++) if (MENTALITY_OPTS[i].value === ui.mentality) return MENTALITY_OPTS[i];
  return MENTALITY_OPTS[0];
}
function cycleSetting(kind, dir) {
  var opts = kind === 'half' ? HALF_OPTS : MENTALITY_OPTS;
  var cur = kind === 'half' ? ui.halfLength : ui.mentality;
  var i = 0;
  for (var n = 0; n < opts.length; n++) if (opts[n].value === cur) i = n;
  i = (i + dir + opts.length) % opts.length;
  if (kind === 'half') ui.halfLength = opts[i].value;
  else ui.mentality = opts[i].value;
  saveSettings();
}
function nudgeSetting(dir) {
  var rows = settingRows();
  var row = rows[ui.menuSel || 0];
  if (!row || !row.kind) return;
  cycleSetting(row.kind, dir);
}
function settingRows() {
  return [
    { kind: 'half', label: '半场时长', value: currentHalfOpt().label, fn: function () { cycleSetting('half', 1); } },
    { kind: 'mentality', label: '战术倾向', value: currentMentalityOpt().label, fn: function () { cycleSetting('mentality', 1); } },
    { label: '返回', back: true, fn: function () { backCareer(); } },
  ];
}
function loadSettings() {
  try {
    var raw = localStorage.getItem('soccer-rpg-settings');
    if (!raw) return;
    var data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return;
    if (HALF_OPTS.some(function (o) { return o.value === data.halfLength; })) ui.halfLength = data.halfLength;
    if (MENTALITY_OPTS.some(function (o) { return o.value === data.mentality; })) ui.mentality = data.mentality;
  } catch (e) {}
}
function saveSettings() {
  try {
    localStorage.setItem('soccer-rpg-settings', JSON.stringify({
      schema: 1,
      halfLength: ui.halfLength,
      mentality: ui.mentality,
    }));
  } catch (e) {
    toast('设置没写上，存储空间可能不够');
  }
}
function titleActions() {
  if (ui.titleView === 'ask') return askRows();
  if (ui.titleView === 'settings') return settingRows();
  if (ui.titleView === 'new' || ui.titleView === 'load') return saveActionRows(ui.titleView === 'new' ? 'new' : 'load');
  var latest = null;
  var C = careerApi();
  if (C) { try { latest = C.latestSlot(); } catch (e) {} }
  var has = !!(latest && latest.career);
  return [
    { label: '开始比赛', fn: function () { ui.careerFix = null; startMatch(); } },
    { label: '继续（最近存档）', enabled: has, fn: function () { resumeCareer(); } },
    { label: '新建生涯', fn: function () { ui.titleView = 'new'; ui.menuSel = 0; } },
    { label: '读取存档', fn: function () { ui.titleView = 'load'; ui.menuSel = 0; } },
    { label: '设置', fn: function () { ui.titleView = 'settings'; ui.menuSel = 0; } },
  ];
}
function careerRows() {
  var C = careerApi();
  if (!C || !careerSave) return [];
  if (ui.careerView === 'table') {
    return C.ranked(careerSave).map(function (r, i) {
      var gd = r.gd > 0 ? ('+' + r.gd) : String(r.gd);
      return {
        cells: {
          rank: String(i + 1),
          name: C.teamName(careerSave, r.teamId),
          p: String(r.p), w: String(r.w), d: String(r.d), l: String(r.l),
          gf: String(r.gf), ga: String(r.ga), gd: gd, pts: String(r.pts),
        },
        own: r.teamId === careerSave.clubId,
        fn: function () {},
      };
    }).concat([{ back: true, label: '返回', fn: function () { ui.careerView = 'hub'; ui.menuSel = 0; } }]);
  }
  if (ui.careerView === 'fixtures') {
    var mine = careerSave.calendar.fixtures.filter(function (f) {
      return f.homeId === careerSave.clubId || f.awayId === careerSave.clubId;
    });
    return mine.map(function (f) {
      var opp = f.homeId === careerSave.clubId ? f.awayId : f.homeId;
      var where = f.homeId === careerSave.clubId ? '主' : '客';
      var tag = f.status === 'played' ? (f.hg + '-' + f.ag) : (f.postponed ? '延期' : '未赛');
      var comp = f.competitionId === 'example-cup' ? '杯赛' : '联赛';
      return { label: '第' + (f.date + 1) + '轮 ' + comp + ' ' + where + ' ' + C.teamName(careerSave, opp) + '  ' + tag, fn: function () {} };
    }).concat([{ label: '返回', fn: function () { ui.careerView = 'hub'; ui.menuSel = 0; } }]);
  }
  if (ui.careerView === 'squad') {
    return careerSave.squad.map(function (p) {
      return {
        cells: {
          pos: p.pos,
          name: p.name,
          age: String(p.age),
          ovr: String(p.ovr || 0),
          wage: String(p.wage),
          fee: String(p.fee || 0),
          xi: careerSave.xi.indexOf(p.id) >= 0 ? '是' : '·',
        },
        fn: function () { trySell(p.id); },
      };
    }).concat([{ back: true, label: '返回', fn: function () { ui.careerView = 'hub'; ui.menuSel = 0; } }]);
  }
  if (ui.careerView === 'market') {
    return careerSave.market.map(function (L) {
      var p = L.player;
      return {
        cells: {
          pos: p.pos,
          name: p.name,
          age: String(p.age),
          ovr: String(p.ovr || 0),
          wage: String(p.wage),
          fee: String(L.fee),
        },
        fn: function () { tryBuy(L.id); },
      };
    }).concat([{ back: true, label: '返回', fn: function () { ui.careerView = 'hub'; ui.menuSel = 0; } }]);
  }
  if (ui.careerView === 'xi') {
    return C.XI_SLOTS.map(function (slot, i) {
      var p = null;
      careerSave.squad.forEach(function (q) { if (q.id === careerSave.xi[i]) p = q; });
      return { label: slot.num + ' ' + slot.pos + '  ' + (p ? p.name : '空'), fn: function () { cycleSlot(i); } };
    }).concat([{ label: '返回', fn: function () { ui.careerView = 'hub'; ui.menuSel = 0; } }]);
  }
  if (ui.careerView === 'end') {
    return [
      { label: '开始新赛季', fn: function () { rollCareer(); } },
      { label: '返回标题', fn: function () { screen = 'title'; ui.titleView = 'main'; ui.menuSel = 0; } },
    ];
  }
  if (ui.careerView === 'save') return saveActionRows(ui.saveMode || 'save');
  if (ui.careerView === 'save-ask') return askRows();
  if (ui.careerView === 'settings') return settingRows();
  if (ui.careerView === 'files') {
    return [
      { label: '保存', fn: function () { ui.careerView = 'save'; ui.saveMode = 'save'; ui.menuSel = 0; } },
      { label: '读取', fn: function () { ui.careerView = 'save'; ui.saveMode = 'load'; ui.menuSel = 0; } },
      { label: '删除', fn: function () { ui.careerView = 'save'; ui.saveMode = 'delete'; ui.menuSel = 0; } },
      { label: '返回', fn: function () { ui.careerView = 'hub'; ui.menuSel = 0; } },
    ];
  }
  var nxt = C.nextFixture(careerSave.calendar, careerSave.clubId);
  var rows = [];
  if (nxt) {
    var opp = nxt.homeId === careerSave.clubId ? nxt.awayId : nxt.homeId;
    var where = nxt.homeId === careerSave.clubId ? '主场' : '客场';
    var comp = nxt.competitionId === 'example-cup' ? '示例杯赛' : '业余联赛';
    rows.push({ label: '开踢 ' + comp + ' ' + where + ' vs ' + C.teamName(careerSave, opp), fn: startCareerMatch });
  } else {
    rows.push({ label: '赛季结束，查看排名', fn: function () { ui.careerView = 'end'; ui.menuSel = 0; } });
  }
  rows.push({ label: '阵容', fn: function () { ui.careerView = 'squad'; ui.menuSel = 0; } });
  rows.push({ label: '首发', fn: function () { ui.careerView = 'xi'; ui.menuSel = 0; } });
  rows.push({ label: '积分榜', fn: function () { ui.careerView = 'table'; ui.menuSel = 0; } });
  rows.push({ label: '转会', fn: function () { ui.careerView = 'market'; ui.menuSel = 0; } });
  rows.push({ label: '赛程', fn: function () { ui.careerView = 'fixtures'; ui.menuSel = 0; } });
  rows.push({ label: '存档', fn: function () { ui.careerView = 'files'; ui.menuSel = 0; } });
  rows.push({ label: '设置', fn: function () { ui.careerView = 'settings'; ui.menuSel = 0; } });
  rows.push({ label: '返回标题', fn: function () { screen = 'title'; ui.titleView = 'main'; ui.menuSel = 0; } });
  return rows;
}
function careerRowCount() {
  if (screen === 'title') return titleActions().length;
  if (screen === 'career') return careerRows().length;
  return 0;
}
function stepCareer(dir) {
  stepSelection(function () { return ui.menuSel || 0; }, function (i) { ui.menuSel = i; }, careerRowCount, function (i) {
    var rows = screen === 'title' ? titleActions() : careerRows();
    return !rows[i] || rows[i].enabled !== false;
  }, dir);
}
function activateCareer() {
  var rows = screen === 'title' ? titleActions() : careerRows();
  var it = rows[ui.menuSel || 0];
  if (it && it.enabled !== false) it.fn();
}
function backCareer() {
  if (screen === 'title' && ui.titleView === 'ask') { cancelSaveAsk(); return; }
  if (screen === 'title' && ui.titleView && ui.titleView !== 'main') {
    ui.titleView = 'main'; ui.menuSel = 0; ui.saveAsk = null; return;
  }
  if (screen === 'career' && ui.careerView === 'save-ask') { cancelSaveAsk(); return; }
  if (screen === 'career' && ui.careerView && ui.careerView !== 'hub') {
    ui.careerView = 'hub'; ui.menuSel = 0; return;
  }
  if (screen === 'career') { screen = 'title'; ui.titleView = 'main'; ui.menuSel = 0; }
}
function openNewCareer() {
  ui.titleView = 'new';
  ui.menuSel = 0;
}
function resumeCareer() {
  var C = careerApi();
  if (!C) { toast('没有存档'); return; }
  var latest = C.latestSlot();
  if (!latest || !latest.career) { toast('没有存档'); return; }
  var loaded = C.loadSlot(null, latest.slot);
  if (!loaded.ok || !loaded.career) { toast((loaded && loaded.error) || '没有存档'); return; }
  adoptCareer(loaded);
}
function tryBuy(id) {
  var C = careerApi();
  var r = C.buy(careerSave, id);
  toast(r.ok ? '已买入 · 已自动保存' : r.error);
  if (r.ok) rememberCareer();
}
function trySell(id) {
  var C = careerApi();
  if (careerSave.xi.indexOf(id) >= 0) { toast('先到首发里换下来'); return; }
  var r = C.sell(careerSave, id);
  toast(r.ok ? '已卖出 · 已自动保存' : r.error);
  if (r.ok) rememberCareer();
}
function cycleSlot(i) {
  var C = careerApi();
  var r = C.cycleXI(careerSave, i);
  toast(r.ok ? ('换成 ' + r.player.name) : r.error);
  if (r.ok) rememberCareer();
}
function rollCareer() {
  var C = careerApi();
  C.rollSeason(careerSave);
  rememberCareer('auto');
  ui.careerView = 'hub';
  ui.menuSel = 0;
  if (ui.toast === '已自动保存') toast('新赛季开始 · 已自动保存');
}
function startCareerMatch() {
  var C = careerApi();
  var fx = C.nextFixture(careerSave.calendar, careerSave.clubId);
  if (!fx) { ui.careerView = 'end'; return; }
  var homeId = fx.homeId, awayId = fx.awayId;
  function side(id) {
    if (id === careerSave.clubId) return C.lineupPlayers(careerSave.squad, careerSave.xi);
    var team = null;
    careerSave.teams.forEach(function (t) { if (t.id === id) team = t; });
    var xi = C.autoXI(team.squad);
    return C.lineupPlayers(team.squad, xi);
  }
  var home = side(homeId), away = side(awayId);
  if (!home || !away) { toast('阵容不齐，先排首发'); return; }
  ui.careerFix = fx.id;
  ui.careerFixDone = false;
  var userHome = homeId === careerSave.clubId;
  startMatch({
    halfLength: ui.halfLength,
    homeSquad: userHome ? home : away,
    awaySquad: userHome ? away : home,
    homeName: C.teamName(careerSave, userHome ? homeId : awayId),
    awayName: C.teamName(careerSave, userHome ? awayId : homeId),
    seed: (careerSave.seed + fx.date * 17) >>> 0,
  });
}
function finishCareerIfDone() {
  var C = careerApi();
  if (!C || !careerSave || !ui.careerFix || ui.careerFixDone) return;
  if (!state || state.phase !== 'fulltime') return;
  ui.careerFixDone = true;
  var userHome = true;
  var fx = null;
  careerSave.calendar.fixtures.forEach(function (f) { if (f.id === ui.careerFix) fx = f; });
  if (fx) userHome = fx.homeId === careerSave.clubId;
  var hg = userHome ? state.score.home : state.score.away;
  var ag = userHome ? state.score.away : state.score.home;
  ui.careerLast = C.recordResult(careerSave, ui.careerFix, hg, ag);
  rememberCareer('auto');
}
function returnToCareer() {
  if (ui.refreshTimer) { clearInterval(ui.refreshTimer); ui.refreshTimer = null; }
  if (matchId) api.del('/api/match/' + matchId).catch(function () {});
  matchId = null;
  state = null;
  screen = 'career';
  ui.careerView = (ui.careerLast && ui.careerLast.done) ? 'end' : 'hub';
  ui.menuSel = 0;
  ui.pauseOpen = false;
  ui.careerFix = null;
}
// career-table-v1：积分榜、阵容、转会用固定列宽。数字右对齐，队名单独一列，本队高亮和光标分开。
var CAREER_COLS = {
  table: [
    { key: 'rank', label: '名次', align: 'right' },
    { key: 'name', label: '球队', align: 'left' },
    { key: 'p', label: '赛', align: 'right' },
    { key: 'w', label: '胜', align: 'right' },
    { key: 'd', label: '平', align: 'right' },
    { key: 'l', label: '负', align: 'right' },
    { key: 'gf', label: '进', align: 'right' },
    { key: 'ga', label: '失', align: 'right' },
    { key: 'gd', label: '净胜', align: 'right' },
    { key: 'pts', label: '积分', align: 'right' },
  ],
  squad: [
    { key: 'pos', label: '位置', align: 'left' },
    { key: 'name', label: '姓名', align: 'left' },
    { key: 'age', label: '年龄', align: 'right' },
    { key: 'ovr', label: '能力', align: 'right' },
    { key: 'wage', label: '周薪', align: 'right' },
    { key: 'fee', label: '转会费', align: 'right' },
    { key: 'xi', label: '首发', align: 'left' },
  ],
  market: [
    { key: 'pos', label: '位置', align: 'left' },
    { key: 'name', label: '姓名', align: 'left' },
    { key: 'age', label: '年龄', align: 'right' },
    { key: 'ovr', label: '能力', align: 'right' },
    { key: 'wage', label: '周薪', align: 'right' },
    { key: 'fee', label: '转会费', align: 'right' },
  ],
};
var CAREER_VIEW_NAME = { table: '积分榜', squad: '阵容', market: '转会', fixtures: '赛程', xi: '首发', files: '存档' };

function careerSafeLeft() {
  return isTouch ? 28 : 44;
}
function careerSafeRight() {
  if (!isTouch) return W - 36;
  var edge = W - 28;
  VKEYS.forEach(function (b) {
    var x = b.x - b.r - 20;
    if (x < edge) edge = x;
  });
  return Math.floor(edge);
}
function careerFont(css) {
  var scale = paintScale();
  return Math.max(15, Math.ceil(css / (scale || 1)));
}
function layoutCareerCols(headers, data, width) {
  var font = careerFont(14);
  var minFont = careerFont(11);
  if (minFont > font) minFont = font;
  var face = '"PingFang SC","Microsoft YaHei",monospace';
  var cols = [];
  var guard = 0;
  while (guard < 16) {
    guard++;
    ctx.font = 'bold ' + font + 'px ' + face;
    var pad = Math.max(6, Math.round(font * 0.5));
    var wantBadge = data.some(function (row) { return row.own; });
    cols = headers.map(function (h) {
      var w = ctx.measureText(h.label).width;
      data.forEach(function (row) {
        var s = row.cells && row.cells[h.key] != null ? String(row.cells[h.key]) : '';
        var tw = ctx.measureText(s).width;
        if (tw > w) w = tw;
      });
      var content = Math.ceil(w + pad);
      var floor = Math.ceil(font * (h.label.length >= 2 ? 2.7 : 2.2));
      if (h.key === 'name') floor = content + (wantBadge ? Math.ceil(font * 1.45) : 0);
      return { key: h.key, label: h.label, align: h.align, w: Math.max(content, floor) };
    });
    var sum = 0;
    cols.forEach(function (c) { sum += c.w; });
    if (sum <= width || font <= minFont) {
      if (sum > width && sum > 0) {
        var fit = width / sum;
        var used = 0;
        cols.forEach(function (c, i) {
          c.w = i === cols.length - 1 ? Math.max(8, width - used) : Math.max(8, Math.floor(c.w * fit));
          used += c.w;
        });
        if (used > width && cols.length) cols[cols.length - 1].w -= used - width;
      } else {
        var extra = width - sum;
        var nameCol = null;
        cols.forEach(function (c) { if (c.key === 'name') nameCol = c; });
        var others = cols.filter(function (c) { return c !== nameCol; });
        var nameShare = nameCol && others.length ? Math.round(extra * 0.28) : extra;
        var rest = extra - nameShare;
        var each = others.length ? Math.floor(rest / others.length) : 0;
        var leftover = others.length ? rest - each * others.length : 0;
        if (nameCol) nameCol.w += nameShare;
        others.forEach(function (c, i) { c.w += each + (i === others.length - 1 ? leftover : 0); });
      }
      break;
    }
    font -= 1;
  }
  var x = 0;
  cols.forEach(function (c) { c.x = x; x += c.w; });
  return { cols: cols, font: font };
}
function drawCareerColumns(rows, headers, size, small) {
  var C = careerApi();
  var data = [];
  var back = null;
  rows.forEach(function (r) { if (r.back) back = r; else data.push(r); });
  var left = careerSafeLeft();
  var right = careerSafeRight();
  if (right - left < 280) { left = isTouch ? 300 : 48; right = isTouch ? 1000 : W - 36; }
  var width = right - left;
  var lay = layoutCareerCols(headers, data, width);
  var font = lay.font;
  var headerH = font + 16;
  var rowH = font + 12;
  var backH = Math.max(font + 16, 36);
  var foot = Math.max(18, Math.round(small * 0.8));
  var helpY = H - foot;
  var bottom = helpY - foot - 52;
  var titleSize = Math.min(size + 4, font + 12);
  var titleY = 12 + titleSize / 2;
  var subY = titleY + titleSize / 2 + small / 2 + 8;
  var top = subY + small / 2 + 12;
  var buttonY = bottom - backH;
  var listTop = top + headerH;
  var listRoom = buttonY - 8 - listTop;
  var visible = data.length ? Math.max(1, Math.floor(listRoom / rowH)) : 0;
  if (visible > data.length) visible = data.length;
  var sel = ui.menuSel || 0;
  if (sel > data.length) sel = ui.menuSel = 0;
  var onBack = sel === data.length;
  var dataSel = onBack ? Math.max(0, data.length - 1) : sel;
  var scroll = 0;
  if (data.length > visible) {
    scroll = dataSel - Math.floor((visible - 1) / 2);
    if (scroll < 0) scroll = 0;
    if (scroll > data.length - visible) scroll = data.length - visible;
  }
  var unit = ui.careerView === 'table' ? '队' : '人';
  var posText = onBack ? ('共' + data.length + unit) : ((data.length ? sel + 1 : 0) + '/' + data.length);
  if (scroll > 0) posText = '↑ ' + posText;
  if (scroll + visible < data.length) posText += ' ↓';

  var viewName = CAREER_VIEW_NAME[ui.careerView] || '';
  var title = (C ? C.teamName(careerSave, careerSave.clubId) : '') + '  第' + careerSave.season + '赛季' + (viewName ? '  ·  ' + viewName : '');
  ctx.font = 'bold ' + small + 'px "PingFang SC","Microsoft YaHei",monospace';
  var pillW = Math.ceil(ctx.measureText(posText).width + small * 1.15);
  var pillH = small + 8;
  var pillX = right - pillW;
  var pillY = subY - pillH / 2;
  ctx.fillStyle = 'rgba(255,217,74,0.16)';
  rr(pillX, pillY, pillW, pillH, 6); ctx.fill();
  ctx.strokeStyle = 'rgba(255,217,74,0.75)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  text(posText, pillX + pillW / 2, subY, small, '#ffd94a', 'center', true);

  ctx.save();
  ctx.beginPath();
  ctx.rect(8, 0, Math.max(0, pillX - 16), subY + small);
  ctx.clip();
  text(title, left, titleY, titleSize, '#ffd94a', 'left', true);
  text('预算 ' + careerSave.budget + '    阵容 ' + careerSave.squad.length + '人', left, subY, small, '#d6e6ff', 'left');
  ctx.restore();

  ctx.fillStyle = 'rgba(6,10,22,0.82)';
  rr(left, top, width, headerH + Math.max(visible, 1) * rowH, 8); ctx.fill();
  ctx.fillStyle = '#16244a';
  ctx.fillRect(left + 2, top + 2, width - 4, headerH - 2);
  ctx.strokeStyle = 'rgba(255,217,74,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left + 10, top + headerH);
  ctx.lineTo(left + width - 10, top + headerH);
  ctx.stroke();
  var cellPad = Math.max(6, Math.round(font * 0.28));
  lay.cols.forEach(function (col) {
    var tx = col.align === 'right' ? left + col.x + col.w - cellPad : left + col.x + cellPad;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left + col.x + 1, top, col.w - 2, headerH);
    ctx.clip();
    text(col.label, tx, top + headerH / 2, font, '#ffd94a', col.align === 'right' ? 'right' : 'left', true);
    ctx.restore();
  });

  var posColor = { GK: '#e8b923', DF: '#8eb7ff', MF: '#8ee0b0', FW: '#ff9b9b' };
  for (var i = 0; i < visible; i++) {
    var idx = scroll + i;
    var row = data[idx];
    if (!row) continue;
    var y = listTop + i * rowH;
    var on = idx === sel;
    ctx.fillStyle = row.own ? 'rgba(32, 120, 72, 0.9)' : (idx % 2 ? 'rgba(12,20,40,0.9)' : 'rgba(8,14,28,0.84)');
    ctx.fillRect(left + 2, y + 1, width - 4, rowH - 2);
    if (row.own) {
      ctx.fillStyle = '#c8ffd8';
      ctx.fillRect(left + 2, y + 5, 6, rowH - 10);
    }
    if (on) {
      ctx.strokeStyle = '#ffd94a';
      ctx.lineWidth = 2;
      ctx.strokeRect(left + 3, y + 2, width - 6, rowH - 4);
    }
    lay.cols.forEach(function (col) {
      var raw = row.cells && row.cells[col.key] != null ? String(row.cells[col.key]) : '';
      var color = on ? '#fff6cc' : '#f3f6ff';
      var bold = !!(on || row.own);
      if (col.key === 'gd') {
        var n = parseInt(raw, 10) || 0;
        color = n > 0 ? '#b8ffc8' : n < 0 ? '#ffb0b0' : '#9fb4dd';
      } else if (col.key === 'pts') {
        color = '#ffd94a';
        bold = true;
      } else if (col.key === 'pos' && posColor[raw]) {
        color = posColor[raw];
        bold = true;
      } else if (col.key === 'name' && row.own) {
        color = '#f4fff7';
      }
      if (col.key === 'name' && on) color = '#ffd94a';
      var tx = col.align === 'right' ? left + col.x + col.w - cellPad : left + col.x + cellPad;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left + col.x + 1, y, col.w - 2, rowH);
      ctx.clip();
      text(raw, tx, y + rowH / 2, font, color, col.align === 'right' ? 'right' : 'left', bold);
      if (col.key === 'name' && row.own) {
        ctx.font = 'bold ' + font + 'px "PingFang SC","Microsoft YaHei",monospace';
        var nw = ctx.measureText(raw).width;
        var bw = Math.round(font * 1.15);
        var bh = Math.round(font * 0.76);
        var bx = tx + nw + Math.round(font * 0.22);
        if (bx + bw < left + col.x + col.w - 2) {
          ctx.fillStyle = '#ffd94a';
          rr(bx, y + rowH / 2 - bh / 2, bw, bh, 4);
          ctx.fill();
          text('我', bx + bw / 2, y + rowH / 2, Math.max(12, Math.round(font * 0.6)), '#3a2a00', 'center', true);
        }
      }
      ctx.restore();
    });
    (function (n, ry) {
      addClick(left, ry, width, rowH, function () { ui.menuSel = n; activateCareer(); });
    })(idx, y);
  }
  ctx.strokeStyle = 'rgba(170,196,240,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  lay.cols.forEach(function (col, ci) {
    if (!ci) return;
    ctx.moveTo(left + col.x + 0.5, top + 6);
    ctx.lineTo(left + col.x + 0.5, top + headerH + Math.max(visible, 1) * rowH - 6);
  });
  ctx.stroke();
  if (!data.length) text('名单是空的', left + width / 2, top + headerH + 24, font, '#9fb4dd', 'center');

  if (back) {
    var bw = Math.min(width, Math.max(200, Math.round(font * 7)));
    var bx = left + (width - bw) / 2;
    ctx.fillStyle = onBack ? '#2b5fe3' : '#10182e';
    rr(bx, buttonY, bw, backH - 4, 8); ctx.fill();
    ctx.strokeStyle = onBack ? '#ffd94a' : '#8eb0e6';
    ctx.lineWidth = 2;
    ctx.stroke();
    text((onBack ? '▶ ' : '') + '返回', bx + bw / 2, buttonY + (backH - 4) / 2, font, onBack ? '#ffd94a' : '#d5e4ff', 'center', true);
    addClick(bx, buttonY, bw, backH - 4, function () {
      ui.menuSel = data.length;
      activateCareer();
    });
  }
  var hint = '摇杆或上/下选择    确定    取消返回';
  if (data.length > visible) hint = '摇杆上下翻行    ' + (scroll + 1) + '-' + (scroll + visible) + '/' + data.length + '    取消返回';
  text(hint, (left + right) / 2, helpY, Math.min(small, font + 1), '#9fb4dd', 'center');
}

function menuChrome() {
  var scale = paintScale();
  var hint = Math.max(15, Math.ceil(13 / (scale || 1)));
  if (hint > 22) hint = 22;
  var hintY = H - 14 - hint / 2;
  var toastH = 34;
  var toastY = hintY - hint / 2 - 12 - toastH;
  return { hint: hint, hintY: hintY, toastY: toastY, toastH: toastH, contentBottom: toastY - 14 };
}
function drawHubButtons(rows, small, title, sub) {
  var chrome = menuChrome();
  var btn = Math.min(small, 24);
  var bh = btn + 20;
  var gap = Math.max(10, Math.round(btn * 0.42));
  var n = rows.length;
  var top = 104;
  var room = chrome.contentBottom - top;
  var block = n * bh + Math.max(0, n - 1) * gap;
  if (block > room && n > 1) {
    gap = Math.max(8, Math.floor((room - n * bh) / (n - 1)));
    block = n * bh + (n - 1) * gap;
  }
  if (block > room) {
    bh = Math.max(btn + 10, Math.floor((room - Math.max(0, n - 1) * 8) / n));
    gap = 8;
    block = n * bh + Math.max(0, n - 1) * gap;
  }
  var left = careerSafeLeft();
  var right = careerSafeRight();
  var bw = Math.min(520, Math.max(280, right - left - 32));
  var cx = (left + right) / 2;
  var bx = cx - bw / 2;
  text(title, cx, 36, Math.min(small + 8, 32), '#ffd94a', 'center', true);
  text(sub, cx, 72, Math.min(small, 22), '#d6e6ff', 'center');
  var by0 = top + Math.max(0, Math.floor((room - block) / 2));
  if (by0 + block > chrome.contentBottom) by0 = chrome.contentBottom - block;
  var sel = ui.menuSel || 0;
  if (sel >= n) sel = ui.menuSel = 0;
  rows.forEach(function (it, i) {
    var by = by0 + i * (bh + gap);
    var on = i === sel;
    ctx.fillStyle = on ? '#ffd94a' : 'rgba(8,12,26,0.86)';
    rr(bx, by, bw, bh, 8); ctx.fill();
    ctx.strokeStyle = on ? '#fff6cc' : '#9eb6de';
    ctx.lineWidth = on ? 3 : 2;
    ctx.stroke();
    var label = (on ? '▶ ' : '') + it.label;
    ctx.font = 'bold ' + btn + 'px "PingFang SC","Microsoft YaHei",monospace';
    var labelSize = btn;
    var maxW = bw - 36;
    if (ctx.measureText(label).width > maxW) labelSize = Math.max(14, Math.floor(btn * maxW / ctx.measureText(label).width));
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx + 12, by, bw - 24, bh);
    ctx.clip();
    text(label, cx, by + bh / 2, labelSize, on ? '#3a2a00' : '#f4f7ff', 'center', true);
    ctx.restore();
    (function (fn, idx) {
      addClick(bx, by, bw, bh, function () { ui.menuSel = idx; if (fn) fn(); });
    })(it.fn, i);
  });
  text('摇杆或上/下选择    确定    取消返回', cx, chrome.hintY, chrome.hint, '#d5e4ff', 'center');
}
function drawMenuBackdrop() {
  ctx.fillStyle = '#07101f';
  ctx.fillRect(0, 0, W, H);
  if (menuBg && menuBg.complete && menuBg.naturalWidth) {
    var iw = menuBg.naturalWidth, ih = menuBg.naturalHeight;
    var scale = Math.max(W / iw, H / ih);
    var dw = iw * scale, dh = ih * scale;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(menuBg, (W - dw) / 2, H - dh, dw, dh);
    ctx.restore();
  }
  var g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(5,8,20,0.78)');
  g.addColorStop(0.42, 'rgba(6,10,24,0.62)');
  g.addColorStop(0.72, 'rgba(6,12,26,0.5)');
  g.addColorStop(1, 'rgba(4,12,18,0.38)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}
function drawCareer() {
  var C = careerApi();
  if (ui.careerView === 'settings') { drawSettingsScreen(); return; }
  drawMenuBackdrop();
  if (!C || !careerSave) { text('没有生涯', W / 2, H / 2, 28, '#fff', 'center'); return; }
  var scale = paintScale();
  var size = Math.max(18, Math.ceil(15 / scale));
  var small = Math.max(15, Math.ceil(13 / scale));
  var rows = careerRows();
  if (ui.careerView === 'save' || ui.careerView === 'save-ask') {
    var saveHeading = ui.careerView === 'save-ask' ? '请确认' : (ui.saveMode === 'load' ? '读取存档' : ui.saveMode === 'delete' ? '删除存档' : '保存生涯');
    drawSlotScreen(rows, saveHeading);
    return;
  }
  if (CAREER_COLS[ui.careerView]) {
    drawCareerColumns(rows, CAREER_COLS[ui.careerView], size, small);
    return;
  }
  if (!ui.careerView || ui.careerView === 'hub' || ui.careerView === 'files') {
    var hubTitle = C.teamName(careerSave, careerSave.clubId) + '  第' + careerSave.season + '赛季';
    if (ui.careerView === 'files') hubTitle += '  ·  存档';
    drawHubButtons(rows, small, hubTitle, '预算 ' + careerSave.budget + '    阵容 ' + careerSave.squad.length + '人');
    return;
  }
  var viewName = CAREER_VIEW_NAME[ui.careerView] || '';
  text(C.teamName(careerSave, careerSave.clubId) + '  第' + careerSave.season + '赛季' + (viewName ? '  ·  ' + viewName : ''), 48, 36, size + 6, '#ffd94a', 'left', true);
  text('预算 ' + careerSave.budget + '    阵容 ' + careerSave.squad.length + '人', 48, 72, small, '#d6e6ff', 'left');
  if (ui.careerView === 'end') {
    var list = C.ranked(careerSave);
    var champ = list[0];
    text('赛季结束', W / 2, 150, size + 10, '#ffd94a', 'center', true);
    text('冠军  ' + C.teamName(careerSave, champ.teamId), W / 2, 210, size + 4, '#fff', 'center', true);
    text('河畔排名  第' + C.rankOf(careerSave, careerSave.clubId) + '名', W / 2, 260, size + 2, '#9dffb0', 'center', true);
  }
  var hasSub = rows.some(function (r) { return r.sub; });
  var rowH = hasSub ? Math.max(56, small * 2 + 14) : Math.max(36, small + 16);
  var top = ui.careerView === 'end' ? 320 : 110;
  var maxRows = Math.max(4, Math.floor((500 - top) / rowH));
  var sel = ui.menuSel || 0;
  if (sel >= rows.length) sel = ui.menuSel = 0;
  var scroll = 0;
  if (rows.length > maxRows) {
    scroll = sel - Math.floor(maxRows / 2);
    if (scroll < 0) scroll = 0;
    if (scroll > rows.length - maxRows) scroll = rows.length - maxRows;
  }
  var x = careerSafeLeft();
  var w = Math.max(280, careerSafeRight() - x);
  for (var i = 0; i < maxRows && scroll + i < rows.length; i++) {
    var idx = scroll + i;
    var y = top + i * rowH;
    var on = idx === sel;
    ctx.fillStyle = on ? 'rgba(255,217,74,0.28)' : 'rgba(8,12,26,0.82)';
    rr(x, y, w, rowH - 4, 6); ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 8, y, w - 16, rowH - 4);
    ctx.clip();
    if (rows[idx].sub) {
      text((on ? '▶ ' : '') + rows[idx].label, x + 16, y + rowH * 0.34, small, on ? '#ffd94a' : '#fff', 'left', true);
      text(rows[idx].sub, x + 36, y + rowH * 0.72, Math.max(14, small - 2), '#d6e6ff', 'left');
    } else {
      text((on ? '▶ ' : '') + rows[idx].label, x + 16, y + (rowH - 4) / 2, on ? size : small, on ? '#ffd94a' : '#fff', 'left', true);
    }
    ctx.restore();
    (function (n) { addClick(x, y, w, rowH - 4, function () { ui.menuSel = n; activateCareer(); }); })(idx);
  }
  var helpY = H - Math.max(18, Math.round(small * 0.65));
  text('摇杆或上/下选择    确定    取消返回', W / 2, helpY, Math.min(small, 22), '#d5e4ff', 'center');
}

function drawSlotScreen(rows, heading) {
  drawMenuBackdrop();
  var small = careerFont(14);
  var titleSize = careerFont(18);
  var left = careerSafeLeft();
  var right = careerSafeRight();
  if (right - left < 280) { left = 36; right = isTouch ? 1000 : W - 36; }
  var width = right - left;
  var foot = Math.max(16, Math.round(small * 0.7));
  var helpY = H - foot;
  var bottom = helpY - Math.round(small * 0.8) - 48;
  text(heading, left, 14 + titleSize / 2, titleSize, '#ffd94a', 'left', true);
  var note = (ui.titleView === 'ask' || ui.careerView === 'save-ask') ? askNoteLines() : [];
  var y = 18 + titleSize;
  note.forEach(function (line) {
    if (!line) return;
    text(line, left, y + small / 2, small, '#ffd0d0', 'left', true);
    y += small + 6;
  });
  y += 8;
  var sel = ui.menuSel || 0;
  if (sel >= rows.length) sel = ui.menuSel = 0;
  if (rows[sel] && rows[sel].slotId) ui.slotFocus = rows[sel].slotId;
  function rowH(row) {
    if (!row.slotId) return small + 22;
    if (row.tone === 'ok') return small * 3 + 22;
    return small * 2 + 20;
  }
  var heights = rows.map(rowH);
  var room = Math.max(40, bottom - y);
  var start = 0;
  var usedBefore = 0;
  for (var i = 0; i < sel; i++) usedBefore += heights[i] + 8;
  var fitBefore = 0;
  var acc = 0;
  for (var k = sel; k >= 0; k--) {
    var next = acc + heights[k] + (k === sel ? 0 : 8);
    if (k < sel && next > room) break;
    if (k === sel && heights[k] > room) break;
    acc = next;
    fitBefore = k;
  }
  start = fitBefore;
  var cursor = y;
  var shown = 0;
  for (var n = start; n < rows.length; n++) {
    var h = heights[n];
    if (cursor + h > bottom && shown > 0) break;
    paintSlotRow(rows[n], n, left, cursor, width, h, n === sel, small);
    cursor += h + 8;
    shown++;
  }
  var pos = rows.length ? ((sel + 1) + '/' + rows.length) : '0/0';
  if (start > 0) pos = '↑ ' + pos;
  if (start + shown < rows.length) pos += ' ↓';
  var posW = small * 4;
  text(pos, right, 14 + titleSize / 2, small, '#ffd94a', 'right', true);
  text('摇杆或上/下选择    确定    取消返回', (left + right) / 2, helpY, Math.min(small, 22), '#9fb4dd', 'center');
  void posW;
}
function paintSlotRow(row, idx, x, y, w, h, on, small) {
  var danger = !!row.danger;
  var bad = row.tone === 'bad';
  var off = row.enabled === false;
  ctx.fillStyle = on ? (danger ? '#8d2424' : 'rgba(255,217,74,0.18)') : (bad ? 'rgba(90,24,24,0.55)' : 'rgba(8,14,32,0.88)');
  rr(x, y, w, h, 8); ctx.fill();
  ctx.strokeStyle = on ? '#ffd94a' : (danger ? '#e07a7a' : '#3d5a99');
  ctx.lineWidth = on ? 3 : 1.5;
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 10, y + 2, w - 20, h - 4);
  ctx.clip();
  if (row.slotId && row.tone === 'ok') {
    text(row.label, x + 16, y + small * 0.72, small, on ? '#ffd94a' : '#fff', 'left', true);
    if (row.time) text(row.time, x + w - 16, y + small * 0.72, Math.max(13, small - 2), '#d7e6ff', 'right');
    var parts = String(row.sub || '').split('  ·  ');
    text(parts[0] || '', x + 16, y + small * 1.85, small, '#f4f7ff', 'left', true);
    text(parts[1] || '', x + 16, y + small * 2.9, Math.max(13, small - 1), '#9fb4dd', 'left');
  } else if (row.slotId) {
    text(row.label, x + 16, y + h * 0.34, small, bad ? '#ffb4b4' : (off ? '#8ea0c4' : '#fff'), 'left', true);
    text(row.sub || '', x + 16, y + h * 0.72, Math.max(13, small - 1), bad ? '#ffd0d0' : '#9fb4dd', 'left');
  } else {
    if (!danger && on) {
      ctx.fillStyle = '#ffd94a';
      rr(x, y, w, h, 8); ctx.fill();
    }
    text((on ? '▶ ' : '') + row.label, x + w / 2, y + h / 2, small, (!danger && on) ? '#3a2a00' : '#fff', 'center', true);
  }
  ctx.restore();
  addClick(x, y, w, h, function () {
    ui.menuSel = idx;
    if (row.slotId) ui.slotFocus = row.slotId;
    if (row.enabled !== false && row.fn) row.fn();
  });
}
function drawSettingsScreen() {
  drawMenuBackdrop();
  var small = careerFont(15);
  var titleSize = careerFont(22);
  var left = Math.max(careerSafeLeft(), 80);
  var right = careerSafeRight();
  if (right - left < 360) { left = isTouch ? 300 : 180; right = isTouch ? 1000 : W - 180; }
  var width = Math.min(760, right - left);
  var x = left + (right - left - width) / 2;
  text('设置', W / 2, 28 + titleSize / 2, titleSize, '#ffd94a', 'center', true);
  text('左右或确定切换    取消返回', W / 2, 28 + titleSize + small, small, '#d5e4ff', 'center');
  var rows = settingRows();
  var sel = ui.menuSel || 0;
  if (sel >= rows.length) sel = ui.menuSel = 0;
  var rowH = small + 36;
  var gap = Math.max(16, Math.round(small * 0.55));
  var top = 28 + titleSize + small * 2 + 28;
  rows.forEach(function (row, i) {
    var y = top + i * (rowH + gap);
    var on = i === sel;
    ctx.fillStyle = on ? 'rgba(255,217,74,0.2)' : 'rgba(8,12,26,0.78)';
    rr(x, y, width, rowH, 10); ctx.fill();
    ctx.strokeStyle = on ? '#ffd94a' : '#3d5a99';
    ctx.lineWidth = on ? 3 : 1.5;
    ctx.stroke();
    if (row.kind) {
      text(row.label, x + 28, y + rowH / 2, small, on ? '#ffd94a' : '#fff', 'left', true);
      var value = '◀   ' + row.value + '   ▶';
      text(value, x + width - 28, y + rowH / 2, small, '#fff', 'right', true);
      addClick(x, y, width * 0.5, rowH, function () { ui.menuSel = i; cycleSetting(row.kind, -1); });
      addClick(x + width * 0.5, y, width * 0.5, rowH, function () { ui.menuSel = i; cycleSetting(row.kind, 1); });
    } else {
      text((on ? '▶ ' : '') + row.label, x + width / 2, y + rowH / 2, small, on ? '#3a2a00' : '#fff', 'center', true);
      if (on) {
        ctx.fillStyle = '#ffd94a';
        rr(x, y, width, rowH, 10); ctx.fill();
        text('▶ ' + row.label, x + width / 2, y + rowH / 2, small, '#3a2a00', 'center', true);
      }
      addClick(x, y, width, rowH, function () { ui.menuSel = i; if (row.fn) row.fn(); });
    }
  });
}
function drawTitle() {
  if (ui.titleView === 'settings') { drawSettingsScreen(); return; }
  if (ui.titleView && ui.titleView !== 'main') {
    var slotHeading = ui.titleView === 'new' ? '新建生涯' : ui.titleView === 'load' ? '读取存档' : '请确认';
    drawSlotScreen(titleActions(), slotHeading);
    return;
  }
  drawMenuBackdrop();
  var scale = paintScale();
  function cssPx(px, min, max) {
    var n = Math.ceil(px / (scale || 1));
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }
  var titleSize = cssPx(36, 52, 78);
  var subSize = cssPx(15, 16, 24);
  var btnSize = cssPx(17, 18, 26);
  var gap = cssPx(14, 16, 26);
  var bh = btnSize + 26;
  var actions = titleActions();
  var block = actions.length * bh + (actions.length - 1) * gap;
  var titleY = 28 + titleSize / 2;
  var subY = titleY + titleSize / 2 + subSize * 0.85;
  var vsY = subY + subSize + 18;
  var topLimit = vsY + subSize + 28;
  var bottomLimit = H - 28;
  if (topLimit + block > bottomLimit) {
    gap = Math.max(10, Math.floor((bottomLimit - topLimit - actions.length * bh) / Math.max(1, actions.length - 1)));
    block = actions.length * bh + (actions.length - 1) * gap;
  }
  var by0 = topLimit;
  if (by0 + block > bottomLimit) by0 = Math.max(topLimit - 8, bottomLimit - block);
  var left = careerSafeLeft();
  var right = careerSafeRight();
  var bw = Math.min(460, Math.max(300, right - left - 48));
  if (bw > right - left - 24) bw = right - left - 24;
  var cx = (Math.max(left, 48) + Math.min(right, W - 48)) / 2;
  text('热 血 足 球 RPG', cx, titleY, titleSize, '#ffd94a', 'center', true);
  text('天使之翼式 · 回合指令制 · 服务器权威判定', cx, subY, subSize, '#d5e4ff', 'center');
  text('青鹰高校  vs  烈风学院', cx, vsY, subSize + 6, '#ffffff', 'center', true);

  ctx.fillStyle = 'rgba(6,10,22,0.38)';
  rr(cx - bw / 2 - 18, by0 - 16, bw + 36, block + 32, 16); ctx.fill();
  actions.forEach(function (it, i) {
    var bx = cx - bw / 2, by = by0 + i * (bh + gap);
    var on = (ui.menuSel || 0) === i;
    var off = it.enabled === false;
    ctx.fillStyle = off ? 'rgba(28,34,48,0.72)' : (on ? '#ffd94a' : '#e8a923');
    rr(bx, by, bw, bh, 8); ctx.fill();
    ctx.strokeStyle = off ? '#667084' : (on ? '#fff' : '#fff2c8');
    ctx.lineWidth = off ? 1.5 : (on ? 3 : 2);
    ctx.stroke();
    text((on && !off ? '▶ ' : '') + it.label, cx, by + bh / 2, btnSize, off ? '#8b93a6' : '#3a2a00', 'center', true);
    (function (fn, dis, n) {
      addClick(bx, by, bw, bh, function () {
        ui.menuSel = n;
        if (!dis) fn();
      });
    })(it.fn, off, i);
  });
}

// ---------------- 绘制：比赛 ----------------
function drawGame(t) {
  drawBackground();
  drawSurround();
  drawPitch();
  if (DEBUG) drawAnchors();
  drawGoals();
  drawActors(t);
  drawReferee(t);
  drawRestartMark();
  drawScoreboard();
  drawMinimap(); // ★ 小地图：全场只在这里看（球员点/球/镜头框/被操控绿圈）
  drawPauseButton();
  if (isTouch) drawGamepad(); // 移动端/Pad：透明虚拟手柄（画在菜单下层）
  if (ui.pauseOpen) drawPauseMenu();
  if (!(state && state.phase === 'fulltime')) drawBottomUI(t);
  if (!(state && state.phase === 'fulltime')) drawCutin();
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

function drawSurround() {
  // 先铺满地平线以下，截图里不会露出透明的白块。
  ctx.fillStyle = '#163322';
  ctx.fillRect(0, HORIZON, W, H - HORIZON);
  var x0 = -SURROUND, x1 = C.FIELD.W + SURROUND;
  var y0 = 0, y1 = C.FIELD.H;
  var p0 = project(x0, y0), p1 = project(x1, y0), p2 = project(x1, y1), p3 = project(x0, y1);
  ctx.fillStyle = '#245c34';
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y);
  ctx.closePath(); ctx.fill();
  // 底线外再深一截，球门网落在这块草坪上，而不是画面外面。
  ctx.fillStyle = '#1d4a2c';
  [[-SURROUND, 0], [C.FIELD.W, C.FIELD.W + SURROUND]].forEach(function (seg) {
    var a = project(seg[0], 0), b = project(seg[1], 0), c = project(seg[1], C.FIELD.H), d = project(seg[0], C.FIELD.H);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
    ctx.closePath(); ctx.fill();
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
  function arc(cx, cy, r, a0, a1, width) {
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = width || 2;
    ctx.beginPath();
    var steps = 36;
    for (var i = 0; i <= steps; i++) {
      var a = a0 + (a1 - a0) * i / steps;
      var p = project(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  function dot(cx, cy) {
    var p = project(cx, cy);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  var F = C.FIELD;
  var L = C.PITCH;
  line(0, 0, F.W, 0); line(0, F.H, F.W, F.H);
  line(0, 0, 0, F.H); line(F.W, 0, F.W, F.H);
  line(F.W / 2, 0, F.W / 2, F.H);
  arc(F.W / 2, F.H / 2, L.centreRadius, 0, Math.PI * 2);
  dot(F.W / 2, F.H / 2);
  // 角球弧：半径 1 米，画在场内。
  arc(0, 0, L.cornerRadius, 0, Math.PI / 2);
  arc(0, F.H, L.cornerRadius, -Math.PI / 2, 0);
  arc(F.W, 0, L.cornerRadius, Math.PI / 2, Math.PI);
  arc(F.W, F.H, L.cornerRadius, Math.PI, Math.PI * 1.5);
  [[0, 1], [F.W, -1]].forEach(function (s) {
    var gx = s[0], d = s[1];
    var ph = L.penaltyHalf, pd = L.penaltyDepth, gh = L.goalAreaHalf, gd = L.goalAreaDepth;
    line(gx, F.H / 2 - ph, gx + pd * d, F.H / 2 - ph);
    line(gx + pd * d, F.H / 2 - ph, gx + pd * d, F.H / 2 + ph);
    line(gx + pd * d, F.H / 2 + ph, gx, F.H / 2 + ph);
    line(gx, F.H / 2 - gh, gx + gd * d, F.H / 2 - gh);
    line(gx + gd * d, F.H / 2 - gh, gx + gd * d, F.H / 2 + gh);
    line(gx + gd * d, F.H / 2 + gh, gx, F.H / 2 + gh);
    var spotX = gx + L.penaltySpot * d;
    dot(spotX, F.H / 2);
    // 点球弧只画禁区外的那一段（以罚球点为圆心，半径 9.15 米）。
    var beta = Math.acos((L.penaltyDepth - L.penaltySpot) / L.arcRadius);
    var mid = d > 0 ? 0 : Math.PI;
    arc(spotX, F.H / 2, L.arcRadius, mid - beta, mid + beta, 3.5);
  });
}

function drawGoals() {
  // 两头都画门柱、横梁和球网。高度按球员精灵换算：人大约 1.85 米，球门 2.44 米，横梁要高出守门员。
  var halfW = 3.66, depth = 2.2;
  function lift(p, meters) { return { x: p.x, y: p.y - meters * 24.6 * p.s }; }
  [[0, -1], [C.FIELD.W, 1]].forEach(function (s) {
    var gx = s[0], dir = s[1];
    var yL = 34 - halfW, yR = 34 + halfW;
    var g1 = project(gx, yL), g2 = project(gx, yR);
    var b1 = project(gx + depth * dir, yL), b2 = project(gx + depth * dir, yR);
    var gt1 = lift(g1, 2.44), gt2 = lift(g2, 2.44);
    var bt1 = lift(b1, 2.2), bt2 = lift(b2, 2.2);
    function mesh(a, b, c, d) {
      ctx.beginPath();
      var i, t;
      for (i = 0; i <= 6; i++) {
        t = i / 6;
        ctx.moveTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        ctx.lineTo(d.x + (c.x - d.x) * t, d.y + (c.y - d.y) * t);
      }
      for (i = 0; i <= 4; i++) {
        t = i / 4;
        ctx.moveTo(a.x + (d.x - a.x) * t, a.y + (d.y - a.y) * t);
        ctx.lineTo(b.x + (c.x - b.x) * t, b.y + (c.y - b.y) * t);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(236,242,248,0.72)';
    ctx.lineWidth = 1.25;
    mesh(bt1, bt2, b2, b1);
    mesh(gt1, bt1, b1, g1);
    mesh(gt2, bt2, b2, g2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(8,16,24,0.55)';
    ctx.beginPath();
    ctx.moveTo(gt1.x, gt1.y); ctx.lineTo(g1.x, g1.y);
    ctx.moveTo(gt2.x, gt2.y); ctx.lineTo(g2.x, g2.y);
    ctx.moveTo(gt1.x, gt1.y); ctx.lineTo(gt2.x, gt2.y);
    ctx.stroke();
    ctx.strokeStyle = '#f7fbff';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(gt1.x, gt1.y); ctx.lineTo(g1.x, g1.y);
    ctx.moveTo(gt2.x, gt2.y); ctx.lineTo(g2.x, g2.y);
    ctx.moveTo(gt1.x, gt1.y); ctx.lineTo(gt2.x, gt2.y);
    ctx.moveTo(gt1.x, gt1.y); ctx.lineTo(bt1.x, bt1.y);
    ctx.moveTo(gt2.x, gt2.y); ctx.lineTo(bt2.x, bt2.y);
    ctx.moveTo(bt1.x, bt1.y); ctx.lineTo(bt2.x, bt2.y);
    ctx.stroke();
  });
}

// 把一帧钉在脚底锚点上。mirror 时绕着脚的世界坐标水平翻转，脚不离开落点。
function blit8(img, anchors, row, col, mirror, pr, dw, dh, alpha) {
  if (!img) return;
  var a = (anchors && anchors[row * 8 + col]) || { x: 24, y: 71 };
  var scx = dw / 48, scy = dh / 72;
  ctx.save();
  if (alpha != null && alpha < 0.999) ctx.globalAlpha = alpha;
  if (mirror) {
    ctx.translate(pr.x, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, col * 48, row * 72, 48, 72, -a.x * scx, pr.y - a.y * scy, dw, dh);
  } else {
    ctx.drawImage(img, col * 48, row * 72, 48, 72, pr.x - a.x * scx, pr.y - a.y * scy, dw, dh);
  }
  ctx.restore();
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
    // 外场图和门将旧表都不带烤进去的球，球一律另画。
    var dw = 16 * s * 1.9, dh = 24 * s * 1.9; // 2:3，与 48×72 帧同比例
    if (p.gkSet) { dh *= 0.84; dw *= 1.12; } // 射门前站定：微蹲
    if (p.gkSpread) dw *= 1.22; // 单刀封角度：把身体张开
    var stagger = !!p.beaten; // ★ 被晃倒：精灵倾斜踉跄，一眼看出被过了
    if (stagger) {
      ctx.save();
      ctx.translate(pr.x, pr.y - dh / 2);
      ctx.rotate(0.50 * ((p.num % 2) ? 1 : -1)); // ★ 2026-10-09 加大到 0.5（之前 0.3 精灵太小看不出）
      ctx.translate(-pr.x, -(pr.y - dh / 2));
    }
    if (spr) {
      if (spr.is8dir) {
        // ★ 右侧斜向原图是背面（下斜该见脸、上斜该见背）。用左侧斜向镜像：
        //   downright←downleft，upright←upleft。脚底锚点一起镜像，不会把人拔离落点。
        var useRow = spr.dirRow, mirror8 = false;
        if (spr.dirRow === 3) { useRow = 5; mirror8 = true; }
        else if (spr.dirRow === 1) { useRow = 7; mirror8 = true; }
        // 不叠下一帧。两帧脚的位置差一截，半透明叠上去脸和身体都会发虚，球的残片也会闪。
        blit8(spr.img, spr.anchors, useRow, spr.col, mirror8, pr, dw, dh, 1);
      } else {
        var sy = spr.row * 72;
        if (spr.face < 0) {
          // ★ 按移动方向翻转（2026-10-10）：向左跑朝左，向右跑朝右，不再按队伍写死
          ctx.save();
          ctx.translate(pr.x, pr.y - dh);
          ctx.scale(-1, 1);
          ctx.drawImage(spr.img, 0, sy, 48, 72, -dw / 2, 0, dw, dh);
          ctx.restore();
        } else {
          ctx.drawImage(spr.img, 0, sy, 48, 72, pr.x - dw / 2, pr.y - dh, dw, dh);
        }
      }
    } else {
      var frames = framesFor(p);
      var img = frames[animFrame];
      var _face = (animClock[p.id] && animClock[p.id].face) || (p.team === 'away' ? -1 : 1);
      if (_face < 0) {
        // ★ 按移动方向翻转（兜底帧也一致）
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
    if (p.swapped) text('⇄', pr.x, pr.y - dh - 16 * s, 16 * s, '#ffd94a', 'center', true);
    if (stagger) ctx.restore(); // ★ 踉跄倾斜结束
    if (stagger) {
      // ★ 眩晕星星：被晃倒头顶转星星，不用眯眼也能看出"这人被过了定住了"
      var swx = pr.x + Math.sin(t / 240) * 10 * s, swy = pr.y - dh - 14 * s + Math.cos(t / 310) * 4 * s;
      ctx.font = Math.round(20 * s) + 'px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('💫', swx, swy);
    }
  });

  // 球
  // 带球时球贴在面朝方向前方约 0.5 米，朝向用八向离散方向，不跟本帧速度。
  // 只有球真正离脚飞行时（传球/射门/解围）才绘制轨迹残影。
  var bbx = ballR.x, bby = ballR.y, ballOwned = false;
  // 定位球已经摆好：球画在发球点上，不跟主罚者的脚走。主罚者站在球后面。
  var placedRestart = state.restart && state.ball && state.ball.ownerId
    && (state.phase === 'whistle' || state.phase === 'penalty' || state.phase === 'decision' || state.restart.held);
  if (placedRestart) {
    bbx = state.ball.x; bby = state.ball.y;
  }
  for (var boi = 0; !placedRestart && boi < state.players.length; boi++) {
    if (state.players[boi].hasBall) {
      var owner = state.players[boi];
      ballOwned = true;
      var oc = owner._cycle, orp = renderPos[owner.id] || owner;
      var ost = animClock[owner.id];
      var fx = 1, fy = 0;
      if (ost && (ost.fx || ost.fy)) { fx = ost.fx; fy = ost.fy; }
      else if (oc && (oc.svx || oc.svy)) {
        var sl = Math.sqrt(oc.svx * oc.svx + oc.svy * oc.svy) || 1;
        fx = oc.svx / sl; fy = oc.svy / sl;
      } else if (owner.team === 'away') fx = -1;
      // 球固定在面朝方向前方。只在跑动时向前轻轻送一点，余弦在 0 和 1 处同值，停步也不拉回脚下。
      // 不用横向正弦，也不跟每帧速度：那些会让球左右乱跳。
      var phase = (oc && oc.moving) ? oc.phase : 0;
      var nudge = (oc && oc.moving) ? (0.5 - 0.5 * Math.cos(phase * Math.PI * 2)) * 0.10 : 0;
      var along = 0.48 + nudge;
      // 直接钉在这一帧的脚前，不做滞后跟随。人的位置按快照走，球再滞后就会甩在身后再弹回来。
      var tx = orp.x + fx * along;
      var ty = orp.y + fy * along;
      bbx = tx; bby = ty;
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
  ctx.drawImage(ballImg, bp.x - bs / 2, bp.y - bs - 2 - rise, bs, bs);

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

function drawReferee(t) {
  if (!state) return;
  var fake = { id: 'referee', team: 'ref', pos: 'REF', skin: 'fair', num: 0, hasBall: false };
  var A = snapPrev && snapPrev.ref, B = snapCurr && snapCurr.ref;
  if (!renderPos.referee) {
    var s0 = B || (state.referee && state.referee.x != null ? state.referee : { x: C.FIELD.W / 2, y: 12 });
    renderPos.referee = { x: s0.x, y: s0.y };
  }
  if (A && B) {
    var ia = 1;
    if (snapPrev && snapCurr && snapCurr.t > snapPrev.t) {
      ia = (t - snapPrev.t) / (snapCurr.t - snapPrev.t);
      if (ia < 0) ia = 0; else if (ia > 1) ia = 1;
    }
    var dx = B.x - A.x, dy = B.y - A.y;
    if (dx * dx + dy * dy > 64) { renderPos.referee.x = B.x; renderPos.referee.y = B.y; }
    else { renderPos.referee.x = A.x + dx * ia; renderPos.referee.y = A.y + dy * ia; }
  } else if (B) {
    renderPos.referee.x = B.x;
    renderPos.referee.y = B.y;
  }
  var spr = spriteFrameFor(fake, t);
  var pr = project(renderPos.referee.x, renderPos.referee.y);
  var dw = 16 * pr.s * 1.9, dh = 24 * pr.s * 1.9;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(pr.x, pr.y + 2, 12 * pr.s, 4 * pr.s, 0, 0, Math.PI * 2);
  ctx.fill();
  if (spr && spr.is8dir) {
    blit8(spr.img, spr.anchors, spr.dirRow || 2, spr.col || 0, false, pr, dw, dh, 1);
  }
}

function drawScoreboard() {
  if (!state) return;
  var y = 8, h = 44;
  // 主队
  ctx.fillStyle = '#1d3fa0'; ctx.fillRect(14, y, 170, h);
  text((state && state.homeName) || '青鹰高校', 99, y + h / 2, 18, '#fff', 'center', true);
  // 比分
  ctx.fillStyle = '#0a0d18'; ctx.fillRect(184, y, 120, h);
  text(state.score.home + ' - ' + state.score.away, 244, y + h / 2, 26, '#ffd94a', 'center', true);
  // 客队
  ctx.fillStyle = '#a02a2a'; ctx.fillRect(304, y, 170, h);
  text((state && state.awayName) || '烈风学院', 389, y + h / 2, 18, '#fff', 'center', true);
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
  var cx = cameraX();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5;
  ctx.strokeRect(mx + cx * kx, my + 2, viewW * kx, mh - 4);
  ctx.restore();
}

function drawPauseButton() {
  if (isTouch) { drawTouchMenuButton(); return; }
  var x = W - 120, y = 8, w = 106, h = 44;
  panel(x, y, w, h);
  text('⏸ 暂停', x + w / 2, y + h / 2, 20, '#fff', 'center', true);
  addClick(x, y, w, h, function () { togglePause(); });
}
// 菜单单独放在右上角，离开摇杆和右侧按键。返回/取消是 Q，这里只开关暂停菜单。
function drawTouchMenuButton() {
  var w = MENU_BTN.w, h = MENU_BTN.h, x = W - w - 16, y = MENU_BTN.y;
  MENU_BTN.x = x; MENU_BTN.y = y;
  ctx.fillStyle = 'rgba(8,12,26,0.40)';
  rr(x, y, w, h, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5; ctx.stroke();
  text('菜单', x + w / 2, y + h / 2, 14, 'rgba(255,255,255,0.82)', 'center');
  addClick(x, y, w, h, function () { togglePause(); });
}

function drawPauseMenu() {
  var x = W - 300, y = 62, w = 286, h = 320;
  panel(x, y, w, h);
  text('PAUSE', x + 20, y + 26, 20, '#9fb4dd', 'left', true);
  var items = pauseItems();
  var sel = ui.pauseSel || 0;
  items.forEach(function (it, i) {
    var iy = y + 52 + i * 42, ih = 36;
    var on = i === sel;
    var hov = it.label.indexOf('战术指令') === 0 && ui.tacticOpen;
    ctx.fillStyle = on || hov ? '#2b5fe3' : '#141b34';
    rr(x + 12, iy, w - 24, ih, 5); ctx.fill();
    text((on ? '▶ ' : '') + it.label, x + 28, iy + ih / 2, 18, on ? '#ffd94a' : '#fff', 'left');
    (function (fn, idx) { addClick(x + 12, iy, w - 24, ih, function () { ui.pauseSel = idx; fn(); }); })(it.fn, i);
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

var CMD_ICONS = { dribble: '💨', burst: '💨', pass: '➡️', protect: '🛡️', shoot: '⚽', special: '🔥', feint: '🌀', retreat: '↩️', tackle: '🦵', jockey: '🧱', 'def-skills': '🛡️', 'def-flying': '🛝', 'def-sweep': '🌀', 'def-shoulder': '💪', 'def-elbow': '🚧', 'shot-driven': '💥', 'shot-placed': '🎯', 'shot-curl': '🌀' };

function hintMessage() {
  if (ui.tutorialArmed && !ui.tutorialDone && ui.tutorialUntil && Date.now() >= ui.tutorialUntil) ui.tutorialDone = true;
  if (state && state.phase === 'fulltime') {
    ui.tutorialDone = true;
    return null;
  }
  if (ui.hintClosed) return null;
  if (!state) return null;
  var restarting = state.restart && (state.phase === 'whistle' || state.phase === 'penalty' || state.phase === 'decision' || state.restart.held);
  if (restarting) {
    var msg = state.restart.label || '定位球';
    if (state.decision && state.decision.kind === 'taker') msg += ' · 选主罚人，按确定';
    else if (state.decision && state.decision.kind === 'qte') msg += ' · 光标居中时按确定';
    else if (state.decision && state.decision.kind === 'penalty-shot') msg += ' · 选择射门';
    else if (state.decision && state.decision.kind === 'setpiece') msg += ' · 传球或射门';
    else if (state.restart.held && state.restart.kind === 'goalkick') msg += ' · 对方退出禁区后才能开出';
    else if (state.restart.team === 'home' && state.restart.kind === 'goalkick') msg += ' · 门将开球';
    return msg;
  }
  if (state.phase === 'kickoff') return '开球！';
  if (state.phase === 'goal') return '⚽ 进球！';
  if (state.phase === 'halftime') return '中场休息…';
  if (state.paused) return '已暂停';
  if (!ui.tutorialDone) {
    var tip = isTouch ? '拖摇杆移动，右侧按键同键盘。' : 'WASD 移动绿圈球员，E 选指令。';
    if (!ui.tutorialArmed || Date.now() < ui.tutorialUntil) return tip;
    ui.tutorialDone = true;
  }
  return null;
}

function drawIdleHint(x, y, w, h) {
  if (state && state.phase === 'fulltime') return;
  var msg = hintMessage();
  if (!msg) return;
  var tip = isTouch ? '拖摇杆移动，右侧按键同键盘。' : 'WASD 移动绿圈球员，E 选指令。';
  var alpha = 1;
  if (msg === tip && ui.tutorialArmed && ui.tutorialUntil) {
    var left = ui.tutorialUntil - Date.now();
    if (left < 1000) alpha = Math.max(0, left / 1000);
  }
  if (alpha <= 0.02) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  panel(x, y, w, h);
  text(msg, x + 16, y + h / 2, 16, '#9fb4dd', 'left');
  text('×', x + w - 18, y + h / 2, 18, '#ffd94a', 'center', true);
  ctx.restore();
  addClick(x, y, w, h, function () { ui.hintClosed = true; ui.tutorialUntil = 0; });
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

// 定位球：场上画球点，画面上方留一条短横幅（犯规/越位 → 任意球，点球同理）。
function drawRestartMark() {
  if (!state || !state.restart) return;
  if (state.phase !== 'whistle' && state.phase !== 'penalty' && state.phase !== 'decision' && !(state.restart && state.restart.held)) return;
  var r = state.restart;
  var spot = project(r.x, r.y);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 217, 74, 0.95)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(spot.x, spot.y, Math.max(8, 16 * spot.s), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  var label = r.label || '定位球';
  ctx.font = 'bold 26px "PingFang SC","Microsoft YaHei",sans-serif';
  var bw = Math.max(300, ctx.measureText(label).width + 56);
  var bh = 48, bx = (W - bw) / 2, by = 86;
  ctx.fillStyle = 'rgba(8, 12, 26, 0.9)';
  rr(bx, by, bw, bh, 8); ctx.fill();
  ctx.strokeStyle = '#ffd94a'; ctx.lineWidth = 3;
  rr(bx, by, bw, bh, 8); ctx.stroke();
  text(label, W / 2, by + bh / 2, 24, '#ffd94a', 'center', true);
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
  var layer = document.getElementById('touch-ui');
  if (layer && !layer.hidden) return;
  ctx.fillStyle = stickVec.on ? 'rgba(6,10,20,0.55)' : 'rgba(6,10,20,0.40)';
  ctx.beginPath(); ctx.arc(STICK.x, STICK.y, STICK.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 3; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(STICK.x - 18, STICK.y); ctx.lineTo(STICK.x + 18, STICK.y);
  ctx.moveTo(STICK.x, STICK.y - 18); ctx.lineTo(STICK.x, STICK.y + 18);
  ctx.stroke();
  text('WASD', STICK.x, STICK.y + 48, 14, '#ffd94a', 'center', true);
  var kx = STICK.x + pad.dx * STICK.r * 0.62;
  var ky = STICK.y - pad.dy * STICK.r * 0.62;
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.beginPath(); ctx.arc(kx, ky, 32, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 3; ctx.stroke();
  VKEYS.forEach(function (b) {
    var primary = b.id === 'confirm';
    var held = false;
    for (var ck in contacts) if (contacts[ck].role === 'key' && contacts[ck].id === b.id) held = true;
    ctx.fillStyle = held ? 'rgba(255,217,74,0.45)' : (primary ? 'rgba(255,217,74,0.24)' : 'rgba(6,10,20,0.46)');
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = primary ? 'rgba(255,226,140,0.9)' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = primary ? 3 : 2; ctx.stroke();
    text(b.label, b.x, b.y - (primary ? 10 : 8), primary ? 22 : 16, '#ffffff', 'center', true);
    text(b.keyLabel, b.x, b.y + (primary ? 16 : 12), primary ? 16 : 13, '#ffd94a', 'center', true);
  });
}

// ---------------- 事件横幅 / 指令演出 ----------------
// ★ 特写跳过（2026-10-11 试玩反馈：全屏特写无跳过、排队打断心流）：
//   玩家按 Enter/空格/Esc 或点击/触摸任意位置，立即关闭当前全屏特写，
//   不等服务器 until 到期；新事件到达（id 不同）自动解除跳过。
function cutActionId(a) { return a.kind + '|' + (a.playerName || '') + '|' + (a.label || '') + '|' + a.until; }
function showingCutscene() {
  if (!state || !state.lastAction) return null;
  var a = state.lastAction;
  if (ui.cutSkipId && ui.cutSkipId === cutActionId(a)) return null;
  var manga = typeof mangaCutAvailable === 'function' && mangaCutAvailable(a);
  if (!manga && typeof mangaHasCut === 'function' && mangaHasCut(a.cut)) return null;
  var im = a.cut && ensureCutImg(a.cut);
  var webp = im && im.complete && im.naturalWidth;
  if (!manga && !webp) return null;
  return a;
}
function skipCutscene() {
  var a = showingCutscene();
  if (a) {
    ui.cutSkipId = cutActionId(a);
    sendInput({ dismissOverlay: true });
    return true;
  }
  return false;
}
function drawAnchors() {
  if (!state) return;
  state.players.forEach(function (p) {
    if (!p.anchor) return;
    var pr = project(p.anchor.x, p.anchor.y);
    ctx.beginPath();
    ctx.strokeStyle = p.team === 'home' ? 'rgba(80,160,255,0.85)' : 'rgba(255,90,90,0.85)';
    ctx.lineWidth = 2;
    ctx.arc(pr.x, pr.y, 7, 0, Math.PI * 2);
    ctx.stroke();
  });
}

// duel-settle-v1：对玩家只显示「突破 对 卡位 — 突破成功」。属性、摇摆、体能和分数只在 ?debug=1。
function duelResultLine(d) {
  return (d.atkLabel || '') + ' 对 ' + (d.defLabel || '') + ' — ' + (d.result || '');
}
function drawDuelCutArt(a) {
  if (!a.cut || (ui.cutSkipId && ui.cutSkipId === cutActionId(a))) return false;
  var im = ensureCutImg(a.cut);
  if (!(im && im.complete && im.naturalWidth)) return false;
  var iw = Math.min(520, W - 80), ih = iw * 2 / 3;
  var ix = (W - iw) / 2, iy = 78;
  ctx.drawImage(im, ix, iy, iw, ih);
  ctx.strokeStyle = '#ffd94a'; ctx.lineWidth = 3;
  ctx.strokeRect(ix - 2, iy - 2, iw + 4, ih + 4);
  return iy + ih;
}
function drawDuelResultOnly(a, d) {
  var line = duelResultLine(d);
  var artBottom = drawDuelCutArt(a);
  var scale = paintScale();
  var size = Math.max(22, Math.ceil(18 / scale));
  ctx.font = 'bold ' + size + 'px "PingFang SC","Microsoft YaHei",sans-serif';
  var bw = Math.min(W - 48, Math.max(420, ctx.measureText(line).width + 56));
  var bh = size + 28;
  var bx = (W - bw) / 2;
  var by = artBottom ? artBottom + 16 : 268;
  ctx.fillStyle = 'rgba(6,8,16,0.92)';
  rr(bx, by, bw, bh, 10); ctx.fill();
  ctx.strokeStyle = '#ffd94a'; ctx.lineWidth = 3;
  rr(bx, by, bw, bh, 10); ctx.stroke();
  var good = d.result && d.result.indexOf('成功') >= 0;
  text(line, W / 2, by + bh / 2, size, good ? '#9dffb0' : '#ffd0d0', 'center', true);
}
function drawDuelBreakdown(a, d) {
  var scale = paintScale();
  var size = Math.max(18, Math.ceil(15 / scale));
  var small = Math.max(16, Math.ceil(14 / scale));
  var w = Math.min(760, W - 80);
  var h = 250;
  var x = (W - w) / 2;
  var y = 150;
  ctx.fillStyle = 'rgba(6,8,16,0.94)';
  rr(x, y, w, h, 12); ctx.fill();
  ctx.strokeStyle = '#ffd94a'; ctx.lineWidth = 3;
  rr(x, y, w, h, 12); ctx.stroke();
  text(d.atkLabel + ' 对 ' + d.defLabel, x + 20, y + 28, size + 2, '#ffd94a', 'left', true);
  text(d.result || '', x + w - 18, y + 28, size, d.result && d.result.indexOf('成功') >= 0 ? '#9dffb0' : '#ffb0b0', 'right', true);
  var atkLine = (d.atkAttrs || []).map(function (b) { return b.k + ' ' + b.v; }).join('  ');
  var defLine = (d.defAttrs || []).map(function (b) { return b.k + ' ' + b.v; }).join('  ');
  text(d.atkName + '  ' + atkLine, x + 20, y + 78, small, '#d6e6ff', 'left', true);
  text('摇摆 ' + d.swingA + '  体能 ' + d.fatA + '  →  ' + d.aScore, x + 20, y + 112, small, '#ffffff', 'left');
  text(d.defName + '  ' + defLine + (d.support ? '  +' + d.support + '协防' : ''), x + 20, y + 156, small, '#ffd0d0', 'left', true);
  text('摇摆 ' + d.swingD + '  体能 ' + d.fatD + '  →  ' + d.dScore, x + 20, y + 190, small, '#ffffff', 'left');
  text('点按或取消关闭', x + w - 18, y + h - 22, Math.max(14, small - 2), '#9fb4dd', 'right');
}
function drawDuelSettlement(a) {
  var d = a.duel;
  if (!d) return;
  if (DEBUG) { drawDuelBreakdown(a, d); return; }
  drawDuelResultOnly(a, d);
}

function drawCutin() {
  if (!state || !state.lastAction) return;
  var a = state.lastAction;
  if (a.duel) { drawDuelSettlement(a); return; }
  // ★ 漫画分镜优先。图还没到就退回旧的 webp 演出。
  if (a.cut && typeof drawMangaCutin === 'function') {
    if (ui.cutSkipId === cutActionId(a)) {
      if (typeof mangaCutAvailable === 'function' && mangaCutAvailable(a)) return;
    } else if (drawMangaCutin(a, performance.now())) return;
  }
  if (typeof mangaHasCut === 'function' && mangaHasCut(a.cut)) return;
  // ★ 有演出图键 → 全屏像素风结算演出（仿《天使之翼》指令结算画面）
  var im = a.cut && ensureCutImg(a.cut);
  if (im && im.complete && im.naturalWidth) {
    if (ui.cutSkipId !== cutActionId(a)) drawCutscene(a, im);
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
  // 左侧事件条：记分牌下面。选人菜单在它右边，两块不叠在一起。
  var x = 16, y = 168, w = 300, h = 168;
  var verdict = restartVerdict(a);
  var awarded = verdict !== (a.success ? '成功！' : '失败…');
  var good = a.success || (awarded && a.team === 'home') || a.kind === 'advantage';
  panel(x, y, w, h, good ? '#2b5fe3' : '#8a2b2b');
  text(a.label, x + 16, y + 26, 22, '#fff', 'left', true);
  text(verdict, x + 16, y + 56, 16, good ? '#7fd0ff' : '#ff9a9a', 'left', true);
  wrapText(a.text, x + 16, y + 84, w - 32, 14, '#e8eeff', 3);
  text(a.playerName, x + 16, y + h - 18, 14, '#ffd94a', 'left');
}

function restartVerdict(a) {
  var ours = a.team === 'home';
  if (a.kind === 'foul') return ours ? '对方犯规，我方主罚' : '我方犯规，对方获得定位球';
  if (a.kind === 'penalty') return ours ? '我方获得点球' : '对方获得点球';
  if (a.kind === 'offside') return ours ? '对方越位，我方主罚' : '我方越位，对方获得任意球';
  if (a.kind === 'corner') return ours ? '我方获得角球' : '对方获得角球';
  if (a.kind === 'throwin') return ours ? '我方获得界外球' : '对方获得界外球';
  if (a.kind === 'goalkick') return ours ? '我方获得球门球' : '对方获得球门球';
  if (a.kind === 'advantage') return '进攻有利，比赛继续';
  return a.success ? '成功！' : '失败…';
}

// ★ 全屏结算演出：暗场 + 像素风拼贴特写 + 标题 + 文字解说
function drawCutscene(a, im) {
  ctx.fillStyle = 'rgba(4,6,14,0.88)';
  ctx.fillRect(0, 0, W, H);
  // 图片 3:2，按屏宽自适应（手机竖屏也能看全）
  var iw = Math.min(680, W - 40), ih = iw * 2 / 3;
  var ix = (W - iw) / 2, iy = Math.max(50, (H - ih) / 2 - 70);
  ctx.drawImage(im, ix, iy, iw, ih);
  // ★ 盖掉底图上烤死的假记分牌（TIME 89:32 / 1-1 / EXTRA TIME），画真实比分与时间
  var barH = ih * 0.105;
  ctx.fillStyle = '#0a0e1c';
  ctx.fillRect(ix, iy, iw, barH);
  ctx.strokeStyle = '#3d5a99'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(ix, iy + barH); ctx.lineTo(ix + iw, iy + barH); ctx.stroke();
  if (state) {
    text(state.clockLabel || '', ix + 14, iy + barH / 2, 17, '#ffd94a', 'left', true);
    text(state.score.home + ' - ' + state.score.away, ix + iw / 2, iy + barH / 2, 22, '#fff', 'center', true);
    text(state.halfLabel || '', ix + iw - 14, iy + barH / 2, 17, '#ff9a9a', 'right', true);
  }
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
  text(isTouch ? '触摸任意处 跳过' : 'Enter / 空格 / 点击  跳过', W / 2, iy + ih + 146, 14, '#8fa3cc', 'center');
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
    (function (v) { addClick(bx, by, bw, bh, function () { ui.halfLength = v; saveSettings(); }); })(o.value);
  });
  text('（半场时长在下场比赛生效）', x + 40, y + 210, 14, '#5f7099', 'left');
  text('战术倾向可在暂停菜单中随时切换', x + 40, y + 236, 14, '#5f7099', 'left');
  ctx.fillStyle = '#2b5fe3'; rr(x + w / 2 - 70, y + h - 52, 140, 36, 6); ctx.fill();
  text('关闭', x + w / 2, y + h - 34, 18, '#fff', 'center', true);
  addClick(x + w / 2 - 70, y + h - 52, 140, 36, function () { ui.overlay = null; });
}

function drawFulltime() {
  finishCareerIfDone();
  ctx.fillStyle = 'rgba(4,6,14,0.92)'; ctx.fillRect(0, 0, W, H);
  var x = 440, y = 190, w = 400, h = 340;
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(x - 6, y - 6, w + 12, h + 12);
  panel(x, y, w, h, '#e8a923');
  text('全场比赛结束', x + w / 2, y + 44, 30, '#ffd94a', 'center', true);
  text((state && state.homeName) || '青鹰高校', x + w / 2 - 110, y + 110, 18, '#7fa8ff', 'center', true);
  text((state && state.awayName) || '烈风学院', x + w / 2 + 110, y + 110, 18, '#ff9a9a', 'center', true);
  text(state.score.home + '  -  ' + state.score.away, x + w / 2, y + 160, 54, '#fff', 'center', true);
  var res = state.score.home > state.score.away ? '🏆 胜利！' : state.score.home < state.score.away ? '失败…' : '平局';
  text(res, x + w / 2, y + 216, 26, '#fff', 'center', true);
  text('射门 ' + state.shots.home + ' - ' + state.shots.away, x + w / 2, y + 250, 16, '#9fb4dd', 'center');
  ctx.fillStyle = '#2b5fe3'; rr(x + w / 2 - 90, y + h - 64, 180, 44, 6); ctx.fill();
  var backLabel = ui.careerFix ? '返回俱乐部' : '返回标题';
  text(backLabel, x + w / 2, y + h - 42, 19, '#fff', 'center', true);
  addClick(x + w / 2 - 90, y + h - 64, 180, 44, function () {
    if (ui.careerFix) returnToCareer();
    else exitMatch();
  });
}

function drawToast() {
  if (state && state.lastAction && state.lastAction.duel) return;
  if (!ui.toast || Date.now() > ui.toastUntil) return;
  var menuUi = screen === 'title' || screen === 'career';
  var y = menuUi ? menuChrome().toastY : (H - 40);
  ctx.font = '17px "PingFang SC","Microsoft YaHei",monospace';
  var tw = ctx.measureText(ui.toast).width + 40;
  ctx.fillStyle = 'rgba(8,12,26,0.92)';
  rr(W / 2 - tw / 2, y, tw, 32, 6); ctx.fill();
  ctx.strokeStyle = '#3d5a99'; ctx.lineWidth = 1.5; ctx.stroke();
  text(ui.toast, W / 2, y + 16, 17, '#ffd94a', 'center');
}

// ---------------- 主循环 ----------------
// ★ 渲染循环永不死（2026-10-12 试玩：偶发"判定中…"冻结——frame 内一次异常就永久停帧，
//   且 err 诊断行由同一循环绘制，死后错误永远不可见）。异常只记入 dbgErr，循环继续，
//   下帧照常绘制，错误可见、可恢复。
function frame(t) {
  try {
    frameInner(t);
  } catch (err) {
    dbgErr = 'ERR: ' + ((err && err.message) || err);
    if (typeof console !== 'undefined') console.error(err);
    if (DEBUG_HUD) try {
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(8, 8, 460, 30);
      ctx.fillStyle = '#ff6b6b'; ctx.font = '14px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(dbgErr, 14, 12);
    } catch (e) {}
  }
  requestAnimationFrame(frame);
}
function frameInner(t) {
  frameNo++;
  clickables = [];
  applyVisualViewport();
  syncFsButton();
  syncTouchLayer();
  driveStickAim();
  driveStickList();
  ctx.clearRect(0, 0, W, H);
  if (screen === 'title') drawTitle();
  else if (screen === 'career') drawCareer();
  else {
    if (!state) {
      ctx.fillStyle = '#0b1020'; ctx.fillRect(0, 0, W, H);
      text('连接服务器中…', W / 2, H / 2, 24, '#9fb4dd', 'center');
    } else {
      drawGame(t);
    }
  }
  drawToast();
  if (DEBUG_HUD) { // 左上角诊断行：只有 ?debug=1&hud=1 才画
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
}

// ★ debug 自动开赛：?debug=1&autostart=1 时跳过标题界面直接开赛，
//   浏览器自动化测试不再依赖画布点击"开始比赛"按钮。
if (/[?&]autostart=1/.test(location.search)) {
  setTimeout(function () { if (screen === 'title') startMatch(); }, 600);
}

// 漫画分镜在另一个脚本里，读的是页面上的画布和字幕函数。
Object.defineProperty(window, 'ctx', { get: function () { return ctx; } });
Object.defineProperty(window, 'W', { get: function () { return W; } });
Object.defineProperty(window, 'H', { get: function () { return H; } });
Object.defineProperty(window, 'state', { get: function () { return state; } });
Object.defineProperty(window, 'isTouch', { get: function () { return isTouch; } });
window.__touchLayout = function () {
  return {
    stick: { x: STICK.x, y: STICK.y, r: STICK.r },
    keys: VKEYS.map(function (b) {
      return { id: b.id, key: b.key, label: b.label, keyLabel: b.keyLabel, x: b.x, y: b.y, r: b.r };
    }),
    menu: { x: MENU_BTN.x, y: MENU_BTN.y, w: MENU_BTN.w, h: MENU_BTN.h },
  };
};
if (DEBUG) {
  window.__touchState = function () {
    var lvl = (typeof hmTop === 'function') ? hmTop() : null;
    return {
      menu: typeof headMenuOpen === 'function' ? headMenuOpen() : false,
      kind: lvl ? lvl.kind : null,
      sel: lvl ? lvl.sel : null,
      stack: ui.hmenu && ui.hmenu.stack ? ui.hmenu.stack.map(function (l) { return l.kind + '#' + l.sel; }).join('>') : '',
      phase: state ? state.phase : null,
      screen: screen,
      titleView: ui.titleView || 'main',
      careerView: ui.careerView || '',
      saveMode: ui.saveMode || '',
      slotFocus: ui.slotFocus || '',
      menuSel: ui.menuSel || 0,
      dec: state && state.decision ? (state.decision.kind || 'command') : null,
      hint: typeof hintMessage === 'function' ? hintMessage() : null,
      pad: { dx: pad.dx, dy: pad.dy },
      stick: { dx: stickVec.dx, dy: stickVec.dy, on: stickVec.on },
      toast: ui.toast && Date.now() <= ui.toastUntil ? ui.toast : '',
      touch: touchDbg.line,
      touchN: touchDbg.n,
      aim: (ui.hmenu && ui.hmenu.pass) ? { x: ui.hmenu.pass.aimX, y: ui.hmenu.pass.aimY } : null,
    };
  };
}
window.text = text;
window.cutActionId = cutActionId;

// vv-layout-v1：按 visualViewport 排画面，地址栏不再盖住底部按键。
var chromeSim = (function () {
  var m = /[?&]chrome=(\d+)/.exec((location && location.search) || '');
  return m ? Math.min(140, parseInt(m[1], 10) || 0) : 0;
})();
function applyVisualViewport() {
  var root = document.documentElement;
  if (!root || !root.style || !root.style.setProperty) return;
  var vv = window.visualViewport;
  var top = vv ? vv.offsetTop : 0;
  var left = vv ? vv.offsetLeft : 0;
  var w = vv ? vv.width : (window.innerWidth || root.clientWidth || 800);
  var h = vv ? vv.height : (window.innerHeight || root.clientHeight || 600);
  if (chromeSim) h = Math.max(160, h - chromeSim);
  root.style.setProperty('--vv-top', top + 'px');
  root.style.setProperty('--vv-left', left + 'px');
  root.style.setProperty('--vv-width', w + 'px');
  root.style.setProperty('--vv-height', h + 'px');
  var bar = document.getElementById('chrome-sim');
  if (bar && bar.style) {
    if (chromeSim) {
      bar.hidden = false;
      bar.style.height = chromeSim + 'px';
    } else if ('hidden' in bar) bar.hidden = true;
  }
}
function fullscreenNode() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function canFullscreen() {
  var el = document.documentElement;
  if (!el) return false;
  var req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (typeof req !== 'function') return false;
  if (document.fullscreenEnabled === false) return false;
  var exit = document.exitFullscreen || document.webkitExitFullscreen;
  return typeof exit === 'function';
}
function syncFsButton() {
  var btn = document.getElementById('fs-btn');
  if (!btn) return;
  var show = canFullscreen() && isTouch && !portraitLock();
  btn.hidden = !show;
  if (!show) return;
  btn.textContent = fullscreenNode() ? '退出全屏' : '全屏';
}
function toggleFullscreen() {
  if (!canFullscreen()) return;
  var el = document.documentElement;
  if (fullscreenNode()) {
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    try { exit.call(document); } catch (err) {}
    return;
  }
  var req = el.requestFullscreen || el.webkitRequestFullscreen;
  try {
    var ret = req.call(el);
    if (ret && ret.catch) ret.catch(function () {});
  } catch (err) {}
}
applyVisualViewport();
if (window.visualViewport && window.visualViewport.addEventListener) {
  window.visualViewport.addEventListener('resize', applyVisualViewport);
  window.visualViewport.addEventListener('scroll', applyVisualViewport);
}
window.addEventListener('resize', applyVisualViewport);
window.addEventListener('orientationchange', applyVisualViewport);
document.addEventListener('fullscreenchange', syncFsButton);
document.addEventListener('webkitfullscreenchange', syncFsButton);
var fsBtn = document.getElementById('fs-btn');
if (fsBtn && fsBtn.addEventListener) {
  fsBtn.addEventListener('click', function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    toggleFullscreen();
  });
}

loadSettings();
try {
  var bootCareer = careerApi();
  if (bootCareer && bootCareer.ensureMigrated) {
    var bootNote = bootCareer.ensureMigrated(null);
    if (bootNote && bootNote.damaged) toast('旧存档损坏，没有迁进自动存档', 3200);
  }
} catch (bootErr) {}

requestAnimationFrame(frame);
})();
