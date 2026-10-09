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
  readonly trimUnknownFields?: boolean;
  get<K extends keyof AalisConfig>(key: K): AalisConfig[K];
  getAll(): Readonly<AalisConfig>;
  set<K extends keyof AalisConfig>(key: K, value: AalisConfig[K]): void;
  getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(instanceId: string): T;
  setPluginConfig(instanceId: string, config: Record<string, unknown>): void;
  applyPluginConfig(instanceId: string, submitted: Record<string, unknown>): Promise<ApplyPluginConfigResult>;
  removePluginConfig(instanceId: string): void; // 只改文档；落盘后不再被任何配置引用的密钥由宿主一并删掉
  isPluginDisabled(instanceId: string): boolean;
  setPluginEnabled(instanceId: string, enabled: boolean): void;
  getServicePreferences(): Record<string, string>;
  setServicePreference(name: string, contextId: string): void;
  removeServicePreference(name: string): void;
  save(): Promise<void>;
}

type ApplyPluginConfigResult =
  | { status: 'refused' }
  | { status: 'applied'; reloaded: boolean; saveError?: unknown };
```

本接口读写的都是**文档形态**：schema 里 `secret: true` 的字段在文档里是引用 `{ $secret: '<键>' }`，值在宿主的密钥存储里（Node 宿主是家目录的 `secrets.yaml`），宿主交给插件（运行态、`config` 服务）之前解析成原值。

- `trimUnknownFields`：宿主的裁剪政策。为 `true` 时宿主同步插件配置会按 `configSchema` 删掉 schema 外字段，不声明时按 `true` 处理；替宿主写插件配置的管理面（如 WebUI 保存插件配置）按它决定裁不裁，与宿主同一政策。Node 宿主取 `startAalis({ configSync })` 的 `trimUnknownFields`，缺省为 `true`；别的宿主保留未知字段时 provide 本服务须填 `false`。
- `set` 写一个顶层字段，只改文档。`plugins` 不能经它整块替换，宿主会抛错；改插件配置用 `applyPluginConfig` 或 `setPluginConfig`。
- `getPluginConfig` 返回实例在文档里的配置，密钥字段上是引用、不是原值；插件要原值读自己的 `config`。返回的是文档里的活对象，改写前先复制。
- `setPluginConfig` 只写文档、不改运行态，只收文档形态：宿主有密钥存储、且查得到该实例的 schema 时，密钥字段上的非空明文（例如把 `config` 服务给的运行态原样写回）抛错，不让原值进文档。
- `applyPluginConfig` 改一个实例的配置并让它生效，见下文[改插件配置](#改插件配置)。
- 其余写方法只改文档，不改运行态。
- 按实例 id 取放的方法遇到 `__proto__` / `constructor` / `prototype` 这类 id 抛「插件 id 不合法」。
- `save()` 持久化当前文档，宿主有密钥存储时先写密钥、再写文档。返回的 Promise 兑现时保存已完成（宿主不持久化时立即兑现、不写盘）；失败以拒绝传出，调用方应 `await`。配置源有尚未生效的外部修改而拒写时，拒绝原因是本包导出的 `ConfigSaveRefusedError`，调用方用本包的 `isConfigSaveRefused(err)` 把它与写入失败等其它原因区分（WebUI 前者回 409、后者回 500）。判据按错误的 `name` 判定，不用 `instanceof`：进程里装有两份本包时，宿主抛出的是它那份的类。失败时提供方已记一笔日志（拒写记告警，其它记 error）并把拒绝标记为已处理，不 `await` 的调用不会变成未处理拒绝。不保证并发保存的先后，也不负责与外部编辑合并。

## 改插件配置

`applyPluginConfig(instanceId, submitted)` 一步完成拆出密钥、更新运行态、写文档与落盘：

1. 按实例的 schema 把 `submitted` 里密钥字段上的新值拆出来暂存，文档里换成引用；
2. 已登记的实例经 `updateConfig` 换上解析后的配置（解析结果与运行态相同且实例在 active 时不重启）；没登记的后缀实例按同模块已登记的定义登记（模块须声明 `reusable`），先写文档再登记，没登记上时撤回文档与暂存的密钥；
3. 写文档、提交密钥；文档里引用了被改动的键的其他实例，按新值重新加载；
4. 落盘（先密钥、后文档）。

`submitted` 是文档形态，密钥字段上另可写新值：

- 引用 `{ $secret: '<键>' }`：保持原值（写别的键即改为指向那个键）；
- 非空明文：顶层与分组里的字段写进该实例当前文档在同一位置引用的那个键，键被别的配置共用时一并改到它们；那里没有引用时新建键。数组元素里的字段一律新建键（元素可能被重排或增删，按下标找到的可能是别的元素的键）；
- `''`、空 map、空 list：不是密钥值，原样写进文档。

新键是 `<实例 id>.<字段路径>`，数组元素里的字段路径不带下标，被占用时依次加 `-2`、`-3`。宿主没有密钥存储时不拆，值原样进文档。本次提交新引入的悬空引用（键不在密钥存储里、也不是这次写入的）被拒绝：抛错，运行态与文档都不动；提交前就悬空、原样带回的不拦。

返回值：运行态不受理（停机中、正在卸载，或新的后缀实例登记被拒）时为 `{ status: 'refused' }`，文档与密钥都不改。受理后为 `{ status: 'applied', reloaded, saveError? }`：`reloaded` 为 `false` 表示解析出的配置与运行态相同、实例在 active，没有重启；`saveError` 是落盘失败的原因（拒写用 `isConfigSaveRefused` 判定），此时改动已在运行态与文档里生效，只是没写进文件。实例 id 不合法、实例不存在且没有可用来新建它的同模块定义时抛错。

## 启停与偏好：运行态与文档分开写

管理动作（`plugins.enable` / `disable`、`services.prefer`）只改运行态，不写文档；除 `applyPluginConfig` 外，`HostConfig` 的写方法只改文档，不改运行态。要让启停与服务偏好跨重启保留，调用方两边都写：先做管理动作，成功后写文档，再 `save()`。

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

第一方的写法见 WebUI 的启停路由（`packages/plugin-webui-server/src/routes/plugins.ts`）。WebUI 的改配置与新建实例路由、mcp-client 的 `mcp_set_server_enabled` 工具（`packages/plugin-mcp-client/src/index.ts`）改配置，用的是 `applyPluginConfig`。

## 第一方消费方

| 插件 | 用途 | 宿主未提供时 |
|---|---|---|
| plugin-authority | 读 owners 等裁决字段；WebUI 权限页改动后落盘 | 激活失败（`apply` 内 `require()`） |
| plugin-webui-server | 全局配置、插件配置、启停、实例增删与服务偏好路由 | 读写文档的路由与服务偏好路由返回 503 |
| plugin-cli | 记录最后视图 `lastView` | 不记录，下次启动回到默认视图 |
| plugin-mcp-client | `mcp_set_server_enabled` 经 `applyPluginConfig` 改配置并落盘 | 工具返回失败，不改运行态 |
| plugin-package-manager | 卸载后清掉禁用标记，选了同时删除配置时删配置块 | 不整理 |

## 相关

- Node 宿主的装配（`createConfigStore`、`installHostConfig`、`withPluginConfigSync`）：[architecture/runtime](../architecture/runtime.md)
- core 持有的运行态：[core/config](../core/config.md)
