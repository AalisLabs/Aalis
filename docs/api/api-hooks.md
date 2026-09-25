# api-hooks — 钩子契约

**包名**: `@aalis/api-hooks`  
**源码**: `packages/api-hooks/src/index.ts`  
**实现**: `@aalis/plugin-hooks`

## 概述

钩子是有序的中间件管道：同一钩子键上的中间件按登记顺序串行执行，可以修改传入的 data，也可以不调用 `next()` 截停整条链（包括默认动作）。事件则是广播通知，不可拦截（见 [core/events](../core/events.md)）。

本包定义 `hooks` 描述符（服务名 `hooks`）、绑定接口 `Hooks`、中间件签名 `MiddlewareFn` / `MiddlewareNext`、提供者契约 `HookRegistry` 与扩展点 `HookContextMap`，不含实现。core 不内置钩子，默认提供者是 [`@aalis/plugin-hooks`](../plugins/plugin-hooks.md)，提供者不独占。使用钩子的插件在 `uses` 里声明 `hooks`，并把 `@aalis/api-hooks` 加进 `dependencies`；部署时须装上提供者插件。

## 绑定接口

```ts
type MiddlewareNext = () => Promise<void>;
type MiddlewareFn<T> = (data: T, next: MiddlewareNext) => Promise<void>;

interface RunOptions {
  /** 广播型相位：某 handler 返回却没调 next() 时点名告警 */
  warnOnStall?: boolean;
}

interface Hooks {
  middleware<K extends string & keyof HookContextMap>(hook: K, fn: MiddlewareFn<HookContextMap[K]>): () => void;
  run<K extends string & keyof HookContextMap>(
    hook: K,
    data: HookContextMap[K],
    defaultAction?: () => Promise<void>,
    opts?: RunOptions,
  ): Promise<boolean>;
}
```

- `middleware(hook, fn)` 经 `registrar` 登记，返回退订，随本次激活撤回。每次调用都是一条独立登记：同一激活可以在同一钩子上挂多个 handler，没有同键替换。提供者尚未就绪时登记留在账上，提供者上线后挂上。
- `run(hook, data, defaultAction?, opts?)` 驱动一条钩子链。返回 `true` 表示走到底（执行了默认动作，或链上没有 handler），`false` 表示被某个中间件截停。
- 没有提供者时 `run` 返回被拒的 Promise，不执行默认动作。
- `warnOnStall`：某个 handler 没有调用 `next()`、且其后还有 handler 时，提供者点名告警。第一方用于 `agent:llm:before`。

## 执行模型

```
hooks.run(hookName, data, defaultAction)
  │
  ▼
中间件 A（先登记） ───── await fn(data, next)
  │ next()                     │ 不调用 next() → 截停
  ▼                             ▼
中间件 B（后登记）        链终止，defaultAction 不执行
  │ next()
  ▼
defaultAction() ← 所有中间件都调用 next() 后执行
```

- **数据修改**：data 按引用传递，修改 data 即影响后续中间件与默认动作。
- **流程控制**：调用 `next()` 继续；不调用则中止后续中间件与默认动作。在 `await next()` 之后的代码可以做后处理。
- **错误**：中间件抛出的错误沿链上溯，`run` 以拒绝传给调用方。
- **归属**：每条登记归属登记方这次激活，激活关闭时与事件、服务登记同一拍撤回。

## 顺序

链内按登记顺序执行，不使用数字优先级。相位之间的次序由调度方显式表达（如 gateway 的 `INBOUND_PHASE_ORDER`）；相位内的 handler 应与顺序无关，或由相位的拥有方约定。

登记序是门面在登记时分配的序号（进程内全部 api-hooks 副本共用一个计数器，单调递增），随登记一起交给提供者，提供者按它排链：

