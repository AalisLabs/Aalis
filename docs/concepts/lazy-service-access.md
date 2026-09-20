# 惰性服务访问

Aalis 的服务图是活的：服务名稳定，名字背后的实例会在运行时被替换——插件热重载、或用户切换偏好 provider，都会换掉某个服务名当前的胜者。访问服务的基本原则是：**每次查询重新解析**。`ServiceRef.current` 与 `require()` 返回的是本次解析的提供者本身，不是自动转发所有调用的代理；把它存进类字段或闭包，之后的调用不会跟着换人。

这篇说明为什么要这样，以及配套手段：`follow`、登记型绑定门面、以及吃 `ServiceRef` 的惰性网关。

## 每次查询重新解析

`current` 是 getter：每次读取都向容器要当前胜者。把读出来的值存起来，之后 provider 换了人，手里的引用并不会更新。

```typescript
import { INBOUND_PHASE } from '@aalis/api-gateway';
import { storage } from '@aalis/api-storage';
import { definePlugin, hooks } from '@aalis/core';

export default definePlugin({
  name: 'example-cache-ref',
  uses: { storage, hooks },
  apply({ storage, hooks }) {
    // 反模式：把当时点的裸实例缓存进闭包
    const frozen = storage.current;
    hooks.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
      await frozen?.writeFile('data:/log.txt', data.message.content ?? '');
      await next();
    });
  },
});
```

把查询留在用到的那一刻：

```typescript
import { INBOUND_PHASE } from '@aalis/api-gateway';
import { storage } from '@aalis/api-storage';
import { definePlugin, hooks } from '@aalis/core';

export default definePlugin({
  name: 'example-reread',
  uses: { storage, hooks },
  apply({ storage, hooks }) {
    hooks.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
      await storage.current?.writeFile('data:/log.txt', data.message.content ?? '');
      await next();
    });
  },
});
```

不必担心性能：解析只是查一次容器，按「偏好 > 优先级 > 注册顺序」返回当前胜者。`require()` 在无提供者时抛错；required 依赖丢失到调度收敛之间也可能短暂为空，不要假设「声明了 required 就永不 `undefined`」。

`all()` 每次调用重新枚举全部提供者（同一套排序）。`all()[i]` 取到的是那一时刻的 `ServiceView`；长期缓存其中的 `instance` 同样会失效。

## 提供者换人时会发生什么

胜者替换**不会**一律重启消费者。下游应通过 `current` / `require()` 惰性读到新实例，或用 `follow` / 登记型门面处理有状态资源。

一次 `bounce` 的流程是：写入配置 → 拆掉当前激活 → 转入 pending → 重算后重新 `apply`。销毁会把该插件登记的服务一并注销，重新激活时新实例重新 `provide`。服务名没变，实例却是全新的——这正是缓存裸引用会出事的原因。

改变「谁是当前胜者」的信号：

| 信号 | 触发 | 事件 |
| --- | --- | --- |
| provider 注册 | `provide(desc, impl)` | `service:registered` |
| provider 注销 | 激活撤回 | `service:unregistered` |
| 偏好切换 | `services.prefer` / `unprefer` | `service:preference-changed` |

偏好切换不改变实例集合，只改变谁是胜者。`follow` 对三种信号都跟随胜者。

## `follow`：有状态资源跟随提供者

`current` 解决的是「每次读到最新值」。还有一类需求它不覆盖：一次性把副作用挂上去（SDK 句柄、订阅、确认通道）。hub 可能比你晚上线，或中途被换实例。

`x.follow(attach)` 在场即调 `attach`；换人时先跑上次返回的清理，等它的 Promise **落定**（完成或被拒）之后才用新实例再调；下线与关闭时清理。等待期间的多次切换合并到最新；退订或关闭之后不再挂载，哪怕旧清理后来才落定。

```typescript
import { authority } from '@aalis/api-authority';
import { definePlugin, logger, optional } from '@aalis/core';

export default definePlugin({
  name: 'example-follow',
  uses: { authority: optional(authority), logger },
  apply({ authority, logger }) {
    authority.follow(provider => {
      if (!provider.setConfirmHandler) return;
      const off = provider.setConfirmHandler('*', async () => false);
      logger.debug('fallback handler 已注册');
      return off;
    });
  },
});
```

约束（源码契约，不是口号）：

- `attach` **必须同步**返回 `void` 或清理函数。`async` 回调在类型上被拒；运行期若返回 thenable，会被接住并 warn，拒绝不会逃逸成 `unhandledRejection`，但**不会**被当成清理器。
- 清理可以是异步的，关闭会等它落地。拒绝被隔离并报告，**不证明**旧资源已释放。
- 运行期旧清理永久不落定会阻塞交接；关闭时按超时放弃并点名。

登记型能力（工具、命令、页面）不要手写 `follow`：契约包描述符用 `BindingPort.registrar` 造绑定门面，`tools.register` / `commands.command` / `webui.registerPage` 已包含「同键替换、提供者换人整体重挂、关闭后拒收」。registrar 与 `follow` 的串行资源交接不同：换人时立即在新提供者重挂，旧异步撤回可后台进行，不能声称所有新旧资源绝无重叠。

## 惰性网关：吃 `ServiceRef`

