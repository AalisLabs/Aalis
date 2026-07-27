# Koishi 插件兼容层 — 调研结论、可行性实证与实施方案

**技术前提已全部实测跑通，桥插件本身尚未动工。** 九个 PoC 脚本全绿：模块加载、最小 Context、
FakeBot 收发、真实插件装载、数据库、生命周期装卸、边界情形、日志接管、跨目录隔离。剩下的工作
是把这些接到 Aalis 的四个桥接点上。

以下每条数据均来自 2026-07 的实际运行与源码核对，并标注了包名与版本；调研统计另标样本量与口径。
记录根因与实现路径，避免后续重新调查。

PoC 产物是一个独立的 npm project（`step2-minimal` / `step3-fakebot` / `step4-real-plugins` /
`step5-database` / `step5b-persist` / `step6-lifecycle` / `step7-edge` / `step8-logging` /
`step9-surface` + `fake-bot.mjs`），跑在 scratchpad 里，**未入库**。

## 版本基线

| 包 | 版本 | 角色 |
|---|---|---|
| `koishi` | 4.18.11 | 元包。`lib/index.d.ts` 只有 4 行 re-export，无自身 API |
| `@koishijs/core` | 4.18.11 | 真正的 API 面（788 行 `.d.ts`） |
| `@satorijs/core` | 4.6.0 | 消息 / Bot / Session 底座 |
| `cordis` | 3.18.1 | DI 内核 |
| `minato` | 3.7.0 | 数据库抽象 |
| `schemastery` | 3.18.0 | 配置 Schema |
| `@satorijs/element` | 3.2.0 | 消息元素 `h` |
| `@koishijs/loader` | 4.6.11 | 配置文件加载器（`koishi` 元包的另一半） |

cordis 的 npm `latest` 已经是 `4.0.0-rc`，而 Koishi 4.18 仍锁 3.x。**沙盒必须让 Koishi 自己
解析整棵依赖树，任何一项都不手工提升。**

## 生态调研

### 约四分之三的插件根本不碰数据库

npm 市场 4426 个 Koishi 包里，声明依赖 `database` 的是 522 个（11.8%）。在下载量靠前的 114 个
热门插件样本里，`ctx.model.extend` 命中 25%、`ctx.database.get` 命中 26%。

这条决定了铺开顺序：**不需要 database 的插件是第一批目标，不需要为它们准备任何存储适配。**
需要 database 的那部分也不难 —— 直接给 minato 的 sqlite driver 即可（见下），同样不需要 Aalis 侧适配。

### API 使用高度集中在十来个入口

同一 114 个插件样本，按「用到该 API 的插件数」计：

| API | 插件数 | API | 插件数 | API | 插件数 |
|---|---|---|---|---|---|
| `ctx.on` | 67 | `ctx.model` | 28 | `ctx.emit` | 13 |
| `ctx.command` | 57 | `ctx.console` | 27 | `ctx.schema` | 7 |
| `ctx.logger` | 52 | `ctx.i18n` | 26 | `ctx.effect` | 6 |
| `ctx.database` | 38 | `ctx.inject` | 23 | `ctx.permissions` | 5 |
| `ctx.http` | 35 | `ctx.middleware` | 23 | `ctx.before` | 5 |
| `ctx.plugin` | 34 | `ctx.bots` | 23 | `ctx.bail` | 2 |
| `ctx.baseDir` | 30 | `ctx.setInterval` | 22 | | |
| | | `ctx.setTimeout` | 20 | | |
| | | `ctx.root` | 16 | | |
| | | `ctx.scope` | 15 | | |

`ctx.scope` / `ctx.effect` / `ctx.root` 这一组是 cordis 的作用域原语 —— 它们的语义（fork、
disposable 传播、reusable）**没有等价的 Aalis 概念可映射**，是「重新实现 API 表面」这条路上
第一块硬骨头。

### Schema 是硬需求，`apply` 与 `Config` 是事实标准

同样本的声明形态占比：

