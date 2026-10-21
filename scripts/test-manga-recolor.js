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
  var mask = kits.prepareMangaMask(base);
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
    kits.paintManga(img, mask, combo.a, combo.b);
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
        var hitA = matchesTone(px, aColors[0]) || matchesTone(px, aColors[1]);
        if (!hitA) badA++;
        else if (same(px, aColors[0]) || same(px, aColors[1])) aSeen[px.join(',')] = 1;
      } else if (part === 1 && claim === 2) {
        jerseyB++;
        var hitB = matchesTone(px, bColors[0]) || matchesTone(px, bColors[1]);
        if (!hitB) badB++;
        else if (same(px, bColors[0]) || same(px, bColors[1])) bSeen[px.join(',')] = 1;
      } else if (part === 2 && claim === 1 && !matchesTone(px, aShort)) badAS++;
      else if (part === 2 && claim === 2 && !matchesTone(px, bShort)) badBS++;
      else if (part === 3 && claim === 1 && !nearScale(px, aShoe)) badA++;
      else if (part === 3 && claim === 2 && !nearScale(px, bShoe)) badB++;
      if (claim && part && part !== 6 && data[p + 3] > 200 && nearWhite(px[0], px[1], px[2])) {
        var allowed = aColors.concat(bColors, [aShort, bShort, aShoe, bShoe]).some(function (c) { return same(px, c); });
        if (!allowed) stray++;
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
        if ((mask.ball && mask.ball[sp]) || mask.claim[sp]) { seenW[sp] = 1; continue; }
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
            if (data[no + 3] >= 200 && nearWhite(data[no], data[no + 1], data[no + 2]) && !(mask.ball && mask.ball[nid]) && !mask.claim[nid]) {
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
    ok(hairA.n < 40 || hairA.big <= 1, tag + ' A 头发只有一个色相', hairA.n + '/' + hairA.big);
    ok(hairB.n < 40 || hairB.big <= 1, tag + ' B 头发只有一个色相', hairB.n + '/' + hairB.big);
    ok(skinA.n < 40 || skinA.big <= 1, tag + ' A 皮肤只有一个色相', skinA.n + '/' + skinA.big);
    ok(skinB.n < 40 || skinB.big <= 1, tag + ' B 皮肤只有一个色相', skinB.n + '/' + skinB.big);
    ok(skinLA.total < 80 || skinLA.basePct >= 0.6, tag + ' A 皮肤底色占六成', skinLA.basePct.toFixed(2));
    ok(skinLB.total < 80 || skinLB.basePct >= 0.6, tag + ' B 皮肤底色占六成', skinLB.basePct.toFixed(2));
    ok(skinLA.total < 80 || skinLA.ratio >= 0.75, tag + ' A 皮肤明暗比', skinLA.ratio.toFixed(2));
    ok(skinLB.total < 80 || skinLB.ratio >= 0.75, tag + ' B 皮肤明暗比', skinLB.ratio.toFixed(2));
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
    kits.paintManga({ width: base.width, height: base.height, data: data0 }, mask, combos[0].a, combos[0].b);
    var crotch = (526 * base.width + 750) * 4;
    ok(data0[crotch + 3] === 0, '突破图腿间的白天空被抠掉', String(data0[crotch + 3]));
    ok(mask.ball && mask.ball.some(function (v) { return v; }), '突破图认出了皮球');
  }
  if (pose === 'goal') {
    var net = (400 * base.width + 300) * 4;
    ok(base.data[net + 3] > 200 && nearWhite(base.data[net], base.data[net + 1], base.data[net + 2]), '进球图的网本来是白的');
    var paintedNet = new Uint8ClampedArray(base.data);
    kits.paintManga({ width: base.width, height: base.height, data: paintedNet }, mask, combos[0].a, combos[0].b);
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
