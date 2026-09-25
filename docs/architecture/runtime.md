# @aalis/runtime —— 独立部署运行时（Node 宿主层）

## 它是什么

Aalis 把「内核」和「宿主」分开：

- **`@aalis/core`** = **环境无关内核**。不碰 I/O、不读 `process.env`、不知道 node_modules，
  环境专有件（重启策略、时钟、版本号等）经 `AppOptions` 注入；插件定义与各实例配置由宿主登记时交来（设计理念见 docs/core）。
- **`@aalis/runtime`** = **Node 宿主层**。用 Node API 承担 core 刻意不做的几件事
  （插件发现 / 配置文档 / 重启策略），并提供「一行启动」`startAalis`。

core 是环境无关的逻辑，runtime 是承载它的 Node 实现。要在 Deno / 浏览器 / 嵌入环境中运行，
**另写一个宿主包**实现同样契约即可，core 与各插件契约保持不变（忒修斯之船）。

## Node 专属性 ≠ 包管理器

- runtime 用 `node:fs / module / child_process / process` + 读 `node_modules`，所以它绑定的是
  **Node.js 这个 JS 运行时**。
- **与包管理器无关**：`npm` / `pnpm` / `yarn` 都能用——它们都产出 `node_modules`，runtime 用
  `createRequire`（以**项目根** `package.json` 为基准）解析插件，因此 **npm 扁平 / pnpm 隔离 /
  monorepo 软链** 三种 `node_modules` 拓扑都自洽。
- 区分轴：runtime 名字里的「node」指 **JS 运行时**（Node vs Deno vs 浏览器），不是包管理器
  （npm/pnpm 都属 Node 生态）。将来若出现别的环境宿主，可加后缀（如 `@aalis/runtime-deno`）；
  当前 `@aalis/runtime` = 默认/参考 Node 宿主。

## 设施（exports）

| 导出 | 作用 |
|---|---|
| `startAalis(opts?)` | **一行启动**：读 `aalis.config.yaml` → 组装 `App` 并接上配置文档 → 从 `node_modules` 发现并登记已装插件 → 启动 + 挂 SIGINT/SIGTERM 优雅退出 + 进程级重生。返回 `App`。装配顺序见下节。 |
| `createNodeModulesPluginLoader(projectDir?)` | **独立部署**插件加载器：读项目 `package.json` 的 `dependencies`+`optionalDependencies`，按 `isLoadablePlugin`（**唯一标准：`keywords` 含 `aalis-plugin`**；契约 `aalis-api`/前端 `aalis-interface`/核心 `aalis-core`/工具链 `aalis-runtime`/工具库 `aalis-util` 因不带该词自然排除，无名前缀/service/subsystem 回退、无 marker 排除）发现并动态 import。 |
| `createFsPluginLoader` | **monorepo 自托管**加载器：扫 `<cwd>/packages`，复用同一 `aalis-plugin` 纯关键词正向门。 |
| `createPluginDiscovery(app, loader, doc)` | 发现驱动：`loadAll()` 发现并导入全部插件，按文档取各实例的配置与禁用标记（含 `name:suffix` 实例），整批交给 `app.pluginAll`，返回时已静置；`rescan()` 登记新出现的插件与配置里尚未注册的 `name:suffix` 实例，返回本次新登记的主实例名（定义名），即 `plugin-source` 服务的实现。加载器契约 `PluginLoader`（`discover` / `load` / 可选 `reload`）由本包导出。 |
| `createFsYamlConfigProvider(configPath?)` | 文件系统 + YAML 配置 provider（返回 `{config, provider}`，交给 `createConfigStore`）。 |
| `createConfigStore(initial, provider?)` | 配置文档：内存态加危险键闸，读写方法与 `HostConfig` 相同；落盘委托给 `provider.save`，外部变更经 `provider.watch` 接入。本身不碰文件。 |
| `installHostConfig(app, store)` | 把文档作为 `host-config` 服务独占登记在根激活上，并应用文档里的服务偏好。插件拿到的 `save()` 兑现即已落盘，失败以拒绝传出并已记一笔 error。须在登记任何插件之前调用。 |
| `withPluginConfigSync(loader, app, store, opts?)` | 加载政策：包装加载器，导入定义后、登记前把 `configSchema` 派生的默认值深合并进文档，默认裁剪 schema 外字段。返回 `{ loader, finishInitialLoad }`，首次加载批次在 `finishInitialLoad()` 时合并为一次落盘。 |
| `syncPluginDefaults` / `handleConfigChanged` / `installConfigHotReload` | 同一政策的其余入口，参数均为 `(app, store, opts?)`：为已登记实例补默认值并裁剪；处理外部变更（文件里已没有配置段的后缀实例卸载，其余差异经 `updateConfig` 重建）；接管变更监听，在 `app:stopping` 时停止。 |
| `createProcessRespawnStrategy()` | 进程级重启策略（`app.restart()` → 子进程重生）。 |

