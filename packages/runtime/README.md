# @aalis/runtime

Aalis 独立部署运行时：node_modules 插件加载 + YAML 配置与密钥文件 + 一行启动 startAalis

## 安装

```bash
pnpm add @aalis/runtime
```

## 提供 / 依赖

宿主组装件，不是插件，无 `provides` / `uses`；`startAalis` 在根上独占登记 `host-paths`（`@aalis/api-host-paths`）、`host-config`（`@aalis/api-host-config`）与 `plugin-source`（`@aalis/api-plugin-source`）三个服务。主要导出：`startAalis`、家目录的 `parseHostArgs` / `resolveHome` / `derivePaths` / `isHomeInitialized` / `initHome`、`createNodeModulesPluginLoader`、`createFsPluginLoader`、`createPluginDiscovery`、`createConfigStore`、`installHostConfig`、`withPluginConfigSync`、`createFsYamlConfigProvider`、`createFsSecretsProvider`、`createProcessRespawnStrategy`。peer：`@aalis/core`（`>=0.19.0 <1.0.0`）。

```ts
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAalis } from '@aalis/runtime';

// 安装集是入口文件所在目录；家目录按 --home、AALIS_HOME、--profile 的顺序取，缺省 ~/.aalis
startAalis({ appDir: dirname(fileURLToPath(import.meta.url)) });
```

第一次运行前在启动命令里加上 `--init` 初始化家目录。

配置里标了 `secret: true` 的字段，值存在家目录的 `secrets.yaml`（0600），`aalis.config.yaml` 只放引用 `{ $secret: '<键>' }`；写进主配置的明文在启动或热重载时自动移过去。备份家目录时连同 `secrets.yaml` 一起备份。

## 文档

详见 [docs/architecture/runtime.md](../../docs/architecture/runtime.md)。

## 许可

见仓库根目录 LICENSE。
