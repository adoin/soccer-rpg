// 每张切入 × 三套球衣：人物对得上球衣，色键不残留，草地上的白月牙不进球衣。
'use strict';

var fs = require('fs');
var path = require('path');
var execFileSync = require('child_process').execFileSync;
var kits = require('../shared/kits');

var failed = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  PASS ' + name);
  else { failed++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

var ROOT = path.join(__dirname, '..');
var MANGA = path.join(ROOT, 'client/assets/manga');
var src = fs.readFileSync(path.join(ROOT, 'client/js/manga-cutin.js'), 'utf8');
var poses = [];
src.replace(/pose:\s*'([^']+)'/g, function (_, name) {
  if (poses.indexOf(name) < 0) poses.push(name);
});
ok(poses.indexOf('def_flying_tackle') >= 0 && poses.indexOf('def_sweep') >= 0
  && poses.indexOf('def_shoulder') >= 0 && poses.indexOf('def_elbow') >= 0, '四张防守分镜都挂上了');
ok(poses.length >= 17, '切入姿势数量', String(poses.length));

function loadPng(file) {
  var py = [
    'from PIL import Image',
    'import struct, sys',
    'im = Image.open(sys.argv[1]).convert("RGBA")',
    'sys.stdout.buffer.write(struct.pack("<II", im.size[0], im.size[1]) + im.tobytes())',
  ].join('\n');
  var buf = execFileSync('python3', ['-c', py, file], { maxBuffer: 32 * 1024 * 1024 });
  var w = buf.readUInt32LE(0);
  var h = buf.readUInt32LE(4);
  var data = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, w * h * 4);
  return { width: w, height: h, data: data };
}

function rgbOf(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function same(px, rgb) { return px[0] === rgb[0] && px[1] === rgb[1] && px[2] === rgb[2]; }
function nearWhite(r, g, b) {
  var mx = r > g ? r : g; if (b > mx) mx = b;
  var mn = r < g ? r : g; if (b < mn) mn = b;
  return mx > 220 && (mx - mn) < 18 && mn > 200;
}
function scaleRgb(rgb, f) {
  return [Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f)];
}
function matchesTone(px, rgb) {
  return same(px, rgb) || same(px, scaleRgb(rgb, 0.8)) || same(px, scaleRgb(rgb, 0.85));
}
function hsvOf(r, g, b) {
  var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  var s = max === 0 ? 0 : d / max;
  var h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h: h, s: s, v: max };
}
// 亮度映射之后色相还是这件衣服的。近白近黑的球衣只要求结果也接近中性。
function shadeOk(px, rgb) {
  var src = hsvOf(px[0], px[1], px[2]);
  var dst = hsvOf(rgb[0], rgb[1], rgb[2]);
  if (src.v < 28) return true;
  if (dst.s < 0.18) return src.s < 0.32;
  var dh = Math.abs(src.h - dst.h);
  if (dh > 180) dh = 360 - dh;
  return src.s > 0.1 && dh < 18;
}
function nearScale(px, rgb) {
  if (same(px, rgb)) return true;
  var prev = -1;
  for (var i = 0; i < 3; i++) {
    if (rgb[i] < 12) {
      if (px[i] > 24) return false;
      continue;
    }
    var t = px[i] / rgb[i];
    if (t < 0.78 || t > 1.03) return false;
    if (prev >= 0 && Math.abs(t - prev) > 0.08) return false;
    prev = t;
  }
  return true;
}
var KEYS = [[255, 0, 255], [0, 255, 255], [255, 136, 0], [136, 0, 255], [255, 0, 136], [0, 0, 255]];

var home = kits.resolveKit('home', null);
var away = kits.resolveKit('away', null);
var combos = [
  {
    name: '默认',
    a: { team: 'home', skin: 'east', hair: 'blonde', kit: null },
    b: { team: 'away', skin: 'tan', hair: 'black', kit: null },
    aKit: home, bKit: away,
  },
  {
    name: '斜带',
    a: { team: 'home', skin: 'deep', hair: 'blonde', kit: { pattern: 'sash', primary: '#f2f2f2', secondary: '#1d3f8f', shorts: '#1e3f7a', shoes: '#e6c34a' } },
    b: { team: 'away', skin: 'fair', hair: 'brown', kit: { pattern: 'stripes', primary: '#1a1a1a', secondary: '#f4f4f4', shorts: '#1a1a1a', shoes: '#c62828' } },
    aKit: kits.resolveKit('home', { pattern: 'sash', primary: '#f2f2f2', secondary: '#1d3f8f', shorts: '#1e3f7a', shoes: '#e6c34a' }),
    bKit: kits.resolveKit('away', { pattern: 'stripes', primary: '#1a1a1a', secondary: '#f4f4f4', shorts: '#1a1a1a', shoes: '#c62828' }),
  },
  {
    name: '横条',
    a: { team: 'home', skin: 'tan', hair: 'auburn', kit: { pattern: 'hoops', primary: '#d03030', secondary: '#f4f4f4', shorts: '#8f1f1f', shoes: '#f4f4f4' } },
    b: { team: 'away', skin: 'east', hair: 'black', kit: { pattern: 'halves', primary: '#2a5db0', secondary: '#f4f4f4', shorts: '#1e3f7a', shoes: '#111111' } },
    aKit: kits.resolveKit('home', { pattern: 'hoops', primary: '#d03030', secondary: '#f4f4f4', shorts: '#8f1f1f', shoes: '#f4f4f4' }),
    bKit: kits.resolveKit('away', { pattern: 'halves', primary: '#2a5db0', secondary: '#f4f4f4', shorts: '#1e3f7a', shoes: '#111111' }),
  },
];

