// shared/constants.js
// 前后端共享的常量：球场尺寸、指令定义、默认配置。
// 同时被 Node（require）和浏览器（<script> 标签）使用，采用 UMD 兼容写法。
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SharedConstants = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 球场尺寸（米）：标准 105 x 68
  var FIELD = { W: 105, H: 68 };

  // 七大指令定义。
  // ★ 体能设计（单资源制，无精神力，2026-09-27 起）：
  //   全场只有「体能」一条资源（0~100）。定价按现实耗能：
  //   冲刺 10 米远比散步 100 米耗能大；必杀技只比普通射门多一点点（不像原版一脚射门吃掉 1/4）。
  var COMMANDS = [
    { id: 'dribble', name: '突破', cost: 5, desc: '以速度突破对手的防守。成功率受对方防守能力影响。消耗 5 体能。' },
    { id: 'pass',    name: '传球', cost: 3, desc: '把球传给位置最好的队友。被紧逼时成功率下降。消耗 3 体能。' },
    { id: 'protect', name: '护球', cost: 2, desc: '用身体卡住位置护住球权，逼抢者被挡开，为队友跑位争取时间。不推进。消耗 2 体能。' },
    { id: 'shoot',   name: '射门', cost: 7, desc: '起脚射门。距离球门越近，成功率越高。消耗 7 体能。' },
    { id: 'special', name: '必杀技', cost: 9, desc: '球员专属的必杀射门，威力巨大，消耗比普通射门稍多。仅前锋 / 中场可用。' },
    { id: 'feint',   name: '假动作', cost: 4, desc: '用假动作晃开最近的防守球员，使其短暂僵直。消耗 4 体能。' },
    { id: 'retreat', name: '回撤', cost: 0,  desc: '安全地带球回撤，保持球权，不消耗体能。' },
  ];

  // 体能调参：移动按「实际速度占个人极限的比例」分四档计费（每米）。
  //   曲线形状贴近现实：冲刺 10 米（0.6）> 散步 100 米（0.4），且散步本身是恢复（+0.4/s），
  //   强度主导、距离次要。绝对值按街机引擎实际跑动量（半场约 1400 米）标定：
  //   主力半场下来剩 25~45 点，站桩球员保持高位。
  //   额外修正：持球 ×1.35；急停变向（单 tick 转向 >70°）每次 0.3；
  //   爆发（从非冲刺档突然提到冲刺档）每次 0.4；身体对抗（1.2 米内有对手紧贴）1.5/秒。
  var STAMINA = {
    MOVE_TIERS: [
      { upTo: 0.30, perMeter: 0.004, name: '散步' },
      { upTo: 0.55, perMeter: 0.010, name: '慢跑' },
      { upTo: 0.80, perMeter: 0.022, name: '高速跑' },
      { upTo: 9.99, perMeter: 0.060, name: '冲刺' },
    ],
    DRIBBLE_MUL: 1.35,   // 持球跑动修正
    TURN_ANGLE: 1.22,    // 弧度（70°）：单 tick 转向超过此值算一次急停变向
    TURN_COST: 0.3,       // 每次急停变向的体能
    BURST_COST: 0.4,     // 每次爆发的体能（从非冲刺档突然提到冲刺档）
    CONTACT_DIST: 1.2,   // 米：对手进入此距离算身体对抗
    CONTACT_DRAIN: 1.5,  // 身体对抗每秒体能
    RECOVER_IDLE: 1.2,   // 静止站立：每秒恢复
    RECOVER_WALK: 0.4,   // 散步：一边走一边小幅恢复
    HALFTIME_RECOVER: 45, // 中场休息恢复量
    SPRINT_MIN: 5,       // 体能低于此值无法冲刺
    TACKLE_COST: 4,      // 防守方上抢一次的体能消耗
  };

  // 默认比赛配置（创建比赛时可覆盖）
  var DEFAULT_CONFIG = {
    halfLength: 180, // 每半场秒数（演示默认 3 分钟）
    tickMs: 100,     // 服务器 tick 间隔（毫秒）
  };

  // 比赛阶段
  var PHASES = ['kickoff', 'play', 'decision', 'goal', 'halftime', 'fulltime', 'whistle', 'penalty'];

  // 阶段中文名
  var PHASE_LABEL = {
    kickoff: '开球',
    play: '比赛中',
    decision: '指令选择',
    goal: '进球',
    halftime: '中场休息',
    fulltime: '终场',
    whistle: '死球',
    penalty: '点球',
  };

  return {
    FIELD: FIELD,
    COMMANDS: COMMANDS,
    STAMINA: STAMINA,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    PHASES: PHASES,
    PHASE_LABEL: PHASE_LABEL,
  };
});
