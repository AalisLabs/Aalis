# @aalis/runtime

Aalis 独立部署运行时：node_modules 插件加载 + YAML 配置 + 一行启动 startAalis

## 安装

```bash
pnpm add @aalis/runtime
```

## 提供 / 依赖

宿主组装件，不是插件，无 `provides` / `uses`；`startAalis` 在根上独占登记 `host-config`（`@aalis/api-host-config`）与 `plugin-source`（`@aalis/api-plugin-source`）两个服务。主要导出：`startAalis`、`createNodeModulesPluginLoader`、`createFsPluginLoader`、`createPluginDiscovery`、`createConfigStore`、`installHostConfig`、`withPluginConfigSync`、`createFsYamlConfigProvider`、`createProcessRespawnStrategy`。peer：`@aalis/core`（`>=0.17.0 <1.0.0`）。

```ts
import { startAalis } from '@aalis/runtime';
```

## 文档

详见 [docs/architecture/runtime.md](../../docs/architecture/runtime.md)。

## 许可

见仓库根目录 LICENSE。