| 形态 | 占比 | 备注 |
|---|---|---|
| `Schema.object` | 89% | schemastery，无可替代 |
| `export const Config` | 28%（含编译形式共 77%） | |
| `export function apply` | 41%（含编译形式共 75%） | |
| `export const inject` | 26%（含 `static inject` 共 58%） | |
| `export const name` | 38% | |
| `export const usage` | 25% | |
| `declare module 'koishi'` | 13% | 类型层扩展，运行时无痕 |
| `class extends Service` | 10% | |
| `export const reusable` | 4% | |
| `export const using` | 2% | 已弃用但运行时仍支持：`plugin['using'] \|\| plugin['inject']` |

89% 这个数字是「重新实现 API 表面」方案的判决书：**不实现 schemastery 就等于不兼容。** 而
schemastery 不是一个可以近似的东西 —— `koishi-plugin-novelai` 单包就有 169 处 Schema 调用。

### Session 字段的实际使用面

| 字段 | 插件数 | 字段 | 插件数 | 字段 | 插件数 |
|---|---|---|---|---|---|
| `send` | 45 | `selfId` | 27 | `event` | 24 |
| `userId` | 45 | `messageId` | 27 | `isDirect` | 20 |
| `channelId` | 39 | `content` | 25 | `user` | 19 |
| `platform` | 36 | `text` | 24 | `username` | 19 |
| `bot` | 35 | | | `execute` | 16 |
| `guildId` | 33 | | | `prompt` | 15 |

这十六个字段就是 FakeBot 必须喂对的全部入站面。`send` / `prompt` / `execute` 三个是出站与
交互面，PoC 已全部验证可用。

### 生态里最有价值的两类插件根本不是 Koishi 插件

这是整个调研最关键的一条结构性发现。

`@koishijs/plugin-adapter-onebot@6.0.2` 的 `dist.unpackedSize` 只有 3702 字节，`dependencies`
仅 `{'@satorijs/adapter-onebot': '^6.0.2'}` —— 整包 27 行，内容是 `export * from '@satorijs/adapter-onebot'`，
真身是 satori 的一个 `Bot` 子类。

`@koishijs/plugin-database-sqlite@4.7.0` 的 `lib/index.mjs` 编译产物只有三条语句：
`import { SQLiteDriver } from '@minatojs/driver-sqlite'` → `var index_default = SQLiteDriver`
→ `export default`。真身是 minato 的一个 `Driver` 子类。

**要兼容它们，需要实现的是 satori 的 Bot 协议（12 个必需方法）和 minato 的 Driver，与 Koishi
的插件协议毫无关系。** 而 Aalis 已经有自己的 OneBot 适配器（`packages/plugin-adapter-onebot`）
与四个 memory 后端（`plugin-memory-sqlite` / `-mongodb` / `-inmemory` / `-vector`）——
**这两类明确排除在兼容目标之外**，不是能力不足，是重复建设。

### 包装式兼容层会被猴补和私有字段当场击穿

`koishi-plugin-dialogue` 直接改原型：`Context.prototype.getSessionState = ...`。
`koishi-plugin-booru` 直接读私有字段：`ctx.i18n._data`。

任何用 `Proxy` 或窄门面包装 Context 的方案，在这类插件上是**硬崩，不是降级** —— 猴补落在包装
对象的原型上而真实调用走的是内部对象，私有字段在窄门面上根本不存在。这两个都不是边缘插件。

## 方案选型

### 被否决：重新实现 Koishi API 表面

要自己写出 schemastery（89% 的插件必需）、`h` 元素系统、cordis 的 scope / effect / fork /
reusable 语义、i18n 全套，还要应付上面那些猴补与私有字段访问。

否决理由不是工作量，是**每一处都是「像但不是」**。Schema 的默认值补全时机、fork 的 disposable
传播顺序、`h` 的转义规则 —— 任何一处语义漂移都会以「这个插件在 Koishi 里能跑，在 Aalis 里行为
不对」的形式暴露，而排查成本落在 Aalis 这边。这是一条无底洞。

