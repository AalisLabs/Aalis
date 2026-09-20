# 服务：描述符、按名解析、偏好

插件通过**服务描述符**声明与发布服务；容器按名保存多个提供者，按「偏好 > 优先级 > 注册顺序」选出胜者。

**源码**: `packages/core/src/context/binding.ts`、`packages/core/src/primitives/services.ts`、`packages/core/src/context/builtins.ts`

消费与发布的插件侧入口见 [插件定义与能力](context.md)。本页补描述符、容器投影、以及动态查询 / 偏好（`services`）。

## 描述符

一个服务有两张面：共享的提供者（容器里的实例，全 App 一份）与按激活绑定的调用接口（每次插件激活一份，登记自动归属这次激活）。描述符把两者连起来。

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
- 领域能力（LLM 的 `vision`、storage 的 `local-path`）挂在服务实例 / model handle 的元数据上，由各 `-api` 的 helper 筛选，不进内核 DI。

第三方登记契约（`BindingPort` / `Registrar`）见 [枢纽服务](../design/hub-services.md)。

## 解析顺序

同一服务名可有多个提供者。`current` / `get` 的解析顺序为 **偏好 > 优先级 > 注册顺序**：先看是否有偏好的提供者（且仍存在），否则取优先级最高、最先注册者。无提供者返回 `undefined`。

## ServiceView

容器对外只交出条目的投影，每次读都是新对象，改它不影响容器；清理归属是容器内部的钥匙，任何读口都不交出：

```typescript
interface ServiceView<T = unknown> {
  instance: T;
  contextId: string;  // 注册者逻辑身份（展示 / 偏好 / 路由），不是清理钥匙
  priority: number;
  label?: string;
}
```

`all()` / `services.all(key)` 返回该投影的数组快照，顺序同样遵循「偏好 > 优先级 > 注册顺序」。

## 行为边界

- `current` / `require` 返回本次解析的提供者本身。缓存引用可能失效，不是自动转发的代理。
- `all()[i]` 手动选非默认提供者并长期缓存：关停边不覆盖这些引用。提供者有失效逻辑则后续调用抛错，无则可能静默成功。
- `services.get` / `services.all` 是动态查询，**不产生依赖边**，不参与激活闸，关停期可能拿空。需要等待、重绑、关停顺序保证的，写进 `uses`。
- 顶层 required 缺席会 `pending`，恢复重新激活；胜者替换不一律重启消费者。

## `services`：动态查询与偏好

管理、展示面用。插件在 `uses` 里声明 `services` 后拿到：

```typescript
interface Services {
  get(key: ServiceDescriptor | string): unknown | undefined;
  all(key: ServiceDescriptor | string): ServiceView[];
  names(): string[];
  preferred(key: ServiceDescriptor | string): string | undefined;
  prefer(key: ServiceDescriptor | string, contextId: string): boolean;
  unprefer(key: ServiceDescriptor | string): boolean;
}
```

有描述符就用描述符（带类型）；只有运行期字符串（URL、配置里的服务名）就用名字，类型由调用方收窄。

`prefer(key, contextId)` 把该服务的胜者钉到指定逻辑身份，无视 priority。偏好可在目标 entry 注册前提前设置。切换偏好发出 `service:preference-changed`，驱动 `follow` 订阅者按胜者变化重挂。也可在 WebUI 的 Services 页设置；配置项为 `servicePreferences`。

跨多 entry 按会话持久化选择，推荐走请求维度的 hint（把选择存在用户 profile），而不是容器维度的偏好——`prefer` 是全局、进程级单例，不适合 per-user。参见 [plugin-author-guide §13](../plugin-author-guide.md#13-用户偏好放哪里-per-user-不进-servicecontainer)。

## ServiceContainer

宿主经 `AppOptions.services` 注入替身、或管控类代码经 `app.services` 巡视时用。插件不直接持有容器：注册走 `provide(descriptor, impl)`，消费走 `uses` 后的 `ServiceRef` 或 `services.get`。

容器按名字存取，不认识类型——实现是否满足契约由描述符在 `provide` 处约束。`register` 的 `owner` 是清理归属（激活门面自动传入）；省略则该 entry 不被拆卸自动清理，调用方用返回的退订闭包自管。`unregisterByOwner` 按 owner 而非 contextId 批量清理，同名激活互不误清。

`hasByContext(name, contextId)` 的「拥有」语义同时匹配 `contextId === ownerId` 和以 `ownerId + '/'` 为前缀的 per-entry 子 entry（如 `@aalis/plugin-llm-ollama:main/llama3`）。
