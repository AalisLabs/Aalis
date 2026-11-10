# api-plugin-source — 插件来源契约

**包名**: `@aalis/api-plugin-source`  
**源码**: `packages/api-plugin-source/src/index.ts`  
**实现**: 宿主提供（Node 宿主为 `@aalis/runtime` 的 `createPluginDiscovery`）

## 概述

插件从哪里来由宿主负责，core 只接收已定义好的插件（`app.plugin` / `app.pluginAll`）。本包定义两件事，不含服务实现：

- `pluginSource` 描述符（服务名 `plugin-source`）：宿主的热扫描入口。能在运行中重新发现插件的宿主在根上提供它；打包进来的静态插件表没有可重扫的来源，不提供。
- `pluginDefinitionOf(mod)`：插件包的入口判定。加载器与包管理共用这一份判定。

## 服务接口

```ts
interface PluginSourceService {
  rescan(): Promise<string[]>;
  loaded(name: string): boolean;
}
```

- `rescan()` 重新发现插件，登记新出现且尚未注册的插件，以及配置文档里尚未注册的 `name:suffix` 实例（所属模块早已注册的也登记）。
- 返回本次新登记的主实例名（插件名，即包名）。
- 兑现时新插件已登记并尽力即时激活，不等状态机静置。要判断某个插件是否就位，看 plugins 服务的注册表（`getStatus()`），不看返回值。
- `loaded(name)` 回以 `name` 登记的主实例是不是经本来源加载的（插件名即包名，即名为 `name` 的包加载上了没有）：没有登记或宿主绕过插件来源直接登记的回 `false`。名字已登记时本来源不再加载同名的包，名字已登记不等于这个包加载上了。要判断某个包装没装上，看它而不是只看名字已登记。

Node 宿主里，`startAalis` 用 `createPluginDiscovery(app, loader, store, withPluginConfigSync(app, store, opts.configSync))` 构造发现驱动：冷启动调用 `loadAll()`，把发现的插件连同配置文档里的配置（解析密钥引用后）与禁用标记整批交给 `app.pluginAll`；它的 `rescan` 与 `loaded` 以本描述符独占登记在根上。插件定义的 `name` 必须与包名相同，不一致的包在发现时报错拒载。扫描范围由加载器决定：`createNodeModulesPluginLoader` 读取项目 `package.json` 的直接依赖，`createFsPluginLoader` 扫描 `packages/` 目录。

## 消费方

消费方以 `optional(pluginSource)` 声明，宿主不提供时自行降级：

```ts
import { pluginSource } from '@aalis/api-plugin-source';
import { optional } from '@aalis/core';

// uses: { source: optional(pluginSource) }
const names = source.present ? await source.use.rescan() : [];
```

| 插件 | 用途 | 宿主未提供时 |
|---|---|---|
| plugin-package-manager | 装完新包后让宿主发现它，按 `loaded` 判它装没装上；卸载时只卸经它从这个包加载的插件的实例 | 视同本次没有新插件、已登记的都不是经它加载的：声明为插件的包报未加载，插件名已登记的报被宿主直接登记的插件占用，卸载时只卸包 |
| plugin-webui-server | `POST /api/plugins/scan` | 返回 503 |

## 入口判定

```ts
function pluginDefinitionOf(mod: unknown): PluginDefinition | null;
```

模块的 `default` 须是 `definePlugin` 的产物，即带非空 `name` 与 `apply` 函数的对象；对不上返回 `null`。`default` 为函数或类时不算插件：它们继承了 `Function.prototype.apply`，只检查 `.apply` 会把 `export default function` 误判为插件，调用时执行的是 `Function.prototype.apply`，插件体不会运行。

## 相关

- Node 宿主的加载器与装配序：[architecture/runtime](../architecture/runtime.md)
- 插件包的 `aalis-plugin` 关键词（加载器的发现门）：[guide/third-party-plugin](../guide/third-party-plugin.md)
