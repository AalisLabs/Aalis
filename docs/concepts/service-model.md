# 服务模型（Service Model）

> 受众：编写 / 维护 Aalis 第三方插件的开发者。

服务模型是 Aalis 最基础的概念。几乎所有其它能力（LLM、存储、命令、鉴权……）都以「服务」的形态注入容器，再由消费方按名取用。读懂本文后，后续 `docs/services/*` 里的各篇服务详解才有依托。

一个服务有两张面：共享的提供者（容器里的实例，全 App 一份）与按激活绑定的调用接口（每次插件激活一份，登记自动归属这次激活）。契约包导出**描述符**（`defineService` 的结果），消费方在 `uses` 里声明它，装配时由描述符自带的 `bind` 为这次激活造接口。容器按名字寻址，同名多实现并存；没有「能力维度」的选择——领域能力挂在实例 / handle 元数据上，由各 `*-api` helper 过滤。

---

## 1. 核心模型

### 1.1 描述符与名字

服务身份是描述符的 `name`。契约包装了两份也指向同一服务；binder 随消费方 import 的那份契约包走，类型与绑定实现同版本。

普通调用型不给自定义 `bind`，绑定接口是 `ServiceRef<P>`（`current` / `require()` / `all()` / `follow()`）。注册型能力给 `bind`，用资源口的 `registrar` / `follow` / `track` 造自动归属的门面（如 `tools.register`）。

容器内部每个服务名对应一个 entry 列表。`llm`、`storage`、`memory` 可以同时被多个插件 `provide`——OpenAI 与 DeepSeek 并存在同一列表里。

公开投影是 `ServiceView`（不含清理归属）：

```ts
interface ServiceView<T = unknown> {
  instance: T;
  contextId: string;  // 逻辑身份：路由 / 显示 / 偏好
  priority: number;
  label?: string;
}
```

### 1.2 胜者解析：偏好 > 优先级 > 注册顺序

`current` / `require()` 返回的是当前唯一的胜者。三层规则严格依此优先级：

1. **偏好**：`services.prefer(key, contextId)` 指定的 provider 永远排第一，即使它的 `priority` 更低。偏好可以在目标 entry 注册之前就设置。
2. **优先级**：没有偏好、或偏好目标当前不存在时，按 `priority` 降序。
3. **注册顺序**：`priority` 相同时，先注册者胜出。

`priority` 是普通数字：越大越优先。没有预设档位，数值含义由 provider 自行记载；部署可调的场景习惯把它开进自己的 `configSchema`。默认 `0`；要盖过参考实现，取一个更高的值（如 `50`）。

`services.prefer` / `unprefer` / `preferred` 会 emit `service:preference-changed`，从而触发 `follow` 重挂。不要直接调容器层的 `prefer`。所有者也可以在 WebUI 的 Services 页面设置偏好。

---

## 2. 提供方

### 2.1 `provide(descriptor, implementation, options?)`

发布服务的唯一入口。实现按描述符的提供者类型约束；返回退订，随这次激活撤回：

```ts
import { memory } from '@aalis/api-memory';
import { definePlugin, provide } from '@aalis/core';

export default definePlugin({
  name: 'example-provide',
  provides: [memory],
  uses: { provide },
  apply({ provide }) {
    provide(memory, myMemoryService, { label: 'SQLite memory' });
  },
});
```

`options`：

- `priority?: number`
- `label?: string` —— 供管控视图展示
- `entryId?: string` —— 一个激活登记多条时的子粒度 id，须以本激活 id 为前缀（`${id}/${子粒度}`）
- `onBehalfOf?: string` —— 代为登记：条目的逻辑身份取被代者 id（偏好、服务页、`provides` 校验的 `hasByContext` 都认这个 id），清理仍归本激活。与 `entryId` 二选一。代登记**不计入**代理人的 `provides`；写进去会按「声明了但未实际注册」让本次激活进入 error。

内置能力（`events` / `logger` / `config` / `lifecycle` / `provide` / `services` / `hooks` / `contributions`）绑的是这次激活自身，不可被普通 `provide` 替换，不参与外部服务激活闸。`hostConfig` / `app` / `plugins` 是普通宿主服务，须显式写进 `uses`。

