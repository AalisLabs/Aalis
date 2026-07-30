# 插件市场 — 剩余缺陷与待办

安装、卸载、批量更新、系统组件展示与失败回滚**已实现**（见文末「已实现」一节）；
**并发互斥、卸载护栏、服务劫持面、装完即用的前端缺口**仍未处理。

以下每条均经实测确认，记录根因与修法方向，避免后续重新调查。

## 两种部署形态

理解这些缺陷的前提，是 Aalis 有两种并存且行为不同的部署形态：

| | 脚手架部署（第一等公民） | monorepo 自托管 |
|---|---|---|
| 产出者 | `create-aalis` | 本仓库 |
| 包的位置 | `node_modules/`，由根 `dependencies` 声明 | `packages/`，工作区包 |
| 加载器 | `createNodeModulesPluginLoader`，**只读根 `dependencies`** | `createFsPluginLoader`，扫 `packages/` |
| 根依赖协议 | semver 范围（`^0.9.1`） | `workspace:*` |

`package-manager` 按 `pnpm-workspace.yaml` 是否存在判别形态，两条分支各自走对应的安装语义。

## 安全

### 禁卸 core / runtime

卸载路径没有「不可卸」概念。服务依赖闸 `findServiceDependents` 对 core **结构性失效**
—— core 不进 `getStatus()` → `provides` 为空 → 直接返回空数组 → 永不 409。

护栏应落在 **`createPackageManager.uninstall()` 这一服务层汇流点**，而非 HTTP 路由 ——
该服务经 `ctx.provide` 公开，任何插件都能绕过路由直接调用。判据宜读目标 `package.json`
的 keywords（`aalis-core` / `aalis-runtime`，与系统组件页同一真相源），而非硬编码包名。

注意这会推翻 `marketplace.ts` 中「不再保护核心/契约/WebUI 基础设施：用户要切就让其切」
的既有决定。理由是 core / runtime 是唯二「删了之后应用自己装不回来」的包，与「让用户
切换 WebUI 实现」不是一回事。

### `install` / `uninstall` 的服务层校验不对称

`uninstall` 有路径穿越守卫（`dirName` 必须匹配合法包段名），`install` 没有任何服务层校验——
包名只在 HTTP 路由上被 `PKG_NAME_RE` 挡一道，而服务经 `ctx.provide` 公开，插件可直接调用。
`update` 已在服务层用 `buildUpdateSpecs` 校验，`install` 应比照补齐。

### 安装脚本执行面

改用 `npm install <pkg>` 后，依赖树的 `preinstall` / `install` / `postinstall` 会默认执行
（旧的 `npm pack` + tar 路径不执行任何第三方脚本）。

权衡：脚手架自身就是裸 `npm install`（其生成的 README 也教用户裸装），加 `--ignore-scripts`
会让「同一个包、同一个用户、两条途径」行为分叉，且会打穿 `plugin-memory-sqlite`
（`better-sqlite3`，脚手架默认勾选）与 `plugin-tool-browser`（`puppeteer`）。真正的增量
风险只有传递依赖的 install 脚本这一片，而入口是 owner 级、包名由用户自己点选、包本体反正
会被动态 import 执行。

### 服务劫持面

新装插件可用高 `priority` 覆盖 `authority` / `llm` / `storage` 等既有服务，下游惰性
`getService` 会立即改路由。

## 装完即用

**内核侧已经成立，core 一行不用改**（已实测）：新插件 `provide` 的服务对 `getService` /
`getAllServices` 立刻可见、无缓存无快照；已激活插件的 optional 依赖靠 `whenService` 自动
重挂；工具 / 指令 / WebUI 页面 / 配置 schema 四类注册全部是「注册即生效」的活注册表；
required 依赖缺失的新插件停在 pending，等提供者装上后自动补激活。

缺口只在 WebUI 一侧：

- **前端候选发现只在 `ready` 事件里跑一次** —— 热装 `aalis-interface` 包不会出现在服务页
  的 `webui-client` 下拉里，必须重启。应提成幂等函数供安装成功后复用（重复
  `fork().provide()` 会在容器里堆同名重复项，幂等是硬要求）。

## 已实现（勿按旧描述施工）

安装（双形态）、卸载、批量更新、peer 预检、系统组件页、回滚、串行闸均已落地。机制与实测
数据写在代码注释里（`plugin-package-manager/src/index.ts`、`runtime/src/providers.ts`），
回归测试见 `test/integration/install-chain.test.ts`（真跑 npm）。

一处旧论断需注意：本文曾写「`--strict-peer-deps` 可把 warn-override 变成硬失败」，**这是错的**
（实测 npm 10.9.2：改「已被别人 peer 依赖的包」的版本时只 warn 且 exit 0）。现行判据是
解析 dry-run 输出，见 `findUnmetPeers` 的注释。

**热升级（`import(url + '?t=…')`）已决定不做**：只重新求值入口模块，多文件 dist 会混版；
而重启路径本就必须做对（core / runtime 只能重启），做对后插件升级复用它零边际成本。

## 相关文档

- 服务契约：[`docs/services/`](../services/)
- 部署形态：[`docs/guide/scaffolding.md`](../guide/scaffolding.md)
