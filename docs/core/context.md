# 插件定义与能力

插件与框架的交界面是一份**定义对象**和一次激活上**按声明装配的能力**，不是一份公开的执行上下文。

**源码**: `packages/core/src/context/definition.ts`、`packages/core/src/context/binding.ts`、`packages/core/src/context/builtins.ts`

## 定义对象

```typescript
import { definePlugin, events, logger, provide, lifecycle, optional } from '@aalis/core';
import { memory } from '@aalis/api-memory';

export default definePlugin({
  name: '@scope/plugin-example',
  displayName: '示例',
  uses: { events, logger, provide, lifecycle, memory: optional(memory) },
  apply({ events, logger, provide, lifecycle, memory }) {
    logger.info(`激活 ${lifecycle.id}`);
    const off = events.on('app:started', () => logger.info('已启动'));
    lifecycle.onDispose(off);
  },
});
```

`definePlugin` 在模块加载时校验声明表（`name` 合法、`uses` 每一项都是描述符或 `optional()` 包装）并原样返回，好让 `apply` 的参数类型从 `uses` 推导出来。加载器只接受 **default 导出的定义对象**。

`name` 须为非空字符串，且不含子模块分隔符 `#`、也不含实例后缀 `:suffix`（`:suffix` 只用于 `register` 的 instanceId）。手写、未经 `definePlugin` 的对象在 `register` 还会再过同一道闸：校验失败返回 `false` 并 warn，不抛错。

字段：

| 字段 | 说明 |
|---|---|
| `name` | 插件名，与 `package.json` 的 `name` 一致；单实例时即实例 id |
| `displayName` / `subsystem` | 展示元数据。core 不读、不校验 `subsystem` 取值 |
| `uses` | 用到的全部能力。键是 `apply` 的参数名，值是描述符；可选依赖包一层 `optional()`。没有默认注入 |
| `provides` | 本插件提供的服务描述符列表。激活后按本次激活的 instanceId 校验确已 `provide`；未提供则本次激活进入 `error` |
| `core` | 核心插件，不能被用户禁用 |
| `reusable` | 允许同一份定义以 `name:suffix` 多次注册；默认 false |
| `apply(caps)` | 拿到绑定接口后的装配。可返回 Promise |

`PluginMeta` 是空接口：core 对额外字段零感知，只原样带在定义上。配置表单（`configSchema`）由 `@aalis/schema-config`、对 core 的扩展声明（`extends`）由 `@aalis/api-webui` 经 declaration merging 挂进来。详见 [types.md](types.md)。

## uses 与装配

声明即装配：写了什么，插件就只能碰到什么。内置能力与第三方服务用同一套入口——都是描述符，放进 `uses`，`apply` 拿到按这次激活绑定的接口。

```typescript
import { definePlugin, optional, events, logger, provide } from '@aalis/core';
import { tools } from '@aalis/api-tools';
import { memory } from '@aalis/api-memory';

export default definePlugin({
  name: '@scope/plugin-example',
  uses: {
    events,
    logger,
    provide,
    tools,                 // required：未就绪则顶层插件保持 pending
    memory: optional(memory),
  },
  apply({ tools, memory }) {
    tools.register({ /* ... */ });
    const items = memory.current; // 可能为 undefined
  },
});
```

- **required**（未包 `optional` 的外部服务）：参与激活闸。缺席则顶层插件 `pending`，恢复后重新激活。
- **optional**：不参与激活闸；绑定接口与 required 完全相同，只是激活闸这一条不同。
- **内置能力**（`events` / `logger` / `config` / `lifecycle` / `provide` / `services` / `hooks` / `contributions`）：绑的是这次激活自身的运行基础设施，不经容器解析、不可被 `provide` 替换，也不参与激活闸。不声明它们不影响框架对这次激活的管理（登记归属、撤回与关闭照常）；只是 `apply` 拿不到对应接口。
- 声明即计入关停编排（required 与 optional，访问与否无关）。

`optional()` 用模块私有品牌标记：assemble 只认 `optional()` 盖过的包装，描述符自有 `optional` 字段不算。

## 内置能力

| 描述符 | 绑定接口 | 作用 |
|---|---|---|
| `events` | `Events` | `on` / `emit`，监听随这次激活撤回 |
| `hooks` | `Hooks` | `middleware` / `run` |
| `contributions` | `Contributions` | `contribute` / `collect` |
| `lifecycle` | `LifecycleCap` | `id`、`closed`、`onDrain`、`onDispose`、`module` |
| `logger` | `Logger` | 这次激活的日志器 |
| `config` | 只读对象 | 这次激活的插件配置视图。整份宿主配置是另一项能力，见下方 `hostConfig` |
| `provide` | `Provide` | 唯一的服务发布入口 |
| `services` | `Services` | 动态查询与偏好。查到的不是声明依赖 |

