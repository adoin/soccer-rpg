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
