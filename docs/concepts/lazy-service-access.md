# 惰性服务访问

Aalis 的服务图是活的：服务名稳定，名字背后的实例会在运行时被替换——插件热重载、或用户切换偏好 provider，都会换掉某个服务名此刻被选中的那一家。访问服务的基本原则是：**每次调用重新解析**。选择层交出的业务句柄（`caps.x.use`、`of(id)`）就是按这条原则做的活的转发句柄：每次访问成员都解析到此刻选中的那一家，存进类字段或闭包也会跟着换人。

这篇说明这套机制，以及配套手段：`follow`、登记型业务层，以及固定同一家与动态查询的边界。

## 每次访问重新解析

业务句柄不是某个实例的快照：每次读属性、调方法都向容器要本插件此刻选中的那一家。把它存起来，之后 provider 换了人，下一次调用照样打到新的那一家。

```typescript
import { INBOUND_PHASE } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { storage } from '@aalis/api-storage';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: 'example-live-handle',
  uses: { storage, hooks },
  apply({ storage, hooks }) {
    // 业务句柄是活的：存进闭包也会跟着换人
    const store = storage.use;
    hooks.use.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
      await store.writeFile('data:/log.txt', data.message.content ?? '');
      await next();
    });
  },
});
```

一段操作要落在同一家上（先读后写、多步事务），取选中那一条的句柄，固定那一家：

```typescript
import { INBOUND_PHASE } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { storage } from '@aalis/api-storage';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: 'example-pinned',
  uses: { storage, hooks },
  apply({ storage, hooks }) {
    hooks.use.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
      const store = storage.list().find(p => p.selected)?.use; // 固定此刻选中的那一家
      if (store) {
        const old = await store.readFile('data:/log.txt', 'utf8');
        await store.writeFile('data:/log.txt', `${old}${data.message.content ?? ''}\n`);
      }
      await next();
    });
  },
});
```

不必担心性能：解析结果按容器版本缓存，登记、撤回、偏好变了才重新挑，按「本插件偏好 > 全局偏好 > 优先级 > 注册顺序」取选中的那一家。已经开始的一次调用在原来那一家上完成。选不到提供者时访问成员同步抛 `ServiceUnavailableError`（错误类不导出，按 `err.name` 认）；required 依赖丢失到调度收敛之间也可能短暂选不到，不要假设「声明了 required 就永远选得到」。可选依赖先看 `present`。

句柄只转发属性读取与调用：`then`、symbol 键、`toJSON` 不转发，`await` 句柄、打印与序列化都不触发解析；`in`、`Object.keys`、对象展开看不到提供者的成员；在句柄上写属性落不到提供者。

`list()` 每次调用重新枚举全部对外可见的提供者（同一套排序，本插件选中的那一条在前）。条目的 `use` 等同 `of(id)`：固定那一家，那一家不在时访问成员抛错，同一个 id 回来后照常可用。

## 提供者换人时会发生什么

选中的那一家换人**不会**一律重启消费者。业务句柄下一次访问就打到新的那一家；有状态资源用 `follow`，登记用登记型业务层。

一次 `bounce` 的流程是：换上新的运行配置（传了 `config` 时）→ 拆掉当前激活 → 转入 pending → 重算后重新 `apply`。销毁会把该插件登记的服务一并注销，重新激活时新实例重新 `provide`。服务名没变，实例却是全新的：业务句柄随之打到新实例，经动态查询取出的原始实例则还指着旧对象。

改变「选中哪一家」的信号都发同一个事件 `service:changed(name)`，含义是「可能变了，请重读」：

| 信号 | 触发 |
| --- | --- |
| provider 注册 | `provide.use(desc, impl)`；转入后台的激活完成时上线它登记的服务 |
| provider 注销 | 激活撤回；激活超过 `slowThresholdMs` 转入后台时撤下它已登记的服务 |
| 偏好切换 | 管理面的 `services.prefer` / `unprefer` |

激活超过 `slowThresholdMs` 仍未完成的提供者在完成前不参与解析：`use` / `list()` / `services.get` 都看不到它登记的服务。阈值之前它在 `apply` 里登记的服务照常可见，转入后台时撤下，`follow` 随之交接回其余提供者。

