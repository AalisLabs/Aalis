# Changelog

本文件只记录**破坏性变更与迁移路径**。逐包的完整改动见 git 历史。

版本号语义：core 在 1.0 之前，次版本（`0.x.0`）可含破坏性变更并在此列出迁移路径；
补丁版本（`0.x.y`）只做修复与加法。1.0 之后按标准 semver，稳定性条款见
[`docs/design/core-contract.md`](docs/design/core-contract.md)。

---

## 未发布（core 0.16.0 → 0.17.0）

### 服务统一与工厂（@aalis/core）

- 八项默认基础服务与第三方服务共用同一容器、描述符与绑定路径，删除 builtin 品牌和装配分路。所有 `uses` 按 required / optional 归类并参与同一激活规则；基础服务在加载插件前已登记，仍须显式声明使用。
- 新增 `serviceFactory(scope => instance)`：同步按消费者激活与提供者登记创建并缓存实例；scope 的资源归消费者。成功工厂实例保留准确提供者边至消费者关闭，失败构造回滚资源并等待异步撤回后释放边。Promise 返回值被拒收，拒绝被观察；同版本 Core 副本的服务协议可互通。
- `services.get/all` 解析当前消费者的工厂实例，`all` 也会创建非胜者；新增 `services.inspect` / `ServiceContainer.inspect`，只读登记元数据。WebUI 服务页使用 inspect，展示基础服务、共享/按激活实例策略和独占状态，不因查看列表创建实例。
- `provide(..., { exclusive: true })` 是通用独占登记策略；Core 基础服务也使用它防止同名第二提供者。该策略不等于永久驻留，退订后可重新登记。
- 内部目录调整为 `kernel` / `primitives` / `infrastructure` / `composition` / `orchestration`，描述符与绑定状态机分文件。深路径不属于公开 API，导入统一走 `@aalis/core`。

**迁移**：管理页只枚举登记时改用 `inspect`；宿主需要消费实例时用 `app.bind`，不能将 `app.services.get/getAll` 返回的原始工厂包装当作实例。工厂和动态查询的完整边界见 [服务文档](docs/core/service.md)。

### 完整服务声明展示与内部精简

- `PluginStatusEntry.uses` 返回全部显式声明的快照，保留参数别名、服务名及必需/可选类别；`requiredServices` / `optionalServices` 包含 Core 基础服务，不再有独立 builtin 类别。
- WebUI 插件详情显示上述全部声明，无配置项的插件也可展开。工具/命令的敏感标签仍单独展示；通过 `services` 动态查询的服务不属于静态声明清单。
- Core 移除仅用于白盒测试的 Host 映射和读取入口，测试观察移入测试夹具；移除生命周期中已由完成对象覆盖的重复状态。发布校验按职责归入 `composition/provide-validation.ts`。

### 清理宿主契约与初始化恢复

- 初始化期间本次 required 绑定的 `require()` 原样抛出服务不可用错误时，撤回该次资源后回到 `pending`，依赖已恢复时也不会漏掉重新激活。optional、普通业务异常、伪造/包装错误和其他激活的错误仍进入 `error`。自动尝试在同一次重算任务内按插件限额，持续失稳会点名暂缓；不会通过排队的服务通知反复重置限额。

- 新增 `@aalis/schema-log` 0.1.0，统一 `LogEntry` / `LogLevel` 与 `formatLogLine` / `parseLogLine`。这些导出从 Core 移除，runtime、CLI、WebUI 改从 schema 包导入；日志通道与 Logger 留在 Core。Core 仅引用该包的类型，编译后的 JavaScript 不加载它。发布时须包含新包。
- 新写日志采用 `@aalis/log:1 ` 前缀的单行 JSON，完整保留反斜杠、换行与分隔符；读取兼容旧分隔格式，支持同一文件内混合记录。旧文件中已经丢失的转义信息无法恢复。
- 删除未被生产代码使用的 `AppOptions.dataDir`、`ConfigManagerOptions.dataDir`、`ConfigManager.getConfigDir()` 与 `createFsYamlConfigProvider()` 返回值的 `dataDir`；宿主文件监听仍使用自己的实际目录。
- 父模块的 `onDrain` 负责业务交接，不能等待同一关停计划中排在它之后的子关闭；外部调用者仍可等待完整关闭。本次未增加超时或改变关闭句柄语义。

### 本批收敛

- Core 删除旧 `Context` 类及中转门面：默认服务工厂连接原语注册表与消费者的 `ServiceScope`，`Activation` 只保存身份、资源和依赖关系，装配及子模块挂载由 `ActivationHost` 承担。服务观察只报告胜者变化，异步交接统一在绑定与资源层处理。
- `App.stop()` 在屏障与清理期间被再次调用，也返回同一个完整关闭 Promise；不再用全局事件阶段判断调用者、提前兑现外部调用。监听器或清理回调不能 await / 返回自己的停机 Promise。本批不新增 `apply` / 屏障超时，既有 `disposeTimeoutMs` 不构成全局停机时限。
- `registrar` 同键登记在同步重入、撤回与关闭交错时仍按条目身份归属，过期登记取得的清理句柄会撤回，不留卸载后仍可执行的条目；关闭等待已发起的异步撤回。
- runtime 在加载定义后、首次交给 Core 注册前完成默认值回填与未知字段裁剪，主实例与配置中的复用实例共用此路径，避免首次 `apply` 配置与保存配置不一致。schema 政策留在宿主。
- Agent 缺少 message-archive 时，首次实际写入告警、每次激活最多一次；对话继续，服务恢复后后续消息恢复归档，不补写缺席期间的消息。minimal 模板包含归档插件；归档职责不进入 Core。

### 版本与必须同批升级的包

**升级**：core 0.17.0 把插件入口从公开激活记录改成定义对象与按激活绑定的能力。旧版插件（具名 `export const name` / `inject` / `provides`、`export default function`、`apply(ctx, config)`）配新 runtime **不会被加载**——`pluginDefinitionOf` 记 warn 后跳过；新插件配旧 core 没有 `definePlugin`。契约包删除全部 `useXxxService(ctx)` helper，描述符改为运行时值导出。下列 **89** 个包必须同批升级（自身即 core，或 core peer 已抬到 `>=0.17.0 <1.0.0`）：

- `@aalis/core` 0.17.0
- 25 个 `@aalis/api-*`（均 minor）：agent 0.8.0 / asr 0.10.0 / authority 0.9.0 / code-sandbox 0.6.0 / commands 0.6.0 / cron-engine 0.6.0 / doctor 0.6.0 / embedding 0.6.0 / flow-control 0.6.0 / gateway 0.6.0 / llm 0.11.0 / media 0.10.0 / memory 0.6.0 / message-archive 0.6.0 / persona 0.7.0 / platform 0.7.0 / process 0.7.0 / session-confirm 0.6.0 / session-manager 0.9.0 / storage 0.6.0 / tool-session 0.6.0 / tools 0.9.0 / vectorstore 0.6.0 / webui 0.10.0 / workflow 0.10.0
- 61 个第一方插件（均 minor）：adapter-onebot 0.13.0 / agent 0.14.0 / asr-openai 0.10.0 / asr-whisper-cpp 0.10.0 / authority 0.12.0 / checkpoint 0.12.0 / cli 0.11.0 / code-sandbox-os 0.6.0 / commands 0.11.0 / cron-engine 0.7.0 / doctor 0.6.0 / draw 0.2.0 / embedding-ollama 0.10.0 / embedding-openai 0.11.0 / file-reader 0.12.0 / flow-control 0.10.0 / gateway 0.6.0 / image-sender 0.6.0 / llm-deepseek 0.12.0 / llm-ollama 0.10.0 / llm-openai 0.12.0 / maimai 0.10.0 / mcp-client 0.11.0 / mcp-server 0.11.0 / media 0.14.0 / memory-history 0.11.0 / memory-inmemory 0.10.0 / memory-mongodb 0.10.0 / memory-sqlite 0.10.0 / memory-summary 0.11.0 / memory-vector 0.12.0 / message-archive 0.11.0 / office 0.10.0 / okx-trading 0.10.0 / package-manager 0.6.0 / persona 0.10.0 / process-local 0.7.0 / prompt-budget 0.6.0 / scheduler 0.12.0 / session-confirm 0.6.0 / session-manager 0.12.0 / skills 0.11.0 / storage-local 0.11.0 / subtask 0.12.0 / todo-list 0.10.0 / tool-browser 0.11.0 / tool-code-runner 0.10.0 / tool-math 0.10.0 / tool-onebot 0.10.0 / tool-search 0.10.0 / tool-session 0.12.0 / tool-system 0.11.0 / tools 0.8.0 / trigger-policy 0.12.0 / user-profile 0.12.0 / user-relation 0.13.0 / vectorstore-flat 0.11.0 / vectorstore-lancedb 0.11.0 / websearch-serper 0.10.0 / webui-server 0.12.0 / workflow 0.13.0
- `@aalis/runtime` 0.13.0（加载器）
- `@aalis/schema-config` 0.12.0（`PluginMeta.configSchema`；53 个消费方 dependencies 下限同步抬到 `>=0.12.0`）