`startAalis` 的 `opts`：`configPath`（默认 `cwd/aalis.config.yaml`）、`projectDir`（默认
`process.cwd()`）、`pluginLoader`、`consoleSink` / `fileLog` / `terminalRestore`（默认开）、`subcommands`。

`startAalis` 在加载器导入定义后、Core 注册之前同步插件配置：从 `configSchema` 补齐默认值，
默认裁剪未知字段，再让首次 `apply` 读取该配置。主实例与已配置的复用实例使用同一规则；
`configSync.trimUnknownFields: false` 可保留未知字段。首次加载批次合并为一次保存，后续市场
重扫描也在激活前同步并保存。配置热重载复用相同规则，通过 `updateConfig` 重建有变更的插件，并卸载文件里已没有配置段的后缀实例。
直接组装 `App` 的宿主仍自行决定配置政策；Core 不解释 schema，也不替运行中的实例改配置。

子命令分发是默认行为：argv 非空即子命令模式——`node index.mjs <name> [args]` 等价于聊天里的
`/<name> args`，在 `app.start()` 之前短路执行并退出；首项不是已注册命令时报错退出（exit 2）。两种情况
都不会启动守护进程（打错的命令名若照常起守护，就是与运行中实例并存的第二个实例）。argv 为空才进守护进程。
`subcommands` 只用于宿主自己解析 argv 的场合，传要分发的数组（`[]` 即不分发），默认 `process.argv.slice(2)`。

子命令进程是完整加载全部插件、但与正在运行的守护进程零通信的一次性实例，由此有三条边界：

- 不写 `data/latest.log`（否则会截断守护进程正在写的日志）；日志走 stderr，stdout 只有命令结果，便于脚本消费；
- 没有重启能力：不注入重启策略，`restart` 子命令返回「不可用」而非重启守护进程；
- `status` / `shutdown` 只作用于这个临时实例。写数据的指令按数据落在哪分两类：落在 `aalis.config.yaml`
  的（如 `auto`）经保存触发守护进程的配置热重载，会生效；落在各插件自己内存态并各自落盘的
  （如 `level` 的等级表、`session.*` 的会话覆盖）在守护进程运行期间不会对其生效，且可能被守护进程下次落盘
  覆盖。管理运行中的实例请用聊天指令 / TUI / WebUI。

它仍会完整跑一遍插件 `apply`，因此守护进程运行期间执行子命令会有两处可见副作用：端口型插件（webui-server /
mcp-server）绑定失败并打一条 error 后降级；config-sync 可能按 schema 回填 / 裁剪配置文件，守护进程会因此触发一次热重载。

## startAalis 的装配顺序

