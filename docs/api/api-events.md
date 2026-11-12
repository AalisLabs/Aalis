# api-events — 事件契约

**包名**: `@aalis/api-events`  
**源码**: `packages/api-events/src/index.ts`  
**实现**: `@aalis/plugin-events`

## 概述

事件是广播通知：`emit` 逐个调用监听器，监听器之间互相隔离，不能拦截。要改写数据或截停流程用钩子（见 [api-hooks](./api-hooks.md)）。

本包定义 `events` 描述符（服务名 `events`）、绑定接口 `Events`、监听器签名 `EventHandler`、提供者契约 `EventBus` 与扩展点 `AalisEvents`，不含实现。core 不内置事件总线，默认提供者是 [`@aalis/plugin-events`](../plugins/plugin-events.md)，提供者不独占。用到事件的插件在 `uses` 里声明 `events`，并把 `@aalis/api-events` 加进 `dependencies`；部署时须装上提供者插件。

core 自己不发事件：整体装好之后开始对外干活用 `lifecycle.onReady`，收尾用 `lifecycle` 的 `signal`、`onDrain`、`onDispose`，某个服务的提供者可能变了用它选择层的 `watch`（见 [插件定义与能力](../core/context.md)），插件状态可能变了用 `plugins` 服务的 `watch`（见 [插件管理](../core/plugin.md)）。

## 绑定接口

```ts
type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

interface Events {
  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<EventArgs<E>>): () => void;
  emit<E extends string & keyof AalisEvents>(event: E, ...args: EventArgs<E>): Promise<void>;
}
```

- `on(event, handler)` 经 `registrar` 登记，返回退订，随本次激活撤回。每次调用都是一条独立登记：同一个函数登记两次触发两次，各自的退订只撤自己那条。提供者尚未就绪时登记留在归属表里，提供者上线后挂上；上线之前发出的事件不补发。
- `emit(event, ...args)` 按登记方的位次逐个调用监听器，监听器返回 Promise 时等它落定再调下一个。返回的 Promise 在全部监听器执行完后兑现，始终兑现。发射方等不等它由自己定。
- 没有提供者时 `emit` 什么都不做。

## 派发规则

- **顺序**：按登记方的位次（宿主自己登记的最前，插件按实例 id 的码元序，同一个插件登记的几条按登记先后），不使用数字优先级。顺序不构成语义：监听器不得依赖自己相对其他监听器的位置。
- **隔离**：单个监听器抛错（同步抛出或返回被拒的 Promise）只影响它自己：其余监听器照常执行，`emit` 不被拒。默认提供者记一条 warn，点名事件与登记它的插件。
- **快照**：一次派发只送达它开始时已登记的监听器。派发途中新登记的不收这一次，途中退订的跳过。
- **归属**：每条登记归属登记方这次激活，激活关闭时与服务登记同一拍撤回：`onDrain` 回调执行时监听器仍在，清理回调（`onDispose`）执行时本激活的监听器已不再收到事件。撤回不等已经在执行的监听器，监听器里的异步工作在本激活收尾、清理期间可能仍在跑：要在关闭前完成的，自己记下并在 `onDrain` 里等；要停下的，交给 `lifecycle.use.signal` 取消。监听器另行发起、没有交还给 `emit` 的 Promise，`emit` 不等，它的拒绝也不经监听器的错误隔离。

## 顺序与提供者变化

位次与登记序随登记一起交给提供者（`on` 的 `seat` 与 `order`），提供者按它们排。次序不看登记发生的时刻：

- **插件重启**：重启的插件重新登记，落回它自己的位次，次序不变。
- **提供者重启**：必选依赖它的插件随之重启并重新登记，可选依赖它的插件与宿主根的登记原样重挂到新的提供者上，次序与冷启动相同。
- **换提供者**：以更高优先级换上另一个提供者时，消费者不重启，各插件的登记在换人那次调用里重挂到新提供者，次序不变。已知现状：换人瞬间正在派发的事件会跳过已移走的监听器；只装 `@aalis/plugin-events` 一个提供者的部署不会遇到。
- **停机**：提供者按关停计划关闭，声明了 `events` 的插件（必选或可选）都排在它之前收尾、关闭，它们在自己的收尾里发事件时提供者还在。宿主根最后关闭：提供者关闭之后，根上的监听不再收到事件，根这时发出的事件也没有提供者可送。

