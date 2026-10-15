// ---------------- 漫画分镜引擎（动态判定动画） ----------------
// 动态漫画风判定演出：分镜面板 + 拟声词 + 速度线 + 震屏，全部代码驱动。
// 人物姿势图用占位符体系，走 kits.js 换色管线（球衣图案/肤色/球鞋），保证可替换。
var MANGA = {
  imgs: {},        // pose -> {home: Image, away: Image}
  ready: false,
  startT: 0,       // 本次分镜开始时间
  lastId: null,    // 上次播放的 action id
};
var MANGA_POSES = ['feint', 'frozen', 'burst'];
var MANGA_V = 'manga1';

function mangaRecolor(src, team) {
  // 按 kits.js 管线换色：标球鞋占位符 → 球衣图案/颜色 → 肤色
  var cv = document.createElement('canvas');
  cv.width = src.naturalWidth; cv.height = src.naturalHeight;
  var cx = cv.getContext('2d');
  cx.drawImage(src, 0, 0);
  var id = cx.getImageData(0, 0, cv.width, cv.height);
  if (typeof SharedKits !== 'undefined') {
    if (SharedKits.markShoePlaceholders) SharedKits.markShoePlaceholders(id, cv.width, cv.height);
    var spec = SharedKits.resolveKit(team, null);
    SharedKits.recolorImageData(id, { home: spec }, 32, { pattern: spec.pattern });
    if (SharedKits.recolorSkin) SharedKits.recolorSkin(id, 'fair');
    cx.putImageData(id, 0, 0);
  }
  var out = new Image();
  out.src = cv.toDataURL();
  return out;
}

function mangaInit() {
  MANGA_POSES.forEach(function (name) {
    var src = new Image();
    src.onload = function () {
      try {
        MANGA.imgs[name] = {
          home: mangaRecolor(src, 'home'),
          away: mangaRecolor(src, 'away'),
        };
        // 三张都就绪才算 ready
        if (MANGA_POSES.every(function (k) { return MANGA.imgs[k]; })) MANGA.ready = true;
      } catch (e) {}
    };
    src.src = 'assets/manga/' + name + '.png?v=' + MANGA_V;
  });
}

// ---------- 漫画视觉元素 ----------

// 分镜面板：黑边 + 白底 + 网点纸
function mangaPanel(x, y, w, h, rot) {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(rot || 0);
  ctx.translate(-w / 2, -h / 2);
  // 网点纸底
  ctx.fillStyle = '#f4f1e8';
  ctx.fillRect(0, 0, w, h);
  mangaTone(0, 0, w, h, 6, 'rgba(0,0,0,0.06)');
  // 黑边（漫画描线）
  ctx.strokeStyle = '#111'; ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, w - 6, h - 6);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, w - 20, h - 20);
  ctx.restore();
}

// 网点纸
function mangaTone(x, y, w, h, gap, color) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = color;
  for (var yy = y + gap / 2; yy < y + h; yy += gap)
    for (var xx = x + gap / 2; xx < x + w; xx += gap) {
      ctx.beginPath(); ctx.arc(xx, yy, 1.2, 0, Math.PI * 2); ctx.fill();
    }
  ctx.restore();
}

// 速度线（从焦点放射）
function mangaSpeedLines(cx, cy, r0, r1, n, color, lw) {
  ctx.save();
  ctx.strokeStyle = color || '#111'; ctx.lineWidth = lw || 3;
  ctx.beginPath();
  for (var i = 0; i < n; i++) {
    var a = (i / n) * Math.PI * 2 + 0.3;
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
  }
  ctx.stroke();
  ctx.restore();
}

// 拟声词：粗黑描边 + 白字 + 弹出动画
function mangaSFX(text, x, y, size, rot, pop) {
  // pop: 0..1 弹出进度
  var s = size * (0.6 + 0.4 * easeOutBack(Math.min(1, pop * 1.4)));
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot || -0.08);
  ctx.font = '900 ' + Math.round(s) + 'px "Noto Sans SC", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(4, s * 0.12); ctx.strokeStyle = '#111';
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillText(text, 0, 0);
  ctx.restore();
}
function easeOutBack(x) {
  var c = 1.70158;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
}

// 冲击闪光
function mangaFlash(alpha) {
  if (alpha <= 0) return;
  ctx.fillStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';
  ctx.fillRect(0, 0, W, H);
}

