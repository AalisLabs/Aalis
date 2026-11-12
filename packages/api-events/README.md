# @aalis/api-events

事件契约：`events` 服务描述符、监听器签名 `EventHandler`、提供者契约 `EventBus` 与扩展点 `AalisEvents`。不含实现，默认提供者是 `@aalis/plugin-events`。

## 角色

- `events`：服务描述符。插件在 `uses` 里声明后得到绑定门面：`on(event, handler)` 登记监听器，随本次激活撤回；`emit(event, ...args)` 按登记顺序逐个调用监听器并等它落定。
- `AalisEvents`：空接口，由各契约包与插件经 declaration merging 注入「事件名 → 参数元组」。未声明的事件名编译报错。
- 监听器之间互相隔离：单个监听器抛错只记一条 warn，其余照常执行，`emit` 始终兑现。发射方等不等 `emit` 由它自己定。
- 一次派发只送达它开始时已登记的监听器；途中退订的跳过。
- 没有提供者时 `emit` 什么都不做，`on` 的登记留着，提供者上线后挂上。

## 顺序

监听器按登记顺序执行。登记序是每条登记自带的序号，提供者按它排：以更高优先级换上另一个提供者时，各插件的登记整批重挂，次序不变。提供者重启时，依赖它的插件随之重启并重新登记，次序即重新激活的次序，与冷启动相同。

自己实现提供者时，`on` 须按 `order` 升序插入。

## 运行中换提供者的已知现状

以更高优先级上线第二个事件提供者时，换人那一刻正在派发的事件会跳过已移到新提供者的监听器。第一方部署只有 `@aalis/plugin-events` 一个提供者，不会遇到。

## 安装

```bash
pnpm add @aalis/api-events
```

## 使用

```ts
import { events } from '@aalis/api-events';

// uses: { events }
events.use.on('scheduler:tick', jobId => {
  // …
});
await events.use.emit('scheduler:tick', 'job-1');
```

声明事件：

```ts
declare module '@aalis/api-events' {
  interface AalisEvents {
    'scheduler:tick': [jobId: string];
  }
}
```