脚手架 `create-aalis-plugin` 0.10.0 与前端 `@aalis/plugin-webui-client` 0.12.6 同批发版，无 core peer，不计入上面 89。`plugin-todo-list` 把 `@aalis/api-memory` / `@aalis/api-webui` 从 `devDependencies` 归位到 `dependencies`（值导入描述符）；`@aalis/api-session-manager` 仍是 type-only，留在 `devDependencies`。api-* 互依里的 type-only 导入不抬下限。脚手架项目里 `@aalis/core` 若仍是 caret 区间，请显式装 `0.17.0` 与上列 peer 已抬的包，再 `npm update`；不要用 `--legacy-peer-deps` 绕过。

### 插件形状：`definePlugin`（@aalis/core / @aalis/runtime）

入口必须是 `export default definePlugin({ name, uses, provides, apply })`。`name` 须为非空字符串，且不含 instanceId 的 `:suffix` 与子模块的 `#`。`uses` 的值是描述符（或 `optional(描述符)`），没有默认注入——写了什么，`apply` 就只能碰到什么。`provides` 是描述符数组，激活后按本次 `instanceId` 校验确已登记。

```ts
import { definePlugin, defineService, logger, provide } from '@aalis/core';

const counter = defineService<{ n: number }>('counter');

export default definePlugin({
  name: '@scope/plugin-example',
  uses: { logger, provide },
  provides: [counter],
  apply({ logger, provide }) {
    provide(counter, { n: 1 });
    logger.info('ready');
  },
});
```

**迁移**：删掉具名 `export const name` / `inject` / `provides` 与 `export default function (ctx, config)`。`inject: { x: 'tools' }` 改为 `uses: { x: tools }`（值导入契约包描述符）；可选依赖包一层 `optional(tools)`。`apply(ctx, config)` 改为 `apply(caps)`，配置改从 `uses` 里的 `config` 读。加载器不再接受具名导出或函数 / 类 default，会 warn 并跳过该包。

### 能力入口（@aalis/core）

四原语与配置、日志、生命周期、发布、动态查询均须在 `uses` 里声明对应描述符。对照：

| 0.16 | 0.17 |
|---|---|
| `ctx.on` / `ctx.emit` | `events.on` / `events.emit` |
| `ctx.logger` | `logger` |
| `ctx.config` / `apply` 第二参 | `config`（本插件配置视图，只读） |
| `ctx.onDispose` | `lifecycle.onDispose`；新增 `lifecycle.onDrain` |
| `ctx.provide(name, impl)` | `provide(descriptor, impl, options?)` |
| `ctx.getService` / `ctx.getAllServices` | `uses` 后 `x.current` / `x.require()` / `x.all()` |
| `ctx.whenService(name, attach)` | `x.follow(attach)` |
| `ctx.useModule` | `lifecycle.module(def, cfg)` |
| `ctx.middleware` / `ctx.runHook` | `hooks.middleware` / `hooks.run` |
| `ctx.contribute` / `ctx.collect` | `contributions.contribute` / `contributions.collect` |
| 整份宿主配置 | `hostConfig`（普通宿主服务，须显式 `uses`） |
| 动态按名取服务 | `services.get` / `services.all`（不增加声明依赖；创建工厂实例时持有其寿命边） |

`current` / `require()` 返回**当时点解析的实例**（共享实例或当前消费者的工厂实例），不是自动转发的代理；把引用存起来须自行承担它失效。`require()` 在 required 依赖丢失到调度收敛之间也可能短暂抛错。`all()` 每次调用重新枚举；手动缓存非默认共享实例（例如 `all()[1]`）不建立关停边；工厂实例则持有其准确提供者边至消费者关闭。缓存不自动转发，也不保护被主动卸载的提供者。

`follow(attach)`：在场即调 `attach`；换人时先跑上次返回的清理，等它的 Promise 落定之后才用新实例再挂；下线与关闭时清理。`attach` 必须同步：需要清理就返回函数，不需要就不返回。返回 thenable 会被接住并 warn，不会当 cleanup 用。拒绝被隔离并报告，但不证明旧资源已释放。

```ts
import { storage } from '@aalis/api-storage';
import { definePlugin, lifecycle } from '@aalis/core';

export default definePlugin({
  name: '@scope/plugin-follow',
  uses: { storage, lifecycle },
  apply({ storage, lifecycle }) {
    storage.follow(svc => {
      const off = svc.watch?.('data:/example', () => {});
      return () => off?.();
    });
    lifecycle.onDrain(async () => {
      await storage.current?.stat('data:/example').catch(() => undefined);
    });
    lifecycle.onDispose(() => {});
  },
});
```

`services.get` 是动态查询：不参与激活闸、不自动跟随，关停期可能拿空。共享实例查询不产生依赖边；实际创建工厂实例时持有其提供者边。需要声明等待与跟随就把描述符写进 `uses`。

子模块：

```ts
import { definePlugin, lifecycle, logger } from '@aalis/core';

const child = definePlugin({
  name: 'child',
  uses: { logger },
  apply({ logger }) {
    logger.info('child');
  },
});

export default definePlugin({
  name: '@scope/plugin-parent',
  uses: { lifecycle },
  async apply({ lifecycle }) {
    await lifecycle.module(child, { extra: true });
  },
});
```

挂载时缺 required 服务即拒绝（抛错，`apply` 不执行）；挂上之后没有独立持续激活闸，提供者离场时登记排队、引用可能为空，由父模块决定是否关掉它。子模块不进 `PluginManager`。

**迁移**：按上表改名即可。`whenService` 的 cleanup 语义由 `follow` 接过（含异步清理被关闭等待）。宿主要读整份配置，在 `uses` 里声明 `hostConfig`，不要假定会默认注入。

### 服务契约（各 `@aalis/api-*`）

每个契约包导出运行时描述符（`defineService` 的产物）。消费方必须把它放进 `dependencies`（值导入），不能只写 type-only / `devDependencies`。类型随描述符走，不再有全局服务类型表，也没有 `ServiceOf`。

`useToolService` / `useCommandService` / `useWebuiService` / `useAgent` / `useStorage` 等 helper 全部删除。`createStorageGateway` 等绑定 helper 的第一参改为 `ServiceRef`（`uses` 里声明的那一项直接传入）。

第三方能力作者用 `defineService(name, bind)` 自定义绑定接口，经 `BindingPort` 的 `registrar` / `follow` / `track` 接入归属与清理；`serviceRef(port, extra)` 可在调用型接口上叠登记方法——不要对象展开，`current` 是 getter。

**迁移**：`import { tools } from '@aalis/api-tools'`，写进 `uses`；`useToolService(ctx)` 改为 `caps.tools`。`createStorageGateway(ctx.getService('storage'))` 改为 `createStorageGateway(caps.storage)`。实现插件 `provide(tools, impl)`，不要 `ctx.provide('tools', impl)`。

### 调度与宿主入口（@aalis/core）

级联 bounce 开关与 `evictDownstreamConsumers` 删除。提供者换人不再一律重启消费者；有状态接线走 `follow`。管理器的手动 `bounce(instanceId, { config? })` 仍在：拆掉当前激活 → pending → 重算后重新激活，不换代码。仍传 `module` 的调用记 warn 并返回 `false`。

内部重算只分 `'changed' | 'shutdown'` 两档，不从包根导出。`PluginEntry.module` 改为 `definition`；`requiredDeps` / `optionalDeps` 改为 `required` / `optional`（服务名数组）。公开的 `PluginEntry` 类型不含内部激活字段。激活记录类不再从包根导出；`app.ctx` 删除。

宿主入口：`app.plugin(definition, config?, instanceId?)`、`app.bind(uses)`、`app.config`、`app.plugins`，以及四张底层注册表（`app.events` / `app.services` / `app.hooks` / `app.contributions`）。管理类插件经 `appService` / `pluginsService` / `hostConfig` 描述符声明获取，不要直接 import `App` 类当运行时依赖。

**迁移**：`app.plugin(mod)` 的 `mod` 改为 `definePlugin` 的产物。`app.ctx.getService(...)` 改为 `app.bind({ services }).services.get(...)` 或给那段宿主代码写 `uses`。读插件条目用 `entry.definition`，不要 `entry.module`。依赖列表用 `entry.required` / `entry.optional`。

### 关停编排与 `app:stopping`（@aalis/core）

关停按激活为单位，每个激活拆成收尾（`lifecycle.onDrain`：此刻本激活的监听、登记与声明的依赖都还在）与撤回加清理（`lifecycle.onDispose`：对外登记已撤回）。依赖交接放 `onDrain`；`onDispose` 阶段依赖可能已不可用。边只来自框架管理的关系：声明的依赖（含子模块、含尚未访问的 optional）在编排那一刻解析到的胜者，以及存活的托管绑定、已创建的工厂实例与尚未落地的撤回。经 `services` 动态查询共享实例不产生边，调用方缓存的裸引用不追踪；动态查询创建的工厂实例按托管寿命持有其实际提供者边。

普通依赖（别的插件、兄弟模块）：消费者整个 close 完，提供者才 drain。父使用自己子树的服务：父 drain 先于提供者子节点 close，父 `onDrain` 期间该节点尚未关闭，但可能已执行 drain。后代使用祖先的服务：不往排序图加边——归属树保证子 close 先于祖先 close，因此子 drain 时祖先尚未关闭，也可能已执行 drain。环内 optional 边构成的强连通分量（≥2 个激活）卡住时一次放行分量内全部 drain，再 close；无法解除的 required 环告警后强行放行。归属约束与环外约束一条不松。框架保证编排顺序与等待，不保证插件在 drain 中已主动撤回或关闭的实现仍可用。`App.stop()` 把全部 active 插件与根激活放进同一张计划。单独 `unload` / `disable` / `bounce` 走同一套分阶段关闭，但不享有整 App 关停那一层「根绑定与全部插件同计划」的交接保证。

