// shared/teams.js
// 两队完整阵容数据：姓名、位置、等级、数值、必杀技、阵型站位。
// 主队（home）= 青鹰高校（蓝色，用户控制）；客队（away）= 烈风学院（红色，AI 控制）。
// 数值区间约 40~85。客队整体略弱，保证 demo 可玩性。
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SharedTeams = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 阵型站位（主队视角：向 +x 方向进攻，自家球门在 x=0）
  // 客队站位由程序自动镜像（x -> 105 - x）
  var FORMATION_HOME = {
    1:  { x: 5,  y: 34 }, // GK
    2:  { x: 22, y: 20 }, // DF
    3:  { x: 20, y: 34 }, // DF
    4:  { x: 22, y: 48 }, // DF
    5:  { x: 38, y: 14 }, // MF
    6:  { x: 36, y: 28 }, // MF
    7:  { x: 36, y: 40 }, // MF
    8:  { x: 38, y: 54 }, // MF
    9:  { x: 52, y: 24 }, // FW
    10: { x: 50, y: 34 }, // FW（开球球员）
    11: { x: 52, y: 44 }, // FW
  };

  // 基础数值模板：{ speed 速度, dribble 盘带, pass 传球, shoot 射门, defend 防守, keep 守门 }
  function base(o) {
    return {
      speed: o.speed || 55,
      dribble: o.dribble || 55,
      pass: o.pass || 55,
      shoot: o.shoot || 50,
      defend: o.defend || 55,
      keep: o.keep || 40,
    };
  }

  // ---------------- 主队：青鹰高校 ----------------
  var HOME = [
    { num: 1,  name: '林 大地',  pos: 'GK', level: 10, stats: base({ keep: 78, defend: 55, speed: 45 }), maxStamina: 700,  maxSpirit: 100, special: null },
    { num: 2,  name: '石川 健',  pos: 'DF', level: 9,  stats: base({ defend: 68, speed: 62, dribble: 52 }), maxStamina: 800, maxSpirit: 100, special: null },
    { num: 3,  name: '高桥 翔',  pos: 'DF', level: 9,  stats: base({ defend: 66, speed: 64, pass: 58 }),    maxStamina: 800, maxSpirit: 100, special: null },
    { num: 4,  name: '松本 勇',  pos: 'DF', level: 8,  stats: base({ defend: 62, speed: 60, shoot: 45 }),  maxStamina: 800, maxSpirit: 100, special: null },
    { num: 5,  name: '井上 蓝',  pos: 'MF', level: 9,  stats: base({ pass: 70, dribble: 64, speed: 62 }), maxStamina: 800, maxSpirit: 100, special: null },
    { num: 6,  name: '山田 光',  pos: 'MF', level: 8,  stats: base({ pass: 66, speed: 66, defend: 58 }),  maxStamina: 800, maxSpirit: 100, special: null },
    { num: 7,  name: '佐藤 疾风', pos: 'MF', level: 10, stats: base({ speed: 78, dribble: 72, pass: 66 }), maxStamina: 800, maxSpirit: 100, special: { name: '疾风突破射门' } },
    { num: 8,  name: '斋藤 心',  pos: 'MF', level: 8,  stats: base({ pass: 64, defend: 60, speed: 60 }),  maxStamina: 800, maxSpirit: 100, special: null },
    { num: 9,  name: '木村 雷',  pos: 'FW', level: 11, stats: base({ shoot: 76, speed: 74, dribble: 68 }), maxStamina: 800, maxSpirit: 100, special: { name: '雷光射门' } },
    { num: 10, name: '风间 隼',  pos: 'FW', level: 12, stats: base({ shoot: 80, speed: 82, dribble: 78, pass: 70 }), maxStamina: 800, maxSpirit: 100, special: { name: '疾风射门' } },
    { num: 11, name: '中村 翼',  pos: 'FW', level: 10, stats: base({ shoot: 72, speed: 76, dribble: 66 }), maxStamina: 800, maxSpirit: 100, special: { name: '翔空射门' } },
  ];

  // ---------------- 客队：烈风学院（AI，整体略弱） ----------------
  var AWAY = [
    { num: 1,  name: '赤城 守',  pos: 'GK', level: 10, stats: base({ keep: 74, defend: 52, speed: 44 }), maxStamina: 700,  maxSpirit: 100, special: null },
    { num: 2,  name: '火野 强',  pos: 'DF', level: 9,  stats: base({ defend: 64, speed: 60, dribble: 50 }), maxStamina: 800, maxSpirit: 100, special: null },
    { num: 3,  name: '炎上 刚',  pos: 'DF', level: 8,  stats: base({ defend: 60, speed: 58, pass: 54 }),    maxStamina: 800, maxSpirit: 100, special: null },
    { num: 4,  name: '爆裂 直',  pos: 'DF', level: 8,  stats: base({ defend: 58, speed: 57, shoot: 44 }),  maxStamina: 800, maxSpirit: 100, special: null },
    { num: 5,  name: '疾风 烈',  pos: 'MF', level: 9,  stats: base({ speed: 70, dribble: 62, pass: 60 }),   maxStamina: 800, maxSpirit: 100, special: null },
    { num: 6,  name: '红莲 斗',  pos: 'MF', level: 8,  stats: base({ pass: 62, defend: 58, speed: 60 }),    maxStamina: 800, maxSpirit: 100, special: null },
    { num: 7,  name: '旋风 丸',  pos: 'MF', level: 8,  stats: base({ speed: 68, dribble: 62, pass: 58 }),   maxStamina: 800, maxSpirit: 100, special: null },
    { num: 8,  name: '烈火 阵',  pos: 'MF', level: 7,  stats: base({ pass: 58, defend: 56, speed: 58 }),   maxStamina: 800, maxSpirit: 100, special: null },
    { num: 9,  name: '灼热 牙',  pos: 'FW', level: 10, stats: base({ shoot: 70, speed: 70, dribble: 64 }),  maxStamina: 800, maxSpirit: 100, special: { name: '灼热射门' } },
    { num: 10, name: '炎 隼人',  pos: 'FW', level: 11, stats: base({ shoot: 76, speed: 78, dribble: 72 }), maxStamina: 800, maxSpirit: 100, special: { name: '烈焰射门' } },
    { num: 11, name: '火渡 空',  pos: 'FW', level: 9,  stats: base({ shoot: 66, speed: 70, dribble: 62 }),  maxStamina: 800, maxSpirit: 100, special: null },
  ];

  // 生成比赛用球员对象（深拷贝 + 运行时字段）
  function makeTeams() {
    function build(list, team) {
      return list.map(function (p, i) {
        var home = FORMATION_HOME[p.num];
        return {
          id: (team === 'home' ? 'h' : 'a') + p.num,
          idx: i,
          team: team,
          num: p.num,
          name: p.name,
          pos: p.pos,
          level: p.level,
          stats: Object.assign({}, p.stats),
          maxStamina: p.maxStamina,
          maxSpirit: p.maxSpirit,
          stamina: p.maxStamina,
          spirit: p.maxSpirit,
          special: p.special ? { name: p.special.name } : null,
          // 站位：主队按阵型，客队镜像
          hx: team === 'home' ? home.x : 105 - home.x,
          hy: home.y,
          x: 0, y: 0,
          frozenUntil: 0,   // 被假动作冻住 until（毫秒时间戳，服务器时钟）
          beatenUntil: 0,   // 被突破晃过 until
          retreatTarget: null, // 回撤目标点
        };
      });
    }
    return { home: build(HOME, 'home'), away: build(AWAY, 'away') };
  }

  return {
    FORMATION_HOME: FORMATION_HOME,
    makeTeams: makeTeams,
    HOME_NAME: '青鹰高校',
    AWAY_NAME: '烈风学院',
    HOME_COLOR: '#2b5fe3',
    AWAY_COLOR: '#d23b3b',
  };
});
