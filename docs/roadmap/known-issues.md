# 已知问题

2026-08 一批改动（市场重构 / 指令声明栈 / metadata 契约 / 两次包改名）之后跑了四轮对抗审计，
本文记录**经实测确认、当轮未修**的条目。随后又跑了一轮**对本文自身的对抗核实**（42 个 agent，
逐条重推 + 独立复核），据此修掉了一批、更正了一批失实数字，并补进了那一轮新发现的条目。

体例：每条附实测依据与当前位置；**不附行号**——这批文档上一次就是因为行号整体漂移而失准，
行号请以符号名现场 grep 为准。（`docs/roadmap/commands.md` 仍是行号体例，实测 17 处引用里
10 处已漂移，读它时先核对。）

> ⚠️ 凡本文的判断，动手前请自己先复现一遍。**上一版本文自己就有五处失实**（数字错 5.8 倍、
> 举的例子在写下时已被修掉、把一层转发壳数成一份实现），来源都是「未经复现就采信」。

## 一、结构性：同一语义的多份实现

### 权限定级：两份实现 + 一层 overrides 壳

**更正**：上一版写「散在三处，其中两处不该有」，实测只有**两份数学实现**——
`api-authority` 的 `capabilityMinLevel`（后端唯一实现）与 `plugin-webui-client` 的
`derivedMinLevel`（真正的拷贝，对 `@aalis/api-authority` 零引用、`0/1/2` 硬编码）。
`plugin-authority` 的 `resolveMinLevel` 是纯委托（`override ?? capabilityMinLevel(opts)`），
它承载的 overrides 优先级本就该住在 authority 里，**不该删**。

**已发生的分歧（上一版说「行为一致」，不确）**：枚举 risk × visibility 全组合实测，
契约域内 12 组全同，域外 3 组分歧，形如「risk 是非联合成员的真值串 + `visibility:'restricted'`」：
后端 2、前端 0。根因是结构不同——后端三个 `===` 都不中就落 visibility 兜底，前端是
`if (op.risk) return riskToLevel(op.risk)`，**只要 risk 为真就再也不看 visibility**。
方向是 fail-open 的显示：第三方 JS 插件把 `risk` 拼错，权限页会显示「所有人可用」。

**「没有任何测试会报错」也不确**：把 `RESTRICTED_LEVEL` 由 2 改 3，实测 8 个用例变红
（commands-v2 / authority-manager / authority-actions）——但前端那 7 个全绿，且红的都是
「后端函数 vs 字面量 2」，改字面量即转绿，漂移被「测试已修好」的假象盖住。加一档 risk 则
连这层偶然告警都没有。另记一笔：`capabilityMinLevel` 里 dangerous/sensitive 是写死的 2/1，
只有 safe 与无 risk 用常量，所以 `RESTRICTED_LEVEL` 根本不是能单独拧的旋钮——改成 3 会让
「restricted 无 risk」比「dangerous」更严。

**方向（未定）**：`getOverview` 对每条 operation 多下发一个后端算好的 `minLevel`
（payload 已在下发 `risk`/`visibility`，加两行即可），前端删掉自己那份、`effectiveMinLevel`
只留 override 覆盖。比给浏览器包塞后端依赖干净。**未做**——这是改进不是修 bug：
该值纯显示、从不回写，复核已把严重度从 medium 下调 low。

### 「关键词 → 包类型」四份实现

`plugin-package-manager` 的卸载闸、`marketplace.ts` 的 `classifyPackage` 与
`classifySystemComponent`、`node-modules-loader.ts` 的 `isLoadablePlugin`——四者优先级各不相同。

**更正两条分歧的现状**：
- 同时带 `aalis-plugin` 与 `aalis-api` 的包：加载器会加载、市场页渲染成只读「API 契约」卡。
  实测**全仓 99 个包无一带两个类型词**，是「等一次误打词」的结构性隐患，不是活缺陷。
- 无任何 aalis 关键词 → `classifyPackage` 兜底成 `plugin`：函数层确实与服务层结论相反，
  但**端到端不可达**——在线路径的输入只来自 5 条 `keywords:` 检索（实测 npm 过滤严格、
  零漏网），离线降级路径显式过滤。属「兜底的正确性靠调用点约束」的潜在耦合。

