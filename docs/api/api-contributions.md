# api-contributions — 贡献点契约

**包名**: `@aalis/api-contributions`  
**源码**: `packages/api-contributions/src/index.ts`  
**实现**: `@aalis/plugin-contributions`

## 概述

贡献点用于往共享产物里「交一块料」，排布权归收集方。

本包定义 `contributions` 描述符（服务名 `contributions`）、绑定接口 `Contributions`、`ContributionSpec` / `ContributionHandle`、提供者契约 `ContributionRegistry`、共用的 id 校验 `assertContributionId` 与扩展点 `ContributionPointMap`，不含实现。core 不内置贡献点，默认提供者是 `@aalis/plugin-contributions`，提供者不独占。使用贡献点的插件在 `uses` 里声明 `contributions`，并把 `@aalis/api-contributions` 加进 `dependencies`；部署时须装上提供者插件。

四种协作形状按「执行 / 数据」二分：

| 形状 | 所在 | 类别 | 语义 |
|---|---|---|---|
| events | core 原语 | 执行 | 广播通知——无返回、错误隔离、不可拦截 |
| hooks | `@aalis/api-hooks` | 执行 | 中间件管道——可变 data、可短路、错误上溯 |
| services | core 原语 | 数据 | 按名解析**单胜者**（偏好 > 优先级 > 注册顺序） |
| contributions | `@aalis/api-contributions` | 数据 | 确定性枚举**全量**（按全局键码元序） |

## 与 hooks 的分工（判别法）

**改写或截停既有流程/产物 → hooks；往共享产物添自己的一块 → 贡献点。**

贡献者不掌握控制流：拿只读视图、看不到其他贡献的产出、无短路、无排序影响力。
换来的是收集方能统一给出 hooks 结构上给不了的保障——幂等（同键不重复物化）、
确定性排布（与注册顺序/插件激活序无关）、错误隔离（单块失败不连坐）、并行执行。
重复注入、排布漂移、错误连坐、卡链饿死这些在中间件注入时代靠纪律避免的事故，
在贡献点 API 上**无法表达**。

## 绑定接口

```ts
interface ContributionSpec {
  id: string; // 局部幂等键：非空、不含 '/'
}

interface ContributionHandle<S extends ContributionSpec = ContributionSpec> {
  readonly key: string; // 全局键 `${激活 id}/${spec.id}`
  readonly spec: S;     // 登记时原样传入的 spec（引用，不拷贝）
}

interface Contributions {
  contribute<K extends string & keyof ContributionPointMap>(
    point: K,
    spec: ContributionPointMap[K] & ContributionSpec,
  ): () => void;
  collect<K extends string & keyof ContributionPointMap>(
    point: K,
  ): ReadonlyArray<ContributionHandle<ContributionPointMap[K] & ContributionSpec>>;
}
```

- `contribute(point, spec)` 经 `registrar` 登记，返回退订，随本次激活撤回。提供者尚未就绪时登记留在账上，提供者上线后挂上。
- `collect(point)` 返回快照；没有提供者时抛服务不可用。

```ts
// 交付一份贡献（返回退订；随这次激活撤回）
const off = contributions.contribute('agent:prompt', {
  id: 'my-block',            // 局部幂等键：非空、不含 '/'；同激活同 id 重复登记 = 替换
  anchor: 'context',         // 点自己的字段（agent:prompt 的槽位词汇）
  build: async view => (view.dryRun ? null : await loadBlock(view.sessionId)),
});

// 收集（贡献点 owner 调用；任何插件都可拥有自己的贡献点——驱动公开）
for (const { key, spec } of contributions.collect('agent:prompt')) {
  // key  = 全局键 `${贡献方 lifecycle.id}/${局部 id}`——归属标识
  // spec = 注册方交付的本体（引用，不拷贝、不改写）
}
```

## 语义

- **全局键**：登记时由门面自动冠 `${激活 id}/` 前缀。局部 id 禁空、禁含 `/`，违者登记期抛 `TypeError`，因此 spec.id 侧构造上无法顶替他人条目。该保证以激活的逻辑 id 为命名空间：调度器保证 `instanceId` 不重复；仍出现重复 id 的两方共用同一命名空间。
- **替换**：同一激活内同局部 id 重复登记即替换（幂等）；旧退订对已被替换的登记无动作。
- **关闭后登记**：已关闭的激活上 `contribute` 被拒（warn + no-op），不影响同 id 的活实例。
- **确定性**：`collect` 按全局键码元序排序；同一登记集合在任意注册顺序、任意机器上枚举结果逐字节相同。顺序是键的纯函数，重复登记无法影响排位。以更高优先级换上另一个提供者时，各插件的条目逐个重挂到新提供者，重挂完成后 `collect` 结果不变；重挂完成前的 `collect` 只含已搬过来的条目。
- **无执行**：登记表只做登记与枚举，永不调用 spec 上的任何函数。如何执行（并行 / 隔离 /
  超时 / 排布）是收集方的策略——如 `agent:prompt` 的组装器（`plugin-agent` 的
  `prompt-assembly.ts`）选择并行 build + 单块错误隔离 + 五锚位排布。
- **撤回**：按激活撤回，不按逻辑 id：激活关闭时与事件、服务登记同一拍撤回；同名激活的迟到清理不会删掉新占位。

## 提供者契约

```ts
interface ContributionRegistry {
  register(point: string, spec: ContributionSpec, contextId: string): () => void;
  collect(point: string): ReadonlyArray<ContributionHandle>;
}
```

插件不直接调用 `ContributionRegistry`：登记经 `contributions` 的绑定门面，门面填入本激活 id（`contextId`）。自行实现提供者时：

- `register` 按全局键 `${contextId}/${spec.id}` 登记，同键为替换；返回的退订在同键已被替换时无动作。
- `collect` 按全局键码元序枚举快照，spec 按引用给出。
- id 校验与门面共用 `assertContributionId(point, id)`。

## 现有贡献点

| 贡献点 | owner | spec | 说明 |
|---|---|---|---|
| `agent:prompt` | `@aalis/plugin-agent` | `PromptContribution`（`@aalis/api-agent`） | LLM 提示词块；锚位 `identity` / `knowledge` / `context` / `turn-context` / `turn-hint`（前三者在历史前、供会话级稳定材料，`turn-context` 在历史后、供每轮取材的材料——分界依据见概念文档《消息与 LLM 管线》），`build(view)` 返回 `string | string[] | null` |

## 定义自己的贡献点

经 declaration merging 扩展 `ContributionPointMap`（spec 类型须含 `id: string`），
然后在自己的关键路径上 `collect` 并按自己的策略执行：

```typescript
// my-plugin-api/src/index.ts
import type {} from '@aalis/api-contributions'; // declaration merging 锚点

declare module '@aalis/api-contributions' {
  interface ContributionPointMap {
    'my-plugin:panel': { id: string; title: string; render(): string };
  }
}

// my-plugin（贡献点 owner）：收集、排布、执行全在这里
const sections = contributions.collect('my-plugin:panel').map(({ key, spec }) => {
  try {
    return `## ${spec.title}\n${spec.render()}`;
  } catch {
    return null; // owner 自选的隔离策略
  }
});
```

同一文件里若还要增广 `AalisEvents`，另写一个 `declare module '@aalis/core'` 块。

同槽多贡献的顺序是全局键码元序——**确定但无语义**；两块内容有顺序依赖时，
应合并为同一个贡献（如 `agent:prompt` 的 build 返回数组，块间保序）。

## 实现者

- [@aalis/plugin-contributions](../plugins/plugin-contributions.md) —— 默认提供者