var thumbs = [];
poses.forEach(function (pose) {
  var file = path.join(MANGA, pose + '.png');
  ok(fs.existsSync(file), pose + ' 有图');
  if (!fs.existsSync(file)) return;
  var base = loadPng(file);
  var labelFile = path.join(MANGA, 'labels', pose + '.png');
  ok(fs.existsSync(labelFile), pose + ' 有标签图');
  if (!fs.existsSync(labelFile)) return;
  var decoded = loadPng(labelFile);
  var nPix = base.width * base.height;
  var label = new Uint8Array(nPix);
  var figure = new Uint8Array(nPix);
  for (var li = 0; li < nPix; li++) {
    label[li] = decoded.data[li * 4];
    figure[li] = decoded.data[li * 4 + 1];
  }
  var map = { label: label, figure: figure, w: base.width, h: base.height };
  var mask = kits.maskFromLabels(label, figure, base.width, base.height);
  var aN = 0, bN = 0, aj = 0, bj = 0;
  for (var i = 0; i < mask.claim.length; i++) {
    if (mask.claim[i] === 1) aN++;
    if (mask.claim[i] === 2) bN++;
    if (mask.part[i] === 1 && mask.claim[i] === 1) aj++;
    if (mask.part[i] === 1 && mask.claim[i] === 2) bj++;
  }
  ok(aN > 500 && bN > 500, pose + ' 两个人都分出来了', aN + '/' + bN);
  ok(aj > 200 && bj > 200, pose + ' 两件球衣都在', aj + '/' + bj);
  combos.forEach(function (combo, ci) {
    var data = new Uint8ClampedArray(base.data);
    var img = { width: base.width, height: base.height, data: data };
    kits.paintMangaLabels(img, map, combo.a, combo.b);
    var aColors = [rgbOf(combo.aKit.primary), rgbOf(combo.aKit.secondary)];
    var bColors = [rgbOf(combo.bKit.primary), rgbOf(combo.bKit.secondary)];
    var aShort = rgbOf(combo.aKit.shorts);
    var bShort = rgbOf(combo.bKit.shorts);
    var aShoe = rgbOf(combo.aKit.shoes);
    var bShoe = rgbOf(combo.bKit.shoes);
    var keys = 0, badA = 0, badB = 0, badAS = 0, badBS = 0, stray = 0, aSeen = {}, bSeen = {};
    var jerseyA = 0, jerseyB = 0;
    var ballChanged = 0, ballN = 0;
    console.log('CUT ' + pose + ' ' + combo.name
      + ' A team=' + combo.a.team + ' pattern=' + combo.aKit.pattern
      + ' primary=' + combo.aKit.primary + ' secondary=' + combo.aKit.secondary
      + ' shorts=' + combo.aKit.shorts + ' socks=' + combo.aKit.socks + ' shoes=' + combo.aKit.shoes
      + ' hair=' + combo.a.hair + ' skin=' + combo.a.skin
      + ' | B team=' + combo.b.team + ' pattern=' + combo.bKit.pattern
      + ' primary=' + combo.bKit.primary + ' secondary=' + combo.bKit.secondary
      + ' shorts=' + combo.bKit.shorts + ' socks=' + combo.bKit.socks + ' shoes=' + combo.bKit.shoes
      + ' hair=' + combo.b.hair + ' skin=' + combo.b.skin);
    for (var p = 0; p < data.length; p += 4) {
      var px = [data[p], data[p + 1], data[p + 2]];
      var idx = p / 4;
      for (var k = 0; k < KEYS.length; k++) if (same(px, KEYS[k])) keys++;
      var claim = mask.claim[idx];
      var part = mask.part[idx];
      if (part === 1 && claim === 1) {
        jerseyA++;
        var hitA = shadeOk(px, aColors[0]) || shadeOk(px, aColors[1]);
        if (!hitA) badA++;
        else if (same(px, aColors[0]) || same(px, aColors[1])) aSeen[px.join(',')] = 1;
      } else if (part === 1 && claim === 2) {
        jerseyB++;
        var hitB = shadeOk(px, bColors[0]) || shadeOk(px, bColors[1]);
        if (!hitB) badB++;
        else if (same(px, bColors[0]) || same(px, bColors[1])) bSeen[px.join(',')] = 1;
      } else if (part === 2 && claim === 1 && !shadeOk(px, aShort)) badAS++;
      else if (part === 2 && claim === 2 && !shadeOk(px, bShort)) badBS++;
      else if (part === 3 && claim === 1 && !shadeOk(px, aShoe)) badA++;
      else if (part === 3 && claim === 2 && !shadeOk(px, bShoe)) badB++;
      if (claim && part && part !== 6 && data[p + 3] > 200 && nearWhite(px[0], px[1], px[2])) {
        var allowed = aColors.concat(bColors, [aShort, bShort, aShoe, bShoe]).some(function (c) { return same(px, c); });
        var piece = part === 1 ? (claim === 1 ? aColors : bColors) : part === 2 ? [claim === 1 ? aShort : bShort] : part === 3 ? [claim === 1 ? aShoe : bShoe] : [];
        var lightPiece = piece.some(function (c) { return nearWhite(c[0], c[1], c[2]); });
        if (!allowed && !lightPiece) stray++;
      }
      if (mask.ball && mask.ball[idx]) {
        ballN++;
        var s0 = base.data[p], s1 = base.data[p + 1], s2 = base.data[p + 2];
        if (data[p] !== s0 || data[p + 1] !== s1 || data[p + 2] !== s2 || data[p + 3] < 250) ballChanged++;
      }
    }
    function hueSat(r, g, b) {
      var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      var s = max === 0 ? 0 : d / max;
      var h = 0;
      if (d) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60; if (h < 0) h += 360;
      }
      return { h: h, s: s };
    }
    function hueSpread(side, part) {
      var buckets = {};
      var n = 0;
      for (var i = 0; i < mask.claim.length; i++) {
        if (mask.claim[i] !== side || mask.part[i] !== part) continue;
        var o = i * 4;
        if (data[o + 3] < 200) continue;
        var hs = hueSat(data[o], data[o + 1], data[o + 2]);
        if (hs.s < 0.22) continue;
        var bkt = Math.floor(hs.h / 12);
        buckets[bkt] = (buckets[bkt] || 0) + 1;
        n++;
      }
      var big = 0;
      Object.keys(buckets).forEach(function (k) { if (buckets[k] > n * 0.08) big++; });
      return { n: n, big: big };
    }
    var hairA = hueSpread(1, 4), hairB = hueSpread(2, 4);
    var skinA = hueSpread(1, 5), skinB = hueSpread(2, 5);
    function skinStats(side, baseRgb) {
      var total = 0, baseN = 0, buckets = {};
      for (var i = 0; i < mask.claim.length; i++) {
        if (mask.claim[i] !== side || mask.part[i] !== 5) continue;
        var o = i * 4;
        if (data[o + 3] < 200) continue;
        total++;
        if (same([data[o], data[o + 1], data[o + 2]], baseRgb)) baseN++;
        var lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
        var bk = Math.round(lum / 6);
        buckets[bk] = (buckets[bk] || 0) + 1;
      }
      var levels = [];
      Object.keys(buckets).forEach(function (k) {
        if (buckets[k] > total * 0.04) levels.push(Number(k) * 6);
      });
      levels.sort(function (a, b) { return a - b; });
      var ratio = levels.length < 2 ? 1 : levels[0] / levels[levels.length - 1];
      return { total: total, basePct: total ? baseN / total : 1, ratio: ratio };
    }
    var skinRgbA = rgbOf((kits.SKIN_PRESETS[combo.a.skin] || kits.SKIN_PRESETS.fair).color);
    var skinRgbB = rgbOf((kits.SKIN_PRESETS[combo.b.skin] || kits.SKIN_PRESETS.fair).color);
    var skinLA = skinStats(1, skinRgbA), skinLB = skinStats(2, skinRgbB);
    function hairComponentHues() {
      var ww = base.width, hh = base.height, seen = new Uint8Array(ww * hh), bad = 0, nComp = 0;
      for (var s = 0; s < ww * hh; s++) {
        if (seen[s] || mask.part[s] !== 4) continue;
        var q = [s]; seen[s] = 1;
        var buckets = {}, n = 0, claim0 = mask.claim[s];
        for (var qi = 0; qi < q.length; qi++) {
          var id = q[qi];
          var o = id * 4;
          if (data[o + 3] > 200) {
            var hs = hueSat(data[o], data[o + 1], data[o + 2]);
            if (hs.s >= 0.22) {
              var bkt = Math.floor(hs.h / 12);
              buckets[bkt] = (buckets[bkt] || 0) + 1;
              n++;
            }
          }
          var x = id % ww, y = (id / ww) | 0;
          [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (dlt) {
            var nx = x + dlt[0], ny = y + dlt[1];
            if (nx < 0 || ny < 0 || nx >= ww || ny >= hh) return;
            var nid = ny * ww + nx;
            if (seen[nid] || mask.part[nid] !== 4 || mask.claim[nid] !== claim0) return;
            seen[nid] = 1; q.push(nid);
          });
        }
        if (n < 40) continue;
        nComp++;
        var big = 0;
        Object.keys(buckets).forEach(function (k) { if (buckets[k] > n * 0.08) big++; });
        if (big > 1) bad++;
      }
      return { bad: bad, nComp: nComp };
    }
    var hairComp = ci === 0 ? hairComponentHues() : { bad: 0, nComp: 0 };
    function bootHuePct(side, shoe) {
      var shoeHs = hueSat(shoe[0], shoe[1], shoe[2]);
      var n = 0, okN = 0;
      for (var i = 0; i < mask.claim.length; i++) {
        if (mask.claim[i] !== side || mask.part[i] !== 3) continue;
        var o = i * 4;
        if (data[o + 3] < 200) continue;
        n++;
        var hs = hueSat(data[o], data[o + 1], data[o + 2]);
        if (shoeHs.s < 0.18) {
          if (hs.s < 0.25) okN++;
        } else {
          var dh = Math.abs(hs.h - shoeHs.h);
          if (dh > 180) dh = 360 - dh;
          if (hs.s > 0.15 && dh < 18) okN++;
        }
      }
      return { n: n, pct: n ? okN / n : 1 };
    }
    var bootA = bootHuePct(1, aShoe), bootB = bootHuePct(2, bShoe);
    var bootWhite = 0;
    [1, 2].forEach(function (side) {
      var shoe = side === 1 ? aShoe : bShoe;
      var shoeWhite = nearWhite(shoe[0], shoe[1], shoe[2]);
      for (var i = 0; i < mask.claim.length; i++) {
        if (mask.claim[i] !== side || mask.part[i] !== 3) continue;
        var o = i * 4;
        if (!shoeWhite && data[o + 3] > 200 && nearWhite(data[o], data[o + 1], data[o + 2])) bootWhite++;
      }
    });
    // 草皮线以上、人物外面的成片白天空。球和网（碎边）不算。
    var skyBlob = 0;
    if (ci === 0) {
      var ww = base.width, hh = base.height, gn = ww * hh;
      var seenW = new Uint8Array(gn);
      var gy = mask.grassY || 0;
      for (var sp = 0; sp < gn; sp++) {
        if (seenW[sp]) continue;
        var so = sp * 4;
        if (data[so + 3] < 200 || !nearWhite(data[so], data[so + 1], data[so + 2])) { seenW[sp] = 1; continue; }
        if ((mask.ball && mask.ball[sp]) || mask.claim[sp] || (mask.keep && mask.keep[sp])) { seenW[sp] = 1; continue; }
        var q = [sp]; seenW[sp] = 1;
        var area = 0, peri = 0, above = 0, minX = ww, maxX = 0, minY = hh, maxY = 0;
        for (var qi = 0; qi < q.length; qi++) {
          var id = q[qi];
          area++;
          var x = id % ww, y = (id / ww) | 0;
          if (y < gy) above++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          var edge = false;
          [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (dlt) {
            var nx = x + dlt[0], ny = y + dlt[1];
            if (nx < 0 || ny < 0 || nx >= ww || ny >= hh) { edge = true; return; }
            var nid = ny * ww + nx;
            var no = nid * 4;
            if (data[no + 3] >= 200 && nearWhite(data[no], data[no + 1], data[no + 2]) && !(mask.ball && mask.ball[nid]) && !mask.claim[nid] && !(mask.keep && mask.keep[nid])) {
              if (!seenW[nid]) { seenW[nid] = 1; q.push(nid); }
            } else edge = true;
          });
          if (edge) peri++;
        }
        var bw = maxX - minX + 1, bh = maxY - minY + 1;
        var solidity = area / (bw * bh);
        if (!(above > area * 0.65 && area > 800 && area < 12000 && peri / area < 0.16 && solidity > 0.4 && Math.min(bw, bh) > 20)) continue;
        if (bw / bh > 3.2 || bh / bw > 3.2) continue;
        var midX = (minX + maxX) >> 1, midY = (minY + maxY) >> 1;
        function bodySide(dir) {
          for (var t = 1; t <= 110; t++) {
            var nx = midX + dir * t;
            if (nx < 0 || nx >= ww) return false;
            if (mask.claim[midY * ww + nx]) return true;
          }
          return false;
        }
        // 夹在两个人身体之间的白块才是裤裆天空。草地月牙和球网不在人缝里。
        if (bodySide(-1) && bodySide(1)) skyBlob = Math.max(skyBlob, area);
      }
    }
    var tag = pose + '/' + combo.name;
    ok(keys === 0, tag + ' 没有剩余色键', String(keys));
    ok(badA === 0 && badB === 0, tag + ' 球衣鞋是本人的颜色', badA + '/' + badB);
    ok(badAS === 0 && badBS === 0, tag + ' 短裤球袜是本人的颜色', badAS + '/' + badBS);
    ok(stray === 0, tag + ' 人里面没有多余的白', String(stray));
    ok(ballN === 0 || ballChanged === 0, tag + ' 皮球像素和原图一致', ballChanged + '/' + ballN);
    var leak = 0, netN = 0, netChanged = 0;
    if (ci === 0 && mask.keep) {
      for (var li = 0; li < mask.claim.length; li++) {
        var lo = li * 4;
        var lr = base.data[lo], lg = base.data[lo + 1], lb = base.data[lo + 2], la = base.data[lo + 3];
        if (la < 200) continue;
        var lchanged = data[lo] !== lr || data[lo + 1] !== lg || data[lo + 2] !== lb;
        var lgrass = lg > lr + 8 && lg + 8 >= lb && lb < lg * 0.55 && lg > 55;
        if ((mask.keep[li] || (mask.ball && mask.ball[li]) || lgrass) && lchanged) leak++;
        if (mask.keep[li]) {
          netN++;
          if (lchanged || data[lo + 3] < 200) netChanged++;
        }
      }
      // 贴着球网、里面没有鞋色键的整块鞋色（门线下的色块）。
      var bootBlock = 0;
      if (mask.part) {
        var bseen = new Uint8Array(mask.claim.length);
        var bw0 = base.width, bh0 = base.height;
        for (var bp = 0; bp < bseen.length; bp++) {
          if (bseen[bp] || mask.part[bp] !== 3) continue;
          var bq = [bp]; bseen[bp] = 1;
          var barea = 0, bkey = 0, bkeep = 0;
          for (var bqi = 0; bqi < bq.length; bqi++) {
            var bid = bq[bqi];
            barea++;
            var bso = bid * 4;
            var bsr = base.data[bso], bsg = base.data[bso + 1], bsb = base.data[bso + 2];
            if (Math.abs(bsr - 255) + bsg + Math.abs(bsb - 136) < 28) bkey++;
            var bx = bid % bw0, by = (bid / bw0) | 0;
            [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].forEach(function (dlt) {
              var nx = bx + dlt[0], ny = by + dlt[1];
              if (nx < 0 || ny < 0 || nx >= bw0 || ny >= bh0) return;
              var nid = ny * bw0 + nx;
              if (mask.keep && mask.keep[nid]) bkeep++;
              if (bseen[nid] || mask.part[nid] !== 3) return;
              bseen[nid] = 1; bq.push(nid);
            });
          }
          if (barea >= 80 && bkey <= barea * 0.08 && bkeep >= 40) { bootBlock += barea; leak += barea; }
        }
      }
      // 同一个人的脸、手臂、腿必须是同一个皮肤底色。腿跟着短裤和球袜，不跟着更近的对方球衣。
      var skinClash = 0;
      (function () {
        var ww = base.width, hh = base.height, nn = ww * hh;
        var presets = [null, skinRgbA, skinRgbB];
        function isBase(px, rgb) {
          return Math.abs(px[0] - rgb[0]) <= 8 && Math.abs(px[1] - rgb[1]) <= 8 && Math.abs(px[2] - rgb[2]) <= 8;
        }
        var seen = new Uint8Array(nn);
        var bucket = { 1: [0, 0, 0], 2: [0, 0, 0] };
        for (var sp = 0; sp < nn; sp++) {
          if (seen[sp] || mask.part[sp] !== 5) continue;
          var q = [sp]; seen[sp] = 1;
          var area = 0, vote = [0, 0, 0], tones = [0, 0, 0], claims = [0, 0, 0];
          for (var qi = 0; qi < q.length; qi++) {
            var id = q[qi];
            area++;
            claims[mask.claim[id]]++;
            var o = id * 4;
            var px = [data[o], data[o + 1], data[o + 2]];
            if (isBase(px, presets[1])) tones[1]++;
            else if (isBase(px, presets[2])) tones[2]++;
            var x = id % ww, y = (id / ww) | 0;
            for (var dy = -2; dy <= 2; dy++) {
              var ny = y + dy; if (ny < 0 || ny >= hh) continue;
              for (var dx = -2; dx <= 2; dx++) {
                if (!dx && !dy) continue;
                var nx = x + dx; if (nx < 0 || nx >= ww) continue;
                var nid = ny * ww + nx;
                if ((mask.part[nid] === 1 || mask.part[nid] === 2) && mask.claim[nid]) vote[mask.claim[nid]]++;
                if (mask.part[nid] === 5 && !seen[nid]) { seen[nid] = 1; q.push(nid); }
              }
            }
          }
          if (area < 200) continue;
          // 布料票要明显一边倒，才说明这块皮肤属于那个人。缠在一起时信这块自己的归属。
          var side = 0;
          if (vote[1] > vote[2] * 2 && vote[1] > 30) side = 1;
          else if (vote[2] > vote[1] * 2 && vote[2] > 30) side = 2;
          else side = claims[1] >= claims[2] ? 1 : 2;
          if (!side) continue;
          bucket[side][1] += tones[1];
          bucket[side][2] += tones[2];
        }
        [1, 2].forEach(function (side) {
          var mine = bucket[side][side];
          var other = bucket[side][side === 1 ? 2 : 1];
          if (other > 400 && other > mine * 0.08) skinClash += other;
        });
      })();
      var netSky = 0;
      if (/goal|gk_|hit_post|round_gk|shot_wide/.test(pose) && mask.sky) {
        var nsw = base.width, nsh = base.height, nsSeen = new Uint8Array(nsw * nsh);
        for (var nsp = 0; nsp < nsSeen.length; nsp++) {
          if (nsSeen[nsp] || !mask.sky[nsp] || base.data[nsp * 4 + 3] < 200) continue;
          var nsq = [nsp]; nsSeen[nsp] = 1;
          var nsArea = 0, nsMinX = nsw, nsMaxX = 0, nsMinY = nsh, nsMaxY = 0;
          for (var nsi = 0; nsi < nsq.length; nsi++) {
            var nid2 = nsq[nsi];
            nsArea++;
            var nx2 = nid2 % nsw, ny2 = (nid2 / nsw) | 0;
            if (nx2 < nsMinX) nsMinX = nx2; if (nx2 > nsMaxX) nsMaxX = nx2;
            if (ny2 < nsMinY) nsMinY = ny2; if (ny2 > nsMaxY) nsMaxY = ny2;
            [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].forEach(function (dlt) {
              var ax = nx2 + dlt[0], ay = ny2 + dlt[1];
              if (ax < 0 || ay < 0 || ax >= nsw || ay >= nsh) return;
              var aid = ay * nsw + ax;
              if (nsSeen[aid] || !mask.sky[aid] || base.data[aid * 4 + 3] < 200) return;
              nsSeen[aid] = 1; nsq.push(aid);
            });
          }
          var nsbw = nsMaxX - nsMinX + 1, nsbh = nsMaxY - nsMinY + 1;
          if (nsArea < 200 || nsArea >= 4500 || Math.max(nsbw, nsbh) > 90) continue;
          if (Math.max(nsbw, nsbh) / Math.max(1, Math.min(nsbw, nsbh)) >= 2) continue;
          var onGrass = false;
          for (var gy = nsMaxY; gy <= nsMaxY + 8 && gy < nsh && !onGrass; gy++) {
            for (var gx = nsMinX; gx <= nsMaxX; gx++) {
              var go = (gy * nsw + gx) * 4;
              var gr = base.data[go], gg = base.data[go + 1], gb = base.data[go + 2];
              if (gg > gr + 8 && gg + 8 >= gb && gb < gg * 0.55 && gg > 55) onGrass = true;
            }
          }
          if (onGrass) netSky += nsArea;
        }
      }
      leak += netSky;
      console.log('LEAK ' + pose + ' ' + leak + ' keep ' + netN + ' keepChanged ' + netChanged + ' bootBlock ' + bootBlock + ' skinClash ' + skinClash + ' netSky ' + netSky);
      ok(leak <= 20, tag + ' 场地球网门柱没有渗色', String(leak));
      ok(bootBlock === 0, tag + ' 球门下没有整块鞋色', String(bootBlock));
      ok(skinClash < 250, tag + ' 同一个人皮肤只有一个底色', String(skinClash));
      if (/goal|gk_|hit_post|round_gk|shot_wide/.test(pose)) ok(netSky === 0, tag + ' 球网格子没有被抠成天空', String(netSky));
      // 两只鞋都跟着这块人的短裤，不能一只红一只金。
      (function () {
        var ww = base.width, hh = base.height, nn = ww * hh;
        var sSeen = new Uint8Array(nn);
        var sSize = new Uint32Array(nn);
        var sp;
        for (sp = 0; sp < nn; sp++) {
          if (sSeen[sp] || mask.part[sp] !== 2) continue;
          var sq = [sp]; sSeen[sp] = 1;
          var sc = [sp];
          for (var sqi = 0; sqi < sq.length; sqi++) {
            var sid = sq[sqi];
            var sx = sid % ww, sy = (sid / ww) | 0;
            for (var sdy = -1; sdy <= 1; sdy++) {
              var sny = sy + sdy; if (sny < 0 || sny >= hh) continue;
              for (var sdx = -1; sdx <= 1; sdx++) {
                if (!sdx && !sdy) continue;
                var snx = sx + sdx; if (snx < 0 || snx >= ww) continue;
                var sn = sny * ww + snx;
                if (sSeen[sn] || mask.part[sn] !== 2) continue;
                sSeen[sn] = 1; sq.push(sn); sc.push(sn);
              }
            }
          }
          for (var sci = 0; sci < sc.length; sci++) sSize[sc[sci]] = sc.length;
        }
        var bSeen = new Uint8Array(nn);
        var mismatch = 0, boots = 0;
        for (sp = 0; sp < nn; sp++) {
          if (bSeen[sp] || mask.part[sp] !== 3) continue;
          var bq = [sp]; bSeen[sp] = 1;
          var bc = [sp];
          for (var bqi = 0; bqi < bq.length; bqi++) {
            var bid = bq[bqi];
            var bx = bid % ww, by = (bid / ww) | 0;
            for (var bdy = -1; bdy <= 1; bdy++) {
              var bny = by + bdy; if (bny < 0 || bny >= hh) continue;
              for (var bdx = -1; bdx <= 1; bdx++) {
                if (!bdx && !bdy) continue;
                var bnx = bx + bdx; if (bnx < 0 || bnx >= ww) continue;
                var bn = bny * ww + bnx;
                if (bSeen[bn] || mask.part[bn] !== 3) continue;
                bSeen[bn] = 1; bq.push(bn); bc.push(bn);
              }
            }
          }
          if (bc.length < 400) continue;
          boots++;
          var stamp = new Uint8Array(nn);
          var fq = bc.slice();
          var fd = [];
          for (var fi = 0; fi < fq.length; fi++) { stamp[fq[fi]] = 1; fd.push(0); }
          var best = [0, 1e9, 1e9];
          var hits = [0, 0, 0];
          for (var fqi = 0; fqi < fq.length; fqi++) {
            var dist = fd[fqi];
            if (dist >= 84) continue;
            var fx = fq[fqi] % ww, fy = (fq[fqi] / ww) | 0;
            for (var fdy = -1; fdy <= 1; fdy++) {
              var fny = fy + fdy; if (fny < 0 || fny >= hh) continue;
              for (var fdx = -1; fdx <= 1; fdx++) {
                if (!fdx && !fdy) continue;
                var fnx = fx + fdx; if (fnx < 0 || fnx >= ww) continue;
                var fn = fny * ww + fnx;
                if (stamp[fn]) continue;
                var fp = mask.part[fn];
                var fc = mask.claim[fn];
                if (fp === 2 && fc && sSize[fn] >= 200) {
                  if (dist + 1 < best[fc]) best[fc] = dist + 1;
                  hits[fc]++;
                  stamp[fn] = 1;
                  continue;
                }
                if (fp === 3 || fp === 1 || (mask.keep && mask.keep[fn]) || (mask.ball && mask.ball[fn]) || (mask.sky && mask.sky[fn])) continue;
                var fo = fn * 4;
                var fr = base.data[fo], fg = base.data[fo + 1], fb = base.data[fo + 2], fa = base.data[fo + 3];
                if (fa < 128) continue;
                var ggrass = fg > fr + 8 && fg + 8 >= fb && fb < fg * 0.55 && fg > 55;
                var mx = Math.max(fr, fg, fb), mn = Math.min(fr, fg, fb);
                var white = mx > 210 && mx - mn < 28 && mn > 185;
                if (ggrass || white) continue;
                var body = fp === 4 || fp === 5 || fp === 6 || (mx < 70 && mx - mn < 28) || (fp === 2 && sSize[fn] < 200);
                if (!body) continue;
                stamp[fn] = 1;
                fq.push(fn);
                fd.push(dist + 1);
              }
            }
          }
          var side = mask.claim[sp];
          if (best[1] < 1e8 || best[2] < 1e8) {
            var want;
            if (best[1] + 8 < best[2]) want = 1;
            else if (best[2] + 8 < best[1]) want = 2;
            else if (hits[1] !== hits[2]) want = hits[1] > hits[2] ? 1 : 2;
            else want = best[1] <= best[2] ? 1 : 2;
            if (side !== want) mismatch++;
          }
        }
        ok(mismatch === 0, tag + ' 两只鞋跟球袜短裤一边', mismatch + '/' + boots);
      })();
      if (pose === 'gk_tip_over' && ci === 0) {
        var holes = 0;
        var hw = base.width;
        for (var hy = 180; hy < 640; hy++) {
          for (var hx = 120; hx < 520; hx++) {
            if (data[(hy * hw + hx) * 4 + 3] < 40) holes++;
          }
        }
        ok(holes < 800, tag + ' 倒地球门左侧网格不再透天', String(holes));
      }
      var keeperPose = /goal|gk_|hit_post|round_gk|shot_wide/.test(pose);
      if (keeperPose) ok(netN > 400 && netChanged === 0, tag + ' 球网和门柱像素没变', netChanged + '/' + netN);
    }
    ok(hairA.n < 40 || hairA.big <= 1, tag + ' A 头发只有一个色相', hairA.n + '/' + hairA.big);
    ok(hairB.n < 40 || hairB.big <= 1, tag + ' B 头发只有一个色相', hairB.n + '/' + hairB.big);
    ok(skinA.n < 40 || skinA.big <= 1, tag + ' A 皮肤只有一个色相', skinA.n + '/' + skinA.big);
    ok(skinB.n < 40 || skinB.big <= 1, tag + ' B 皮肤只有一个色相', skinB.n + '/' + skinB.big);
    ok(skinLA.total < 80 || skinLA.basePct >= 0.45, tag + ' A 皮肤底色还在', skinLA.basePct.toFixed(2));
    ok(skinLB.total < 80 || skinLB.basePct >= 0.45, tag + ' B 皮肤底色还在', skinLB.basePct.toFixed(2));
    // 墨线 3px 内的皮肤不能偏色，也不能比这块皮肤的中位色亮出 25%。源图本来更亮的高光除外。
    function skinInkEdge(side) {
      var ww = base.width, hh = base.height;
      var lums = [];
      var hues = [];
      var keyLum = (0.299 * 240 + 0.587 * 200 + 0.114 * 160) / 255;
      var i, o, hs, lum;
      for (i = 0; i < mask.claim.length; i++) {
        if (mask.claim[i] !== side || mask.part[i] !== 5) continue;
        o = i * 4;
        if (data[o + 3] < 200) continue;
        lum = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
        lums.push(lum);
        hs = hueSat(data[o], data[o + 1], data[o + 2]);
        if (hs.s >= 0.18) hues.push(hs.h);
      }
      if (lums.length < 40) return { bad: 0, n: 0 };
      lums.sort(function (a, b) { return a - b; });
      hues.sort(function (a, b) { return a - b; });
      var medL = lums[(lums.length / 2) | 0];
      var medH = hues.length ? hues[(hues.length / 2) | 0] : 0;
      var bad = 0, n = 0;
      function inkAt(id) {
        if (mask.part[id] === 6) return true;
        var z = id * 4;
        var r = base.data[z], g = base.data[z + 1], b = base.data[z + 2], a = base.data[z + 3];
        if (a < 80) return false;
        var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        return mx < 70 && (mx - mn) < 28;
      }
      for (i = 0; i < mask.claim.length; i++) {
        if (mask.claim[i] !== side || mask.part[i] !== 5) continue;
        var x = i % ww, y = (i / ww) | 0;
        var nearInk = false;
        var dy, dx;
        for (dy = -3; dy <= 3 && !nearInk; dy++) {
          var ny = y + dy; if (ny < 0 || ny >= hh) continue;
          for (dx = -3; dx <= 3; dx++) {
            if (!dx && !dy) continue;
            if (Math.max(Math.abs(dx), Math.abs(dy)) > 3) continue;
            var nx = x + dx; if (nx < 0 || nx >= ww) continue;
            if (inkAt(ny * ww + nx)) { nearInk = true; break; }
          }
        }
        if (!nearInk) continue;
        o = i * 4;
        if (data[o + 3] < 200) continue;
        n++;
        var srcLum = (0.299 * base.data[o] + 0.587 * base.data[o + 1] + 0.114 * base.data[o + 2]) / 255;
        lum = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
        if (srcLum > keyLum + 0.03) continue;
        hs = hueSat(data[o], data[o + 1], data[o + 2]);
        // 贴着墨线、已经收成黑色的像素没有稳定色相。
        if (lum < 0.06) continue;
        var dh = Math.abs(hs.h - medH);
        if (dh > 180) dh = 360 - dh;
        var hueBad = hues.length > 20 && hs.s > 0.18 && dh > 15;
        var lightBad = lum > medL * 1.25 + 0.02;
        if (hueBad || lightBad) bad++;
      }
      return { bad: bad, n: n };
    }
    var edgeA = skinInkEdge(1), edgeB = skinInkEdge(2);
    ok(edgeA.n < 30 || edgeA.bad <= 3, tag + ' A 墨线边皮肤不发白不偏色', edgeA.bad + '/' + edgeA.n);
    ok(edgeB.n < 30 || edgeB.bad <= 3, tag + ' B 墨线边皮肤不发白不偏色', edgeB.bad + '/' + edgeB.n);
    ok(bootWhite === 0, tag + ' 球鞋没有剩半块白', String(bootWhite));
    ok(bootA.n < 40 || bootA.pct >= 0.9, tag + ' A 球鞋九成是鞋的色相', bootA.pct.toFixed(2));
    ok(bootB.n < 40 || bootB.pct >= 0.9, tag + ' B 球鞋九成是鞋的色相', bootB.pct.toFixed(2));
    if (ci === 0) ok(hairComp.bad === 0, tag + ' 每块头发只有一个色相', hairComp.bad + '/' + hairComp.nComp);
    if (ci === 0) ok(skyBlob === 0, tag + ' 草皮线以上没有大块天空白', String(skyBlob));
    if (combo.aKit.pattern !== 'solid') ok(Object.keys(aSeen).length >= 2, tag + ' A 球衣铺了图案', Object.keys(aSeen).join('|'));
    if (combo.bKit.pattern !== 'solid') ok(Object.keys(bSeen).length >= 2, tag + ' B 球衣铺了图案', Object.keys(bSeen).join('|'));
    if (ci === 0 && pose === 'dribble_win') {
      ok(Object.keys(aSeen).length === 1, '默认主队球衣是纯色');
      ok(Object.keys(bSeen).length >= 2, '默认客队横条两种颜色都有');
    }
    var tw = 400;
    var th = Math.max(1, Math.round(tw * base.height / base.width));
    var stepX = base.width / tw, stepY = base.height / th;
    var thumb = Buffer.alloc(tw * th * 3);
    for (var y = 0; y < th; y++) {
      var sy = Math.min(base.height - 1, Math.floor(y * stepY));
      for (var x = 0; x < tw; x++) {
        var sx = Math.min(base.width - 1, Math.floor(x * stepX));
        var o = (sy * base.width + sx) * 4;
        var to = (y * tw + x) * 3;
        if (data[o + 3] < 128) {
          var u = sy / base.height;
          thumb[to] = Math.round(126 + (231 - 126) * u);
          thumb[to + 1] = Math.round(183 + (243 - 183) * u);
          thumb[to + 2] = Math.round(230 + (224 - 230) * u);
        } else {
          thumb[to] = data[o]; thumb[to + 1] = data[o + 1]; thumb[to + 2] = data[o + 2];
        }
      }
    }
    thumbs.push({ pose: pose, combo: combo.name, w: tw, h: th, rgb: thumb.toString('base64') });
  });
  if (pose === 'dribble_win') {
    var data0 = new Uint8ClampedArray(base.data);
    kits.paintMangaLabels({ width: base.width, height: base.height, data: data0 }, map, combos[0].a, combos[0].b);
    var crotch = (526 * base.width + 750) * 4;
    ok(data0[crotch + 3] === 0, '突破图腿间的白天空被抠掉', String(data0[crotch + 3]));
    ok(mask.ball && mask.ball.some(function (v) { return v; }), '突破图认出了皮球');
  }
  if (pose === 'goal') {
    var net = (400 * base.width + 300) * 4;
    ok(base.data[net + 3] > 200 && nearWhite(base.data[net], base.data[net + 1], base.data[net + 2]), '进球图的网本来是白的');
    var paintedNet = new Uint8ClampedArray(base.data);
    kits.paintMangaLabels({ width: base.width, height: base.height, data: paintedNet }, map, combos[0].a, combos[0].b);
    var keptNet = paintedNet[net + 3] > 200 && nearWhite(paintedNet[net], paintedNet[net + 1], paintedNet[net + 2]);
    ok(keptNet, '进球图的球网没有被抠掉');
  }
  if (pose === 'def_sweep') {
    var kept = 0;
    var srcData = base.data;
    for (var s = 0; s < srcData.length; s += 4) {
      var r = srcData[s], g = srcData[s + 1], b = srcData[s + 2], a = srcData[s + 3];
      if (a > 200 && nearWhite(r, g, b) && !mask.claim[s / 4]) kept++;
    }
    ok(kept > 20000, '横扫的白月牙留在草地上', String(kept));
  }
});

