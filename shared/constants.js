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

  // 六大指令定义。
  // ★ 体能设计（区别于《天使之翼》）：所有技能只消耗「精神」，不消耗体能。
  //   体能只因跑动缓慢下降、随时间缓慢恢复（见 server/game/engine.js 与 README）。
  var COMMANDS = [
    { id: 'dribble', name: '突破', cost: 20, desc: '以速度突破对手的防守。成功率受对方防守能力影响。' },
    { id: 'pass',    name: '传球', cost: 15, desc: '把球传给位置最好的队友。被紧逼时成功率下降。' },
    { id: 'shoot',   name: '射门', cost: 30, desc: '起脚射门。距离球门越近，成功率越高。' },
    { id: 'special', name: '必杀技', cost: 60, desc: '球员专属的必杀射门，威力巨大但精神消耗很高。仅前锋 / 中场可用。' },
    { id: 'feint',   name: '假动作', cost: 20, desc: '用假动作晃开最近的防守球员，使其短暂僵直。' },
    { id: 'retreat', name: '回撤', cost: 0,  desc: '安全地带球回撤，保持球权，不消耗精神。' },
  ];

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
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    PHASES: PHASES,
    PHASE_LABEL: PHASE_LABEL,
  };
});
