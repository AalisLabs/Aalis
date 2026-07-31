# 插件市场 — 剩余缺陷与待办

安装、卸载、批量更新、系统组件展示、失败回滚、串行互斥、卸载护栏、装完即用**均已实现**
（见文末「已实现」）。本文只剩两条**有意不做**的记录及其理由。

## 有意不做

### 安装脚本执行面

`npm install <pkg>` 会执行依赖树的 `preinstall` / `install` / `postinstall`。

不加 `--ignore-scripts` 的理由：脚手架自身就是裸 `npm install`（其生成的 README 也教用户裸装），
加了会让「同一个包、同一个用户、两条途径」行为分叉；且会打穿 `plugin-memory-sqlite`
（`better-sqlite3`，脚手架默认勾选）与 `plugin-tool-browser`（`puppeteer`）。真正的增量风险
只有传递依赖的 install 脚本这一片，而入口是 owner 级、包名由用户自己点选、包本体反正会被
动态 import 执行。

### 服务劫持面

新装插件可用高 `priority` 覆盖 `authority` / `llm` / `storage` 等既有服务，下游惰性
`getService` 会立即改路由。

**这是特性不是缺陷** —— 忒修斯之船的前提就是任何实现可被替换。真要管，方向是「装前披露」
（依赖图端点已能列出目标提供/需要哪些服务），而不是禁止。

## 已实现（勿按旧描述施工）

- **安装 / 卸载 / 批量更新 / peer 预检 / 系统组件页 / 回滚 / 串行闸**：机制与实测数据写在
  `plugin-package-manager/src/index.ts` 与 `runtime/src/providers.ts` 的注释里，回归测试见
  `test/plugins/package-manager.test.ts` 与 `test/integration/install-chain.test.ts`（真跑 npm）。
- **卸载护栏**：服务层两道闸 —— 类型（只收 `aalis-plugin` / `aalis-interface`；内核、宿主、
  契约、规范、工具库一律拒绝，文案指出 `npm uninstall` 这条带外途径）+ 来源（只收 registry）。
  更新不设此闸：它保留实例且失败会自动回滚，故内核宿主仍可经市场更新。
- **包名校验**：装/卸/更新三条路径统一在服务层（`validatePackageSpec` / `buildUpdateSpecs`），
  路由只做形状检查 —— 服务经 `ctx.provide` 公开，插件能绕过路由直接调。
- **装完即用**：前端候选发现已提成幂等函数并在安装成功后重跑，热装的 `aalis-interface` 包
  立即出现在服务页下拉里，无需重启。内核侧本就成立（服务/工具/指令/配置四类均为活注册表）。

三处旧论断需注意，均已实测证伪并从代码中删除：

- 「按 `pnpm-workspace.yaml` 判别部署形态」—— 该文件与真正生效的加载器**没有因果关系**
  （加载器由入口文件传给 `startAalis`）。猜错时会把包装进加载器永不查看的地方并静默失败。
  现在只有一条安装路径（写根依赖），能否更新/卸载由**每个包自己的来源**判定。
- 「`--strict-peer-deps` 可把 warn-override 变成硬失败」—— 错。npm 10.9.2 对命令行显式 spec
  只 warn 且 exit 0。现行做法是**在项目副本里预检**（理由与实测见 `preflightInSandbox` 注释）。
- 「热升级（`import(url + '?t=…')`）可行」—— 只重新求值入口模块，多文件 dist 会混版。
  而重启路径本就必须做对（core / runtime 只能重启），做对后插件升级复用它零边际成本。

## 相关文档

- 服务契约：[`docs/services/`](../services/)
- 部署形态：[`docs/guide/scaffolding.md`](../guide/scaffolding.md)
