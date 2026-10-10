# 服务模型（Service Model）

> 受众：编写 / 维护 Aalis 第三方插件的开发者。

服务模型是 Aalis 最基础的概念。几乎所有其它能力（LLM、存储、命令、鉴权……）都以「服务」的形态注入容器，再由消费方按名取用。读懂本文后，后续 `docs/services/*` 里的各篇服务详解才有依托。

一个服务有两张面：共享的提供者（容器里的实例，全 App 一份）与按激活绑定的调用接口（每次插件激活一份，登记自动归属这次激活）。契约包导出**描述符**（`defineService` 的结果），消费方在 `uses` 里声明它；装配时 core 为这次激活造选择层（选哪一家），描述符自带的 `bind` 造业务层（怎么调）。容器按名字寻址，同名多实现并存；没有「能力维度」的选择——领域能力挂在实例 / handle 元数据上，由各 `*-api` helper 过滤。

---

## 1. 核心模型

### 1.1 描述符与名字

服务身份是描述符的 `name`。契约包装了两份也指向同一服务；binder 随消费方 import 的那份契约包走，类型与绑定实现同版本。

`caps.xxx` 分两层。选择层 `ServiceSelection` 由 core 定义、每个服务都一样（`list()` / `use` / `of(id)` / `present` / `follow()`）；业务层由契约定义：普通调用型不给自定义 `bind`，业务层就是按提供者形状 `P` 转发的活句柄；注册型能力给 `bind`，用资源口的 `registrar` / `follow` / `track` 造自动归属的登记方法（如 `caps.tools.use.register`）。

容器内部每个服务名对应一个 entry 列表。`llm`、`storage`、`memory` 可以同时被多个插件 `provide`——OpenAI 与 DeepSeek 并存在同一列表里。

动态查询（`services.all`）的公开投影是 `ServiceView`（不含清理归属）；选择层的 `list()` 给的是 `ProviderEntry`（`id` / `label` / `priority` / `selected` / `basis` / `use`），不含原始实例：

```ts
interface ServiceView<T = unknown> {
  instance: T;
  contextId: string;  // 逻辑身份：路由 / 显示 / 偏好
  priority: number;
  label?: string;
}
```

### 1.2 挑选规则：本插件偏好 > 全局偏好 > 优先级 > 注册顺序

业务句柄 `use` 打到本插件按这条规则选中的那一家。四层严格依此优先级：

1. **本插件偏好**：给这个消费插件单独指定的 provider（`services.prefer(key, contextId, { for: 实例 id })`）。
2. **全局偏好**：`services.prefer(key, contextId)` 指定的 provider，即使它的 `priority` 更低也排在前面。偏好可以在目标 entry 注册之前就设置。
3. **优先级**：没有偏好、或偏好目标当前不存在时，按 `priority` 降序。偏好指向的那家回来后切回。
4. **注册顺序**：`priority` 相同时，先注册者胜出。

`services.get` / `all` / `inspect` 按全局口径排序（不看本插件偏好）。

`priority` 是普通数字：越大越优先。没有预设档位，数值含义由 provider 自行记载；部署可调的场景习惯把它开进自己的 `configSchema`。默认 `0`；要盖过参考实现，取一个更高的值（如 `50`）。