偏好切换不改变实例集合，只改变选中哪一家。`follow` 对三种信号都跟随选中的那一家。

## `follow`：有状态资源跟随提供者

业务句柄解决的是「每次调用打到此刻选中的那一家」。还有一类需求它不覆盖：一次性把副作用挂上去（SDK 句柄、订阅、登记在提供者实例上的规则）。hub 可能比你晚上线，或中途被换实例。

`x.follow(attach)` 选得到即以选中那一家的业务句柄调 `attach`；换人时先跑上次返回的清理，等它的 Promise **落定**（完成或被拒）之后才以新选中那一家的句柄再调；选不到、下线与关闭时清理。交给 `attach` 的句柄钉在挂上的那一条登记上：那一家撤回、或同一个 id 换了新实例，它仍打到原来那一家，直到这次挂载的清理落定，之后访问抛错。等待期间的多次切换合并到最新；退订或关闭之后不再挂载，哪怕旧清理后来才落定。

```typescript
import { sessionHistory } from '@aalis/api-session-history';
import { definePlugin, logger, optional } from '@aalis/core';

export default definePlugin({
  name: 'example-follow',
  uses: { sessionHistory: optional(sessionHistory), logger },
  apply({ sessionHistory, logger }) {
    sessionHistory.follow(history => {
      const off = history.registerAccessChecker({ platform: 'example', check: () => undefined });
      logger.use.debug('访问规则已登记');
      return off;
    });
  },
});
```

约束（源码契约，不是口号）：

- `attach` **必须同步**返回 `void` 或清理函数。`async` 回调在类型上被拒；运行期若返回 thenable，会被接住并 warn，拒绝不会逃逸成 `unhandledRejection`，但**不会**被当成清理器。
- 清理可以是异步的，关闭会等它落地。拒绝被隔离并报告，**不证明**旧资源已释放。
- 运行期旧清理永久不落定会阻塞交接；关闭时按超时放弃并点名。

登记型能力（工具、命令、页面）不要手写 `follow`：契约包描述符用 `BindingPort.registrar` 造业务层的登记方法，`tools.use.register` / `commands.use.command` / `webui.use.definePage` 已包含「同键替换、提供者换人整体重挂、关闭后拒收」。registrar 与 `follow` 的串行资源交接不同：换人时立即在新提供者重挂，旧异步撤回可后台进行，不能声称所有新旧资源绝无重叠。

## 多提供者与按条目调度

`storage`、`process` 这类服务直接用业务句柄：`caps.storage.use.writeFile(...)`、`caps.process.use.execFile(...)`。存储根在 `@aalis/plugin-storage-local` 这一个提供者内部按 URI 根名路由，消费方不必关心哪个根由谁提供：

```typescript
import { INBOUND_PHASE } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { processService } from '@aalis/api-process';
import { storage } from '@aalis/api-storage';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: 'example-handles',
  uses: { process: processService, storage, hooks },
  apply({ process, storage, hooks }) {
    hooks.use.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
      await process.use.execFile('echo', ['hi']);
      await storage.use.writeFile('data:/notes/today.md', 'ok');
      await next();
    });
  },
});
```

单实例、只要选中的那一家：用 `use`。多实例且要按模型或条目调度：用 `of(id)`，或对应 `*-api` 的 `resolveXxx` helper（如 `resolveLLMModel(caps.llm, ref, requiredCaps)`，吃选择层的 `list`），不要自己重抄聚合逻辑。storage 的 URI 文法见 [storage URI 文法](./storage-uri-grammar.md)。

## 动态查询没有依赖边

`services.use.get` / `services.use.all` 是管理、展示面用的动态查询：拿到的是原始实例，按全局口径解析（不看本插件偏好），不享有业务句柄的转发语义。查到的服务**不是**声明依赖，不参与激活闸，不享有重绑与关停顺序保证。需要这些保证就写进 `uses`。关停期动态查询可能拿空，这是预期，调用方按提供者不在场处理。

单独 unload / disable / bounce 提供者时，正在用它的 required 依赖方并入同批先收尾，交接同样成立。