宿主管理面另有三个**普通服务**（不是内置能力），管理类插件必须写进 `uses` 才拿得到：

| 描述符 | 服务名 | 说明 |
|---|---|---|
| `appService` | `app` | 停机、重启、存配置、热扫描 |
| `pluginsService` | `plugins` | 插件管理动作与状态 |
| `hostConfig` | `host-config` | 整份配置的读写与落盘 |

## provide

```typescript
import { definePlugin, defineService, provide } from '@aalis/core';

interface Greeter {
  hello(name: string): string;
}
const greeter = defineService<Greeter>('greeter');

export default definePlugin({
  name: '@scope/plugin-greeter',
  uses: { provide },
  provides: [greeter],
  apply({ provide }) {
    provide(greeter, { hello: name => `hi ${name}` }, { priority: 10, label: 'default' });
  },
});
```

实现按描述符的提供者类型约束。返回退订，随这次激活撤回。选项：

- `priority` / `label`：解析序与展示
- `entryId`：一个激活登记多条时的子粒度 id，须以本激活 id 为前缀（`${id}/${子粒度}`）
- `onBehalfOf`：代为登记。条目的逻辑身份取被代者 id（偏好、服务页、`provides` 校验的 `hasByContext` 都认这个 id），清理仍归本激活。代登记**不计入代理人的 `provides`**：若把代登记的服务写进本清单，会以「声明 provides 但未实际注册」进入 `error`。与 `entryId` 二选一。

dev 模式下，实际注册了但未写入 `provides` 的服务会 warn：下游依赖排序找不到该 provider。生产宿主应显式传入 `AppOptions.devMode: false`。

## ServiceRef

普通调用型服务的绑定接口。required 与 optional 拿到的是同一接口。

```typescript
interface ServiceRef<P> {
  readonly current: P | undefined;  // 当前胜者；无提供者为 undefined
  require(): P;                     // 无提供者抛错
  all(): ServiceView<P>[];          // 全部提供者，每次调用重新枚举
  follow(attach: (provider: P) => void | (() => unknown)): () => void;
}
```

解析顺序：**偏好 > 优先级 > 注册顺序**。`current` / `require` / `all` 每次查询重新解析。

契约是「每次查询解析当前值」：`current` / `require` 返回的是**提供者本身**，不是自动转发所有调用的代理。调用方把它存起来就得自己承担它失效。

- 长期缓存 `current` 或 `all()[i]`：提供者换人后，旧引用是否仍可用取决于该实现有没有失效逻辑——有则后续调用抛错，无则可能静默成功。关停编排**不**保护这些缓存引用。
- `require()` 在 required 依赖丢失到调度收敛之间也可能短暂抛错。
- 要用提供者建立长期状态（SDK 句柄、订阅）走 `follow`。

既登记又被调用的服务（如 agent：预处理器登记 + 对话调用）在自定义 `bind` 里把登记方法作为第二参数传入 `serviceRef(port, { registerX })`。不要用对象展开去拼——`current` 是 getter，展开会把它求值成一次性快照。

## follow

跟随提供者建立有状态资源，取代整插件重启式的依赖更新。胜者替换不一律重启消费者。

```typescript
apply({ llm, lifecycle }) {
  const stop = llm.follow(provider => {
    const client = provider.connect();
    return () => client.close(); // 同步返回清理函数；清理本身可以是异步的
  });
  lifecycle.onDispose(stop);
}
```

- **attach 必须同步**返回 `void` 或清理函数。返回 thenable 会被接住并 warn，该 Promise 的拒绝不会逃逸，也**不会**被当成 cleanup。
- 在场即调 attach；换人时先跑上次返回的清理，等它的 Promise **落定**（完成或被拒——被拒只记 warn，不代表资源已释放）之后才用新实例调 attach。
- 等待期间再换人只跟到最新的。关闭或退订之后不再挂载，哪怕旧清理后来才落定。
- 旧清理永不落定则新实例永不挂上；关闭时按超时放弃并点名。
- 提供者不变则不重挂。

`registrar`（注册型能力）与 `follow` 不同：换人时立即在新提供者重挂，旧异步撤回可后台进行，关闭会等它。不能声称所有新旧资源绝无重叠。见 [枢纽服务](../design/hub-services.md)。

## 动态查询（`services`）

```typescript
apply({ services }) {
  const llm = services.get(llmDesc);       // 有描述符则带类型
  const named = services.get('llm');       // 运行期字符串，类型为 unknown
  services.prefer('llm', someInstanceId);
}
```

