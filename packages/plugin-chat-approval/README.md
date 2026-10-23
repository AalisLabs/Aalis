# @aalis/plugin-chat-approval

聊天审批：owner 的 IM 私聊与群窗口作审批面（契约见 `@aalis/api-approval`）。私聊每个（owner 的 IM 身份，机器人账号）一份接入：她经这个账号亲手说话（私聊或群里）即在场，她经这个账号发起的、只有她能批的审批（私聊里、群里都算）推到她与这个账号的私聊，卡上写来源；只认适配器明确声明为一对一的私聊。群窗口每个（窗口，发言者）一份接入：他在这个群里亲手说话即在场，这个群发起的参与者审批发在群里，自己就能做这件事的人都能批；只有 owner 能批的不发进群。引用审批消息回复「同意」或「拒绝 原因」即结，只认本人，回复不交给 agent。

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
