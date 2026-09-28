// js/api-local.js（构建产物，不要手改）
// 纯前端试玩版：把原来发往 /api/* 的请求直接转给跑在页面里的引擎实例。
// 接口形状与 server/index.js 的 REST 接口保持一致。
(function () {
'use strict';

var matches = {};

function newId() {
  var h = '0123456789abcdef', s = '';
  for (var i = 0; i < 16; i++) s += h[(Math.random() * 16) | 0];
  return s;
}

function getMatch(id) { return matches[id] || null; }

// ★ debug 摆拍场景：同步布阵→开球→跑完关键 tick→冻结，返回关键信息供 toast/截图核对
function debugScene(m, name) {
  function setup() {
    m.players.forEach(function(p){ if(p.pos !== 'GK'){ p.x = (p.team === 'home' ? 15 : 90); p.y = 34; p.vx = 0; p.vy = 0; } });
    var hp = m.byId['h10'], dp = m.byId['a4'];
    hp.x = 50; hp.y = 34; dp.x = (name === '2' ? 60 : 52.5); dp.y = 34; // 高球越过:人摆线路中段
    m.ball.ownerId = 'h10'; m.ball.x = 50; m.ball.y = 34; m.ball.z = 0; m.ball.vx = 0; m.ball.vy = 0;
    m.phase = 'play'; m.decision = null;
  }
  var info = { scene: name };
  m.setPaused(false);
  if (name === '1' || name === '2') {
    setup();
    m.startPassFlight(m.byId['h10'], { x1: 70, y1: 34, durMs: name === '1' ? 600 : 700, height: name === '1' ? 'low' : 'high', receiverId: null });
    var n = 0; while (m.phase === 'passflight' && n < 20) { m.tick(); n++; }
    info.ticks = n; info.owner = m.ball.ownerId; info.bx = +m.ball.x.toFixed(1); info.by = +m.ball.y.toFixed(1);
  } else if (name === '3') {
    setup();
    m.startPassFlight(m.byId['h10'], { x1: 80, y1: 34, durMs: 1300, height: 'vhigh', receiverId: null });
    for (var i = 0; i < 6; i++) m.tick();
    info.z = +m.ball.z.toFixed(2); info.bx = +m.ball.x.toFixed(1); info.phase = m.phase;
  } else {
    setup();
    var tries = 0;
    while (tries < 20) {
      m.startPassFlight(m.byId['h10'], { x1: 70, y1: 34, durMs: 600, height: 'low', receiverId: null });
      var n2 = 0; while (m.phase === 'passflight' && n2 < 20) { m.tick(); n2++; }
      tries++;
      if (!m.ball.ownerId) break;
    }
    info.tries = tries; info.free = !m.ball.ownerId;
    for (var j = 0; j < 20; j++) { m.tick(); if (m.ball.ownerId) break; }
    info.chased = m.ball.ownerId; info.bx = +m.ball.x.toFixed(1);
  }
  m.setPaused(true);
  return info;
}

  if (/[?&]debug=1/.test(location.search)) { window.__getMatch = getMatch; window.__matches = matches; }

window.__makeLocalApi = function () {
  var Match = window.SoccerEngine.Match;
  return {
    post: function (url, body) {
      body = body || {};
      var m;
      if (url === '/api/match') {
        var halfLength = parseInt(body.halfLength, 10);
        if (!(halfLength >= 30 && halfLength <= 1200)) halfLength = 180;
        var id = newId();
        matches[id] = new Match(id, { halfLength: halfLength, mentality: body.mentality || 'balanced' });
        return Promise.resolve({ ok: true, matchId: id });
      }
      m = url.match(/^\/api\/match\/([^\/]+)\/command$/);
      if (m) {
        var mm = getMatch(m[1]);
        if (!mm || !mm.decision) return Promise.resolve({ ok: false, error: '当前不需要做决策' });
        return Promise.resolve(mm.applyCommand(mm.decision.playerId, body.commandId, body.params));
      }
      m = url.match(/^\/api\/match\/([^\/]+)\/pass-preview$/);
      if (m) {
        var pm = getMatch(m[1]);
        if (!pm || !pm.decision) return Promise.resolve({ ok: false, error: '当前不需要做决策' });
        return Promise.resolve(pm.passPreview(pm.decision.playerId, body.params));
      }
      m = url.match(/^\/api\/match\/([^\/]+)\/pause$/);
      if (m) {
        var mm2 = getMatch(m[1]);
        if (mm2) mm2.setPaused(!!body.paused);
        return Promise.resolve({ ok: true, paused: !!body.paused });
      }
      m = url.match(/^\/api\/match\/([^\/]+)\/mentality$/);
      if (m) {
        var mm3 = getMatch(m[1]);
        if (mm3) mm3.setMentality(body.mentality);
        return Promise.resolve({ ok: true, mentality: body.mentality });
      }
      m = url.match(/^\/api\/match\/([^\/]+)\/input$/);
      if (m) {
        var mm4 = getMatch(m[1]);
        if (mm4) return Promise.resolve(mm4.setInput(body));
        return Promise.resolve({ ok: false, error: '比赛不存在或已结束' });
      }
      if (url === '/api/debug/scene') {
        if (!/[?&]debug=1/.test(location.search)) return Promise.resolve({ ok: false, error: 'not in debug' });
        var dm = getMatch(body.matchId) || (function(){ for (var k in matches) return matches[k]; return null; })();
        if (!dm) return Promise.resolve({ ok: false, error: '无比赛' });
        var sinfo = debugScene(dm, String(body.scene || '1'));
        return Promise.resolve({ ok: true, info: sinfo });
      }
      return Promise.resolve({ ok: false, error: 'unknown api: ' + url });
    },
    get: function (url) {
      var m = url.match(/^\/api\/match\/([^\/]+)\/state$/);
      if (m) {
        var mm = getMatch(m[1]);
        if (!mm) return Promise.resolve({ ok: false, error: '比赛不存在或已结束' });
        return Promise.resolve({ ok: true, state: mm.serialize() });
      }
      return Promise.resolve({ ok: false, error: 'unknown api: ' + url });
    },
    del: function (url) {
      var m = url.match(/^\/api\/match\/([^\/]+)$/);
      if (m) {
        var mm = getMatch(m[1]);
        if (mm) { mm.destroy(); delete matches[m[1]]; }
      }
      return Promise.resolve({ ok: true });
    }
  };
};
})();