查到的服务**不是声明依赖**：不参与激活闸，不享有重绑与关停顺序保证，关停期可能拿空。需要这些保证就写进 `uses`。单独卸载提供者不享有整个 App 关停的交接保证。

## 生命周期

`lifecycle.id` 是这次激活的实例 id（多实例为 `name:suffix`，子模块为 `父id#模块名`）：日志、展示、路由用的逻辑名，不是资源身份。归属用不透明激活身份，不从 id / `entryId` 字符串前缀猜。

### `onDrain` / `onDispose`

```typescript
lifecycle.onDrain(async () => {
  await persistPendingWork(); // 停接新活、把在手的数据交给下层并等它确认
}, 'flush');

lifecycle.onDispose(async () => {
  await conn.close();
}, 'db');
```

- **onDrain**（收尾段，最先执行）：此刻本激活的监听、登记与依赖都还在。依赖交接（把最后一笔交给还活着的提供者）放这里。
- **onDispose**（清理段）：本激活的对外登记已撤回；依赖可能已不可用，只释放自己的资源。
- 都可以返回 Promise。编排层在 unload / bounce / 停机路径上走分阶段关闭，会等待异步清理。
- `label` 仅进诊断日志，超时或抛错时点名。

不要用 `events.on('app:stopping', …)` 做资源清理——那只在 app 全局停机时触发一次，不会在 bounce / unload 时触发。该事件定位是知会，不是清理通道。见 [events.md](events.md)。

关停编排以激活为单位，分收尾（drain）与关闭（close）两阶段。边只来自框架管理的关系：声明的依赖（含子模块、含尚未访问的 optional）在编排那一刻解析到的胜者，以及存活的托管绑定与尚未落地的撤回。不追踪调用方缓存的裸引用；经 `services` 动态查到的服务不产生边。

承诺按依赖形状分三种，不是一条无条件规则：

1. 普通依赖（required 与 optional 胜者：别的插件、兄弟模块）：消费者整个 close 完，提供者才 drain。
2. 父使用自己子树的服务：父 drain 先于子 close；父 `onDrain` 期间子树仍活着。到父 close 时子已按归属关闭。
3. 后代使用祖先的服务：不往排序图加边。归属树已保证子 close 先于祖先 close，drain 在 close 之前，故子 drain 时祖先仍活着。祖先若同时用这棵子树（第 2 种），第 2 种边把祖先 drain 插在子 close 之前，两笔收尾都能用到对方。因此父子互用不再形成二元环。

环：optional 边构成的强连通分量先让成员全部 drain，再任一 close（不告警；drain 期间双方都能 `require()`）；环里只剩 required 边仍无解才告警并强行放行。环外与归属约束不松。单独卸载提供者不在整次 `App.stop()` 计划里，不享有上述交接。

单个异步清理项的等待上限由 `AppOptions.disposeTimeoutMs` 注入（默认 5000；0=不设限）：超时放弃该项、继续后续清理并 warn 点名。超时只是停止等待，不代表资源已释放。

### `lifecycle.module(definition, config?)`

挂一个子模块：独立身份与生命周期，能力按子激活重新绑定，随父关闭。子模块不进调度器。

- 挂载时缺 required 服务即拒绝（抛错，`apply` 不执行）。
- 挂载之后不再设闸：提供者离场时登记排队、引用可能为空，由父模块决定是否关掉它。不能说子模块与顶层插件调度完全相同。
- 返回 `ModuleHandle`：`id`（同名重复挂载时已唯一化：`parent#name`、`parent#name~2`…）、`dispose()`（同步请求关闭，异步清理不等待）、`disposeAsync(timeoutMs?)`（等待全部异步清理；名字在此之后才释放）。

## 宿主入口

宿主不拿插件那份绑定。`App` 提供：

- `app.plugin(definition, config?, instanceId?)`：注册定义对象
- `app.bind(uses)`：按与插件同一套描述符为**根激活**装配绑定接口，登记归属根激活、随 App 停止撤回
- `app.config` / `app.plugins` / 四张底层注册表（`events` / `services` / `hooks` / `contributions`）

插件拿的是自己激活的绑定，不复用 `app.bind` 的那一份。

## 内部激活记录

`Context` 不再从包根导出，也不是插件契约。运行时内部仍用激活记录（`packages/core/src/context/context.ts`）承接归属、清理链与容器门面；插件与宿主经描述符拿到的是按激活绑定的能力。内部结构无 semver 承诺，不要从深路径 import，也不要把激活记录当成稳定 API。
