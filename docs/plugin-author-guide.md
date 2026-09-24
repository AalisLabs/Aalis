# 插件作者隐式契约指南

本文档整理 Aalis 插件作者需要遵守、但 API 文档不会显式提醒的几条约定。
写完一个插件、确认它能运行之后，建议通读本指南，核对是否遗漏了其中任何一条。

> **重要前置阅读**：[node-usage-policy](architecture/node-usage-policy.md) —— 业务插件**不能**直接 import `node:fs` / `node:child_process` / `node:os` / `node:http(s)`，必须通过 `@aalis/api-storage` / `@aalis/api-process` 等网关访问。biome 会拦截违例。

> **完整参考文档**（给第三方作者与维护者的全景）：
> - [概念层 concepts/](concepts/README.md) —— 服务模型、惰性访问、双源 manifest、存储文法、安全模型、消息管线（**写插件前先通读这 6 篇**）。
> - [服务契约层 services/](services/README.md) —— 各 `*-api` 契约逐篇讲解：如何编写 provider、如何消费、边界与常见错误。
> - [工具库 utils/](utils/README.md) —— 4 个 `util-*` 纯函数库（bounded-map / json-repair / network-guard / text-normalize）。
> - [脚手架上手 guide/scaffolding.md](guide/scaffolding.md) —— `npm create aalis@latest`（建项目）与 `create-aalis-plugin`（建插件）从零到能跑。
>
> 本指南（下文）专讲那些 **API 文档不会显式提醒、但容易出错**的隐式约定。

---

## 1. 服务实例替换：你需要主动通知下游吗？

| 场景 | 你要不要做什么 |
|---|---|
| 插件 dispose 时不主动 dispose 自己 provided 的服务实例 | **什么都不用做**，激活撤回会从容器注销 |
| 插件 active 期间临时换一个服务实例（同名 provide 二次） | **不要这么做**。同激活同名不带 `entryId` 的二次登记会被 warn，下游按 identity 只命中第一条。要换实现：`bounce` 自己 |
| 插件配置变更触发热重载 | **调用 `updateConfig()`**（`bounce(instanceId, { config })` 的薄壳）。PluginManager 负责拆掉激活并重算。下游**不会**一律级联重启 |

胜者替换不一律重启消费者。下游应通过 `current` 每次查询重新解析，或用 `follow` / 登记型门面处理有状态资源。

在 active 期间二次 `provide` 同一描述符（不带新 `entryId`）换实现，是反模式。正确做法是让 PluginManager 走完整 bounce：

```typescript
await plugins.require().bounce(lifecycle.id);
```

`plugins` 与 `lifecycle` 都须写进 `uses`（`plugins` 是普通宿主服务，`pluginsService` 描述符）。几乎从不需要在 apply 内部替换实例：配置变了 → `updateConfig`；运行时事件让服务能力变了 → 改服务内部状态而非重新 provide。

---

## 2. `uses`：required 与 optional

| 不包 `optional()` | 包一层 `optional()` |
|---|---|
| 没这个服务无法 apply | 有更好，没有也能跑（功能降级） |
| 服务消失时必须停下（顶层插件转 pending） | 服务消失时可以保留主功能 |
| 绑定接口与 optional **相同**（都是 `ServiceRef` 或自定义门面） | 只差激活闸，不差 API |

没有默认注入——`uses` 写了什么，插件就只能碰到什么。内置能力（`events` / `logger` / `config` / `lifecycle` / `provide` / `services` / `hooks` / `contributions`）同样要声明才会出现在 `apply` 参数里；不声明 `lifecycle` / `logger` 不影响框架对这次激活的管理。

`hostConfig`（整份宿主配置）、`app`、`plugins` 是普通宿主服务，须显式 uses。

`uses` 的值是描述符（或 `optional()` 包着的描述符），不是字符串。领域能力（LLM 的 tool-calling、storage 的 local-path）不是 core DI 的一维：用各域 `*-api` helper 按实例 / 句柄元数据过滤（见第 10 节）。

---

## 3. `provides` 的隐式约定

`provides` 是描述符数组。声明之后，激活结束时 core 按本次激活的 instanceId 校验确已提供；缺一个进入 `error`。

