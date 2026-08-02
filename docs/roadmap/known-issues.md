# 已知问题

2026-08 一批改动（市场重构 / 指令声明栈 / metadata 契约 / 两次包改名）之后跑了四轮对抗审计，
随后又跑了一轮**对那份记录自身的对抗核实**（42 个 agent，逐条重推 + 独立复核），据此修掉了
一批、更正了一批失实数字、并补进了新发现的条目。本文只留**当前仍未解决**的。

体例：每条附实测依据与当前位置；**不附行号**——行号会随重构整体漂移而静默失准，
位置请以符号名现场 grep 为准。（`docs/roadmap/commands.md` 仍是行号体例，实测 17 处引用里
10 处已指向别的代码，读它时先核对。）

> ⚠️ 凡本文的判断，动手前请自己先复现一遍。上一版本文自己就有五处失实（数字错 5.8 倍、
> 举的例子在写下时已被修掉、把一层转发壳数成一份实现），来源都是「未经复现就采信」。

## 一、结构性：同一语义的多份实现

### 权限定级：后端一份，WebUI 自带第二份

`api-authority` 的 `capabilityMinLevel` 是后端唯一实现；`plugin-webui-client` 的
`derivedMinLevel` 是真正的拷贝——对 `@aalis/api-authority` 零引用、`0/1/2` 硬编码。
（`plugin-authority` 的 `resolveMinLevel` 只是 `override ?? capabilityMinLevel(opts)` 的
转发壳，它承载的 overrides 优先级本就该住在 authority 里，**不该删**。）

**已发生的分歧**：枚举 risk × visibility 全组合实测，契约域内 12 组全同，域外 3 组分歧，
形如「risk 是非联合成员的真值串 + `visibility:'restricted'`」：后端 2、前端 0。根因是结构不同
——后端三个 `===` 都不中就落 visibility 兜底，前端是 `if (op.risk) return riskToLevel(op.risk)`，
**只要 risk 为真就再也不看 visibility**。方向是 fail-open 的显示：第三方 JS 插件把 `risk`
拼错，权限页会显示「所有人可用」。

**测试挡不住漂移**：把 `RESTRICTED_LEVEL` 由 2 改 3，8 个后端用例变红、前端那 7 个全绿，
而红的都是「后端函数 vs 字面量 2」，改字面量即转绿，漂移被「测试已修好」的假象盖住；
加一档 risk 则连这层偶然告警都没有。另注意 `capabilityMinLevel` 里 dangerous/sensitive 是
写死的 2/1，`RESTRICTED_LEVEL` 并不是能单独拧的旋钮（改成 3 会让「restricted 无 risk」
比「dangerous」更严）。

**方向（未定）**：`getOverview` 对每条 operation 多下发一个后端算好的 `minLevel`
（payload 已在下发 `risk`/`visibility`，加两行即可），前端删掉自己那份、`effectiveMinLevel`
只留 override 覆盖。**未做**——该值纯显示、从不回写，复核已把严重度从 medium 下调 low，
属改进不是修 bug。做这一条时顺手删掉 `plugin-authority` 的死 `riskToLevel`（3 行转发壳、
零生产调用点，但有 6 处文档拿它当权威出处，单独删不划算）。

### 「关键词 → 包类型」四份实现

`plugin-package-manager` 的卸载闸、`marketplace.ts` 的 `classifyPackage` 与
`classifySystemComponent`、`node-modules-loader.ts` 的 `isLoadablePlugin`——四者优先级各不相同。

两条分歧当前都**不是活缺陷**：
- 同时带 `aalis-plugin` 与 `aalis-api` 的包会被加载器加载、却在市场页渲染成只读「API 契约」卡。
  实测全仓 99 个包无一带两个类型词，是「等一次误打词」的隐患（`tools-api` 曾发生过一次）。
- 无任何 aalis 关键词 → `classifyPackage` 兜底成 `plugin`，与服务层闸结论相反，但**端到端
  不可达**：在线路径的输入只来自 5 条 `keywords:` 检索（实测 npm 过滤严格、零漏网），
  离线降级路径显式过滤。属「兜底的正确性靠调用点约束」的潜在耦合。

**方向**：抬成唯一一份纯函数，`aalis-plugin` 置最高优先级（它是加载器判据）。要防复发可加
一条 architecture 测试：每包类型词数量恒为 1（脚手架/示例白名单）。

## 二、性能：真正的热点

**每条消息 ≈4 次全图读**：middleware 一次 + extractor 两次 + `isOverQuota` 一次，而
`triggerEveryNMessages=1`。实测单次 `listMetadata('user-relation')` 中位 **177ms**
（3352 文档 / 38.7MB，mongodb 后端），即每条消息 ≈0.7s 花在读全图上。**这是唯一还没动的
大头**——`mergeNodes` 的重复级联与 `cleanup all` 的逐节点级联已修。

顺带更正两处旧记载：级联删除每节点 2 次全图读属实，但「1400 次」在当前配额下**不会发生**
（evictByQuota 触发线 300/600/300/2400，实测计数 243/536/287/2241 全部低于触发线，触发 0 次）；
且「每消息省 1 次」与「一次维护事件 1400 次」不同量纲，并列比较会让优先级排反。

