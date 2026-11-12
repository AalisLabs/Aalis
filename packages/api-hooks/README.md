# @aalis/api-hooks

钩子契约：`hooks` 服务描述符、中间件签名 `MiddlewareFn` / `MiddlewareNext`、提供者契约 `HookRegistry` 与扩展点 `HookContextMap`。不含实现，默认提供者是 `@aalis/plugin-hooks`。

## 角色

- `hooks`：服务描述符。插件在 `uses` 里声明后得到绑定门面：`middleware(hook, fn)` 登记中间件，随本次激活撤回；`run(hook, data, defaultAction?, opts?)` 驱动一条链，返回 `false` 表示被截停。
- `HookContextMap`：空接口，由各领域 `-api` 包经 declaration merging 注入「钩子名 → 中间件上下文」。
- 没有提供者时 `run` 返回被拒的 Promise，不执行默认动作。

## 顺序

链内按登记方的位次排：宿主自己登记的最前，插件按实例 id 的码元序，同一个插件登记的几条按登记先后。链序不看登记发生的时刻：插件重启、提供者重启或换人都不改变它。相位内的 handler 应与顺序无关。

自己实现提供者时，`register` 须按（`seat`，`order`）插入：先比 `seat` 的码元序，同一 `seat` 按 `order` 升序。

## 运行中换提供者的已知现状

以更高优先级上线第二个钩子提供者，或在 WebUI 设置「系统」的服务偏好里切换 hooks 时，换人那一刻正在执行的链会跳过已移到新提供者的中间件。被跳过的若是截停者，默认动作照样执行。第一方部署只有 `@aalis/plugin-hooks` 一个提供者，不会遇到。

## 安装

```bash
pnpm add @aalis/api-hooks
```

## 使用

```ts
import { hooks } from '@aalis/api-hooks';

// uses: { hooks }
hooks.use.middleware('agent:llm:before', async (data, next) => {
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