## 注意事项

- 经 `services.use.get` / `all` 取出的原始实例进类字段或闭包，就是失效引用。要长期持有，存业务句柄（`caps.x.use`）。
- **不要用 `events.use.on('app:stopping', …)` 清理资源。** 它只在整个应用停机时触发一次，插件热重载并不会触发它。清理副作用走 `lifecycle.use.onDispose`；需要在对外登记仍在、依赖仍可调用时交接数据，走 `lifecycle.use.onDrain`。
- `follow` 的 `attach` 执行期间退订或换人：刚拿到的清理器不会丢，会立刻按新目标收敛。
- 要枚举所有并存的 provider（管控或展示），用 `x.list()`（本插件口径，条目带业务句柄）或 `services.use.all(desc)`（全局口径，原始实例），同样每次重新枚举。
- 长期缓存 `services.use.all(desc)[i].instance`：**关停边不保护这份缓存引用**。提供者自己有失效逻辑则调用会抛；没有则可能静默成功（例如工具表按名覆盖、旧对象仍能 `add`）。需要关停保护就不要把原始实例存出去。

## 关停顺序

关停以激活为单位，分收尾（drain，`lifecycle.use.onDrain`）与关闭（close，含 `onDispose`）两阶段。依赖交接放 `onDrain`（声明的依赖仍可用）；`onDispose` 阶段依赖可能已不可用，只释放自己的资源。

编排按依赖形状分三种，不是一条无条件规则：

- 插件用别的插件的服务（声明的 required 与 optional，含尚未访问的，在编排那一刻对外的全部提供者，不只是选中的那一家）：消费者整个 close 完，提供者才 drain。
- 根激活用插件的服务（宿主经 `app.bind` 绑定）：根 drain 先于该插件 close；根收尾时插件仍活着。到根 close 时插件已按归属关闭。
- 插件用根激活登记的服务：不往排序图加边。归属保证插件 close 先于根 close，故插件 drain 时根仍活着。根若同时用这个插件的服务，上一条把根 drain 插在插件 close 之前，两笔收尾都能用到对方。

依赖成环时的处理见 [插件定义与能力](../core/context.md)。

`App.stop()` 先排干在飞重算，冻结新增绑定并进入停机态，再发屏障事件 `app:stopping`（知会，不是清理通道），等监听器完成后执行停机计划。从 `beginShutdown()` 起，新发起的 `register` / `unload` / `enable` / `disable` / `bounce` / `updateConfig` 一律立即返回 false，不改变状态或配置；拆卸由停机计划负责，停机是否完成看 `app.stop()`。

单独 unload / disable / bounce 提供者时上述交接同样成立（下游先收尾、先关，提供者之后）。动态 `services.use.get` 不产生依赖边，关停期间可能取到空；它拿到的原始实例不受关停边保护。

## 一页速查

| 你想做的事 | 用什么 | 不要 |
| --- | --- | --- |
| 调用某服务此刻选中的那一家 | `x.use.method(...)`，句柄可以存起来 | 可选依赖不先看 `x.present` 就调 |
| 一段操作固定同一家 | `x.list().find(p => p.selected)?.use`，或 `x.of(id)` | 不要拿动态查询的原始实例长期持有 |
| 把有状态资源挂到会换人的提供者上 | `x.follow(attach)`，attach 同步返回 cleanup | 不要 `async` attach；不要手写监听 `service:changed` |
| 往 hub 登记工具 / 命令 / 页面 | 业务层的登记方法（`tools.use.register` / `commands.use.command` / `webui.use.definePage`） | 不要拿 `services.use.get` 查到的原始实例直接登记（会丢掉换人重挂） |
| 按模型或条目调度 | `x.of(id)`、`*-api` 的 `resolveXxx` helper | 不要自己重抄聚合逻辑 |
| 清理资源（连接、定时器、外部句柄） | `lifecycle.use.onDispose`；交接在手数据用 `onDrain` | 不要用 `app:stopping` 当清理通道 |
| 动态按名查找（无依赖边） | `services.use.get` / `services.use.all` | 不要指望关停期一定还能拿到 |