- **提供者重启**：依赖它的插件先关闭，再按拓扑序重新激活并重新登记，链序即重新激活的次序，与冷启动相同。
- **换提供者**：以更高优先级换上另一个提供者时，消费者不重启，各插件的登记逐个重挂到新提供者，提供者按登记序还原原来的交错次序，重挂完成后链序不变。已知现状：换人瞬间正在执行的链会跳过已移走的中间件；胜者在容器里同步换人，重挂完成前新发起的链只能看到已经搬过来的中间件。两种情形下截停者都可能缺席、默认动作照样执行，只发生在运行中换提供者的那一刻，只装 `@aalis/plugin-hooks` 一个提供者的部署不会遇到。

## 提供者契约

```ts
interface HookRegistry {
  register(hook: string, fn: MiddlewareFn<unknown>, contextId: string, order: number): () => void;
  run(hook: string, data: unknown, defaultAction?: () => Promise<void>, opts?: RunOptions): Promise<boolean>;
}
```

插件不直接调用 `HookRegistry`：登记经 `hooks` 的绑定门面，门面填入本激活 id（`contextId`，供卡链告警点名）与登记序（`order`）。自行实现提供者时：

- `register` 须按 `order` 升序插入该钩子的链；返回的退订幂等，只撤这一条。
- `run` 的返回值语义与绑定接口相同。

## 扩展钩子键

`HookContextMap` 是空接口，各 `-api` 包经 declaration merging 注入「钩子名 → 中间件上下文」：

```ts
import type {} from '@aalis/api-hooks'; // declaration merging 锚点

declare module '@aalis/api-hooks' {
  interface HookContextMap {
    'schedule:before': { jobId: string; cron: string };
  }
}
```

注入后 `hooks.middleware()` 与 `hooks.run()` 按键获得精确类型。同一文件里若还要增广 `AalisEvents`，另写一个 `declare module '@aalis/core'` 块。要让 TS 看到某个包注入的键，需把该包加进依赖（值导入或 side-effect import）。

## 第一方钩子键

键名与 data 类型的权威定义在各包的 `declare module` 声明里。

| 注入方 | 钩子键 | 用途 |
|---|---|---|
| `@aalis/api-agent` | `agent:input:before` / `agent:llm:before` / `agent:llm:after` / `agent:tool:before` / `agent:tool:after` / `agent:reply:before` / `agent:turn:after` | agent 一轮处理的各阶段，见 [api-agent](./api-agent.md) |
| `@aalis/api-gateway` | `inbound:confirm` / `inbound:command` / `inbound:flow` / `inbound:trigger` / `inbound:dispatch` / `outbound:dispatch` | 网关出入站的命名相位，见 [services/gateway](../services/gateway.md) |
| `@aalis/api-memory` | `memory:clear` | 统一记忆清理编排，见 [api-memory](./api-memory.md) |

## 典型用法

往提示词里加内容不走钩子，而是交给 `agent:prompt` 贡献点（见 [api-contributions](./api-contributions.md)）：贡献点由收集方统一保证幂等、确定性排布与错误隔离。钩子用于改写与截停。

```ts
import type {} from '@aalis/api-agent'; // 引入 agent:* 钩子键
import { hooks } from '@aalis/api-hooks';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-hooks',
  uses: { hooks },
  apply({ hooks }) {
    // 拦截消息：不调用 next，整条链终止
    hooks.middleware('agent:input:before', async (data, next) => {
      if (data.message.content.trim() === '') return;
      await next();
    });

    // 后处理回复内容
    hooks.middleware('agent:reply:before', async (data, next) => {
      await next();
      data.content = data.content.trim();
    });
  },
});
```

定义自己的钩子时，在关键路径上调用 `hooks.run`，默认动作放在第三个参数里：

```ts
const reachedEnd = await hooks.run('schedule:before', { jobId, cron }, async () => {
  await executeJob(jobId);
});
if (!reachedEnd) logger.info(`任务 ${jobId} 被中间件截停`);
```

## 实现者

- [@aalis/plugin-hooks](../plugins/plugin-hooks.md) —— 默认提供者
