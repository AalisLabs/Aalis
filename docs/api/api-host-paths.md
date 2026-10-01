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
  readonly home: string;      // 家目录（Node 宿主给真实路径，符号链接已解开）
  readonly profile?: string;  // 家目录是 ~/.aalis-<profile> 时才有，不论经 --profile 还是 --home 选中
  readonly app: string;       // 安装集
  readonly config: string;    // <家目录>/aalis.config.yaml
  readonly secrets: string;   // <家目录>/secrets.yaml（目前不读取）
  readonly state: string;     // 插件状态：数据库、向量库、checkpoint、各插件的数据目录
  readonly logs: string;      // 文件日志 latest.log 所在目录
  readonly cache: string;     // 缓存
  readonly run: string;       // 实例锁（runtime 自用）；以后还放 socket
  readonly tmp: string;       // 临时区
  readonly self: { personas: string; skills: string; workflows: string };  // 人设卡、技能、编排定义
  readonly stage: { drafts: string; public: string; paper: string };       // 草稿（未使用）、发布的作品、白纸
}
```

全部是绝对路径。宿主在登记任何插件之前提供，运行中不会替换，所以插件可以在激活时取一次留用。

第一方插件不直接拼这些路径，而是经 `@aalis/plugin-storage-local` 按它们派生的内部根访问：`state` 是 `data:/`（`state/plugins` 是 `pluginData:/`），`tmp`、`cache`、`logs` 是同名的根，`self.*` 是 `personas:/`、`skills:/`、`workflows:/`，`stage.paper` 与 `stage.public` 是 `paper:/` 与 `public:/`。`stage.drafts` 目前没有对应的根，还没有插件使用。`secrets.yaml` 建出时为空，目前不读取，密钥仍写在 `aalis.config.yaml` 里；经 storage 读写 `secrets.yaml`、改写 `config` 都会被拒绝。

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
| `plugin-storage-local` | 用户根的相对路径按家目录解析；内部根按 `state`、`tmp`、`cache`、`logs`、`self.*`、`stage.paper`、`stage.public` 派生；拦住经存储访问 `secrets` 与改写 `config` | 停在 pending（required） |
| `plugin-package-manager` | 往安装集里装卸插件（与插件加载器读同一份 `package.json`） | 停在 pending（required） |
| `plugin-webui-server` | 市场、系统组件与前端发现读安装集（可选依赖） | 市场与系统组件接口回 503，发现不到前端，只剩 HTTP 接口 |
