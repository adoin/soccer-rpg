// shared/teams.js
// 两队完整阵容数据：姓名、位置、等级、数值、必杀技、阵型站位。
// 主队（home）= 青鹰高校（蓝色，用户控制）；客队（away）= 烈风学院（红色，AI 控制）。
// 数值体系：FM 式 1-20 分制。身体 / 技术 / 心智 / 守门四类。
// 客队整体比主队弱约 1-2 点，保证 demo 可玩性；客队王牌保留亮点。
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

  // FM 式属性 key（1-20）
  var OUTFIELD_KEYS = [
    // 身体
    'pace', 'acceleration', 'agility', 'strength', 'jumping', 'stamina', 'balance',
    // 技术
    'dribbling', 'passing', 'finishing', 'longShots', 'tackling', 'marking',
    'heading', 'technique', 'firstTouch', 'crossing', 'setPieces',
    // 心智
    'decisions', 'anticipation', 'offBall', 'positioning', 'vision',
    'composure', 'determination', 'aggression', 'bravery', 'teamwork',
  ];
  var GK_KEYS = [
    'aerial', 'command', 'handling', 'kicking', 'oneOnOne', 'reflexes', 'rushing', 'throwing',
  ];

  // 基础数值模板：外场球员默认 10；门将的外场 key 默认 8、守门 key 默认 10。
  // o 覆盖任意 key。外场球员的守门 key 默认 5（应急客串）。
  function base(o, isGK) {
    o = o || {};
    var s = {};
    OUTFIELD_KEYS.forEach(function (k) {
      s[k] = (o[k] != null) ? o[k] : (isGK ? 8 : 10);
    });
    GK_KEYS.forEach(function (k) {
      s[k] = (o[k] != null) ? o[k] : (isGK ? 10 : 5);
    });
    return s;
  }

  // ---------------- 主队：青鹰高校 ----------------
  var HOME = [
    { num: 1,  name: '林 大地',  pos: 'GK', level: 10, stats: base({ reflexes: 15, handling: 14, oneOnOne: 14, aerial: 13, command: 12, rushing: 11, throwing: 11, kicking: 10, jumping: 12, strength: 10, composure: 13, decisions: 12, positioning: 12 }, true), special: null },
    { num: 2,  name: '石川 健',  pos: 'DF', level: 9,  stats: base({ tackling: 13, marking: 13, positioning: 13, anticipation: 13, aggression: 13, bravery: 12, pace: 12, acceleration: 11, strength: 12, heading: 11, jumping: 11, decisions: 11, composure: 11, teamwork: 12 }), special: null },
    { num: 3,  name: '高桥 翔',  pos: 'DF', level: 9,  stats: base({ tackling: 13, marking: 12, positioning: 12, anticipation: 12, pace: 12, acceleration: 11, passing: 11, strength: 11, heading: 11, decisions: 11, composure: 11, aggression: 11 }), special: null },
    { num: 4,  name: '松本 勇',  pos: 'DF', level: 8,  stats: base({ tackling: 12, marking: 12, positioning: 11, anticipation: 11, pace: 11, aggression: 12, bravery: 12, strength: 12, heading: 11, jumping: 11, longShots: 9, finishing: 8 }), special: null },
    { num: 5,  name: '井上 蓝',  pos: 'MF', level: 9,  stats: base({ passing: 14, vision: 14, decisions: 13, dribbling: 12, technique: 12, firstTouch: 12, pace: 12, offBall: 11, anticipation: 11, composure: 11, teamwork: 12, stamina: 12, aggression: 9 }), special: null },
    { num: 6,  name: '山田 光',  pos: 'MF', level: 8,  stats: base({ passing: 12, vision: 12, decisions: 12, pace: 12, acceleration: 11, tackling: 11, marking: 10, teamwork: 12, stamina: 12, composure: 11, aggression: 10 }), special: null },
    { num: 7,  name: '佐藤 疾风', pos: 'MF', level: 10, stats: base({ pace: 16, acceleration: 16, dribbling: 15, agility: 14, balance: 13, firstTouch: 13, technique: 13, passing: 12, vision: 12, offBall: 12, finishing: 12, longShots: 11, composure: 12, determination: 12 }), special: { name: '疾风突破射门' } },
    { num: 8,  name: '斋藤 心',  pos: 'MF', level: 8,  stats: base({ passing: 12, vision: 12, decisions: 13, tackling: 11, pace: 11, technique: 11, teamwork: 13, composure: 11, stamina: 11, aggression: 9 }), special: null },
    { num: 9,  name: '木村 雷',  pos: 'FW', level: 11, stats: base({ finishing: 15, strength: 14, heading: 14, longShots: 13, jumping: 13, balance: 12, pace: 13, acceleration: 12, offBall: 13, anticipation: 13, composure: 12, bravery: 12, firstTouch: 12 }), special: { name: '雷光射门' } },
    { num: 10, name: '风间 隼',  pos: 'FW', level: 12, stats: base({ pace: 17, acceleration: 16, dribbling: 16, finishing: 15, firstTouch: 15, anticipation: 15, offBall: 15, composure: 14, agility: 14, technique: 14, decisions: 14, determination: 14, vision: 13, balance: 13, longShots: 12, jumping: 12 }), special: { name: '疾风射门' } },
    { num: 11, name: '中村 翼',  pos: 'FW', level: 10, stats: base({ finishing: 13, pace: 14, acceleration: 14, dribbling: 12, jumping: 14, heading: 13, offBall: 13, anticipation: 13, composure: 12, firstTouch: 12, longShots: 11, strength: 11 }), special: { name: '翔空射门' } },
  ];

  // ---------------- 客队：烈风学院（AI，整体弱约 1-2 点） ----------------
  var AWAY = [
    { num: 1,  name: '赤城 守',  pos: 'GK', level: 10, stats: base({ reflexes: 14, handling: 13, oneOnOne: 13, aerial: 12, command: 11, rushing: 10, throwing: 10, kicking: 9, jumping: 11, strength: 9, composure: 12, decisions: 11, positioning: 11 }, true), special: null },
    { num: 2,  name: '火野 强',  pos: 'DF', level: 9,  stats: base({ tackling: 12, marking: 12, positioning: 12, anticipation: 12, aggression: 13, bravery: 12, pace: 11, strength: 12, heading: 11, jumping: 10, decisions: 10 }), special: null },
    { num: 3,  name: '炎上 刚',  pos: 'DF', level: 8,  stats: base({ tackling: 11, marking: 11, positioning: 11, anticipation: 11, pace: 11, passing: 10, aggression: 12, strength: 11, heading: 10 }), special: null },
    { num: 4,  name: '爆裂 直',  pos: 'DF', level: 8,  stats: base({ tackling: 11, marking: 10, positioning: 10, aggression: 13, bravery: 13, strength: 12, pace: 10, heading: 11, jumping: 11, longShots: 8, finishing: 7 }), special: null },
    { num: 5,  name: '疾风 烈',  pos: 'MF', level: 9,  stats: base({ pace: 13, acceleration: 13, agility: 12, dribbling: 12, passing: 11, vision: 11, offBall: 11, anticipation: 11, composure: 10, teamwork: 11, stamina: 11 }), special: null },
    { num: 6,  name: '红莲 斗',  pos: 'MF', level: 8,  stats: base({ passing: 11, vision: 11, decisions: 11, tackling: 11, pace: 11, teamwork: 11, aggression: 11, stamina: 11, composure: 10 }), special: null },
    { num: 7,  name: '旋风 丸',  pos: 'MF', level: 8,  stats: base({ pace: 12, acceleration: 12, agility: 12, dribbling: 11, passing: 10, offBall: 10, stamina: 11, firstTouch: 10 }), special: null },
    { num: 8,  name: '烈火 阵',  pos: 'MF', level: 7,  stats: base({ passing: 10, vision: 10, decisions: 10, tackling: 10, pace: 10, teamwork: 10, stamina: 10, technique: 9 }), special: null },
    { num: 9,  name: '灼热 牙',  pos: 'FW', level: 10, stats: base({ finishing: 13, strength: 13, pace: 12, acceleration: 11, longShots: 12, offBall: 12, anticipation: 12, composure: 11, bravery: 12, heading: 12, jumping: 11, firstTouch: 11 }), special: { name: '灼热射门' } },
    { num: 10, name: '炎 隼人',  pos: 'FW', level: 11, stats: base({ pace: 15, acceleration: 15, dribbling: 14, finishing: 14, offBall: 13, anticipation: 13, firstTouch: 13, composure: 13, technique: 13, determination: 13, agility: 13, balance: 12, longShots: 12, vision: 12 }), special: { name: '烈焰射门' } },
    { num: 11, name: '火渡 空',  pos: 'FW', level: 9,  stats: base({ finishing: 12, pace: 13, acceleration: 12, offBall: 11, anticipation: 11, heading: 11, jumping: 11, composure: 10, dribbling: 10 }), special: null },
  ];

  // 生成比赛用球员对象（深拷贝 + 运行时字段）
  // 体能为单一资源：maxStamina/stamina = 100（初始满），无精神力字段。
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
          maxStamina: 100,
          stamina: 100,
          special: p.special ? { name: p.special.name } : null,
          // 站位：主队按阵型，客队镜像
          hx: team === 'home' ? home.x : 105 - home.x,
          hy: home.y,
          x: 0, y: 0,
          frozenUntil: 0,   // 被假动作冻住 until（毫秒时间戳，服务器时钟）
          beatenUntil: 0,   // 被突破晃过 until
          retreatTarget: null, // 回撤目标点
          cards: { yellow: 0, red: false }, // 红黄牌
          sentOff: false,   // 是否被罚下
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