### 被否决：移植辅助（转换工具）

产出一个把 Koishi 插件源码转成 Aalis 插件的工具。

否决理由：**产物是一次性快照。** 上游插件更新后立即分叉，维护责任落到 Aalis 这边，且原作者不会
接受一份自动生成的分支。同时，预期极少有插件作者会主动移植 —— 移植的收益归 Aalis，成本归作者。

### 选定：嵌入真实 Koishi 内核

不做任何模拟 —— 直接在同一进程里给插件一个**真的 Koishi 环境**：真的 `Context`、真的
schemastery、真的 `h`、真的 cordis、真的 minato。

这条路把上面三个问题一次性解掉：猴补与私有字段天然工作（因为那就是真对象）；语义零漂移（因为
就是上游代码在跑）；上游更新只需 `pnpm add` bump 沙盒里的依赖，Aalis 这边零改动。

代价是引入一份 Koishi 依赖树。实测这份代价可控（见下），且**完全隔离在沙盒目录里，Aalis 主仓
零 koishi 依赖**。

## PoC 实证结果

### 体积与冷启动都不构成障碍

只装 `koishi`：23M / 163 个包。只装 `@koishijs/core`：6.1M / 63 个包。

23M 的大头是 `@koishijs/plugin-server`（zod 5M + koa 全家桶），但**它不会被自动加载** —— 装在
磁盘上不等于跑在进程里。

冷启动到首条消息往返：**平均 6.8ms**。这个数字后面还会再用到一次（见「`ctx.stop()` 是终态」）。

### 最小可用嵌入面比预期小得多

`new Context({})` —— 空配置即可，schemastery 会自动补齐全部默认值。`start()` 零报错，
`stop()` 后进程能自然退出。

**开箱不带的东西比想象中多**：`ctx.http` / `ctx.database` / `ctx.server` 全是 `undefined`；
`help` 是独立插件 `@koishijs/plugin-help`，**不在 core 里**。需要哪个就 `ctx.plugin()` 装哪个，
这反而是好事 —— 嵌入面可以按需收窄。

### 四个真实插件跑通

- `@koishijs/plugin-echo@2.2.5`：`echo hello` → `hello`；缺参数走 i18n 提示；`-E` 选项正常。
  **i18n 数据是插件自带的，宿主无需补任何语言包。**
- `@koishijs/plugin-help@2.4.6`：正常。
- `@koishijs/plugin-repeater@1.1.3`：纯 middleware 路径，正常。
- `koishi-plugin-novelai@1.27.0`：`inject: { required: ['http'] }` 被 `plugin-http` 满足，
  指令注册成功。这是「有真实依赖门的复杂插件」样本。

装载必须过一层 `unwrapExports`（`m?.default || m`）：`plugin-http` 用 `default` 导出，
`echo` / `help` 用 `apply` 具名导出，**两种形态在官方插件里都存在**。

### FakeBot 最少只需三件事

1. `super(ctx, config, platformName)` —— 第三个参数同时成为 `bot.platform`；
2. 给 `this.user.id` 赋值 —— `@satorijs/core@4.6.0` 在 `lib/index.cjs:573` 把
   `Bot.prototype.selfId` 定义成 `["user", "id"]` 的访问器，赋 `user.id` 即得 `selfId`；
3. 覆写 `createMessage` —— 覆写它即同时接管 `sendMessage` / `session.send` / `broadcast`
   三条出站路径。

**不需要实现 `Adapter` 类** —— 基类里对 adapter 的调用全是 `this.adapter?.` 可选链。

一个必须知道的细节：`@koishijs/core@4.18.11` `lib/index.cjs:812` 有
`if (session.selfId === session.userId) return;` —— **`selfId` 必须区别于 `userId`**，
否则消息被当成自己发的，静默丢弃。

### 消息进出各有一个明确信号

入站：`bot.dispatch(bot.session({ ... }))`。

