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
eq('没写球袜时跟着短裤', spec.socks === spec.shorts && spec.shorts === kits.TEAM_COLORS.home.shorts);
eq('客队默认球袜等于短裤', kits.TEAM_COLORS.away.socks === kits.TEAM_COLORS.away.shorts);
eq('球袜跟着短裤', px(cell, 22, 48)[2] > px(cell, 22, 48)[0]);
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

// 预计算的占位蒙版必须和逐像素换色得出同一张图，包括容差内的近色。
(function () {
  function paintCell(set) {
    var x, y;
    for (y = 8; y < 18; y++) for (x = 18; x < 30; x++) set(x, y, 254, 210, 172);
    set(20, 12, 0, 0, 0);
    for (y = 20; y < 36; y++) for (x = 16; x < 32; x++) set(x, y, x === 16 ? 250 : 255, x === 16 ? 8 : 0, 255);
    for (y = 36; y < 46; y++) for (x = 18; x < 30; x++) set(x, y, 0, 255, 255);
    for (y = 46; y < 54; y++) for (x = 20; x < 28; x++) set(x, y, 255, 255, 0);
    for (y = 54; y < 62; y++) for (x = 20; x < 28; x++) set(x, y, 255, 0, 136);
    set(4, 4, 255, 136, 0);
  }
  var a = img(48, 72, paintCell);
  var b = img(48, 72, paintCell);
  var spec2 = kits.resolveKit('home', { pattern: 'sash', primary: '#f2f2f2', secondary: '#1d3f8f', shoes: '#e6c34a' });
  var opts = { cellW: 48, cellH: 72, pattern: 'sash' };
  kits.recolorImageData(a, { home: spec2 }, 32, opts);
  var mask = kits.classifyPlaceholders(b, 32);
  var centers = kits.sheetCenters(mask, 48, 72, 48, 72);
  kits.recolorImageData(b, { home: spec2 }, 32, {
    cellW: 48, cellH: 72, pattern: 'sash', mask: mask, centers: centers,
  });
  var same = true;
  for (var i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) { same = false; break; }
  eq('蒙版换色和逐像素换色一致', same);
  eq('容差内的近品红进了蒙版', mask[(22 * 48) + 16] === 1);
})();

// 漫画色键：换色之后画面上不能再留下占位色。鞋和头发两边各换各的。
(function () {
  var keys = [
    [255, 0, 255], [0, 255, 255], [255, 136, 0], [136, 0, 255],
    [255, 0, 136], [0, 0, 255], [240, 200, 160], [255, 255, 0], [0, 255, 136],
  ];
  var shot = img(72, 40, function (set) {
    var x, y;
    for (y = 0; y < 40; y++) for (x = 0; x < 72; x++) set(x, y, 40, 140, 40);
    set(1, 36, 250, 250, 250);
    set(3, 36, 0, 0, 0);
    for (y = 8; y < 20; y++) for (x = 4; x < 18; x++) set(x, y, 255, 0, 255);
    for (y = 20; y < 26; y++) for (x = 6; x < 16; x++) set(x, y, 0, 255, 255);
    for (y = 30; y < 35; y++) for (x = 8; x < 13; x++) set(x, y, 255, 0, 136);
    for (y = 2; y < 6; y++) for (x = 6; x < 14; x++) set(x, y, 0, 0, 255);
    set(16, 4, 240, 200, 160);
    set(18, 12, 248, 6, 250);
    set(20, 22, 255, 255, 0);
    for (y = 8; y < 20; y++) for (x = 48; x < 64; x++) set(x, y, 255, 136, 0);
    for (y = 20; y < 26; y++) for (x = 50; x < 62; x++) set(x, y, 136, 0, 255);
    for (y = 30; y < 35; y++) for (x = 52; x < 58; x++) set(x, y, 255, 0, 136);
    for (y = 2; y < 6; y++) for (x = 50; x < 60; x++) set(x, y, 0, 0, 255);
    set(64, 4, 240, 200, 160);
    set(46, 22, 0, 255, 136);
  });
  kits.recolorManga(shot, {
    team: 'home', skin: 'deep', hair: 'blonde', kit: { shoes: '#2030c0' },
  }, {
    team: 'away', skin: 'tan', hair: 'auburn', kit: { shoes: '#c0a020' },
  });
  var leftKey = 0, x, y;
  for (y = 0; y < 40; y++) for (x = 0; x < 72; x++) {
    var p = px(shot, x, y);
    for (var ki = 0; ki < keys.length; ki++) {
      if (p[0] === keys[ki][0] && p[1] === keys[ki][1] && p[2] === keys[ki][2]) leftKey++;
    }
  }
  eq('换色后没有剩余色键', leftKey === 0);
  var g = px(shot, 0, 0), chalk = px(shot, 1, 36), ink = px(shot, 3, 36);
  eq('草地没有被换色', g[0] === 40 && g[1] === 140 && g[2] === 40);
  eq('白线没有被换色', chalk[0] === 250 && chalk[1] === 250 && chalk[2] === 250);
  eq('墨线没有被换色', ink[0] === 0 && ink[1] === 0 && ink[2] === 0);
  var bootA = px(shot, 10, 32), bootB = px(shot, 54, 32);
  var hairA = px(shot, 8, 3), hairB = px(shot, 54, 3);
  var skinA = px(shot, 16, 4), skinB = px(shot, 64, 4);
  eq('两边球鞋颜色不同', bootA[0] !== bootB[0] || bootA[1] !== bootB[1] || bootA[2] !== bootB[2]);
  eq('两边头发颜色不同', hairA[0] !== hairB[0] || hairA[1] !== hairB[1]);
  eq('两边肤色不同', skinA[0] !== skinB[0] || skinA[1] !== skinB[1]);
  eq('近品红也被换掉', px(shot, 18, 12)[0] !== 248 || px(shot, 18, 12)[2] !== 250);
})();

