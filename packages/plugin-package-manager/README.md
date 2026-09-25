# @aalis/plugin-package-manager

插件包管理：从 npm 安装/卸载/更新到项目根 dependencies

## 安装

```bash
pnpm add @aalis/plugin-package-manager
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：`packageManager`（服务名 `package-manager`；描述符由本包导出）
- uses：`proc`（`process`）、`logger`、`config`、`provide`、`services`；可选 `app`、`plugins`、`hostConfig`（`host-config`）、`source`（`plugin-source`）

装卸落在项目根 `dependencies`，随后经宿主的 `plugin-source` 服务 `rescan()` 让加载器发现；宿主不提供插件来源时视同本次没有新插件。卸载后经 `host-config` 清理配置块与禁用标记，宿主未提供配置文档时不清理。

装卸只接受插件（`aalis-plugin`）与前端界面（`aalis-interface`）包；卸载会让其它插件失去所需服务的唯一提供者时拒绝。插件写入存储根的数据不随卸载删除。

## 文档

详见 [docs/extensions/index.md](../../docs/extensions/index.md)。

## 许可

见仓库根目录 LICENSE。
