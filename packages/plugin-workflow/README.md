# @aalis/plugin-workflow

工作流编排：多步骤任务的声明式编排

## 安装

```bash
pnpm add @aalis/plugin-workflow
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：`workflow`
- uses：`cronEngine`、`events`、`hooks`、`lifecycle`、`logger`、`config`、`provide`；可选 `storage`、`tools`、`webui`（`webui-server`）

## 文档

详见 [docs/plugins/plugin-workflow.md](../../docs/plugins/plugin-workflow.md)。

## 许可

见仓库根目录 LICENSE。
