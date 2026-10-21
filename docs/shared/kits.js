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
//   jersey  旧字段，等同 primary。
// 球员 kit 里没写的字段，用所在队的 TEAM_COLORS。
// 跑动图和漫画分镜都按球衣重心铺同一套图案。漫画按人物连通域上色，
// 袜子跟短裤，草地上的白月牙、皮球、手套不进人物。
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

  // 占位色都是高饱和的纯色。先拆成数字，换色时不用每个像素再 split 字符串。
  var PH_LIST = [];
  var PH_PEAK = 255;
  (function () {
    var peak = 1e9;
    Object.keys(PLACEHOLDERS).forEach(function (pk) {
      var c = pk.split(',').map(Number);
      PH_LIST.push({ r: c[0], g: c[1], b: c[2], ph: PLACEHOLDERS[pk] });
      var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
      if (mx - mn < peak) peak = mx - mn;
    });
    PH_PEAK = peak;
  })();

  function matchPlaceholder(r, g, b, a, tolerance) {
    if (a < 128) return null;
    var ph = PLACEHOLDERS[r + ',' + g + ',' + b];
    if (ph || !(tolerance > 0)) return ph || null;
    var tol = tolerance * 3;
    var mx = r > g ? r : g; if (b > mx) mx = b;
    var mn = r < g ? r : g; if (b < mn) mn = b;
    // 和任一占位色的曼哈顿距离至少是「饱和度差」。灰皮肤、墨线直接跳过。
    if (mx - mn < PH_PEAK - tol) return null;
    var best = null, bd = 1e9;
    for (var i = 0; i < PH_LIST.length; i++) {
      var c = PH_LIST[i];
      var dist = (r > c.r ? r - c.r : c.r - r) + (g > c.g ? g - c.g : c.g - g) + (b > c.b ? b - c.b : c.b - b);
      if (dist < bd) { bd = dist; best = c.ph; }
    }
    return bd <= tol ? best : null;
  }

  // 跑动图的占位色和球衣图案重心只跟原图像素有关。开赛时按每套球衣重扫整张图会卡一秒以上。
  // 1=球衣 2=短裤 3=球袜 4=球鞋，客队加 8。
  function classifyPlaceholders(imgData, tolerance) {
    var d = imgData.data, n = (d.length / 4) | 0;
    var mask = new Uint8Array(n);
    for (var p = 0; p < n; p++) {
      var i = p * 4;
      var ph = matchPlaceholder(d[i], d[i + 1], d[i + 2], d[i + 3], tolerance);
      if (!ph) continue;
      var part = ph.part === 'jersey' ? 1 : ph.part === 'shorts' ? 2 : ph.part === 'socks' ? 3 : ph.part === 'shoes' ? 4 : 0;
      if (!part) continue;
      mask[p] = part + (ph.team === 'away' ? 8 : 0);
    }
    return mask;
  }

  function sheetCenters(mask, w, h, cellW, cellH) {
    var cols = Math.floor(w / cellW), rows = Math.floor(h / cellH);
    var centers = new Array(rows * cols);
    var ci;
    for (ci = 0; ci < centers.length; ci++) centers[ci] = { sx: 0, sy: 0, n: 0 };
    for (var y = 0; y < h; y++) {
      var row = Math.floor(y / cellH) * cols;
      var base = y * w;
      for (var x = 0; x < w; x++) {
        var code = mask[base + x];
        var part = code >= 8 ? code - 8 : code;
        if (part !== 1) continue;
        var box = centers[row + Math.floor(x / cellW)];
        if (!box) continue;
        box.sx += x; box.sy += y; box.n++;
      }
    }
    return centers;
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
    var mask = opts.mask || null;
    var centers = opts.centers || null;
    if (!centers && cellW > 0 && cellH > 0 && pattern !== 'solid') {
      if (mask) centers = sheetCenters(mask, w, h, cellW, cellH);
      else {
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
        var team, part;
        if (mask) {
          var code = mask[y * w + x];
          if (!code) continue;
          team = code >= 8 ? 'away' : 'home';
          var partN = code >= 8 ? code - 8 : code;
          part = partN === 1 ? 'jersey' : partN === 2 ? 'shorts' : partN === 3 ? 'socks' : 'shoes';
        } else {
          var ph = matchPlaceholder(d[i], d[i + 1], d[i + 2], d[i + 3], tolerance);
          if (!ph) continue;
          team = ph.team; part = ph.part;
        }
        var secondary = false;
        if (part === 'jersey' && centers) {
          var cols2 = Math.floor(w / cellW);
          var box = centers[Math.floor(y / cellH) * cols2 + Math.floor(x / cellW)];
          if (box && box.n) secondary = useSecondary(pattern, x, y, box.sx / box.n, box.sy / box.n);
        }
        var hex = kitHex(teamColors, team, part, secondary);
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
    // 皮肤的暗部饱和度更高、更偏橙。仍要求有蓝色分量，免得把橙球衣收成皮肤。
    if (h < 50 && s >= 0.12 && s <= 0.78 && r > 140 && g > 80 && b > 40 && r > g && g + 4 > b && (r - b) > 18) return 'skin';
    if (h >= 12 && h <= 44 && s > 0.62 && v > 85 && g > 40 && b < g * 0.55 && r > g) return 'defJersey';
    if (h >= 282 && h <= 318 && s > 0.4 && v >= 40 && g < v * 0.4 && Math.abs(r - b) <= Math.max(28, v * 0.32) && b > r * 0.72) return 'atkJersey';
    // 品红被 JPG 压成低到中等 G 的粉，和球鞋 #FF0088 叠在同一色相。先标成待定，再按块拆开。
    if ((h >= 305 || h <= 12) && s > 0.45 && v > 70 && r > 120 && b > 40 && g < 110 && (b / (r || 1)) > 0.32 && (b / (r || 1)) < 0.85) return 'ambiguous';
    if (h >= 250 && h <= 292 && s > 0.35 && v > 48 && b > r && r > 32 && g < b * 0.72) return 'defShorts';
    if (h >= 48 && h <= 72 && s > 0.7 && v > 140 && b < 80 && r > 160 && g > 160) return 'atkShorts';
    if (h >= 140 && h <= 162 && s > 0.55 && v > 120 && r < 40 && g > 180 && b > 90 && b < g * 0.8) return 'defShorts';
    // 头发色键是纯蓝，暗部蓝会掉到 70 以下。青色短裤 G 接近 B，进不来。
    if (h >= 190 && h <= 265 && b >= 18 && r < 110 && b > r + 10 && b > g + 8 && g < b * 0.7 && r < b * 0.6 && s > 0.35) return 'hair';
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

  function resolveAmbiguous(cls, d, w, h) {
    var n = w * h;
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
        var label = comps[ci].ids.length >= 400 ? 'atkJersey' : 'boot';
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
  }

  function clothSide(kind) {
    if (kind === 'atkJersey' || kind === 'atkShorts') return 1;
    if (kind === 'defJersey' || kind === 'defShorts') return 2;
    return 0;
  }

  function partCode(kind) {
    if (kind === 'atkJersey' || kind === 'defJersey') return 1;
    if (kind === 'atkShorts' || kind === 'defShorts') return 2;
    if (kind === 'boot') return 3;
    if (kind === 'hair') return 4;
    if (kind === 'skin') return 5;
    if (kind === 'ink') return 6;
    return 0;
  }

  function isGrassPixel(r, g, b) {
    return g > r + 8 && g + 8 >= b && b < g * 0.55 && g > 55;
  }

  function isNearWhitePixel(r, g, b) {
    var max = r > g ? r : g; if (b > max) max = b;
    var min = r < g ? r : g; if (b < min) min = b;
    return max > 210 && (max - min) < 28 && min > 185;
  }

  function isRedBallPixel(r, g, b) {
    var c = pixelHsv(r, g, b);
    return (c.h < 16 || c.h > 350) && c.s > 0.5 && b < 75 && g < 110 && c.v > 90;
  }

  function isNeutralDark(r, g, b) {
    var max = r > g ? r : g; if (b > max) max = b;
    var min = r < g ? r : g; if (b < min) min = b;
    return max < 70 && (max - min) < 28;
  }

  function relLum(r, g, b) {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  // 同一色相按原图明度变深，不把暗部收成另一种头发或肤色。
  function toneRgb(rgb, r, g, b, refLum) {
    var t = refLum > 0.04 ? relLum(r, g, b) / refLum : 1;
    if (t < 0.62) t = 0.62;
    if (t > 1.06) t = 1.06;
    return [
      Math.max(0, Math.min(255, Math.round(rgb[0] * t))),
      Math.max(0, Math.min(255, Math.round(rgb[1] * t))),
      Math.max(0, Math.min(255, Math.round(rgb[2] * t))),
    ];
  }

  function grassLineY(d, w, h) {
    var y, x, i, g, k, s;
    for (y = 0; y < h - 8; y++) {
      s = 0;
      for (k = 0; k < 8; k++) {
        g = 0;
        for (x = 0; x < w; x += 4) {
          i = ((y + k) * w + x) * 4;
          if (d[i + 3] >= 128 && isGrassPixel(d[i], d[i + 1], d[i + 2])) g++;
        }
        s += g / Math.max(1, (w / 4));
      }
      if (s / 8 > 0.18) return y;
    }
    return Math.round(h * 0.55);
  }

  // 皮球是一圈白块贴着黑缝。标出圆内的白、黑、灰，换色时整颗球不动。
  function detectBall(d, w, h) {
    var n = w * h;
    var ball = new Uint8Array(n);
    var seen = new Uint8Array(n);
    var panels = [];
    var p, i, r, g, b, a, x, y, q, qi, id, nx, ny, nid, area, peri, minX, maxX, minY, maxY, blackN;
    for (p = 0; p < n; p++) {
      if (seen[p]) continue;
      i = p * 4;
      r = d[i]; g = d[i + 1]; b = d[i + 2]; a = d[i + 3];
      if (a < 128 || !isNearWhitePixel(r, g, b)) { seen[p] = 1; continue; }
      q = [p]; seen[p] = 1; qi = 0;
      area = 0; peri = 0; blackN = 0;
      minX = w; maxX = 0; minY = h; maxY = 0;
      var sx = 0, sy = 0;
      while (qi < q.length) {
        id = q[qi++];
        area++;
        x = id % w; y = (id / w) | 0;
        sx += x; sy += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        var edge = false;
        var dy, dx;
        for (dy = -1; dy <= 1; dy++) {
          ny = y + dy; if (ny < 0 || ny >= h) { edge = true; continue; }
          for (dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            nx = x + dx; if (nx < 0 || nx >= w) { edge = true; continue; }
            nid = ny * w + nx;
            var ni = nid * 4;
            var nr = d[ni], ng = d[ni + 1], nb = d[ni + 2], na = d[ni + 3];
            if (na >= 128 && isNearWhitePixel(nr, ng, nb)) {
              if (!seen[nid]) { seen[nid] = 1; q.push(nid); }
            } else {
              edge = true;
              if (na >= 128 && isNeutralDark(nr, ng, nb)) blackN++;
            }
          }
        }
        if (edge) peri++;
      }
      var bw = maxX - minX + 1, bh = maxY - minY + 1;
      var aspect = bw / Math.max(1, bh);
      if (area < 120 || area > 3200) continue;
      if (aspect < 0.45 || aspect > 2.3) continue;
      if (Math.min(bw, bh) < 16) continue;
      if (blackN < area * 0.015) continue;
      panels.push({ cx: sx / area, cy: sy / area, minX: minX, maxX: maxX, minY: minY, maxY: maxY });
    }
    var used = new Uint8Array(panels.length);
    var c, j, k, dx, dy, dist, group, cx, cy, rad, yy, xx;
    for (c = 0; c < panels.length; c++) {
      if (used[c]) continue;
      group = [c]; used[c] = 1;
      for (j = 0; j < group.length; j++) {
        for (k = 0; k < panels.length; k++) {
          if (used[k]) continue;
          dx = panels[group[j]].cx - panels[k].cx;
          dy = panels[group[j]].cy - panels[k].cy;
          if (dx * dx + dy * dy < 110 * 110) { used[k] = 1; group.push(k); }
        }
      }
      if (group.length < 3) continue;
      var gMinX = w, gMaxX = 0, gMinY = h, gMaxY = 0;
      for (j = 0; j < group.length; j++) {
        var gp = panels[group[j]];
        if (gp.minX < gMinX) gMinX = gp.minX;
        if (gp.maxX > gMaxX) gMaxX = gp.maxX;
        if (gp.minY < gMinY) gMinY = gp.minY;
        if (gp.maxY > gMaxY) gMaxY = gp.maxY;
      }
      // 球网的白格会连成一大片，不是一颗球。
      if (gMaxX - gMinX > 220 || gMaxY - gMinY > 220) continue;
      cx = 0; cy = 0;
      for (j = 0; j < group.length; j++) { cx += panels[group[j]].cx; cy += panels[group[j]].cy; }
      cx /= group.length; cy /= group.length;
      rad = 0;
      for (j = 0; j < group.length; j++) {
        var pan = panels[group[j]];
        var corners = [[pan.minX, pan.minY], [pan.maxX, pan.minY], [pan.minX, pan.maxY], [pan.maxX, pan.maxY]];
        for (k = 0; k < 4; k++) {
          dist = Math.sqrt((corners[k][0] - cx) * (corners[k][0] - cx) + (corners[k][1] - cy) * (corners[k][1] - cy));
          if (dist > rad) rad = dist;
        }
      }
      rad += 10;
      var r2 = rad * rad;
      for (yy = Math.max(0, Math.floor(cy - rad)); yy <= Math.min(h - 1, Math.ceil(cy + rad)); yy++) {
        for (xx = Math.max(0, Math.floor(cx - rad)); xx <= Math.min(w - 1, Math.ceil(cx + rad)); xx++) {
          dx = xx - cx; dy = yy - cy;
          if (dx * dx + dy * dy > r2) continue;
          i = (yy * w + xx) * 4;
          if (d[i + 3] < 128) continue;
          r = d[i]; g = d[i + 1]; b = d[i + 2];
          if (isNearWhitePixel(r, g, b) || isNeutralDark(r, g, b)) ball[yy * w + xx] = 1;
        }
      }
    }
    return ball;
  }

  // 草皮线以上、不在人物轮廓里的成片白天空。网和细白线周长很大，留着。
  function detectSky(d, w, h, ball, grassY, cls) {
    var n = w * h;
    var sky = new Uint8Array(n);
    var seen = new Uint8Array(n);
    var p, i, r, g, b, a;
    for (p = 0; p < n; p++) {
      if (seen[p] || ball[p]) { seen[p] = 1; continue; }
      i = p * 4;
      r = d[i]; g = d[i + 1]; b = d[i + 2]; a = d[i + 3];
      if (a < 128 || !isNearWhitePixel(r, g, b)) { seen[p] = 1; continue; }
      var q = [p]; seen[p] = 1;
      var comp = [p];
      var qi = 0, peri = 0, above = 0;
      var minX = w, maxX = 0, minY = h, maxY = 0;
      while (qi < q.length) {
        var id = q[qi++];
        var x = id % w, y = (id / w) | 0;
        if (y < grassY) above++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        var edge = false;
        var dy, dx, nx, ny, nid;
        for (dy = -1; dy <= 1; dy++) {
          ny = y + dy; if (ny < 0 || ny >= h) { edge = true; continue; }
          for (dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            nx = x + dx; if (nx < 0 || nx >= w) { edge = true; continue; }
            nid = ny * w + nx;
            if (ball[nid]) { edge = true; continue; }
            var ni = nid * 4;
            if (d[ni + 3] >= 128 && isNearWhitePixel(d[ni], d[ni + 1], d[ni + 2])) {
              if (!seen[nid]) { seen[nid] = 1; q.push(nid); comp.push(nid); }
            } else edge = true;
          }
        }
        if (edge) peri++;
      }
      var area = comp.length;
      var bw = maxX - minX + 1, bh = maxY - minY + 1;
      if (above < area * 0.65) continue;
      if (Math.min(bw, bh) <= 18) continue;
      var solidity = area / (bw * bh);
      var pr = peri / area;
      var aspect = bw / Math.max(1, bh);
      if (aspect > 3.2 || bh / Math.max(1, bw) > 3.2) continue;
      // 腿和手臂之间的白洞两侧都是身体。球网的白格周长更大，草地上的月牙旁边不是身体。
      var midX = (minX + maxX) >> 1, midY = (minY + maxY) >> 1;
      function bodyAt(dir) {
        var t, nx, kind;
        for (t = 1; t <= 110; t++) {
          nx = midX + dir * t;
          if (nx < 0 || nx >= w) return false;
          kind = cls[midY * w + nx];
          if (kind === 'atkJersey' || kind === 'defJersey' || kind === 'atkShorts' || kind === 'defShorts' || kind === 'skin' || kind === 'boot' || kind === 'hair') return true;
        }
        return false;
      }
      var between = bodyAt(-1) && bodyAt(1);
      if (between && area > 800 && area < 12000 && pr < 0.2 && solidity > 0.4) {
        for (var ci = 0; ci < comp.length; ci++) sky[comp[ci]] = 1;
      }
    }
    return sky;
  }

  // 贴着鞋色键的小块白是鞋面高光，收到同一只鞋上。大片天空和皮球不收。
  function absorbBootWhites(cls, d, w, h, ball, sky) {
    var n = w * h;
    var seen = new Uint8Array(n);
    var p, i;
    function touchesBoot(x, y) {
      var dy, dx, nx, ny;
      for (dy = -2; dy <= 2; dy++) {
        ny = y + dy; if (ny < 0 || ny >= h) continue;
        for (dx = -2; dx <= 2; dx++) {
          nx = x + dx; if (nx < 0 || nx >= w) continue;
          if (cls[ny * w + nx] === 'boot') return true;
        }
      }
      return false;
    }
    for (p = 0; p < n; p++) {
      if (seen[p] || ball[p] || sky[p]) { seen[p] = 1; continue; }
      i = p * 4;
      if (d[i + 3] < 128 || !isNearWhitePixel(d[i], d[i + 1], d[i + 2])) { seen[p] = 1; continue; }
      var q = [p]; seen[p] = 1;
      var comp = [p];
      var qi = 0, touch = touchesBoot(p % w, (p / w) | 0);
      var minX = w, maxX = 0, minY = h, maxY = 0;
      while (qi < q.length) {
        var id = q[qi++];
        var x = id % w, y = (id / w) | 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (!touch && touchesBoot(x, y)) touch = true;
        var dy, dx, nx, ny;
        for (dy = -1; dy <= 1; dy++) {
          ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            nx = x + dx; if (nx < 0 || nx >= w) continue;
            var nid = ny * w + nx;
            if (seen[nid] || ball[nid] || sky[nid]) continue;
            var ni = nid * 4;
            if (d[ni + 3] < 128 || !isNearWhitePixel(d[ni], d[ni + 1], d[ni + 2])) continue;
            seen[nid] = 1; q.push(nid); comp.push(nid);
          }
        }
      }
      var area = comp.length;
      var bw = maxX - minX + 1, bh = maxY - minY + 1;
      if (!touch || area < 24 || area > 1600) continue;
      if (Math.min(bw, bh) < 8) continue;
      if (bw / Math.max(1, bh) > 3.5 || bh / Math.max(1, bw) > 3.5) continue;
      for (var ci = 0; ci < comp.length; ci++) cls[comp[ci]] = 'boot';
    }
  }

  // 条纹宽度跟球衣高度走。跑动图格子很小，band 用 2；漫画人物用身高的 1/16。
  function patternSecondary(pattern, x, y, cx, cy, band) {
    band = band || 2;
    if (pattern === 'stripes') return (Math.floor((x - cx) / band) & 1) === 0;
    if (pattern === 'hoops') return (Math.floor((y - cy) / band) & 1) === 0;
    if (pattern === 'sash') return Math.abs((x - cx) - (y - cy)) <= band * 2;
    if (pattern === 'halves') return x >= cx;
    return false;
  }

  // 每人一块连通域。品红/青是 A，橙/紫是 B。鞋、头发、皮肤顺着身体走，
  // 不按全图最近球衣（那会在两人交叠时把短裤和鞋换到对方身上）。
  // 连得上画面边缘的白（草地月牙、皮球、白线）留着；包在腿和腋下里的白补上。
  function prepareMangaMask(imgData) {
    var d = imgData.data, w = imgData.width, h = imgData.height, n = w * h;
    var cls = new Array(n);
    var p, i;
    for (p = 0; p < n; p++) {
      i = p * 4;
      cls[p] = mangaPixelClass(d[i], d[i + 1], d[i + 2], d[i + 3]);
    }
    resolveAmbiguous(cls, d, w, h);
    snapOutlineHalos(cls, d, w, h);
    var ball = detectBall(d, w, h);
    var grassY = grassLineY(d, w, h);
    var sky = detectSky(d, w, h, ball, grassY, cls);
    absorbBootWhites(cls, d, w, h, ball, sky);

    var claim = new Uint8Array(n);
    var part = new Uint8Array(n);
    var dist = new Int16Array(n);
    for (p = 0; p < n; p++) dist[p] = -1;
    var q = [];
    var qside = [];
    for (p = 0; p < n; p++) {
      if (ball[p] || sky[p]) continue;
      var side0 = clothSide(cls[p]);
      if (!side0) continue;
      claim[p] = side0;
      part[p] = partCode(cls[p]);
      dist[p] = 0;
      q.push(p);
      qside.push(side0);
    }
    var BR = 5;
    var qi = 0;
    while (qi < q.length) {
      var id = q[qi];
      var sd = qside[qi];
      qi++;
      var cd = dist[id];
      var x = id % w, y = (id / w) | 0;
      for (var dy = -1; dy <= 1; dy++) {
        var yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          var nid = yy * w + xx;
          if (ball[nid] || sky[nid]) continue;
          var nd = cd + 1;
          if (dist[nid] !== -1 && dist[nid] <= nd) continue;
          var other = clothSide(cls[nid]);
          if (other && other !== sd) continue;
          var pk = partCode(cls[nid]);
          if (!pk && !other) {
            var bi = nid * 4;
            var grass = isGrassPixel(d[bi], d[bi + 1], d[bi + 2]);
            if (grass && nd > 4) continue;
            if (!grass && nd > BR) continue;
          }
          dist[nid] = nd;
          if (pk) {
            if (!claim[nid]) {
              claim[nid] = sd;
              part[nid] = pk;
            }
          }
          if (pk || nd < BR) {
            q.push(nid);
            qside.push(sd);
          }
        }
      }
    }

    // 腿缝：左右 3 像素内都是身体的草地/白，不让外面的洪水钻进来。
    var pinch = new Uint8Array(n);
    var x2, y2, t, hitL, hitR, xx2;
    for (y2 = 0; y2 < h; y2++) {
      for (x2 = 0; x2 < w; x2++) {
        var id2 = y2 * w + x2;
        if (claim[id2]) continue;
        i = id2 * 4;
        if (d[i + 3] < 128) continue;
        if (!isGrassPixel(d[i], d[i + 1], d[i + 2]) && !isNearWhitePixel(d[i], d[i + 1], d[i + 2])) continue;
        hitL = 0; hitR = 0;
        for (t = 1; t <= 3; t++) {
          xx2 = x2 - t;
          if (xx2 >= 0 && claim[y2 * w + xx2]) { hitL = t; break; }
        }
        for (t = 1; t <= 3; t++) {
          xx2 = x2 + t;
          if (xx2 < w && claim[y2 * w + xx2]) { hitR = t; break; }
        }
        if (hitL && hitR) pinch[id2] = 1;
      }
    }

    var reach = new Uint8Array(n);
    var fq = [];
    function tryFlood(fid) {
      if (reach[fid] || claim[fid] || pinch[fid]) return;
      var fi = fid * 4;
      var fa = d[fi + 3];
      if (fa >= 128) {
        var fr = d[fi], fg = d[fi + 1], fb = d[fi + 2];
        if (!isGrassPixel(fr, fg, fb) && !isNearWhitePixel(fr, fg, fb)) return;
      }
      reach[fid] = 1;
      fq.push(fid);
    }
    for (x2 = 0; x2 < w; x2++) { tryFlood(x2); tryFlood((h - 1) * w + x2); }
    for (y2 = 0; y2 < h; y2++) { tryFlood(y2 * w); tryFlood(y2 * w + (w - 1)); }
    var fqi = 0;
    while (fqi < fq.length) {
      var fid = fq[fqi++];
      var fx = fid % w, fy = (fid / w) | 0;
      if (fx > 0) tryFlood(fid - 1);
      if (fx + 1 < w) tryFlood(fid + 1);
      if (fy > 0) tryFlood(fid - w);
      if (fy + 1 < h) tryFlood(fid + w);
    }

    for (p = 0; p < n; p++) {
      if (claim[p] || reach[p]) continue;
      i = p * 4;
      if (d[i + 3] < 128) continue;
      var r = d[i], g = d[i + 1], b = d[i + 2];
      if (ball[p] || sky[p]) continue;
      if (isGrassPixel(r, g, b) || isRedBallPixel(r, g, b)) continue;
      var xh = p % w, yh = (p / w) | 0;
      var white = isNearWhitePixel(r, g, b);
      // 草皮线以上的白是天空或手套，不涂成短裤。鞋面高光已经在前面收成鞋。
      if (white && yh < grassY) continue;
      // 离身体远的杂色（孤立红边、场上墨点）不动。白只补包在身体里的小块。
      var limit = white ? 8 : 2;
      if (r < 36 && g < 36 && b < 36) continue;
      var near = false;
      var votes = [0, 0, 0, 0, 0, 0, 0];
      var sideVotes = [0, 0, 0];
      var rad, dy3, dx3, nx3, ny3, np;
      for (rad = 1; rad <= limit && !near; rad++) {
        for (dy3 = -rad; dy3 <= rad; dy3++) {
          ny3 = yh + dy3;
          if (ny3 < 0 || ny3 >= h) continue;
          for (dx3 = -rad; dx3 <= rad; dx3++) {
            if (Math.max(Math.abs(dx3), Math.abs(dy3)) !== rad) continue;
            nx3 = xh + dx3;
            if (nx3 < 0 || nx3 >= w) continue;
            np = ny3 * w + nx3;
            if (!claim[np]) continue;
            near = true;
            sideVotes[claim[np]]++;
            if (part[np] && part[np] !== 6) votes[part[np]]++;
          }
        }
      }
      if (!near) continue;
      // 手套：贴着皮肤、不贴短裤的一小块白留下。
      if (isNearWhitePixel(r, g, b) && votes[5] > 0 && votes[2] === 0 && votes[1] === 0) continue;
      var bestSide = sideVotes[1] >= sideVotes[2] ? 1 : 2;
      if (!sideVotes[1] && !sideVotes[2]) {
        // 近处只有墨线，再往外找身体
        bestSide = 0;
        for (rad = 1; rad <= 6 && !bestSide; rad++) {
          for (dy3 = -rad; dy3 <= rad && !bestSide; dy3++) {
            ny3 = yh + dy3;
            if (ny3 < 0 || ny3 >= h) continue;
            for (dx3 = -rad; dx3 <= rad; dx3++) {
              nx3 = xh + dx3;
              if (nx3 < 0 || nx3 >= w) continue;
              np = ny3 * w + nx3;
              if (claim[np]) { bestSide = claim[np]; break; }
            }
          }
        }
      }
      if (!bestSide) continue;
      var bestPart = 2;
      var bestN = 0;
      for (var pi = 1; pi <= 5; pi++) {
        if (votes[pi] > bestN) { bestN = votes[pi]; bestPart = pi; }
      }
      if (!bestN) bestPart = 2;
      claim[p] = bestSide;
      part[p] = bestPart;
    }

    // 离身体稍远的鞋、头发、皮肤色键，归到最近的那个人，不留品红/玫红。
    for (p = 0; p < n; p++) {
      if (claim[p] || ball[p] || sky[p]) continue;
      var stray = partCode(cls[p]);
      if (stray !== 3 && stray !== 4 && stray !== 5) continue;
      var sx = p % w, sy = (p / w) | 0;
      var found = 0, bestD = 1e9;
      var rad2, dy4, dx4, qx, qy, qp;
        for (rad2 = 1; rad2 <= 14 && !found; rad2++) {
        for (dy4 = -rad2; dy4 <= rad2; dy4++) {
          qy = sy + dy4;
          if (qy < 0 || qy >= h) continue;
          for (dx4 = -rad2; dx4 <= rad2; dx4++) {
            if (Math.max(Math.abs(dx4), Math.abs(dy4)) !== rad2) continue;
            qx = sx + dx4;
            if (qx < 0 || qx >= w) continue;
            qp = qy * w + qx;
            if (!claim[qp]) continue;
            var dd = dx4 * dx4 + dy4 * dy4;
            if (dd < bestD) { bestD = dd; found = claim[qp]; }
          }
        }
      }
      if (found) {
        claim[p] = found;
        part[p] = stray;
      }
    }

    // 身体蒙版出来之后，再收一次夹在两人中间、草皮线以上的白洞。
    var seenSky = new Uint8Array(n);
    for (p = 0; p < n; p++) {
      if (seenSky[p] || ball[p] || sky[p] || claim[p]) continue;
      i = p * 4;
      if (d[i + 3] < 128 || !isNearWhitePixel(d[i], d[i + 1], d[i + 2])) { seenSky[p] = 1; continue; }
      var sq = [p]; seenSky[p] = 1;
      var scomp = [p];
      var sqi = 0, speri = 0, sabove = 0;
      var sminX = w, smaxX = 0, sminY = h, smaxY = 0;
      while (sqi < sq.length) {
        var sid = sq[sqi++];
        var sx = sid % w, sy = (sid / w) | 0;
        if (sy < grassY) sabove++;
        if (sx < sminX) sminX = sx; if (sx > smaxX) smaxX = sx;
        if (sy < sminY) sminY = sy; if (sy > smaxY) smaxY = sy;
        var sedge = false;
        var sdirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (var sdi = 0; sdi < 4; sdi++) {
          var snx = sx + sdirs[sdi][0], sny = sy + sdirs[sdi][1];
          if (sny < 0 || sny >= h || snx < 0 || snx >= w) { sedge = true; continue; }
          var snid = sny * w + snx;
          if (ball[snid] || claim[snid]) { sedge = true; continue; }
          var sni = snid * 4;
          if (d[sni + 3] >= 128 && isNearWhitePixel(d[sni], d[sni + 1], d[sni + 2]) && !sky[snid]) {
            if (!seenSky[snid]) { seenSky[snid] = 1; sq.push(snid); scomp.push(snid); }
          } else sedge = true;
        }
        if (sedge) speri++;
      }
      var sarea = scomp.length;
      var sbw = smaxX - sminX + 1, sbh = smaxY - sminY + 1;
      if (sabove < sarea * 0.65 || sarea < 800 || sarea > 12000) continue;
      if (sbw / sbh > 3.2 || sbh / sbw > 3.2 || Math.min(sbw, sbh) <= 20) continue;
      if (speri / sarea >= 0.16 || sarea / (sbw * sbh) < 0.35) continue;
      var smx = (sminX + smaxX) >> 1, smy = (sminY + smaxY) >> 1;
      function sideBody(dir) {
        var t, nx;
        for (t = 1; t <= 110; t++) {
          nx = smx + dir * t;
          if (nx < 0 || nx >= w) return false;
          if (claim[smy * w + nx]) return true;
        }
        return false;
      }
      if (sideBody(-1) && sideBody(1)) {
        for (var sci = 0; sci < scomp.length; sci++) sky[scomp[sci]] = 1;
      }
    }

    return { w: w, h: h, claim: claim, part: part, ball: ball, sky: sky, grassY: grassY };
  }

  // 漫画复合图换色。aLook 是品红/青那个人，bLook 是橙/紫那个人。
  // 参数名沿用 atk/def，只是 A/B，不代表进攻方和防守方。
  function paintManga(imgData, mask, aLook, bLook) {
    aLook = aLook || {};
    bLook = bLook || {};
    var looks = [null, aLook, bLook];
    var kits = [null, resolveKit(aLook.team || 'home', aLook.kit), resolveKit(bLook.team || 'away', bLook.kit)];
    var skins = [null,
      hexRgb((SKIN_PRESETS[aLook.skin] || SKIN_PRESETS.fair).color),
      hexRgb((SKIN_PRESETS[bLook.skin] || SKIN_PRESETS.fair).color)];
    var hairs = [null,
      hexRgb((HAIR_PRESETS[aLook.hair] || HAIR_PRESETS.black).color),
      hexRgb((HAIR_PRESETS[bLook.hair] || HAIR_PRESETS.black).color)];
    var d = imgData.data, w = mask.w, h = mask.h, n = w * h;
    var claim = mask.claim, part = mask.part;
    function jerseyBox(side) {
      var seen = new Uint8Array(n);
      var best = null;
      var p0, q, qi, id, x, y, nx, ny, nid, comp, minX, maxX, minY, maxY;
      for (p0 = 0; p0 < n; p0++) {
        if (seen[p0] || part[p0] !== 1 || claim[p0] !== side) continue;
        q = [p0]; seen[p0] = 1; qi = 0;
        comp = 0; minX = w; maxX = 0; minY = h; maxY = 0;
        var sx = 0, sy = 0;
        while (qi < q.length) {
          id = q[qi++];
          x = id % w; y = (id / w) | 0;
          comp++; sx += x; sy += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          var dy, dx;
          for (dy = -1; dy <= 1; dy++) {
            ny = y + dy; if (ny < 0 || ny >= h) continue;
            for (dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              nx = x + dx; if (nx < 0 || nx >= w) continue;
              nid = ny * w + nx;
              if (seen[nid] || part[nid] !== 1 || claim[nid] !== side) continue;
              seen[nid] = 1; q.push(nid);
            }
          }
        }
        if (!best || comp > best.n) {
          best = { n: comp, cx: sx / comp, cy: sy / comp, minX: minX, maxX: maxX, minY: minY, maxY: maxY };
        }
      }
      if (!best) return null;
      best.band = Math.max(3, Math.round((best.maxY - best.minY) / 12));
      return best;
    }
    var box1 = jerseyBox(1);
    var box2 = jerseyBox(2);
    var boxes = [null, box1, box2];
    var hairRef = relLum(0, 0, 255);
    var skinRef = relLum(240, 200, 160);
    function jerseyRgb(side, x, y) {
      var look = looks[side];
      var kit = kits[side];
      if (look && look.pos === 'GK') {
        return hexRgb(look.team === 'home' ? '#e8b923' : '#7a7f8a');
      }
      var b = boxes[side];
      var hex = kit.primary;
      if (!b) return hexRgb(hex);
      var on = false;
      if (kit.pattern === 'sash') {
        var uw = Math.max(1, b.maxX - b.minX);
        var uh = Math.max(1, b.maxY - b.minY);
        on = Math.abs((x - b.minX) / uw - (y - b.minY) / uh) <= 0.16;
      } else {
        on = patternSecondary(kit.pattern, x, y, b.cx, b.cy, b.band);
      }
      if (on) hex = kit.secondary || kit.primary;
      return hexRgb(hex);
    }
    var p, pr, side;
    for (p = 0; p < n; p++) {
      var o = p * 4;
      if (mask.sky && mask.sky[p]) { d[o + 3] = 0; continue; }
      if (mask.ball && mask.ball[p]) continue;
      pr = part[p];
      side = claim[p];
      if (!pr || !side) continue;
      var rgb = null;
      if (pr === 6) rgb = [0, 0, 0];
      else if (pr === 1) rgb = jerseyRgb(side, p % w, (p / w) | 0);
      else if (pr === 2) rgb = hexRgb(kits[side].shorts);
      else if (pr === 3) rgb = hexRgb(kits[side].shoes || '#222222');
      else if (pr === 4) rgb = toneRgb(hairs[side], d[o], d[o + 1], d[o + 2], hairRef);
      else if (pr === 5) rgb = toneRgb(skins[side], d[o], d[o + 1], d[o + 2], skinRef);
      if (!rgb) continue;
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
    }
    return imgData;
  }

  function recolorManga(imgData, atkLook, defLook) {
    var mask = prepareMangaMask(imgData);
    return paintManga(imgData, mask, atkLook, defLook);
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
    classifyPlaceholders: classifyPlaceholders,
    sheetCenters: sheetCenters,
    recolorImageData: recolorImageData,
    resolveKit: resolveKit,
    isSkinPixel: isSkinPixel,
    recolorSkin: recolorSkin,
    mangaPixelClass: mangaPixelClass,
    prepareMangaMask: prepareMangaMask,
    paintManga: paintManga,
    recolorManga: recolorManga,
  };
});