## 提供者契约

```ts
interface EventBus {
  on(event: string, handler: EventHandler<unknown[]>, contextId: string, order: number, seat: string): () => void;
  emit(event: string, ...args: unknown[]): Promise<void>;
}
```

插件不直接调用 `EventBus`：登记经 `events` 的绑定门面，门面填入本激活 id（`contextId`，供监听器抛错时点名）、登记序（`order`，进程内单调递增）与登记方的位次（`seat`：宿主的根是空串，插件是它的实例 id）。自行实现提供者时：

- `on` 须按（`seat`，`order`）插入该事件的监听器表：先比 `seat` 的码元序，同一 `seat` 按 `order` 升序。只按 `order` 排的话，插件重启后它的监听器会换位置。返回的退订幂等，只撤这一条。
- `emit` 须遵守上面的派发规则，返回的 Promise 不得被拒。

## 声明事件

`AalisEvents` 是空接口，各契约包与插件经 declaration merging 注入「事件名 → 参数元组」：

```ts
import type {} from '@aalis/api-events'; // declaration merging 锚点

declare module '@aalis/api-events' {
  interface AalisEvents {
    'scheduler:tick': [jobId: string];
    'scheduler:error': [jobId: string, error: Error];
  }
}
```

注入后 `events.use.on()` 与 `events.use.emit()` 按键获得精确类型。要让 TS 看到某个包注入的事件，需把该包加进依赖（值导入或 side-effect import）。谁注入了哪一族事件见 [扩展点索引 §2](../extensions/index.md)，键与参数的权威定义在该包的 `declare module` 声明里。

`AalisEvents` 是类型封闭的（没有 `[key: string]` 兜底）：未声明的事件名在 `events.use.on` / `events.use.emit` 处直接编译报错。事件名需要运行时动态生成（如按频道、任务 id 派生）时，在自己的命名空间内合并一条模板字面量签名：

```ts
declare module '@aalis/api-events' {
  interface AalisEvents {
    // 动态事件名族：myplugin:channel: 前缀下的任意后缀都合法，参数类型统一
    [k: `myplugin:channel:${string}`]: [payload: ChannelMessage];
  }
}

events.use.on(`myplugin:channel:${channelId}`, async msg => { /* msg: ChannelMessage */ });
```

同前缀下更具体的字面量键仍可逐条声明（TS 优先匹配字面量）。前缀必须用自己插件的命名空间，避免与他人的模板签名相互吞并。

`EventArgs<E>` 取事件 `E` 的参数元组，写泛型辅助函数时用它，不直接写 `AalisEvents[E]`。

声明的事件，除了 plugin-workflow 拒绝表里的，都能被编排的 `event` 触发器当成触发源：事件参数插值进编排的节点，按编排定义者的身份运行。拒绝表只在 plugin-workflow 里，只列第一方声明的事件（见 [plugin-workflow](../plugins/plugin-workflow.md#触发器)）：第三方插件声明的事件，负载里带会话内容（会话 id、平台、正文等）的也会被当成触发源，声明它的插件拦不住。所以第三方插件声明事件时，请在说明里写明负载里有什么，由定义编排的人自己判断能不能订阅。

## 典型用法

```ts
import { events } from '@aalis/api-events';
import { definePlugin } from '@aalis/core';
import type {} from '@aalis/schema-message'; // 引入消息事件

export default definePlugin({
  name: '@acme/plugin-example-events',
  uses: { events },
  apply({ events }) {
    events.use.on('inbound:message', message => {
      // …
    });
  },
});
```

## 实现者

- [@aalis/plugin-events](../plugins/plugin-events.md) —— 默认提供者
