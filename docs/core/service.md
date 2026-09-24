# 服务：描述符、按名解析、偏好

插件通过**服务描述符**声明与发布服务；容器按名保存多个提供者，按「偏好 > 优先级 > 注册顺序」选出胜者。

**源码**: `packages/core/src/composition/descriptors.ts`、`packages/core/src/composition/binding.ts`、`packages/core/src/primitives/services.ts`、`packages/core/src/composition/core-services.ts`

消费与发布的插件侧入口见 [插件定义与能力](context.md)。本页补描述符、容器投影、以及动态查询 / 偏好（`services`）。

## 描述符

一个服务有两张面：容器中的提供者登记，与消费方通过描述符得到的绑定接口。容器保存 `provide` 交进来的实现对象本身；描述符的 `bind` 用资源口为消费方的这次激活造调用接口。

```typescript
import { defineService, type BindingPort, serviceRef, type ServiceRef } from '@aalis/core';

interface Clock {
  now(): number;
}

// 普通调用型：不给 bind，绑定接口是 ServiceRef<Clock>
export const clock = defineService<Clock>('clock');

// 注册型：给 bind，用资源口的 registrar / follow / track 造自动归属的门面
interface Inbox {
  add(handler: (msg: string) => void): () => void;
}
export interface BoundInbox extends ServiceRef<Inbox> {
  register(handler: (msg: string) => void): () => void;
}
export const inbox = defineService<Inbox, BoundInbox>('inbox', port => {
  const entries = port.registrar<{ id: string; handler: (msg: string) => void }>({
    key: item => item.id,
    register: (provider, item) => provider.add(item.handler),
  });
  const extra = {
    register: (handler: (msg: string) => void) => entries.add({ id: 'default', handler }),
  };
  return serviceRef(port, extra);
});
```

- 契约包导出描述符（**值导入**，进 `dependencies`，不是 type-only）。类型与绑定实现随描述符走，不需要一张全局服务名 → 类型表。
- 服务身份是描述符的 `name`。契约包装了两份也指向同一服务。
- 同版本 Core 副本之间的描述符、`optional` 包装与 required 不可用错误可互通；不据此承诺不同版本或任意 Core 类实例可混用。依赖仍应使用 peer 并尽量去重。
- `provide(descriptor, impl)` 按描述符约束实现类型。
- Core 默认登记的八项基础服务与第三方服务共用容器、描述符和 `bind`；`uses` 中的 required / optional 规则也相同。基础服务以 `exclusive` 登记，防止同名接口指向另一套实现；这项登记策略第三方同样可以使用。
- 领域能力（LLM 的 `vision`、storage 的 `local-path`）挂在服务实例 / model handle 的元数据上，由各 `-api` 的 helper 筛选，不进内核 DI。

第三方登记契约（`BindingPort` / `Registrar`）见 [枢纽服务](../design/hub-services.md)。

## 内置服务的登记

八项内置服务（`events` / `hooks` / `contributions` / `lifecycle` / `logger` / `config` / `provide` / `services`）与第三方服务走同一条登记路径：加载插件前，根激活经 `provide` 以 `exclusive` 登记它们，同样经过 `provide` 的校验、发出 `service:registered`、归属根激活。唯一的例外是 `provide` 自身：根激活要先取得 `provide` 才能登记其余七项，因此 `provide` 的提供者由 `ActivationHost` 直接写入容器一次来自举。宿主三项（`app` / `plugins` / `host-config`）同样由根激活经 `provide` 独占登记。

内置服务在容器中的提供者是函数 `(identity: symbol) => 门面`：传入一次激活的身份，返回属于这次激活的接口，经这个接口登记的监听、中间件、贡献与服务都归这次激活。内置描述符的 `bind` 是 `port => port.require()(port.identity)`，只用公开的资源口。提供者先核对该身份属于在 `uses` 里声明过本服务的激活，否则抛错「内置服务 "x" 只能由在 uses 里声明了它的激活取用」。不声明就拿不到门面：经 `services.get(events)` 动态查到的只是提供者函数，未声明 `events` 的激活无法用它取得接口。

## 资源身份

资源口的 `identity` 是这次激活的不透明资源身份（`symbol`）。`id` 是日志、展示、路由用的逻辑名；归属与核对用 `identity`，不从 `id` 字符串推断。

`identity` 是凭据：交给谁，谁就能以这次激活的名义调用认它的提供者。提供者据它把登记归到这次激活。内置服务按这种方式为每个调用方交出门面；第三方契约包也可以同样提供按调用方区分的服务：提供者登记为 `(identity) => 接口`，描述符的 `bind` 以 `port.identity` 取用，提供者按身份保存的状态由 `bind` 经 `port.track` 登记撤回、随这次激活关闭释放。binder 不应把 `identity` 转交给这次激活以外的代码。

