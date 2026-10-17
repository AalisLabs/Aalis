# @aalis/api-approval

审批契约：模型发起、需要 owner 批准的操作以审批对象的形式发起、推给在场的审批面、由 owner 应答、结算后回给发起方。不含服务实现，默认实现是 `@aalis/plugin-session-server`。

## 角色

- `approvals`：服务描述符（服务名 `approvals`）。发起方调 `request(req, signal)` 等结算；审批面经绑定门面 `registerSurface(name)` 登记，随激活撤回，每个客户端 `attend` 一次，在场上报与应答都经它。
- `Approval`、`ApprovalRequest`、`ApprovalOutcome` 等：审批对象、请求与结局的类型。
- `approval:created`、`approval:settled`：审批推给审批面、结算时发出的事件。
- `sanitizeForCard(text)`：审批卡显示事实之前的清洗，各审批面共用；`clipForCard(text, limit)` 清洗并截断，交出开头、结尾与中间省略的字数，「省略 N 字」由审批面按读者语言写。
- 应答被拒（`ApprovalResponse` 的 `ok: false`）时 `message` 是给应答人看的原因，可以是文字对象（`@aalis/schema-i18n`），审批面按读者语言渲染。

## 安装

```bash
pnpm add @aalis/api-approval
```

## 使用

```ts
import { approvals, clipForCard } from '@aalis/api-approval';
// 审批面自己的字典（@aalis/schema-i18n 的 defineTexts），「省略 N 字」整句在那里
import { t } from './texts.js';

// uses: { approvals: optional(approvals) }
const surface = caps.approvals.use.registerSurface('cli');
const attendance = surface.attend({ platform: 'cli', userId: 'console' }, {
  requested: approval => {
    const { head, omitted, tail } = clipForCard(approval.facts.command ?? approval.tool, 400);
    // render：按读者语言把文字对象渲染成字符串
    showCard(omitted === 0 ? head : `${head}${render(t('charsOmitted', { count: omitted }))}${tail}`);
  },
  settled: approvalId => closeCard(approvalId),
});
attendance.presence(true);
```

详见 [docs/api/api-approval.md](../../docs/api/api-approval.md)。
