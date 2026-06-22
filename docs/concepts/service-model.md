# 服务模型（Service Model）

> 受众：编写 / 维护 Aalis 第三方插件的开发者。
> 这是 Aalis 最基础的概念——几乎所有其它能力（LLM、存储、命令、鉴权……）都以「服务」形态注入容器，再由消费方按名取用。读懂本文，后续 `docs/services/*` 才有落点。

Aalis 的依赖注入（DI / IoC）建立在一个**按名字寻址、支持同名多实现**的服务容器之上。插件通过 `ctx.provide(name, instance)` 把一个实例登记进容器；消费方通过 `ctx.getService(name)` 取回**当前胜者**。容器只认名字——没有「能力维度」的选择（这一点很重要，详见 [能力选择已下沉](#能力选择已下沉至-api-层0510-移除)）。

源码权威：
- 容器实现 `packages/core/src/service.ts`
- Context 上的公开 API `packages/core/src/context.ts`
- 类型与优先级常量 `packages/core/src/types/service.ts`
- provide 的 dev 校验 `packages/core/src/service-helpers.ts`

---

## 1. 核心模型

### 1.1 一个名字，多个提供者

容器内部是 `Map<string, ServiceEntry[]>`——**每个服务名对应一个 entry 列表**，而非单实例（`service.ts:22`）。这意味着 `llm`、`storage`、`memory` 这些名字可以同时被多个插件 provide：OpenAI 与 DeepSeek 同时 `provide('llm', ...)`，sqlite 与 mongodb 同时 `provide('memory', ...)`，全部并存在同一列表里。

一个 `ServiceEntry` 的形状（`types/service.ts:34`）：

```ts
interface ServiceEntry {
  instance: unknown;   // 服务实例（你 provide 进去的对象）
  priority: number;    // 优先级，数字越大越优先
  contextId: string;   // 注册者的 Context id（卸载清理的依据）
  label?: string;      // 可选展示标签，如 "OpenAI / gpt-4o"
}
```

### 1.2 胜者解析规则：偏好 > 优先级 > 注册顺序

`getService(name)` 返回的是当前**唯一胜者**。容器统一经 `resolveEntries()`（`service.ts:63`）排序，三层规则严格依此优先级：

1. **偏好（preference）**：所有者显式 `preferService(name, contextId)` 指定的 provider，永远排第一——**哪怕它的 priority 数值更低**（`service.ts:66-70`）。偏好可以在目标 entry 注册之前就设置，一旦该 contextId 注册即生效（`service.ts:180-183`）。
2. **优先级（priority）**：无偏好（或偏好目标当前不存在）时，按 priority 降序。register 时即做稳定降序排序（`service.ts:51`）。
3. **注册顺序**：同 priority 时，**先注册者胜出**（稳定排序保证）。

`get<T>()` 直接返回排序后列表的第 0 个（`service.ts:76-79`）。

`priority` 的推荐取值是 `ServicePriority` 枚举（`types/service.ts:27-31`）：

```ts
export const ServicePriority = {
  Backend: 0,    // 普通后端实现（plugin-openai / plugin-deepseek 等）
  Override: 50,  // 用户级覆盖：希望默认胜过普通后端
  System: 200,   // 保留给核心系统级覆盖
} as const;
```

> 历史注记：曾经有过 `Router = 100` 槽位（router/facade 层）。`feat/service-granularity` 之后已废弃——LLM / storage / platform 全改为按 model / root / sessionId 直接注册多 entry，跨 entry 的聚合由各自 `*-api` 的 helper 承担，不再有同名 facade entry（`types/service.ts:23-26`）。

裸数字 priority（如 `10`，介于 Backend 与 Override 之间）是**允许**的，dev 模式仅打 debug 日志提醒你自行记载其含义（`service-helpers.ts:56-66`）。

---

## 2. 提供方（Provider）

### 2.1 `ctx.provide(name, instance, options?)`

`context.ts:185`。注册一个服务实例，返回一个 `dispose()` 函数用于**精确卸载这一条** entry：

```ts
const dispose = ctx.provide('memory', myMemoryService, {
  priority: ServicePriority.Backend, // 默认 0
  label: 'SQLite memory',
});
// 之后若想主动下线：dispose();
```

`provide` 自动把卸载登记进 Context 的 disposable 链——插件 unload / bounce 时无需你手动清理（`context.ts:204-224`）。卸载会 emit `service:unregistered`，触发依赖此服务的下游重新解析（见 §5）。

`options`：
- `priority?: number` —— 见 §1.2。
- `label?: string` —— 给管控视图（WebUI / CLI status）展示用。
- `entryId?: string` —— 覆盖默认 `contextId`（默认 = `ctx.id`）。用于「一个插件实例拆出多条逻辑 entry」的场景，见 §3。

### 2.2 一个插件实例只 provide 一次同名服务（默认）

**默认情况下，同一个 Context 对同一个服务名只能 `provide` 一次。** 重复 provide（不带显式 `entryId`）会被 dev 校验拦下并 warn——因为下游若按 `contextId` 路由，只能命中第一条，后续静默失效（`service-helpers.ts:46-54`）。

要在同一插件里跑多套配置（如多个 API key），正确做法是在 module 上声明 `reusable = true`（`types/plugin.ts:32`），然后用 `name:suffix` 形式注册多个**插件实例**，各自有独立 Context 与 contextId。

---

## 3. Per-entry 粒度与 entryId 约定

有些插件天然要为「子粒度」各开一条 entry，而非每个子粒度起一个插件实例。典型：

- **per-model LLM**：一个 OpenAI 插件实例发现/挂载多个模型，每个模型一条 `llm` entry。
- **per-root storage**：一个存储插件挂载多个 root，每个 root 一条 entry。

此时用 `options.entryId` 覆盖默认 contextId。**约定：`entryId` 必须以 `ctx.id` 为前缀，以 `/` 分隔**——`'${ctx.id}/${子粒度标识}'`（`context.ts:185-189`）。

真实例子（plugin-openai，`packages/plugin-openai/src/index.ts:634`）：

```ts
const dispose = ctx.provide('llm', handle, {
  label: `${baseLabel} / ${modelId}`,
  entryId: `${ctx.id}/${modelId}`,  // 如 "@aalis/plugin-openai:main/gpt-4o"
});
```

为什么前缀约定重要：插件卸载时容器靠 `unregisterByContext(ctx.id)` 批量清理，它移除「`contextId === id` **或** 以 `id + '/'` 为前缀」的所有 entry（`service.ts:123-139`）。entryId 脱离这个前缀，卸载就会**漏清理**僵尸 entry。dev 模式会校验并 warn（`service-helpers.ts:38-44`），但 `dispose()` 函数本身不依赖该约定。

> 实践中各插件还会自管 per-entry 的 dispose 句柄（`registered: Map<modelId, dispose>`），以便单独上/下线某个子粒度而不重挂整个插件——见 `plugin-openai/src/index.ts:618-650` 的 `registerOne` / `unregisterOne`。

---

## 4. 消费方（Consumer）

### 4.1 `ctx.getService(name)` —— 即取即用，别缓存裸引用

`context.ts:238`。返回**当时点的胜者裸实例**（或 `undefined`）。关键陷阱：

> **返回的是当时的裸实例，provider 发生换跳后不会跟随。** 不要把它长期存进类字段——provider bounce / 偏好切换会让旧引用失效。常规做法是在 handler / 方法体作用域内**每次重新 `getService`**（`context.ts:226-242` 注释）。

容器查询是 O(1) map 命中 + 已排序列表取首，每次 getService 都重查，开销可忽略。

类型推断：传字面量服务名（如 `'memory'`）命中 `ServiceTypeMap` 自动推断为 `MemoryService | undefined`；传字符串变量或未登记名退回 `<T = unknown>`，需自行 narrow（`context.ts:238-242`、`types/services.ts:39-54`）。`ServiceTypeMap` 由各 `*-api` 包通过 declaration merging 反向注入，core 内部不登记任何条目（`types/services.ts:39-45`）。

### 4.2 `ctx.getAllServices(name)` —— 枚举所有提供者

`context.ts:264`。返回所有 entry 的 `{ instance, contextId, label }`，顺序遵循「偏好 > 优先级 > 注册顺序」。这是**领域级筛选的入口**（见 §6）——譬如「列出所有 LLM 模型」「找一个支持 vision 的模型」都从这里拿全集再过滤。

### 4.3 `ctx.whenService(name, cb)` —— 晚绑定 / 跟随切换

`context.ts:354`。持续订阅：**胜者上线即调一次 `cb(svc)`，胜者下线 / 换人自动跑上次 cb 返回的 cleanup**。它内部监听 `service:registered` / `service:unregistered` / `service:preference-changed`，但**只看容器当前胜者态**，对事件乱序 / 合并天然免疫（`context.ts:385-407`）。

适用两类场景：
- **把副作用挂到 hub 服务上**：`ctx.whenService('tools', svc => svc.register(myTool, ctx.id))`——hub 被 bounce 或换提供者时自动重挂。
- **跟随 provider 切换**：cb 返回 cleanup，胜者换人时先 cleanup 再用新实例重挂。

语义细则（`context.ts:328-353` 注释）：
- 调用时若服务已就绪，**立即首挂**。
- **胜者不变则不动**：败者 entry 上下线不触发重挂；只有胜者换人（含偏好切换、胜者注销后次优顶上）才 cleanup + 重挂。
- cb 可返回 cleanup；返回的 dispose 与 `ctx.dispose()` 都会调它。dispose 幂等可多次调。

### 4.4 偏好的公开 API

`ctx.preferService(name, contextId)` / `unpreferService` / `getPreferredService`（`context.ts:281-311`）。注意 **走 Context 的公开 API 而非容器层 `prefer`**——前者额外 emit `service:preference-changed` 触发 `whenService` 重挂（`service.ts:177-178` 标注 `@internal`，插件勿直接调容器）。所有者也可在 WebUI 的 Services 页面设置偏好。

---

## 5. 生命周期：bounce、级联与惰性的默认契约

provider 上下线会驱动插件库重算（`RecomputeReason`，`types/plugin.ts:71-75`）：`service-up` 可能让 pending 插件激活；`service-down` 让 required 依赖者停用、optional 依赖者 bounce。

**默认契约：core 不主动级联 bounce 下游。** 绝大多数插件应让 `getService` 在每次调用时惰性查询，从而天然跟随 provider 切换，无需 bounce（`types/plugin.ts:37-49`）。

`requiresBounceOnDepChange?: boolean` 是逃生舱（`types/plugin.ts:49`、`plugin-activation.ts:40`、`plugin-topology.ts:107-122`）：仅当插件**无法响应式处理状态**（如必须在启动期把 provider 引用一次性缓存进第三方 SDK 内部、或 apply 时跑昂贵同步初始化）时设 `true`，让 core 在依赖 provider 变化时主动级联 dispose + reapply。能用 `getService` 惰性查询 / `whenService` 重挂的，就不要打开它。

插件 dispose 时容器还会跑「服务自清理协议」：任何实例若实现 `unregisterByPlugin(contextId)`，会被统一通知清理本上下文相关的注册项（如 ToolService / CommandService）；core 不硬编码任何具体服务名（`context.ts:594-614`）。

---

## 6. 能力选择已下沉至 *-api 层（0.5.0 移除）

**这是相对旧版的关键变化，务必建立正确心智模型。**

0.5.0 之前，内核 DI 有一个「服务能力选择层」（`ServiceCapabilityMap` / `getServiceCapabilities`，`getService` / `provide` 可带能力维度）。**该层已整体删除。** 现在：

- `provide` / `getService` / `getAllServices` **只接受 name**，没有能力参数（见上文 §2/§4 签名）。
- 容器选择只走「偏好 > 优先级 > 注册顺序」，**没有能力维度**（`service.ts:18` 设计注释明文）。
- **能力是实例 / handle 上的元数据**，由各领域 `*-api` 的 helper 函数自行过滤——不进内核 DI。

权威例子（`packages/plugin-llm-api/src/index.ts:190-198`）：「按能力过滤 LLM」不再问容器，而是 `ctx.getAllServices('llm')` 取全集，再按 `instance.capabilities` 过滤：

```ts
function listLLMEntries(ctx, caps) {
  const all = ctx.getAllServices<LLMModel>('llm');
  if (!caps?.length) return all;
  return all.filter(e => caps.every(c => (e.instance.capabilities ?? []).includes(c)));
}
```

`resolveLLMModel`（`plugin-llm-api/src/index.ts:219-229`）进一步演示：`{ provider, model }` ref → 拼 `entryId = '${provider}/${model}'` 直接命中那条 per-entry。这正是 §3 entryId 约定的下游消费面——**领域路由器靠 entryId 字符串寻址具体子粒度，而非靠内核能力匹配**。

**给插件作者的结论**：你的 provider 想被「按能力选中」，就把能力诚实地写进实例的元数据字段（如 LLM handle 的 `capabilities`），消费方会经对应 `*-api` helper 过滤。不要期待内核 DI 帮你按能力选——它只认名字、优先级、偏好。

---

## 7. 作用域子容器（沙盒 / 会话隔离）

`ctx.createScope(id)`（`context.ts:127`）创建一个 `ScopedServiceContainer`（`service.ts:227`）+ `ScopedConfigManager` 的子上下文：

- **读 fallback**：`get` / `has` / `getEntries` / `getServiceNames` 先查本地，miss 落到父容器（`service.ts:235-258`）。
- **写隔离**：子作用域内 `provide` 只影响本地，不污染全局。

典型用途：沙盒内 `provide('agent', sandboxAgent)` 仅此作用域可见，而 `getService('authority')` 仍 fallback 到全局服务（`context.ts:113-125`）。`getEntries` 在 scope 下是「本地条目在前、父容器在后」拼接（`service.ts:249-254`）——本地覆盖优先。

---

## 8. 双源 manifest：声明要与运行时一致

服务的「声明」有**两个独立来源，必须保持一致**：

| 来源 | 位置 | 用途 |
| --- | --- | --- |
| **包级 manifest** | `package.json` 的 `aalis.service.{provides,required,optional}` | 市场 / 安装前的**静态披露**（用户装前就知道这插件提供/依赖什么） |
| **运行时 DI 声明** | 模块导出 `export const provides` / `export const inject`（或 module 字段 `provides` / `inject`） | core 实际据此做依赖解析与激活时序 |

真实例子，plugin-openai：
- `package.json` → `"aalis": { "service": { "provides": ["llm"] } }`
- `src/index.ts:32` → `export const provides = ['llm']`

`inject` 的形状是 `{ required?, optional? }`，元素可为字符串或 `{ service }`（`types/core.ts:18-23`），运行时统一经 `normalizeDependency` 归一为 `{ service }`（`types/service.ts:49-51`）。

> 两者是**两条独立链路**：manifest 不参与运行时 DI（core 读的是导出 / module 字段），但市场展示与「装前体检」读 manifest。漏写或写错任一边，要么市场披露失真，要么运行时依赖解析与披露对不上。务必同步维护。

---

## 9. 审计踩坑清单（容易翻车的边角）

1. **缓存裸 service 引用**：`const svc = ctx.getService('llm')` 存类字段长期用——provider bounce 后引用失效。改为每次 getService，或用 `whenService` 跟随（§4.1/§4.3）。
2. **重复 provide 同名服务**：同一 Context 不带 entryId 二次 provide 会静默失效。多套配置用 `reusable` + `name:suffix`；有意拆子粒度用 `entryId`（§2.2/§3）。
3. **entryId 不带 `ctx.id/` 前缀**：卸载漏清理僵尸 entry。永远用 `'${ctx.id}/${sub}'`（§3）。
4. **直接调容器层 `prefer` / `register`**：绕过事件发射，`whenService` 不会重挂。走 `ctx.preferService` / `ctx.provide`（§4.4）。
5. **滥用 `requiresBounceOnDepChange`**：默认就该惰性查询。打开它会让 core 在依赖变化时级联重启你的插件，成本高（§5）。
6. **期待内核按能力选服务**：0.5.0 已无此能力。把能力写进实例元数据，靠 `*-api` helper 过滤（§6）。
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
