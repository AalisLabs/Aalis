# 插件作者隐式契约指南

本文档解释 Aalis 插件作者**容易踩到但 API 文档不会显式提醒的几条约定**。
如果你刚写完一个插件、跑起来"看上去能用"，强烈建议过一遍本指南，确认没漏掉任何一条。

---

## 1. 服务实例替换：你需要主动通知下游吗？

### 简单结论

| 场景 | 你要不要做什么 |
|---|---|
| 插件 dispose 时不主动 dispose 自己 provided 的服务实例 | **什么都不用做**，PluginManager 会处理 |
| 插件 active 期间临时换一个服务实例（同名 provide 二次） | **必须**手动 evict 下游消费者，否则它们仍持有旧引用 |
| 插件配置变更触发热重载 | **走 `updatePluginConfig()`**，PluginManager 已包办 evict |

### 为什么

`ctx.provide(name, instance, opts)` 在 `ctx.dispose()` 时自动从 ServiceContainer
中注销。下游 `optional` 依赖该服务的插件会收到 `service:unregistered` 事件，被
`recompute({type:'service-down'})` 自动 bounce，重新 apply 时拿到新实例。

但如果你**在 active 期间**（不是 dispose）二次调用 `ctx.provide(name, newInstance)` 来"替换"实例：

```typescript
// ❌ 反模式：下游持有的还是旧 instance，不会感知更新
ctx.provide('mysvc', newInstance);
```

正确的做法是：**dispose 自己再让 PluginManager 重启你**：

```typescript
// ✅ 触发 PluginManager 走完整 bounce 流程
await ctx.getService('plugins')!.bouncePlugin(myInstanceId);
```

或者直接通过 `updatePluginConfig` 让 PluginManager 把整套 dispose+evict+reapply
都打包做完。

### 我什么时候真的需要在 apply 内部"换实例"？

**几乎从不需要**。如果你以为需要，多半是把"配置驱动"和"运行时驱动"混了。
配置变了 → `updatePluginConfig`；运行时事件让服务能力变了 → 改服务内部状态而非
重新 provide。

---

## 2. `inject.required` vs `inject.optional`：选哪个？

| 选 required | 选 optional |
|---|---|
| 没这个服务我无法 apply，连注册命令都不能 | 有更好，没有也能跑（功能降级） |
| 服务消失时我必须停下 | 服务消失时我可以保留主功能 |
| 服务实例被替换我应该重新 apply | 服务实例被替换我**也**需要重新 apply（因为我可能注册过依赖于旧实例的回调） |

注意 optional 依赖**也会被 bounce**：当依赖的服务被 unregister 后又重新 provide
（典型场景：另一个插件配置变更触发自己 reload），你会被重新 apply 一次以拿到新
实例引用。这是为了避免"前一秒注册到旧 commands 实例的 `/help` 子命令在新实例
中消失"这类隐性 bug。

### capabilities 数组什么时候用

```typescript
inject: {
  required: [{ service: 'llm', capabilities: ['tool_calling', 'streaming'] }],
}
```

只在以下情况用：
- 你**真的**会调用某个能力 API（比如 `llm.toolCall(...)`），用 capabilities 让框架
  自动在多 LLM 提供者中选满足该能力的最高优先级实现。
- 否则就用裸字符串 `required: ['llm']`，让用户/路由插件决定用哪个 provider。

> 不要把 capabilities 当文档用——它会改变运行时选服务的行为。

---

## 3. `provides` 的隐式约定

声明 `provides: ['mysvc']` 后，PluginManager 会把你视为该服务的"权威提供者"
之一。这意味着：

- 关机时拓扑序保证你**晚于**所有 `inject` 了 `mysvc` 的下游 dispose
- 如果 `mysvc` 出现在某个其它插件的 `requiredServices` 列表里且当前不可用，
  PluginManager 可能会调用 `ensureServiceProvider('mysvc')` 主动激活你

如果你 apply 内部调用了 `ctx.provide('mysvc', ...)` **但没在 module 顶层声明
`provides: ['mysvc']`**，拓扑排序与服务恢复都不会把你考虑进去。结果：
- 关机时下游可能比你先 dispose（虽然有 reactive listener 兜底，但延迟一拍）
- 服务自动恢复时找不到你

**除非有特殊理由，`provides` 应该和 `ctx.provide()` 完全一致**。

---

## 4. `reusable: true` 的代价

```typescript
export const reusable = true;
```

声明后允许同一 module 通过 `name:suffix` 注册多次（典型用例：多个 LLM provider
配多套 API key）。但你需要保证：