### 2.2 同一激活默认只 provide 一次同名服务

同一个激活对同一个服务名默认只能 `provide` 一次。重复 provide（不带显式 `entryId`）会被 dev 校验 warn：下游若按 `contextId` 路由，只能命中第一条。

要在同一个插件里跑多套配置（例如多个 API key），在定义上声明 `reusable: true`，再用 `name:suffix` 注册多个插件实例。要在单实例里拆子粒度，用 `entryId`。

---

## 3. Per-entry 与 entryId 约定

有些插件天然需要为「子粒度」各开一条 entry：

- **per-model LLM**：一个 OpenAI 插件实例挂载多个模型，每个模型一条 `llm` entry。
- **per-root storage**：一个存储插件挂载多个 root，每个 root 一条 entry。

`entryId` 必须以本次激活 id 为前缀、以 `/` 分隔，即 `` `${lifecycle.id}/${子粒度}` ``。

```ts
caps.provide(storage, scoped, {
  label: root.label || `本地根 ${root.name}`,
  entryId: `${caps.lifecycle.id}/${root.name}`,
});
```

插件卸载时按清理归属批量清理，per-entry 与主 entry 同 owner，一并清掉——清理不依赖前缀。前缀约定服务的是逻辑身份：`hasByContext` 的前缀查询、api-llm 按 `provider/model` 解析模型引用都靠它。dev 模式对此校验并 warn。

---

## 4. 消费方

### 4.1 `ServiceRef`：`current` / `require()` / `all()` / `follow()`

写进 `uses` 之后，apply 里拿到的是绑定接口。required 与 optional 拿到的是**同一接口**——两者只差激活闸：required 缺席会让顶层插件 pending；optional 缺席不拦激活，到场后自动接上。

- `current`：当前胜者，无提供者为 `undefined`。每次读取重新解析。
- `require()`：无提供者抛错。required 依赖丢失到调度收敛之间也可能短暂为空。
- `all()`：全部提供者，每次调用重新枚举。
- `follow(attach)`：跟随胜者建立有状态资源。详见 [惰性服务访问](./lazy-service-access.md)。

不要把 `current` 或 `all()[i].instance` 长期缓存。写了 `uses` 并不保护任意取出的缓存引用。

### 4.2 动态查询：`services`

管理、展示面用 `services.get` / `all` / `names` / `prefer`。按描述符查带类型，按运行期字符串查则由调用方收窄。动态查询**不产生依赖边**，不参与激活闸，关停期可能拿空。需要保证就写进 `uses`。

### 4.3 登记型门面

`tools` / `commands` / `webuiServer` / `agent` 等描述符在 `bind` 里用 `registrar` 把登记方法挂到 `ServiceRef` 上。经门面 `register` 的条目随激活撤回、同键替换、提供者换人整体重挂。绕过门面直接打到 `current` 上会丢掉这套账本。

---

## 5. 生命周期：激活闸、bounce、关停

顶层插件：required 缺席会 pending，恢复后重新激活；胜者替换不一律重启消费者。

`bounce(instanceId, opts?)`：拆掉当前激活 → 转 pending → 重算后重新激活。`updateConfig` 是 `bounce(instanceId, { config })` 的薄壳。true 只说明请求已受理，激活是否落定看 `idle()`。停机进行中 `bounce` / `register` 返回 false。

关停以激活为单位，分收尾（drain）与关闭（close）两阶段。普通依赖（required，以及 optional 当时的胜者）：消费者整个 close 完，提供者才 drain。宿主根激活使用插件服务：根 drain 先于该插件 close。插件使用根激活登记的服务：不加排序边，归属保证插件 close 先于根 close。环：optional 让步；required 环告警并强行放行。依赖交接放 `onDrain`；`onDispose` 阶段依赖可能已不可用。

`App.stop()` 先排干在飞重算，冻结新增绑定并进入停机态，再发 `app:stopping`（知会，不是清理通道），等监听器完成后执行停机计划。停机期间 `unload` / `disable` 汇入计划后立即返回 true（不等拆卸完成）。单独卸载提供者不享有交接保证。动态 `services.get` 不产生依赖边，关停期间可能取到空。缓存的 `all()[i]` 引用不受关停边保护。

