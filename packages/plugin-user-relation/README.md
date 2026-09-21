# @aalis/plugin-user-relation

用户关系图谱：抽取事件/实体/关系

## 安装

```bash
pnpm add @aalis/plugin-user-relation
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：`userRelation`（服务名 `user-relation`；描述符由本包导出）
- uses：`memory`、`logger`、`config`、`events`、`hooks`、`contributions`、`provide`；可选 `llm`、`platform`、`tools`、`commands`、`webui`（`webui-server`）、`embedding`、`agent`

## 文档

详见 [docs/plugins/user-relation.md](../../docs/plugins/user-relation.md)。

## 许可

见仓库根目录 LICENSE。