1. **文档**：`createFsYamlConfigProvider(configPath)` 读 YAML，`createConfigStore(config, provider)` 建配置文档。
2. **App**：`new App({ name, logLevel, restartStrategy, devMode, now, version })`，`name` 与 `logLevel` 取自文档。子命令模式不注入重启策略。
3. **host-config**：`installHostConfig(app, store)`。文档里的服务偏好在全部提供者上线之前生效。
4. **加载政策**：`withPluginConfigSync(loader, app, store, opts.configSync)` 包装加载器（缺省 `createNodeModulesPluginLoader(projectDir)`）。
5. **发现**：`createPluginDiscovery(app, loader, store)` 建发现驱动，`startAalis` 以它的 `rescan` 在根上独占提供 `plugin-source`；`loadAll()` 整批登记全部插件，随后 `finishInitialLoad()` 落盘首批规范化结果。子命令模式在此分发并退出，否则 `app.start()`。
6. **热重载**：`installConfigHotReload(app, store, opts.configSync)`，`app:stopping` 时停止监听。

## 两种部署模型（同一套契约，两个加载器）

- **独立（纯 npm/pnpm）**：`npm create aalis@latest <dir>` 生成项目——`package.json` 含所选 @aalis 插件、
  `index.mjs` 仅 `import { startAalis } from '@aalis/runtime'; startAalis()`、`aalis.config.yaml`。
  运行时 `createNodeModulesPluginLoader` 从 `node_modules` 发现插件。
- **monorepo 自托管**：本仓库自身，入口 `src/index.ts` 直接从 `@aalis/runtime` 引入
  `createFsPluginLoader` 扫 `packages/`。FS 系列（`createFsPluginLoader` /
  `createFsYamlConfigProvider` / `createProcessRespawnStrategy`）只在 `@aalis/runtime` 定义一处，
  monorepo 与独立部署共用，无重复实现。

## 怎么为别的环境写宿主

core 的 `App` 构造只接收环境无关的选项（`name` / `logLevel` / `restartStrategy` / `devMode` / `now` /
`version` / `logHub` / `logger` / `disposeTimeoutMs`，全部可省），插件发现与配置文档都不经它注入。
`@aalis/runtime` 的包入口会引入 Node 模块，非 Node 宿主不能直接复用，要用该环境的 API 自备以下几样：

- **插件发现驱动**：取得插件定义（例：Deno 用 import map、无 node_modules；浏览器打包成静态插件表），
  连同各实例的配置与禁用标记整批交给 `app.pluginAll([{ definition, config?, instanceId?, disabled? }, …])`。
  整批登记只重算一次，依赖方排在它 required 服务的全部提供者之后激活。`@aalis/plugin-hooks` 与
  `@aalis/plugin-contributions` 放进同一批。
- **配置文档**：core 只持运行态（各实例的配置、禁用态、服务偏好），文档的读写与落盘由宿主负责
  （例：浏览器配置走 fetch / IndexedDB）。交给 core 的配置原样生效，schema 默认值要由宿主先深合并进去
  （`withPluginConfigSync` 即此政策）；不能顶层浅合并，否则只写了半块的嵌套组会把默认值整块顶掉。
  文档里的服务偏好经根绑定的 `services.prefer` 应用，放在登记插件之前。
- **重启策略**：实现 `RestartStrategy`，经 `AppOptions.restartStrategy` 注入（例：浏览器里「重启」改为重建实例）；
  不注入时 `app.restart()` 抛错。

两项服务按需提供，都经根绑定 `app.bind({ provide })` 登记：要让管理类插件读写配置文档，提供
`hostConfig`（`@aalis/api-host-config`）；能在运行中重新发现插件时，提供 `pluginSource`
（`@aalis/api-plugin-source`）。不提供时，以 `optional` 声明它们的插件自行降级：市场视同没有新插件，
WebUI 读写配置文档与扫描插件的接口返回 503。

在此之上再写一个等价的 `startXxx`。**core 与各插件契约不变**——这正是把 runtime 单独成包的目的。
