# @aalis/plugin-memory-history

跨会话消息历史上下文（基础记忆）

## 安装

```bash
pnpm add @aalis/plugin-memory-history
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：无
- uses：`memory`、`config`、`logger`、`contributions`；可选 `tools`、`sessionManager`（能取哪些会话按它的规则；不在时只取得到当前会话）

## 文档

详见 [docs/plugins/plugin-memory-history.md](../../docs/plugins/plugin-memory-history.md)。

## 许可

见仓库根目录 LICENSE。