// 黑球衣：色键描边外的 JPG 光晕要收成部位色或墨线，不能留一圈红/品红。
(function () {
  var halo = img(22, 16, function (set) {
    var x, y;
    for (y = 0; y < 16; y++) for (x = 0; x < 22; x++) set(x, y, 40, 140, 40);
    set(1, 1, 250, 250, 250);
    set(1, 2, 0, 0, 0);
    set(20, 2, 210, 40, 30);
    set(18, 8, 120, 20, 40);
    for (y = 5; y <= 11; y++) for (x = 5; x <= 13; x++) set(x, y, 0, 0, 0);
    for (y = 6; y <= 10; y++) for (x = 6; x <= 12; x++) set(x, y, 255, 0, 255);
    set(9, 8, 119, 0, 56);
    set(8, 8, 67, 0, 9);
    set(6, 7, 180, 40, 80);
    set(6, 8, 120, 20, 40);
    set(6, 9, 120, 20, 40);
    set(5, 8, 33, 0, 11);
    for (y = 13; y <= 15; y++) for (x = 6; x <= 12; x++) set(x, y, 0, 255, 255);
    set(6, 13, 0, 70, 90);
    set(5, 14, 8, 18, 26);
  });
  var black = { pattern: 'solid', primary: '#111111', secondary: '#111111', shorts: '#111111', shoes: '#111111' };
  kits.recolorManga(halo, { team: 'home', kit: black }, { team: 'away', kit: black });
  function flatDark(p) { return p[0] < 40 && p[1] < 40 && p[2] < 40; }
  eq('球衣内部品红孔收成黑', flatDark(px(halo, 9, 8)) && flatDark(px(halo, 8, 8)));
  eq('球衣左侧红边收成黑或墨线', flatDark(px(halo, 6, 7)) && flatDark(px(halo, 6, 8)) && flatDark(px(halo, 6, 9)));
  eq('描边溢色收成墨线', flatDark(px(halo, 5, 8)));
  eq('短裤青边收成黑或墨线', flatDark(px(halo, 6, 13)) && flatDark(px(halo, 5, 14)));
  eq('草地没被黑球衣吃掉', px(halo, 0, 0)[0] === 40 && px(halo, 0, 0)[1] === 140 && px(halo, 14, 14)[1] === 140);
  eq('白线还在', px(halo, 1, 1)[0] === 250);
  eq('原有墨线还是黑的', px(halo, 1, 2)[0] === 0 && px(halo, 1, 2)[1] === 0);
  eq('没挨着色块的红球还是红的', px(halo, 20, 2)[0] === 210 && px(halo, 20, 2)[1] === 40);
  eq('孤立的红边不会自己变色', px(halo, 18, 8)[0] === 120 && px(halo, 18, 8)[1] === 20);

  var blue = img(16, 12, function (set) {
    var x, y;
    for (y = 0; y < 12; y++) for (x = 0; x < 16; x++) set(x, y, 40, 140, 40);
    for (y = 3; y <= 8; y++) for (x = 3; x <= 10; x++) set(x, y, 0, 0, 0);
    for (y = 4; y <= 7; y++) for (x = 4; x <= 9; x++) set(x, y, 255, 0, 255);
    set(4, 5, 120, 20, 40);
    set(3, 5, 30, 0, 12);
  });
  kits.recolorManga(blue, {
    team: 'home', kit: { primary: '#2244cc', shorts: '#2244cc', shoes: '#222222' },
  }, { team: 'away' });
  var fringe = px(blue, 4, 5), cast = px(blue, 3, 5);
  eq('蓝球衣把红边收成球衣色', fringe[2] > fringe[0] + 20 && fringe[0] < 80);
  eq('蓝球衣的描边溢色收成墨线', cast[0] < 20 && cast[1] < 20 && cast[2] < 20);
})();

var made = teams.makeTeams();
eq('10 号是斜带金鞋', made.home[9] && made.home.filter(function (p) { return p.num === 10; })[0].kit.pattern === 'sash');
eq('没有单独配置的球员 kit 为空', made.home.filter(function (p) { return p.num === 3; })[0].kit === null);
eq('球员带发型预设', made.home.filter(function (p) { return p.num === 10; })[0].hair === 'blonde');

if (failed) {
  console.log('\n' + failed + ' FAILED');
  process.exit(1);
}
console.log('\nALL KIT TESTS PASSED');