出站完成：监听 `'middleware'` 事件、按 `session.id` 配对。`@koishijs/core@4.18.11`
`lib/index.cjs:845` 在 Processor 的 `finally` 块里 `this.ctx.emit(session, "middleware", session)`
—— 此时 `session.send` 已经完成，是可靠的完成信号。

富元素完整保留：`img` / `at` / `quote` 以完整 `h` 结构交到宿主，**不是被压平的字符串**，
宿主可以自己决定怎么渲染成 Aalis 的 `segments` / `attachments`。`session.prompt()` 的多轮会话
也正常工作。

未实现的可选 Bot 方法（`createDirectChannel` / `getGuildList` / `getMessage` 等）**优雅降级**：
插件收到 i18n 提示文案而非崩溃。

### 数据库：WASM sqlite + `baseDir` 圈定

`@minatojs/driver-sqlite@4.7.0` 是 **WASM 版 sql.js，无原生编译** —— 不需要 node-gyp，不受
Node 版本变动影响，装即可用。

路径行为：传绝对路径直接生效；传相对路径则走 `resolve(ctx.baseDir, path)`。**宿主设好
`ctx.baseDir` 就能把 koishi 的所有相对路径圈进沙盒**，实测有效，宿主 cwd 下无任何杂散文件。

功能面：`ctx.model.extend` + `create` / `get` / `set` 全通；`user` / `binding` / `channel`
三张内建表自动建；重启后数据读回正常（`step5b-persist`）。

### 装卸零泄漏

`fork.dispose()` 三轮装卸循环后，指令数 / middleware 数 / i18n 条目数 / disposables 数 /
hook 总数**精确回到基线，零泄漏**。

`ctx.setInterval` 与 `ctx.on('dispose')` 两种定时器都随 scope 正确释放。`ctx.stop()` 后端口
正确释放，进程 `exit 0` 无悬挂 handle。

**这条是「Koishi 插件能不能在 Aalis 里热装热卸」的直接答案：能。**

### 日志可以 100% 接管

`Logger.targets` 是 reggol 的**进程级全局静态数组**（`reggol@1.7.1` `lib/shared.js:112`
`static targets = [...]`，`:181` 处遍历它输出）。把它整个替换掉即完全接管：实测 31 条日志
全部进了宿主回调，**stdout 上 koishi 一个字都没写**。

`record.meta.ctx` 可用于多实例分流。

### 多实例与目录隔离都成立

同进程两个独立 `Context` 完全隔离，停掉 A 不影响 B。

隔离形态已验证：宿主目录**自身零 `node_modules`**（在宿主目录 `require('koishi')` 报
`MODULE_NOT_FOUND`），koishi 本体与全部插件住在一个独立目录（该目录本身是个 npm project），
宿主用 `createRequire(resolve(SANDBOX, 'noop.js'))` 加载 —— 跨目录跑 echo / help 全部正常。

## 两个必须知道的坑

### 坑一：koishi 的 ESM 入口是坏的

`import { Context } from 'koishi'` 在 Node ESM 下直接崩：

```
@koishijs/loader/lib/index.mjs:23
TypeError: Class extends value #<Object> is not a constructor or null
```

根因：`@koishijs/loader@4.6.11` 的 ESM 产物在 `lib/index.mjs:15` 写
`import Loader from "./shared.js"`，而 `shared.js` 是 CJS —— Node 的 default interop 把整个
`module.exports` 对象给回来，而不是 `.default`。于是 `:23` 的 `var NodeLoader = class extends Loader`
在一个普通对象上做 `extends`，当场炸。

**绕法：`createRequire(import.meta.url)('koishi')`。CJS 入口完全正常。**

连带的**双包陷阱**：`@satorijs/core` 有 exports map，直接 ESM import 会拿到**第二份** `Bot` 类
（实测 `satoriEsm.Bot !== require('koishi').Bot`）。**宿主必须全程走 CJS 图**，一处混用 ESM
就会出现「instanceof 不成立、原型上的猴补看不见」这类极难排查的症状。

### 坑二：`ctx.stop()` 是终态