var sheetDir = '/opt/cursor/artifacts';
fs.mkdirSync(sheetDir, { recursive: true });
var sheetJson = path.join(sheetDir, 'manga-recolor-thumbs.json');
fs.writeFileSync(sheetJson, JSON.stringify(thumbs.map(function (t) {
  return { pose: t.pose, combo: t.combo, w: t.w, h: t.h, rgb: t.rgb };
})));
execFileSync('python3', ['-c', [
  'import json, base64',
  'from PIL import Image, ImageDraw',
  'thumbs=json.load(open("' + sheetJson + '"))',
  'cols=["默认","斜带","横条"]',
  'poses=[]',
  'for t in thumbs:',
  '    if t["pose"] not in poses: poses.append(t["pose"])',
  'cell=thumbs[0]',
  'cw,ch=cell["w"],cell["h"]',
  'pad,lab=8,150',
  'W=lab+len(cols)*(cw+pad)+pad',
  'H=lab+len(poses)*(ch+pad)+pad',
  'im=Image.new("RGB",(W,H),(12,16,28))',
  'dr=ImageDraw.Draw(im)',
  'for i,c in enumerate(cols):',
  '    dr.text((lab+i*(cw+pad), 8), c, fill=(255,220,120))',
  'lookup={(t["pose"],t["combo"]):t for t in thumbs}',
  'for r,pose in enumerate(poses):',
  '    dr.text((4, lab+r*(ch+pad)+8), pose, fill=(180,200,230))',
  '    for i,c in enumerate(cols):',
  '        t=lookup[(pose,c)]',
  '        raw=base64.b64decode(t["rgb"])',
  '        tile=Image.frombytes("RGB",(t["w"],t["h"]),raw)',
  '        im.paste(tile,(lab+i*(cw+pad), lab+r*(ch+pad)))',
  'im.save("/opt/cursor/artifacts/manga-recolor-contact.png")',
  'print("sheet", im.size)',
].join('\n')]);

console.log(failed ? ('\n' + failed + ' FAILED') : '\nALL MANGA RECOLOR TESTS PASSED');
process.exit(failed ? 1 : 0);