`provide(..., { onBehalfOf })` 代登记归属被代者，不计入代理人：把代登记写进自己的 `provides` 会按「未提供」失败。

dev 模式下，实际 `provide` 了但未在 `provides` 声明的服务名会 warn。除非有特殊理由，`provides` 应该和本次激活真正登记的服务名完全一致。

---

## 3.5 提供者换人与 `follow`

胜者替换默认**不**级联重启下游。调用型服务每次读 `current` / `require()` 即重新解析。要把有状态资源（SDK 句柄、订阅、确认通道）挂到会换人的提供者上，用 `follow`：

```typescript
authority.follow(provider => {
  if (!provider.setConfirmHandler) return;
  const off = provider.setConfirmHandler('*', handler);
  return off;
});
```

- `attach` 必须同步返回 `void` 或清理函数。`async` 回调类型上被拒；运行期 thenable 会被接住并 warn，不会当清理器。
- 换人时先跑上次清理，等 Promise 落定（完成或被拒）才挂新实例；等待期间多次切换合并到最新。
- 拒绝被隔离并报告，不证明旧资源已释放。旧清理永不落定会阻塞交接。

往 hub 登记（工具 / 命令 / 页面 / 预处理器）走描述符绑定门面：`tools.register`、`commands.command`、`webui.registerPage`、`agent.registerPreprocessor`。门面用 registrar：同键替换、换人整体重挂、关闭后拒收。它与 `follow` 的串行交接不同，不能声称新旧资源绝无重叠。

长期缓存 `current` 或 `all()[i].instance`：关停边不保护这份引用。提供者有失效逻辑则抛，没有则可能静默成功。

动态 `services.get` 不产生依赖边，关停期可能拿空。

---

## 4. `reusable: true` 的代价

```typescript
export default definePlugin({
  name: '@aalis/plugin-foo',
  reusable: true,
  // ...
});
```

声明后允许同一份定义通过 `name:suffix` 注册多次（典型用例：多个 LLM provider 配多套 API key）。需要保证：

- `apply` 内**不直接注册全局命令**（会重复注册），改为通过 `commands` 服务路由，handler 内根据 `lifecycle.id` 区分实例
- 如果 `provides` 服务，所有实例提供的服务**同名**，下游通过 priority + preference 选胜者（域能力另由 `*-api` helper 按实例/句柄元数据过滤）；服务实例之间互不串扰
- `displayName` 内最好包含配置区分信息（`` displayName: `OpenAI / ${cfg.model}` ``）让 WebUI 能区分

没有多实例需求就不要声明 reusable——重复注册会从直接挡下变成静默允许，掩盖配置 bug。

### 反模式：单实例 apply 内多次 `provide` 同一服务名

不带 `entryId` 二次登记，下游按 identity 只会命中第一个。`provide` 会 warn。

正确做法二选一：

**方案 A：`reusable: true` + 配置后缀**——适合「多套独立配置」：

```yaml
plugins:
  '@aalis/plugin-foo:chat': { ... }
  '@aalis/plugin-foo:vision': { ... }
```

**方案 B：单实例 apply 内传 `options.entryId` 拆子粒度**——适合「单插件实例、但对外提供多个 entry」：

```typescript
apply({ provide, lifecycle, config }) {
  const cfg = config as { models: Array<{ id: string }> };
  for (const model of cfg.models) {
    provide(llm, new LLMBackend(model), {
      entryId: `${lifecycle.id}/${model.id}`,
      label: `OpenAI / ${model.id}`,
    });
  }
}
```

下游走 preference 选默认胜者，或在请求参数中显式传 `provider` / `model` hint，由 `*-api` helper（如 `resolveLLMModel(llm, { provider, model })`）按 handle 元数据定位。

---

## 5. dispose / drain：什么放进去、什么不放

### 应该放入 `onDispose`

```typescript
lifecycle.onDispose(() => {
  clearInterval(timer);
  childProcess.kill();
  websocket.close();
  fileHandle.close();
});
```

外部资源（OS handle、网络连接、子进程、定时器）**必须**手动清理。回调**可以是异步的**：unload / bounce / 停机路径会逐项等待 promise（单项默认 5s 上限，超时放弃并 warn 点名）。

