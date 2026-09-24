# @aalis/api-host-config

宿主配置文档契约：`host-config` 服务描述符、`HostConfig` 读写面与配置文档类型 `AalisConfig`。不含服务实现。

## 角色

- `hostConfig`：服务描述符。Node 宿主 `@aalis/runtime` 把配置文档（`aalis.config.yaml`）以它独占登记在根上；别的宿主要让插件读写文档，自己提供。管理类插件（WebUI、市场、CLI、authority）在 `uses` 里声明它。
- `HostConfig`：文档读写面加 `save()`。写方法只改文档；管理动作只改运行态。要跨重启保留，调用方两边都写。
- `AalisConfig`：配置文档类型，也是各域业务字段做 declaration merging 的目标。

## 安装

```bash
pnpm add @aalis/api-host-config
```

## 使用

```ts
import { optional } from '@aalis/core';
import { hostConfig } from '@aalis/api-host-config';

// uses: { plugins: pluginsService, doc: optional(hostConfig) }
if (await plugins.disable(id)) {
  const store = doc.current;
  if (store) {
    store.setPluginEnabled(id, false);
    await store.save();
  }
}
```

扩展文档字段：

```ts
declare module '@aalis/api-host-config' {
  interface AalisConfig {
    myFeature?: { enabled: boolean };
  }
}
```
