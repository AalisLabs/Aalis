# 插件作者隐式契约指南

本文档整理 Aalis 插件作者需要遵守、但 API 文档不会显式提醒的几条约定。
写完一个插件、确认它能运行之后，建议通读本指南，核对是否遗漏了其中任何一条。

> **重要前置阅读**：[node-usage-policy](architecture/node-usage-policy.md) —— 业务插件**不能**直接 import `node:fs` / `node:child_process` / `node:os` / `node:http(s)`，必须通过 `@aalis/api-storage` / `@aalis/api-process` 等服务访问（`caps.storage.use` / `caps.process.use`）。biome 会拦截违例。

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
| 插件 active 期间临时换一个服务实例（同名 provide 二次） | **不要这么做**。同激活同名不带 `entryId` 的二次登记在 dev 模式下会被 warn，下游按条目 id（`of(id)`、偏好）只命中其中一条。要换实现：`bounce` 自己 |
| 插件配置变更触发热重载 | **调用 `updateConfig()`**（换上新配置再按 `bounce` 重启；`bounce` 只按现有配置重启）。PluginManager 负责拆掉激活并重算。下游**不会**一律级联重启 |

选中的那一家换人不一律重启消费者。下游的业务句柄 `use` 每次访问都重新解析；有状态资源用 `follow`，登记用登记型业务层。

在 active 期间二次 `provide` 同一描述符（不带新 `entryId`）换实现，是反模式。正确做法是让 PluginManager 走完整 bounce：

```typescript
await plugins.use.bounce(lifecycle.use.id);
```

`plugins` 与 `lifecycle` 都须写进 `uses`（`plugins` 是普通宿主服务，`pluginsService` 描述符）。几乎从不需要在 apply 内部替换实例：配置变了 → `updateConfig`；运行时事件让服务能力变了 → 改服务内部状态而非重新 provide。

---

## 2. `uses`：required 与 optional

| 不包 `optional()` | 包一层 `optional()` |
|---|---|
| 没这个服务无法 apply | 有更好，没有也能跑（功能降级） |
| 服务消失时必须停下（顶层插件转 pending） | 服务消失时可以保留主功能 |
| 选择层与业务层与 optional **相同**（业务层是提供者形状的活句柄或契约自定义的绑定） | 只差激活闸，不差 API；用前先看 `present` |

没有默认注入：`apply` 只收到 `uses` 里声明的各项，内置能力（`events` / `logger` / `config` / `lifecycle` / `provide` / `services`）也一样；不声明 `lifecycle` / `logger` 不影响框架对这次激活的管理。`uses` 说明插件依赖什么，不是授权边界：插件是同进程的可信代码（见 [安全模型](concepts/security-model.md)）。

以下是普通服务，同样须显式 uses：

- `app`、`plugins`：core 在根激活上提供的宿主管理面。
- `hostConfig`（配置文档，`@aalis/api-host-config`）：由宿主提供。Node 宿主 `@aalis/runtime` 会提供，别的宿主不一定；缺席时要降级的插件写 `optional(hostConfig)`。
- `hostPaths`（家目录与安装集的绝对路径，`@aalis/api-host-paths`）：由宿主提供，Node 宿主同样会提供。插件要定位这些目录时声明它，不读 `process.cwd()`。
- `hostLogs`（读日志流，`@aalis/api-host-logs`）：由宿主提供，Node 宿主同样会提供。写日志用 `logger`；要读整个日志流（日志页一类）时声明它，不直接订阅 core 的日志中枢 `LogHub`（有 architecture 守卫）。
- `hooks` / `contributions`（`@aalis/api-hooks` / `@aalis/api-contributions`）：由插件提供，默认提供者是 `@aalis/plugin-hooks` / `@aalis/plugin-contributions`。部署里缺了它们，依赖它们的插件停在 pending。

`uses` 的值是描述符（或 `optional()` 包着的描述符），不是字符串。领域能力（LLM 的 tool-calling / vision）不是 core DI 的一维：用各域 `*-api` helper 按实例 / 句柄元数据过滤（见第 10 节）。

---

## 3. `provides` 的隐式约定

`provides` 是描述符数组。声明之后，激活结束时 core 按本次激活实际登记的条目校验确已提供；缺一个进入 `error`。

以任何逻辑身份登记的条目（含以 `entryId` 替别的包登记的）都计入本次激活。

dev 模式下，实际 `provide` 了但未在 `provides` 声明的服务名会 warn。除非有特殊理由，`provides` 应该和本次激活真正登记的服务名完全一致。

---

## 3.5 提供者换人与 `follow`

选中的那一家换人默认**不**级联重启下游。业务句柄 `caps.x.use` 每次访问成员即重新解析，存起来也会跟着换人。要把有状态资源（SDK 句柄、订阅、登记在提供者实例上的规则）挂到会换人的提供者上，用 `follow`：

```typescript
sessionHistory.follow(history => {
  const off = history.registerAccessChecker(checker);
  return off;
});
```

