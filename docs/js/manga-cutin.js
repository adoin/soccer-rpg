// ---------------- 漫画分镜 ----------------
// 每张切入图自带草地和白线。A/B 色键按本场球员换球衣、短裤（球袜同色）、
// 球鞋、皮肤和头发。速度线是代码画的风线，不画一串球。
var MANGA = {
  srcs: {},
  ready: false,
  startT: 0,
  lastId: null,
  cache: {},
};
var MANGA_V = 'manga8';

// a / b：这张图里品红/青（A）和橙/紫（B）分别对应 action.roles 的哪个角色。
// trail.split 为真时，start→impact 是被改变前的淡线，impact→end 是加粗的新路线。
var MANGA_CUTS = {
  'dribble-win':  { pose: 'dribble_win', sfx: '突破！', shake: 8, a: 'attacker', b: 'defender',
    trail: { start: [0.40, 0.70], end: [0.76, 0.75] } },
  'feint-win':    { pose: 'dribble_win', sfx: '晃开！', shake: 6, a: 'attacker', b: 'defender',
    trail: { start: [0.38, 0.68], end: [0.76, 0.75] } },
  'shield-win':   { pose: 'shield_win', sfx: '护球！', shake: 5, a: 'holder', b: 'presser',
    trail: { start: [0.42, 0.68], end: [0.72, 0.75] } },
  'dribble-lose': { pose: 'tackle_win', sfx: '抢断！', shake: 8, a: 'tackler', b: 'dribbler',
    trail: { start: [0.74, 0.64], end: [0.52, 0.71] } },
  'tackle-win':   { pose: 'tackle_win', sfx: '抢断！', shake: 8, a: 'tackler', b: 'dribbler',
    trail: { start: [0.74, 0.64], end: [0.52, 0.71] } },
  'intercept':    { pose: 'intercept', sfx: '拦截！', shake: 6, a: 'passer', b: 'interceptor',
    trail: { start: [0.14, 0.40], end: [0.46, 0.60] } },
  'header-duel':  { pose: 'header_duel', sfx: '争顶！', shake: 7, a: 'loser', b: 'winner',
    trail: { start: [0.22, 0.52], impact: [0.52, 0.28], end: [0.78, 0.10], split: true } },
  'shot-blocked': { pose: 'shot_blocked', sfx: '封堵！', shake: 8, a: 'shooter', b: 'blocker',
    trail: { start: [0.76, 0.48], impact: [0.32, 0.35], end: [0.16, 0.52], split: true } },
  'clearance':    { pose: 'clearance', sfx: '解围！', shake: 6, a: 'chaser', b: 'clearer',
    trail: { start: [0.26, 0.70], impact: [0.56, 0.58], end: [0.80, 0.18], split: true } },
  'shoot-goal':   { pose: 'goal', sfx: '进球！', shake: 10, a: 'scorer', b: 'keeper',
    trail: { start: [0.78, 0.52], end: [0.42, 0.64] } },
  'special-goal': { pose: 'goal', sfx: '进球！', shake: 10, a: 'scorer', b: 'keeper',
    trail: { start: [0.78, 0.50], end: [0.42, 0.64] } },
  'gk-catch':     { pose: 'gk_catch', sfx: '没收！', shake: 6, a: 'shooter', b: 'keeper',
    trail: { start: [0.74, 0.48], end: [0.41, 0.36] } },
  'shoot-save':   { pose: 'gk_catch', sfx: '扑救！', shake: 8, a: 'shooter', b: 'keeper',
    trail: { start: [0.74, 0.48], end: [0.41, 0.36] } },
  'special-save': { pose: 'gk_catch', sfx: '扑救！', shake: 8, a: 'shooter', b: 'keeper',
    trail: { start: [0.74, 0.46], end: [0.41, 0.36] } },
  'gk-parry':     { pose: 'gk_parry_byline', sfx: '扑出底线！', shake: 8, a: 'shooter', b: 'keeper',
    trail: { start: [0.55, 0.62], impact: [0.34, 0.34], end: [0.15, 0.31], split: true } },
  'gk-tip':       { pose: 'gk_tip_over', sfx: '托出！', shake: 8, a: 'shooter', b: 'keeper',
    trail: { start: [0.24, 0.58], impact: [0.48, 0.30], end: [0.50, 0.12], split: true } },
  'gk-spill':     { pose: 'gk_spill', sfx: '脱手！', shake: 7, a: 'shooter', b: 'keeper',
    trail: { start: [0.18, 0.42], impact: [0.50, 0.46], end: [0.37, 0.77], split: true } },
  'gk-rush':      { pose: 'gk_rush_win', sfx: '出击！', shake: 8, a: 'striker', b: 'keeper',
    trail: { start: [0.80, 0.48], end: [0.53, 0.71] } },
  'gk-claim':     { pose: 'gk_claim_cross', sfx: '摘下！', shake: 6, a: 'striker', b: 'keeper',
    trail: { start: [0.12, 0.36], end: [0.53, 0.08] } },
  'round-gk':     { pose: 'round_gk', sfx: '过掉！', shake: 8, a: 'striker', b: 'keeper',
    trail: { start: [0.36, 0.66], end: [0.79, 0.72] } },
  'shot-wide':    { pose: 'shot_wide', sfx: '偏出！', shake: 4, a: 'shooter', b: 'keeper',
    trail: { start: [0.68, 0.52], end: [0.08, 0.41] } },
  'shoot-miss':   { pose: 'shot_wide', sfx: '偏出！', shake: 4, a: 'shooter', b: 'keeper',
    trail: { start: [0.68, 0.52], end: [0.08, 0.41] } },
  'hit-post':     { pose: 'hit_post', sfx: '中柱！', shake: 10, a: 'shooter', b: 'keeper',
    trail: { start: [0.28, 0.55], impact: [0.92, 0.42], end: [0.68, 0.58], split: true } },
  // A 色键是出技能的防守人，B 是持球的进攻者。飞铲和横扫把球从接触点敲走；肩靠和拦江只有撞击。
  'def-skill-flying-tackle': { pose: 'def_flying_tackle', sfx: '离地飞铲！', shake: 9, a: 'defender', b: 'attacker',
    trail: { start: [0.28, 0.72], impact: [0.46, 0.58], end: [0.84, 0.30], ball: true } },
  'def-skill-sweep': { pose: 'def_sweep', sfx: '横扫千军！', shake: 8, a: 'defender', b: 'attacker',
    trail: { start: [0.34, 0.70], impact: [0.50, 0.62], end: [0.86, 0.38], ball: true } },
  'def-skill-shoulder': { pose: 'def_shoulder', sfx: '铁山靠！', shake: 7, a: 'defender', b: 'attacker',
    trail: { impact: [0.52, 0.48], burst: true } },
  'def-skill-elbow': { pose: 'def_elbow', sfx: '铁索拦江！', shake: 8, a: 'defender', b: 'attacker',
    trail: { impact: [0.51, 0.32], burst: true } },
};

