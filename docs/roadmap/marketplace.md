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

## 并发

### `install` / `uninstall` / `update` 全程无互斥

三者都会写同一个根 `package.json`，而路由层与服务层都没有锁。两个 `npm` 进程并发时后写覆盖先写，
依赖声明被静默丢弃；卸载与安装并发时，卸载掉的包可能被并行安装的那次写回。

前端只对当前卡片禁用按钮（`packages/plugin-webui-client/src/pages/MarketplacePage.tsx` 的
`disabled={installing === pkg.name}` 是单值 state），点了 A 立刻能点 B。

修法：在 `createPackageManager` 内加一把串行锁（同一服务实例内所有写操作排队）。注意锁要覆盖
`update`——它的预检与真装之间有窗口，期间若有 `install` 插入，装出来的树与预检过的不是同一张。

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

## 已实现

以下条目已落地，保留在此仅供追溯，勿再按旧描述施工：

| 原缺陷 | 现状 |
|---|---|
| 脚手架部署下安装无效（写不进根依赖，死目录 + 假成功） | 按形态分支，standalone 走 `npm install` 写根依赖 |
| 卸载只 dispose 运行时实例，重启后插件复活 | standalone 走 `npm uninstall` 摘根依赖 |
| 未发现新插件仍返回 `ok` | 判据改为「目标是否进了运行时注册表」；非插件包（如 `aalis-interface`）正常成功 |
| 超时按 `npm pack` 定，对 `npm install` 不足 | 安装类命令 600s，短命令仍 120s |
| 升级已装插件不生效（`rescanPlugins` 跳过已注册） | 新增 `update(targets)`：整组预检 → 一次安装 → 一次重启 |
| 更新无拓扑序 | 一次 `npm install` 提交整张版本映射，重启次数恒为 1 |
| peer 兼容门禁（npm 只 warn 就把 core 换掉） | 预检与真装都带 `--strict-peer-deps`，冲突则整批拒绝且不改文件 |
| core / runtime 检索不到 | 独立的「系统组件」页，数据源是本地已装 + 根依赖表，只提供更新 |
| 无更新入口（卡片显示「可更新 vX」但无动作） | 系统组件页的批量勾选 + 「更新所选」 |
| 重启丢 `execArgv`、不验证子进程、`stop()` reject 成僵尸态 | 见 `packages/runtime/src/providers.ts` 的 `createProcessRespawnStrategy` |
| 更新 core / runtime 不可逆 | IPC ready 握手；新实例 ready 前夭折则还原 `package.json` + lockfile 并重生旧版 |

**热升级（`import(url + '?t=…')`）已决定不做。** 理由：它只让入口模块重新求值，同包兄弟文件
与全部依赖仍命中旧 ESM 缓存，而一方插件约三分之一是多文件 tsc dist，对它们要么无效、要么造成
同包内「新 `index.js` + 旧 `helpers.js`」混版；判据（改动包集合 ⊆ 目标插件）还要依赖解析
`npm install --json` 的输出。而重启路径无论如何都必须做对（core / runtime 更新只能重启），
做对之后插件升级复用它是零边际成本。升级是低频操作，几秒中断可接受。

## 相关文档

- 服务契约：[`docs/services/`](../services/)
- 部署形态：[`docs/guide/scaffolding.md`](../guide/scaffolding.md)
