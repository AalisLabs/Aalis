# 插件市场 — 已知缺陷与待办

市场的**检索、依赖披露、版本显示**已可用；**安装与更新链路尚不完整**。

以下每条均经实测确认（隔离脚手架 + 本仓库两种形态），记录根因与修法方向，避免后续重新调查。

## 两种部署形态

理解这些缺陷的前提，是 Aalis 有两种并存且行为不同的部署形态：

| | 脚手架部署（第一等公民） | monorepo 自托管 |
|---|---|---|
| 产出者 | `create-aalis` | 本仓库 |
| 包的位置 | `node_modules/`，由根 `dependencies` 声明 | `packages/`，工作区包 |
| 加载器 | `createNodeModulesPluginLoader`，**只读根 `dependencies`** | `createFsPluginLoader`，扫 `packages/` |
| 根依赖协议 | semver 范围（`^0.9.1`） | `workspace:*` |

脚手架**不写 `pnpm-workspace.yaml`、不建 `packages/` 目录**。其生成的 README 教用户
`npm install @aalis/plugin-<name>` —— 这是正确装法，装完即被 `discover()` 发现。

## 安装

### 脚手架部署下安装无效（阻塞）

`plugin-package-manager` 的 `install()` 走的是「`npm pack` → 解包到 `packages/<dir>` →
`pnpm install --filter`」，**从不写入根 `package.json` 的 `dependencies`**。而脚手架用的
node_modules 加载器只读根 `dependencies` —— 结果是一个永不加载的死目录，接口却返回
`{ok: true, message: '已安装到 packages/xxx，但未发现新插件'}`。

修法：改写根依赖（`npm install <pkg>`）。同时必须对工作区形态加硬护栏 —— 本仓库根依赖
含 `workspace:` 协议，`npm install` 会直接 `EUNSUPPORTEDPROTOCOL` 硬失败；而一旦哪天
根依赖里没有该协议，`npm install` 会在 pnpm 仓库根写出 `package-lock.json` 与扁平
`node_modules`，把整个工作区搅坏。

### 未发现新插件仍返回 ok

`install()` 在 `rescanPlugins()` 返回空数组时仍返回 `ok: true`。这是「静默假成功」的最后
一环，改写安装路径时须一并改为显式失败。

### 超时按 `npm pack` 定，对 `npm install` 不足

`execProc` 硬编码 120 秒。`npm install` 装全依赖树 + 原生编译（`better-sqlite3`、
`puppeteer` 均在默认依赖里）在快机快网下已达 95 秒量级。超时行为是 `SIGKILL`。

## 更新

### 升级已装插件不生效

`App.rescanPlugins()` 对已注册插件直接 `continue` 跳过，装了新版等于没装。

正解原语是 **`bouncePlugin(id, { module })`**，而非「`unload` + `register`」——
后者会丢插件配置（`PluginManagerService.register` 不合并 `defaultConfig`，只有
`App.plugin()` 合并），也会丢 disabled / 多实例语义，且旧版已删无从回滚。

`bouncePlugin` 自身的已知缺口：不重算 config 与 `requiredDeps`（新版新增的
`defaultConfig` 字段拿不到值、依赖门用的还是旧版 `inject` 声明）；对 disabled 插件直接
返回 `false`；返回值不反映 `apply` 成败；多实例只换主实例，会让同一插件两个版本在同一
进程内并存。

### 热升级的适用边界

`import(url + '?t=…')` **只让入口模块重新求值**，同包兄弟文件与全部依赖仍命中旧 ESM
缓存。一方插件中约三分之一是多文件 tsc dist，对它们热重载要么无效、要么造成同包内
「新 `index.js` + 旧 `helpers.js`」混版。

判据应为：**允许热升级 ⟺ 本次安装在磁盘上改动的包集合 ⊆ {目标插件自身}，且目标带
`aalis-plugin` 关键词。** 数据源取 `npm install --json` 报告的 added/updated/removed，
精确且零成本。越界则全量重启。

注意反向陷阱：跨包混版在 Aalis 不致命（`-api` 包零 class、零 Symbol、零模块级可变态，
declaration merging 是纯类型的，运行时不落符号；失败形态是 `x is not a function`，被
`activatePlugin` 捕获后回滚兜住）。但**给整棵依赖树加 generation query 反而会制造真
bug** —— 例如 `util-network-guard` 的策略是进程级单例，被复制成两份会让 SSRF 策略在
一份里生效、另一份是默认值。

### core / runtime 的可见与更新

二者带 `aalis-core` / `aalis-runtime` 关键词，不在市场检索的四类（`aalis-plugin` /
`aalis-util` / `aalis-api` / `aalis-interface`）之内，故检索不到。

应经**根依赖表**呈现 —— 脚手架已把它们写进根 `dependencies`，遍历根依赖天然覆盖，
天然有版本、天然可更新、天然没有安装按钮 —— 而非塞进插件检索通道（npm 关键词是开放
命名空间，任何人可发布带 `aalis-core` 关键词的包，在市场里拿到一张「内核」卡片）。