function mangaPoseList() {
  var seen = {}, list = [];
  Object.keys(MANGA_CUTS).forEach(function (k) {
    var name = MANGA_CUTS[k].pose;
    if (seen[name]) return;
    seen[name] = true;
    list.push(name);
  });
  return list;
}

function mangaInit() {
  // 开球不等 17 张分镜解码。用到哪张再加载，区域蒙版也只算一次。
  MANGA.ready = true;
}

function mangaPoseImage(name) {
  if (MANGA.srcs[name]) return MANGA.srcs[name];
  var src = new Image();
  src._pose = name;
  MANGA.srcs[name] = src;
  src.onload = function () { src._ok = true; };
  src.onerror = function () { src._bad = true; };
  src.src = 'assets/manga/' + name + '.png?v=' + MANGA_V;
  var labels = new Image();
  labels.onload = function () { labels._ok = true; };
  labels.onerror = function () { labels._bad = true; };
  labels.src = 'assets/manga/labels/' + name + '.png?v=' + MANGA_V;
  src._labels = labels;
  return src;
}

function mangaLookKey(look) {
  if (!look) return '';
  var k = look.kit || {};
  return [look.team || '', look.pos || '', look.skin || '', look.hair || '',
    k.pattern || '', k.primary || '', k.secondary || '', k.shorts || '', k.shoes || ''].join('|');
}

