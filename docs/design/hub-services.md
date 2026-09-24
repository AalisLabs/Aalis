# 枢纽服务：第三方能力的登记契约

core 只有四种原语：事件、服务、钩子、贡献点。工具、命令、页面、诊断检查这类"登记进某个服务、由它派活"的能力不是 core 原语，
它们由三件套组成：契约包导出描述符与登记项类型，枢纽服务持有登记本并派活，描述符的 `bind` 用 `BindingPort` 把登记绑到调用方这次激活的生命周期上。
插件经 `uses` 拿到按激活绑定的门面，core 不认识"工具""命令"是什么。

这页给出三件套的范本，然后逐条列出这类登记与四原语共享哪些保证、允许哪些差异、各由哪个测试钉住。
消费侧的 `follow` / `registrar` 语义见 [插件定义与能力](../core/context.md)；拆卸顺序见同页生命周期节。

## 三件套范本

### 契约包：描述符 + 按激活绑定门面

```ts
// packages/api-xxx/src/index.ts
import { defineService, serviceRef, type ServiceRef } from '@aalis/core';

export interface XxxItem {
  name: string;
  run(input: unknown): Promise<unknown>;
}

export interface XxxService {
  /** 登记一条；返回退订闭包。同名替换还是并存由本能力定义，写在这里 */
  register(item: XxxItem, contextId: string): () => void;
  list(): readonly XxxItem[];
}

/** 调用方拿到的绑定接口：登记自动归属这次激活 */
export interface BoundXxx extends ServiceRef<XxxService> {
  register(item: XxxItem): () => void;
}

export const xxx = defineService<XxxService, BoundXxx>('xxx', port => {
  const entries = port.registrar<XxxItem>({
    key: item => item.name,
    register: (service, item) => service.register(item, port.id),
  });
  const extra = {
    register: (item: XxxItem) => entries.add(item),
  };
  return serviceRef(port, extra);
});
```

`register(item, contextId)` 的第二个参数是登记方的逻辑 id（`port.id`）：枢纽若要在自己的登记本上记下「谁登记的」（展示、`pluginName`）用这把钥匙。清理不靠它——`BindingPort.registrar` 按条目句柄撤回，归属这次激活。

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

  list(): readonly XxxItem[] {
    return [...this.items.values()].map(e => e.item);
  }
}

export default definePlugin({
  name: '@scope/plugin-xxx',
  uses: { provide },
  provides: [xxx],
  apply({ provide }) {
    provide(xxx, new XxxHub());
  },
});
```

硬要求：退订闭包按**这一次登记**比对，不按名字加 contextId（否则同名重登记后旧闭包会把新登记一起删掉）。
同名政策（替换、并存、按激活分层）由能力自己定，但必须写进契约包文档。撤回由调用方的 `registrar` 驱动，枢纽不必再实现一套按 id 的批量清扫协议。

### 消费方

```ts
export default definePlugin({
  name: '@scope/plugin-xxx-user',
  uses: { xxx },
  apply({ xxx }) {
    xxx.register({ name: 'a', run: async () => 1 });
  },
});
```

`registrar` 已给出：同名替换后旧退订闭包失效、不复活；提供者换人对同一激活是整体重挂（被动注册表走 overlap：立即在新提供者挂上，旧异步撤回后台落定，关闭会等）；关闭后登记 warn、不进枢纽。`@aalis/api-tools` 的 `tools` 描述符是这个形状的现行实现。

这个范本的前提是枢纽的 `register` 与退订闭包**同步且不抛错**。`register` 在批量重挂中途抛错，跟随只记 warn、订阅保持，
但抛错前已登记的条目若没有句柄可撤，提供者换人时可能留在旧枢纽里；"整体重挂"的保证只对不抛错的枢纽成立。单条 `register` 对调用方抛错时，账上不留半条——同键替换失败时旧登记已撤，旧条目一并出账，不会在下次换提供者时复活。

退订是异步的枢纽（摘登记要等远端确认）不能照抄这个范本：批量撤回要用 `Promise.allSettled` 合并等待（`Promise.all` 一项拒绝就提前落定，
其余撤回还没完成，清理段就开始了）；同步抛错的退订要转成拒绝，否则后面的条目不再撤回。`registrar` / `track` 会把异步清理挂进这次激活的在飞账，关闭等到、拒绝被接住。
第一方没有这样的枢纽，这页不提供经验证的异步范本。

需要跟随提供者建立**有状态**资源（SDK 句柄、订阅）而不是被动登记表时，用 `port.follow` / `ServiceRef.follow`：串行交接，旧清理落定后才挂新实例，与 `registrar` 的 overlap 重挂不同。

## 共同契约与允许的差异

| 项 | 四原语（`events.on` / `provide` / `hooks.middleware` / `contributions.contribute`） | 枢纽登记（经 `BindingPort.registrar`） | 钉住的测试 |
|---|---|---|---|
| 撤回时机 | 用户清理开始前，由 core 按归属整体摘除 | 四原语切断后同一拍发起，不等下游交接；异步部分由撤回段收口等待，先于全部 `onDispose` | `test/core/whenservice-withdraw-phase.test.ts`、`test/core/binding-hardening.test.ts`、`test/core/management-handover.test.ts` |
| 撤回钥匙 | 这次激活的资源身份：core 发、经资源口的 `identity` 交给 binder、拆卸时自己收；同 id 的两次激活互不误清 | 条目引用（退订闭包）；逻辑 id 只给枢纽自己的展示 / `pluginName` | `test/core/owner-identity.test.ts`、`test/plugins/hub-registration-identity.test.ts` |
| 异步撤回 | 无，同步摘除 | cleanup 可返回 promise；关闭等它落地（含手动退订、换人启动的在飞项），拒绝记 warn | `test/core/whenservice-async-cleanup.test.ts` |
| 关闭后登记 | warn + no-op | `registrar.add` / `follow` 同口径 | `test/core/post-dispose-policy.test.ts`、`test/plugins/hub-registration-identity.test.ts` |
| 同键重复 | `contribute` 替换；`on` / `middleware` 并存；`provide` 同名多提供者并存 | 由能力自定并写进契约包：工具与分组替换（helper 与枢纽两层）；命令按激活分层；页面并存 | `test/core/contributions.test.ts`、`test/plugins/hub-registration-identity.test.ts` |
| 提供者换人 | 不适用 | `registrar`：立即在新提供者重挂，旧撤回可重叠；`follow`：先跑上次 cleanup、等落定再用新实例 | `test/core/binding-hardening.test.ts` |
| 退订闭包幂等 | 是 | 是 | 同上 |

差异都来自"登记本在谁手里"：四原语的登记本在 core，钥匙是这次激活的资源身份（插件写不出，只能从资源口的 `identity` 拿）；枢纽的登记本在服务，注册那一侧是 `svc.register(x, port.id)`，展示用同一把逻辑 id。同键政策不统一是刻意的：工具按名唯一，页面天然可以并存，命令要支持覆盖后复位。

## 不承诺的边界

- `plugins.register()` 返回 `true` 只表示已受理，激活是否落定看 `plugins.idle()`。
- 关停顺序只在 `App.stop()` 的整次计划里按实际绑定编排；单插件 `unload` / `disable` / `bounce` 不提供该顺序。动态 `services.get` 不产生依赖边。
- 枢纽登记随消费者激活撤回：撤回在消费者 drain 之后、close 之前完成。
- 撤回登记不结束在飞的工作：已开始的事件处理、工具执行、被消费者存下的服务引用，不因注销而停止；关闭超时只是停止等待。
- 缓存 `current` 或 `all()[i]` 拿到的裸引用不受关停边保护。