`App.stop()` 单飞：重入返回同一 Promise。现序：停配置 watch → `beginShutdown()`（置停机态并冻计划）→ `plugins.idle()`（排干在飞重算）→ 发出 `app:stopping`（屏障，等监听器）→ 再 `idle()` → 执行已冻计划的 drain / close → 清 sticky → 根激活 `disposeAsync`。已静置时仍须先冻闸，否则 `idle()` 让出的微任务里 bounce 会留下 pending 幽灵。`app:stopping` 只在全局停机触发一次，bounce / unload / disable 不发；知会（告别语、状态条）可以挂它，资源清理走 `onDrain` / `onDispose`。发出时停机计划已冻：窗口内 `unload` / `disable` 汇入该计划后立即返回 true（不等拆卸完成，拆卸由停机计划执行）；`register` / `bounce` 返回 false（与定义或实例 id 校验失败同属政策挡下的 false 口径；`register` 不落账）。每次调用 `stop()` 都得到完整停机的同一 Promise；监听器与清理回调不得 await 或返回它，以免等待自身。监听器里对已冻激活 `provide` 记 warn 后忽略、不抛；`lifecycle.module` 抛「已 dispose」。停机完成后：对新定义 `register` 返回 false 且不落账；对已 disposed 实例的 `enable` / `updateConfig` / `bounce` 返回 false；`idle()` 落定。

**迁移**：数据交接（flush、abort 在飞工作并等待收尾）放 `onDrain`；拆连接、摘登记放 `onDispose`，不要假定此时依赖仍在。不要用 `events.on('app:stopping', …)` 当清理通道。

### 定义与登记校验（@aalis/core）

缺 `name`、空串、仅空白、含 `#`、`name` 带 `:suffix`、或 `name` / `instanceId` 为危险键 `__proto__` / `constructor` / `prototype`：`definePlugin` 抛错；手写对象绕过它时 `register` / `app.plugin` 返回 `false` 并 warn，不落账。显式 `instanceId` 同样须非空、不含 `#`，但允许 `name:suffix`（多实例）。`uses` 必须是纯对象（不能是数组或原始值）；值不是描述符的项，定义期抛、登记期 `false`。`apply` 必须是函数：定义期抛，手写 `register` 返回 false 且不落账。`provides` 元素必须是描述符。

`provide` 拒空实现（`null` / `undefined`）与非有限 `priority`（`NaN` / `Infinity` / 非数字）；`ServiceContainer.register` 同一套闸。按插件 id 取放配置时，危险键抛 `插件 id 不合法: ${id}`。

`provides` 声明了但激活后未按本次 `instanceId` 登记 → 本次激活进入 `error`。`provide(..., { onBehalfOf })` 的条目逻辑身份取被代者，清理仍归本激活；代登记**不计入**代理人的 `provides`，写进去会按「未提供」报错。

**迁移**：保证 `export default definePlugin({ name })` 的 `name` 与包名一致（不一致加载器会 warn，配置键 / 热扫描 / 卸载以定义名为准）。代登记的服务不要写进本插件的 `provides`。

### 配置合并（@aalis/core / @aalis/schema-config）

注册期逐层深合并（宿主 `pluginDefaults` ← 配置文件 ← `app.plugin` 第三参）：全程返回新对象。纯对象递归拷贝，数组拷一层（元素若为纯对象也拷）；`Date` / `Map` / 类实例等非纯对象按引用透传。危险键 `__proto__` / `constructor` / `prototype` 跳过。`bounce` / `updateConfig` 的入参先拷贝再挂：`entry.config` 与 `ConfigManager` 各持一份，调用方事后改 payload 或插件经内置 `config` 就地改嵌套都不得写穿快照。

`schema-config` 0.12.0：配置表单声明挂到 `PluginMeta.configSchema`（此前挂在插件模块形状上）。`defaultsFrom` 对 array / object default 返回拷贝。core 仍把 `configSchema` 当 opaque 透传，不解释字段。

**迁移**：插件在 `definePlugin({ configSchema })` 里声明。依赖 `@aalis/schema-config` 的包下限抬到 `>=0.12.0 <1.0.0`。不要再改 `pluginDefaults` 或 `bounce` 入参并假定那就是登记后的活对象。

### 加载器与双副本（@aalis/runtime / @aalis/core）

`@aalis/core` 公开面从包根导出 `pluginDefinitionOf`（加载器与市场共用判定）：只认 default 导出的定义对象（带非空 `name` 与 `apply` 函数）。具名导出、函数 / 类 default、普通对象缺字段，一律 warn「入口须 `export default definePlugin({ … })`」并跳过。定义 `name` 与包名不一致另 warn 一次，仍加载，但配置键以定义名为准。

同版本 `@aalis/core` 副本的描述符、optional 包装、工厂与 required 不可用错误可以互通；不再因基础服务描述符来自另一份副本而拒绝装配。不据此承诺不同版本兼容，也不承诺所有 Core 类实例可以跨副本互换。

**迁移**：入口改 default 定义。继续使用 peer `>=0.17.0 <1.0.0` 并尽量去重，禁 caret；跨副本支持不替代版本约束。

### 热扫描、市场卸载与 WebUI 配置（@aalis/core / @aalis/plugin-package-manager / @aalis/plugin-webui-server）

`rescanPlugins` 与 `autoLoadPlugins` 共用配置键里的 `name:suffix` 多实例登记。返回值仍只含新发现的主描述符名，不含 `:suffix`。

市场装卸以加载器解析的**定义 name**为准（可与 npm 包名不同）。卸载在 `npm uninstall` 之前按定义 name 枚举注册表里全部 instanceId（主实例 + `name:suffix`），逐个 `unload` 并清理配置块与禁用标记。

PUT `/api/plugins/:name/config` 按 `configSchema` 裁掉未知键并 warn。裁剪与 runtime 共用 `@aalis/schema-config` 导出的 `removeExtraFields`。`:name` 非法时（含 `#`、危险键）core 抛错，路由返回 400 并透出原文。GET `/api/plugins` 列表对 `schema.secret` 字段回传掩码 `••••••`，编辑器 `GET /api/plugins/:name/config` 保持原文；列表不可作为配置备份。

### session-manager 关停收口（@aalis/plugin-session-manager）

`lifecycle.onDrain` 把仍为 `active` 的会话收口为 `completed` 并立即落盘；`waiting` / 已终态不动。不依赖 agent 钩子。`onDispose` 仍 `shutdown()` 再刷一次。

### `ServiceContainer.getEntries` 删除（@aalis/core）

它把容器内部的条目对象原样交出（只拷贝外层数组），调用方能改 `priority` / `contextId` / 清理归属 `owner` 绕过容器不变量；
`ServiceEntry` 类型随之不再从包根导出。

**迁移**：改用 `ServiceContainer.getAll(name)`，或声明 `services` 后 `services.all(name)`，或在 `uses` 里声明该服务后 `x.all()`。元素是 `ServiceView` 投影（`instance` / `contextId` / `priority` / `label`），顺序相同。原始容器保留工厂包装，后两种消费入口解析实例；只看元数据请改用 `inspect`。

## 2026-09-20（core 0.16.0 minor；patch：api-tools 0.8.4 / plugin-agent 0.13.6）

### `bounce` 不再接受 `module`（@aalis/core）

`PluginManager.bounce(instanceId, { module })` 的模块热替换选项删除。它只换了模块引用，没有随之换新 `inject` 的依赖声明，
也在按旧模块 `provides` 疏散下游之前就换了引用——新模块声明的必需依赖缺失时仍会被激活。仓内没有调用方。

**迁移**：要在不改 instanceId 的前提下换代码，走 `await plugins.unload(id); await plugins.register(fresh, config, id)`。
与旧 `bounce` 的差异：注册表里的位置重置（只影响 required 依赖成环时的声明序兜底）、多发一次 `plugin:unloaded`。
`bounce(id, { config })` 与 `updateConfig` 不变。仍传 `module` 的调用（TypeScript 编译期报错；JavaScript 运行期）会记 warn 并返回 `false`，
不会静默跑旧代码。

## 2026-09-19（core 0.15.0 minor；patch：api-tools 0.8.3 / plugin-tools 0.7.4 / plugin-webui-server 0.11.11）

### `whenService` 的 cleanup 先于 `onDispose` 执行（@aalis/core）

Context 的清理链分成撤回段与清理段：`whenService` 回调返回的 cleanup 挂撤回段，拆卸时**先于全部 `onDispose` 回调**执行，
且执行时本 Context 的四原语登记已切断。此前它与 `onDispose` 按登记顺序 LIFO 交错，用户清理跑的时候，经 tools / commands /
webui 等枢纽服务交出去的登记仍在册，半拆的插件还会被枢纽派活；现在与四原语一样，用户清理开始前已撤净。

**迁移**：凡是"关闭在 `whenService` 的 cleanup、最终提交在 `onDispose`"的写法，顺序会从"提交 → 关闭"反转为"关闭 → 提交"。
依赖同一资源的最终提交与关闭要组织在同一个有序清理流程里——都放 `onDispose`（推荐），或都放 cleanup。
公开签名无变化；只调枢纽 `off()` 的 cleanup 不受影响（第一方已逐处核过）。分段只约束排空快照内的次序，排空期间迟到登记的清理仍立即执行。

