# @aalis/api-approval

审批契约：模型发起、需要 owner 批准的操作以审批对象的形式发起、推给在场的审批面、由 owner 应答、结算后回给发起方。不含服务实现，默认实现是 `@aalis/plugin-session-server`。

## 角色

- `approvals`：服务描述符（服务名 `approvals`）。发起方调 `request(req, signal)` 等结算；审批面经绑定门面 `registerSurface(name)` 登记，随激活撤回，每个客户端 `attend` 一次，在场上报与应答都经它。
- `Approval`、`ApprovalRequest`、`ApprovalOutcome` 等：审批对象、请求与结局的类型。
- `approval:created`、`approval:settled`：审批推给审批面、结算时发出的事件。
- `sanitizeForCard(text, limit?)`：审批卡显示事实之前的清洗，各审批面共用。

## 安装

```bash
pnpm add @aalis/api-approval
```

## 使用

```ts
import { approvals, sanitizeForCard } from '@aalis/api-approval';

// uses: { approvals: optional(approvals) }
const surface = caps.approvals.registerSurface('cli');
const attendance = surface.attend({ platform: 'cli', userId: 'console' }, {
  requested: approval => showCard(sanitizeForCard(approval.facts.command ?? approval.tool, 400)),
  settled: approvalId => closeCard(approvalId),
});
attendance.presence(true);
```

详见 [docs/api/api-approval.md](../../docs/api/api-approval.md)。
