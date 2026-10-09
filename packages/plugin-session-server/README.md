# @aalis/plugin-session-server

会话服务：会话协议（`@aalis/api-session-protocol`）的服务端，另提供审批服务（`@aalis/api-approval`）。把 session-manager 里的会话投影成会话列表（「我的」与房间两区、房间按适配器实例分组、出错、完成未读、运行中），按会话事件推增量，转发会话的建、改名、归档与恢复、删除与配置（会话自己的设置，以及全局默认、平台档、平台类型档与场所的按层读写），另记「我的」区的已读时间；订阅一个会话时给出快照（存档归并的历史与在途回合的条目），之后把 agent、工具与存档的事件拼成条目推送；回合控制（发消息、继续、停止、压缩、回滚、清空待办）转给 agent、网关、压缩服务（`compression`）、检查点与待办。审批推给在场的审批面，同一会话排队、限频，先答先得并核应答人与内容哈希，请求与决定成对记进家目录的审计文件。

## 角色

运行时插件，提供 `session-protocol` 与 `approvals` 服务。

## 安装

```bash
pnpm add @aalis/plugin-session-server
```

## 使用

参考 [docs/plugins/plugin-session-server.md](../../docs/plugins/plugin-session-server.md)、[docs/api/api-session-protocol.md](../../docs/api/api-session-protocol.md) 与 [docs/api/api-approval.md](../../docs/api/api-approval.md)。

## 许可

MIT，见本目录 LICENSE。
