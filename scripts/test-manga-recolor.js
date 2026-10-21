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
    for (var p = 0; p < data.length; p += 4) {
      var px = [data[p], data[p + 1], data[p + 2]];
      var idx = p / 4;
      for (var k = 0; k < KEYS.length; k++) if (same(px, KEYS[k])) keys++;
      var claim = mask.claim[idx];
      var part = mask.part[idx];
      if (part === 1 && claim === 1) {
        jerseyA++;
        var hitA = same(px, aColors[0]) || same(px, aColors[1]);
        if (!hitA) badA++;
        else aSeen[px.join(',')] = 1;
      } else if (part === 1 && claim === 2) {
        jerseyB++;
        var hitB = same(px, bColors[0]) || same(px, bColors[1]);
        if (!hitB) badB++;
        else bSeen[px.join(',')] = 1;
      } else if (part === 2 && claim === 1 && !same(px, aShort)) badAS++;
      else if (part === 2 && claim === 2 && !same(px, bShort)) badBS++;
      else if (part === 3 && claim === 1 && !same(px, aShoe)) badA++;
      else if (part === 3 && claim === 2 && !same(px, bShoe)) badB++;
      if (claim && part && part !== 6 && nearWhite(px[0], px[1], px[2])) {
        var allowed = aColors.concat(bColors, [aShort, bShort, aShoe, bShoe]).some(function (c) { return same(px, c); });
        if (!allowed) stray++;
      }
    }
    var tag = pose + '/' + combo.name;
    ok(keys === 0, tag + ' 没有剩余色键', String(keys));
    ok(badA === 0 && badB === 0, tag + ' 球衣鞋是本人的颜色', badA + '/' + badB);
    ok(badAS === 0 && badBS === 0, tag + ' 短裤球袜是本人的颜色', badAS + '/' + badBS);
    ok(stray === 0, tag + ' 人里面没有多余的白', String(stray));
    if (combo.aKit.pattern !== 'solid') ok(Object.keys(aSeen).length >= 2, tag + ' A 球衣铺了图案', Object.keys(aSeen).join('|'));
    if (combo.bKit.pattern !== 'solid') ok(Object.keys(bSeen).length >= 2, tag + ' B 球衣铺了图案', Object.keys(bSeen).join('|'));
    if (ci === 0 && pose === 'dribble_win') {
      ok(Object.keys(aSeen).length === 1, '默认主队球衣是纯色');
      ok(Object.keys(bSeen).length >= 2, '默认客队横条两种颜色都有');
    }
    var step = 8;
    var tw = Math.floor(base.width / step), th = Math.floor(base.height / step);
    var thumb = Buffer.alloc(tw * th * 3);
    for (var y = 0; y < th; y++) {
      for (var x = 0; x < tw; x++) {
        var o = ((y * step) * base.width + (x * step)) * 4;
        var to = (y * tw + x) * 3;
        thumb[to] = data[o]; thumb[to + 1] = data[o + 1]; thumb[to + 2] = data[o + 2];
      }
    }
    thumbs.push({ pose: pose, combo: combo.name, w: tw, h: th, rgb: thumb.toString('base64') });
  });
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
  'pad,lab=8,36',
  'W=lab+len(cols)*(cw+pad)+pad',
  'H=lab+len(poses)*(ch+pad)+pad',
  'im=Image.new("RGB",(W,H),(12,16,28))',
  'dr=ImageDraw.Draw(im)',
  'for i,c in enumerate(cols):',
  '    dr.text((lab+i*(cw+pad), 8), c, fill=(255,220,120))',
  'lookup={(t["pose"],t["combo"]):t for t in thumbs}',
  'for r,pose in enumerate(poses):',
  '    dr.text((4, lab+r*(ch+pad)+ch/2-6), pose[:10], fill=(180,200,230))',
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
