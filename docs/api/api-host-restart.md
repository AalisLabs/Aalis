# api-host-restart — 宿主重启契约

**包名**: `@aalis/api-host-restart`  
**源码**: `packages/api-host-restart/src/index.ts`  
**实现**: 宿主提供（Node 宿主为 `@aalis/runtime`）

## 概述

重启是宿主的事：怎么换一个新进程、旧进程何时退出、新实例没起来怎么办，只有宿主知道。core 只管插件的装配与启停，没有重启的概念；要重启的插件在 `uses` 里声明本服务。

本包定义 `hostRestart` 描述符（服务名 `host-restart`）、服务接口 `HostRestart` 与回滚凭据 `RestartRollback`，不含实现。Node 宿主 `@aalis/runtime` 在根上独占提供它。不能重启的宿主不提供：嵌入式宿主没有声明重启能力，子命令进程是一次性的。服务缺席即「这个宿主不能重启」。

## 服务接口

```ts
interface HostRestart {
  restart(opts?: { rollback?: RestartRollback }): void;
}

interface RestartRollback {
  reason: string;
  restore: Array<{ path: string; content: string; deleteIfEmpty?: boolean }>;
  postRestore?: { cmd: string; args: string[]; cwd: string };
}
```

- `restart(opts)`：请求重启。受理后立即返回，停机与换新实例在之后进行，时序由宿主决定。只受理一次：已受理过的再调是空操作；未受理过而应用已开始停机时抛错。
- `opts.rollback`：新实例没能接管时，宿主用它把工程恢复原样。由发起方在改动工程之前构造：`restore` 是要还原的文件（绝对路径与原内容；`deleteIfEmpty` 表示这个文件原本不存在，回滚时删掉它），`postRestore` 是还原之后要跑的命令（如重新安装依赖）。凭据只在宿主的内存里，不落盘。

## Node 宿主的做法

`startAalis` 在守护模式下独占提供本服务，按启动方式选重启的做法：直接启动的进程自己拉起下一代、等它报就绪后退出；带 `--service` 由服务管理器托管的进程停机后以约定的退出码退出，由服务管理器拉起。直接启动时，新实例在就绪之前退出的，按 `rollback` 还原文件、执行 `postRestore`，再拉起原来的版本；由服务管理器托管时不回滚，带回滚凭据的重启照常退出并记一条说明。细节见 [runtime](../architecture/runtime.md)。

子命令模式不提供本服务：子命令是一次性进程，重启它没有意义。

## 使用

```ts
import { hostRestart } from '@aalis/api-host-restart';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: 'my-admin',
  uses: { restart: optional(hostRestart) },
  apply({ restart }) {
    // 某个管理动作里
    if (restart.present) restart.use.restart();
  },
});
```

写成 `optional(hostRestart)` 并先看 `present`：宿主不提供时，访问 `restart.use` 的成员会抛「服务不可用」。

## 第一方使用方

| 插件 | 用途 | 宿主不提供时 |
|---|---|---|
| `plugin-commands` | `/restart` 指令 | 指令回报失败 |
| `plugin-webui-server` | `POST /api/restart`（设置页的重启按钮） | 回 500，界面不去等待重连 |
| `plugin-package-manager` | 市场更新成功之后重启接管，带回滚凭据 | 包照常装好，回执写明不会自动重启 |