## 解析顺序

同一服务名可有多个提供者。`current` / `get` 的解析顺序为 **偏好 > 优先级 > 注册顺序**：先看是否有偏好的提供者（且仍存在），否则取优先级最高、最先注册者。无提供者返回 `undefined`。

`provide(descriptor, impl, { exclusive: true })` 要求这个服务名下没有其他登记；该条目存在期间，任何第二条登记都被拒绝。它不改变解析顺序，也不赋予永久驻留权；退订后可以重新登记。

## ServiceView

容器对外交出条目的投影，每次读都是新对象，改投影字段不影响容器；投影不包含清理归属：

```typescript
interface ServiceView<T = unknown> {
  instance: T;
  contextId: string;  // 注册者逻辑身份（展示 / 偏好 / 路由），不是清理钥匙
  priority: number;
  label?: string;
}
```

`all()` / `services.all(key)` 返回该投影的数组快照，顺序同样遵循「偏好 > 优先级 > 注册顺序」。

`instance` 是登记进容器的对象本身。只查看登记信息应使用 `services.inspect(key)`：返回 `contextId` / `priority` / `label` 与 `exclusive`，不含实例。WebUI 服务列表使用这一元数据入口。

## 行为边界

- `current` / `require` 返回本次解析到的登记对象。缓存不是自动转发代理。
- 手动缓存的 `all()[i]` 不产生关停边。
- `services.get` / `services.all` 不增加声明、不参与激活闸、不自动跟随，也不产生关停边。关停期仍可能拿空；需要声明等待与跟随的，写进 `uses` 并使用 `follow`。
- 顶层 required 缺席会 `pending`，恢复重新激活；胜者替换不一律重启消费者。

## `services`：动态查询与偏好

管理、展示面用。插件在 `uses` 里声明 `services` 后拿到：

```typescript
interface Services {
  get(key: ServiceDescriptor | string): unknown | undefined;
  all(key: ServiceDescriptor | string): ServiceView[];
  inspect(key: ServiceDescriptor | string): ServiceInfo[];
  names(): string[];
  preferred(key: ServiceDescriptor | string): string | undefined;
  prefer(key: ServiceDescriptor | string, contextId: string): boolean;
  unprefer(key: ServiceDescriptor | string): boolean;
}
```

有描述符就用描述符（带类型）；只有运行期字符串（URL、配置里的服务名）就用名字，类型由调用方收窄。

动态查内置服务拿到的是提供者函数，不是门面：它只接受在 `uses` 里声明了该服务的激活身份，以其他身份调用即抛错。要用内置服务，在 `uses` 里声明它。

`prefer(key, contextId)` 把该服务的胜者钉到指定逻辑身份，无视 priority。偏好可在目标 entry 注册前提前设置。切换偏好发出 `service:preference-changed`，驱动 `follow` 订阅者按胜者变化重挂。也可在 WebUI 的 Services 页设置；配置项为 `servicePreferences`。

跨多 entry 按会话持久化选择，推荐走请求维度的 hint（把选择存在用户 profile），而不是容器维度的偏好——`prefer` 是全局、进程级单例，不适合 per-user。参见 [plugin-author-guide §13](../plugin-author-guide.md#13-用户偏好放哪里-per-user-不进容器)。

## ServiceContainer

宿主经 `AppOptions.services` 注入替身、或管控类代码经 `app.services` 巡视时用。插件不直接持有容器：注册走 `provide(descriptor, impl)`，消费走 `uses` 后的 `ServiceRef` 或 `services.get`。

容器按名字存取，不认识类型——实现是否满足契约由描述符在 `provide` 处约束。`register` 的 `owner` 是清理归属（激活门面自动传入）；省略则该 entry 不被拆卸自动清理，调用方用返回的退订闭包自管。`unregisterByOwner` 按 owner 而非 contextId 批量清理，同名激活互不误清。

`app.services.get(name)` / `getAll(name)` 返回登记进容器的对象本身。内置八项登记的是提供者函数，宿主要用它们的接口须经 `app.bind`，如 `app.bind({ events }).events`；只看登记元数据用 `app.services.inspect(name)`。

`hasByContext(name, contextId)` 的「拥有」语义同时匹配 `contextId === ownerId` 和以 `ownerId + '/'` 为前缀的 per-entry 子 entry（如 `@aalis/plugin-llm-ollama:main/llama3`）。