## 2026-09-18（core 0.14.0 minor；patch：runtime 0.12.5 / api-commands 0.5.2 / api-tools 0.8.2 / api-webui 0.9.3 / plugin-adapter-onebot 0.12.4 / plugin-commands 0.10.1 / plugin-flow-control 0.9.4 / plugin-mcp-client 0.10.3 / plugin-persona 0.9.5 / plugin-skills 0.10.3 / plugin-tool-onebot 0.9.3 / plugin-tools 0.7.3 / plugin-webui-server 0.11.10）

**升级**：core 又走了次版本，且这次改了事件名与管理动词，**旧版第一方插件配新 core 会失效**——`ctx.on('ready')` 永远
收不到（静默），`plugins.enablePlugin` 不存在（TypeError）。下列包必须与 core 同批升级，它们的 core 下限已抬到 `>=0.14.0`：
runtime / plugin-adapter-onebot / plugin-flow-control / plugin-persona / plugin-skills / plugin-tool-onebot / plugin-webui-server /
plugin-mcp-client。脚手架项目里 `@aalis/core` 若仍是 caret 区间，请显式 `npm install @aalis/core@latest @aalis/runtime@latest`
再 `npm update`；不要用 `--legacy-peer-deps` 绕过。第三方插件按下面各节的迁移路径改。

### 四原语注册表统一形状（@aalis/core）

四个注册表（`EventBus` / `HookRegistry` / `ServiceContainer` / `ContributionRegistry`）此前各写各的，现统一为：
注册方法返回退订闭包；hooks / services / contributions 三家的形状是 `(键, 载荷, contextId, owner?)` 且 `contextId` 必填
（原先两家默认 `'root'`），events 保持 `(event, handler, owner?)`、注册者身份由 owner 派生；键按各自的扩展点接口约束
（`keyof AalisEvents` / `HookContextMap` / `ContributionPointMap`），services 例外——服务名保持开放（动态服务名是既定逃生舱），
约束落在载荷 `ServiceOf<K>` 与 `get` / `getAll` 的按键重载上。具体变化：

- `ServiceContainer.register(name, instance, contextId, owner?, options?)`：`priority` / `label` 收进 `options`；返回退订闭包
  （闭包返回这次是否真摘掉了条目），`unregisterEntry(name, entry)` 删除；`instance` 按 `ServiceTypeMap` 约束，`get` / `getAll`
  按键推导实例类型（未登记名仍走 `get<T>(name)` 兜底）。`getAll` 的元素类型具名为 `ServiceView<T>`（新导出，结构不变）。
- `ContributionRegistry.register` / `collect` 按 `ContributionPointMap` 约束贡献点名与 spec 类型。
- `HookRegistry.register` 的 `contextId` 不再默认 `'root'`。
- `EventBus.onHandlerError` 回调新增可选第三参 `contextId`（注册者的逻辑身份，无 owner 的裸登记为 `undefined`）——加法。
- `ConfigManager.watch(onChange)` 返回退订闭包（与 core 其余订阅口同形），`unwatch()` 保留为属主 App 的整体清扫口；
  已有订阅时再 `watch` 抛错，不再静默顶替——单订阅者口径成文。

**迁移**：经 `ctx.provide` / `ctx.middleware` / `ctx.contribute` / `ctx.on` 门面的代码不受影响。直接持有注册表
（`app.services` / `app.hooks` / `app.contributions` / `ctx.serviceContainer`，或自建 `new ServiceContainer()`）的代码：
`register` 的返回值由 `ServiceEntry` 改为退订闭包，按引用删除改为调用该闭包；位置参数 `priority` / `label` 改写进
`options`；补上 `contextId`。原先能编译的错误实现会开始报错：services 的未登记名仍落到 `unknown`、行为同旧，已登记名按契约
修正实现；contributions 的贡献点名必须已 declaration-merge 进 `ContributionPointMap`（0.8.0 起门面就是这个要求，现在注册表
这条旁路也关上了）。`packages/` 下零命中；`test/core/service.test.ts` 一处夹具因此改用合成名 `__t:llm`。

### 内置事件分「屏障 / 通知」两节，`plugin:loaded` 不再等监听器（@aalis/core）

core 自持的 11 条内置事件按「发射方等不等监听器」分两节，写进 `AalisEvents` 的 JSDoc，并由 `test/core/architecture.test.ts`
按调用形式守：屏障（`app:starting` / `app:ready` / `app:started` / `app:restarting` / `app:stopping`，后两者改名见下节）由 `App` 的
生命周期方法等监听器全部返回后才推进下一步；通知（`service:*` / `plugin:*` / `plugins:changed`）不等监听器。

**行为变化**：`plugin:loaded` 此前是唯一 `await` 监听器的通知事件，现与同节其余事件一样不等。此前一个慢监听器会挡住同一轮
recompute 里下一个插件的激活，监听器里 `await plugins.idle()` 则必死锁（idle 等 flight 排干，flight 等监听器返回）。现在监听器
不能再假设「我返回了状态机才继续」，要看落定后的状态请 `await plugins.idle()`；监听器的异步尾巴可能在 `plugins.idle()` /
`app.stop()` 返回之后才跑完。`packages/` 下没有 `plugin:loaded` 的监听点。

### 屏障事件统一 `app:` 前缀：`ready` → `app:ready`，`restarting` → `app:restarting`（@aalis/core）

五条屏障事件此前三条带 `app:` 前缀、两条不带，节的归属要靠一张手工名单；现在「屏障 ≡ `app:*`」是纯语法判据，
架构测试直接按前缀判节，并对账 `AalisEvents` 声明的 `app:*` 集合与 `App` 实际发出的集合。`app:ready` 与 `app:started`
仍是两个相位（`start()` 串行 await，前者的监听器全部完成后才发后者），只改名不合并。

**迁移**：`ctx.on('ready', …)` → `ctx.on('app:ready', …)`，`ctx.on('restarting', …)` → `ctx.on('app:restarting', …)`；
旧键已从 `AalisEvents` 删除，旧写法编译期报错，不会静默失效。第一方跟改的包（发布时抬 core 下限至 `>=0.14.0`）：
plugin-adapter-onebot / plugin-flow-control / plugin-persona / plugin-skills / plugin-tool-onebot / plugin-webui-server。
WebUI 的 WS 报文 `type: 'restarting'` 是前端协议，与 core 事件名无关，不跟改。

### PluginManager 的管理动作去掉 `Plugin` 后缀（@aalis/core）

`enablePlugin` → `enable`，`disablePlugin` → `disable`，`updatePluginConfig` → `updateConfig`，`bouncePlugin` → `bounce`；
`bounce` 同时加进 `PluginManagerService` 接口（此前只在类上，插件作者指南却教经服务调它）。持有它的对象已经叫 `plugins`，
`plugins.enablePlugin(id)` 的后缀是同一个词说两遍；与同一接口上的 `register` / `unload` 对齐（`getPlugin` / `getStatus`
里的名词是返回的对象，不是后缀，不动）。形参名同批统一为 `instanceId`（纯改名，不影响调用）。

**迁移**：按上表改方法名即可，签名与语义不变。第一方跟改的包（发布时抬 core 下限至 `>=0.14.0`）：
plugin-mcp-client / plugin-webui-server / runtime；WebUI 的 HTTP 路由路径（`/enable`、`/disable`）本就无后缀，不变。

### 管理动作一律返回 `Promise<boolean>`（@aalis/core）

`PluginManagerService.register` / `unload` 由 `Promise<void>` 改为 `Promise<boolean>`，与 `enable` / `disable` / `bounce` /
`updateConfig` 同一口径：**false = 主体不在注册表，或本次动作被状态 / 政策规则挡下**（重名、未声明 `reusable` 的多实例、
core 插件禁用、`disposed` 单向终态、`disabled` 态 bounce）；**true = 其余，含主体已在目标态的幂等情形**（unload 撞上在途卸载
即 join 它）。每个 false 分支都已记一笔日志（政策挡下 warn，主体不存在与 `disposed` 在途 debug）。`App.plugin()` 透传 `register` 的结果；`App.rescanPlugins()` 据此不再把
「描述符名与模块自报名不同、自报名已注册」的模块误报进热加载名单。

**迁移**：调用方可以继续忽略返回值。自行实现 `PluginManagerService` 的第三方需把这两个方法改为返回 `Promise<boolean>`
（旧实现的 `Promise<void>` 不满足接口的 `Promise<boolean>`，编译报错；仓内无此类实现）。

## 2026-09-17（core 0.13.0 minor；patch：runtime 0.12.4 / plugin-authority 0.11.5 / plugin-cli 0.10.3 / plugin-mcp-client 0.10.2 / plugin-media 0.13.3 / plugin-package-manager 0.5.3 / plugin-webui-server 0.11.9）

**升级**：core 走了次版本。脚手架生成的项目里 `@aalis/core` 是 caret 区间（`^0.12.x` 不含 0.13.0），而本批 runtime / plugin-cli / plugin-media / plugin-package-manager 用到了 `saveConfig()` / `config.save()` 的 Promise 返回值、peer 下限抬到 `>=0.13.0`——直接 `npm update` 会 ERESOLVE。请显式升级：`npm install @aalis/core@latest @aalis/runtime@latest`，再 `npm update`。不要用 `--legacy-peer-deps` 绕过：那会装出新 runtime 配旧 core 的组合，启动时即 TypeError。