更新 core / runtime 必须**全量重启**：它们在 App 存在之前就被宿主入口 import，无热换可能。

### peer 兼容门禁

`npm` 的 ERESOLVE 只在「peer 需求方被装」方向硬失败；**core / runtime 被根显式指定时
只 warn 且 exit 0，照样把 core 换掉**。故 core 更新路径需自带门禁，不能指望 npm 兜底。

`--strict-peer-deps` 可把上述 warn-override 变成硬失败，一次性判定一组目标版本是否
互相兼容 —— 不需要自研版本求解算法。

### 更新无拓扑序

更新是文件系统操作，而进程只在启动那一刻读文件系统。故整批更新的正确形状是：算出一张
目标版本映射 → 整组 peer 预检 → **一次** `npm install` 提交整张映射（依赖图由 npm 解）
→ **一次**重启。重启次数恒为 1，与改了多少个包无关。拓扑序只在**发布**时需要。

## 安全

### 禁卸 core / runtime

卸载路径没有「不可卸」概念。服务依赖闸 `findServiceDependents` 对 core **结构性失效**
—— core 不进 `getStatus()` → `provides` 为空 → 直接返回空数组 → 永不 409。落到
`package-manager` 就是 `rm -rf <cwd>/packages/core`；在 monorepo 自托管形态下这删的是
内核源码目录。

护栏应落在 **`createPackageManager.uninstall()` 这一服务层汇流点**，而非 HTTP 路由 ——
该服务经 `ctx.provide` 公开，任何插件都能绕过路由直接调用。判据宜读目标 `package.json`
的 keywords（与市场分类同一真相源），而非硬编码包名。

注意这会推翻 `marketplace.ts` 中「不再保护核心/契约/WebUI 基础设施：用户要切就让其切」
的既有决定。理由是 core / runtime 是唯二「删了之后应用自己装不回来」的包，与「让用户
切换 WebUI 实现」不是一回事。

### `PackageManagerService` 自身零校验

包名校验只长在 HTTP 路由上，而 `install()` / `uninstall()` 是 `ctx.provide` 出去的公开
服务，任何插件都能绕过路由直接调用。信任边界应在服务层。

### 安装脚本执行面

现行 `npm pack` + tar 路径**不执行任何第三方脚本**。若改用 `npm install <pkg>`，依赖树的
`preinstall` / `install` / `postinstall` 会默认执行。

权衡：脚手架自身就是裸 `npm install`（其生成的 README 也教用户裸装），加 `--ignore-scripts`
会让「同一个包、同一个用户、两条途径」行为分叉，且会打穿 `plugin-memory-sqlite`
（`better-sqlite3`，脚手架默认勾选）与 `plugin-tool-browser`（`puppeteer`）。真正的增量
风险只有传递依赖的 install 脚本这一片，而入口是 owner 级、包名由用户自己点选、包本体反正
会被动态 import 执行。

### 无互斥锁

`install` / `uninstall` / `rescan` 全程无互斥，解包与 `rescanPlugins` 之间无屏障。

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
- **装非插件类包时前端零反馈** —— `aalis-interface` / `aalis-api` / `aalis-util` 不带
  `aalis-plugin` 关键词，`discover()` 不收 → 不注册插件 → 不发 `plugins:changed` → WS 不
  广播。

## 重启

- **丢失 Node 执行选项**：`createProcessRespawnStrategy` 以 `process.argv` 重生，丢掉
  `execArgv`。脚手架启动脚本的 `--env-file-if-exists=.env` 与用户自加的
  `--max-old-space-size` 在重启后静默失效 —— 「改完 `.env` 再重启」永远不生效。
- **不验证子进程**：`spawn` 后立刻 `process.exit(0)`，不确认新进程是否起来。对插件够用，
  对 core / runtime 更新则是砖化路径：新 core 起不来时父进程已退，没有 UI 可恢复。
  最小方案是 `spawn` 加第四个 fd `'ipc'`，`start.ts` 在 `app.start()` 后
  `process.send({ type: 'aalis:ready' })`；超时未退也判成功，以兼容不发 ready 的旧 runtime。
- **`stop()` 若 reject**，respawn 既不 spawn 也不 exit，进程停在「插件已半拆、HTTP 已关、
  但还活着」的僵尸态，而脚手架不生成 pm2 / systemd 配置，无 supervisor 可救。

## 无更新入口

全仓没有触发重启的更新路径。`app.restart()` 只有两个调用点，均与更新无关：
`PUT /api/config`（仅 name / persona / logLevel 被改时）与 `/restart` 聊天指令。前端没有
重启按钮。

市场卡片现已显示「可更新 vX」，但**尚无对应的更新动作** —— 该提示在更新功能接上前是悬空的。
