# ContributionRegistry — 贡献点

**源码**: `packages/core/src/contributions.ts`

贡献点是 Aalis 的第四内核原语：**往共享产物里"交一块料"，排布权归收集方**。

四原语按「执行 / 数据」二分：

| 原语 | 类别 | 语义 |
|---|---|---|
| events | 执行 | 广播通知——无返回、错误隔离、不可拦截 |
| hooks | 执行 | 中间件管道——可变 data、可短路、错误上溯 |
| services | 数据 | 按名解析**单胜者**（偏好 > 优先级 > 注册顺序） |
| contributions | 数据 | 确定性枚举**全量**（按全局键码元序） |

## 与 hooks 的分工（判别法）

**改写或截停既有流程/产物 → hooks；往共享产物添自己的一块 → 贡献点。**

贡献者不掌握控制流：拿只读视图、看不到其他贡献的产出、无短路、无排序影响力。
换来的是收集方能统一给出 hooks 结构上给不了的保障——幂等（同键不重复物化）、
确定性排布（与注册顺序/插件激活序无关）、错误隔离（单块失败不连坐）、并行执行。
重复注入、排布漂移、错误连坐、卡链饿死这些在中间件注入时代靠纪律避免的事故，
在贡献点 API 上**无法表达**。

## API

```typescript
// 交付一份贡献（返回 dispose；挂 dispose 链，插件卸载自动清扫）
const off = ctx.contribute('agent:prompt', {
  id: 'my-block',            // 局部幂等键：非空、不含 '/'；同 ctx 同 id 重复注册 = 替换
  anchor: 'context',         // 点自己的字段（agent:prompt 的槽位词汇）
  build: async view => (view.dryRun ? null : await loadBlock(view.sessionId)),
});

// 收集（贡献点 owner 调用；任何插件都可拥有自己的贡献点——驱动公开）
for (const { key, spec } of ctx.collect('agent:prompt')) {
  // key  = 全局键 `${贡献方 ctx.id}/${局部 id}`——归属标识
  // spec = 注册方交付的本体（引用，不拷贝、不改写）
}
```

## 内核语义

- **全局键**：注册时自动冠 `${ctx.id}/` 前缀。spec.id 侧无法顶替他人贡献（含 `/` 的
  局部 id 在注册期抛 `TypeError`，防跨 ctx 键碰撞构造）。信任锚是 ctx.id 本身——
  `fork(id)` 不保证唯一，这是 Context 模型的既有信任边界，与 provide / middleware 一致。
- **确定性**：`collect` 按全局键码元序排序；同一注册集合在任意注册顺序、任意机器上
  枚举结果逐字节相同。顺序是键的纯函数，重复注册无法影响排位。
- **无执行**：内核只做注册与枚举，永不调用 spec 上的任何函数。如何执行（并行 / 隔离 /
  超时 / 排布）是收集方的策略——如 `agent:prompt` 的组装器（`plugin-agent` 的
  `prompt-assembly.ts`）选择并行 build + 单块错误隔离 + 四锚位排布。
- **清理**：dispose 链与 `unregisterByContext` 双路径，插件卸载/热重载（bounce）自动清扫。

## 现有贡献点

| 贡献点 | owner | spec | 说明 |
|---|---|---|---|
| `agent:prompt` | `@aalis/plugin-agent` | `PromptContribution`（`@aalis/plugin-agent-api`） | LLM 提示词块；锚位 `identity` / `knowledge` / `context` / `turn-hint`，`build(view)` 返回 `string | string[] | null` |

## 定义自己的贡献点

经 declaration merging 扩展 `ContributionPointMap`（spec 类型须含 `id: string`），
然后在自己的关键路径上 `collect` 并按自己的策略执行：

```typescript
// my-plugin-api/src/index.ts
declare module '@aalis/core' {
  interface ContributionPointMap {
    'my-plugin:panel': { id: string; title: string; render(): string };
  }
}

// my-plugin（贡献点 owner）：收集、排布、执行全在这里
const sections = ctx.collect('my-plugin:panel').map(({ key, spec }) => {
  try {
    return `## ${spec.title}\n${spec.render()}`;
  } catch {
    return null; // owner 自选的隔离策略
  }
});
```

同槽多贡献的顺序是全局键码元序——**确定但无语义**；两块内容有顺序依赖时，
应合并为同一个贡献（如 `agent:prompt` 的 build 返回数组，块间保序）。