### saveConfig 返回 Promise，兑现时保存已完成（@aalis/core）

`AppService.saveConfig()` 由 `void` 改为 `Promise<void>`：同步 provider 立即完成，异步 provider 等其落定；provider 失败以拒绝传出——此前异步 provider 的拒绝被 `ConfigManager.save` 静默吞掉、App 照记「配置已保存」，同步 provider 的抛错则同步冒给调用方，现在两者都以拒绝传出。core 会把失败记一条 error 并标记为已处理，所以不 await 的调用不会变成未处理拒绝。并发保存的先后与外部编辑的合并不在此契约内。
**迁移**：调用方 `await app.saveConfig()`；尽力而为的后台持久化路径用 `.catch()` 记录。第三方若实现 `AppService` 需改返回类型。不 await 的旧调用（0.13.0 之前发布的第一方插件如此）成功路径不变；失败路径上，旧调用者会继续后续逻辑——原本依赖同步抛错的错误处理失效，失败只出现在 core 的 error 日志里，部分调用方可能误报成功。与 core 同批升级 plugin-webui-server ≥0.11.9 / plugin-authority ≥0.11.5 / plugin-mcp-client ≥0.10.2 / plugin-cli ≥0.10.3 / plugin-media ≥0.13.3 即恢复正确的失败处理。

### provide 按 ServiceTypeMap 约束实现类型（@aalis/core）

`ctx.provide(name, instance)` 对已知服务名（`ServiceTypeMap` 中声明的）按契约类型检查 `instance`，错误实现在编译期被拒；未知名与动态字符串仍为 `unknown`。运行时不变。
**迁移**：编译报错的要么是真实缺口（修实现），要么是刻意的部分替身（测试里按仓内先例 `as never`）。

### useModule 返回可等待的模块句柄（@aalis/core）

`ctx.useModule()` 由返回 `() => void` 改为返回 `ModuleHandle { id; dispose(); disposeAsync(timeoutMs?) }`，与 Context 自身的生命周期面同形。`await handle.disposeAsync()` 返回时子上下文里全部异步清理已完成，此前 `await off()` 只是「开始执行」。`disposeAsync` 路径下模块名在子上下文彻底收尾（清理链排空、按 `ctx.id` 的枢纽清扫）之后才释放：排空期间同名新挂载拿到 `~n` 后缀，不再复用旧名。`dispose()` 保持原同步语义，不等异步清理，名字随同步段释放；需要名字隔离的用 `disposeAsync`。
**迁移**：`off()` → `handle.dispose()`；需要等清理落地的改 `await handle.disposeAsync()`。

### 注册表按清理归属清理（@aalis/core）

四个注册表（`ServiceContainer` / `HookRegistry` / `EventBus` / `ContributionRegistry`）的 `unregisterByContext(id)` 删除，换为 `unregisterByOwner(owner: symbol)`；`register` / `on` 新增可选 `owner` 参数，`EventBus.on` 第三参由 `string` 改为 `symbol`。`ctx.id` 仍是逻辑身份（贡献键与同键替换、服务偏好、模型引用、`hasByContext` 前缀查询）；清理按每次激活新鲜的内部 owner，同名 Context 在四原语层互不误清，拆卸在飞时同名新激活的注册也不会被迟到的清理误删。经 `tools` / `commands` / `webui-server` 等枢纽服务登记的条目仍按 `ctx.id` 走 `unregisterByPlugin` 清扫，不变。
`EventBus` 的登记改为按次计身份：同一函数被两个 Context（或同一 Context 两次）登记互不相干，各自退订、各自清理——此前按函数去重，后登记者会顶掉先登记者的归属，先登记者的退订会删掉后登记者。同一 handler 登记两次现在触发两次（与 Node `EventEmitter` 一致）。
**迁移**：经 `ctx.provide` / `on` / `middleware` / `contribute` 注册的无需改动。不经门面直接调注册表 `register` 的条目不再随 Context dispose 自动清理（原按 contextId 与 `id/` 前缀清），用返回值自管；直接调过 `unregisterByContext` 的改为逐条用返回值清、或经 Context dispose。

## 2026-09-13 修复批（二）（无 core 变更；minor：plugin-checkpoint 0.11.0 / plugin-file-reader 0.11.0；其余 patch：api-media 0.9.3 / api-session-manager 0.8.1 / api-storage 0.5.6 / plugin-adapter-onebot 0.12.1 / plugin-agent 0.13.2 / plugin-cli 0.10.2 / plugin-media 0.13.2 / plugin-scheduler 0.11.1 / plugin-storage-local 0.10.2 / plugin-tool-system 0.10.1 / plugin-workflow 0.12.1 / plugin-webui-server 0.11.5 / plugin-webui-client 0.12.4）

### checkpoint 不记共享根（@aalis/plugin-checkpoint）

回合期间的文件快照不再记 `kind` 为 `data` / `pluginData` / `logs` 的根（多会话、多平台共享的写入区：别处落盘的附件、插件状态，也包括本回合经 `skill_create` / `skill_update` 等写入 `data:/skills` 的内容）与 `tmp` 根（原先只排除 tmp）；`workspace` 与用户在 storage 配置里自建的 `custom` 等根照常记账。此前 storage 写入没有会话归属，其它会话乃至其它平台落到 `data:/images/…` 的文件、scheduler 等插件保存的状态文件都被记成本回合改动，WebUI 一回滚就删掉别人刚落盘的图片、把状态文件写回旧版。升级前写下的 manifest 里的这类条目读取时一并忽略，历史回合的回滚不再碰它们。`exec` 类工具的副作用本就不在保护范围内，不变。
**迁移**：无需操作。

### 上传文件的会话目录名（@aalis/plugin-file-reader）

新上传文件落到 `pluginData:/file-reader/<会话目录>/…`，会话目录名把 sessionId 里的 `:` `/` `\` 替换为 `_`（与附件落盘同一套规则；Windows 文件名不收冒号，此前 OneBot 会话的上传落盘直接失败）。启动恢复按 meta 文件实际所在目录定位数据文件、按会话清理时新旧目录名都清，WebUI「已上传的文件」路由读侧两种目录名都试（plugin-webui-server 0.11.5 同批升级），老版本按原样 sessionId 建的目录照常可读可删，不必迁移。降级到旧构建后，新目录里的文件同样能被扫到（旧代码也按扫到的 meta 恢复），但删除/清理会算错路径（0.x 不保证降级）。

### 其余行为对齐（patch）

- plugin-adapter-onebot：合并转发里字符串格式的节点先规范化成消息段再渲染，与段数组同一条路径——文本做 CQ 反转义，`[CQ:at,qq=all]` 渲染为 `<at>all</at>`，字符串里的 `[CQ:forward]` 也会递归展开（多一次 `get_forward_msg`）。描述缓存别名对 QQ 直链的 rkey 轮换免疫（登记与查询两侧都按剥掉 rkey 的键再走一次）。
- plugin-media：图片描述缓存按详略档分键——`auto`（默认）与到达识别共用一条，`casual` / `detailed` / `professional` 各自一条；快照文件里因此会出现 `<内容哈希>#<档位>` 形式的键，旧构建读到会原样当普通键载入，无害。
- api-storage：`resolveAgainstCwd` 把 `C:/…` 与 `C:\…` 一并判为宿主机绝对路径拒绝；storage 根名须至少两个字符（单字母根名与 Windows 盘符文法冲突，按盘符处理）。
- plugin-agent：会话级 `maxToolIterations` 生效——正整数覆盖全局配置，非正整数视为未设置。
- plugin-cli：非 chat 视图期间聊天区有新内容（含意图确认提示）时 header 的 CHAT 页签带计数高亮。
- plugin-scheduler / plugin-workflow：远期一次性 `runAt`（> 24.8 天）不再因 `setTimeout` 溢出即刻执行；工作流定义目录列举失败的那次启动不再清空 once 记账。
- plugin-storage-local：`watch` 文件 URI 改为监听父目录按文件名过滤，事件路径不再翻倍、原子覆盖写之后仍有事件。
- plugin-tool-system：`file_read` 整篇读取与行范围读取同一行数口径（结尾换行不算一行、CRLF 行内容不带 `\r`、空文件 0 行）。

## 2026-09-13（core 0.12.1 仅修复；minor：api-session-manager 0.8.0 / api-platform 0.6.0 / plugin-session-manager 0.11.0 / plugin-adapter-onebot 0.12.0 / plugin-trigger-policy 0.11.0 / plugin-workflow 0.12.0 / plugin-cli 0.10.0 / plugin-tool-session 0.11.0 / plugin-scheduler 0.11.0 / plugin-tool-system 0.10.0 / plugin-process-local 0.6.0 / plugin-checkpoint 0.10.0 / plugin-tool-browser 0.10.0 / plugin-cron-engine 0.6.0 / vectorstore-flat 与 lancedb 0.10.0；其余 patch，契约包的可选字段加法走 patch：api-tools 0.8.1 / api-authority 0.7.1 / api-media 0.9.2 / api-agent 0.7.1）

### 确认与回合中止（@aalis/api-tools / @aalis/api-authority / plugin-cli）

