// shared/kits.js
// 球队球衣颜色配置 + 结算图调色板规范（2026-10-10）。
//
// 设计目标：新增球队时不用为每种颜色组合重画图。
// 跑动图只有一套占位符，运行时换成球队或单个球员的颜色和球衣图案。
//
// 占位符规范（新图生成时必须遵守）：
//   #FF00FF (品红) = 球衣 | #00FFFF (青) = 球裤 | #FFFF00 (黄) = 球袜
//   #FF0088 (玫红) = 球鞋。现有跑动图的鞋是深色，加载时会自动标成这个颜色。
//   #FF8800 / #8800FF / #00FF88 仍是客队球衣/球裤/球袜，给结算图用。
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
      socks: '#2a5db0',
      shoes: '#1a1a1a',
    },
    away: {
      name: '烈风学院',
      pattern: 'hoops',
      primary: '#d03030',
      secondary: '#f4f4f4',
      jersey: '#d03030',
      shorts: '#8f1f1f',
      socks: '#d03030',
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
    return {
      name: src.name || base.name || '',
      pattern: pattern,
      primary: primary,
      secondary: src.secondary || base.secondary || '#f4f4f4',
      jersey: primary,
      shorts: src.shorts || base.shorts || '#ffffff',
      socks: src.socks || base.socks || primary,
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
    hexToHsl: hexToHsl,
    hslToRgb: hslToRgb,
    markShoePlaceholders: markShoePlaceholders,
    recolorImageData: recolorImageData,
    resolveKit: resolveKit,
    isSkinPixel: isSkinPixel,
    recolorSkin: recolorSkin,
  };
});
