# 枢纽服务：第三方能力的登记契约

core 只有四种原语：事件、服务、钩子、贡献点。工具、命令、页面、诊断检查这类"登记进某个服务、由它派活"的能力不是 core 原语，
它们由三件套组成：契约包声明服务与登记项类型，枢纽服务持有登记本并派活，helper 把登记绑到调用方 Context 的生命周期上。
插件经 `ctx.whenService` 登记，core 不认识"工具""命令"是什么。

这页给出三件套的范本，然后逐条列出这类登记与四原语共享哪些保证、允许哪些差异、各由哪个测试钉住。
消费侧的 `whenService` 用法见 [惰性服务访问](../concepts/lazy-service-access.md)；拆卸顺序见 [Context](../core/context.md)。

## 三件套范本

### 契约包

```ts
// packages/api-xxx/src/index.ts
import type { Context, DisposableService } from '@aalis/core';

export interface XxxItem {
  name: string;
  run(input: unknown): Promise<unknown>;
}

export interface XxxService extends DisposableService {
  /** 登记一条；返回退订闭包。同名替换还是并存由本能力定义，写在这里 */
  register(item: XxxItem, contextId: string): () => void;
  list(): readonly XxxItem[];
}

declare module '@aalis/core' {
  interface ServiceTypeMap {
    xxx: XxxService;
  }
}

/** 绑到调用方 Context：服务未上线时等它上线，换人时重挂，拆卸时随撤回段摘净 */
export function useXxx(ctx: Context) {
  return {
    register: (item: XxxItem) => ctx.whenService('xxx', svc => svc.register(item, ctx.id)),
  };
}
```

`register(item, contextId)` 的第二个参数是登记方的 `ctx.id`：枢纽的登记本在服务自己手里，拆卸兜底清扫（下文）用的就是这把钥匙。

### 枢纽服务

```ts
// 提供者插件内部
class XxxHub implements XxxService {
  private readonly items = new Map<string, { item: XxxItem; contextId: string }>();

  register(item: XxxItem, contextId: string): () => void {
    const entry = { item, contextId };
    this.items.set(item.name, entry); // 同名替换
    // 退订按条目引用比对：同名被替换后，旧闭包不得摘掉新登记
    return () => {
      if (this.items.get(item.name) === entry) this.items.delete(item.name);
    };
  }

  unregisterByPlugin(contextId: string): void {
    for (const [name, entry] of this.items) {
      if (entry.contextId === contextId) this.items.delete(name);
    }
  }

  list(): readonly XxxItem[] {
    return [...this.items.values()].map(e => e.item);
  }
}

export function apply(ctx: Context) {
  ctx.provide('xxx', new XxxHub());
}
```

两条是硬要求：退订闭包按**这一次登记**比对，不按名字加 contextId（否则同名重登记后旧闭包会把新登记一起删掉）；
实现 `unregisterByPlugin(contextId)`，Context 拆卸的最后一步会对每个在场服务调它，摘掉该 `ctx.id` 名下的全部登记。
同名政策（替换、并存、按 Context 分层）由能力自己定，但必须写进契约包文档。

### helper 的两种形状

上面的 `useXxx` 是一行委托：每条登记一条 `whenService` 订阅。调用方在 `apply` 里登记一次、每个 Context 几条，这就够了；
同名重登记前先调上次返回的退订闭包。

当一种能力的登记数多、且会反复同名刷新（工具是典型：一个连接器几十个工具，列表变了整批重登记），一条登记一条订阅会让
旧订阅在提供者换人时把早已被替换的登记重新挂上，订阅数也随刷新次数增长。这时 helper 应改为每个 Context 一份绑定、
一条订阅：

```ts
interface Bound { item: XxxItem; off?: () => void }
interface Binding { svc: XxxService | undefined; items: Map<string, Bound> }
const bindings = new WeakMap<Context, Binding>();

function bind(ctx: Context): Binding {
  const existing = bindings.get(ctx);
  if (existing) return existing;
  const b: Binding = { svc: undefined, items: new Map() };
  bindings.set(ctx, b);
  ctx.whenService('xxx', svc => {
    b.svc = svc;
    for (const e of b.items.values()) e.off = svc.register(e.item, ctx.id);
    return () => {
      b.svc = undefined;
      for (const e of b.items.values()) {
        e.off?.();
        e.off = undefined;
      }
    };
  });
  return b;
}

export function useXxx(ctx: Context) {
  return {
    register(item: XxxItem): () => void {
      if (ctx.disposed) {
        ctx.logger.warn(`Context "${ctx.id}" 已 dispose，忽略 xxx 登记 "${item.name}"`);
        return () => {};
      }
      const b = bind(ctx);
      b.items.get(item.name)?.off?.(); // 同名替换：先摘旧登记
      const entry: Bound = { item, off: b.svc ? b.svc.register(item, ctx.id) : undefined };
      b.items.set(item.name, entry);
      return () => {
        if (b.items.get(item.name) !== entry) return;
        b.items.delete(item.name);
        entry.off?.();
        entry.off = undefined;
      };
    },
  };
}
```