**方向**：抬成唯一一份纯函数，`aalis-plugin` 置最高优先级（它是加载器判据）。要防复发可加一条
architecture 测试：每包类型词数量恒为 1（脚手架/示例白名单）。

## 二、契约与调用侧

- **`api-memory` 必填化只做了 4/11**——**这不是欠债**。上一版说「另 7 个用的是同一条论据」，
  只对一半：契约给的是两条论据，第二条（守卫全是死分支）对这 7 个不成立。实测它们的守卫是
  **有真实降级动作的活分支**（9 处：trimHistory 缺失记 warn、deleteMessagesByTimestamps 缺失
  推 error、getFullHistory 缺失回落 getHistory……）。按「要么补齐」去做会删掉这 9 条降级路径
  并把第三方后端门槛一次抬满。**结论：不补齐**，在契约注释里写清差异即可。

- **`unregister` 两参语义在 `api-commands` 通路上零覆盖**。实测把调用点改回单参，
  1174 个用例**无一变红**、tsc 也不红（少传参数是类型兼容的）。而真改回去，
  `stack.splice(0)` 会在任一插件卸载时把同名指令的全部声明连根删除——正是 38fbd22e 修的病。
  唯一的测试替身 `commands-api-helper.test.ts` 的 `unregister` 仍是单参、忽略第二个实参。
  **修法**：加一条端到端用例（ctxA/ctxB 各注册同名 `ping`，dispose ctxB 后断言 ctxA 的仍在）。

## 三、性能：优先级排错了

**更正**：上一版说「若要再动 user-relation 的性能，级联删除这里才是」——不对。

- 级联删除每节点 2 次全图读属实（`loadAll` 一次 + `deleteMergeRejectsByNode` 一次）。
  但「1400 次」在当前配额下**不会发生**：evictByQuota 触发线 300/600/300/2400，
  实测计数 243/536/287/2241 全部低于触发线，实测触发 0 次。
- **真正的热点是每条消息 ≈4 次全图读**：middleware 一次 + extractor 两次 + isOverQuota 一次，
  而 `triggerEveryNMessages=1`。实测单次 `listMetadata('user-relation')` 中位 **177ms**
  （3352 文档 / 38.7MB，mongodb 后端），即每条消息 ≈0.7s 花在读全图上。
- 顺带：`mergeNodes` 每个 alias 多付一次重复级联（`mergeAlias` 已负责物理删除），
  合并 5 个 alias 白烧 ≈1.8s。**这条是纯浪费，最该先删。**
- 另：`relation.cleanup.all` 逐节点级联（≈2132 次全图读 ≈110s），而 `store.clearAll()` 现成——
  三行的事。

**量纲提醒**：「省下的 1 次」是**每条消息**省一次，「1400 次」是**一次维护事件**的总量，
两者不同量纲，上一版并列比较导致排序失真。

## 四、复杂度账（数字已更正）

上一版的三个数字**均不可复现**。按同一区间（`aad37b12..18787bc9`）重算：

| | 上一版 | 实测 |
|---|---|---|
| `packages/**/src` 代码净增 | +161 | **+935** |
| 同上 注释净增 | +355 | **+902** |
| `docs/` 净减 | -307 | **-241** |

方向没错且比它自称的更极端（注释增量 : 文档减量 ≈ 3.7:1），但「三个 agent 独立统计得到同一
结论」这句的可信度要打折——三个数没一个对。**教训改写为**：统计口径（含不含注释 / 测试 /
哪个区间）必须写进括号，否则同一件事在不同口径下能差 3 倍以上。

上一版举的例子「help.ts 的文件头注释比 roadmap 更失准」**已失效**：它在 `e8124058` 就被回改了，
比写下那份文档早 10 个提交。逐句核对当前头注释，全部成立。