插件 dispose 时，容器按清理归属撤回本激活登记的全部服务。登记型 hub（工具 / 命令）由描述符的 registrar 在提供者侧按激活身份退订。

---

## 6. 能力选择在 `*-api` 层

`provide` / `current` / `all` 只认名字，没有能力参数。容器选择只走「偏好 > 优先级 > 注册顺序」。

能力是实例 / handle 上的元数据，由各领域 `*-api` helper 自行过滤。以 api-llm 为例：先 `llm.all()` 取全集，再按 `instance.capabilities` 过滤；`resolveLLMModel(llm, ref, caps)` 把 `{ provider, model }` 拼成 `entryId = '${provider}/${model}'` 命中那条 per-entry。

如果你希望自己的 provider 被「按能力选中」，把能力写进实例的元数据字段，消费方经对应 helper 过滤。内核 DI 不做能力选择。

---

## 7. 隔离：键控解析或新 App

按会话 / 租户做差异化配置，用键控解析（session-manager 的 `resolveConfig(sessionId)` 模式）。需要真正隔离的事件总线 / 日志通道 / 服务容器，用独立的 `App` 实例（`createApp({ events, services, hooks, … })`）。同租户内多用户偏好不要写进容器的 `prefer`——那是进程级 default，见 [插件作者指南](../plugin-author-guide.md) 第 13 节。

---

## 8. 双源 manifest：声明要与运行时一致

| 来源 | 位置 | 用途 |
| --- | --- | --- |
| **包级 manifest** | `package.json` 的 `aalis.service.{provides,required,optional}` | 市场 / 安装前的静态披露 |
| **运行时定义** | `export default definePlugin({ provides, uses })` | core 实际据此做依赖解析与激活时序 |

`provides` 写描述符数组，对账时取 `.name`。`uses` 里未包 `optional()` 的外部服务进 `required`，包了的进 `optional`；内置能力不进 `aalis.service`。对账守卫见 [清单元数据](./manifest-metadata.md)。

---

## 9. 常见错误与边界情形

1. **缓存裸引用**：`const svc = x.current` 存进类字段，provider 换人后失效。每次读 `current`，或 `follow`。
2. **重复 provide 同名服务**：同一激活不带 `entryId` 二次 provide 会静默失效。多套配置用 `reusable` + `name:suffix`；拆子粒度用 `entryId`。
3. **`entryId` 不带激活 id 前缀**：前缀查询与模型引用命不中。永远用 `` `${lifecycle.id}/${sub}` ``。
4. **把代登记写进自己的 `provides`**：`onBehalfOf` 归属被代者，不计入代理人。
5. **动态 `services.get` 当依赖**：无激活闸、无关停边、关停期可能拿空。
6. **期待内核按能力选服务**：把能力写进实例元数据，靠 `*-api` helper 过滤。
7. **manifest 与 `definePlugin` 不一致**：两条独立链路都要写、要对齐。
8. **缺 `name` / 非法 `instanceId`**：`definePlugin` 与 `register` 两层拒绝（非空字符串；`name` 不含 `:suffix` 与 `#`；`instanceId` 允许 `name:suffix`）。

---

## 相关文档

兄弟概念（`docs/concepts/`）：

- 惰性访问、`follow`、网关、缓存引用的关停边界 → `docs/concepts/lazy-service-access.md`
- 存储 URI 文法与 `entryId`（per-root）的下游消费面 → `docs/concepts/storage-uri-grammar.md`
- 消息 / LLM 管线 → `docs/concepts/message-llm-pipeline.md`

服务详解（`docs/services/`）：

- `docs/services/llm.md` —— per-model entry、`capabilities` 元数据、`resolveLLMModel`
- `docs/services/storage.md` —— per-root entry、`createStorageGateway`

核心 API 参考：

- `docs/core/service.md`
- `docs/core/context.md`（插件定义与能力）
- `docs/core/plugin.md`
