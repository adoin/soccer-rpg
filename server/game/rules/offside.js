// server/game/rules/offside.js
// ============================================================
// 越位裁判层：100% 确定性的纯客观判定，不使用任何随机数，
// 也不看任何球员数值。
//
// 原则（用户纠正后的架构）：
//   数值只决定球员的「行为」（跑位时机、是否收步、防线是否协同），
//   裁判只看场上实际发生的局面吹哨——看到什么吹什么，绝不用数值
//   去扭曲玩家亲眼看到的结果。
//
// 行为层的数值决策在 behavior.js，裁判层对此一无所知。
//
// 判定点（传球、射门、门将扑救反弹三个瞬间做快照）：
//
//  1. 越位位置（纯几何）：
//     - 以进攻方向坐标 u（离本方球门越远越大）衡量；
//     - u > 倒数第二名防守球员的 u，且 u > 球的 u，且 u > 中线，
//       则处于越位位置（平行不越位，本方半场不越位）；
//  2. 接球：目标处于越位位置 → 越位犯规，没有任何数值可以豁免；
//  3. 干扰行为（纯几何）：处于越位位置的非接球球员，若出现以下任一
//     行为即判越位犯规——
//       · 遮挡门将视线（处在球→门将的视线走廊内）
//       · 卡位（贴住正在追球的防守球员，干扰其防守移动）
//       · 参与进攻（进入传球线路 2.5 米内试图触球）
//       · 假装处理球（在传球线路附近做动作干扰防守判断）
//  4. 越位位置获益：射门被门将扑出后，处于越位位置的球员在 9 米内
//     拿到反弹球 → 吹越位（而不是让进攻继续）。
//
// 所有判定都是「站位快照」的纯函数：同样的局面永远得到同样的哨声。
// ============================================================
'use strict';

var FIELD_W = 105;
var FIELD_H = 68;
var HALF = FIELD_W / 2;
var PATH_TOUCH = 2.5;     // 进入传球线路即视为试图触球（米）
var PATH_DUMMY = 4.0;     // 在此范围内视为假装处理球干扰（米）
var SIGHT_CORRIDOR = 2.0; // 门将视线走廊半宽（米）
var SCREEN_DIST = 2.5;    // 卡位判定距离（米）
var REBOUND_DIST = 9;     // 反弹获益判定距离（米）

// 进攻方向坐标：离本方球门越远，u 越大
function uOf(p, attackingTeam) {
  return attackingTeam === 'home' ? p.x : FIELD_W - p.x;
}

