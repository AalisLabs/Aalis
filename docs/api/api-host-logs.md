# api-host-logs — 宿主日志契约

**包名**: `@aalis/api-host-logs`  
**源码**: `packages/api-host-logs/src/index.ts`  
**实现**: 宿主提供（Node 宿主为 `@aalis/runtime` 的 `createHostLogs`）

## 概述

写日志是 core 发给每个插件的 `logger`；读整个日志流是宿主的管理能力：日志里有用户消息、路径与报错细节，不随 `logger` 发给每个插件，要读的插件在 `uses` 里声明本服务，订阅归本次激活。历史在宿主那里（Node 宿主是家目录的 `logs/latest.log`），core 只有实时的日志通道，所以读日志的服务由宿主提供，不进 core。

本包定义 `hostLogs` 描述符（服务名 `host-logs`）与服务接口 `HostLogs`，不含实现。Node 宿主 `@aalis/runtime` 在根上独占提供它；其他宿主要给插件读日志，需自行 provide 本描述符。除了 core 与 runtime，`packages` 下的源码不引用 core 的日志中枢 `LogHub`（architecture 守卫 `test/architecture/log-hub-readers.test.ts` 会拦下）。

## 服务接口

```ts
interface HostLogs {
  recent(limit: number, options?: { before?: number; match?(entry: LogEntry): boolean }): Promise<LogEntry[]>;
  subscribe(listener: (entry: LogEntry) => void, options?: { history?: number }): () => void;
}
```

- `recent(limit, options)`：本轮启动以来最后 `limit` 条，按 `seq` 升序。`before` 只看 `seq` 比它小的（往前翻页），`match` 只收符合的。宿主往前只扫有限的一段，筛得很窄、翻得很深时可能不满 `limit` 条；宿主不写文件日志时没有历史，回空数组。
- `subscribe(listener, options)`：先补发最近的 `history` 条（缺省 0），再送此后的每一条，按 `seq` 递增、不重不漏。返回退订。`listener` 抛错（含返回被拒的 Promise）只丢掉这一次，不影响订阅，与日志中枢的订阅者同一规则。

业务层的 `subscribe` 是登记：订阅归本次激活，激活关闭时与其它登记同一拍撤回，插件不必自己退订；`recent` 照常转发给提供者。

## Node 宿主的做法

`startAalis` 在登记任何插件之前，以 `createHostLogs(LogHub.default, fileLogger, app.logger)` 独占提供本服务：实时接默认日志中枢（runtime 不给 App 注入别的中枢），历史读本轮的 `logs/latest.log`（启动期的日志也写在里面）。读历史之前先等文件日志把已记下的写完；从文件末尾往前最多扫 16 MiB。子命令模式不写文件日志，没有历史。

## 使用

```ts
import { hostLogs } from '@aalis/api-host-logs';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: 'my-log-viewer',
  uses: { logs: optional(hostLogs) },
  apply({ logs }) {
    logs.use.subscribe(entry => render(entry), { history: 500 });
  },
});
```

宿主不一定提供它（嵌入式宿主、测试夹具），日志页这类功能写成 `optional(hostLogs)`：宿主不提供时，订阅留在账上不送任何日志，提供者上线后才生效；`recent` 要先看 `present`。

## 第一方使用方

| 插件 | 用途 | 宿主不提供时 |
|---|---|---|
| `plugin-cli` | 日志页：激活时订阅，补发最近 2000 条，之后实时 | 日志页为空 |
| `plugin-webui-server` | `/api/logs/tail`、`/api/logs/range` 的历史（`recent` 带筛选与 `before`）；`/admin` 上的实时推送（激活时订阅） | 历史接口回 503，没有实时推送 |
