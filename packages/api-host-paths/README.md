# @aalis/api-host-paths

宿主路径契约：`host-paths` 服务描述符与路径类型 `HostPaths`。不含服务实现。

## 角色

- `hostPaths`：服务描述符。Node 宿主 `@aalis/runtime` 在启动时解析家目录与安装集，把结果以它独占登记在根上；别的宿主要让插件定位这些目录，自己提供。插件在 `uses` 里声明它，不读 `process.cwd()`。
- `HostPaths`：家目录（`home`）、可选的 profile 名、安装集（`app`），以及家目录布局里各处的绝对路径（`config`、`secrets`、`state`、`logs`、`cache`、`run`、`tmp`、`self.*`、`stage.*`）。

布局里的 `secrets`、`state`、`cache`、`tmp`、`self.*`、`stage.*` 目前是预留路径（`run` 里放 runtime 自己的实例锁）：`--init` 会建出它们，但第一方插件还没有使用，实例数据仍在家目录的 `data/` 与 `workspace/` 下，`secrets.yaml` 也还不读取。

## 安装

```bash
pnpm add @aalis/api-host-paths
```

## 使用

```ts
import { hostPaths } from '@aalis/api-host-paths';

// uses: { paths: hostPaths }
const { app, home } = caps.paths.require();
```

家目录的解析规则（`--home`、`AALIS_HOME`、`--profile` 等）见 `@aalis/runtime` 的文档。
