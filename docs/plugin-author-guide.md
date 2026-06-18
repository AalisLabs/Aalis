# 插件作者隐式契约指南

本文档解释 Aalis 插件作者**容易踩到但 API 文档不会显式提醒的几条约定**。
如果你刚写完一个插件、跑起来"看上去能用"，强烈建议过一遍本指南，确认没漏掉任何一条。

> **重要前置阅读**：[node-usage-policy](architecture/node-usage-policy.md) —— 业务插件**不能**直接 import `node:fs` / `node:child_process` / `node:os` / `node:http(s)`，必须通过 `@aalis/plugin-storage-api` / `@aalis/plugin-process-api` 等网关访问。biome 会拦截违例。

---

## 1. 服务实例替换：你需要主动通知下游吗？

### 简单结论

| 场景 | 你要不要做什么 |
|---|---|
| 插件 dispose 时不主动 dispose 自己 provided 的服务实例 | **什么都不用做**，PluginManager 会处理 |
| 插件 active 期间临时换一个服务实例（同名 provide 二次） | **必须**手动 evict 下游消费者，否则它们仍持有旧引用 |
| 插件配置变更触发热重载 | **走 `updatePluginConfig()`**（现为 `bouncePlugin(name, { config })` 别名）；PluginManager 包办 dispose+reapply。下游是否级联看 `requiresBounceOnDepChange`（默认否） |

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
- 下游插件 `inject.required: ['mysvc']` 时，拓扑序保证你**先于**它们激活（提供者先起、消费者后起）

如果你 apply 内部调用了 `ctx.provide('mysvc', ...)` **但没在 module 顶层声明
`provides: ['mysvc']`**，拓扑排序不会把你考虑进去。结果：
- 关机时下游可能比你先 dispose（虽然有 reactive listener 兜底，但延迟一拍）
- 激活时下游的依赖排序找不到你（仅靠 reactive 兜底）

> dev 模式下 core 会在 apply 完成后扫描并 warn：「插件 X 注册了服务 [Y] 但未在
> module.provides 中声明」，提示你补全 `provides` 列表。

**除非有特殊理由，`provides` 应该和 `ctx.provide()` 完全一致**。

---

## 3.5 级联契约（opt-in）：`requiresBounceOnDepChange`

### 默认行为

当某个 provider 插件被 bounce（配置更新 / 热重载 / 手动重启）时，
**inject 了它服务的下游插件默认不会被级联重启**。下游应该通过
**lazy `ctx.getService()`** （在方法内调用时查询，而非 apply 时缓存）
透明拿到新的 provider 实例。

### 何时设 `requiresBounceOnDepChange: true`（罕用）

只有以下场景才需要让下游级联 bounce：

- 你的 provider **改变了服务的核心能力 / 契约**（如动态增删 capability）
- 下游消费者**必须重新 apply 才能感知变化**（无法通过 lazy lookup 兼容）
- 典型例：schema-changing provider、需要下游重新注册回调 / 子命令的 provider

```typescript
export const module: PluginModule = {
  name: '@aalis/plugin-schema-provider',
  provides: ['schema'],
  requiresBounceOnDepChange: true,  // 下游 inject schema 的插件会被级联重新 apply
  apply(ctx) { ... },
};
```

### 下游推荐写法：lazy getter

```typescript
// ✅ 推荐：存 ctx，方法内查询
class MyConsumer {
  constructor(private ctx: Context) {}
  async doWork() {
    const llm = this.ctx.getService<LLMService>('llm');
    if (!llm) return;
    return llm.chat({...});
  }
}
```

```typescript
// ❌ 反模式：apply 时缓存，provider 被 bounce 后拿到还是旧实例
class BadConsumer {
  constructor(private llm: LLMService) {}  // 在 apply 内 = ctx.getService('llm')
}
```

参考实现：plugin-session-manager、plugin-memory-summary、plugin-message-archive
都采用该模式让 `memory` provider 的切换对它们透明。

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
`ctx.provide` 会 warn 提醒你（详见 `validateProvide`）。

正确做法二选一：

**方案 A：`reusable: true` + 配置后缀**——适合「多套獨立配置」（如多套 API key），
每份配置一个独立实例：

```yaml
plugins:
  '@aalis/plugin-foo:chat': { ... }
  '@aalis/plugin-foo:vision': { ... }
```

**方案 B：单实例 apply 内传 `options.entryId` 拆子粒度**——适合「单插件实例、
但对外提供多个 entry」（如 per-model LLM、per-pool embedding）：

```typescript
export async function apply(ctx, cfg) {
  for (const model of cfg.models) {
    ctx.provide('llm', new LLMBackend(model), {
      capabilities: model.capabilities,
      entryId: `${ctx.id}/${model.id}`, // 显式拆子粒度，抽抽 warn
    });
  }
}
```

下游走 capability filter / preference 机制选中所需实例（高优先级 / 偏好），
或在请求参数中显式传 `provider` / `model` hint（参见 plugin-openai / plugin-deepseek
的 `resolveLLMModel` 实现）。

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

用户在 WebUI 点保存 → `updatePluginConfig(name, newConfig)`（现为
`bouncePlugin(name, { config })` 的薄壳别名）：

1. `entry.config = newConfig` + 写回 ConfigManager
2. 如果当前 active：
   - `evictDownstreamConsumers(entry)` 仅针对声明了 `requiresBounceOnDepChange: true` 的
     active 下游降级 pending（默认 false 不级联）
   - dispose 你的 ctx → 你的 onDispose hook 执行
   - 你的 entry 状态 → pending
   - `recompute({type:'plugin-state-changed'})` 把你和受影响的下游按拓扑序重激活
