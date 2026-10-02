# @aalis/plugin-session-server

会话服务：会话协议（`@aalis/api-session-protocol`）的服务端。把 session-manager 里的会话投影成会话列表（「我的」与房间两区、房间按适配器实例分组、出错、完成未读、运行中），按会话事件推增量，转发会话的建、改名、归档、删除与配置，另记「我的」区的已读时间；订阅一个会话时给出快照（存档归并的历史与在途回合的条目），之后把 agent、工具与存档的事件拼成条目推送；回合控制（发消息、继续、停止、压缩、回滚、清空待办）转给 agent、网关、检查点与待办。

## 角色

运行时插件，提供 `session-protocol` 服务。

## 安装

```bash
pnpm add @aalis/plugin-session-server
```

## 使用

参考 [docs/plugins/plugin-session-server.md](../../docs/plugins/plugin-session-server.md) 与 [docs/api/api-session-protocol.md](../../docs/api/api-session-protocol.md)。

## 许可

MIT，见本目录 LICENSE。