function mangaDecodeLabels(src) {
  if (src._map) return src._map;
  var labels = src._labels;
  if (!labels || !labels._ok || !labels.naturalWidth) return null;
  var cv = document.createElement('canvas');
  cv.width = labels.naturalWidth;
  cv.height = labels.naturalHeight;
  var cx = cv.getContext('2d');
  cx.drawImage(labels, 0, 0);
  var raw = cx.getImageData(0, 0, cv.width, cv.height).data;
  var n = cv.width * cv.height;
  var label = new Uint8Array(n);
  var figure = new Uint8Array(n);
  for (var i = 0; i < n; i++) {
    label[i] = raw[i * 4];
    figure[i] = raw[i * 4 + 1];
  }
  src._map = { label: label, figure: figure, w: cv.width, h: cv.height };
  return src._map;
}

function mangaPaint(src, aLook, bLook) {
  var key = src.src + '>' + mangaLookKey(aLook) + '>' + mangaLookKey(bLook);
  if (MANGA.cache[key]) return MANGA.cache[key];
  var map = mangaDecodeLabels(src);
  if (!map || typeof SharedKits === 'undefined' || !SharedKits.paintMangaLabels) return null;
  var cv = document.createElement('canvas');
  cv.width = src.naturalWidth;
  cv.height = src.naturalHeight;
  var cx = cv.getContext('2d');
  cx.drawImage(src, 0, 0);
  if (!src._pixels) {
    src._pixels = cx.getImageData(0, 0, cv.width, cv.height).data;
  }
  var copy = new Uint8ClampedArray(src._pixels);
  var id = { width: cv.width, height: cv.height, data: copy };
  SharedKits.paintMangaLabels(id, map, aLook || { team: 'home' }, bLook || { team: 'away' });
  var paintedData = cx.createImageData(cv.width, cv.height);
  paintedData.data.set(copy);
  cx.putImageData(paintedData, 0, 0);
  // 直接缓存画布。toDataURL 再解码一次会把第一次播出卡住一两秒。
  MANGA.cache[key] = cv;
  return cv;
}

function mangaHasCut(cut) {
  return !!(cut && MANGA_CUTS[cut]);
}

function mangaDefaultLook(team) {
  return { team: team, skin: 'fair', hair: 'black', kit: null };
}

function mangaLooks(a, cfg) {
  var roles = a.roles || {};
  var aLook = roles[cfg.a];
  var bLook = roles[cfg.b];
  if (aLook && bLook) return { a: aLook, b: bLook };
  var team = a.team === 'away' ? 'away' : 'home';
  var other = team === 'home' ? 'away' : 'home';
  return {
    a: aLook || mangaDefaultLook(team),
    b: bLook || mangaDefaultLook(other),
  };
}

function mangaCutAvailable(a) {
  if (!a || !MANGA.ready) return false;
  var cfg = MANGA_CUTS[a.cut];
  if (!cfg) return false;
  var src = mangaPoseImage(cfg.pose);
  var labels = src && src._labels;
  return !!(src && src._ok && src.complete && src.naturalWidth
    && labels && labels._ok && labels.complete && labels.naturalWidth);
}

function easeOutBack(x) {
  var c = 1.70158;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
}

function mangaSFX(text, x, y, size, rot, pop) {
  var s = size * (0.6 + 0.4 * easeOutBack(Math.min(1, pop * 1.4)));
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot || -0.08);
  ctx.font = '900 ' + Math.round(s) + 'px "Noto Sans SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(4, s * 0.12);
  ctx.strokeStyle = '#111';
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function mangaFlash(alpha) {
  if (alpha <= 0) return;
  ctx.fillStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';
  ctx.fillRect(0, 0, W, H);
}

function qbez(p0, pc, p1, t) {
  var u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * pc.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * pc.y + t * t * p1.y,
  };
}

