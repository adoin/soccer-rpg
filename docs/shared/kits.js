// shared/kits.js
// 球队球衣颜色配置 + 结算图调色板规范（2026-10-10）。
//
// 设计目标：新增球队时不用为每种颜色组合重画结算图。
// 方案：结算底图用占位符纯色绘制，运行时按球队实际颜色做 HSL 色相替换。
//
// 占位符规范（新图生成时必须遵守）：
//   #FF00FF (品红) = 主队球衣 | #00FFFF (青) = 主队球裤 | #FFFF00 (黄) = 主队球袜
//   #FF8800 (橙)   = 客队球衣 | #8800FF (紫) = 客队球裤 | #00FF88 (绿) = 客队球袜
// 阴影/高光由运行时 HSL 保留明度自动处理，底图只需平涂占位符。
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SharedKits = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 球队实际颜色（十六进制）
  var TEAM_COLORS = {
    home: { jersey: '#2a5db0', shorts: '#1e3f7a', socks: '#2a5db0', name: '青鹰高校' },
    away: { jersey: '#d03030', shorts: '#8f1f1f', socks: '#d03030', name: '烈风学院' },
  };

  // 占位符 → 球队部位的映射（R,G,B 精确匹配）
  var PLACEHOLDERS = {
    '255,0,255':   { team: 'home', part: 'jersey' }, // 品红
    '0,255,255':   { team: 'home', part: 'shorts' }, // 青
    '255,255,0':   { team: 'home', part: 'socks' },  // 黄
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

  // 运行时换色：把 ImageData 里占位符纯色替换为球队颜色（保留原像素明度做阴影）。
  // tolerance: 容差（0-255），用于抗锯齿边缘。
  function recolorImageData(imgData, teamColors, tolerance) {
    teamColors = teamColors || TEAM_COLORS;
    tolerance = tolerance == null ? 32 : tolerance;
    var d = imgData.data;
    var hslCache = {};
    function targetHsl(team, part) {
      var key = team + '.' + part;
      if (!hslCache[key]) hslCache[key] = hexToHsl(teamColors[team][part]);
      return hslCache[key];
    }
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue; // 跳过透明
      var key = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
      var ph = PLACEHOLDERS[key];
      // 容差匹配：找最近的占位符
      if (!ph && tolerance > 0) {
        var best = null, bd = 1e9;
        for (var pk in PLACEHOLDERS) {
          var c = pk.split(',').map(Number);
          var dist = Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]);
          if (dist < bd) { bd = dist; best = pk; }
        }
        if (bd <= tolerance * 3) ph = PLACEHOLDERS[best];
      }
      if (!ph) continue;
      var th = targetHsl(ph.team, ph.part);
      // 保留原像素的相对明度（阴影），只换色相和饱和度
      var origL = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      var rgb = hslToRgb(th.h, th.s, origL * 0.9 + th.l * 0.1);
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
    }
    return imgData;
  }

  return {
    TEAM_COLORS: TEAM_COLORS,
    PLACEHOLDERS: PLACEHOLDERS,
    hexToHsl: hexToHsl,
    hslToRgb: hslToRgb,
    recolorImageData: recolorImageData,
  };
});