- `apply` 内**不直接注册全局命令**（会重复注册），改为通过 `commands` 服务
  路由，命令 handler 内根据 `instanceId` 区分实例
- 如果你 `provides` 服务，所有实例提供的服务**同名**，下游通过 capabilities
  + priority 区分；你需要确保自己的服务实例之间互不串扰
- `displayName` 内最好包含配置区分信息（`displayName: \`OpenAI / ${cfg.model}\``）
  让 WebUI 能区分

如果你的插件**没有这种多实例需求**，**不要**声明 reusable —— 这会让重复注册
直接抛错变成静默允许，掩盖配置 bug。

### 反模式：单实例 apply 内多次 `ctx.provide(同一服务名)`

```typescript
// ❌ 不要这么写
export async function apply(ctx) {
  ctx.provide('llm', backend1, { capabilities: ['chat'] });
  ctx.provide('llm', backend2, { capabilities: ['vision'] }); // 静默失效
}
```

ServiceContainer **允许**同一 contextId 下多次注册（容器层无校验），但下游
按 `contextId` 路由（如按 entryId 直查 LLMModel：`resolveLLMModel(ctx, { provider, model })`）
**只会命中第一个**。第二个 entry 既不会被路由到，也不会被 cap-filter 选中。
dev 模式下 `ctx.provide` 会 warn 一次提醒你。

正确做法：用 `reusable: true` + 配置后缀注册多份，让两个 entry 拥有不同 contextId：

```yaml
plugins:
  '@aalis/plugin-foo:chat': { ... }
  '@aalis/plugin-foo:vision': { ... }
```

---

## 5. dispose hook：什么放进去、什么不放

### ✅ 放进去

```typescript
ctx.onDispose(() => {
  clearInterval(timer);
  childProcess.kill();
  websocket.close();
  fileHandle.close();
});
```

外部资源（OS handle、网络连接、子进程、定时器）**必须**手动清理。

### ❌ 不要放

```typescript
ctx.onDispose(() => {
  ctx.serviceContainer.unregister('mysvc');     // 已自动处理
  ctx.eventBus.off('foo', handler);              // ctx.on() 已自动处理
  ctx.hooks.unregister('bar', handler);          // ctx.middleware() 已自动处理
});
```

通过 `ctx.on / ctx.middleware / ctx.provide / ctx.fork / ctx.createScope` 注册
的所有东西都会被 DisposableChain 按 LIFO 顺序自动注销。手动再做一遍可能 double-free。

### ⚠️ 在 dispose hook 内访问其它服务

PluginManager 保证消费者**先于**提供者 dispose（拓扑反向）。所以你的 dispose
hook **可以**安全访问 `ctx.getService('xxx')`——前提是你在 `inject` 中声明了
依赖。如果只是 ad-hoc 访问没声明的服务，那个服务可能已经先你一步 dispose 了。

---

## 6. 配置 schema：能力比形式重要

`configSchema` 是给 WebUI 自动生成表单的元数据。**关键约定**：

- `secret: true` 字段会在 WebUI 中被遮罩 + 写回时跳过空值（防止误清空）
- `required: true` 仅作前端校验，**core 不强制**——你 apply 内还是要自己判空
- `default` 必须和 `defaultConfig[key]` 一致，否则 WebUI 显示和实际生效值不符
- 嵌套对象用 `SchemaGroup`，数组用 `SchemaArray`，不要用裸 JSON 字符串字段

### 配置变更如何触发 reload

用户在 WebUI 点保存 → `updatePluginConfig(name, newConfig)`：

1. `entry.config = newConfig` + 写回 ConfigManager
2. 如果当前 active：
   - `evictDownstreamConsumers(entry)` 把所有 inject 你 provided 服务的 active 下游降级 pending
   - dispose 你的 ctx → 你的 onDispose hook 执行
   - 你的 entry 状态 → pending
   - `recompute({type:'plugin-state-changed'})` 把你和被 evict 的下游一起按拓扑序重激活
3. 如果之前 error：直接 pending → recompute 重试

**你 apply 内不需要做任何特殊处理**。如果你的服务是无状态的（HTTP client、
工厂函数），下游会在重激活时自然拿到新实例。

---

## 7. 测试插件的最小套路

```typescript
import { createApp } from '@aalis/core';
import myPlugin from './src/index.js';

it('should activate when its dependencies are present', async () => {
  const app = await createApp({ /* ... */ });
  await app.plugin(fakeDepProvider);  // 先注册依赖
  await app.plugin(myPlugin, { /* config */ });
  await new Promise(r => setTimeout(r, 10));  // 让 reactive listener 跑完
  expect(app.plugins.getPlugin('my-plugin')?.state).toBe('active');
});
```

