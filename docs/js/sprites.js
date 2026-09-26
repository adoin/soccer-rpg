// client/js/sprites.js
// 程序化像素精灵：所有角色/足球均由代码逐像素绘制，不依赖外部素材。
// 精灵绘制在离屏 canvas 上，渲染时关闭平滑以保持像素风。
(function (root) {
  'use strict';

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function px(g, x, y, w, h, color) {
    g.fillStyle = color;
    g.fillRect(x | 0, y | 0, w, h);
  }

  // 绘制 16x24 的 Q 版球员。frame: 0/1 两帧跑动动画。
  function drawPlayer(g, frame, o) {
    var shirt = o.shirt, shorts = o.shorts || '#f2f2f2',
        skin = o.skin || '#f2c89b', hair = o.hair || '#2b2b33',
        shoes = '#22222a', socks = o.socks || '#ffffff';

    // 头发
    px(g, 4, 0, 8, 3, hair);
    px(g, 3, 1, 2, 4, hair);
    px(g, 11, 1, 2, 4, hair);
    px(g, 5, 3, 6, 1, hair);
    // 脸
    px(g, 5, 4, 6, 5, skin);
    px(g, 4, 5, 1, 3, skin);
    px(g, 11, 5, 1, 3, skin);
    // 眼睛
    px(g, 6, 6, 1, 2, '#1a1a22');
    px(g, 9, 6, 1, 2, '#1a1a22');
    // 身体（球衣）
    px(g, 4, 9, 8, 7, shirt);
    px(g, 5, 9, 6, 1, shade(shirt, -25)); // 衣领阴影
    px(g, 7, 11, 2, 3, 'rgba(255,255,255,0.85)'); // 号码位
    // 手臂
    px(g, 2, 10, 2, 4, shirt);
    px(g, 12, 10, 2, 4, shirt);
    px(g, 2, 14, 2, 2, skin);
    px(g, 12, 14, 2, 2, skin);
    // 短裤
    px(g, 5, 16, 6, 3, shorts);
    // 腿（两帧）
    if (frame === 0) {
      px(g, 5, 19, 2, 3, socks); px(g, 5, 22, 2, 2, shoes);
      px(g, 9, 19, 2, 3, socks); px(g, 9, 22, 2, 2, shoes);
    } else {
      px(g, 4, 19, 2, 2, socks); px(g, 3, 21, 3, 3, shoes);
      px(g, 10, 19, 2, 2, socks); px(g, 10, 21, 3, 3, shoes);
    }
  }

  // 简单的颜色加深/提亮
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16) + amt));
    var g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
    var b = Math.max(0, Math.min(255, (n & 0xff) + amt));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // 生成某套球衣的两帧精灵
  function playerFrames(o) {
    var frames = [];
    for (var f = 0; f < 2; f++) {
      var c = makeCanvas(16, 24);
      drawPlayer(c.getContext('2d'), f, o);
      frames.push(c);
    }
    return frames;
  }

  // 足球 8x8
  function ballSprite() {
    var c = makeCanvas(8, 8), g = c.getContext('2d');
    px(g, 2, 0, 4, 8, '#f4f4f4');
    px(g, 0, 2, 8, 4, '#f4f4f4');
    px(g, 1, 1, 2, 2, '#f4f4f4'); px(g, 5, 1, 2, 2, '#f4f4f4');
    px(g, 1, 5, 2, 2, '#f4f4f4'); px(g, 5, 5, 2, 2, '#f4f4f4');
    px(g, 3, 3, 2, 2, '#22222a');
    px(g, 3, 0, 2, 1, '#22222a'); px(g, 3, 7, 2, 1, '#22222a');
    return c;
  }

  // 头像：用球员精灵放大绘制（像素风）
  function portrait(frames) {
    return frames[0];
  }

  root.Sprites = {
    makeCanvas: makeCanvas,
    playerFrames: playerFrames,
    ballSprite: ballSprite,
    portrait: portrait,
    shade: shade,
  };
})(window);