`ToolCallContext.signal` 与 `AccessRequest.signal`（均为可选）：agent 把回合的中止信号传给工具服务与权限守卫，等待人工确认期间回合被中止（新消息 latest-wins / 手动 abort）时，工具不再执行、未决确认被撤回——此前用户稍后按下的 y 会替一个已死的回合执行写操作。第三方 authority / 确认通道实现可忽略该字段（退化为等应答）。
plugin-cli 不再自建终端确认通道：确认提示（含参数摘要）作为消息进聊天区，在输入框回复 `y` / `ys` 后回车，与 WebUI / OneBot 同一份排队、超时、会话授予语义；此前按单键 `y` 的交互不再有。

### workflow 的 once 触发器一生只触发一次（@aalis/plugin-workflow）

此前 `runAt` 已过的一次性工作流在每次进程启动 / 插件 bounce 时都会再跑一遍（节点若是 send-message 就是每次重启重发）。现在触发后把 `firedAt` 记进运行历史文件，注册时已有记账即跳过；同 id 覆盖定义不会重新触发，要再跑一次先 `workflow_remove` 再定义或直接 `workflow_run`；定义文件被删除后记账随之清除。
**迁移**：运行历史文件从顶层数组升级为 `{ runs, onceFired }`，新代码能读旧文件；降级到旧构建会把运行历史读空并丢掉 once 记账（0.x 不保证降级）。

### @ 判定只认 `<at self>`，OneBot 字符串消息格式在入站统一成 segments（plugin-trigger-policy / plugin-adapter-onebot）

trigger-policy 删掉了 `[CQ:at,qq=…]` 字符串兜底（它不分辨被 @ 的是谁，字符串格式下群里 @ 任何人 bot 都会抢答）；adapter-onebot 在入站把字符串格式（含 `raw_message` 回退与 `get_msg` 引用反查）规范化成 segments，`<at self>` 只由适配器产出。**两包须同批升级**：只升 trigger-policy 而 OneBot 端配 `message_format=string` 时，@ 触发会静默失效。

### 移除（经全仓 grep 确认零消费面）

- `SessionManagerService.setPlatformProfile()`（@aalis/api-session-manager）与 WebUI 动作
  `updatePlatformProfile`（@aalis/plugin-session-manager）：删除从未落盘的运行时写平台档入口——
  参考实现只把它写进内存 Map，`persist()` 只落会话元数据，重启即丢。平台档统一走插件配置
  `platformProfiles`（WebUI 配置页 / `aalis.config.yaml`），读侧 `getPlatformProfiles()` 不变。
- `PlatformAdapter.isReady?()`（@aalis/api-platform）：删除从未有消费者的 isReady——
  适配器可用性一律看 `getConnections()` 里的 `status`；实现过它的 plugin-adapter-onebot 同批删。

## 2026-09-11（无 core 变更；runtime 0.12.0 / api-authority 0.7.0 / api-tools 0.8.0 / schema-message 0.8.0 / plugin-media 等）

### 子命令是默认行为（@aalis/runtime）

`startAalis({ subcommands })` 从 `boolean | string[]` 收成 `string[]`，默认 `process.argv.slice(2)`：
`node index.mjs status` 直接等价于聊天里的 `/status`，执行后退出；argv 非空但首项不是已注册命令时报错退出（exit 2），不会启动守护进程（此前会照常起守护，打错命令名即与运行中实例并存的第二个实例）。argv 为空才进守护进程。
子命令进程是与守护进程零通信的一次性实例：不写 `data/latest.log`（此前会截断守护进程正在写的日志）、不注入重启策略（此前 `restart` 子命令在 `app.stop` 超过 500ms 时会 spawn 出 argv 仍带 `restart` 的 detached 子进程无限连环）；`status` / `shutdown` 只作用于该临时实例；写数据的指令按落点分：写 `aalis.config.yaml` 的经守护进程热重载生效，只改插件内存态的不生效。日志走 stderr，stdout 只有命令结果。
`tryDispatchSubcommand` 返回值从 `number | null` 收成 `number`（未命中返回 2 并经新增的 `err` 回调报错）。
迁移：删掉 `subcommands: true`（现在是默认，仍传也按默认处理）；显式传 `subcommands: false` 的宿主要改传 `[]`——
非数组一律按默认处理，`false` 不再关闭分发；宿主自己解析 argv 的，把要分发的数组显式传入——靠位置参数给守护进程传东西的启动方式现在会 exit 2。

### 确认通道可注销（@aalis/api-authority）

`AuthorityService.setConfirmHandler()` 改为返回注销函数，注册方在 dispose 时调用（plugin-session-confirm / plugin-webui-server / plugin-cli 都经 `whenService` 注册并把它作为 cleanup 返回：跟着 authority 的胜者走，bounce 后自动重挂）。
此前禁用或卸载 session-confirm 后 authority 仍持有已死的 `'*'` 回调，每次需确认的工具调用都要等 60 秒超时才被拒。
第三方 authority 实现需同步返回注销函数；仍返回 `undefined` 的旧实现照常可用，只是注册方无法注销（行为同旧版）。

### 图片处理重定位：识别模型 + 两个正交开关（plugin-media）

`vision.mode` 四档（describe / passthrough / passthrough-raw / disabled）删除，由两个正交键取代：

| 旧值 | 等价的新配置 |
|---|---|
| `describe`（默认） | `recognizeOnArrival: true` + `delivery: 'describe'`（文本主模型下 `auto` 等价） |
| `passthrough` | `recognizeOnArrival: false` + `delivery: 'passthrough'` |
| `passthrough-raw` | 同上；动图不抽帧的实验档已删除，直通一律抽帧 |
| `disabled` | `recognizeOnArrival: false` + `delivery: 'describe'`（档案只留指针，模型可按需 `analyze_image`） |

旧键在启动时**一次性迁移**：plugin-media 按上表映射写入新键、删除 `vision.mode` 并写回配置文件（日志提示一次），
之后 WebUI 上该弃用字段显示为「未设置」。`delivery` 默认 `auto`：按本会话生效主模型的 vision 能力选直通或转文字。**迁移**：无需手动操作；旧键 `vision.mode`
在 schema 里保留一版（标为已弃用），只为让 WebUI 能显示它已被清空。注意主模型带 vision 的部署：新默认（识别 + 直通）会让当轮图片既被识别模型描述又直通主模型，
想保持旧 `describe` 的成本请显式设 `delivery: 'describe'`。同批删掉从未生效的配置：`video.maxTokens` /
`video.think` / `video.prompt`（只喂给从不被选中的 `video.passthrough` processor）与
`document.extractImages`（无消费者）；`document.image` processor 同理不再注册。

### 工具结果携图（api-tools 0.8.0）

`RegisteredTool.handler` 可返回 `string | ToolExecutionResult`（`{ content, images? }`），
`ToolService.execute` 一律返回 `ToolExecutionResult`。**实现或直接调用 `ToolService.execute`
的代码要改读 `.content`**（仓内调用方：plugin-agent / plugin-mcp-server / plugin-workflow 已随批改）。
返回形状的实现方是 plugin-tools：**plugin-tools 与这三个调用方必须同批升级**——旧调用方拿到对象会当字符串用。
反向（新调用方配旧 plugin-tools）已由 api-tools 0.8.0 的 `asToolExecutionResult()` 兜住：三个仓内调用方都经它读结果，
第三方直接调 `execute` 的代码也应如此。
只注册工具、handler 返回字符串的插件零改动。出口编码在 schema-message 0.8.0 的
`prepareLLMMessages`：tool 消息带 `images` 时拆成 tool 文本 + 一条注明来源的 user 图片消息。

## 2026-08-30（无 core 变更；单包 plugin-agent 0.12.1）

### agent：media 缺席时的图片基础体验（盖楼修复）

此前「出口 images 只交出 provider 可解码形态」这条不变量的唯一守卫住在 plugin-media
的 `agent:llm:before` 中间件里——media 缺席时，OneBot 图片附件的落盘相对路径会原样
进入请求，openai/ollama 系模型整轮被拒（400 illegal base64 data），表现为发图即不回话。

现在 agent 在 media 缺席时把这种（且仅这种）已知必炸形态经 storage 物化为 data URI，
保住「视觉主模型直通」的基础体验；物化失败则丢弃该图；其余一切形态（data:/http(s)/
file:// 等）原样透传，由各 provider 自行解析。media 在场时行为逐字节不变（原样透传，
出口规范化仍归 media）。

**注意**：media 缺席时图片一律直通主模型——无模式开关、无体积闸（单图上限即适配器
落盘上限）、动图不抽帧；主模型无视觉能力时图片是否被忽略取决于服务端。需要
describe/passthrough/disabled 分档、抽帧与体积控制，请安装 plugin-media。

## 2026-08-29（无 core 变更；各包独立版号）

本批 17 包：schema-message 0.7.0 / plugin-memory-vector 0.11.0 /
plugin-message-archive 0.10.0 / api-session-manager 0.7.0 / plugin-session-manager 0.10.0 /
plugin-agent 0.12.0 / plugin-user-profile 0.11.0 / plugin-commands 0.10.0 /
plugin-llm-openai 0.10.1 / plugin-adapter-onebot 0.11.1 / plugin-media 0.12.1 /
plugin-memory-summary 0.10.1 / plugin-webui-server 0.11.2 / api-memory 0.5.1 /
api-gateway 0.5.1 / create-aalis 0.5.3 / create-aalis-plugin 0.9.4

### memory-vector：AI 自身回复进入语义召回（recallRoles 双模式）

