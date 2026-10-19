# @aalis/plugin-chat-approval

聊天审批：受众只有 owner 的 IM 私聊作审批面（契约见 `@aalis/api-approval`）。owner 在与她的 IM 私聊里亲手发言即在场，在这个私聊里发起的审批推回这里，owner 引用那条审批消息回复「同意」或「拒绝 原因」即结，回复不交给 agent。只认适配器明确声明为一对一的窗口；群里与别人的私聊不推。

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