// 风线：3 到 5 条略弯的细墨线，中间留空，尾端变细变淡。不是一串球。
function mangaWind(p0, p1, t, bold) {
  var dx = p1.x - p0.x, dy = p1.y - p0.y;
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  var nx = -dy / len, ny = dx / len;
  var bow = len * (bold ? 0.10 : 0.07);
  var c = { x: (p0.x + p1.x) / 2 + nx * bow, y: (p0.y + p1.y) / 2 + ny * bow };
  var reach = t < 0 ? 0 : t > 1 ? 1 : t;
  var count = bold ? 5 : 3;
  var dashes = bold ? 5 : 4;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (var s = 0; s < count; s++) {
    var lat = (s - (count - 1) / 2) * (bold ? 5.2 : 3.4);
    for (var d = 0; d < dashes; d++) {
      var u0 = (d / dashes) * reach;
      var u1 = ((d + 0.62) / dashes) * reach;
      if (u1 - u0 < 0.012) continue;
      var mid = (u0 + u1) / 2;
      var alpha = (0.18 + 0.82 * mid) * (bold ? 0.92 : 0.42);
      var lw = (bold ? 2.5 : 1.25) * (0.28 + 0.72 * mid);
      ctx.beginPath();
      for (var k = 0; k <= 5; k++) {
        var u = u0 + (u1 - u0) * k / 5;
        var p = qbez(p0, c, p1, u);
        var wave = Math.sin(u * 5.5 + s * 1.3) * 1.1;
        var x = p.x + nx * (lat + wave);
        var y = p.y + ny * (lat + wave);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(255,255,255,' + (alpha * 0.55).toFixed(3) + ')';
      ctx.lineWidth = lw + 1.6;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(16,16,16,' + alpha.toFixed(3) + ')';
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function mangaTrailPoint(pair, rect) {
  return { x: rect.x + pair[0] * rect.w, y: rect.y + pair[1] * rect.h };
}

function mangaBall(x, y, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#f7f7f7';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.16);
  ctx.strokeStyle = '#111';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x - r * 0.18, y - r * 0.08, r * 0.26, 0, Math.PI * 2);
  ctx.fillStyle = '#222';
  ctx.fill();
  ctx.restore();
}

function mangaBurst(pt, t) {
  // t 是强度 0..1。调用方决定它亮多久。
  var life = t < 0 ? 0 : t > 1 ? 1 : t;
  var fade = life;
  if (fade <= 0) return;
  ctx.save();
  ctx.translate(pt.x, pt.y);
  ctx.lineCap = 'round';
  for (var i = 0; i < 8; i++) {
    var ang = i / 8 * Math.PI * 2 + 0.2;
    var len = 8 + 26 * Math.min(1, life / 0.35);
    ctx.beginPath();
    ctx.moveTo(Math.cos(ang) * 3, Math.sin(ang) * 3);
    ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
    ctx.strokeStyle = 'rgba(255,255,255,' + (fade * 0.45).toFixed(3) + ')';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(16,16,16,' + (fade * 0.95).toFixed(3) + ')';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

function mangaDrawTrails(trail, rect, t, el) {
  if (!trail) return;
  if (trail.burst && trail.impact) {
    // 横幅出来时撞击还在，大约半秒后收掉。
    var age = el == null ? t : el;
    var bt = age < 0.08 ? age / 0.08 : (age < 0.55 ? 1 : Math.max(0, 1 - (age - 0.55) / 0.22));
    mangaBurst(mangaTrailPoint(trail.impact, rect), bt);
    return;
  }
  if (trail.ball && trail.impact && trail.start && trail.end) {
    var from = mangaTrailPoint(trail.start, rect);
    var hitB = mangaTrailPoint(trail.impact, rect);
    var away = mangaTrailPoint(trail.end, rect);
    mangaWind(from, hitB, Math.min(1, t / 0.35), false);
    var u = t < 0.18 ? 0 : Math.min(1, (t - 0.18) / 0.55);
    if (u > 0) mangaWind(hitB, away, u, true);
    mangaBall(hitB.x + (away.x - hitB.x) * u, hitB.y + (away.y - hitB.y) * u, 8);
    return;
  }
  if (!trail.start || !trail.end) return;
  var a = mangaTrailPoint(trail.start, rect);
  var b = mangaTrailPoint(trail.end, rect);
  if (trail.split && trail.impact) {
    var hit = mangaTrailPoint(trail.impact, rect);
    mangaWind(a, hit, Math.min(1, t / 0.55), false);
    if (t > 0.28) mangaWind(hit, b, Math.min(1, (t - 0.28) / 0.55), true);
  } else {
    mangaWind(a, b, t, true);
  }
}

function drawMangaBar(a, py, ph) {
  var bw = Math.min(620, W - 60), bx = (W - bw) / 2;
  var by = py + ph + 16;
  ctx.fillStyle = '#0a0e1c';
  ctx.fillRect(bx, by, bw, 34);
  ctx.strokeStyle = '#ffd94a';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, 34);
  if (state) {
    text(state.clockLabel || '', bx + 12, by + 17, 15, '#ffd94a', 'left', true);
    text(state.score.home + ' - ' + state.score.away, bx + bw / 2, by + 17, 18, '#fff', 'center', true);
    text(a.label || '', bx + bw - 12, by + 17, 15, '#7fd0ff', 'right', true);
  }
  text(a.playerName || '', W / 2, by + 58, 15, '#ffd94a', 'center');
  text(isTouch ? '触摸任意处 跳过' : 'Enter / 空格 / 点击  跳过', W / 2, by + 82, 13, '#8fa3cc', 'center');
}

function drawMangaCutin(a, t) {
  var cfg = a && MANGA_CUTS[a.cut];
  if (!cfg || !MANGA.ready) return false;
  var src = mangaPoseImage(cfg.pose);
  if (!src || !src._ok || !src.complete || !src.naturalWidth) return false;
  var id = cutActionId(a);
  if (MANGA.lastId !== id) { MANGA.lastId = id; MANGA.startT = t; }
  var el = (t - MANGA.startT) / 1000;
  var looks = mangaLooks(a, cfg);
  var painted = mangaPaint(src, looks.a, looks.b);
  if (!painted) return false;

  ctx.fillStyle = 'rgba(4,6,14,0.92)';
  ctx.fillRect(0, 0, W, H);

  var shake = el < 0.22 ? (cfg.shake || 0) : 0;
  ctx.save();
  ctx.translate(shake ? (Math.random() - 0.5) * shake : 0, shake ? (Math.random() - 0.5) * shake : 0);

  var cx = W / 2, pw = Math.min(680, W - 40), ph = pw * 0.75;
  // 顶上留给技能名底板，画面从牌子下面开始，字不再压到脸上。
  var py = Math.max(84, (H - ph) / 2 - 20);
  var pop = Math.min(1, el / 0.25);
  var sc = 0.7 + 0.3 * easeOutBack(pop);

  ctx.save();
  ctx.translate(cx, py + ph / 2);
  ctx.scale(sc, sc);
  ctx.translate(-cx, -(py + ph / 2));
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 6;
  ctx.strokeRect(cx - pw / 2 + 3, py + 3, pw - 6, ph - 6);
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - pw / 2 + 10, py + 10, pw - 20, ph - 20);
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - pw / 2 + 12, py + 12, pw - 24, ph - 24);
  ctx.clip();
  var innerW = pw - 24, innerH = ph - 24;
  var iw = innerW, ih = iw * src.naturalHeight / src.naturalWidth;
  if (ih > innerH) { ih = innerH; iw = ih * src.naturalWidth / src.naturalHeight; }
  var ix = cx - iw / 2, iy = py + 12 + (innerH - ih) / 2;
  // 抠掉的天空透出同一块渐变，腿间的白不再像破洞。
  var sky = ctx.createLinearGradient(0, iy, 0, iy + ih);
  sky.addColorStop(0, '#7eb7e6');
  sky.addColorStop(0.72, '#d7ecf8');
  sky.addColorStop(1, '#e7f3e0');
  ctx.fillStyle = sky;
  ctx.fillRect(ix, iy, iw, ih);
  if (painted && (painted.naturalWidth || painted.width)) ctx.drawImage(painted, ix, iy, iw, ih);
  else ctx.drawImage(src, ix, iy, iw, ih);
  // 风线大约 0.42 秒画完，然后画面停住。原路线细，变向后的路线粗。
  mangaDrawTrails(cfg.trail, { x: ix, y: iy, w: iw, h: ih }, Math.min(1, el / 0.42), el);
  ctx.restore();
  ctx.restore();

  mangaFlash(Math.max(0, 0.55 - el * 2));
  ctx.restore();
  if (el > 0.2 && cfg.sfx) {
    var plateY = 14;
    ctx.save();
    ctx.font = '900 40px "Noto Sans SC", sans-serif';
    var tw = ctx.measureText(cfg.sfx).width;
    var plateW = Math.max(220, tw + 56);
    var plateX = cx - plateW / 2;
    ctx.fillStyle = 'rgba(8,12,22,0.94)';
    ctx.fillRect(plateX, plateY, plateW, 54);
    ctx.strokeStyle = '#ffd94a';
    ctx.lineWidth = 3;
    ctx.strokeRect(plateX + 1.5, plateY + 1.5, plateW - 3, 51);
    ctx.restore();
    mangaSFX(cfg.sfx, cx, plateY + 27, 36, 0, (el - 0.2) / 0.25);
  }
  drawMangaBar(a, py, ph);
  return true;
}