绑定版多给两条保证：同名替换后旧退订闭包失效、不复活；提供者换人对同一 Context 是整体重挂，任一微任务观察到的都是 0 条或全部。
关闭后登记的口径（warn、不进枢纽）一行委托版由 `whenService` 的入口守卫兜底，绑定版绕过它直连枢纽，必须自己在入口判
`ctx.disposed`，否则就成了绑定版独有的漏。`@aalis/api-tools` 的 `useToolService` 是这个形状的现行实现。

枢纽的退订若是异步的（摘登记要等远端确认），绑定的批量撤回要合并等待，否则 `disposeAsync` 等不到它们。cleanup 的两句脱挂照旧，
只把逐条 `off` 换成合并等待：

```ts
return () => {
  b.svc = undefined;
  const offs = [...b.items.values()].map(e => {
    const settled = e.off?.();
    e.off = undefined;
    return settled;
  });
  return Promise.all(offs).then(() => undefined);
};
```

`whenService` 的 cleanup 返回 promise 即被等待（拒绝记 warn、不逃逸）；此时契约包里的 `register` 应声明返回 `() => Promise<void>`。

## 共同契约与允许的差异

| 项 | 四原语（`on` / `provide` / `middleware` / `contribute`） | 枢纽登记（经 `whenService`） | 钉住的测试 |
|---|---|---|---|
| 撤回时机 | 用户清理开始前，由 core 按归属整体摘除 | 清理链撤回段：先于全部 `onDispose`，且此时四原语已切断 | `test/core/whenservice-withdraw-phase.test.ts` |
| 撤回钥匙 | owner 标识，core 自己发、自己收；同 id 的两个 Context 互不误清 | 条目引用（退订闭包）；`unregisterByPlugin(ctx.id)` 兜底清扫按逻辑 id，同 id 并存时会互清 | `test/core/owner-identity.test.ts`、`test/plugins/hub-registration-identity.test.ts`、`test/core/context.test.ts` |
| 异步撤回 | 无，同步摘除 | cleanup 可返回 promise；`disposeAsync` 等它落地（含手动退订、换人启动的在飞项），拒绝记 warn；同步 `dispose()` 不等 | `test/core/whenservice-async-cleanup.test.ts` |
| 关闭后登记 | warn + no-op | `whenService` 同口径；`useToolService` 同口径 | `test/core/post-dispose-policy.test.ts`、`test/plugins/hub-registration-identity.test.ts` |
| 同键重复 | `contribute` 替换；`on` / `middleware` 并存；`provide` 同名多提供者并存 | 由能力自定并写进契约包：工具与分组替换（helper 与枢纽两层）；命令按 Context 分层；页面并存；诊断检查项与预处理器在枢纽替换、helper 不去重 | `test/core/contributions.test.ts`、`test/plugins/hub-registration-identity.test.ts` |
| 提供者换人 | 不适用 | 先跑上次 cleanup、再用新实例重挂；胜者不变则不动 | `test/core/context.test.ts` |
| 退订闭包幂等 | 是 | 是 | 同上 |

差异都来自"登记本在谁手里"：四原语的登记本在 core，钥匙可以是插件写不出的内部标识；枢纽的登记本在服务，注册那一侧是插件作者亲手写的
`svc.register(x, ctx.id)`，清扫必须用同一把钥匙。同键政策不统一是刻意的：工具按名唯一，页面天然可以并存，命令要支持覆盖后复位。

## 不承诺的边界

- `plugins.register()` 返回 `true` 只表示已受理，激活是否落定看 `plugins.idle()`。
- 关停顺序（消费者先于提供者）只在 `App.stop()` 的整体拓扑逆序成立；拓扑只按 `inject.required` 建图，同名服务取首个声明 `provides` 的插件。
  单插件 `unload` / `disable` / `bounce` 不提供该顺序。
- 撤回登记不结束在飞的工作：已开始的事件处理、工具执行、被消费者存下的服务引用，不因注销而停止；`disposeAsync` 的超时只是停止等待。
