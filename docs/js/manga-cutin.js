// ---------------- 漫画分镜引擎（动态判定动画） ----------------
// 动态漫画风判定演出：分镜面板 + 拟声词 + 速度线 + 震屏，全部代码驱动。
// 人物姿势图用占位符体系，走 kits.js 换色管线（球衣图案/肤色/球鞋），保证可替换。
var MANGA = {
  imgs: {},        // pose -> {home: Image, away: Image}
  ready: false,
  startT: 0,       // 本次分镜开始时间
  lastId: null,    // 上次播放的 action id
};
// 单图方案（2026-10-15 用户拍板）：只用 Grok 截图抠图改占位色的复合图
var MANGA_POSES = ['grok_beaten'];
// 背景图（球场+观众席）不需要换色，单独加载
MANGA.bgImgs = {};
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

// 复合图换色：主队占位色→进攻方，客队占位色→防守方（结算图只认纯色，不铺图案）
function mangaRecolorComposite(src, atkTeam, defTeam) {
  var cv = document.createElement('canvas');
  cv.width = src.naturalWidth; cv.height = src.naturalHeight;
  var cx = cv.getContext('2d');
  cx.drawImage(src, 0, 0);
  var id = cx.getImageData(0, 0, cv.width, cv.height);
  if (typeof SharedKits !== 'undefined') {
    var atkSpec = SharedKits.resolveKit(atkTeam, null);
    var defSpec = SharedKits.resolveKit(defTeam, null);
    // home 占位符画的是进攻者，away 占位符画的是防守者
    SharedKits.recolorImageData(id, { home: atkSpec, away: defSpec }, 32, {});
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
        if (name === 'beaten' || name === 'grok_beaten') {
          // 复合图：按攻守双方分别换色
          MANGA.imgs[name] = {
            home: mangaRecolorComposite(src, 'home', 'away'),
            away: mangaRecolorComposite(src, 'away', 'home'),
          };
        } else {
          MANGA.imgs[name] = {
            home: mangaRecolor(src, 'home'),
            away: mangaRecolor(src, 'away'),
          };
        }
        // 全部就绪才算 ready
        if (MANGA_POSES.every(function (k) { return MANGA.imgs[k]; })) MANGA.ready = true;
      } catch (e) {}
    };
    src.src = 'assets/manga/' + name + '.png?v=' + MANGA_V;
  });
  // 背景图单独加载（不换色）
  var bgsrc = new Image();
  bgsrc.onload = function () { MANGA.bgImgs.stadium = bgsrc; };
  bgsrc.src = 'assets/manga/stadium_bg.jpg?v=' + MANGA_V;
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
// 四幕：假动作（0-0.9s）→ 被过复合（0.9-1.8s）→ 扬长而去（1.8-2.7s）→ 突破（2.7s+）
function drawMangaDribbleWin(a, t) {
  var id = cutActionId(a);
  if (MANGA.lastId !== id) { MANGA.lastId = id; MANGA.startT = t; }
  var el = (t - MANGA.startT) / 1000; // 秒

  var atkTeam = a.team === 'away' ? 'away' : 'home';
  var grokIm = MANGA.imgs.grok_beaten && MANGA.imgs.grok_beaten[atkTeam];
  var stadiumIm = MANGA.bgImgs.stadium;

  // 暗场
  ctx.fillStyle = 'rgba(4,6,14,0.92)';
  ctx.fillRect(0, 0, W, H);

  // 开场震屏
  var shake = el < 0.22 ? 8 : 0;
  ctx.save();
  ctx.translate(shake ? (Math.random() - 0.5) * shake : 0, shake ? (Math.random() - 0.5) * shake : 0);

  var cx = W / 2, pw = Math.min(680, W - 40), ph = pw * 0.72;
  var py = Math.max(40, (H - ph) / 2 - 60);
  var p = Math.min(1, el / 0.25); // 砸入进度
  var sc = 0.7 + 0.3 * easeOutBack(p);

  function imOk(im) { return im && im.complete && im.naturalWidth; }

  // 单图：面板砸入 + 球场背景 + 复合图
  ctx.save();
  ctx.translate(cx, py + ph / 2); ctx.scale(sc, sc); ctx.translate(-cx, -(py + ph / 2));
  // 先画边框（不填充底色，背景图当底）
  ctx.save();
  ctx.translate(cx, py + ph / 2); ctx.rotate(-0.01); ctx.translate(-cx, -(py + ph / 2));
  ctx.strokeStyle = '#111'; ctx.lineWidth = 6;
  ctx.strokeRect(cx - pw / 2 + 3, py + 3, pw - 6, ph - 6);
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - pw / 2 + 10, py + 10, pw - 20, ph - 20);
  ctx.restore();
  // 面板内区域裁剪画背景和人物
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - pw / 2 + 12, py + 12, pw - 24, ph - 24);
  ctx.clip();
  if (stadiumIm && stadiumIm.complete && stadiumIm.naturalWidth) {
    var bw = pw, bh = bw * stadiumIm.naturalHeight / stadiumIm.naturalWidth;
    if (bh < ph) { bh = ph; bw = bh * stadiumIm.naturalWidth / stadiumIm.naturalHeight; }
    ctx.drawImage(stadiumIm, cx - bw / 2, py + ph - bh, bw, bh);
  } else {
    // 背景没加载时用网点纸兜底
    ctx.fillStyle = '#f4f1e8';
    ctx.fillRect(cx - pw / 2 + 12, py + 12, pw - 24, ph - 24);
  }
  if (imOk(grokIm)) {
    // 远景构图：人物缩小，多露球场
    var iw = pw * 0.72, ih = iw * grokIm.naturalHeight / grokIm.naturalWidth;
    if (ih > ph * 0.72) { ih = ph * 0.72; iw = ih * grokIm.naturalWidth / grokIm.naturalHeight; }
    // 人物放下面，脚踩草地
    ctx.drawImage(grokIm, cx - iw / 2, py + ph - ih - 14, iw, ih);
  }
  ctx.restore(); // clip
  ctx.restore(); // panel transform

  // 拟声词
  if (el > 0.35) mangaSFX('突破！', cx, py + 66, 58, -0.08, (el - 0.35) / 0.3);
  mangaFlash(Math.max(0, 0.6 - el * 2));

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