注释膨胀点（建议压缩，非缺陷）：`api-memory` 的「结构化元数据存储」块占该文件 16.8%
（含 818× benchmark 与 ORM 选型，属实现侧决策不属契约）；`SPEC_ARGV_BUDGET` 的 16 行
ARG_MAX 论证在 **4 处**调用点复述（不是 1 处）；「rehype-raw 被实测推翻」写在 **3 处**
（markdownConfig.tsx / help.ts / docs/roadmap/commands.md，不是 2 处）。

## 五、零散（低）

- **`isSymmetricRelation`**：零生产调用点、靠自己的单测续命、knip 看不见。
- **`plugin-authority` 的 `riskToLevel`**：同形——3 行的 `capabilityMinLevel` 转发壳，
  零生产调用点。**未删**，因为有 6 处文档把它当 risk→等级的权威出处引用，删它要连带改文档；
  正解是上面「后端下发 minLevel」那个更大的决定，届时一并处理。
- **幽灵分组回收只挂在 `unregisterByPlugin`**，直接 `unregister` 仍留幽灵（真实卸载路径走前者）。
- **别名在 `materialize` 里只取栈顶**：底层声明的别名解析得到却不展示。
- **`ctx.provide` 收 `unknown`**，`ServiceTypeMap` 不校验实现——补 declare 只解决了消费侧手抄
  类型，提供侧写错依然不报错。可加一条类型重载收口（纯编译期），但需先测量它会让多少现存
  provider 变红。
- **`koishi-compat.md`** 仍引用已删除的 `packagesDir()` 并给出失效行号；该文所有 Aalis 侧事实
  都需在实施前重核（包名、指令系统机制、市场关键词数量均已变）。

**更正**：上一版说「25 包改名后约 20 处文档/core 源码注释仍写旧命名」——实测源码与文档里
**0 处**（只剩 CHANGELOG 5 处，属历史记录，不该改）。真正的残留是 `vitest.config.ts` 的
`packages/*-api/**` 死 glob（已修）。

## 六、本轮新发现（增量审计，未修）

- **重启成功路径的终端复原顺序**（`986ba959`）：父进程改成「等子进程 ready 再退」之后，
  它的终端复原钩子跑在子进程已接管终端之后，新实例的 TUI 当场被踢出备用屏。
  修法是 spawn 前摘掉钩子（回滚分支保持原样）。**未修**——重启路径无法在离线单测里验证，
  盲改风险大于收益。
- **卸载留下幽灵前端候选**（`1111eaa7`）：`discoverAndProvideClients` 只增不删，而卸载在本批
  改成真删 `node_modules`，于是留下指向已删目录的候选与已注册的 provider。
  修法是卸载成功后同样对账一次。**未修**——同上，需真实装卸链路验证。

## 七、待决策（不是缺陷）

- **指令声明栈是否该回退**成「同名注册直接拒绝」。事实前提更正：本仓实际注册点 **48** 条
  （不是 42），互不重名；`.alias()` **生产 0 处、测试 9 处**（不是「全仓 0 处」，回退成本要算上
  改测试）。行数三个口径差很大：源码净 +71 行（其中注释 +49、代码 +20），测试 +149 行——
  上一版并列的「省 66 行」与「+28 行」量的不是同一个东西。另注意威胁模型是**第三方插件**
  注册同名指令提权，本仓 0 重复本就是预期，不构成「服务的是从未发生的条件」的反驳。
- **预检副本是否该回退**。三条前提全部实测成立：env 确实能压过项目级 `.npmrc`；
  副本确实丢掉项目 `.npmrc` 的 registry/authToken（**私有源用户的预检会对着公共源下结论**，
  最小修法是把 `.npmrc` 一起 cp 进副本）；`--dry-run` 污染隐藏锁这条缺口确凿存在
  （实测：dry-run 后 `node_modules/.package-lock.json` 已被改写成新版本，紧接着真装会
  「up to date」空转），所以**副本不能整体回退**。
- **25 个契约包改名是否划算**。已发布，不回退，记此以免后来者以为无代价。

## 相关文档

- 安全模型：[`docs/concepts/security-model.md`](../concepts/security-model.md)
- 服务模型：[`docs/concepts/service-model.md`](../concepts/service-model.md)