`services.prefer` / `unprefer` 会 emit `service:changed`，业务句柄随之打到新选中的那一家，`follow` 随之重挂。偏好只由用户经管理面写：WebUI 设置「系统」的服务偏好与配置项 `servicePreferences` 设全局偏好，插件详情的服务偏好与配置项 `pluginServicePreferences` 设本插件偏好；普通插件不调 `prefer` / `unprefer`，选择层也没有写偏好的入口。不需要让某个插件改用别家、也不需要它固定用某一家的，就别设本插件偏好：「谁生效」由选中者决定的服务（trigger）与几个插件共用数据的服务（memory、storage、vectorstore、embedding）按插件分开选会出错，见 [运行态与配置文档](../core/config.md#服务偏好)。插件一定要某一家提供时，在插件文档里写明，由用户设本插件偏好。

---

## 2. 提供方

### 2.1 `provide.use(descriptor, implementation, options?)`

发布服务的唯一入口。实现按描述符的提供者类型约束；返回退订，随这次激活撤回：

```ts
import { memory } from '@aalis/api-memory';
import { definePlugin, provide } from '@aalis/core';

export default definePlugin({
  name: 'example-provide',
  provides: [memory],
  uses: { provide },
  apply({ provide }) {
    provide.use(memory, myMemoryService, { label: 'SQLite memory' });
  },
});
```

`options`：

- `priority?: number`
- `label?: string` —— 供管控视图展示
- `entryId?: string` —— 条目的逻辑身份（偏好、展示与 `of(id)` 认它），缺省为本激活 id。一个激活登记同一服务的多条时各给一个，`list()` 与 `of(id)` 才分得清；托管自己不运行代码的包（如 WebUI 服务端替扫描到的前端包登记）时取被托管包的 id。格式由服务契约约定，core 不检查；清理与 `provides` 核对仍归本激活

内置能力（`events` / `logger` / `config` / `lifecycle` / `provide` / `services`）由根激活独占提供、始终在场，绑的是这次激活自身，不可被普通 `provide` 替换。`app` / `plugins` 是 core 提供的宿主服务；`hostConfig`（`@aalis/api-host-config`）由宿主提供；`hooks` / `contributions`（`@aalis/api-hooks` / `@aalis/api-contributions`）由插件提供，默认提供者是 `@aalis/plugin-hooks` / `@aalis/plugin-contributions`。它们都须显式写进 `uses`。

### 2.2 同一激活默认只 provide 一次同名服务

同一个激活对同一个服务名默认只能 `provide` 一次。以同一 id 重复 provide（都不带 `entryId`，或带了相同的 `entryId`）会被 dev 校验 warn：下游按条目 id 路由（`of(id)`、设偏好）只能命中其中一条。

要在同一个插件里跑多套配置（例如多个 API key），在定义上声明 `reusable: true`，再用 `name:suffix` 注册多个插件实例。要在单实例里拆子粒度，用 `entryId`。

---

## 3. Per-entry 与 entryId 约定

有些插件天然需要为「子粒度」各开一条 entry。典型是 **per-model LLM**：一个 OpenAI 插件实例挂载多个模型，每个模型一条 `llm` entry。存储不按根分条：`@aalis/plugin-storage-local` 只登记一个 storage 提供者，根在它内部按 URI 根名路由。

`entryId` 的格式由服务契约约定，core 不检查。第一方契约都约定为本次激活 id 加 `/` 加子粒度，即 `` `${lifecycle.use.id}/${子粒度}` ``；api-llm 按 `provider/model` 解析模型引用依赖这一格式。

```ts
caps.provide.use(llm, handle, {
  label: `${baseLabel} / ${modelId}`,
  entryId: `${caps.lifecycle.use.id}/${modelId}`,
});
```

插件卸载时按清理归属批量清理，per-entry 与主 entry 同 owner，一并清掉；`provides` 同样按归属核对。两者都不依赖 `entryId` 的格式。

---

## 4. 消费方

### 4.1 选择层：`list()` / `use` / `of(id)` / `present` / `follow()`

写进 `uses` 之后，apply 里拿到的是选择层。required 与 optional 拿到的是**同一接口**——两者只差激活闸：required 缺席会让顶层插件 pending；optional 缺席不拦激活，到场后自动接上。

- `use`：默认业务句柄，转发给本插件当前选中的那一家；`present`：此刻能否选到一家。
- `list()`：全部对外可见的提供者（`ProviderEntry`），本插件选中的那一条在前，条目的 `use` 钉在那一条登记上。
- `of(id)`：按 id 固定某一家的业务句柄。
- `follow(attach)`：跟随选中的那一家建立有状态资源。

挑选规则、缺席时的行为与三种句柄各打到哪一家见 [选择层与业务层](../core/context.md#选择层与业务层)，`follow` 的交接见 [follow](../core/context.md#follow)。

### 4.2 动态查询：`services`

管理、展示面用 `services.use.get` / `all` / `names` / `inspect` / `prefer`；`inspect(key, { for })` 给出那个插件的解析顺序与选中依据。按描述符查带类型，按运行期字符串查则由调用方收窄。`get` / `all` 给的是原始实例，存起来不会跟着换人。动态查询**不产生依赖边**，不参与激活闸，关停期可能拿空。需要保证就写进 `uses`。

### 4.3 登记型业务层

`tools` / `commands` / `webuiServer` / `agent` 等描述符在 `bind` 里用 `registrar` 把登记方法挂到业务层上（`caps.tools.use.register`）。经它登记的条目随激活撤回、同键替换、提供者换人整体重挂。绕过它、拿 `services.use.get` 查到的原始实例去登记会丢掉这套账本。

---

## 5. 生命周期：激活闸、bounce、关停

顶层插件：required 缺席会 pending，恢复后重新激活；选中的那一家换人不一律重启消费者。

`bounce(instanceId)`：按现有配置拆掉当前激活 → 转 pending → 重算后重新激活。`updateConfig(instanceId, config)` 先换上新配置再按 `bounce` 重启；插件处于禁用态时只换上新配置、保持禁用，启用时按新配置激活。true 只说明请求已受理，激活是否落定看 `idle()`。停机进行中六个管理动作一律返回 false。

关停以激活为单位，分收尾（drain）与关闭（close）两阶段。插件用别的插件的服务（声明的 required 与 optional，对外的全部提供者）：消费者整个 close 完，提供者才 drain。宿主根激活使用插件服务：根 drain 先于该插件 close。插件使用根激活登记的服务：不加排序边，归属保证插件 close 先于根 close。依赖成环时的处理见 [插件定义与能力](../core/context.md)。依赖交接放 `onDrain`；`onDispose` 阶段依赖可能已不可用。

`App.stop()` 先排干在飞重算，冻结新增绑定并进入停机态，再发 `app:stopping`（知会，不是清理通道），等监听器完成后执行停机计划。从 `beginShutdown()` 起，新发起的 `register` / `unload` / `enable` / `disable` / `bounce` / `updateConfig` 一律立即返回 false，不改变状态或配置；拆卸由停机计划负责，停机是否完成看 `app.stop()`。单独 unload / disable / bounce 提供者时，正在用它的 required 消费者并入同批先收尾再关，收尾时提供者仍在；空档里不切到后备提供者。动态 `services.use.get` 不产生依赖边，关停期间可能取到空；它拿到的原始实例不受关停边保护。

插件 dispose 时，容器按清理归属撤回本激活登记的全部服务。登记型 hub（工具 / 命令）由描述符的 registrar 在提供者侧按激活身份退订。

---

## 6. 能力选择在 `*-api` 层

`provide.use` / `list()` / `services.get` 只认名字，没有能力参数。容器选择只走「本插件偏好 > 全局偏好 > 优先级 > 注册顺序」。

能力是实例 / handle 上的元数据，由各领域 `*-api` helper 自行过滤。以 api-llm 为例：先 `caps.llm.list()` 取全集，再按条目的 `use.capabilities` 过滤；`resolveLLMModel(caps.llm, ref, requiredCaps)` 把 `{ provider, model }` 拼成条目 id `'${provider}/${model}'` 命中那条 per-entry，按模型直接取也可以写 `caps.llm.of('<provider>/<model>')`。

如果你希望自己的 provider 被「按能力选中」，把能力写进实例的元数据字段，消费方经对应 helper 过滤。内核 DI 不做能力选择。

---

## 7. 隔离：键控解析或新 App

按会话 / 租户做差异化配置，用键控解析（session-manager 的 `resolveConfig(sessionId)` 模式）。需要真正隔离的事件总线 / 日志通道 / 服务容器，用独立的 `App` 实例（`createApp(options)`：每个 `App` 自有事件总线与服务容器，日志通道另传独立的 `logHub`）。同租户内多用户偏好不要写进容器的 `prefer`——那是进程级 default，见 [插件作者指南](../plugin-author-guide.md) 第 13 节。

---

## 8. 双源 manifest：声明要与运行时一致

| 来源 | 位置 | 用途 |
| --- | --- | --- |
| **包级 manifest** | `package.json` 的 `aalis.service.{provides,required,optional}` | 市场 / 安装前的静态披露 |
| **运行时定义** | `export default definePlugin({ provides, uses })` | core 实际据此做依赖解析与激活时序 |

`provides` 写描述符数组，对账时取 `.name`。`uses` 里未包 `optional()` 的服务进 `required`，包了的进 `optional`；内置能力与其余服务同样计入。对账守卫见 [清单元数据](./manifest-metadata.md)。

---

## 9. 常见错误与边界情形

1. **缓存原始实例**：`services.use.get(x)` 拿到的原始实例存进类字段，provider 换人后不会跟着换。要长期持有就用选择层的业务句柄 `caps.x.use`，有状态资源用 `follow`。
2. **重复 provide 同名服务**：同一激活不带 `entryId` 二次 provide 会静默失效。多套配置用 `reusable` + `name:suffix`；拆子粒度用 `entryId`。
3. **`entryId` 不按契约的格式写**：core 不检查，但依赖格式的契约 helper 会命不中（如 api-llm 的模型引用）。照所用契约的约定写，第一方契约都是 `` `${lifecycle.use.id}/${sub}` ``。
4. **动态 `services.use.get` 当依赖**：无激活闸、无关停边、关停期可能拿空。
5. **期待内核按能力选服务**：把能力写进实例元数据，靠 `*-api` helper 过滤。
6. **manifest 与 `definePlugin` 不一致**：两条独立链路都要写、要对齐。
7. **缺 `name` / 非法 `instanceId`**：`definePlugin` 与 `register` 两层拒绝（非空字符串、不是危险键；`name` 不含 `:suffix`；`instanceId` 允许 `name:suffix`）。

---

## 相关文档

兄弟概念（`docs/concepts/`）：

- 活句柄、`follow`、原始实例的关停边界 → `docs/concepts/lazy-service-access.md`
- 存储 URI 文法与按根路由 → `docs/concepts/storage-uri-grammar.md`
- 消息 / LLM 管线 → `docs/concepts/message-llm-pipeline.md`

服务详解（`docs/services/`）：

- `docs/services/llm.md` —— per-model entry、`capabilities` 元数据、`resolveLLMModel`
- `docs/services/storage.md` —— 单一提供者内按根路由、业务层与插件私有目录 `own`

核心 API 参考：

- `docs/core/service.md`
- `docs/core/context.md`（插件定义与能力）
- `docs/core/plugin.md`
