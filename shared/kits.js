// shared/kits.js
// 球队球衣颜色配置 + 结算图调色板规范（2026-10-10）。
//
// 设计目标：新增球队时不用为每种颜色组合重画图。
// 跑动图只有一套占位符，运行时换成球队或单个球员的颜色和球衣图案。
//
// 占位符规范（新图生成时必须遵守）：
//   #FF00FF (品红) = A 方球衣 | #00FFFF (青) = A 方短裤+球袜
//   #FF8800 (橙) = B 方球衣 | #8800FF (紫) = B 方短裤+球袜
//   #FF0088 (玫红) = 双方球鞋 | #0000FF (纯蓝) = 双方头发（只在漫画分镜里用，不进跑动图）
//   皮肤平涂 #F0C8A0。#FFFF00 / #00FF88 是旧跑动图的球袜，仍能换色。
//   球袜颜色跟着短裤。草地、白线、球、手套、门框不参与换色。
//
// 怎么配一套球衣（改 TEAM_COLORS，或给球员对象加 kit）：
//   pattern: 'solid' | 'stripes' | 'hoops' | 'sash' | 'halves'
//     solid 纯色，stripes 竖条，hoops 横条，sash 斜带，halves 左右分色
//   primary    球衣主色
//   secondary  条纹/斜带/另一半的颜色。纯色时可以不写。
//   shorts / socks / shoes  短裤、球袜、球鞋
//   jersey  旧字段，等同 primary。结算图只认纯色，不铺图案。
// 球员 kit 里没写的字段，用所在队的 TEAM_COLORS。
// 图案按每一帧球衣的重心铺，八个方向、每一帧用同一套规则，不用为组合另画图。
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SharedKits = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PATTERNS = ['solid', 'stripes', 'hoops', 'sash', 'halves'];

  // 球队默认球衣。球员 kit 覆盖其中任意字段。
  var TEAM_COLORS = {
    home: {
      name: '青鹰高校',
      pattern: 'solid',
      primary: '#2a5db0',
      secondary: '#f4f4f4',
      jersey: '#2a5db0',
      shorts: '#1e3f7a',
      socks: '#1e3f7a',
      shoes: '#1a1a1a',
    },
    away: {
      name: '烈风学院',
      pattern: 'hoops',
      primary: '#d03030',
      secondary: '#f4f4f4',
      jersey: '#d03030',
      shorts: '#8f1f1f',
      socks: '#8f1f1f',
      shoes: '#f4f4f4',
    },
  };

  // 占位符 → 球队部位的映射（R,G,B 精确匹配）
  // 跑动图只画了主队占位符。客队是把同一张图的 home 映射换成客队颜色。
  var PLACEHOLDERS = {
    '255,0,255':   { team: 'home', part: 'jersey' }, // 品红
    '0,255,255':   { team: 'home', part: 'shorts' }, // 青
    '255,255,0':   { team: 'home', part: 'socks' },  // 黄
    '255,0,136':   { team: 'home', part: 'shoes' },  // 玫红，球鞋
    '255,136,0':   { team: 'away', part: 'jersey' }, // 橙
    '136,0,255':   { team: 'away', part: 'shorts' }, // 紫
    '0,255,136':   { team: 'away', part: 'socks' },  // 绿
  };

  function hexToHsl(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255,
        g = parseInt(hex.slice(3, 5), 16) / 255,
        b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      var hk = function (t) {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      r = hk(h + 1/3); g = hk(h); b = hk(h - 1/3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  function matchPlaceholder(r, g, b, a, tolerance) {
    if (a < 128) return null;
    var key = r + ',' + g + ',' + b;
    var ph = PLACEHOLDERS[key];
    if (!ph && tolerance > 0) {
      var best = null, bd = 1e9;
      for (var pk in PLACEHOLDERS) {
        var c = pk.split(',').map(Number);
        var dist = Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]);
        if (dist < bd) { bd = dist; best = pk; }
      }
      if (bd <= tolerance * 3) ph = PLACEHOLDERS[best];
    }
    return ph;
  }

  function isDarkNeutral(r, g, b, a) {
    if (a < 128) return false;
    var mx = r > g ? r : g; if (b > mx) mx = b;
    var mn = r < g ? r : g; if (b < mn) mn = b;
    return mx <= 90 && (mx - mn) <= 28;
  }

  function isYellowSock(r, g, b, a) {
    if (a < 128) return false;
    return Math.abs(r - 255) + Math.abs(g - 255) + Math.abs(b - 0) <= 96;
  }

  // 把每格最底下、贴着黄袜的深色像素标成球鞋占位符。头发和眼睛不贴黄袜，不会被标上。
  // 新图画好 #FF0088 的鞋时，这些像素本来就是占位符，这里不会改掉它们。
  function markShoePlaceholders(imgData, cellW, cellH) {
    cellW = cellW || imgData.width;
    cellH = cellH || imgData.height;
    var d = imgData.data, w = imgData.width, h = imgData.height;
    var cols = Math.floor(w / cellW), rows = Math.floor(h / cellH);
    function at(x, y) { return (y * w + x) * 4; }
    function sockAt(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      var i = at(x, y);
      return isYellowSock(d[i], d[i + 1], d[i + 2], d[i + 3]);
    }
    for (var row = 0; row < rows; row++) {
      for (var col = 0; col < cols; col++) {
        var ox = col * cellW, oy = row * cellH;
        for (var lx = 0; lx < cellW; lx++) {
          var x = ox + lx;
          var y = oy + cellH - 1;
          while (y >= oy && d[at(x, y) + 3] < 40) y--;
          if (y < oy) continue;
          var run = [];
          while (y >= oy && isDarkNeutral(d[at(x, y)], d[at(x, y) + 1], d[at(x, y) + 2], d[at(x, y) + 3])) {
            run.push(y);
            y--;
          }
          if (!run.length) continue;
          var touch = false;
          for (var ri = 0; ri < run.length && !touch; ri++) {
            var yy = run[ri];
            for (var dy = -1; dy <= 1 && !touch; dy++) {
              for (var dx = -1; dx <= 1; dx++) {
                if (sockAt(x + dx, yy + dy)) { touch = true; break; }
              }
            }
          }
          if (!touch) continue;
          for (var k = 0; k < run.length; k++) {
            var i = at(x, run[k]);
            d[i] = 255; d[i + 1] = 0; d[i + 2] = 136; d[i + 3] = 255;
          }
        }
      }
    }
    return imgData;
  }

  function kitHex(teamColors, team, part, secondary) {
    var kit = (teamColors && teamColors[team]) || {};
    if (part === 'jersey') {
      if (secondary) return kit.secondary || kit.primary || kit.jersey || '#f4f4f4';
      return kit.primary || kit.jersey || '#2a5db0';
    }
    if (part === 'shoes') return kit.shoes || '#222222';
    // 球袜占位符跟着短裤，漫画里短裤和球袜是同一个色键。
    if (part === 'socks') return kit.shorts || kit.socks;
    return kit[part];
  }

  // 图案相位跟这一帧球衣的重心走，人在格子里挪动时条纹还长在衣服上。
  function useSecondary(pattern, x, y, cx, cy) {
    if (pattern === 'stripes') return (Math.floor((x - cx) / 2) & 1) === 0;
    if (pattern === 'hoops') return (Math.floor((y - cy) / 2) & 1) === 0;
    if (pattern === 'sash') return Math.abs((x - cx) - (y - cy)) <= 3;
    if (pattern === 'halves') return x >= cx;
    return false;
  }

  // 运行时换色。opts.cellW / cellH 和 opts.pattern 只在跑动图上铺图案。
  // 结算图不传 opts，球衣仍是纯色，明度算法和以前一样。
  function recolorImageData(imgData, teamColors, tolerance, opts) {
    teamColors = teamColors || TEAM_COLORS;
    tolerance = tolerance == null ? 32 : tolerance;
    opts = opts || {};
    var d = imgData.data, w = imgData.width, h = imgData.height;
    var pattern = opts.pattern || 'solid';
    if (PATTERNS.indexOf(pattern) < 0) pattern = 'solid';
    var cellW = opts.cellW || 0, cellH = opts.cellH || 0;
    var centers = null;
    if (cellW > 0 && cellH > 0 && pattern !== 'solid') {
      var cols = Math.floor(w / cellW), rows = Math.floor(h / cellH);
      centers = new Array(rows * cols);
      for (var ci = 0; ci < centers.length; ci++) centers[ci] = { sx: 0, sy: 0, n: 0 };
      for (var y0 = 0; y0 < h; y0++) {
        for (var x0 = 0; x0 < w; x0++) {
          var i0 = (y0 * w + x0) * 4;
          var ph0 = matchPlaceholder(d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3], tolerance);
          if (!ph0 || ph0.part !== 'jersey') continue;
          var cidx = Math.floor(y0 / cellH) * cols + Math.floor(x0 / cellW);
          if (!centers[cidx]) continue;
          centers[cidx].sx += x0;
          centers[cidx].sy += y0;
          centers[cidx].n++;
        }
      }
    }
    var hslCache = {};
    function targetHsl(hex) {
      if (!hslCache[hex]) hslCache[hex] = hexToHsl(hex);
      return hslCache[hex];
    }
    var vivid = !!(opts && opts.cellW);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var ph = matchPlaceholder(d[i], d[i + 1], d[i + 2], d[i + 3], tolerance);
        if (!ph) continue;
        var secondary = false;
        if (ph.part === 'jersey' && centers) {
          var cols2 = Math.floor(w / cellW);
          var box = centers[Math.floor(y / cellH) * cols2 + Math.floor(x / cellW)];
          if (box && box.n) secondary = useSecondary(pattern, x, y, box.sx / box.n, box.sy / box.n);
        }
        var hex = kitHex(teamColors, ph.team, ph.part, secondary);
        if (!hex) continue;
        var th = targetHsl(hex);
        var origL = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
        var outL = vivid ? (origL * 0.2 + th.l * 0.8) : (origL * 0.9 + th.l * 0.1);
        if (outL < 0.04) outL = 0.04;
        if (outL > 0.97) outL = 0.97;
        var rgb = hslToRgb(th.h, th.s, outL);
        d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
      }
    }
    return imgData;
  }

  function normalizeKit(partial, fallback) {
    var src = partial || {};
    var base = fallback || {};
    var primary = src.primary || src.jersey || base.primary || base.jersey || '#2a5db0';
    var pattern = src.pattern || base.pattern || 'solid';
    if (PATTERNS.indexOf(pattern) < 0) pattern = 'solid';
    var shorts = src.shorts || base.shorts || '#ffffff';
    var socks = (src.socks != null && src.socks !== '') ? src.socks
      : (src.shorts ? shorts : (base.socks || shorts));
    return {
      name: src.name || base.name || '',
      pattern: pattern,
      primary: primary,
      secondary: src.secondary || base.secondary || '#f4f4f4',
      jersey: primary,
      shorts: shorts,
      socks: socks,
      shoes: src.shoes || base.shoes || '#222222',
    };
  }

  // team 是 'home' / 'away'。override 是球员自己的 kit，缺的字段用球队默认。
  function resolveKit(team, override) {
    var base = TEAM_COLORS[team] || TEAM_COLORS.home;
    return normalizeKit(override, base);
  }

  // 肤色预设。原画像的皮肤是平涂的暖色，不是占位符。
  // 球衣换色只动占位符；肤色另走一条，只改判定为皮肤的像素。
  var SKIN_SOURCE = '#f0c8a0';
  var SKIN_PRESETS = {
    fair: { name: '浅肤', color: '#f0c8a6' },
    east: { name: '暖黄', color: '#e0a878' },
    tan:  { name: '小麦', color: '#c47a45' },
    deep: { name: '深肤', color: '#6a3a28' },
  };

  function isSkinPixel(r, g, b, a) {
    if (a < 128) return false;
    if (r < 150 || g < 100 || b < 60) return false;
    if (g < b - 5 || r < g - 5) return false;
    if (r - b < 28) return false;
    // 黄袜是高 R 高 G 低 B，不能算皮肤
    if (b < 90 && g > 180 && r > 180) return false;
    return true;
  }

  // 头发预设。漫画分镜的头发是纯蓝 #0000FF，按球员换成这里的颜色。
  // 不放进 PLACEHOLDERS：跑动图的容差会把别的蓝色吃掉，而且双方头发不是同一个队。
  var HAIR_PRESETS = {
    black:  { name: '黑发', color: '#1a1a1a' },
    brown:  { name: '棕发', color: '#5a3a1a' },
    blonde: { name: '金发', color: '#d8c07a' },
    auburn: { name: '赤褐', color: '#8a3a22' },
    gray:   { name: '灰发', color: '#8a8a92' },
  };
  var HAIR_KEY = [0, 0, 255];

  function hexRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  function pixelHsv(r, g, b) {
    var max = r > g ? r : g; if (b > max) max = b;
    var min = r < g ? r : g; if (b < min) min = b;
    var d = max - min;
    var s = max === 0 ? 0 : d / max;
    var h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: h, s: s, v: max };
  }

  // 漫画色键分类。JPG 会把品红 #FF00FF 压成低 G 的粉，和球鞋 #FF0088 叠在一起，
  // 那种像素先标成 ambiguous，再按连通块大小分开（大块是球衣，孤立小块是鞋）。
  // 返回 null 表示草地、白线、球、手套、门框、墨线，不换色。
  // JPG 在色键和墨线交界留下的窄光晕分类不到，换色时由 snapOutlineHalos 补上。
  function mangaPixelClass(r, g, b, a) {
    if (a != null && a < 128) return null;
    // 已经吸附过的精确色键直接认，避免大块球鞋在「有品红」的图里被并回球衣。
    var bootD = Math.abs(r - 255) + Math.abs(g) + Math.abs(b - 136);
    if (bootD <= 18 && g < 30 && b > r * 0.4 && b < r * 0.7) return 'boot';
    var c = pixelHsv(r, g, b);
    var h = c.h, s = c.s, v = c.v;
    if (v < 34 && s < 0.55) return null;
    if (s < 0.12 && v > 200) return null;
    if (h >= 70 && h <= 160 && g > r + 8 && g + 8 >= b && b < g * 0.48 && s > 0.22 && g > 55) return null;
    if ((h < 16 || h > 350) && s > 0.5 && b < 75 && g < 110 && v > 90) return null;
    if (s >= 0.14 && s <= 0.58 && r > 165 && g > 120 && b > 75 && r > g && g + 8 > b && (r - b) > 22 && h < 55) return 'skin';
    if (h >= 12 && h <= 44 && s > 0.62 && v > 85 && g > 40 && b < g * 0.55 && r > g) return 'defJersey';
    if (h >= 282 && h <= 318 && s > 0.4 && v >= 40 && g < v * 0.4 && Math.abs(r - b) <= Math.max(28, v * 0.32) && b > r * 0.72) return 'atkJersey';
    // 品红被 JPG 压成低到中等 G 的粉，和球鞋 #FF0088 叠在同一色相。先标成待定，再按块拆开。
    if ((h >= 305 || h <= 12) && s > 0.45 && v > 70 && r > 120 && b > 40 && g < 110 && (b / (r || 1)) > 0.32 && (b / (r || 1)) < 0.85) return 'ambiguous';
    if (h >= 250 && h <= 292 && s > 0.35 && v > 48 && b > r && r > 32 && g < b * 0.72) return 'defShorts';
    if (h >= 48 && h <= 72 && s > 0.7 && v > 140 && b < 80 && r > 160 && g > 160) return 'atkShorts';
    if (h >= 140 && h <= 162 && s > 0.55 && v > 120 && r < 40 && g > 180 && b > 90 && b < g * 0.8) return 'defShorts';
    if (h >= 195 && h <= 255 && b > 70 && r < 95 && b > g + 32 && g < b * 0.7 && r < b * 0.6) return 'hair';
    if (h >= 165 && h <= 220 && r < 100 && g > 70 && b > 90 && g > b * 0.62) return 'atkShorts';
    return null;
  }

  // 贴着球衣/短裤/鞋、又没落进色键窗口的像素：包在色块里的涂成该部位，
  // 贴着墨线的暗色溢色涂成墨线。草地、白线、皮球和皮肤不进来。
  function haloMatches(kind, r, g, b, c, loose) {
    if (kind === 'atkJersey' || kind === 'boot') {
      // 品红/玫红光晕：蓝不低于绿。纯红皮球蓝更低，进不来。
      if (!(b + 6 >= g && g <= 70 && r > g + 10 && r >= 22)) return false;
      if (loose) return b > 4 || r > g + 16;
      return r >= 40 && g <= 58 && (b > 12 || (g <= 16 && r >= 48));
    }
    if (kind === 'atkShorts') {
      if (!(r < 80 && b > 24 && b + 8 >= g && r < b && (g + b) > r * 2)) return false;
      return loose ? (g < 150 || b > g) : (g < 130 && b > 28);
    }
    if (kind === 'defJersey') {
      if (!(r > 48 && r > g + 12 && b < 80 && g < r * 0.72 && c.h < 50)) return false;
      return loose ? r >= 28 : (g <= 22 || r > 70);
    }
    if (kind === 'defShorts') {
      if (!(b > 28 && b > r && b > g + 8 && g < 55 && r < 100)) return false;
      return true;
    }
    return false;
  }

  function snapOutlineHalos(cls, d, w, h) {
    var keys = ['atkJersey', 'atkShorts', 'defJersey', 'defShorts', 'boot'];
    var canon = {
      atkJersey: [255, 0, 255],
      atkShorts: [0, 255, 255],
      defJersey: [255, 136, 0],
      defShorts: [136, 0, 255],
      boot: [255, 0, 136],
    };
    var n = w * h;
    var extra = new Array(n);
    var p, i, r, g, b, a, c, max, min, x, y, dx, dy, nx, ny, nk, ni, nr, ng, nb, nv, nmin;
    for (p = 0; p < n; p++) {
      if (cls[p]) continue;
      i = p * 4;
      r = d[i]; g = d[i + 1]; b = d[i + 2]; a = d[i + 3];
      if (a < 128) continue;
      c = pixelHsv(r, g, b);
      max = c.v;
      min = r < g ? r : g; if (b < min) min = b;
      if (max - min < 12) continue;
      if (c.s < 0.16 && max > 185) continue;
      if (c.h >= 70 && c.h <= 160 && g > r + 8 && g + 8 >= b && b < g * 0.55 && c.s > 0.22 && g > 55) continue;
      x = p % w; y = (p / w) | 0;
      var votes = { atkJersey: 0, atkShorts: 0, defJersey: 0, defShorts: 0, boot: 0 };
      var darkInk = 0;
      for (dy = -1; dy <= 1; dy++) {
        for (dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          nx = x + dx; ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          nk = cls[ny * w + nx];
          if (votes[nk] != null) votes[nk]++;
          else if (!nk) {
            ni = (ny * w + nx) * 4;
            nr = d[ni]; ng = d[ni + 1]; nb = d[ni + 2];
            nv = nr > ng ? nr : ng; if (nb > nv) nv = nb;
            nmin = nr < ng ? nr : ng; if (nb < nmin) nmin = nb;
            if (nv < 36 && nv - nmin < 28) darkInk++;
          }
        }
      }
      var loose = max < 48;
      var skinish = c.s >= 0.14 && c.s <= 0.7 && r > 150 && g > 100 && b > 70 && r > g && g + 12 > b && (r - b) > 22 && c.h < 50;
      var best = null, bestN = 0, bestD = 1e9;
      for (var ki = 0; ki < keys.length; ki++) {
        var kind = keys[ki];
        var cnt = votes[kind];
        if (cnt < 1 || !haloMatches(kind, r, g, b, c, loose)) continue;
        var canonRgb = canon[kind];
        var dist = Math.abs(r - canonRgb[0]) + Math.abs(g - canonRgb[1]) + Math.abs(b - canonRgb[2]);
        if (cnt > bestN || (cnt === bestN && dist < bestD)) {
          best = kind; bestN = cnt; bestD = dist;
        }
      }
      if (!best) continue;
      if (skinish && bestN < 3) continue;
      if (bestN < 3 && max < 96 && (darkInk > 0 || max < 48)) extra[p] = 'ink';
      else extra[p] = best;
    }
    for (var e = 0; e < n; e++) if (extra[e]) cls[e] = extra[e];
  }

  function jerseyHexOf(look, kit) {
    if (look && look.pos === 'GK') return look.team === 'home' ? '#e8b923' : '#7a7f8a';
    return kit.primary;
  }

  // 漫画复合图换色。atkLook / defLook: { team, skin, hair, kit, pos }
  // A 色键（品红/青）给 atkLook，B 色键（橙/紫）给 defLook。
  // 鞋、头发、皮肤两边共用色键，按离哪一件球衣更近归到那个人。
  function recolorManga(imgData, atkLook, defLook) {
    atkLook = atkLook || {};
    defLook = defLook || {};
    var atkKit = resolveKit(atkLook.team || 'home', atkLook.kit);
    var defKit = resolveKit(defLook.team || 'away', defLook.kit);
    var atkSkin = hexRgb((SKIN_PRESETS[atkLook.skin] || SKIN_PRESETS.fair).color);
    var defSkin = hexRgb((SKIN_PRESETS[defLook.skin] || SKIN_PRESETS.fair).color);
    var atkHair = hexRgb((HAIR_PRESETS[atkLook.hair] || HAIR_PRESETS.black).color);
    var defHair = hexRgb((HAIR_PRESETS[defLook.hair] || HAIR_PRESETS.black).color);
    var paintOf = {
      atk: {
        atkJersey: hexRgb(jerseyHexOf(atkLook, atkKit)),
        atkShorts: hexRgb(atkKit.shorts),
        boot: hexRgb(atkKit.shoes || '#222222'),
        hair: atkHair,
        skin: atkSkin,
      },
      def: {
        defJersey: hexRgb(jerseyHexOf(defLook, defKit)),
        defShorts: hexRgb(defKit.shorts),
        boot: hexRgb(defKit.shoes || '#222222'),
        hair: defHair,
        skin: defSkin,
      },
    };
    var d = imgData.data, w = imgData.width, h = imgData.height, n = w * h;
    var cls = new Array(n);
    for (var p = 0; p < n; p++) {
      var i = p * 4;
      cls[p] = mangaPixelClass(d[i], d[i + 1], d[i + 2], d[i + 3]);
    }
    // 待定的粉：有成片真品红时，小块孤立的是鞋；否则最大块是球衣，
    // G 通道接近它的也是球衣（第二名进攻球员），其余是鞋。
    var trueMag = 0;
    for (var ti = 0; ti < n; ti++) if (cls[ti] === 'atkJersey') trueMag++;
    var seen = new Uint8Array(n);
    var q = [];
    var comps = [];
    for (var s = 0; s < n; s++) {
      if (cls[s] !== 'ambiguous' || seen[s]) continue;
      q.length = 0;
      q.push(s);
      seen[s] = 1;
      var comp = [s];
      var sumG = d[s * 4 + 1];
      for (var qi = 0; qi < q.length; qi++) {
        var id = q[qi];
        var x = id % w, y = (id / w) | 0;
        for (var dy = -4; dy <= 4; dy++) {
          for (var dx = -4; dx <= 4; dx++) {
            if (!dx && !dy) continue;
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            var nid = ny * w + nx;
            if (cls[nid] !== 'ambiguous' || seen[nid]) continue;
            seen[nid] = 1;
            q.push(nid);
            comp.push(nid);
            sumG += d[nid * 4 + 1];
          }
        }
      }
      var minY = h, maxY = 0;
      for (var yi = 0; yi < comp.length; yi++) {
        var yy = (comp[yi] / w) | 0;
        if (yy < minY) minY = yy;
        if (yy > maxY) maxY = yy;
      }
      comps.push({ ids: comp, g: sumG / comp.length, minY: minY, maxY: maxY });
    }
    if (trueMag > 200) {
      for (var ci = 0; ci < comps.length; ci++) {
        var asJersey = comps[ci].ids.length >= 400;
        var label = asJersey ? 'atkJersey' : 'boot';
        for (var cj = 0; cj < comps[ci].ids.length; cj++) cls[comps[ci].ids[cj]] = label;
      }
    } else if (comps.length) {
      comps.sort(function (a, b) { return b.ids.length - a.ids.length; });
      var refG = comps[0].g;
      var refMaxY = comps[0].maxY;
      for (var ck = 0; ck < comps.length; ck++) {
        var below = comps[ck].minY > refMaxY + 8;
        var jersey = ck === 0 || (!below && Math.abs(comps[ck].g - refG) <= 12);
        var lab = jersey ? 'atkJersey' : 'boot';
        for (var cz = 0; cz < comps[ck].ids.length; cz++) cls[comps[ck].ids[cz]] = lab;
      }
    }
    snapOutlineHalos(cls, d, w, h);
    var INF = 1e9;
    var da = new Float64Array(n);
    var dd = new Float64Array(n);
    for (var pi = 0; pi < n; pi++) {
      da[pi] = cls[pi] === 'atkJersey' ? 0 : INF;
      dd[pi] = cls[pi] === 'defJersey' ? 0 : INF;
    }
    function chamfer(dist) {
      var y, x, i, best;
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x; best = dist[i];
          if (x > 0 && dist[i - 1] + 3 < best) best = dist[i - 1] + 3;
          if (y > 0) {
            if (dist[i - w] + 3 < best) best = dist[i - w] + 3;
            if (x > 0 && dist[i - w - 1] + 4 < best) best = dist[i - w - 1] + 4;
            if (x + 1 < w && dist[i - w + 1] + 4 < best) best = dist[i - w + 1] + 4;
          }
          dist[i] = best;
        }
      }
      for (y = h - 1; y >= 0; y--) {
        for (x = w - 1; x >= 0; x--) {
          i = y * w + x; best = dist[i];
          if (x + 1 < w && dist[i + 1] + 3 < best) best = dist[i + 1] + 3;
          if (y + 1 < h) {
            if (dist[i + w] + 3 < best) best = dist[i + w] + 3;
            if (x > 0 && dist[i + w - 1] + 4 < best) best = dist[i + w - 1] + 4;
            if (x + 1 < w && dist[i + w + 1] + 4 < best) best = dist[i + w + 1] + 4;
          }
          dist[i] = best;
        }
      }
    }
    chamfer(da); chamfer(dd);
    function fill(i, rgb) {
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
    }
    for (var k = 0; k < n; k++) {
      var kind = cls[k];
      if (!kind) continue;
      if (kind === 'ink') { fill(k * 4, [0, 0, 0]); continue; }
      var side = da[k] <= dd[k] ? 'atk' : 'def';
      var rgb = null;
      if (kind === 'atkJersey' || kind === 'atkShorts') rgb = paintOf.atk[kind];
      else if (kind === 'defJersey' || kind === 'defShorts') rgb = paintOf.def[kind];
      else rgb = paintOf[side][kind];
      if (rgb) fill(k * 4, rgb);
    }
    return imgData;
  }

  function recolorSkin(imgData, presetId) {
    var preset = SKIN_PRESETS[presetId] || SKIN_PRESETS.fair;
    var dst = hexToHsl(preset.color);
    var srcL = hexToHsl(SKIN_SOURCE).l || 0.75;
    var d = imgData.data;
    for (var i = 0; i < d.length; i += 4) {
      if (!isSkinPixel(d[i], d[i + 1], d[i + 2], d[i + 3])) continue;
      var lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      var outL = dst.l * (lum / srcL);
      if (outL < 0.05) outL = 0.05;
      if (outL > 0.96) outL = 0.96;
      var rgb = hslToRgb(dst.h, dst.s, outL);
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
    }
    return imgData;
  }

  return {
    PATTERNS: PATTERNS,
    TEAM_COLORS: TEAM_COLORS,
    PLACEHOLDERS: PLACEHOLDERS,
    SKIN_PRESETS: SKIN_PRESETS,
    HAIR_PRESETS: HAIR_PRESETS,
    HAIR_KEY: HAIR_KEY,
    hexToHsl: hexToHsl,
    hslToRgb: hslToRgb,
    markShoePlaceholders: markShoePlaceholders,
    recolorImageData: recolorImageData,
    resolveKit: resolveKit,
    isSkinPixel: isSkinPixel,
    recolorSkin: recolorSkin,
    mangaPixelClass: mangaPixelClass,
    recolorManga: recolorManga,
  };
});