### 应该放入 `onDrain`

收尾段：此刻本激活的监听、登记与声明的依赖都还在，用于停接新活、把在手的数据交给下层并等它确认。**依赖交接放这里**；`onDispose` 阶段依赖可能已不可用。

关停以激活为单位，分 drain 与 close。普通依赖（required，以及 optional 当时的胜者）：消费者整个 close 完，提供者才 drain，所以整机停机时这里调下层是安全的。宿主根激活使用插件服务：根 drain 先于该插件 close，交接仍放根的 `onDrain`。插件使用根激活登记的服务（基础服务、宿主服务）：不加排序边，归属保证插件 close 先于根 close。环：optional 让步；required 环告警并强行放行。

### 不要放入

通过 `events.on` / `hooks.middleware` / `provide` / 绑定门面 `register` 登记的东西都会随激活撤回。手动再退订可能 double-free。

### 边界：在清理回调里访问其它服务

依赖交接放 `lifecycle.onDrain`（依赖仍可用）。`onDispose` 只释放自己的资源，**不能**假定 `x.current` 还在：拿不到就跳过，不要把只能在 dispose 时落盘的数据攒到最后（每次写点后就保存）。单独 unload / disable / bounce 提供者时，正在用它的 required 消费者先收尾再关，收尾时提供者仍在；随后消费者转 pending（bounce 后重新激活）。动态 `services.get` 不产生依赖边，关停期间可能取到空。

`App.stop()` 先冻结新增绑定并进入停机态，再发 `app:stopping`（知会，不是清理通道），等监听器完成后执行停机计划。停机期间 `unload` / `disable` 汇入计划后立即返回 true（不等拆卸完成）；`register` / `bounce` 返回 false。

---

## 6. 配置 schema：能力比形式重要

`configSchema` 写在 `definePlugin` 上，是给 WebUI 自动生成表单的元数据。**关键约定**：

- `secret: true` 字段会在 WebUI 中被遮罩 + 写回时跳过空值（防止误清空）
- `required: true` 仅作前端校验，**core 不强制**——你 apply 内还是要自己判空
- `default` 就是运行时默认值——configSchema 是配置的唯一声明来源，宿主用 `defaultsFrom(configSchema)` 派生默认配置
- 嵌套对象用 `SchemaGroup`，数组用 `SchemaArray`，不要用裸 JSON 字符串字段

### 配置变更如何触发 reload

用户在 WebUI 点保存 → `updateConfig(instanceId, newConfig)`：

1. 配置先拷贝再挂进 entry 与 ConfigManager
2. 如果当前 active：`disposeAsync` 你的激活（`onDrain` 然后 `onDispose`，异步清理会被等待）→ pending → `recompute('changed')` 按拓扑重激活
3. 如果之前 error：直接 pending → recompute 重试

**你 apply 内不需要做任何特殊处理**。无状态服务的下游在下一次 `current` 查询时会自然拿到新实例。

---

## 7. 测试插件的最小写法

```typescript
import { createApp } from '@aalis/core';
import myPlugin from './src/index.js';

it('required 依赖到场后激活', async () => {
  const app = createApp({ config: { name: 'test', logLevel: 'error', plugins: {} } });
  await app.plugin(fakeDepProvider);
  await app.plugin(myPlugin, { /* config */ });
  await app.plugins.idle();
  expect(app.plugins.getPlugin('my-plugin')?.state).toBe('active');
  await app.stop();
});
```

`createApp` 是同步的。`plugin()` 的 true 只说明请求已受理；需要「激活已落定」必须 `await app.plugins.idle()`。不得在插件 `apply` / `onDispose` 内调用 `idle()`（互等死锁）。不要用 `setTimeout` 代替 `idle()`。

---

## 8. 何时多实例插件、何时新 App

