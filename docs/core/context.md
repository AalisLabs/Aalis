# 插件定义与能力

插件与框架的交界面是一份**定义对象**和一次激活上**按声明装配的能力**，不是一份公开的执行上下文。

**源码**: `packages/core/src/composition/plugin-definition.ts`、`packages/core/src/composition/descriptors.ts`、`packages/core/src/composition/binding.ts`、`packages/core/src/composition/core-services.ts`

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

`name` 须为非空字符串，且不含保留字符 `#`、也不含实例后缀 `:suffix`（`:suffix` 只用于 `register` 的 instanceId）。空白（trim 后空）与 `__proto__` / `constructor` / `prototype` 同样拒绝；`instanceId` 同规则（允许 `name:suffix`）。手写、未经 `definePlugin` 的对象在 `register` 还会再过同一道闸：校验失败返回 `false` 并 warn，不抛错。定义期 `definePlugin` 抛错；登记期不抛、返回 `false`。

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

声明即装配：写了什么，插件就只能碰到什么。Core 基础服务与第三方服务共用容器与装配路径——都是描述符，放进 `uses`，由各自的 `bind` 生成接口。

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

- **required**（未包 `optional` 的服务）：参与激活闸。缺席则顶层插件 `pending`，恢复后重新激活。
- **optional**：不参与激活闸；绑定接口与 required 完全相同，只是激活闸这一条不同。
- **Core 基础服务**（`events` / `logger` / `config` / `lifecycle` / `provide` / `services` / `hooks` / `contributions`）：启动时由根激活经 `provide` 独占登记，与第三方服务同一条路径；提供者只向在 `uses` 里声明了它的激活交出属于该激活的接口，声明同样计入 required / optional。它们在加载插件前已经可用；不声明也不影响框架管理资源，只是 `apply` 拿不到对应接口。见 [内置服务的登记](service.md#内置服务的登记)。
- 声明即计入关停编排（required 与 optional，访问与否无关）。

`optional()` 使用同版本 Core 副本可识别的包装标记；描述符自有 `optional` 字段不算。

## Core 默认登记的服务

| 描述符 | 绑定接口 | 作用 |
|---|---|---|
| `events` | `Events` | `on` / `emit`，监听随这次激活撤回 |
| `hooks` | `Hooks` | `middleware` / `run` |
| `contributions` | `Contributions` | `contribute` / `collect` |
| `lifecycle` | `LifecycleCap` | `id`、`closed`、`onDrain`、`onDispose` |
| `logger` | `Logger` | 这次激活的日志器 |
| `config` | 只读对象 | 这次激活的插件配置视图。整份宿主配置是另一项能力，见下方 `hostConfig` |
| `provide` | `Provide` | 唯一的服务发布入口 |
| `services` | `Services` | 动态查询与偏好。查到的不是声明依赖 |

宿主管理面另有三个服务，同样由根激活独占登记、通过 `uses` 声明：

| 描述符 | 服务名 | 说明 |
|---|---|---|
| `appService` | `app` | 停机、重启、存配置、热扫描 |
| `pluginsService` | `plugins` | 插件管理动作与状态 |
| `hostConfig` | `host-config` | 整份配置的读写（窄面 `HostConfig`，不含 `watch` / `save`；落盘经 `appService.saveConfig`） |

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

实现按描述符的提供者类型约束，容器保存的就是这个对象。返回的退订同步撤回这一条登记，重复调用无副作用；未退订的登记在提供方激活关闭时整体撤回。选项：

- `priority` / `label`：解析序与展示
- `exclusive`：独占这个服务名；与已有登记冲突、或该条目存在期间添加其他提供者，都会抛错。Core 基础服务与第三方使用同一规则
- `entryId`：一个激活登记多条时的子粒度 id，须以本激活 id 为前缀（`${id}/${子粒度}`）
- `onBehalfOf`：代为登记。条目的逻辑身份取被代者 id（偏好、服务页、`provides` 校验的 `hasByContext` 都认这个 id），清理仍归本激活。代登记**不计入代理人的 `provides`**：若把代登记的服务写进本清单，会以「声明 provides 但未实际注册」进入 `error`。与 `entryId` 二选一。

dev 模式下，实际注册了但未写入 `provides` 的服务会 warn：启动拓扑使用声明清单，遗漏会影响排序；关停依赖则按实际提供者身份建立。生产宿主应显式传入 `AppOptions.devMode: false`。

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

契约是「每次查询解析当前值」：`current` / `require` 返回的是**本次解析的实例**，不是自动转发所有调用的代理。调用方把它存起来就得自己承担它失效。

- 长期缓存 `current` 或 `all()[i]`：提供者换人后，旧引用是否仍可用取决于该实现有没有失效逻辑——有则后续调用抛错，无则可能静默成功。手动缓存的引用不建立关停边。
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

查到的服务**不是声明依赖**：不参与激活闸，不自动重绑，不产生依赖边，关停期可能拿空。需要声明等待与跟随就写进 `uses`。动态查内置服务拿到的是提供者函数，只接受在 `uses` 里声明了该服务的激活身份，未声明者拿不到接口。`services.inspect(key)` 只读元数据，适合服务列表。声明的依赖在单独 unload / disable / bounce 提供者时也享有与整机停机同样的交接保证。

## 生命周期

`lifecycle.id` 是这次激活的实例 id（多实例为 `name:suffix`）：日志、展示、路由用的逻辑名，不是资源身份。归属用不透明激活身份，不从 id / `entryId` 字符串前缀猜。

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

关停编排以激活为单位，分收尾（drain）与关闭（close）两阶段。边只来自框架管理的关系：声明的依赖（含尚未访问的 optional）在编排那一刻解析到的胜者，以及存活的托管绑定与尚未落地的撤回。不追踪动态查询与调用方缓存的裸引用。

承诺按依赖形状分三种，不是一条无条件规则：

1. 普通依赖（required 与 optional 胜者，即别的插件）：消费者整个 close 完，提供者才 drain。
2. 根激活使用插件的服务（宿主经 `app.bind` 取用）：根 drain 先于该插件的 close；根 `onDrain` 期间该插件尚未关闭，但可能已执行 drain。到根 close 时插件已按归属关闭。
3. 插件使用根激活登记的服务（基础服务、宿主服务，以及宿主经 `app.bind({ provide })` 发布的服务）：不额外增加依赖边。归属保证插件 close 先于根 close，因此插件 drain 时根尚未关闭；这不保证根还没执行 drain。根也依赖该插件时，按第 2 条安排根 drain，避免把互用变成两个 drain 互相等待。

环：optional 边构成的强连通分量先让成员全部 drain，再任一 close（不告警）；环里只剩 required 边仍无解才告警并强行放行。环外与归属约束不松。单独 unload / disable / bounce 提供者时，正在用它的 required 下游（传递闭包）并入同一批关闭，上述交接同样成立。这里保证的是框架的调用顺序与等待：插件若在 drain 中自行撤回服务或关闭连接，框架无法维持该实现可用；业务交接仍须返回可等待的 Promise，并处理失败。

关闭回调不能等待同一计划中排在自身之后的阶段。例如在 `onDrain` 中 `await app.stop()`（或返回这个 Promise）：停机要等这次收尾完成，收尾又在等停机完成，两者就会互等。收尾应等待数据交接本身完成，再由计划继续执行后续阶段。计划外的调用者仍可 `await app.stop()` 等实际关闭完成；重复请求加入已有关闭，不改变计划顺序，也不会提前兑现。

单个异步清理项的等待上限由 `AppOptions.disposeTimeoutMs` 注入（默认 5000；0=不设限）：超时放弃该项、继续后续清理并 warn 点名。超时只是停止等待，不代表资源已释放。

本次没有为插件 `apply` 或 `app:*` 屏障监听器新增超时。`disposeTimeoutMs` 不保证整个 `register()` / `stop()` 有统一上限：尚未进入清理阶段时，永不落定的初始化或屏障监听器仍可能阻止流程推进。

## 宿主入口

宿主不拿插件那份绑定。`App` 提供：

- `app.plugin(definition, config?, instanceId?)`：注册定义对象
- `app.bind(uses)`：按与插件同一套描述符为**根激活**装配绑定接口，登记归属根激活、随 App 停止撤回
- `app.config` / `app.plugins` / 四张底层注册表（`events` / `services` / `hooks` / `contributions`）

插件拿的是自己激活的绑定，不复用 `app.bind` 的那一份。

## 内部职责

旧 `Context` 类已拆解。服务装配、资源管理与插件编排按职责组织，所有服务共用描述符、容器和绑定路径：

| 部分 | 职责 |
|---|---|
| `kernel/DisposableChain` | 分段清理、逆序执行与异步等待，不认识服务或插件 |
| `infrastructure/Resources` | 一次激活的资源账与关闭过程：清理登记、收尾段、初始化等待、在飞撤回与同步获取操作记账；关闭相位等待这些工作落定 |
| `orchestration/Activation` | 内部身份、配置视图、资源记录、子激活和依赖边；不提供四原语操作门面 |
| `orchestration/ActivationHost` | 创建激活、经根激活登记内置服务、按 `uses` 装配能力；关闭时按归属同栈切断本激活的原语登记 |
| `composition/core-services` | 内置八项的描述符与提供者：提供者按调用方身份交出这次激活的 `events` / `provide` 等接口 |
| `composition/descriptors`、`plugin-definition` | 服务与插件定义、类型推导，以及资源口契约 |
| `composition/service-watch` 与 `composition/binding` | 前者只观察服务胜者变化；后者负责 `follow` 交接、`registrar` 登记与逐条撤回 |

插件只使用 `apply` 收到的能力，宿主通过 `app.bind` 装配根激活的能力。上表中的内部类与深路径均不属于稳定公开 API。