`schema-message` 新增 `assistant:message:archived` 事件（message-archive 在 assistant
回复落库后发出）；memory-vector 据此索引 AI 自身发言（metadata 带 `role`），新配置
`recallRoles`（默认 `all`）控制其是否参与召回。所有召回到的 assistant 条目强制带
「Assistant·你自己」角色标注（同批的防自我强化地基，不随开关关闭）。

**行为变化**：升级后 AI 的新回复（对外可见回复；工具回合内部前言不入）开始进入向量库
并默认可被召回。`recallRoles: others-only` 过滤的是**语义命中点**（候选池自动放大一倍补偿，
assistant 语料占比很高时命中数仍可能少于从前）；命中点的扩窗邻居不过滤、以角色标注呈现。
存量历史不自动回填。

### user-profile 0.11.0：aalisFeelings 特性整体移除

移除「Aalis 对用户的主观感受」层：配置键 `enableAalisFeelings` / `maxFeelingsPerUser` /
`injectFeelingsForOthers` / `maxFeelingsForOthers`、工具参数 `user_profile_lookup.include_feelings`、
档案字段 `aalisFeelings` 及其抽取/注入路径全部删除。该特性默认关闭且 schema 自述
「不建议开启」（无 sourceQuote 护栏的自我蒸馏回路）。

**迁移**：配置里遗留的四个键会被 config-sync 按 schema 白名单裁剪并告警，不影响启动。
**数据不可逆**：若曾开启过该开关，存量 `aalisFeelings` 字段会在升级后的首次档案写入时
被整体覆写丢弃（saveMetadata 为整条替换语义），无导出/迁移路径；需要保留请在升级前自行导出。

### commands 0.10.0：受信系统源收窄为 scheduler-only

`TRUSTED_SYSTEM_SOURCES` 删除 `workflow` 与 `system` 死项：workflow 派发进虚拟会话的
命令不再免确认，照常走 confirm 闸（虚拟会话无人应答即超时拒绝，fail-closed）。原因：
workflow_define/workflow_run 仅需 level-1，受信等于让 L1 用户绕过确认闸向任意会话投递
高危命令（提权面）。依赖 workflow 静默执行确认类命令的自动化会从「静默执行」变为
「超时拒绝」；如需恢复须自行抬高 workflow 工具档位（另行决策）。

### 会话级 thinking 开关（api-session-manager 0.7.0 / agent 0.12.0 / session-manager 0.10.0）

`SessionConfig` 新增 `think?: boolean`（`/session.set -t on|off` 设置、`/session.reset` 复位，
未设置继承 provider 全局配置）。**同批升级**：plugin-agent 0.12.0 与
plugin-session-manager 0.10.0 需一起升——平台级默认 think 由 session-manager 白名单式
逐字段解析，旧版会静默丢弃该配置字段。

---

## 2026-08-24（无 core 变更；各包独立版号）

本批 19 包：api-tools 0.7.0 / api-authority 0.6.0 / plugin-tools 0.6.0 /
plugin-authority 0.11.0 / plugin-agent 0.11.0 / plugin-scheduler 0.10.0 /
plugin-workflow 0.10.0 / plugin-tool-session 0.10.0 / plugin-subtask 0.11.0 /
plugin-llm-openai 0.10.0 / plugin-llm-deepseek 0.11.0 / plugin-embedding-openai 0.10.0 /
plugin-mcp-client 0.10.0 / plugin-user-relation 0.12.0 /
plugin-tool-system 0.9.5 / plugin-webui-client 0.12.1 / api-process 0.5.2 /
api-llm 0.10.1 / plugin-tool-code-runner 0.9.3。

### llm-openai / embedding-openai / llm-deepseek：baseUrl 语义改为「完整前缀」

插件不再向 baseUrl 硬拼 `/v1`，只拼端点名（`/chat/completions`、`/models`、`/embeddings`）。
与 plugin-asr-openai 的既有约定对齐；Gemini 等无 `/v1` 段的兼容端点
（`https://generativelanguage.googleapis.com/v1beta/openai`）从此可直接配置。

**迁移**（注意：config-sync 会在启动时把默认值物化进配置文件，所以不存在"未配置 baseUrl"的
存量部署——所有跑过旧版的配置文件里都已写着旧默认值）：
- llm-openai / embedding-openai：配置值恰为旧默认 `https://api.openai.com` 的，插件启动时
  **自动就地升级**为 `https://api.openai.com/v1` 并打 warn，无需手动迁移；
  自定义端点（聚合网关等）需自行在末尾补 `/v1`（如 `https://gateway.example` → `.../v1`）。
- llm-deepseek：官方端点 `https://api.deepseek.com` 无需改动（无版本段形态本就是官方文档写法，
  `/models` 此前也不带 `/v1`）；指向第三方 `/v1` 网关的需在 `baseUrl` 补 `/v1`。

### mcp-client：桥接工具默认档位不再是 public

外部 MCP 工具此前默认 `public`（等级 0 可达）。现默认改为按工具注解分档：
自称只读（`readOnlyHint`）→ `sensitive`（等级 1）；有破坏提示或未声明 → `restricted`（等级 2）。
server 配置的 `visibility` 字段新增 `auto`（新默认）与 `sensitive` 两值。

**迁移**：需要恢复旧行为（群成员直接可用）的部署，在对应 server 配置里显式设
`visibility: public`；已显式配置 `public`/`restricted` 的不受影响。

### 授权身份（actor）贯穿工具调用链：委派/子任务/工作流不再匿名执行

`ToolCallContext` 与 `ExecutionGuardContext` 新增可选 `actor` 字段（语义同
`IncomingMessage.actor`）：等级裁决与 owner 自动确认跳过按 actor 评估；`platform`/`userId`
恢复**会话/物理**语义（定时任务归属、平台档继承、记忆平台域、confirm 通道选路不再被
发起者平台覆盖）。`delegate_to_session` / `create_subtask` / `send_to_subtask` /
workflow 的 agent 与 send_message 节点现在都会透传发起者授权身份。

**行为变化**：此前这些路径的目标回合以匿名（等级 0）执行；现在以**发起者等级**执行——
依赖"子任务/委派天然低权"的部署需注意。actor 只从执行上下文 snapshot，LLM 无法经
工具入参指定（防提权）；匿名发起者的目标回合仍为匿名。

### user-relation：consolidate「落笔核实况」不变量

真合并删除的节点不再被同 pass 的派生回写（embedding hash / summary / PageRank）复活；
层级判定落边收进唯一入口（端点活性 + 实时查重 + 走门面）。无迁移动作——存量僵尸节点与
重复边会在后续 consolidate 轮次中被正常清理/去重。

## 0.10.0

契约包大改名 + 四个包的破坏性变更。这批**必须显式升级**，装到一半会同时装进新旧两份
同一契约（各带一份 `declare module`，类型一旦分叉就撞 TS2717，且被 `skipLibCheck` 静默吞掉）。

### 契约包改名（30 个旧名已 `npm deprecate`）

命名从「按插件命名契约」改成「按类型分层」：契约是 `api-*`，纯数据 schema 是 `schema-*`，
提供者实现是 `plugin-<类别>-<厂商>`。

| 旧名 | 新名 |
| --- | --- |
| `@aalis/plugin-<X>-api`（25 个） | `@aalis/api-<X>` |
| `@aalis/plugin-config-api` | `@aalis/schema-config` |
| `@aalis/plugin-message-api` | `@aalis/schema-message` |
| `@aalis/plugin-{deepseek,openai,ollama}` | `@aalis/plugin-llm-{deepseek,openai,ollama}` |

**迁移**：包名整体替换即可，导出符号未变。两个例外——

- `plugin-cron-engine-api` 是**拆包不是纯改名**：`CronEngine` / `useCronEngine` /
  `CronSubscribeOptions` 去了 `api-cron-engine`，但 6 个纯函数 + 2 个类型
  （`validateCronExpr` / `normalizeCronExpr` / `matchesCron` / `parseCronField` /
  `parseEverySeconds` / `dateFieldsInTimeZone` / `CronExprKind` / `ValidateResult`）
  去了新包 `@aalis/util-cron`。用到这些的要装两个包。
- **配置里的 LLM 模型引用要一起改**。`ref.provider` 存的是插件包名，`resolveLLMModel`
  拿它拼 `${provider}/${model}` 精确匹配，改名后旧 ref 一律落空。已持久化的会话级模型
  设置（WebUI 会话、`/session set -m`）也存着这个值，配置文件改完不代表会话跟着改。
  症状是「配置指向的模型不存在：<provider>/<model>」，服务其实注册得好好的。

### 破坏性变更

- **`@aalis/core` 0.10.0** —— `ServiceTypeMap` 现在字面为空，扩展点全部靠 `-api` 包的
  declaration merging 填。影响两处：① `ctx.getService('app')` 这类裸调用退化到
  `<T = unknown>` 兜底重载，要显式写类型参数；② 第三方插件的 `getService` 返回类型
  第一次真正受检——此前 core 内部一个相对说明符的 `declare module './services.js'`
  把接口绑到了第二个符号上，所有 `-api` 包的 augmentation 静默失效。修复后原本
  「能编过」的错误用法会开始报错。**只有裸说明符 `declare module '@aalis/core'` 是安全的。**
- **`@aalis/runtime` 0.10.0** —— 删除配置文件里的 `${VAR}` 环境变量插值与 `.env` 机制。
  密钥直接写进配置（配置文件本就不入库）。**这条是本批走 minor 而非 patch 的关键**：
  按 patch 发的话存量 `^0.9.0` 会自动吃到，配置里的 `${OPENAI_API_KEY}` 会变成
  字面量字符串直接发给上游。
