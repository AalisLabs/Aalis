# @aalis/api-host-restart

宿主重启契约：`host-restart` 服务描述符与服务接口 `HostRestart`。不含服务实现。

## 角色

- `hostRestart`：服务描述符。Node 宿主 `@aalis/runtime` 在根上独占提供；不能重启的宿主（嵌入式宿主、一次性的子命令进程）不提供。
- `HostRestart`：`restart({ rollback? })` 请求重启，只受理一次。
- `RestartRollback`：新实例没能接管时，宿主把工程恢复原样用的凭据（要还原的文件与还原后要跑的命令），由发起方构造。

插件以可选依赖声明它：服务缺席即这个宿主不能重启。

## 安装

```bash
pnpm add @aalis/api-host-restart
```

## 使用

```ts
import { hostRestart } from '@aalis/api-host-restart';

// uses: { restart: optional(hostRestart) }
if (restart.present) restart.use.restart();
```

详见 [docs/api/api-host-restart.md](../../docs/api/api-host-restart.md)。
