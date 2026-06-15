# @aalis/runtime —— 独立部署运行时（Node 宿主层）

## 它是什么

Aalis 把「内核」和「宿主」分开：

- **`@aalis/core`** = **环境无关内核**。不碰 I/O、不读 `process.env`、不知道 node_modules，
  一切外部能力经 provider 注入（设计理念见 docs/core）。
- **`@aalis/runtime`** = **Node 宿主层**。用 Node API 实现 core 需要的几样宿主契约
  （插件加载器 / 配置 provider / 重启策略），并提供「一行启动」`startAalis`。

打个比方：core 是大脑，runtime 是「Node 这具身体」。要在 Deno / 浏览器 / 嵌入环境里跑，
就**另写一个宿主包**实现同样契约，core 与各插件契约一字不改（忒修斯之船）。

## Node 专属性 ≠ 包管理器

- runtime 用 `node:fs / module / child_process / process` + 读 `node_modules`，所以它绑定的是
  **Node.js 这个 JS 运行时**。
- **与包管理器无关**：`npm` / `pnpm` / `yarn` 都能用——它们都产出 `node_modules`，runtime 用
  `createRequire`（以**项目根** `package.json` 为基准）解析插件，因此 **npm 扁平 / pnpm 隔离 /
  monorepo 软链** 三种 `node_modules` 拓扑都自洽。
- 区分轴：runtime 名字里的「node」指 **JS 运行时**（Node vs Deno vs 浏览器），不是包管理器
  （npm/pnpm 都属 Node 生态）。将来真出别的环境宿主，可加后缀（如 `@aalis/runtime-deno`）；
  当前 `@aalis/runtime` = 默认/参考 Node 宿主。

## 设施（exports）

| 导出 | 作用 |
|---|---|
| `startAalis(opts?)` | **一行启动**：读 `aalis.config.yaml` → 从 `node_modules` 加载已装 @aalis 插件 → 组装 `App` → 启动 + 挂 SIGINT/SIGTERM 优雅退出 + 进程级重生。返回 `App`。 |
| `createNodeModulesPluginLoader(projectDir?)` | **独立部署**插件加载器：读项目 `package.json` 的 `dependencies`+`optionalDependencies`，按 `isLoadablePlugin`（`aalis-plugin` 关键词 ∪ `@aalis/plugin-*` 名 ∪ `aalis.service`/`subsystem` 标记，且**排除** `aalis.{core,types,client,tooling}`）发现并动态 import。 |
| `createFsPluginLoader` | **monorepo 自托管**加载器：扫 `<cwd>/packages`，同一套 marker 排除规则。 |
| `createFsYamlConfigProvider(configPath?)` | 文件系统 + YAML 配置 provider（返回 `{config, provider, dataDir}`）。 |
| `createProcessRespawnStrategy()` | 进程级重启策略（`app.restart()` → 子进程重生）。 |

`startAalis` 的 `opts`：`configPath`（默认 `cwd/aalis.config.yaml`）、`projectDir`（默认
`process.cwd()`）、`requiredServices`（缺失则启动告警）。

## 两种部署模型（同一套契约，两个加载器）

- **独立（纯 npm/pnpm）**：`npm create aalis <dir>` 生成项目——`package.json` 含所选 @aalis 插件、
  `index.mjs` 仅 `import { startAalis } from '@aalis/runtime'; startAalis()`、`aalis.config.yaml`。
  运行时 `createNodeModulesPluginLoader` 从 `node_modules` 发现插件。
- **monorepo 自托管**：本仓库自身，`createFsPluginLoader` 扫 `packages/`。
  （`src/runtime/providers.ts` 从 `@aalis/runtime` 再导出 FS 系列——单一事实来源、零重复。）

## 怎么为别的环境写宿主

core 的 `App` 构造接收宿主契约：`{ configProvider, pluginLoader, restartStrategy, config, dataDir,
devMode, requiredServices }`。要支持 Deno / 浏览器 / 嵌入环境，就用该环境的 API 实现这三样契约
（例：Deno 用 import map、无 node_modules；浏览器无 `fs`/`process`，配置走 fetch/IndexedDB、
「重启」改为重建实例），再写一个等价的 `startXxx`。**core 与各插件契约不变**——这正是把
runtime 单独成包的目的。