- `attach` 必须同步返回 `void` 或清理函数。`async` 回调类型上被拒；运行期 thenable 会被接住并 warn，不会当清理器。
- 交给 `attach` 的是选中那一家的业务句柄，钉在挂上的那一条登记上，直到这次挂载的清理落定。
- 换人时先跑上次清理，等 Promise 落定（完成或被拒）才挂新选中的那一家；等待期间多次切换合并到最新。
- 拒绝被隔离并报告，不证明旧资源已释放。旧清理永不落定会阻塞交接。

往 hub 登记（工具 / 命令 / 页面 / 预处理器）走业务层的登记方法：`tools.use.register`、`commands.use.command`、`webui.use.definePage`、`agent.use.registerPreprocessor`。它们用 registrar：同键替换、换人整体重挂、关闭后拒收。它与 `follow` 的串行交接不同，不能声称新旧资源绝无重叠。

关停保护覆盖声明的服务的全部提供者：整机停机时，你经 `of(id)` 或 `list()` 条目用到的、不是此刻选中的那一家，同样等你关完才收尾。单独卸载、停用或重启某个提供者时，并入同一批先关的只有此刻选中它的 required 下游；你以 optional 声明它，或经 `of(id)`、`list()` 条目用到它，它照样先走：之后经 `of(id)` 与 `list()` 条目的访问抛 `ServiceUnavailableError`，`use` 换到下一家、选不到时同样抛错，调用处要能处理。

长期缓存 `services.use.get` / `services.use.all(desc)[i].instance` 拿到的原始实例：关停边不保护这份引用。提供者有失效逻辑则抛，没有则可能静默成功。

动态 `services.use.get` 不产生依赖边，关停期可能拿空。

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

- `apply` 内**不直接注册全局命令**（会重复注册），改为通过 `commands` 服务路由，handler 内根据 `lifecycle.use.id` 区分实例
- 如果 `provides` 服务，所有实例提供的服务**同名**，下游各按 priority + preference 选中其中一家（域能力另由 `*-api` helper 按实例/句柄元数据过滤）；服务实例之间互不串扰
- `displayName` 内最好包含配置区分信息（`` displayName: `OpenAI / ${cfg.model}` ``）让 WebUI 能区分

没有多实例需求就不要声明 reusable——重复注册会从直接挡下变成静默允许，掩盖配置 bug。

### 反模式：单实例 apply 内多次 `provide` 同一服务名

不带 `entryId` 二次登记，下游按条目 id 只会命中其中一个。dev 模式下 `provide` 会 warn。

正确做法二选一：

**方案 A：`reusable: true` + 配置后缀**——适合「多套独立配置」：

```yaml
plugins:
  '@aalis/plugin-foo:chat': { ... }
  '@aalis/plugin-foo:vision': { ... }
```

**方案 B：单实例 apply 内传 `options.entryId` 拆子粒度**——适合「单插件实例、但对外提供多个 entry」：

```typescript
apply({ provide, lifecycle, config, logger }) {
  const cfg = parseConfig(configSchema, config.use, logger.use);
  for (const model of cfg.models) {
    provide.use(llm, new LLMBackend(model), {
      entryId: `${lifecycle.use.id}/${model.id}`,
      label: `OpenAI / ${model.id}`,
    });
  }
}
```

下游的 `use` 按 preference 打到默认那一家，或在请求参数中显式传 `provider` / `model` hint，由 `*-api` helper（如 `resolveLLMModel(caps.llm, { provider, model })`）按条目 id 与 handle 元数据定位；按模型直接取写 `caps.llm.of('<provider>/<model>')`。

---

## 5. dispose / drain：什么放进去、什么不放

### 应该放入 `onDispose`

```typescript
lifecycle.use.onDispose(() => {
  clearInterval(timer);
  childProcess.kill();
  websocket.close();
  fileHandle.close();
});
```

外部资源（OS handle、网络连接、子进程、定时器）**必须**手动清理。回调**可以是异步的**：unload / bounce / 停机路径会逐项等待 promise（单项默认 5s 上限，超时放弃并 warn 点名）。

### 应该放入 `onDrain`

收尾段：此刻本激活的监听、登记与声明的依赖都还在，用于停接新活、把在手的数据交给下层并等它确认。**依赖交接放这里**；`onDispose` 阶段依赖可能已不可用。

关停以激活为单位，分 drain 与 close。插件用别的插件的服务（声明的 required 与 optional，对外的全部提供者）：消费者整个 close 完，提供者才 drain，所以整机停机时这里调下层是安全的。宿主根激活使用插件服务：根 drain 先于该插件 close，交接仍放根的 `onDrain`。插件使用根激活登记的服务（基础服务、宿主服务）：不加排序边，归属保证插件 close 先于根 close。依赖成环时的处理见 [插件定义与能力](core/context.md)，交接放 `onDrain` 才不丢。

### 不要放入