**关键点**：`plugin()` 后**必须** `await` 一个微任务/setTimeout，因为
`service:registered` listener 走异步 `recompute`，同步立刻断言会读到瞬态。

测试 bounce / softReload 时同理 —— bounce 后立刻 assert 服务可用会读到 dispose
中间态，应等 `plugins:changed` 事件触发后再断言。

---

## 8. 何时 fork、何时 createScope、何时新 App

| 隔离需求 | 用法 |
|---|---|
| 一个独立"插件实例"（默认）| `app.plugin(mod, cfg)` 自动 `ctx.fork(id)` |
| 同 App 内子作用域且需要**配置/服务隔离** | `ctx.createScope(id)` |
| 完全独立的事件总线 / 日志通道（少见，例如沙盒执行用户脚本） | `createApp({ events, services, hooks, ... })` 新建 App |

⚠️ `createScope` 的事件总线和钩子注册仍是**全局**的（dispose 时按 contextId
反查清理）。所以**沙盒内不要注册"产生跨作用域副作用"的全局事件**（如
`service:registered`），可能干扰主进程逻辑。

---

## 9. 速查：apply 函数的"做什么 / 别做什么"

### ✅ 应该在 apply 里做

- `ctx.provide(...)` 注册服务
- `ctx.on(event, ...)` 监听事件
- `ctx.middleware(hook, ...)` 注册中间件
- `ctx.whenService(name, svc => …)` **跨插件消费服务的首选** —— 自动响应 provider 上下/下线
- `ctx.registerTool(...)` 注册 AI 工具（通过 plugin-tools-api）
- `useXxxService(ctx).register(...)` 通过 -api 包注册子能力
- `ctx.onDispose(...)` 清理外部资源
- 启动后台 worker / 连接外部服务

### ❌ 不应该在 apply 里做

- `await` 永久阻塞（apply 必须返回，否则 PluginManager 卡住）
- 直接修改全局 process 状态（`process.env`、信号 handler）
- 跨插件 import 实现细节（应只 import `@aalis/plugin-xxx-api`）
- `ctx.serviceContainer.register(...)` / `ctx.eventBus.on(...)` 等绕过自动清理的低层 API（仅供桥接/诊断用）
- 在 apply 内 throw —— 用 `ctx.logger.error` + 优雅降级；throw 会让你的 entry 进 `error` 态直到下次配置变更

---

## 10. 类型化能力（typed capabilities）—— 已有的好东西，记得用

`ServiceCapabilityMap` 是个 declaration-merging 扩展点。`-api` 包应该在自己的入口
文件里把所属服务的能力枚举声明出来：

```typescript
// packages/plugin-llm-api/src/index.ts
export type LLMCapability =
  | 'chat'
  | 'tool_calling'
  | 'streaming'
  | 'vision'
  | 'thinking'
  | (string & {});  // 留逃逸口，允许私有能力字符串

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    llm: LLMCapability;
  }
}
```

收益：
- `ctx.provide('llm', x, { capabilities: ['streaming'] })` 标准能力有自动补全
- `'streaaming'` 这种 typo 会被 IDE 提示 `Did you mean 'streaming'?`
- 模板字面量类型（如 `model:${string}`）能约束"能力名族"
- 运行时**完全不强制**——`(string & {})` 兜底，私有能力随便写，框架不管

**不要**在每个实现包里也声明自己的能力枚举——只 `-api` 包声明，实现包按需引用。

类似地，`AalisEvents` 和 `HookContextMap` 也是 declaration-merging 扩展点，按同样
规则使用：契约由 `-api` 包定义，实现包消费。

---

## 11. 消费跨插件服务的"心智阶梯"

| 顺序 | 写法 | 何时用 |
|---|---|---|
| ① | `useXxxService(ctx)` | -api 包里有对应 helper（如 `useToolService` / `useCommandService`） |
| ② | `ctx.whenService('xxx', svc => …)` | 跨插件消费 + 需要在 provider 重启/替换时**自动**重接 |
| ③ | `inject.required: ['xxx']` + `ctx.getService('xxx')!` | 你已显式声明依赖、PluginManager 保证你被激活时 provider 一定在 |
| ④ | `ctx.hasService('xxx')` + `ctx.getService('xxx')` | 探测性可选依赖（更推荐 `inject.optional` + bounce） |

### 反模式

```typescript
// ❌ 没声明 inject，又直接断言
export async function apply(ctx) {
  const llm = ctx.getService<LLMService>('llm')!;  // provider 还没注册 → 运行时崩
  // ...
}
```