| 隔离需求 | 用法 |
|---|---|
| 一个独立插件实例（默认）| `app.plugin(definition, cfg)` |
| 按会话/租户差异化配置或服务 | **键控解析**：按 key 查表（参考 session-manager 的 `resolveConfig(sessionId)`），不需要上下文隔离 |
| 同一份定义跑多套独立配置 | 定义声明 `reusable: true`，再以 `app.plugin(definition, cfg, 'name:suffix')` 注册（插件内经 `plugins.register` 同签名）；每个实例是独立的顶层激活，由调度器管理。约束见第 4 节 |
| 完全独立的事件总线 / 日志通道 / 服务容器 | `createApp({ events, services, hooks, ... })` 新建 App |

宿主取根激活绑定用 `app.bind(uses)`，与插件同一套描述符；登记归属根激活、随 App 停止撤回。插件拿的是自己激活的绑定，不复用这里的。

---

## 9. 速查：apply 里做什么 / 别做什么

### 应该在 apply 里做

- `provide(desc, impl)` 登记服务
- `events.on` / `events.emit`
- `hooks.middleware` / `hooks.run`
- `x.follow(attach)` 跟随会换人的提供者
- `tools.register` / `commands.command` / `webui.registerPage` / `agent.registerPreprocessor`（经 `uses` 拿到的绑定门面）
- `lifecycle.onDispose` / `onDrain` 清理外部资源与交接
- 启动后台 worker / 连接外部服务

### 不应该在 apply 里做

- `await` 永久阻塞（apply 必须返回，否则 PluginManager 卡住）
- 直接修改全局 process 状态（`process.env`、信号 handler）
- 跨插件 import 实现细节（应只 import `@aalis/api-xxx`）
- 绕过绑定门面直接打容器底层 API
- 在 apply 内 throw —— 用 `logger.error` + 优雅降级；throw 会让 entry 进 `error` 态直到下次配置变更。**例外**：声明了 `provides` 却因缺配置无法真正 `provide` 时，静默 return 会变成更难懂的 provides 校验错，应抛清晰错误（见 `plugin-asr-openai`）

---

## 10. 领域能力——写在实例 / 句柄上，不进 core

core 的 declaration-merging 扩展点是 `AalisEvents`、`HookContextMap`、`ContributionPointMap`（后两者保持空接口，由 `-api` 填；`AalisEvents` 自持基础设施事件）。服务类型随描述符走，没有「服务名 → 实例」的核心类型表可 augment。

领域能力（LLM 的 tool-calling / vision、storage 的 read/write/local-path）落在**服务实例 / model-handle 的元数据**上，由各 `-api` 包导出能力枚举 + 过滤 helper：

```typescript
export interface StorageCapabilityRegistry {
  List: 'list';
  Read: 'read';
  Write: 'write';
  Delete: 'delete';
  LocalPath: 'local-path';
  Watch: 'watch';
}
```

运行时由各域 helper 做过滤（如 `resolveStorageEntryForRoot(storage, root, caps)` / `resolveLLMModel(llm, { provider, model })`），不是 core DI。

不要在每个实现包里也声明自己的能力枚举——只 `-api` 包声明，实现包按需引用。

### `AalisEvents` 是封闭的：动态事件名怎么办？

`AalisEvents` / `HookContextMap` **没有** `[key: string]` 兜底：没声明过的事件名会在 `events.on` / `events.emit` 处直接编译报错。固定事件逐条 declare；事件名需要运行时动态生成时，在自己命名空间内合并一条模板字面量签名：

```typescript
declare module '@aalis/core' {
  interface AalisEvents {
    'myplugin:ready': [];
    [k: `myplugin:channel:${string}`]: [msg: ChannelMessage];
  }
}
```

两条纪律：

- **前缀必须是自己插件的命名空间**。模板签名会吸收该前缀下的一切事件名，与他人前缀重叠时会互相吞并类型。
- **不要把模板签名当万能逃逸口**。能枚举的事件就逐条声明。

---

## 11. 消费跨插件服务的顺序

| 顺序 | 写法 | 何时用 |
|---|---|---|
| ① | `uses: { tools }` 等描述符 + 绑定门面 | 契约包导出了登记门面（tools / commands / webui / agent） |
| ② | `x.follow(attach)` | 跨插件消费 + 需要在 provider 换人时自动重接有状态资源 |
| ③ | `uses: { x }`（required）+ `x.require()` / `x.current` | 已声明依赖；激活时 provider 应在，但收敛间隙仍可能短暂为空 |
| ④ | `optional(x)` + `x.current?.…` | 探测性可选依赖 |

