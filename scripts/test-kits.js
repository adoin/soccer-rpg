// scripts/test-kits.js
// 球衣图案、球鞋占位符、短裤球袜和肤色互不覆盖。
'use strict';

var kits = require('../shared/kits');
var teams = require('../shared/teams');

var failed = 0;
function eq(name, cond) {
  if (cond) console.log('  PASS ' + name);
  else { console.log('  FAIL ' + name); failed++; }
}

function img(w, h, paint) {
  var data = new Uint8ClampedArray(w * h * 4);
  var o = { data: data, width: w, height: h };
  paint(function (x, y, r, g, b, a) {
    var i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a == null ? 255 : a;
  });
  return o;
}
function px(im, x, y) {
  var i = (y * im.width + x) * 4;
  return [im.data[i], im.data[i + 1], im.data[i + 2], im.data[i + 3]];
}

// 48×72 一格：脸在上方（皮肤+黑眼），球衣品红，短裤青，球袜黄，鞋是贴着袜的深色。
var cell = img(48, 72, function (set) {
  var x, y;
  for (y = 8; y < 18; y++) for (x = 18; x < 30; x++) set(x, y, 254, 210, 172);
  set(20, 12, 0, 0, 0); set(21, 12, 0, 0, 0);
  set(26, 12, 0, 0, 0); set(27, 12, 0, 0, 0);
  for (y = 20; y < 36; y++) for (x = 16; x < 32; x++) set(x, y, 255, 0, 255);
  for (y = 36; y < 46; y++) for (x = 18; x < 30; x++) set(x, y, 0, 255, 255);
  for (y = 46; y < 54; y++) for (x = 20; x < 28; x++) set(x, y, 255, 255, 0);
  for (y = 54; y < 62; y++) for (x = 20; x < 28; x++) set(x, y, 20, 20, 20);
});

kits.markShoePlaceholders(cell, 48, 72);
eq('鞋被标成 #FF0088', px(cell, 22, 58)[0] === 255 && px(cell, 22, 58)[1] === 0 && px(cell, 22, 58)[2] === 136);
eq('眼睛仍是黑的', px(cell, 20, 12)[0] === 0 && px(cell, 20, 12)[1] === 0 && px(cell, 20, 12)[2] === 0);
eq('脸的皮肤没被标成鞋', px(cell, 22, 10)[0] === 254);

var spec = kits.resolveKit('home', { pattern: 'stripes', primary: '#0033cc', secondary: '#f4f4f4', shoes: '#e6c34a' });
eq('球员覆盖图案，短裤沿用球队', spec.pattern === 'stripes' && spec.shorts === kits.TEAM_COLORS.home.shorts && spec.shoes === '#e6c34a');
eq('未知图案退回纯色', kits.resolveKit('home', { pattern: 'plaid' }).pattern === 'solid');
eq('客队默认是横条', kits.resolveKit('away', null).pattern === 'hoops');

kits.recolorImageData(cell, { home: spec }, 32, { cellW: 48, cellH: 72, pattern: spec.pattern });
var j1 = px(cell, 16, 22), j2 = px(cell, 18, 22);
eq('竖条两种颜色都出现', j1[0] !== j2[0] || j1[2] !== j2[2]);
var shorts = px(cell, 20, 40);
eq('短裤不再是青色，变成蓝色', shorts[2] > shorts[0] && shorts[2] > shorts[1] && shorts[1] < 200);
eq('球袜跟着主色', px(cell, 22, 48)[2] > px(cell, 22, 48)[0]);
var shoe = px(cell, 22, 58);
eq('鞋是金色而不是黑或皮肤', shoe[0] > 160 && shoe[1] > 120 && shoe[2] < 100);
eq('眼睛换色后仍是黑的', px(cell, 21, 12)[0] < 5 && px(cell, 21, 12)[1] < 5);

kits.recolorSkin(cell, 'deep');
var face = px(cell, 22, 10);
eq('深肤落在脸上', face[0] < 140 && face[1] < 90 && face[0] > face[2]);
eq('深肤没有把眼睛涂掉', px(cell, 20, 12)[0] < 5);
eq('深肤没有把鞋涂掉', px(cell, 22, 58)[0] > 160);

// 斜带、横条、左右分色至少会用到副色
['sash', 'hoops', 'halves'].forEach(function (pat) {
  var c = img(48, 72, function (set) {
    var x, y;
    for (y = 20; y < 40; y++) for (x = 10; x < 38; x++) set(x, y, 255, 0, 255);
  });
  var s = kits.resolveKit('home', { pattern: pat, primary: '#111111', secondary: '#f4f4f4' });
  kits.recolorImageData(c, { home: s }, 0, { cellW: 48, cellH: 72, pattern: pat });
  var seenDark = false, seenLight = false;
  for (var y = 20; y < 40; y++) for (var x = 10; x < 38; x++) {
    var p = px(c, x, y);
    if (p[0] < 80) seenDark = true;
    if (p[0] > 180) seenLight = true;
  }
  eq(pat + ' 同时有主色和副色', seenDark && seenLight);
});

var made = teams.makeTeams();
eq('10 号是斜带金鞋', made.home[9] && made.home.filter(function (p) { return p.num === 10; })[0].kit.pattern === 'sash');
eq('没有单独配置的球员 kit 为空', made.home.filter(function (p) { return p.num === 3; })[0].kit === null);

if (failed) {
  console.log('\n' + failed + ' FAILED');
  process.exit(1);
}
console.log('\nALL KIT TESTS PASSED');