停了**不能再 `start()`** —— `stop` 会 reset root scope，`ctx.satori` 永久消失，此后再
`ctx.plugin()` 一个 Bot 直接 `TypeError: ... reading '_loginSeq'`。

**热重载只能丢弃整个 Context 重建。** 好在重建只要 7ms（见上），所以这不是问题，只是必须知道
的形状 —— 任何「先 stop 再 start」的写法都是错的。

另一个次生坑：**必须先 dispose bot / adapter 的 fork，再 `ctx.stop()`**。顺序反了的话 root
scope 先拆掉 satori 服务，`Bot.dispose()` 里 `this.ctx.bots` 已是 `undefined`，报
`TypeError: Cannot read properties of undefined (reading 'findIndex')`。该错误非致命（被 cordis
吞成 `internal/error`），但每次停机都会打一段栈。

## 实施方案

### 形态：同进程桥插件 + 独立沙盒 project

一个普通的 Aalis 插件 `plugin-koishi-compat` 作为桥，**同进程**嵌入 koishi —— 不是子进程、
不是 IPC，全程在内存里传对象。

桥插件代码在 `packages/`；koishi 沙盒在运行时数据目录下，**沙盒自身是一个独立的 npm project**
（有自己的 `package.json` / lockfile / `node_modules`），**Aalis 主仓零 koishi 依赖**。

沙盒具体路径做成插件配置项。**默认值未决**，候选两个：
- `data/koishi/` —— 与 lancedb（`plugin-vectorstore-lancedb` 默认 `data:/lancedb`，见
  `packages/plugin-vectorstore-lancedb/src/index.ts:46`）等同级；
- `data/plugins/koishi-compat/` —— 走 storage 的 `pluginData` 根规范位置（`plugin-storage-local`
  把 `pluginData` 根映射到 `data/plugins`，见 `packages/plugin-storage-local/src/index.ts:178`）。

### 四个桥接点（均已 PoC 验证）

| 桥接点 | Aalis 侧 | Koishi 侧 |
|---|---|---|
| 模块加载 | `createRequire` 指向沙盒 + `unwrapExports` | CJS 图，避开坏 ESM 入口 |
| 消息入 | `inbound:message` 事件 | 造 satori Event → `bot.dispatch` |
| 消息出 | 转 `OutgoingMessage` | 覆写 `Bot#createMessage` |
| 生命周期 | 插件 `apply` 建 Context、`ctx.onDispose` 拆 | 先拆 bot fork，再 `ctx.stop()` |

`inbound:message` / `OutgoingMessage` 的定义在 `packages/plugin-message-api/src/index.ts:246`
（`OutgoingMessage`）与 `:299`（事件签名）。插件的 `apply(ctx, config)` 契约见
`packages/core/src/types/plugin.ts:60`，`ctx.onDispose` 见 `packages/core/src/context.ts:595`。

另加两条：日志接管（替换 `Logger.targets`）与存储落位（`ctx.baseDir` + sqlite driver path）。

### 指令统一挂 `/koishi` 前缀

Koishi 指令全部注册成 `koishi.<name>`。

理由：Aalis 的指令注册是**后者覆盖前者** —— `packages/plugin-commands/src/commands.ts:101-110`
在重名时只打一条 `logger.warn`，随后清空旧节点的 aliases / options / handler 并让新的接管，
注册照样成功。而 `help` / `status` / `echo` 这类常见名两边都有（Koishi 的 `@koishijs/plugin-help`
和 `plugin-echo` 就是最先跑通的两个），混注会导致 `/help` 被静默顶掉，且排查极难 —— 那条 warn
埋在启动日志里，症状却是「运行几周后某天发现帮助不对了」。同目录 `commands.md` 记了这条的全貌。

代价明确：**与 Koishi 插件自己的文档不一致**（文档写 `echo hello`，在 Aalis 里要打
`/koishi echo hello`）。这是有意付出的代价，前缀做成配置项供用户自己权衡。

### `/help` 里只占一个顶层条目

