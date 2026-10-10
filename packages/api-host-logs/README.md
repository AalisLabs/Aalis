# @aalis/api-host-logs

宿主日志契约：`host-logs` 服务描述符与服务接口 `HostLogs`。不含服务实现。

## 角色

- `hostLogs`：服务描述符。Node 宿主 `@aalis/runtime` 在根上独占提供：历史读本轮的 `logs/latest.log`，实时接日志中枢。别的宿主要给插件读日志，自己提供。
- `HostLogs`：`recent(limit, { before, match })` 取最近的日志；`subscribe(listener, { history })` 先补发最近几条、再接实时，`seq` 连续、不重不漏。业务层的订阅归本次激活，关闭时撤回。

写日志用 core 发给每个插件的 `logger`；读整个日志流要在 `uses` 里声明本描述符，不直接订阅 core 的 `LogHub`。

## 安装

```bash
pnpm add @aalis/api-host-logs
```

## 使用

```ts
import { hostLogs } from '@aalis/api-host-logs';

// uses: { logs: optional(hostLogs) }
logs.use.subscribe(entry => render(entry), { history: 500 });
```

详见 [docs/api/api-host-logs.md](../../docs/api/api-host-logs.md)。
