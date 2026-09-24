# 服务：描述符、按名解析、偏好

插件通过**服务描述符**声明与发布服务；容器按名保存多个提供者，按「偏好 > 优先级 > 注册顺序」选出胜者。

**源码**: `packages/core/src/composition/descriptors.ts`、`packages/core/src/composition/binding.ts`、`packages/core/src/primitives/services.ts`、`packages/core/src/composition/core-services.ts`

消费与发布的插件侧入口见 [插件定义与能力](context.md)。本页补描述符、容器投影、以及动态查询 / 偏好（`services`）。

## 描述符

一个服务有两张面：容器中的提供者登记，与消费方通过描述符得到的绑定接口。登记可以是共享实例，也可以是 `serviceFactory` 工厂；工厂按消费者激活创建实例。描述符的 `bind` 把解析后的实例与资源口连成调用接口。

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
- `provide(descriptor, impl)` 按描述符约束实现类型。
- Core 默认登记的八项基础服务与第三方服务共用容器、描述符和 `bind`；`uses` 中的 required / optional 规则也相同。基础服务以 `exclusive` 登记，防止同名接口指向另一套实现；这项登记策略第三方同样可以使用。
- 领域能力（LLM 的 `vision`、storage 的 `local-path`）挂在服务实例 / model handle 的元数据上，由各 `-api` 的 helper 筛选，不进内核 DI。

第三方登记契约（`BindingPort` / `Registrar`）见 [枢纽服务](../design/hub-services.md)。

## 按消费者创建实例

`serviceFactory(scope => instance)` 是公开的同步工厂。一次登记在每个消费者激活中成功创建一次，后续查询复用；同名但身份不同的激活分别创建。重新登记是新的条目，会创建新实例。

以下插件提供一个按消费者隔离的计数器。消费者从契约包导入同一个 `counter` 描述符，在 `uses: { counter }` 后调用 `counter.require().next()`。

```typescript
import { definePlugin, defineService, provide, serviceFactory } from '@aalis/core';

export const counter = defineService<{ next(): number }>('counter');

export default definePlugin({
  name: '@scope/plugin-counter',
  uses: { provide },
  provides: [counter],
  apply({ provide }) {
    provide(counter, serviceFactory(scope => {
      let value = 0;
      const period = setInterval(() => scope.logger.debug(`${scope.id}: ${value}`), 60_000);
      scope.track(() => clearInterval(period), 'counter-timer');
      return { next: () => ++value };
    }));
  },
});
```

`scope` 是工厂的消费者资源口：`id` / 不透明 `identity`、消费者 `logger` / `config`、`closed`，以及 `track` / `onDrain` / `onDispose`。它不暴露激活记录、容器或原语注册表，也不是传给插件 `apply` 的入口。

- 工厂必须同步返回非空、非 thenable 的实例。异步工厂被类型检查和运行期拒收；返回 Promise 的拒绝仍被接住并报告。
- 经 scope 登记的资源属于消费者。成功实例对应的提供者边保留到消费者关闭；切换胜者不会提前清理旧实例的资源。需要每次切换都交接的资源应在 `follow` 的 attach 中取得、由返回清理函数释放。`follow` 串行的是这两步，不保证工厂构造延后，也不会在切换时释放工厂自己的资源。
- 构造失败会回滚该次登记：撤回 `track`，执行未取消的 `onDispose`，取消 `onDrain`。异步回滚被消费者关闭等待，完成后释放该次工厂边；失败 scope 的迟到清理也会执行。
- 缓存不自动转发调用，也不取消提供者主动卸载、依赖成环或清理超时等边界。工厂资源的交接同样服从 [关停契约](context.md#生命周期)。
- 同版本 Core 副本之间的描述符、`optional` 包装、工厂与 required 不可用错误可互通；不据此承诺不同版本或任意 Core 类实例可混用。依赖仍应使用 peer 并尽量去重。

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

这两个消费入口会为当前消费者解析工厂；`all()` 会解析每个提供者，包括非胜者。只查看登记信息应使用 `services.inspect(key)`：返回 `contextId` / `priority` / `label`、`scope: 'shared' | 'activation'` 与 `exclusive`，不含实例，不运行工厂。WebUI 服务列表使用这一元数据入口。

## 行为边界

- `current` / `require` 返回本次解析的实例：共享服务直接返回登记对象，工厂返回属于当前消费者的实例。缓存不是自动转发代理。
- 手动缓存共享服务的 `all()[i]` 不产生关停边。已创建的工厂实例则保留其准确提供者的边，包括非胜者，直到消费者关闭。
- `services.get` / `services.all` 不增加声明、不参与激活闸，也不自动跟随。动态查询共享实例不产生边；如果查询实际创建了工厂实例，其托管寿命会建立提供者边。关停期仍可能拿空；需要声明等待与跟随的，写进 `uses` 并使用 `follow`。
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

`prefer(key, contextId)` 把该服务的胜者钉到指定逻辑身份，无视 priority。偏好可在目标 entry 注册前提前设置。切换偏好发出 `service:preference-changed`，驱动 `follow` 订阅者按胜者变化重挂。也可在 WebUI 的 Services 页设置；配置项为 `servicePreferences`。

跨多 entry 按会话持久化选择，推荐走请求维度的 hint（把选择存在用户 profile），而不是容器维度的偏好——`prefer` 是全局、进程级单例，不适合 per-user。参见 [plugin-author-guide §13](../plugin-author-guide.md#13-用户偏好放哪里-per-user-不进容器)。

## ServiceContainer

宿主经 `AppOptions.services` 注入替身、或管控类代码经 `app.services` 巡视时用。插件不直接持有容器：注册走 `provide(descriptor, impl)`，消费走 `uses` 后的 `ServiceRef` 或 `services.get`。

容器按名字存取，不认识类型——实现是否满足契约由描述符在 `provide` 处约束。`register` 的 `owner` 是清理归属（激活门面自动传入）；省略则该 entry 不被拆卸自动清理，调用方用返回的退订闭包自管。`unregisterByOwner` 按 owner 而非 contextId 批量清理，同名激活互不误清。

`app.services.get(name)` / `getAll(name)` 返回原始登记值，工厂条目返回工厂包装，**不是消费实例**。宿主要消费服务，用 `app.bind({ services }).services.get(descriptor)` 或 `app.bind({ target: descriptor })`；要巡视登记，用 `app.services.inspect(name)`，它不会创建实例。

`hasByContext(name, contextId)` 的「拥有」语义同时匹配 `contextId === ownerId` 和以 `ownerId + '/'` 为前缀的 per-entry 子 entry（如 `@aalis/plugin-llm-ollama:main/llama3`）。
