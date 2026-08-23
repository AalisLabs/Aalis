# Koishi 插件兼容层 — 结论与实施方案

**技术前提已全部实测跑通（九个 PoC 全绿），桥插件尚未动工。** PoC 产物是独立 npm project，在 scratchpad 中，未入库。数据采于 2026-07；施工前就地复核 Aalis 侧引用。

## 版本基线

| 包 | 版本 | 角色 |
|---|---|---|
| koishi | 4.18.11 | 元包（4 行 re-export） |
| @koishijs/core | 4.18.11 | 真正的 API 面 |
| @satorijs/core | 4.6.0 | 消息 / Bot / Session 底座 |
| cordis | 3.18.1 | DI 内核 |
| minato | 3.7.0 | 数据库抽象 |
| schemastery | 3.18.0 | 配置 Schema |
| @koishijs/loader | 4.6.11 | 配置加载器 |

cordis 的 npm latest 已是 4.0.0-rc 而 Koishi 4.18 锁 3.x：**沙盒必须让 Koishi 自己解析整棵依赖树，任何一项不手工提升。**

## 调研结论（样本：npm 4426 包全量 + 下载靠前 114 个）

- 约 3/4 插件不涉及 database → 第一批目标零存储适配；其余直接给 minato sqlite driver，同样零适配。
- schemastery 覆盖 89%（novelai 单包 169 处调用）→「重新实现 API 表面」被否：不实现 schemastery 等于不兼容；且 cordis 的 scope / effect / fork 语义无 Aalis 等价物，任何语义漂移都以「在 Koishi 里能跑、在这里行为不对」的形式暴露。
- 猴补与私有字段是常态（dialogue 改 `Context.prototype`、booru 读 `ctx.i18n._data`）→ Proxy / 窄门面方案在这类插件上硬崩，不是降级。
- 「移植转换工具」被否：产物是一次性快照，上游一更新即分叉，维护责任反落 Aalis。
- `@koishijs/plugin-adapter-onebot` 与 `plugin-database-sqlite` 的真身分别是 satori Bot 与 minato Driver，与插件协议无关；Aalis 已有对应能力，**这两类明确排除在兼容目标外**。

**选定：同进程嵌入真实 Koishi 内核。** 真 Context / schemastery / cordis / minato——猴补天然工作、语义零漂移、上游更新只 bump 沙盒依赖。

## PoC 实证要点

- 体积：koishi 全量 23M / 163 包（仅 @koishijs/core 6.1M / 63 包）；冷启动到首条消息往返 6.8ms。
- `new Context({})` 空配置即用；`ctx.http` / `ctx.database` / `ctx.server` 默认 undefined，help 是独立插件——嵌入面可按需收窄。
- 四个真实插件跑通：echo / help / repeater / novelai（含 `inject` 依赖门）。装载需 `unwrapExports`（`m?.default || m`；default 与具名 apply 两种形态官方插件都有）。
- FakeBot 只需三项：`super(ctx, config, platformName)`（第三参即 `bot.platform`）；给 `this.user.id` 赋值（`selfId` 是 `user.id` 的访问器）；覆写 `createMessage`（即接管 sendMessage / session.send / broadcast 三条出站路径）。无需实现 Adapter 类。**selfId 必须 ≠ userId**，否则消息被当成自发、静默丢弃（core 的 dispatch 里有判等 return）。
- 消息入：`bot.dispatch(bot.session({...}))`。出站完成信号：监听 `'middleware'` 事件按 `session.id` 配对（Processor 在 finally 里 emit，此时 send 已完成）。富元素以完整 `h` 结构交宿主；`session.prompt()` 多轮可用；未实现的可选 Bot 方法优雅降级为 i18n 提示文案。
- 数据库：`@minatojs/driver-sqlite` 是 WASM sql.js，零原生编译；相对路径走 `resolve(ctx.baseDir, path)`——设好 baseDir 即把 koishi 全部相对路径圈进沙盒。`model.extend` / CRUD / 内建三表 / 重启持久化全通。
- 装卸零泄漏：`fork.dispose()` 三轮后指令 / middleware / i18n / disposables / hook 全部精确回基线；两类定时器随 scope 释放。热装热卸成立。
- 日志 100% 接管：reggol 的 `Logger.targets` 是进程级静态数组，整体替换即全收（实测 31/31 条，stdout 零输出）；`record.meta.ctx` 可做多实例分流。
- 多实例隔离成立；宿主目录自身零 node_modules，经 `createRequire(resolve(SANDBOX, 'noop.js'))` 跨目录加载验证通过。