通过 `events.use.on` / `hooks.use.middleware` / `provide.use` / 业务层的 `register` 登记的东西都会随激活撤回。手动再退订可能 double-free。

### 事件处理器里的异步工作

撤回只摘掉监听，不等已经在执行的处理器：处理器里发起的异步工作，在你的 `onDrain` / `onDispose` 执行期间可能仍在跑。要在关闭前完成的，自己记下这些 Promise，在 `onDrain` 里等；要停下的，传 `lifecycle.use.signal`。处理器里另起、没有 `return` 或 `await` 的 Promise，`emit` 不等它，它的拒绝也不经监听器的错误隔离，要自己接住。

### 边界：在清理回调里访问其它服务

依赖交接放 `lifecycle.use.onDrain`（依赖仍可用）。`onDispose` 只释放自己的资源，**不能**假定 `x.present` 还为真：选不到就跳过，不要把只能在 dispose 时落盘的数据攒到最后（每次写点后就保存）。单独 unload / disable / bounce 提供者时，正在用它的 required 消费者先收尾再关，收尾时提供者仍在；随后消费者转 pending（bounce 后重新激活）。动态 `services.use.get` 不产生依赖边，关停期间可能取到空。

`App.stop()` 先冻结新增绑定并进入停机态，再发 `app:stopping`（知会，不是清理通道），等监听器完成（单个至多等 `slowThresholdMs`）后执行停机计划。从 `beginShutdown()` 起，新发起的 `register` / `unload` / `enable` / `disable` / `bounce` / `updateConfig` 一律立即返回 false，不改变状态或配置；拆卸由停机计划负责，停机是否完成看 `app.stop()`。

---

## 6. 配置 schema：能力比形式重要

`configSchema` 写在 `definePlugin` 上，同时描述表单、配置类型与解析规则。使用 `@aalis/schema-config` 的 `defineConfig` 保留类型信息，在 apply 开头调用 `parseConfig(configSchema, config.use, logger.use)`，后续只使用解析结果。Core 不解释 schema。