## 三、契约与调用侧

- **`api-memory` 必填化只做了 4/11 是对的，不是欠债**。另 7 个方法的守卫是**有真实降级动作
  的活分支**（9 处：trimHistory 缺失记 warn、deleteMessagesByTimestamps 缺失推 error、
  getFullHistory 缺失回落 getHistory……）。按「要么补齐」去做会删掉这些降级路径并把第三方
  后端门槛一次抬满。**结论：不补齐**，在契约注释里写清「metadata 面没有可用降级，故必填；
  其余七个有明确降级语义，故可选」即可。

## 四、复杂度账

本批实测：`packages/**/src` 代码净 **+935** 行、注释净 **+902** 行，`docs/` 净 **-241** 行。
（上一版记的 +161 / +355 / -307 三个数字均不可复现，已更正。）方向没错且比原记载更极端
——注释增量 : 文档减量 ≈ 3.7:1，「精简」只发生在 `docs/`。

**教训**：统计口径（含不含注释 / 测试 / 哪个区间）必须写进括号，否则同一件事在不同口径下
能差 3 倍以上（本例 20 / 71 / 220 三个数都"对"）。

注释膨胀点（建议压缩，非缺陷）：`api-memory` 的「结构化元数据存储」块占该文件 16.8%
（含 818× benchmark 与 ORM 选型，属实现侧决策不属契约）；`SPEC_ARGV_BUDGET` 的 16 行
ARG_MAX 论证在 **4 处**调用点复述；「rehype-raw 被实测推翻」写在 **3 处**
（markdownConfig.tsx / help.ts / docs/roadmap/commands.md）。

## 五、零散（低）

- **别名在 `materialize` 里只取栈顶**：底层声明的别名解析得到却不展示。
- **`ctx.provide` 收 `unknown`**，`ServiceTypeMap` 不校验实现——补 declare 只解决了消费侧
  手抄类型，提供侧写错依然不报错。可加一条类型重载收口（纯编译期、零运行时改动），
  但需先测量它会让多少现存 provider 变红。
- **重启成功路径的终端复原顺序**（`986ba959`）：父进程改成「等子进程 ready 再退」之后，
  它的终端复原钩子跑在子进程已接管终端之后，新实例的 TUI 当场被踢出备用屏。修法是 spawn
  前摘掉钩子（回滚分支保持原样）。**未修**——重启路径无法在离线单测里验证。
- **卸载留下幽灵前端候选**（`1111eaa7`）：`discoverAndProvideClients` 只增不删，而卸载在本批
  改成真删 `node_modules`，于是留下指向已删目录的候选与已注册的 provider。修法是卸载成功后
  同样对账一次。**未修**——同上，需真实装卸链路验证。
- **`plugin-webui-server/src/index.ts` 的孤儿注释**：`26e3249e` 删掉系统组件页时留下两行注释，
  现在挂在「插件配置」页上描述一个已不存在的页面。纯删两行。
- **`koishi-compat.md`** 仍引用已删除的 `packagesDir()` 并给出失效行号；该文所有 Aalis 侧事实
  都需在实施前重核（包名、指令系统机制、市场关键词数量均已变）。

## 六、发布前必须拍板：LLM 提供者改名的配置迁移

`fb3ad542` 把三个 LLM 提供者改名（`plugin-{openai,deepseek,ollama}` → `plugin-llm-*`）。
**包名同时是两样东西**：配置树里的键 `plugins.<包名>`，以及 `llm-ref` 的 `provider` 值
（entry contextId = `${ctx.id}/${modelId}`）。改名没有带任何迁移。

本地已实测到后果：旧的 `plugins."@aalis/plugin-deepseek"` 变成没人读的死配置（新插件读到空
配置 → 报「未配置 apiKey」），全部存量 `llm-ref` 指向不存在的 contextId → 整机 LLM 静默全哑。

**当前只影响本地**——三个改名后的包尚未发布（老包 `@aalis/plugin-deepseek@0.9.0` 仍在 npm）。
**一旦发布，每个升级的用户都会以同样方式失效。** 发布前须择一：

1. **配套 rename map 做配置迁移**：加载配置时把旧键与旧 ref 值映射到新名并 warn。约 25 行，
   一张表；代价是这张表要长期维护，且要想清楚条目何时可以退休。
2. **只靠发布说明**：把三条改名与「请手工改 `plugins.*` 键与所有 `provider:` 字段」写进
   release notes / CHANGELOG。零机制，但依赖用户读到。

诊断侧已修（`b661336b`）：`describeLLMFailure` 让失败说清「配置指向 X/Y，当前可用 …」，
不再是无信息的「LLM 服务不可用」。这降低了两种方案的代价，但**不替代**上面的决定。

## 七、待决策（不是缺陷）

- **指令声明栈是否该回退**成「同名注册直接拒绝」。事实前提：本仓实际注册点 **48** 条，
  互不重名；`.alias()` **生产 0 处、测试 9 处**（回退成本要算上改测试）。行数三个口径差很大：
  源码净 +71 行（其中注释 +49、代码 +20），测试 +149 行。另注意威胁模型是**第三方插件**
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