function dist(ax, ay, bx, by) {
  var dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// 点到线段距离
function distToSegment(px, py, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay;
  var len2 = dx * dx + dy * dy;
  var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  var cx = ax + t * dx, cy = ay + t * dy;
  return dist(px, py, cx, cy);
}

// 比赛快照：只读，不修改任何状态
function snapshot(match, attackingTeam) {
  var defendingTeam = attackingTeam === 'home' ? 'away' : 'home';
  var defU = [];
  match.players.forEach(function (p) {
    if (p.team === defendingTeam && !p.sentOff) defU.push(uOf(p, attackingTeam));
  });
  defU.sort(function (a, b) { return b - a; }); // 离进攻方球门由近到远
  var uSecondLast = defU.length >= 2 ? defU[1] : (defU.length === 1 ? defU[0] : 0);
  var uBall = attackingTeam === 'home' ? match.ball.x : FIELD_W - match.ball.x;
  return { attackingTeam: attackingTeam, defendingTeam: defendingTeam, uSecondLast: uSecondLast, uBall: uBall };
}

function isOffsidePosition(p, snap) {
  if (p.sentOff) return false;
  var u = uOf(p, snap.attackingTeam);
  return u > snap.uSecondLast + 0.001 && u > snap.uBall + 0.001 && u > HALF + 0.001;
}

// 跑位分 / 造越位分 / 收步判定已移至 behavior.js（行为层）。
// 裁判层不看数值：位置越位就是越位，没有任何数值豁免。

function keeperOf(match, team) {
  for (var i = 0; i < match.players.length; i++) {
    var p = match.players[i];
    if (p.team === team && p.pos === 'GK' && !p.sentOff) return p;
  }
  return null;
}

// 遮挡门将视线：B 处在球→门将的走廊内、且在球与门将之间
function blocksKeeperSight(b, ballX, ballY, gk) {
  if (!gk) return false;
  if (distToSegment(b.x, b.y, ballX, ballY, gk.x, gk.y) > SIGHT_CORRIDOR) return false;
  return dist(ballX, ballY, b.x, b.y) < dist(ballX, ballY, gk.x, gk.y) - 1;
}

// 判罚结果构造
function offence(player, reason, snap, ballX, ballY) {
  return {
    type: 'offside',
    player: player,
    reason: reason,
    spot: { x: ballX, y: ballY },
    uSecondLast: snap.uSecondLast,
  };
}

var REASON_LABEL = {
  'receive': '处于越位位置接球',
  'interfere-play': '越位位置参与进攻',
  'screen': '越位位置卡位阻挡',
  'sight': '越位位置遮挡门将视线',
  'dummy': '越位位置假装处理球干扰',
  'rebound': '越位位置获益（反弹球）',
};

function reasonText(reason, player) {
  return '🚩 越位！' + player.name + REASON_LABEL[reason] + '，裁判鸣哨。';
}

// ---------- 传球瞬间的越位判定 ----------
function judgePass(match, passer, target) {
  var team = passer.team;
  var snap = snapshot(match, team);
  var gk = keeperOf(match, snap.defendingTeam);

  // 回追的防守球员（用于卡位判定）：离球最近的两名对方球员
  var chasers = match.players
    .filter(function (p) { return p.team === snap.defendingTeam && !p.sentOff; })
    .sort(function (a, b) { return dist(a.x, a.y, match.ball.x, match.ball.y) - dist(b.x, b.y, match.ball.x, match.ball.y); })
    .slice(0, 2);

  // 其余处于越位位置的队友的干扰扫描
  function scanInterference(excludeId) {
    var mates = match.players.filter(function (p) {
      return p.team === team && !p.sentOff && p.id !== passer.id && p.id !== excludeId && isOffsidePosition(p, snap);
    });
    for (var i = 0; i < mates.length; i++) {
      var b = mates[i];
      // 1. 遮挡门将视线（向进攻三区传球时）
      var uTarget = uOf(target, team);
      if (uTarget > 75 && blocksKeeperSight(b, match.ball.x, match.ball.y, gk)) {
        return offence(b, 'sight', snap, b.x, b.y);
      }
      // 2. 卡位：越位位置贴住正在追球的防守球员，视为干扰对方
      for (var j = 0; j < chasers.length; j++) {
        var o = chasers[j];
        if (dist(b.x, b.y, o.x, o.y) < SCREEN_DIST) {
          return offence(b, 'screen', snap, b.x, b.y);
        }
      }
      // 3/4. 进入传球线路：试图触球 / 假装处理球
      var dPath = distToSegment(b.x, b.y, passer.x, passer.y, target.x, target.y);
      if (dPath < PATH_TOUCH) return offence(b, 'interfere-play', snap, b.x, b.y);
      if (dPath < PATH_DUMMY) return offence(b, 'dummy', snap, b.x, b.y);
    }
    return null;
  }

  // 先看接球目标：处于越位位置接球 → 直接吹罚，没有任何数值豁免。
  // （球员是否"急停收步"是行为层的决策，见 behavior.js；
  //   裁判只看传球瞬间实际发生的局面。）
  if (isOffsidePosition(target, snap)) {
    return offence(target, 'receive', snap, target.x, target.y);
  }

  // 目标不越位：仍要检查其他越位位置球员是否干扰
  var interference = scanInterference(target.id);
  if (interference) return interference;
  return { type: 'playon' };
}

// ---------- 射门瞬间的越位判定（干扰类） ----------
function judgeShot(match, shooter) {
  var team = shooter.team;
  var snap = snapshot(match, team);
  var gk = keeperOf(match, snap.defendingTeam);
  var goalX = team === 'home' ? FIELD_W : 0;
  var goalY = FIELD_H / 2;
  var mates = match.players.filter(function (p) {
    return p.team === team && !p.sentOff && p.id !== shooter.id && isOffsidePosition(p, snap);
  });
  for (var i = 0; i < mates.length; i++) {
    var b = mates[i];
    if (blocksKeeperSight(b, shooter.x, shooter.y, gk)) {
      return offence(b, 'sight', snap, b.x, b.y);
    }
    if (distToSegment(b.x, b.y, shooter.x, shooter.y, goalX, goalY) < PATH_TOUCH) {
      return offence(b, 'interfere-play', snap, b.x, b.y);
    }
  }
  return { type: 'playon', snap: snap };
}

// ---------- 门将扑救反弹后的获益判定 ----------
// 按射门瞬间的快照判断"越位位置"（规则如此：位置看的是队友触球瞬间，
// 而不是反弹瞬间），再看反弹后谁在球附近获益。
function judgeRebound(match, attackingTeam, shotSnap) {
  var snap = shotSnap || snapshot(match, attackingTeam);
  var mates = match.players.filter(function (p) {
    return p.team === attackingTeam && !p.sentOff && isOffsidePosition(p, snap);
  });
  for (var i = 0; i < mates.length; i++) {
    var b = mates[i];
    if (dist(b.x, b.y, match.ball.x, match.ball.y) < REBOUND_DIST) {
      return offence(b, 'rebound', snap, b.x, b.y);
    }
  }
  return { type: 'playon' };
}

module.exports = {
  snapshot: snapshot,
  isOffsidePosition: isOffsidePosition,
  uOf: uOf,
  judgePass: judgePass,
  judgeShot: judgeShot,
  judgeRebound: judgeRebound,
  reasonText: reasonText,
  REASON_LABEL: REASON_LABEL,
};
