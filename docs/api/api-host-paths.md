# api-host-paths — 宿主路径契约

**包名**: `@aalis/api-host-paths`  
**源码**: `packages/api-host-paths/src/index.ts`  
**实现**: 宿主提供（Node 宿主为 `@aalis/runtime` 的 `startAalis`）

## 概述

家目录装着一个实例的全部状态：配置、密钥、数据库、日志、人设卡、技能、舞台。安装集是放 `package.json` 与 `node_modules` 的目录（源码形态另有 `packages/`）。两者都由宿主在启动时解析一次，之后不变；进程的 cwd 不带任何语义。

本包定义 `hostPaths` 描述符（服务名 `host-paths`）与路径类型 `HostPaths`，不含实现。Node 宿主 `@aalis/runtime` 在根上独占提供它，解析规则见 [runtime 的「家目录」](../architecture/runtime.md#家目录)；其他宿主要让插件定位这些目录，需自行 provide 本描述符。插件要用时在 `uses` 里声明，不读 `process.cwd()`（architecture 守卫 `test/architecture/process-cwd.test.ts` 会拦下）。

## 服务接口

```ts
interface HostPaths {
  readonly home: string;      // 家目录
  readonly profile?: string;  // 由 --profile 或 AALIS_PROFILE 选出家目录时才有
  readonly app: string;       // 安装集
  readonly config: string;    // <家目录>/aalis.config.yaml
  readonly secrets: string;   // <家目录>/secrets.yaml（预留，目前不读取）
  readonly state: string;     // 预留：数据库、向量库、checkpoint、各插件的数据目录
  readonly logs: string;      // 文件日志 latest.log 所在目录
  readonly cache: string;     // 预留
  readonly run: string;       // 实例锁（runtime 自用）；以后还放 socket
  readonly tmp: string;       // 预留：按会话分子目录
  readonly self: { personas: string; skills: string; workflows: string };  // 预留
  readonly stage: { drafts: string; public: string; paper: string };       // 预留
}
```

全部是绝对路径。宿主在登记任何插件之前提供，运行中不会替换，所以插件可以在激活时取一次留用。

标为预留的目录由 `--init` 建出，目前还没有插件使用：实例的数据仍经 `@aalis/plugin-storage-local` 的存储根落在家目录的 `data/` 与 `workspace/` 下（白纸与公开作品在 `data/stage/` 下），之后把存储根迁入这套布局时才启用它们。`secrets.yaml` 建出时为空，目前不读取，密钥仍写在 `aalis.config.yaml` 里。

## 使用

```ts
import { hostPaths } from '@aalis/api-host-paths';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: 'my-plugin',
  uses: { paths: hostPaths },
  apply({ paths }) {
    const { app } = paths.require(); // 安装集
  },
});
```

宿主不一定提供它（嵌入式宿主、测试夹具）。离开它就做不了事的插件声明为 required，宿主不提供时停在 pending；只有部分功能依赖它的插件写成 `optional(hostPaths)`，取不到时让对应功能降级（例如 WebUI 的市场与系统组件接口回 503）。自己组装 `App` 的宿主要在登记插件之前提供它，顺序为先 `hostPaths`、再 `installHostConfig`，见 [运行态与配置文档](../core/config.md)。

## 第一方使用方

| 插件 | 用途 | 宿主不提供时 |
|---|---|---|
| `plugin-storage-local` | 存储根的相对路径按家目录解析；内部根 `logs` 指向 `logs` 目录 | 停在 pending（required） |
| `plugin-package-manager` | 往安装集里装卸插件（与插件加载器读同一份 `package.json`） | 停在 pending（required） |
| `plugin-webui-server` | 市场、系统组件与前端发现读安装集（可选依赖） | 市场与系统组件接口回 503，发现不到前端，只剩 HTTP 接口 |
