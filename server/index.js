// server/index.js
// HTTP 服务器：Express 对外提供 REST 接口 + 托管客户端静态文件。
//
// 接口一览（通信方式：REST 轮询，保持简单可靠）：
//   POST /api/match                 创建一场比赛 -> { matchId }
//   GET  /api/match/:id/state       读取比赛状态快照（客户端轮询）
//   POST /api/match/:id/command    发送指令 { commandId }（唯一可写的玩法接口）
//   POST /api/match/:id/pause       暂停 / 继续 { paused }
//   POST /api/match/:id/mentality   战术倾向 { mentality }
//   DELETE /api/match/:id           结束并销毁比赛
//
// 防作弊要点：见 server/game/engine.js 头部注释。客户端发来的任何数值
// （位置、比分、随机结果）一律不被信任，服务器只接受「选了哪个指令」。
'use strict';

var path = require('path');
var crypto = require('crypto');
var express = require('express');
var Match = require('./game/engine').Match;

var app = express();
var PORT = process.env.PORT || 3000;

app.use(express.json());

// 比赛全部保存在服务器内存，客户端只持有 matchId
var matches = new Map();

function getMatch(req, res) {
  var m = matches.get(req.params.id);
  if (!m) {
    res.status(404).json({ ok: false, error: '比赛不存在或已结束' });
    return null;
  }
  return m;
}

// 创建比赛
app.post('/api/match', function (req, res) {
  var body = req.body || {};
  var halfLength = parseInt(body.halfLength, 10);
  if (!(halfLength >= 30 && halfLength <= 1200)) halfLength = 180;
  var id = crypto.randomBytes(8).toString('hex');
  var m = new Match(id, { halfLength: halfLength, mentality: body.mentality || 'balanced' });
  matches.set(id, m);
  res.json({ ok: true, matchId: id });
});

// 状态快照（客户端轮询）
app.get('/api/match/:id/state', function (req, res) {
  var m = getMatch(req, res);
  if (!m) return;
  res.json({ ok: true, state: m.serialize() });
});

// 发送指令：客户端唯一能影响比赛的写接口
app.post('/api/match/:id/command', function (req, res) {
  var m = getMatch(req, res);
  if (!m) return;
  var body = req.body || {};
  if (!m.decision) {
    return res.status(400).json({ ok: false, error: '当前不需要做决策' });
  }
  var result = m.applyCommand(m.decision.playerId, body.commandId);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// 直接操控输入：方向向量 dx/dy（-1..1）+ 加速/减速 + 切换球员。
// 服务器只接受意图，位置仍由服务器模拟（防作弊）。
app.post('/api/match/:id/input', function (req, res) {
  var m = getMatch(req, res);
  if (!m) return;
  res.json(m.setInput(req.body || {}));
});

// 暂停 / 继续
app.post('/api/match/:id/pause', function (req, res) {
  var m = getMatch(req, res);
  if (!m) return;
  m.setPaused(!!(req.body || {}).paused);
  res.json({ ok: true, paused: m.paused });
});

// 战术倾向
app.post('/api/match/:id/mentality', function (req, res) {
  var m = getMatch(req, res);
  if (!m) return;
  m.setMentality((req.body || {}).mentality);
  res.json({ ok: true, mentality: m.mentality });
});

// 销毁比赛
app.delete('/api/match/:id', function (req, res) {
  var m = matches.get(req.params.id);
  if (m) { m.destroy(); matches.delete(req.params.id); }
  res.json({ ok: true });
});

// 静态文件：客户端 + 共享常量（shared 下的 UMD 模块可直接被浏览器 <script> 引用）
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use(express.static(path.join(__dirname, '..', 'client')));

app.listen(PORT, function () {
  console.log('⚽ 足球 RPG demo 服务器启动：http://localhost:' + PORT);
});
