# @aalis/api-hooks

钩子契约：`hooks` 服务描述符、中间件签名 `MiddlewareFn` / `MiddlewareNext`、提供者契约 `HookRegistry` 与扩展点 `HookContextMap`。不含实现，默认提供者是 `@aalis/plugin-hooks`。

## 角色

- `hooks`：服务描述符。插件在 `uses` 里声明后得到绑定门面：`middleware(hook, fn)` 登记中间件，随本次激活撤回；`run(hook, data, defaultAction?, opts?)` 驱动一条链，返回 `false` 表示被截停。
- `HookContextMap`：空接口，由各领域 `-api` 包经 declaration merging 注入「钩子名 → 中间件上下文」。
- 没有提供者时 `run` 返回被拒的 Promise，不执行默认动作。

## 顺序

链内按登记顺序执行。登记序是每条登记自带的序号，提供者按它排链：以更高优先级换上另一个提供者时，各插件的登记整批重挂，链序不变。提供者重启时，依赖它的插件随之重启并重新登记，链序即重新激活的次序，与冷启动相同。相位内的 handler 应与顺序无关。

自己实现提供者时，`register` 须按 `order` 升序插入。

## 运行中换提供者的已知现状

以更高优先级上线第二个钩子提供者，或在服务页切换 hooks 偏好时，有两种情形会让截停者暂时缺席：

- 换人那一刻正在执行的链会跳过已移到新提供者的中间件。被跳过的若是截停者，默认动作照样执行。
- 胜者在容器里同步换人，各插件的登记要逐个重挂到新提供者上。重挂完成前新发起的链，只能看到已经搬过来的中间件。

两种情形都只发生在运行中换提供者的那一刻。第一方部署只有 `@aalis/plugin-hooks` 一个提供者，不会遇到。

## 安装

```bash
pnpm add @aalis/api-hooks
```

## 使用

```ts
import { hooks } from '@aalis/api-hooks';

// uses: { hooks }
hooks.middleware('agent:llm:before', async (data, next) => {
  // 改 data 后交棒；不调 next 即截停
  await next();
});
```

扩展钩子键：

```ts
declare module '@aalis/api-hooks' {
  interface HookContextMap {
    'schedule:before': { jobId: string };
  }
}
```