`storage`、`process` 这类服务，消费者通常不想关心「当前哪个 root 由哪个后端提供」。对应 `*-api` 的网关工厂接受 `ServiceRef`，每个方法内部重新解析当前提供者（storage 还按 URI 跨 root 路由）。这个句柄**可以长期持有**——它从不捕获裸实例：

```typescript
import { INBOUND_PHASE } from '@aalis/api-gateway';
import { createProcessGateway, processService } from '@aalis/api-process';
import { createStorageGateway, storage } from '@aalis/api-storage';
import { definePlugin, hooks } from '@aalis/core';

export default definePlugin({
  name: 'example-gateway',
  uses: { process: processService, storage, hooks },
  apply({ process, storage, hooks }) {
    const proc = createProcessGateway(process);
    const store = createStorageGateway(storage);
    hooks.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
      await proc.execFile('echo', ['hi']);
      await store.writeFile('data:/notes/today.md', 'ok');
      await next();
    });
  },
});
```

单实例、只要当前胜者：每次读 `current` 即可，或用网关。多实例且要按 URI / 模型透明调度：用对应 `*-api` 的网关或 `resolveXxx` helper（如 `resolveLLMModel(llm, ref, caps)`），不要自己重抄聚合逻辑。storage 的 URI 文法见 [storage URI 文法](./storage-uri-grammar.md)。

## 动态查询没有依赖边

`services.get` / `services.all` 是管理、展示面用的动态查询：查到的服务**不是**声明依赖，不参与激活闸，不享有重绑与关停顺序保证。需要这些保证就写进 `uses`。关停期动态查询可能拿空，这是预期（例如 webui 在 file-reader 已关后按名查删除接口会得到 `undefined`，改走自己的 storage）。

单独卸载提供者不享有整个 App 关停的交接保证。

## 注意事项

- 裸引用进类字段或闭包，就是失效引用。框架不会因为写了 `uses` 就保护你缓存的任意取值。
- **不要用 `events.on('app:stopping', …)` 清理资源。** 它只在整个应用停机时触发一次，插件热重载并不会触发它。清理副作用走 `lifecycle.onDispose`；需要在对外登记仍在、依赖仍可调用时交接数据，走 `lifecycle.onDrain`。
- `follow` 的 `attach` 执行期间退订或换人：刚拿到的清理器不会丢，会立刻按新目标收敛。
- 要枚举所有并存的 provider（管控或展示），用 `x.all()` 或 `services.all(desc)`，同样每次重新枚举。
- 长期缓存 `all()[i].instance`：**关停边不保护这份缓存引用**。提供者自己有失效逻辑则调用会抛；没有则可能静默成功（例如工具表按名覆盖、旧对象仍能 `add`）。需要关停保护就不要把裸实例存出去。

## 关停顺序

关停以激活为单位，分收尾（drain，`lifecycle.onDrain`）与关闭（close，含 `onDispose`）两阶段。依赖交接放 `onDrain`（声明的依赖仍可用）；`onDispose` 阶段依赖可能已不可用，只释放自己的资源。

编排按依赖形状分三种，不是一条无条件规则：

- 普通依赖（required，以及 optional 当时解析到的胜者）：消费者整个 close 完，提供者才 drain。
- 父使用自己子树的服务：父 drain 先于子 close；父收尾时子树仍活着。到父 close 时子已按归属关闭。
- 后代使用祖先服务：不往排序图加边。归属树保证子 close 先于祖先 close，故子 drain 时祖先仍活着。祖先若同时用这棵子树，第 2 种边把祖先 drain 插在子 close 之前，两笔收尾都能用到对方。

环：optional 边按自然次序让步（不告警）；只剩 required 边仍无解才告警并强行放行。

`App.stop()` 先排干在飞重算，冻结新增绑定并进入停机态，再发屏障事件 `app:stopping`（知会，不是清理通道），等监听器完成后执行停机计划。停机期间 `unload` / `disable` 汇入该计划后立即返回 true（不等拆卸完成）；`register` / `bounce` 返回 false。

单独卸载提供者不享有上述交接保证。动态 `services.get` 不产生依赖边，关停期间可能取到空。缓存的 `all()[i]` 引用不受关停边保护。

## 一页速查

| 你想做的事 | 用什么 | 不要 |
| --- | --- | --- |
| 偶尔读一次某服务的当前胜者 | `x.current` / `x.require()`，即取即用 | 不要把读出的值存进类字段或闭包 |
| 长期持有一个自动跟随换人的句柄 | `createStorageGateway(storage)` / `createProcessGateway(process)` | 不要缓存 `current` 的裸实例 |
| 把有状态资源挂到会换人的提供者上 | `x.follow(attach)`，attach 同步返回 cleanup | 不要 `async` attach；不要手写监听 `service:registered` |
| 往 hub 登记工具 / 命令 / 页面 | `uses` 描述符的绑定门面（`register` / `command` / `registerPage`） | 不要绕过门面直接打到 `current` 上（会丢掉换人重挂） |
| 跨 root 或跨 model 透明路由 | `*-api` 的 `resolveXxx` 或网关 helper | 不要自己重抄聚合逻辑 |
| 清理资源（连接、定时器、外部句柄） | `lifecycle.onDispose`；交接在手数据用 `onDrain` | 不要用 `app:stopping` 当清理通道 |
| 动态按名查找（无依赖边） | `services.get` / `services.all` | 不要指望关停期一定还能拿到 |
