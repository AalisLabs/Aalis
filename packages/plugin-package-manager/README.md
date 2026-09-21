# @aalis/plugin-package-manager

插件包管理：从 npm 安装/卸载插件到 packages/

## 安装

```bash
pnpm add @aalis/plugin-package-manager
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：`packageManager`（服务名 `package-manager`；描述符由本包导出）
- uses：`proc`（`process`）、`logger`、`config`、`provide`、`services`；可选 `app`、`plugins`、`hostConfig`

装卸落在项目根 `dependencies`，随后 `rescan` 让加载器发现。

## 文档

详见 [docs/extensions/index.md](../../docs/extensions/index.md)。

## 许可

见仓库根目录 LICENSE。