Koishi 指令作为**一个**顶层条目出现在 Aalis `/help` 概览里：

```
- `/koishi` — Koishi 兼容插件指令 · 12 个子指令
```

这样概览长度不随 Koishi 插件数量膨胀，符合 `renderOverview` 现有的「只列顶层节点、深度 ≥1 一律
不进概览」设计（`packages/plugin-commands/src/help.ts:73-92`）。

实现上有一个必须做对的细节：**`koishi` 这个顶层节点要显式声明**（`service.command('koishi', 'Koishi 兼容插件指令')`）。
若只注册子指令，`ensureGroups` 会造一个 `declared: false` 的占位节点
（`packages/plugin-commands/src/commands.ts:168-178`），而 `isGroup` 取 `!node.declared`
（`:371`）、`isPlaceholderGroup` 取 `isGroup && !handler`（`help.ts:39-41`）—— 结果概览里只会
渲染成「`/koishi` — 12 个子指令」，描述被整条丢掉。

### 市场加一路 Koishi 检索

Aalis 市场是**纯 npm 路线**：直接打 registry 的 `/-/v1/search` API，按类型关键词分类
（`packages/plugin-webui-server/src/routes/marketplace.ts:17` 的 `AALIS_KEYWORDS` 四类，
`:337` 的 `buildSearchUrl`，`:402` 用 `Promise.allSettled` 并发打四路）。

**加 Koishi 来源只需多打一路搜 `keywords:koishi-plugin`，结果标记来源。** 三处天然隔离：

- **分类**：`classifyPackage`（`:96`）按类型关键词判定，Koishi 包命中不了任何 `aalis-*` 关键词；
- **安装位置**：装进沙盒 project，而非 `package-manager` 的 `packagesDir()`
  （`packages/plugin-package-manager/src/index.ts:80`）；
- **加载**：Aalis 加载器是纯 `aalis-plugin` 关键词正向门
  （`packages/runtime/src/node-modules-loader.ts:35-37`，`providers.ts:251` 复用同一判定），
  Koishi 包不带该关键词，**不可能被误加载**。

需要注意的是 `classifyPackage` 目前假定「结果只含四类之一」，加入第五类来源后这个前置条件不再
成立 —— 来源标记必须在进入分类之前打上，不能靠 `classifyPackage` 的 `return 'plugin'` 兜底。

### 覆盖预期分层

| 层 | 状态 | 说明 |
|---|---|---|
| 不碰数据库的插件（约 3/4） | 已实证 | 第一批目标，echo / help / repeater 已跑通 |
| 需要 `database` 的插件 | 已实证 | 直接给 minato sqlite driver，Aalis 侧零适配 |
| 需要 `ctx.server` / console 生态（WebUI 扩展类） | **未验证** | 27/114 用 `ctx.console`，是最大的未知块 |

## 未决项

以下五条需要拍板，本文不替用户决定：

1. **沙盒目录默认位置** —— `data/koishi/` 还是 `data/plugins/koishi-compat/`（两者各自的依据见
   「形态」一节）。
2. **`/koishi` 前缀** —— 是否可配、默认值是什么。可配意味着用户可以改成空前缀从而重新引入重名
   覆盖风险。
3. **Koishi 插件的配置面板是否接进 Aalis WebUI** —— 需要一层 schemastery Schema → Aalis
   ConfigSchema 的**降级转换**（schemastery 表达力更强，转换必然有损）。不做的话 Koishi 插件
   只能改沙盒里的配置文件。
4. **Koishi 侧 database 与 Aalis 的 memory 是否需要互通** —— 目前设计是两套完全独立的存储，
   Koishi 插件写自己的 sqlite。互通与否影响的是「Koishi 侧的用户/频道表要不要和 Aalis 的
   user-profile 对齐」。
5. **console 生态是否纳入范围** —— 即上表第三层。纳入则需要先验证 `@koishijs/plugin-console`
   在嵌入形态下能否工作，以及它自带的 HTTP 服务与 Aalis 的 `webui-server` 如何共处。