正确：

```typescript
// ✅ 方式 A：声明依赖
export const inject = { required: ['llm'] };
export async function apply(ctx) {
  const llm = ctx.getService<LLMService>('llm')!;  // 框架保证就绪
}

// ✅ 方式 B：whenService 异步等
export async function apply(ctx) {
  ctx.whenService('llm', llm => {
    // provider 上线时调用；返回的清理函数在 provider 下线/ctx dispose 时执行
    const off = llm.onEvent(handle);
    return () => off();
  });
}
```

`whenService` 比"自己 `ctx.on('service:registered', …)` 监听"轻量得多 ——
core 已经处理好"已就绪立刻同步触发 / 反复上下线重接 / dispose 自动清理"。

---

## 12. -api 包：怎么让 `ctx.getService('xxx')` 拿到强类型

`ServiceTypeMap` 也是 declaration-merging 扩展点。`-api` 包里同时声明能力枚举
和类型映射，业务插件只要 `import '@aalis/plugin-xxx-api'`（哪怕只是副作用导入）
就能让 TS 在调用 `ctx.getService('xxx')` 时自动推断出对应接口类型：

```typescript
// packages/plugin-llm-api/src/index.ts
export interface LLMService {
  chat(req: ChatRequest): Promise<ChatResponse>;
  // ...
}

declare module '@aalis/core' {
  interface ServiceTypeMap {
    llm: LLMService;
  }
  interface ServiceCapabilityMap {
    llm: LLMCapability;
  }
}
```

业务插件：

```typescript
import '@aalis/plugin-llm-api';  // 仅副作用：把类型注册进 ServiceTypeMap

export async function apply(ctx) {
  const llm = ctx.getService('llm');
  //    ^? LLMService | undefined  ←  无需手动 <LLMService>
  await llm?.chat({ messages: [...] });
}
```

> ⚠️ 没 import `-api` 包时，`ctx.getService('llm')` 会 fallback 到 `unknown`，
> 你只能 `ctx.getService<LLMService>('llm')` 手动断言。所以**消费方至少要把 -api
> 包作为 devDep / dep 引入并 import 一次**。helper 形式（`useToolService(ctx)`）
> 已经把这个副作用包好了，是最省心的写法。

实现包的 `provides` 服务也建议在 -api 包写类型，自己 import 使用 —— 保持
"接口契约 → -api 包 / 实现 → 实现包"的单向依赖。

---

## 13. 用户偏好放哪里？—— per-user 不进 ServiceContainer
ServiceContainer 有个 `preferences: Map<serviceName, contextId>` 用来"钉死某个
服务的胜者"。**这个机制只用于管理员级 / App 级 default**，不要拿来存 per-user 偏好。

### 为什么

- ServiceContainer 是进程级单例。`A 用户钉了 OpenAI、B 用户钉了 DeepSeek` 在
  WebUI 多用户场景下会互相覆盖
- preferences 没有 user 维度，加进去就要把 tenancy 渗入 IoC，是噩梦
- per-user 偏好语义本质上是**请求维度的 hint**，不是**容器维度的 default**

### 推荐方案

把"用户偏好的 LLM/embedding"等存在用户 profile 数据里：

```typescript
interface UserProfile {
  id: string;
  preferences: {
    llm?: { providerHint?: string; requiredCapabilities?: string[] };
    // ...
  };
}
```

每次请求时显式传入：

```typescript
// agent / chat 路由内
const userPref = await getUserProfile(sessionUserId);
const llm = ctx.getService<LLMService>('llm');
const res = await llm.chat({
  messages,
  provider: req.provider ?? userPref.preferences.llm?.providerHint,
  // ...
});
```

优先级链清晰可追溯：**req 显式 > user 偏好 > 管理员 preference > priority enum**。

### 多租户怎么办？

- **Layer A（不同公司）**：走部署，每租户一个独立进程 + 独立 `AALIS_DATA_DIR`
- **Layer B（沙盒/测试）**：`createApp({ events, services, hooks })` 已经支持完全隔离
- **Layer C（同租户内多用户）**：上面的"per-user profile + 请求级 hint"方案

**不要**为了多租户改 ServiceContainer。让 IoC 保持"一进程 = 一产品实例"心智。

---

## 相关文档

- [docs/architecture.md](architecture.md) — 整体架构
- [docs/core/context.md](core/context.md) — Context API 详解
- [docs/core/plugin.md](core/plugin.md) — PluginManager 内部
- [docs/design/service-persistence.md](design/service-persistence.md) — 各服务 bounce 时的状态保持情况
