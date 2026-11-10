# @aalis/plugin-package-manager

插件包管理：从 npm 安装/卸载/更新到宿主安装集的 dependencies

## 安装

```bash
pnpm add @aalis/plugin-package-manager
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：`packageManager`（服务名 `package-manager`；描述符来自 `@aalis/api-package-manager`）
- uses：`proc`（`process`）、`paths`（`host-paths`）、`lifecycle`、`logger`、`provide`、`services`、`app`、`plugins`；可选 `hostConfig`（`host-config`）、`source`（`plugin-source`）

装卸落在宿主安装集（`host-paths` 的 `app`，与插件加载器读同一份 `package.json`）的 `dependencies`，随后经宿主的 `plugin-source` 服务 `rescan()` 让加载器发现；宿主不提供插件来源时视同本次没有新插件。卸载后经 `host-config` 清掉各实例的禁用标记；配置块与密钥默认留着（重装后照原配置启动），调用方传 `removeConfig: true` 时一并删掉配置块与只有它们用的密钥。配置文件没写成时包照样卸掉，回执写明原因；宿主未提供配置文档时不整理。

本插件停用、重启或停机时打断在途的 npm：已经动过文件的，等 npm 退出后把 `package.json` 与锁文件还原到操作前，回执写明没有生效、怎样对齐 node_modules；收尾等还原做完，新实例在此之前不启动。

宿主不提供 `host-paths` 时本插件停在 pending。要装到别的目录，给 `startAalis` 传 `appDir`。

装卸只接受插件（`aalis-plugin`）与前端界面（`aalis-interface`）包；卸载会让其它插件失去所需服务的唯一提供者时拒绝。插件写入存储根的数据不随卸载删除。

## 文档

服务契约见 [docs/api/api-package-manager.md](../../docs/api/api-package-manager.md)，扩展总览见 [docs/extensions/index.md](../../docs/extensions/index.md)。

## 许可

见仓库根目录 LICENSE。
