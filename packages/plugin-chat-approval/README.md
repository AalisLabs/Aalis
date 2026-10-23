# @aalis/plugin-chat-approval

聊天审批：owner 与她的 IM 私聊作审批面（契约见 `@aalis/api-approval`）。每个（owner 的 IM 身份，机器人账号）一份接入：她经这个账号亲手说话（私聊或群里）即在场，她经这个账号发起的审批（私聊里、群里都算）推到她与这个账号的私聊，卡上写来源；她在那里引用审批消息回复「同意」或「拒绝 原因」即结，回复不交给 agent。只认适配器明确声明为一对一的私聊；群聊窗口里不出卡。

## 角色

运行时插件，登记审批面 `chat`。

## 安装

```bash
pnpm add @aalis/plugin-chat-approval
```

## 使用

参考 [docs/plugins/plugin-chat-approval.md](../../docs/plugins/plugin-chat-approval.md) 与 [docs/api/api-approval.md](../../docs/api/api-approval.md)。

## 许可

MIT，见本目录 LICENSE。