## 两处边界（必须照做）

1. **koishi 的 ESM 入口不可用**：`@koishijs/loader` 的 mjs 产物对 CJS 模块做 `extends`，import 即抛 `Class extends value ... is not a constructor`。绕法：`createRequire` 走 CJS 入口。连带双包陷阱：`@satorijs/core` 有 exports map，混用 ESM 会拿到第二份 Bot 类（instanceof 不成立、猴补不可见）——**宿主全程走 CJS 图**。
2. **`ctx.stop()` 是终态**，不能再 start；热重载只能整个重建 Context（重建 7ms，无实际代价）。停机顺序：**先 dispose bot / adapter 的 fork，再 `ctx.stop()`**——反了会在 `Bot.dispose` 里读已拆除的 `ctx.bots`，打一段非致命错误栈。

## 实施方案

**形态**：普通 Aalis 插件 `plugin-koishi-compat` 同进程嵌入（非子进程、非 IPC）；koishi 沙盒是运行时数据目录下的独立 npm project（自带 package.json / lockfile / node_modules），**主仓零 koishi 依赖**。沙盒路径做成配置项，默认值未决（见未决项）。

**四个桥接点**（均已 PoC 验证）：

| 桥接点 | Aalis 侧 | Koishi 侧 |
|---|---|---|
| 模块加载 | createRequire 指向沙盒 + unwrapExports | CJS 图 |
| 消息入 | `inbound:message` 事件 | 造 satori Event → `bot.dispatch` |
| 消息出 | 转 `OutgoingMessage` | 覆写 `Bot#createMessage` |
| 生命周期 | 插件 apply 建 Context、onDispose 拆 | 先拆 bot fork，再 `ctx.stop()` |

另加日志接管（替换 `Logger.targets`）与存储落位（`ctx.baseDir` + sqlite driver path）。

**指令统一挂 `koishi.<name>`**：Aalis 指令重名由后来者接管（`CommandRegistry` 声明栈），而 help / echo 等常见名两边都有，混注会被静默覆盖且难排查。代价是与 Koishi 插件自身文档不一致（要打 `/koishi echo`），前缀做成配置项供用户权衡。实现细节：`koishi` 顶层节点必须显式 `command('koishi', '…')` 声明，否则被 `ensureGroups` 建成占位组、概览丢描述（`isPlaceholderGroup` 判定）。`/help` 概览里只占一个顶层条目，长度不随 Koishi 插件数膨胀。

**市场**：纯 npm 路线多打一路 `keywords:koishi-plugin` 检索，结果标来源。三处天然隔离：分类（`classifyPackage` 命不中 aalis 关键词）、安装位置（进沙盒而非项目根）、加载（`isLoadablePlugin` 纯 aalis-plugin 正向门，不可能误加载）。注意 `classifyPackage` 假定结果只含五类 aalis 关键词——来源标记必须在进入分类之前打上，不能靠它的 `'plugin'` 兜底。

**覆盖分层**：不碰 database 的插件（约 3/4）已实证；database 类已实证（minato sqlite，Aalis 侧零适配）；`ctx.console` / server 生态（27/114 命中）**未验证**，是最大未知块。

## 已拍板（2026-08-23）

1. 沙盒目录默认 `data/koishi/`（可配）。
2. 指令前缀可配，默认 `koishi`；清空前缀会重新引入同名静默覆盖风险，配置描述里写明、用户自担。
3. 一期范围：桥四接点 + 市场 Koishi 检索 + **console 嵌入可行性验证**（先把最大未知块验掉，验完再定是否纳入二期）。
4. WebUI 配置面板一期不做（schemastery → ConfigSchema 转换必然有损）；Koishi 插件配置改沙盒配置文件。
5. Koishi 侧 database 与 Aalis memory 不互通：两套独立存储，Koishi 插件写自己的 sqlite。