- **`@aalis/plugin-authority` 0.10.0** —— ① `restrictedPolicy` 白名单不再救非 owner：
  它此前在「未授权救援」路径上跨身份生效，被封禁的负等级用户也能被捞回来；
  ② 降权即撤销该用户已有的会话级授予，不再等其自然过期。
- **`@aalis/plugin-webui-client` 0.10.0** —— `Operation` 要求 `minLevel`，必须与
  `plugin-authority` 同批升级。

### 其它

- `@aalis/plugin-package-manager` 的 core peer 下界抬到 `>=0.10.0`：它调用
  `restart({ rollback })`，而 0.9.x 的 `restart()` 不收参数、静默丢弃——市场更新失败后
  不会回滚，起来的是坏版本。

---

## 0.9.1

安全收紧与遗留清理。11 个包，其中 7 个有用户可见的行为变化——**权限收紧修的是非预期
的默认值，不是功能变更**，故走 patch。

### 安全（都是「默认 public」这个坑的实例）

- **`/clear` 的保护此前完全失效**：它原先挂在配置键 `visibilityOverrides` 上，该键在权限
  重构中失效（全仓零处读它），而指令注册时无任何 risk/visibility 声明 → 按默认落到等级 0。
  结果是任意 level-0 群成员可清空会话的消息/摘要/向量/图片。现按会话归属分场景：
  私聊 `confirm` 即可（会话归用户本人，清自己的记忆是自助行为），群/频道需等级 2 或 owner。
- **`/clear.all`** 从 `visibility:'restricted'` 改为 `risk:'dangerous'`——原写法拿到了等级 2
  但**漏了确认**，dangerous 一档同时推出两者。
- **`/authority`** 标 `risk:'sensitive'`（会披露他人权限等级）。
- **`plugin-subtask` 的 create/send_to/delete** 标 `sensitive`：每个子任务是一条独立的 LLM
  会话链，不受信任的调用方可连续调用放大 API 开销。只读的 check/wait 保持 public。
- **`plugin-tool-browser` 的 navigate/click/type/close_page** 标 `sensitive`：页面池是进程级
  共享 Map、取页时不校验会话归属，拿到 pageId 就能操作他人（含 owner）已登录的页面。
  只读的 get_text/get_links 保持 public。

新增 `test/plugins/tool-policy-guard.test.ts` 与 `clear-authorization.test.ts`：读**生效策略**
而非源码文本（防护机制异构，只有生效值可信），正反双向钉住——写类退回 public 会红、
只读被误伤也会红。

### 移除（均经对抗验证确认零消费面）

- session 配置的 legacy `model` / `llmProvider` 字段与其折叠逻辑（服务端 30 行 + 前端 13 行）
- `plugin-skills` 的 `skillsDir` → `skillsUri` 迁移分支
- `plugin-file-reader` 的 `fileRetentionMinutes` 配置项（schema 自身已标【已弃用】）
- `plugin-user-relation` 的 `MergeRejectRecord.aReinforcedAt` / `bReinforcedAt` 及孤儿方法
  `listMergeRejects`
- `plugin-webui-client` 中 `SessionConfigData` 的重复定义

### 文档

README 与脚手架模板里「core 在 0.x 内承诺向后兼容」的表述作废（0.7.0 / 0.9.0 均删过公开面）；
`core-contract.md` 增「1.0 之前的实况」一节列出删除清单与版本号语义。

## 0.9.0

本批 58 个包统一版号 `0.9.0`（未改动的包停在原版号）。**升级 core 必须同批升级
runtime 与所用插件**——兼容单位是整组。

### 破坏性变更

**`@aalis/core` 删除的公开面**

| 删除 | 替代 |
|---|---|
| `CORE_CONFIG_SCHEMA`、`ConfigSchema`、`SchemaField`、`SchemaFieldType`、`SchemaFieldTypes`、`SchemaGroup`、`SchemaArray` | 全部迁至新包 `@aalis/plugin-config-api`，import 改指该包 |
| `ctx.hasService(name)` | `ctx.getService(name) !== undefined` |
| `ctx.getServiceEntries(name)` | `ctx.getAllServices(name)`（返回项现含 `priority`） |
| `ctx.once(event, fn)` | `const off = ctx.on(e, (...a) => { off(); ... })` |
| `PluginManager.createInstance` / `removeInstance` | `register(module, config, instanceId)` + `unload(instanceId)` 组合；配置文件编排由调用方负责 |
| `ServiceContainer.has` | `get(name) !== undefined` |
| `EventBus.removeAll` | 无替代（绕过 dispose 链的所有权账本，刻意移除） |
| `ConfigManager.syncPluginDefaults`、`ConfigManager.trimUnknownFields`、`AppOptions.configSync` | 迁至 `@aalis/runtime` 的 `syncPluginDefaults` / `installConfigHotReload`；`startAalis({ configSync })` |

`PluginStatusEntry` 不再携带 `config` / `configSchema` / `defaultConfig`——它们是配置详情
不是内核状态，改由 `getPlugin(instanceId)` 从 `entry.config` / `entry.module` 读取。

**契约包删除的 helper**（均为 `ctx.getService` 的一行包装，无附加语义）：
`@aalis/plugin-asr-api` 的 `useASRService`、`@aalis/plugin-media-api` 的 `useMediaService`、
`@aalis/plugin-workflow-api` 的 `useWorkflowService`。直接用 `ctx.getService('asr' | 'media' | 'workflow')`。
（包名是当时的；这三个契约包后来分别改名为 `@aalis/api-asr` / `api-media` / `api-workflow`。）

**`declare module` 目标变更**：向 `SchemaField` / `SchemaFieldTypes` 做 declaration merging 的
包，目标从 `'@aalis/core'` 改为 `'@aalis/plugin-config-api'`。**merging 到旧目标不会报错，
只会静默失效**，务必检查。

### 新增

- **新包 `@aalis/plugin-config-api`**：配置表单词汇（`ConfigSchema` 全家 + `SchemaFieldTypes`
  扩展点 + `CORE_CONFIG_SCHEMA`）。零依赖纯类型包。依赖它请用宽区间
  `>=0.9.0 <1.0.0` 而非 caret——0.x 的 caret 锁死 minor，会在加词汇时强制全生态级联重发。
- **第四内核原语「贡献点」**：`ctx.contribute(point, spec)` / `ctx.collect(point)`。
  多方向同一产物各交一块，内核保证 id 幂等、`(槽, 全局键)` 确定性排布、单块错误隔离，
  且**从不执行插件代码**。首个贡献点 `agent:prompt`（提示词组装）。
- **`ctx.hooks` 摊平为 `ctx.runHook(hook, data, defaultAction?, opts?)`**：六动词对称
  （on/emit、provide/getService、middleware/runHook），不再发布可持有的对象句柄。
- **可等待的异步 dispose**：`ctx.disposeAsync(timeoutMs?)`，`onDispose` 返回的 promise
  真正被等待（逐项超时护栏防卡死停机）。已有拆卸在飞时 join 而非早退。
- **前缀缓存命中上报**：`ChatResponse.usage.cachedPromptTokens`（DeepSeek 的
  `prompt_cache_hit_tokens` / OpenAI 的 `prompt_tokens_details.cached_tokens`）。
  `undefined` = 不可知，`0` = 明确无命中，勿用 `?? 0` 抹平。

### 修复

- **自动摘要压缩静默失效**：历史探测条数曾写死 200 并兼作阈值判定样本，导致
  `threshold > 200` 的配置下压缩分支永不进入、零日志。改为由配置推导且保留原下限。
- **停机竞态**：`App.stop()` 撞上在飞的 bounce/unload 时，shutdown 请求被单飞排队后立即
  返回，拓扑逆序编排落空，下游插件的落盘可能写进已关闭的连接。现在先等状态机静置。
- **贡献点两条守卫**：已 dispose 的 Context 上 `contribute` 被拒（否则会顶掉同 id 活实例的
  条目并被连带删除）；退订时摘除登记表条目（否则动态 id 场景无界增长）。
- **流式 usage 丢失**：`if (!delta) continue` 排在 usage 提取之前，导致挂在 `choices: []`
  收尾帧上的 usage 整帧被跳过。两家适配器均已修正顺序。

### 升级须知

1. **只升 core 不升 runtime 会静默丢三项**：`aalis.config.yaml` 的 defaultConfig 回填、
   schema 外字段裁剪、配置文件热重载。不报错、不崩、插件功能正常，但配置文件不再被维护。
2. **旧插件 + 新 core 会炸**：以下已发布版本调用了被删 API，需同批升级到 0.9.0——
   `plugin-webui-server@0.5.2`（加载期失败）、`plugin-tool-system@0.5.2`、
   `plugin-session-manager@0.5.3`、`plugin-office@0.5.0`（三者激活期失败）、
   `plugin-commands@0.5.4`、`plugin-media@0.5.3`（运行期失败）。
3. **第三方插件**：core peerDep 建议写 `>=0.9.0 <1.0.0`（若用了 0.9 新 API）。
   本仓禁用 caret——`^0.x` 只匹配单个次版本，会把插件锁死。
4. **1.0 之前 core 的公开面可能在次版本被删**（0.7.0 与 0.9.0 均已发生）。宽 peerDep 区间
   只是「没用新 API 的插件不必随次版本重发」的便利，不是兼容性承诺。
