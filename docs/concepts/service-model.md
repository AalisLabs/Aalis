# 服务模型（Service Model）

> 受众：编写 / 维护 Aalis 第三方插件的开发者。

服务模型是 Aalis 最基础的概念。几乎所有其它能力（LLM、存储、命令、鉴权……）都以「服务」的形态注入容器，再由消费方按名取用。读懂本文，后续 `docs/services/*` 里的各篇服务详解才有落点。

Aalis 的依赖注入（DI / IoC）建立在一个按名字寻址、支持同名多实现的服务容器之上。插件通过 `ctx.provide(name, instance)` 把一个实例登记进容器；消费方通过 `ctx.getService(name)` 取回当前胜者。容器只认名字，没有「能力维度」的选择——这一点很重要，详见 [能力选择已下沉](#能力选择已下沉至-api-层0510-移除)。

---

## 1. 核心模型

### 1.1 一个名字，多个提供者

容器内部是一张 `Map<string, ServiceEntry[]>`：每个服务名对应的不是单个实例，而是一个 entry 列表。这意味着 `llm`、`storage`、`memory` 这些名字可以同时被多个插件 provide——OpenAI 与 DeepSeek 可以同时 `provide('llm', ...)`，sqlite 与 mongodb 可以同时 `provide('memory', ...)`，它们并存在同一个列表里。

一个 `ServiceEntry` 的形状如下：

```ts
interface ServiceEntry {
  instance: unknown;   // 服务实例（你 provide 进去的对象）
  priority: number;    // 优先级，数字越大越优先
  contextId: string;   // 注册者的 Context id（卸载清理的依据）
  label?: string;      // 可选展示标签，如 "OpenAI / gpt-4o"
}
```

### 1.2 胜者解析规则：偏好 > 优先级 > 注册顺序

`getService(name)` 返回的是当前唯一的胜者。容器统一经 `resolveEntries()` 排序，三层规则严格依此优先级：

1. **偏好（preference）**：所有者显式 `preferService(name, contextId)` 指定的 provider 永远排第一，即使它的 `priority` 数值更低。偏好可以在目标 entry 注册之前就设置，一旦对应的 contextId 注册即生效。
2. **优先级（priority）**：没有偏好、或偏好目标当前不存在时，按 `priority` 降序。register 时即完成稳定降序排序。
3. **注册顺序**：`priority` 相同时，先注册者胜出，由稳定排序保证。

`get<T>()` 直接返回排序后列表的第 0 个。

`priority` 的推荐取值是 `ServicePriority` 枚举：

```ts
export const ServicePriority = {
  Backend: 0,    // 普通后端实现（plugin-llm-openai / plugin-llm-deepseek 等）
  Override: 50,  // 用户级覆盖：希望默认胜过普通后端
  System: 200,   // 保留给核心系统级覆盖
} as const;
```

> 历史注记：曾经存在一个 `Router = 100` 槽位（router / facade 层），在 `feat/service-granularity` 之后已废弃。现在 LLM / storage / platform 全部改为按 model / root / sessionId 直接注册多条 entry，跨 entry 的聚合由各自 `*-api` 的 helper 承担，不再有同名的 facade entry。

裸数字 `priority`（例如介于 `Backend` 与 `Override` 之间的 `10`）是允许的；dev 模式只会打一条 debug 日志，提醒你自行记载它的含义。

---

## 2. 提供方（Provider）

### 2.1 `ctx.provide(name, instance, options?)`

注册一个服务实例，返回一个 `dispose()` 函数，用于精确卸载这一条 entry：

```ts
const dispose = ctx.provide('memory', myMemoryService, {
  priority: ServicePriority.Backend, // 默认 0
  label: 'SQLite memory',
});
// 之后若想主动下线：dispose();
```

`provide` 会自动把卸载登记进 Context 的 disposable 链，插件 unload / bounce 时无需你手动清理。卸载会 emit `service:unregistered`，触发依赖此服务的下游重新解析（见 §5）。

`options` 支持三个字段：

- `priority?: number` —— 含义见 §1.2。
- `label?: string` —— 供管控视图（WebUI / CLI status）展示用。
- `entryId?: string` —— 覆盖默认的 `contextId`（默认为 `ctx.id`）。用于「一个插件实例拆出多条逻辑 entry」的场景，见 §3。

### 2.2 一个插件实例只 provide 一次同名服务（默认）

默认情况下，同一个 Context 对同一个服务名只能 `provide` 一次。重复 provide（不带显式 `entryId`）会被 dev 校验拦下并 warn：下游若按 `contextId` 路由，只能命中第一条，后续注册会静默失效。

要在同一个插件里跑多套配置（例如多个 API key），推荐的做法是在 module 上声明 `reusable = true`，再用 `name:suffix` 形式注册多个插件实例，每个实例有独立的 Context 与 contextId。

---

## 3. Per-entry 粒度与 entryId 约定

有些插件天然需要为「子粒度」各开一条 entry，而不是为每个子粒度起一个插件实例。典型场景有两类：

- **per-model LLM**：一个 OpenAI 插件实例发现并挂载多个模型，每个模型一条 `llm` entry。
- **per-root storage**：一个存储插件挂载多个 root，每个 root 一条 entry。

这种情况下用 `options.entryId` 覆盖默认的 contextId。约定是：`entryId` 必须以 `ctx.id` 为前缀、以 `/` 分隔，即 `'${ctx.id}/${子粒度标识}'`。

以 plugin-llm-openai 为例：

```ts
const dispose = ctx.provide('llm', handle, {
  label: `${baseLabel} / ${modelId}`,
  entryId: `${ctx.id}/${modelId}`,  // 如 "@aalis/plugin-llm-openai:main/gpt-4o"
});
```

::: warning entryId 必须带 `ctx.id/` 前缀
插件卸载时，容器靠 `unregisterByContext(ctx.id)` 批量清理，它只会移除所有「`contextId === id`，或以 `id + '/'` 为前缀」的 entry。一旦 `entryId` 脱离这个前缀，卸载时就会漏清理，留下僵尸 entry。dev 模式会对此校验并 warn，但 `dispose()` 函数本身不依赖该约定。
:::

实践中，各插件通常还会自管 per-entry 的 dispose 句柄（例如 `registered: Map<modelId, dispose>`），以便单独上线 / 下线某个子粒度，而不必重挂整个插件。

---

## 4. 消费方（Consumer）

### 4.1 `ctx.getService(name)` —— 即取即用，别缓存裸引用

`ctx.getService(name)` 返回当前时点的胜者裸实例，或者 `undefined`。

::: warning 不要缓存裸实例
返回的是调用那一刻的裸实例，provider 发生换跳后它不会跟随更新。不要把它长期存进类字段——provider bounce 或偏好切换都会让旧引用失效。常规做法是在 handler 或方法体作用域内每次重新 `getService`。
:::

容器查询是 O(1) 的 map 命中加上从已排序列表取首，每次 `getService` 都重查，开销可以忽略。

类型推断方面：传入字面量服务名（如 `'memory'`）会命中 `ServiceTypeMap`，自动推断为 `MemoryService | undefined`；传入字符串变量或未登记的名字则退回 `<T = unknown>`，需要你自行 narrow。`ServiceTypeMap` 由各 `*-api` 包通过 declaration merging 反向注入，core 内部不登记任何条目。

### 4.2 `ctx.getAllServices(name)` —— 枚举所有提供者

`ctx.getAllServices(name)` 返回所有 entry 的 `{ instance, contextId, label }`，顺序遵循「偏好 > 优先级 > 注册顺序」。它是领域级筛选的入口（见 §6）：像「列出所有 LLM 模型」「找一个支持 vision 的模型」这类需求，都从这里拿到全集，再自行过滤。

### 4.3 `ctx.whenService(name, cb)` —— 晚绑定 / 跟随切换

`ctx.whenService(name, cb)` 是一个持续订阅：胜者上线时调用一次 `cb(svc)`，胜者下线或换人时自动运行上一次 `cb` 返回的 cleanup。它内部监听 `service:registered` / `service:unregistered` / `service:preference-changed`，但只关心容器当前的胜者态，因此对事件乱序或合并天然免疫。

它适用于两类场景：

- **把副作用挂到 hub 服务上**：`ctx.whenService('tools', svc => svc.register(myTool, ctx.id))`，hub 被 bounce 或换提供者时会自动重挂。
- **跟随 provider 切换**：`cb` 返回 cleanup，胜者换人时先 cleanup、再用新实例重挂。

语义细则如下：

- 调用时若服务已就绪，立即首挂。
- 胜者不变则不动：败者 entry 的上下线不触发重挂；只有胜者换人（包括偏好切换、以及胜者注销后由次优顶上）才会 cleanup 加重挂。
- `cb` 可以返回 cleanup；返回的 dispose 与 `ctx.dispose()` 都会调用它，且 dispose 是幂等的，可多次调用。

### 4.4 偏好的公开 API

偏好的公开 API 是 `ctx.preferService(name, contextId)` / `unpreferService` / `getPreferredService`。请走 Context 的这套公开 API，而不是容器层的 `prefer`：前者会额外 emit `service:preference-changed`，从而触发 `whenService` 重挂；容器层的 `prefer` 标注为 `@internal`，插件不应直接调用容器。所有者也可以在 WebUI 的 Services 页面设置偏好。

---

## 5. 生命周期：bounce、级联与惰性的默认契约

provider 的上下线会驱动插件库重算（`RecomputeReason`）：`service-up` 可能让 pending 插件激活；`service-down` 会让 required 依赖者停用、让 optional 依赖者 bounce。

默认契约是：core 不主动级联 bounce 下游。绝大多数插件应当让 `getService` 在每次调用时惰性查询，从而天然跟随 provider 切换，无需 bounce。

`requiresBounceOnDepChange?: boolean` 是逃生舱。只有当插件无法响应式处理状态时才设为 `true`——例如必须在启动期把 provider 引用一次性缓存进第三方 SDK 内部，或 apply 时要跑昂贵的同步初始化。设为 `true` 后，core 会在依赖的 provider 变化时主动级联 dispose 加 reapply。凡是能用 `getService` 惰性查询、或用 `whenService` 重挂的场景，都不要打开它。

插件 dispose 时，容器还会跑一套「服务自清理协议」：任何实例只要实现了 `unregisterByPlugin(contextId)`，都会被统一通知，清理与本上下文相关的注册项（如 ToolService / CommandService）。core 不硬编码任何具体服务名。

---

## 6. 能力选择已下沉至 *-api 层（0.5.0 移除）

这是相对旧版的一个关键变化，需要建立正确的心智模型。

0.5.0 之前，内核 DI 里有一个「服务能力选择层」（`ServiceCapabilityMap` / `getServiceCapabilities`，`getService` / `provide` 可以带能力维度）。该层已整体删除。现在：

- `provide` / `getService` / `getAllServices` 只接受 name，没有能力参数（签名见上文 §2 / §4）。
- 容器选择只走「偏好 > 优先级 > 注册顺序」，没有能力维度。
- 能力是实例 / handle 上的元数据，由各领域 `*-api` 的 helper 函数自行过滤，不进内核 DI。

以 plugin-llm-api 为例，「按能力过滤 LLM」不再询问容器，而是先用 `ctx.getAllServices('llm')` 取全集，再按 `instance.capabilities` 过滤：

```ts
function listLLMEntries(ctx, caps) {
  const all = ctx.getAllServices<LLMModel>('llm');
  if (!caps?.length) return all;
  return all.filter(e => caps.every(c => (e.instance.capabilities ?? []).includes(c)));
}
```

`resolveLLMModel` 进一步演示了另一种寻址：把 `{ provider, model }` ref 拼成 `entryId = '${provider}/${model}'`，直接命中那条 per-entry。这正是 §3 中 entryId 约定的下游消费面——领域路由器靠 entryId 字符串寻址具体的子粒度，而不靠内核的能力匹配。

对插件作者而言，结论是：如果你希望自己的 provider 被「按能力选中」，就把能力诚实地写进实例的元数据字段（如 LLM handle 的 `capabilities`），消费方会经对应的 `*-api` helper 过滤。不要指望内核 DI 帮你按能力选，它只认名字、优先级和偏好。

---

## 7. 作用域子容器已移除（0.7.0）

实验性的 `ctx.createScope(id)` / `ScopedServiceContainer` / `ScopedConfigManager`（叠加式的服务 / 配置隔离）已在 0.7.0 移除：全生态没有消费者，而且共享事件 / 钩子 / 文件系统的边界不足以支撑「沙盒」语义。

替代方案有两条。按会话 / 租户做差异化配置，用键控解析，即 session-manager 的 `resolveConfig(sessionId)` 模式。需要真正的隔离，则用独立的 `App` 实例。

---

## 8. 双源 manifest：声明要与运行时一致

服务的「声明」有两个独立来源，二者必须保持一致：

| 来源 | 位置 | 用途 |
| --- | --- | --- |
| **包级 manifest** | `package.json` 的 `aalis.service.{provides,required,optional}` | 市场 / 安装前的静态披露（用户装前就知道这插件提供 / 依赖什么） |
| **运行时 DI 声明** | 模块导出 `export const provides` / `export const inject`（或 module 字段 `provides` / `inject`） | core 实际据此做依赖解析与激活时序 |

以 plugin-llm-openai 为例，两处声明分别是：

- `package.json` → `"aalis": { "service": { "provides": ["llm"] } }`
- 模块导出 → `export const provides = ['llm']`

`inject` 的形状是 `{ required?, optional? }`，元素可以是字符串或 `{ service }`，运行时统一经 `normalizeDependency` 归一为 `{ service }`。

> 这是两条独立链路：manifest 不参与运行时 DI（core 读的是导出或 module 字段），但市场展示与「装前体检」读的是 manifest。任意一边漏写或写错，要么市场披露失真，要么运行时的依赖解析与披露对不上。务必同步维护。

---

## 9. 常见错误与边界情形

1. **缓存裸 service 引用**：`const svc = ctx.getService('llm')` 存进类字段长期使用，provider bounce 后引用失效。改为每次 getService，或用 `whenService` 跟随（§4.1 / §4.3）。
2. **重复 provide 同名服务**：同一 Context 不带 entryId 二次 provide 会静默失效。多套配置用 `reusable` + `name:suffix`；有意拆子粒度用 `entryId`（§2.2 / §3）。
3. **entryId 不带 `ctx.id/` 前缀**：卸载会漏清理僵尸 entry。永远用 `'${ctx.id}/${sub}'`（§3）。
4. **直接调容器层 `prefer` / `register`**：绕过事件发射，`whenService` 不会重挂。走 `ctx.preferService` / `ctx.provide`（§4.4）。
5. **滥用 `requiresBounceOnDepChange`**：默认就应惰性查询。打开它会让 core 在依赖变化时级联重启你的插件，成本高（§5）。
6. **期待内核按能力选服务**：0.5.0 起已无此能力。把能力写进实例元数据，靠 `*-api` helper 过滤（§6）。
7. **manifest 与运行时声明不一致**：两条独立链路都要写、要对齐（§8）。

---

## 相关文档

兄弟概念（`docs/concepts/`）：

- 存储 URI 文法与 `entryId`（per-root）的下游消费面 → `docs/concepts/storage-uri-grammar.md`
- 鉴权数字等级与服务消费的安全边界 → `docs/concepts/authority.md`
- 消息 / LLM 管线（`prepareLLMMessages` 等 egress 约定）→ `docs/concepts/message-llm-pipeline.md`

服务详解（forward-ref，`docs/services/`）：

- `docs/services/llm.md` —— per-model entry、`capabilities` 元数据、`resolveLLMModel` 路由
- `docs/services/storage.md` —— per-root entry、`createStorageGateway` 聚合

核心 API 参考：

- `docs/core/service.md` —— ServiceContainer 方法逐一参考
- `docs/core/context.md` —— Context 完整 API
- `docs/core/plugin.md` —— PluginModule 字段（`provides` / `inject` / `reusable` / `requiresBounceOnDepChange`）
