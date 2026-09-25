# api-host-config — 宿主配置文档契约

**包名**: `@aalis/api-host-config`  
**源码**: `packages/api-host-config/src/index.ts`  
**实现**: 宿主提供（Node 宿主为 `@aalis/runtime` 的 `installHostConfig`）

## 概述

配置文档记录「下次启动用什么」：插件配置、禁用名单、服务偏好与各域业务字段（如 authority 的 `owners`）。core 只持运行态（各实例的配置、禁用态、服务偏好），不读写配置文档；文档的读写与落盘由宿主负责。

本包定义 `hostConfig` 描述符（服务名 `host-config`）、读写面 `HostConfig` 与配置文档类型 `AalisConfig`，不含实现。Node 宿主 `@aalis/runtime` 把 `aalis.config.yaml` 以本服务独占登记在根上；其他宿主要让插件读写文档，需自行 provide 本描述符。该服务由宿主而非插件提供，需要读写文档的插件（WebUI、市场、CLI、authority 等）在 `uses` 里显式声明，通常写成 `optional(hostConfig)`，宿主未提供时自行降级。

## 配置文档类型

```ts
interface AalisConfig {
  name: string;
  logLevel: string;
  plugins: Record<string, Record<string, unknown>>;
  /** 被禁用的插件实例 id；宿主登记插件时据此以禁用态登记 */
  disabledPlugins?: string[];
  /** 服务偏好：serviceName → preferred contextId；宿主启动时应用到服务容器 */
  servicePreferences?: Record<string, string>;
  [key: string]: unknown;
}
```

本包只声明宿主层字段。各域业务字段经 declaration merging 注入；`[key: string]: unknown` 兜底，未做 declaration merging 的插件也能读到自己的顶层字段（类型为 `unknown`）。

```ts
import type {} from '@aalis/api-host-config'; // declaration merging 锚点

declare module '@aalis/api-host-config' {
  interface AalisConfig {
    myFeature?: { enabled: boolean };
  }
}
```

第一方的注入方如 `@aalis/api-authority`（`owners`、`deniedCapabilities` 等，见 [api-authority](./api-authority.md)）。

## 服务接口

```ts
interface HostConfig {
  get<K extends keyof AalisConfig>(key: K): AalisConfig[K];
  getAll(): Readonly<AalisConfig>;
  set<K extends keyof AalisConfig>(key: K, value: AalisConfig[K]): void;
  getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(instanceId: string): T;
  setPluginConfig(instanceId: string, config: Record<string, unknown>): void;
  removePluginConfig(instanceId: string): void;
  isPluginDisabled(instanceId: string): boolean;
  setPluginEnabled(instanceId: string, enabled: boolean): void;
  getServicePreferences(): Record<string, string>;
  setServicePreference(name: string, contextId: string): void;
  removeServicePreference(name: string): void;
  save(): Promise<void>;
}
```

- 写方法只改文档，不改运行态。
- 按实例 id 取放的方法遇到 `__proto__` / `constructor` / `prototype` 这类 id 抛「插件 id 不合法」。
- `save()` 持久化当前文档。返回的 Promise 兑现时保存已完成；失败以拒绝传出，调用方应 `await`。失败时提供方已记一笔 error 并把拒绝标记为已处理，不 `await` 的调用不会变成未处理拒绝。不保证并发保存的先后，也不负责与外部编辑合并。

## 运行态与文档分开写

管理动作（`plugins.enable` / `disable` / `updateConfig` / `bounce`、`services.prefer`）只改运行态，不写文档；`HostConfig` 的写方法只改文档，不改运行态。要跨重启保留，调用方两边都写：先做管理动作，成功后写文档，再 `save()`。

```ts
import { hostConfig } from '@aalis/api-host-config';
import { optional, pluginsService } from '@aalis/core';

// uses: { plugins: pluginsService, doc: optional(hostConfig) }
async function disablePersistently(id: string): Promise<boolean> {
  const pm = plugins.current;
  if (!pm || !(await pm.disable(id))) return false; // 运行态
  const store = doc.current;
  if (store) {
    store.setPluginEnabled(id, false); // 文档
    await store.save();
  }
  return true;
}
```

第一方的写法见 WebUI 的启停与改配置路由（`packages/plugin-webui-server/src/routes/plugins.ts`）与 mcp-client 的 `mcp_set_server_enabled` 工具（`packages/plugin-mcp-client/src/index.ts`）。

## 第一方消费方

| 插件 | 用途 | 宿主未提供时 |
|---|---|---|
| plugin-authority | 读 owners 等裁决字段；WebUI 权限页与 `/auto` 指令改动后落盘 | 激活失败（`apply` 内 `require()`） |
| plugin-webui-server | 全局配置、插件配置、启停、实例增删与服务偏好路由 | 读写文档的路由与服务偏好路由返回 503 |
| plugin-cli | 记录最后视图 `lastView` | 不记录，下次启动回到默认视图 |
| plugin-mcp-client | `mcp_set_server_enabled` 落盘 | 工具返回失败，不改运行态 |
| plugin-package-manager | 卸载后清理配置块与禁用标记 | 不清理 |

## 相关

- Node 宿主的装配（`createConfigStore`、`installHostConfig`、`withPluginConfigSync`）：[architecture/runtime](../architecture/runtime.md)
- core 持有的运行态：[core/config](../core/config.md)