反模式：没写进 `uses`，又去 `services.get` 当依赖用——无激活闸、无关停边。

`follow` 比自己监听 `service:registered` 轻量：已就绪立刻同步触发、反复上下线重接、关闭自动清理。

---

## 12. 描述符与类型

消费方 `import { llm } from '@aalis/api-llm'`（值导入）即可：`uses: { llm }` 之后 `apply` 参数类型从描述符推导，无需手写服务名字符串、也无需副作用 import 一张类型表。

没把描述符写进 `uses` 时，动态 `services.get('llm')` 没有类型可依凭，由调用方自行收窄。

实现包的 `provides` 也用同一份描述符——保持「接口契约 → `-api` 包 / 实现 → 实现包」的单向依赖。

---

## 13. 用户偏好放哪里？—— per-user 不进容器

容器的 `services.prefer(key, contextId)` 用来锁定某个服务的胜者。**这个机制只用于管理员级 / App 级 default**，不要拿来存 per-user 偏好。

- 容器是进程级单例。A 用户锁定 OpenAI、B 用户锁定 DeepSeek 会互相覆盖
- preferences 没有 user 维度
- per-user 偏好语义是**请求维度的 hint**，不是容器维度的 default

把用户偏好的 LLM/embedding 存在用户 profile 里，每次请求显式传入。优先级链：**req 显式 ref > user 偏好 ref > `services.prefer` > 注册顺序**——最后两级由 `resolveLLMModel(llm, undefined)` 回落到 `all()[0]`。

多租户：

- **不同公司**：每租户一个独立进程 + 独立 `AALIS_DATA_DIR`
- **沙盒/测试**：`createApp({ events, services, hooks })` 完全隔离
- **同租户内多用户**：profile + 请求级 hint

不要为了多租户改服务容器。让 IoC 保持「一进程 = 一产品实例」。

---

## 从 0.16 迁移

下列对照只列写法，不含演进叙述。完整破坏性清单见 CHANGELOG 未发布节。

| 0.16 | 0.17 |
| --- | --- |
| 具名 `name` / 依赖表 / 提供表（字符串）+ 函数 `apply`；配置为第二参 | `export default definePlugin({ name, uses, provides, apply(caps) })`；配置经 `uses: { config }` |
| 第一参 Context：`on`/`emit`、`logger`、`onDispose`、`provide(name, impl)`、按名取服务、跟随订阅、`middleware`/`runHook`、`contribute`/`collect` | `uses` 里写描述符后解构：`events`、`logger`、`lifecycle`（`onDispose` / `onDrain`）、`provide(desc, impl)`、`x.current` / `require()` / `all()` / `follow`、`hooks`、`contributions` |
| 整份宿主配置默认可取 | `hostConfig` 须显式 uses（普通宿主服务） |
| `useModule` 子上下文 | 删除。改用顶层插件：定义声明 `reusable`，以 `name:suffix` 注册多实例 |
| 契约包 `useXxxService` helper | 描述符值导入进 `uses` 与 `dependencies`；apply 里用绑定门面（`tools.register`、`commands.command`、`webui.registerPage` / `registerAction`、`agent.registerPreprocessor`） |
| 网关 helper 第一参为 Context | `createStorageGateway` / `createProcessGateway` / `resolveLLMModel` 第一参为 `ServiceRef` |
| 依赖变更时整插件级联重启开关 | 删除。调用型每次读 `current`；有状态资源用 `follow`；登记型由 registrar 随换人重挂 |
| 服务名→实例的 declaration merging 表 | 删除。类型随描述符走 |
| 加载器接受具名导出与函数 default | 只认 `export default definePlugin({…})`；其它形状 warn 并跳过 |
| `App` 上的公开 Context | `app.plugin` / `app.bind` / `app.config` / `app.plugins` / 四注册表 |
| 公开条目 `module` / `requiredDeps` | `definition` / `required` / `optional`（服务名数组）；不含内部激活记录 |
| `onBehalfOf` 是否计入代理人提供表 | 归属被代者，不计入代理人 `provides` |