3. 如果之前 error：直接 pending → recompute 重试

**你 apply 内不需要做任何特殊处理**。如果你的服务是无状态的（HTTP client、
工厂函数），下游在下一次 `ctx.getService()` lazy 查询时会自然拿到新实例。

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
- `useToolService(ctx).register(...)` / `useCommandService(ctx).command(...)` 通过 -api 包注册子能力
- `ctx.onDispose(...)` 清理外部资源
- 启动后台 worker / 连接外部服务

### ❌ 不应该在 apply 里做

- `await` 永久阻塞（apply 必须返回，否则 PluginManager 卡住）
- 直接修改全局 process 状态（`process.env`、信号 handler）
- 跨插件 import 实现细节（应只 import `@aalis/plugin-xxx-api`）
- `ctx.serviceContainer.register(...)` 等绕过自动清理的低层 API（仅供桥接/诊断用）
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

### `AalisEvents` 是封闭的：动态事件名怎么办？

`AalisEvents` / `HookContextMap` **没有** `[key: string]` 兜底（对扩展开放、对拼写
错误封闭）：没声明过的事件名会在 `ctx.on` / `ctx.emit` 处直接编译报错。固定事件逐条
declare 即可；事件名需要**运行时动态生成**（按频道 / 任务 / 会话 ID 派生）时，官方
出路是在自己命名空间内合并一条**模板字面量签名**（TS 4.4+）：

```typescript
declare module '@aalis/core' {
  interface AalisEvents {
    'myplugin:ready': [];                                  // 固定事件：逐条声明
    [k: `myplugin:channel:${string}`]: [msg: ChannelMessage]; // 动态事件名族
  }
}
```

两条纪律：

- **前缀必须是自己插件的命名空间**。模板签名会吸收该前缀下的一切事件名，
  撞了别人的前缀就互相吞类型。
- **不要把模板签名当万能逃逸口**（如 `` [k: `x:${string}`] ``宽到没有信息量）。
  能枚举的事件就逐条声明——封闭性的价值正在于契约可枚举。

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

## 发布到插件市场

Aalis 市场走**纯 npm 路线**，无自建服务器、无静态索引——发现靠 npm registry 的
keyword 检索，分发靠 npm 包本身。要让你的插件出现在市场里：

1. **打 keyword**：`package.json` 的 `keywords` 必须含 `"aalis-plugin"`（脚手架已自动产出）。
   市场按 `npm registry search keywords:aalis-plugin` 发现插件。**官方插件用 `@aalis/` scope**
   （市场标"官方"）；社区插件任意包名（标"社区"）。
2. **依赖正确归类**（决定发布后能否被正确安装——脚手架已产出正确形态）：
   - `@aalis/core` → **`peerDependencies: ">=0.2.0 <1.0.0"`**（宿主提供核心，不每插件 bundle 一份）
     + `devDependencies: workspace:*`（开发期编译）。**宽松区间是刻意的**：core 承诺 0.x 内向后
     兼容、破坏性变更才升 1.0.0，所以 `>=0.2.0 <1.0.0` 接受任何 0.x 宿主 core——你的插件不必
     随 core 次版本升级而重发，慢更新的插件也永远跟得上官方框架。**不要用 caret**（`^0.2.0` 只
     匹配 `0.2.x`，会把插件锁死在某个 core 次版本，core 一升就显示不兼容）。
   - 仅 `import type` / declaration merging 的 api 包 → **`devDependencies`**（编译期擦除，
     运行时不装）。**注意**：若你写的是 `-api` 契约包且其导出类型引用别的包，那些要留
     `dependencies`（类型会传递给消费方）。
   - 运行时用到值（`useXxxService`、helper、常量）的 api/util 包 → `dependencies: workspace:^`。
   - 市场展示字段直接读 `package.json`：`description`/`author`/`license`/`repository`/`version`。
3. **声明 `aalis.service` 供装前披露**：市场在 npm 上**安装前**只能读 `package.json`
   （拿不到代码里的 `inject`），所以在 `package.json` 加：
   ```json
   "aalis": { "service": { "required": ["llm"], "optional": ["memory"], "provides": ["my-service"] } }
   ```
   保持与代码 `inject.required/optional` + `provides` 一致。装后市场仍会按实际 `inject` +
   工具/指令 `permissions` 聚合细化（双重披露）。
4. **breaking change 记 changelog**：core 在 0.x 内**承诺向后兼容**（次版本只做加法/温和改），
   真正的破坏性变更才升 **1.0.0**——那是唯一会要求插件适配的线（`>=0.2.0 <1.0.0` 区间正建立
   在这承诺上）。core/契约包的不兼容变更必须在 `CHANGELOG.md` 记录迁移说明。
5. **发布**：`pnpm publish:all`（仓库根，递归拓扑序发 core→api→util→插件、跳 private、
   转 workspace 协议）。单插件 `npm publish`。私有/未发布插件仍可走 monorepo 本地安装。

> 安全模型：市场是**透明披露 + 用户知情同意**，不是技术隔离。安装第三方插件
> 等于授予它声明的能力；真正的执行隔离（如 code_runner 沙箱）由容器化层负责。

## 相关文档

- [docs/architecture.md](architecture.md) — 整体架构
- [docs/core/context.md](core/context.md) — Context API 详解
- [docs/core/plugin.md](core/plugin.md) — PluginManager 内部
- [docs/design/service-persistence.md](design/service-persistence.md) — 各服务 bounce 时的状态保持情况
