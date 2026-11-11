# Mod 接口

生涯层在 `shared/career.js`。业余联赛本身就是一个 mod（`shared/mods/amateur.js`），示例杯赛和年龄曲线是另一个 mod（`shared/mods/example-cup.js`）。两者走同一套注册和钩子。

## 怎么加载

1. 内置：页面先载入 `shared/career.js`，再载入各个 mod 脚本。mod 在加载时调用 `Career.registerMod(mod)`。
2. 数据 mod：`Career.loadJSON({ id, name, hooks })`。`hooks` 里如果是函数就能跑；纯 JSON 只能登记 id 和静态 `data`。
3. 自己的 JS：写成和 `example-cup.js` 一样的 UMD，在 `career.js` 之后用 `<script>` 引入，或在控制台 `Career.registerMod(...)`。同 id 会覆盖旧的。

节点里：

```js
var Career = require('./shared/career');
require('./shared/mods/amateur');
require('./shared/mods/example-cup');
var save = Career.newCareer(1);
```

## 注册形状

```js
Career.registerMod({
  id: 'my-mod',
  name: '显示名',
  hooks: {
    competitions: function (ctx) {},
    onSeasonStart: function (ctx) {},
    schedule: function (ctx) {},
    transferMarket: function (ctx) {},
    onMatchPlayed: function (ctx) {},
    growPlayers: function (ctx) {},
    youthIntake: function (ctx) {}
  }
});
```

`Career.HOOKS` 是上面这份名字列表。

## 钩子

| 钩子 | 时机 | ctx |
|---|---|---|
| `competitions` | 新生涯一开始 | `{ save, rng, competitions }`。往 `competitions` 里 push `{ id, name, kind, points, tiebreak }` |
| `onSeasonStart` | 新赛季（含新档和升季） | `{ save, rng, rollover }`。业余联赛在这里生成球队、积分榜和双循环赛程 |
| `schedule` | 赛季赛程生成之后 | `{ save }`。用 `Career.insertAndPostpone` 插入杯赛并推迟当天的联赛 |
| `transferMarket` | 赛程定了之后 | `{ save, rng }`。可往 `save.market` 加挂牌 |
| `onMatchPlayed` | 玩家这场记完分 | `{ save, fixture, hg, ag }` |
| `growPlayers` | 每场之后，以及升季时 | `{ save, players, when: 'match' \| 'season' }`。直接改 `players[].stats` |
| `youthIntake` | 赛季开始的最后 | `{ save, rng }`。往 `save.squad` 加人，注意 `Career.MAX_SQUAD`。青训营走 `club` mod，不占这 22 人 |
| `onLoad` | 读档迁完之后 | `{ save }`。补经营字段，不冲掉旧阵容 |
| `serialize` | 写入某个存档槽时 | `{ save }`。返回这个 mod 自己的状态（会放进 `modState[id]`） |
| `deserialize` | 从槽位读进游戏时 | `{ save, data }`。`data` 是上次 serialize 的结果 |

## 赛程不是死列表

`save.calendar = { seq, fixtures: [] }`。

一场比赛：

```js
{
  id, competitionId, round, homeId, awayId,
  date,            // 第几天，从 0 起
  status,          // scheduled | played
  postponed,       // 被杯赛挤过
  hg, ag
}
```

- `Career.addFixture(cal, spec)` 追加一场。
- `Career.postpone(cal, fixtureId, newDate)` 改日期，已踢完的会拒绝。
- `Career.insertAndPostpone(cal, spec)` 把这一天里牵扯到主客队的 `amateur-league` 场次推到赛程最后，再插入新的一场。示例杯赛用的就是这个。
- `Career.nextFixture(cal, teamId)` 取该队最近的未赛。
- `Career.doubleRoundRobin(cal, competitionId, teamIds)` 主客双循环。

积分：胜 3、平 1、负 0。排序是积分、净胜球、进球、队名。`Career.applyScore` / `Career.sortTable`。

## 转会和人数

`Career.buy(save, listingId)`、`sell`、`release`。预算不够、超过 22 人、少于 16 人、或者人还在首发里，都会失败并给出中文原因。挂牌形状是 `{ id, fee, wage, player }`。

首发 11 个槽位在 `Career.XI_SLOTS`（4-2-3-1 的号码）。`Career.lineupPlayers(squad, xi)` 交给比赛引擎。

## 存档

生涯正文的 `schema` 是 `Career.SCHEMA`（现在是 1）。槽位信封是 `Career.SLOT_SCHEMA`（现在是 2）：一个索引键 `soccer-rpg-saves`，再加每个槽自己的键 `soccer-rpg-save-auto`、`soccer-rpg-save-1`、`soccer-rpg-save-2`、`soccer-rpg-save-3`。自动档 1 个，手动档 3 个。

信封里有 `savedAt`、给列表用的 `summary`、当时启用的 `mods`（id 和 version），以及 `modState`。读档时如果某个 mod id 不在，会给出「缺少模组」警告，游戏本身不崩。槽位损坏或版本认不出时标成损坏，不往下解释。

以前的单键 `soccer-rpg-career` 会在第一次打开时迁进自动存档，迁成功就删掉旧键。迁不了就标损坏，不动已经有的自动档。

`Career.writeSlot(storage, slotId, career)`、`readSlot`、`loadSlot`、`listSlots`、`deleteSlot`、`exportSlot`、`importSlot`。`persist` / `restore` 仍可用，分别写和读最近一份好档（写入走自动档）。空间不够时返回 `{ ok: false, quota: true, error: '存储空间不够，存档没写上' }`。