// 二次贝塞尔曲线点（闪身轨迹用）
function qbez(p0, pc, p1, t) {
  var u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * pc.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * pc.y + t * t * p1.y,
  };
}

// ---------- dribble-win 分镜时间线 ----------
// 四幕：假动作（0-0.9s）→ 呆住+扬长而去（0.9-1.8s）→ 闪身轨迹（1.8-2.7s）→ 突破（2.7s+）
function drawMangaDribbleWin(a, t) {
  var id = cutActionId(a);
  if (MANGA.lastId !== id) { MANGA.lastId = id; MANGA.startT = t; }
  var el = (t - MANGA.startT) / 1000; // 秒

  var atkTeam = a.team === 'away' ? 'away' : 'home';
  var defTeam = atkTeam === 'home' ? 'away' : 'home';
  var feintIm = MANGA.imgs.feint && MANGA.imgs.feint[atkTeam];
  var frozenIm = MANGA.imgs.frozen && MANGA.imgs.frozen[defTeam];
  var burstIm = MANGA.imgs.burst && MANGA.imgs.burst[atkTeam];

  // 暗场
  ctx.fillStyle = 'rgba(4,6,14,0.92)';
  ctx.fillRect(0, 0, W, H);

  var ACT = 0.9; // 每幕秒数
  var act = el < ACT ? 0 : el < ACT * 2 ? 1 : el < ACT * 3 ? 2 : 3;
  var ae = el - act * ACT; // 本幕内经过秒数

  // 震屏（每幕切换时）
  var shake = ae < 0.22 ? 8 : 0;
  ctx.save();
  ctx.translate(shake ? (Math.random() - 0.5) * shake : 0, shake ? (Math.random() - 0.5) * shake : 0);

  var cx = W / 2, pw = Math.min(620, W - 60), ph = pw * 0.72;
  var py = Math.max(40, (H - ph) / 2 - 60);
  var gy = py + ph - 8; // 地面线
  var p = Math.min(1, ae / 0.25); // 砸入进度
  var sc = 0.7 + 0.3 * easeOutBack(p);

  function beginPanel(rot) {
    ctx.save();
    ctx.translate(cx, py + ph / 2); ctx.scale(sc, sc); ctx.translate(-cx, -(py + ph / 2));
    mangaPanel(cx - pw / 2, py, pw, ph, rot);
  }
  function imOk(im) { return im && im.complete && im.naturalWidth; }

  if (act === 0) {
    // ===== 第一幕：假动作 =====
    beginPanel(-0.02);
    if (imOk(feintIm)) {
      var ih = ph * 0.92;
      ctx.drawImage(feintIm, cx - ih / 2, gy - ih, ih, ih);
    }
    ctx.restore();
    mangaSpeedLines(cx, py + ph / 2, 60, pw * 0.7, 24, '#111', 2.5);
    if (ae > 0.3) mangaSFX('假动作！', cx, py + 70, 54, -0.1, (ae - 0.3) / 0.3);
    mangaFlash(Math.max(0, 0.7 - ae * 2));
  } else if (act === 1) {
    // ===== 第二幕：呆住（前景）+ 控球者扬长而去（背景）=====
    beginPanel(0.015);
    // 背景：控球者小号在右后方离去
    if (imOk(burstIm)) {
      var bh = ph * 0.52, bx = cx + pw * 0.22, bgy = gy - ph * 0.10;
      ctx.globalAlpha = 0.92;
      ctx.drawImage(burstIm, bx - bh / 2, bgy - bh, bh, bh);
      ctx.globalAlpha = 1;
      // 离去的横向速度线
      ctx.save();
      ctx.strokeStyle = '#111'; ctx.lineWidth = 3;
      ctx.beginPath();
      for (var li = 0; li < 4; li++) {
        var ly = bgy - bh * 0.25 - li * bh * 0.18;
        ctx.moveTo(bx - bh / 2 - 70, ly);
        ctx.lineTo(bx - bh / 2 - 14, ly);
      }
      ctx.stroke();
      ctx.restore();
    }
    // 前景：防守人呆住，僵直颤抖
    if (imOk(frozenIm)) {
      var ih2 = ph * 0.88;
      var tremble = Math.sin(el * 40) * 3;
      ctx.drawImage(frozenIm, cx - pw * 0.12 - ih2 / 2 + tremble, gy - ih2, ih2, ih2);
    }
    ctx.restore();
    if (ae > 0.35) mangaSFX('！', cx - pw * 0.12, py + 84, 88, 0.12, (ae - 0.35) / 0.3);
    mangaFlash(Math.max(0, 0.5 - ae * 2));
  } else if (act === 2) {
    // ===== 第三幕：闪身而过 — 带球轨迹 + 残影 =====
    beginPanel(-0.01);
    // 防守人被留在左侧
    if (imOk(frozenIm)) {
      var dh = ph * 0.62, dx = cx - pw * 0.30;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(frozenIm, dx - dh / 2, gy - dh, dh, dh);
      ctx.globalAlpha = 1;
    }
    // 闪身弧线：从防守人身侧绕过
    var p0 = { x: cx - pw * 0.22, y: gy };
    var pc = { x: cx + pw * 0.02, y: gy - ph * 0.42 };
    var p1 = { x: cx + pw * 0.30, y: gy };
    ctx.save();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 4; ctx.setLineDash([14, 9]);
    ctx.beginPath();
    for (var si = 0; si <= 24; si++) {
      var spt = qbez(p0, pc, p1, si / 24);
      if (si === 0) ctx.moveTo(spt.x, spt.y); else ctx.lineTo(spt.x, spt.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    // 三重残影沿轨迹
    if (imOk(burstIm)) {
      var ghosts = [
        { t: 0.38, alpha: 0.22, s: 0.62 },
        { t: 0.68, alpha: 0.45, s: 0.80 },
        { t: 1.00, alpha: 1.00, s: 0.95 },
      ];
      for (var gi = 0; gi < ghosts.length; gi++) {
        var g = ghosts[gi], gp = qbez(p0, pc, p1, g.t);
        var gh = ph * 0.80 * g.s;
        ctx.globalAlpha = g.alpha;
        ctx.drawImage(burstIm, gp.x - gh / 2, gp.y - gh, gh, gh);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    mangaSpeedLines(cx + pw * 0.18, py + ph * 0.45, 40, pw * 0.5, 20, '#111', 3);
    if (ae > 0.3) mangaSFX('唰！', cx + pw * 0.08, py + 64, 60, -0.06, (ae - 0.3) / 0.3);
    mangaFlash(Math.max(0, 0.55 - ae * 2));
  } else {
    // ===== 第四幕：突破 =====
    beginPanel(-0.01);
    if (imOk(burstIm)) {
      var ih3 = ph * 0.95;
      ctx.drawImage(burstIm, cx - ih3 / 2, gy - ih3, ih3, ih3);
    }
    ctx.restore();
    mangaSpeedLines(cx, py + ph / 2, 40, pw * 0.75, 36, '#111', 3.5);
    if (ae > 0.3) mangaSFX('突破！', cx, py + 70, 64, -0.06, (ae - 0.3) / 0.3);
    mangaFlash(Math.max(0, 0.6 - ae * 2));
  }
  ctx.restore(); // 震屏

  // 底部信息条（比分/标题/跳过提示，复用现有风格）
  drawMangaBar(a);
}

function drawMangaBar(a) {
  var bw = Math.min(620, W - 60), bx = (W - bw) / 2;
  var by = Math.max(40, (H - bw * 0.72) / 2 - 60) + bw * 0.72 + 16;
  ctx.fillStyle = '#0a0e1c';
  ctx.fillRect(bx, by, bw, 34);
  ctx.strokeStyle = '#ffd94a'; ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, 34);
  if (state) {
    text(state.clockLabel || '', bx + 12, by + 17, 15, '#ffd94a', 'left', true);
    text(state.score.home + ' - ' + state.score.away, bx + bw / 2, by + 17, 18, '#fff', 'center', true);
    text(a.label || '', bx + bw - 12, by + 17, 15, '#7fd0ff', 'right', true);
  }
  text(a.playerName || '', W / 2, by + 58, 15, '#ffd94a', 'center');
  text(isTouch ? '触摸任意处 跳过' : 'Enter / 空格 / 点击  跳过', W / 2, by + 82, 13, '#8fa3cc', 'center');
}

// 入口：drawCutin 里对 dribble-win 改走漫画分镜
function drawMangaCutin(a, t) {
  if (!MANGA.ready) return false;
  if (a.cut === 'dribble-win') { drawMangaDribbleWin(a, t); return true; }
  return false;
}