- `secret: true` 表示值是凭据（API key、token、带账号密码的连接串）：宿主把值存进密钥存储（Node 宿主是家目录的 `secrets.yaml`），配置文件里只放引用，WebUI 只显示「已设置」、不回显原值。插件经 `parseConfig` 读到的仍是原值；引用的键不在密钥存储里时 `parseConfig` 拒绝激活，不回落默认值（不走 `parseConfig` 的插件会拿到引用对象，由诊断检查 `config.secrets` 报出）。名字像凭据却不是凭据的字段（如 `maxTokens`）写 `secret: false`。存放与写入规则见 [运行态与配置文档](./core/config.md#密钥配置)
- `required: true` 且没有默认值的字段未填时，`parseConfig` 抛出配置错误；数组元素中此类错误只丢弃该元素并告警。跨字段、条件必填等语义仍由插件核对
- `default` 是唯一默认值来源；宿主用 `defaultsFrom` 回填文档（密钥字段的默认值不写进文档），插件用 `parseConfig` 取得默认值，不依赖宿主是否做过回填
- 普通字段无效时回落默认值并告警；`onInvalid: 'error'` 的字段拒绝无效值，即使有默认值也不回落。地址、启动参数、访问边界等字段应显式声明这一策略；缺省规则不变。例外：插件自己登记拒绝规则或访问检查器时，相关字段不要声明这一策略，默认值取收紧的一侧，坏值回落并告警。插件进 error 会连规则一起撤掉，没有规则时访问反而放开
- 写宿主文件路径的 `string` / `textarea` 字段声明 `format`：`'absolute-path'` 只收绝对路径，`'executable'` 另收按 PATH 查找的命令名（不含路径分隔符，`C:foo` 这类带盘符的相对写法不算）；判定忽略首尾空白，交给插件的值也去掉首尾空白，空串与只有空白都表示未填（`required` 字段算缺失）；只看写法、与宿主平台无关，Windows 形状的绝对路径在 POSIX 宿主上同样通过。配置里的相对路径没有可靠的基准：宿主进程的 cwd 不带语义（家目录与安装集经 `host-paths` 取得，见 [api-host-paths](./api/api-host-paths.md)）
- 用 `ConfigOf<typeof configSchema>` 推导配置类型；解析后的派生列表等另行计算，不重复维护默认值对象或取值断言
- 嵌套对象用 `SchemaGroup`，数组用 `SchemaArray`，不要用裸 JSON 字符串字段

### 配置变更如何触发 reload

用户在 WebUI 点保存 → WebUI 调 host-config 的 `applyPluginConfig(instanceId, newConfig)`，宿主拆出密钥、以解析后的配置调 `updateConfig`，成功后写配置文档并落盘。`updateConfig` 本身只改运行态：

1. 配置先拷贝再挂进 entry
2. 如果当前 active：`disposeAsync` 你的激活（`onDrain` 然后 `onDispose`，异步清理会被等待）→ pending → `recompute()` 按拓扑重激活
3. 如果之前 error：直接 pending → recompute 重试

**你 apply 内不需要做任何特殊处理**。无状态服务的下游经业务句柄的下一次调用会自然打到新实例。

---

## 7. 测试插件的最小写法

```typescript
import { createApp } from '@aalis/core';
import contributionsPlugin from '@aalis/plugin-contributions';
import hooksPlugin from '@aalis/plugin-hooks';
import myPlugin from './src/index.js';

it('required 依赖到场后激活', async () => {
  const app = createApp({ name: 'test', logLevel: 'error' });
  // 钩子与贡献点由插件提供：插件用到它们时，测试里要一并登记两个默认提供者（部署里由宿主随其他插件整批发现登记）
  await app.pluginAll([{ definition: hooksPlugin }, { definition: contributionsPlugin }]);
  await app.plugin(fakeDepProvider);
  await app.plugin(myPlugin, { /* config */ });
  await app.plugins.idle();
  expect(app.plugins.getPlugin('my-plugin')?.state).toBe('active');
  await app.stop();
});
```

`createApp` 是同步的。配置经 `app.plugin(definition, config)` 传入，core 不合并 schema 默认值；插件的 parseConfig 负责解析与默认值。测试里登记的 `@aalis/plugin-hooks` / `@aalis/plugin-contributions` 放进 devDependencies。`plugin()` 的 true 只说明请求已受理；需要「激活已落定」必须 `await app.plugins.idle()`。`idle()` 不等超过 `slowThresholdMs`（默认 60 秒）转入后台的激活，测试里要等这类激活，按 `getStatus()` 的状态轮询，或把 `slowThresholdMs` 设为 0。不得在插件 `apply` / `onDispose` 内调用 `idle()`（互等死锁）。不要用 `setTimeout` 代替 `idle()`。

用假定时器（`vi.useFakeTimers()`）时注意：激活在落定或转入后台之前挂着一个阈值定时器，`vi.getTimerCount()` 会把它算进去，`vi.runAllTimers()` 会让仍未落定的激活到点转入后台。先 `await app.plugins.idle()` 让激活落定再装假定时器。

---

## 8. 何时多实例插件、何时新 App

| 隔离需求 | 用法 |
|---|---|
| 一个独立插件实例（默认）| `app.plugin(definition, cfg)` |
| 按会话/租户差异化配置或服务 | **键控解析**：按 key 查表（参考 session-manager 的 `resolveConfig(sessionId)`），不需要上下文隔离 |
| 同一份定义跑多套独立配置 | 定义声明 `reusable: true`，再以 `app.plugin(definition, cfg, 'name:suffix')` 注册（插件内经 `plugins.register` 同签名）；每个实例是独立的顶层激活，由调度器管理。约束见第 4 节 |
| 完全独立的事件总线 / 日志通道 / 服务容器 | `createApp(options)` 新建 App；日志通道另传独立的 `logHub` |

宿主取根激活绑定用 `app.bind(uses)`，与插件同一套描述符；登记归属根激活、随 App 停止撤回。插件拿的是自己激活的绑定，不复用这里的。

---

## 9. 速查：apply 里做什么 / 别做什么

### 应该在 apply 里做

- `provide.use(desc, impl)` 登记服务
- `events.use.on` / `events.use.emit`
- `hooks.use.middleware` / `hooks.use.run`
- `x.follow(attach)` 跟随会换人的提供者
- `tools.use.register` / `commands.use.command` / `webui.use.definePage` / `agent.use.registerPreprocessor`（经 `uses` 拿到的业务层登记方法）
- `lifecycle.use.onDispose` / `onDrain` 清理外部资源与交接
- 启动后台 worker / 连接外部服务（发起即可，不要在 apply 里等它就绪，见下）

### 不应该在 apply 里做

- 长时间下载、等外部服务就绪或其它可能很久不返回的 `await`。激活超过 `slowThresholdMs`（默认 60 秒）仍未完成会被告警、转入后台，依赖你所提供服务的插件一直等在 pending；停用、重启、停机或 required 依赖下线时 `lifecycle.use.signal` abort 之后只有 `disposeTimeoutMs`（默认 5 秒）的宽限，到期仍没停下的，你的插件在它停下之前不会重新激活（状态带 `lingering`）。做法见下文「长任务与取消」
- 直接修改全局 process 状态（`process.env`、信号 handler）
- 跨插件 import 实现细节（应只 import `@aalis/api-xxx`）
- 绕过业务层的登记方法、拿动态查询的原始实例直接登记
- 整体用不了时写一行日志就 return：插件显示在运行，用户却不知道它什么都没做。缺必填配置、连不上必需的后端、运行环境不满足时在 apply 里抛错，插件进 `error` 态，原因出现在「需要处理」与 `/doctor`；只有部分功能坏了才降级并记日志。写法见下一节「报错与故障说明」

### 长任务与取消

- 长任务放后台：在 apply 里发起、不 `await`，就绪状态由服务自己表达（如 `isReady()`、首次调用时等就绪）；或推迟到首次使用时再做。apply 本身尽快返回。
- 用 `lifecycle.use.signal` 取消：`fetch(url, { signal: lifecycle.use.signal })`、`lifecycle.use.signal.addEventListener('abort', …)`、循环里查 `lifecycle.use.signal.aborted`。定时器、重连等回调里判断「本激活是否已开始关闭」也查它。
- abort 的两个时机：apply 尚未完成时被停机或停用、卸载、重启接手，或后台激活因 required 依赖下线被拆，关闭计划冻结后立即 abort；其余情形在本激活的收尾段开始时 abort（`onDrain` 执行时已断，依赖你的插件先关闭时你的 signal 仍未断）。reason 是 `AbortError`。
- abort 监听器同步执行，不得抛错：Node 宿主把监听器的异常当成未捕获异常，runtime 会因此退出进程。
- 转入后台期间，你经 `provide.use` 登记的服务不对外，经 `events.use.on` 挂的监听与经业务层登记方法（工具、指令、页面等）登记的条目照常生效：`app:ready` / `app:started` 监听器可能在 apply 完成之前被调用。需要自身就绪的逻辑放在 apply 末尾再挂（两者都是 sticky，晚挂照样收到），或在回调里自查就绪。

工具调用的长任务（构建、下载、转换、渲染、远端调用）不要自己做后台进程表与轮询工具，在工具定义上声明 `background`，交给执行器转后台（见 [api-tools](./api/api-tools.md#可转后台)）：

```typescript
tools.use.register({
  definition: { type: 'function', function: { name: 'acme_render', description: '…', parameters } },
  background: { yieldSeconds: 20 }, // 不写用执行器的默认 30 秒
  handler: async (args, ctx) => {
    const job = startRender(args, { signal: ctx.signal });
    job.on('log', line => ctx.output?.(`${line}\n`));
    return JSON.stringify(await job.done);
  },
});
```

- 声明的前提：工具响应 `ctx.signal`（收到中止就停下并尽快返回，不留后台残余），晚些拿到结果仍有意义。顺序要紧或本来就快的工具（文件读写、浏览器交互、发消息与平台动作、搜索）不要声明。
- `ctx.signal` 是执行器给这次调用的：在前台时随回合中止，转到后台之后只随停止、工具撤回登记与执行器停用中止。自己的超时不要再加一层「到时就杀」：等多久由让出时限管。
- 进度写进 `ctx.output`：前台时推给界面，转到后台之后成为任务的最后一行与可取的输出。结果照旧在结束时一次返回。
- 参数表里不要用 `runInBackground`、`waitSeconds` 这两个名字：执行器要补上它们，同名的工具被当作没声明。

---

## 9.5 报错与故障说明

用户看得到的报错写两件事：出了什么事，用户该做什么。「该做什么」具体到配置项、命令或页面，例如 schema-config 的 `missingConfigError('apiKey')` 给出的「缺少配置项 apiKey，在 WebUI 或配置文件中填入后生效」。用户看得到的报错有：激活失败的原因、WebUI 提示、诊断结果、指令回复的失败分支、安装与卸载的回执。抛给模型的工具错误（写给模型看，让它换个做法）与抛给调用方的契约错误（由调用方转述）不在此列。

- 修法写在前面，原因放在最后：原因里常带一段响应体或系统报错，放前面会把修法挤到看不见的地方。包装下层错误时把原错误作 `cause`，宿主显示插件的错误信息时会把它的消息接在后面（「… ← 原因」），不用自己再拼一遍。
- 指向文档时写文档站上那一页的完整地址（`https://aalis.acenyan.com/...`），不写仓库里的路径：经 npm 装的项目里没有 `docs/`。
- 配置问题用 schema-config 的 `missingConfigError` / `configError` 抛：不带堆栈，激活失败的日志只有一行，不像程序崩溃。

整体用不了的故障要落到用户看得见的地方，只写一行日志不算告诉了用户：

| 什么时候发现 | 怎么报 | 用户在哪看到 |
|---|---|---|
| 激活时：缺配置、连不上必需的后端、运行环境不满足 | 在 `apply` 里抛错 | 「需要处理」、插件详情与 `/doctor` 的 `plugins.errored`；依赖它的插件写到它为止的依赖链，链尾就是这句 |
| 激活后：凭据过期、后台任务一直失败、外部服务掉线 | `webui.use.notify` 发提示，`detail` 写修法，问题解决后 `clear` | 「需要处理」与插件详情 |
| 能自己检查的状态：模型能不能用、目录能不能写 | 登记 doctor 检查，`warn` 与 `error` 的 `detail` 写修法 | `/doctor` 与 WebUI 的诊断页；没装 WebUI 的用户靠 `/doctor` |

- 缺了就整体用不了的配置项在 schema 里写 `required: true`，不配 `default`：`parseConfig` 缺了就抛 `missingConfigError`，WebUI 把插件标成「待配置」并列出没填的键。带 `default` 的必填项永远算填了。不要自己判空后写日志、return；只在一定条件下才必填的（比如只在用官方地址时必填 `apiKey`）自己判，同样抛 `missingConfigError`。
- 取值范围交给 schema 的约束键（number 的 `min`、`max`、`integer`，string 的 `pattern`、`format`）：WebUI 保存时就拦下，激活时报出是哪一项、错在哪。
- 只有部分功能坏了才降级：一个自定义存储根建不了、一张角色卡读不懂。日志写明是哪一项、为什么、怎么修。
- 空 `catch` 与 `.catch(() => {})` 只用于尽力而为的收尾（关连接、删临时文件、取消读流）与有明确兜底的解析；吞下的若是用户该知道的故障，改成抛错、提示或诊断。

---

## 10. 领域能力——写在实例 / 句柄上，不进 core

declaration-merging 扩展点：core 的 `AalisEvents`（自持基础设施事件），`@aalis/api-hooks` 的 `HookContextMap` 与 `@aalis/api-contributions` 的 `ContributionPointMap`（空接口，由各 `-api` 填）。服务类型随描述符走，没有「服务名 → 实例」的核心类型表可 augment。

领域能力（LLM 的 tool-calling / vision）落在**服务实例 / model-handle 的元数据**上，由各 `-api` 包导出能力枚举 + 过滤 helper：

```typescript
export interface LLMCapabilityRegistry {
  Chat: 'chat';
  ToolCalling: 'tool_calling';
  Vision: 'vision';
  // …
}
```

运行时由各域 helper 在选择层的 `list()` 上做过滤（如 `resolveLLMModel(caps.llm, { provider, model }, requiredCaps)` 读条目的 `use.capabilities`），不是 core DI。存储根的读写删由根的权限位携带，提供者在每个操作前核对，不按能力挑提供者。

不要在每个实现包里也声明自己的能力枚举——只 `-api` 包声明，实现包按需引用。

### `AalisEvents` 是封闭的：动态事件名怎么办？

`AalisEvents` / `HookContextMap` **没有** `[key: string]` 兜底：没声明过的事件名会在 `events.use.on` / `events.use.emit` 处直接编译报错。固定事件逐条 declare；事件名需要运行时动态生成时，在自己命名空间内合并一条模板字面量签名：

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
| ① | `uses: { tools }` 等描述符 + 业务层的登记方法 | 契约包的业务层带登记方法（tools / commands / webui / agent） |
| ② | `x.follow(attach)` | 跨插件消费 + 需要在 provider 换人时自动重接有状态资源 |
| ③ | `uses: { x }`（required）+ `x.use.…` | 已声明依赖；激活时 provider 应在，但收敛间隙仍可能短暂选不到（访问成员抛 `ServiceUnavailableError`） |
| ④ | `optional(x)` + 先看 `x.present` 再 `x.use.…` | 探测性可选依赖 |

反模式：没写进 `uses`，又去 `services.use.get` 当依赖用——无激活闸、无关停边。`get` / `all` / `inspect` 各自的用途见 [动态查询](core/context.md#动态查询-services)。

`follow` 比自己监听 `service:changed` 轻量：已就绪立刻同步触发、反复上下线重接、关闭自动清理。

---

## 12. 描述符与类型

消费方 `import { llm } from '@aalis/api-llm'`（值导入）即可：`uses: { llm }` 之后 `apply` 参数类型从描述符推导，无需手写服务名字符串、也无需副作用 import 一张类型表。

没把描述符写进 `uses` 时，动态 `services.use.get('llm')` 没有类型可依凭，由调用方自行收窄。

实现包的 `provides` 也用同一份描述符——保持「接口契约 → `-api` 包 / 实现 → 实现包」的单向依赖。自己写契约包时照 [契约约定](design/contract-conventions.md) 写。

---

## 13. 用户偏好放哪里？—— per-user 不进容器

容器的 `services.prefer(key, contextId)` 用来锁定某个服务选中的那一家（全局，或给 `{ for }` 只对某个插件实例）。**这个机制只用于管理员级 / App 级 default**，由用户经管理面设，不要拿来存 per-user 偏好。

- 容器是进程级单例。A 用户锁定 OpenAI、B 用户锁定 DeepSeek 会互相覆盖
- preferences 只有全局与插件实例两级，没有 user 维度
- per-user 偏好语义是**请求维度的 hint**，不是容器维度的 default

把用户偏好的 LLM/embedding 存在用户 profile 里，每次请求显式传入。优先级链：**req 显式 ref > user 偏好 ref > `services.prefer` > 优先级与注册顺序**——最后两级由 `resolveLLMModel(caps.llm, undefined)` 回落到 `list()[0]`（本插件选中的那一家）。

多租户：

- **不同公司**：每租户一个独立进程 + 独立 `AALIS_DATA_DIR`
- **沙盒/测试**：`createApp(options)` 新建独立 App
- **同租户内多用户**：profile + 请求级 hint

不要为了多租户改服务容器。让 IoC 保持「一进程 = 一产品实例」。

---

<a id="ui-placement"></a>
## 14. 界面：声明式页面与插件前端

插件不画宿主的界面，只声明自己有什么，由宿主按契约画出来；没装、没启用就不出现，界面不报错、不留空壳。页面默认声明式：用 `webui.use.definePage` 交出组件、数据源与动作，样式、窄屏变形、确认框与输入表单都由宿主统一画（见 [api-webui 的「声明式页面」](api/api-webui.md#声明式页面)）。声明式表达不了的页面（自绘的画布、拖拽编排这类交互）才用插件前端：插件包里的一份静态网页，在宿主画的隔离框架里运行，与宿主页面不同源，只能经宿主调这一页声明过的数据源与动作（见 [api-webui 的「插件前端」](api/api-webui.md#插件前端)）。

**插件前端可以联网；脚本只认插件自己打包的文件。** 外站的样式、字体、图片、音视频与数据请求都放行；脚本只认包里 `webui/` 下的文件与宿主的公用目录，页面里写的内联脚本、`eval` 与外站脚本都不执行，框架里也不能再嵌别的网页。显示别人给的文字（群成员的昵称与消息、作品、网页标题）一律用只显示纯文字的写法：

```js
// 对：按纯文字显示
cell.textContent = member.nickname;
// 错：别人的文字会被当成标记
cell.innerHTML = member.nickname;
```

写错时注入的标记虽然跑不了脚本，仍能借样式把页面上的链接地址、输入框的值带到外站（属性选择器配外站的背景图），也能让框架跳走。

**能放在哪：**

| 位置 | 插件声明什么 | 出现在哪 |
|---|---|---|
| 插件详情的页面（`placement: 'plugin'`，默认） | 声明式页面或插件前端 | 插件详情里的页面入口，地址 `/p/:instance/:pageKey`；用户可以把它固定到图标栏 |
| 设置的一节（`placement: 'settings'`） | 只收声明式页面 | 设置的分节目录 |
| 会话右侧面板（`placement: 'session'`） | 声明式页面或插件前端，可用 `applies` 只对部分会话适用 | 面板标签栏的「+」，用户打开后记住 |
| 会话设置项 | `sessionManager.use.registerSetting`：一个配置字段，加适用的会话种类与显眼程度；字段没有默认值时用 `unset` 写一句没设时怎样（见 [api-session-manager 的「登记设置项」](api/api-session-manager.md#登记设置项)）。可选项要按服务现取的，字段的 `dynamicOptions` 指向提供它的服务，界面调那个服务各提供者的 `listModels()`，只拿得到取值、拿不到依赖项的值（见 [api-webui 的「可选项与模型」](api/api-webui.md#可选项与模型)） | 会话的「设置」标签、设置的「会话默认」、输入框旁的快捷切换（`prominence: 'composer'`） |
| 提示 | `webui.use.notify`：一条待处理事项或故障，带级别，可附跳转；事情处理好了就撤回 | 「需要处理」（运行状况页、首页摘要、运行状况的角标与标签页标题的数，每条计 1）与发出它的插件详情 |
| 主题 | 经贡献点 `webui:theme` 交一份主题文件（`contributions.use.contribute('webui:theme', { id, theme })`，见 [api-webui 的「插件提供的主题」](api/api-webui.md#插件提供的主题)），只收颜色令牌，与导入的主题走同一套校验 | 设置「外观」的主题选择；插件停用后消失，正在用的回到同深浅的偏中性 |
| 工具卡的展示 | 工具定义上的 `display`（命令、文件改动） | 时间线的工具卡与审批卡上的事实 |

**不能放在哪：** 图标栏（里面的页面全由用户固定）、会话头部、输入框旁（快捷切换只收会话设置项）、时间线与消息、会话列表的行、浮层与弹窗、宿主自己的设置分区；工具卡只认 `display` 的种类，不收插件画的卡片。

**为什么：** 这些地方是 owner 读对话、做决定的地方（审批、停止、发送），内容要由宿主按会话协议与契约里的数据统一画，才能在每个插件组合下都干净、插件画不出仿冒宿主的界面、宿主升级后不会静默失效；照同一套协议实现的第三方前端、终端客户端与编辑器扩展也要能画出同样的东西，而它们画不了插件前端。插件前端只在两个位置里、占它自己的格子，外围的标题栏、标签栏、出处一行、确认框与 Toast 都由宿主画；设置不收插件前端，设置与宿主自己的分区是同一套样子。

---

## 15. 联网搜索后端

联网搜索不是宿主的内置能力。plugin-websearch-serper 登记 `web_search`、`search_images` 两个工具；换搜索后端就是另写一个插件，自己登记这两个工具，与 plugin-websearch-serper 二选一（停用其中一个）。

---

## 16. 模型服务商：记账与余额

写一个 LLM 服务商插件时，登记模型要套一层 `metered`：`provide.use(llm, metered(handle, events.use), { entryId })`。每次调用拿到用量时它发一条 `llm:usage`，记账插件（如 [plugin-usage-stats](plugins/plugin-usage-stats.md)）靠这条事件记账；不套就不记账，用量统计里看不到这个服务商的调用。插件的 `uses` 因此要带上 `events`。服务商有余额接口时可以在模型上实现 `balance`，用量统计页按服务商有没有实现决定出不出现「余额」。写法见 [api-llm 的「记账」](api/api-llm.md#记账)。

调模型的插件在请求里带 `purpose`（给人看的短语，如「摘要」）与 `sessionId`，记账才知道这次调用做什么用、算在哪个会话上；调用方的实例由 `llm` 的业务层填，不用自己写。

---

## 发布到插件市场

Aalis 市场走**纯 npm 路线**，无自建服务器、无静态索引——发现靠 npm registry 的 keyword 检索，分发靠 npm 包本身。要让你的插件出现在市场里：

1. **打 keyword**：`package.json` 的 `keywords` 必须含 `"aalis-plugin"`（脚手架已自动产出）。
   市场按 `npm registry search keywords:aalis-plugin` 发现插件。**官方插件用 `@aalis/` scope**
   （市场标「官方」）；社区插件任意包名（标「社区」）。
2. **依赖正确归类**（决定发布后能否被正确安装——脚手架已产出正确形态）：
   - `@aalis/core` → **`peerDependencies: ">=0.20.0 <1.0.0"`**（用了哪版 API 就把下限写到哪版）
     + `devDependencies: ">=x.y.z <1.0.0"`（本地编译用，x.y.z 是开发时用的版本）。**不要用 caret**（`^0.20.0` 只匹配 `0.20.x`）。
     进程里只能装一份 core，插件解析到另一份即被拒绝加载，见 [装了两份 @aalis/core](guide/third-party-plugin.md#two-cores)。
     > **注意**：这条宽松 peer 只针对 `@aalis/core` 本身。你依赖的 `@aalis/api-*`
     > 契约包**不在稳定性承诺内**——0.x 期间仍可能改签名。消费它们的插件要关注 CHANGELOG。
   - 仅 `import type` 的 api 包 → **`devDependencies`**（编译期擦除）。
     **注意**：描述符是值导入，所在契约包进 `dependencies`。若你写的是 `-api` 契约包且其导出类型引用别的包，那些要留 `dependencies`。
   - 运行时用到值（描述符、helper、常量）的 api/util 包 → `dependencies: ">=x.y.z <1.0.0"`，不写 caret、精确版本或 `latest`，理由见[第三方插件开发者指南的「依赖怎么归类」](guide/third-party-plugin.md#_5-1-类型从哪里-import-依赖怎么归类)。`create-aalis-plugin` 生成的依赖已是这种写法。
   - 市场展示字段直接读 `package.json`：`description`/`author`/`license`/`repository`/`version`。
3. **声明 `aalis.service` 供装前披露**：市场在 npm 上**安装前**只能读 `package.json`
   （拿不到 `definePlugin`），所以在 `package.json` 加：
   ```json
   "aalis": { "service": { "required": ["llm"], "optional": ["memory"], "provides": ["my-service"] } }
   ```
   与 `definePlugin` 的 `uses` / `provides` 一致（描述符 `.name`；内置能力同样写）。装后市场仍会按实际定义聚合细化。
   **`provides` 要写**：市场按服务搜靠它，卡片写「提供：…」；用户缺某个服务时，界面提示的正是「在插件市场按服务搜」。
4. **breaking change 记 changelog**：**1.0 之前 core 的公开面可能在次版本被删**。宽 peerDep 区间是为了让不用新 API 的插件不必随次版本频繁重发，不是兼容性承诺。
   稳定性承诺自 **1.0** 起生效，条款见 `docs/design/core-contract.md`。
5. **发布**：在插件包目录执行 `npm publish`。不发布的插件用 `npm install --install-links <插件目录>` 或 `npm pack` 出的 tarball 装进 Aalis 项目，见 [第三方插件开发者指南](guide/third-party-plugin.md#two-cores) 里拷贝安装的写法。

> 安全模型：市场是**透明披露 + 用户知情同意**，不是技术隔离。安装第三方插件
> 等于授予它声明的能力；真正的执行隔离（如 code_runner 沙箱）由容器化层负责。

## 相关文档

- [docs/architecture.md](architecture.md) — 整体架构
- [docs/core/context.md](core/context.md) — 插件定义与能力
- [docs/core/plugin.md](core/plugin.md) — PluginManager
- [docs/design/contract-conventions.md](design/contract-conventions.md) — 写契约包时遵守的约定
- [docs/design/service-persistence.md](design/service-persistence.md) — 各服务 bounce 时的状态保持情况