---

## 发布到插件市场

Aalis 市场走**纯 npm 路线**，无自建服务器、无静态索引——发现靠 npm registry 的 keyword 检索，分发靠 npm 包本身。要让你的插件出现在市场里：

1. **打 keyword**：`package.json` 的 `keywords` 必须含 `"aalis-plugin"`（脚手架已自动产出）。
   市场按 `npm registry search keywords:aalis-plugin` 发现插件。**官方插件用 `@aalis/` scope**
   （市场标「官方」）；社区插件任意包名（标「社区」）。
2. **依赖正确归类**（决定发布后能否被正确安装——脚手架已产出正确形态）：
   - `@aalis/core` → **`peerDependencies: ">=0.17.0 <1.0.0"`**（用了哪版 API 就把下限写到哪版）
     + `devDependencies: "latest"`（外部项目）或 workspace 协议（本仓开发期编译）。**不要用 caret**（`^0.17.0` 只匹配 `0.17.x`）。
     进程里只能装一份 core，插件解析到另一份即被拒绝加载，见 [装了两份 @aalis/core](guide/third-party-plugin.md#two-cores)。
     > **注意**：这条宽松 peer 只针对 `@aalis/core` 本身。你依赖的 `@aalis/api-*`
     > 契约包**不在稳定性承诺内**——0.x 期间仍可能改签名。消费它们的插件要关注 CHANGELOG。
   - 仅 `import type` 的 api 包 → **`devDependencies`**（编译期擦除）。
     **注意**：描述符是值导入，所在契约包进 `dependencies`。若你写的是 `-api` 契约包且其导出类型引用别的包，那些要留 `dependencies`。
   - 运行时用到值（描述符、helper、常量）的 api/util 包 → `dependencies: workspace:>=<被依赖包当前版本> <1.0.0`（本仓）或 `>=x.y.z <1.0.0`（外部）。
     **不要用 `workspace:^` 或 `workspace:*`**：`^` 发布成 `^0.x.y`，caret 在 0.x 下只匹配 `0.x.*`，**跨 minor 就断**；若同时依赖两个包而它们各锁不同 minor，npm 会装进**两份**同一 api 包，两份 `declare module '@aalis/core'` 撞成 `TS2717`，而 `skipLibCheck: true` 会把这个错误彻底吞掉。`*` 发布成精确版本，同样锁死。写成 `>=x.y.z <1.0.0` 范围时 pnpm **原样保留**，跨 minor 自动拉新版。
   - 市场展示字段直接读 `package.json`：`description`/`author`/`license`/`repository`/`version`。
3. **声明 `aalis.service` 供装前披露**：市场在 npm 上**安装前**只能读 `package.json`
   （拿不到 `definePlugin`），所以在 `package.json` 加：
   ```json
   "aalis": { "service": { "required": ["llm"], "optional": ["memory"], "provides": ["my-service"] } }
   ```
   与 `definePlugin` 的 `uses` / `provides` 一致（描述符 `.name`；内置能力不写）。装后市场仍会按实际定义聚合细化。
4. **breaking change 记 changelog**：**1.0 之前 core 的公开面可能在次版本被删**。宽 peerDep 区间是为了让不用新 API 的插件不必随次版本频繁重发，不是兼容性承诺。
   稳定性承诺自 **1.0** 起生效，条款见 `docs/design/core-contract.md`。
5. **发布**：`pnpm publish:all`（仓库根，递归拓扑序发 core→api→util→插件、跳 private、
   转 workspace 协议）。单插件 `npm publish`。私有/未发布插件仍可走 monorepo 本地安装。

> 安全模型：市场是**透明披露 + 用户知情同意**，不是技术隔离。安装第三方插件
> 等于授予它声明的能力；真正的执行隔离（如 code_runner 沙箱）由容器化层负责。

## 相关文档

- [docs/architecture.md](architecture.md) — 整体架构
- [docs/core/context.md](core/context.md) — 插件定义与能力
- [docs/core/plugin.md](core/plugin.md) — PluginManager
- [docs/design/service-persistence.md](design/service-persistence.md) — 各服务 bounce 时的状态保持情况
