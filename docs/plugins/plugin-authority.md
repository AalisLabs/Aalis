# plugin-authority — 权限管理系统

**包名**: `@aalis/plugin-authority`  
**源码**: `packages/plugin-authority/src/index.ts`

## 概述

基于「纯能力委托」的权限管理系统：用能力（capability）+ 默认可见性（public/restricted）+ 委托加减替代数字等级。管理 owner、能力委托树、受限能力的临时委托与平台级确认处理器。

## 插件声明

```typescript
meta.name = '@aalis/plugin-authority'
meta.provides = ['authority']
meta.inject = {}
```

## 能力模型

- **owner** = 能力 `*`，拥有一切、可委托一切。`config.owners`（`UserIdentity[]`）列出 owner 身份；webui/cli 的 `console` 恒为 owner。
- 每条能力有默认**可见性**：`public`（所有人默认拥有，除非被 deny）或 `restricted`（默认禁止，须被授予）。类型 `CapabilityVisibility`。
- 用户有效能力 = owner ? 全部 : (所有 public ∪ 被授予的 restricted) − 被禁用的。
  优先级：**deny > owner(`*`) > public > granted**（deny 连 owner 都压过）。
  纯判定逻辑见 `packages/plugin-authority/src/capability-model.ts` 的 `hasCapability`。

## 能力委托（委托树）

`setUserCapabilities(granter, target, { grant?, deny? })` —— grant/deny 为 glob 列表（覆盖式）：

- `grant`：授予的 restricted 能力（委托加）。
- `deny`：禁用的能力（委托减，最高优先）。
- 非 owner 授予方只能授予「自己当前持有」的能力（子集约束，越权抛 `越权` 错误）。
- `grantedBy` 记录委托父，形成委托树（孙 ⊆ 子 ⊆ owner）。
- `listDelegatees(granter | null)` 列出某授予方直接委托的下层用户（owner 传 `null` 列顶层）。

## 配置项

- `config.owners`（`UserIdentity[]`）：owner 身份列表。
- `config.restrictedCapabilities`（glob 列表）：额外视为 restricted 的能力，叠加在内置之上。
- `config.deniedCapabilities`（glob 列表）：全局硬禁用，命中即拒，连 owner 都压过。
- `config.visibilityOverrides`（操作名 → public/restricted）：owner 临时把某操作放开/收紧，无需改插件声明。
- `config.restrictedPolicy`（`{ allow?, duration? }`）：受限能力的临时放行策略（时限白名单）。

### 内置受限能力（`BUILTIN_RESTRICTED`）

无需配置即默认 restricted，仅 owner 或被授予者可触达：

- 写 / 删 `data:/users.json`
- 写 / 删 `data:/scheduler-jobs.json`
- 写 / 删 `aalis:` 源码根

## 临时能力委托

当用户触达「未被授予的 restricted 能力」时，`requestAccess` 依次尝试：

1. `restrictedPolicy` 时限白名单（`{ allow?, duration? }`）：命中即放行。
2. 会话内临时授予复用（按 `sessionId` 限定，**不跨会话泄漏**）。
3. 确认回调（`AccessConfirmHandler`）：owner 审批，可返回会话级临时授予（带 `durationSeconds` / `maxUses`）。

相关类型：请求 `AccessRequest`、决策 `AccessDecision { allowed, grant? }`、范围 `TemporaryGrantSpec { scope: 'once' | 'session', durationSeconds?, maxUses? }`。
管理：`listTemporaryGrants()` / `revokeTemporaryGrant(id)`。

每个平台（CLI / WebUI / OneBot）通过 `setConfirmHandler(platform, handler)` 注册独立确认回调，适配各自的交互方式。

## 用户数据（users.json v3）

```jsonc
{
  "version": 3,
  "users": {
    "<platform>:<userId>": {
      "caps": { "grant": ["..."], "deny": ["..."] },
      "grantedBy": "webui:admin",
      "secret": "...",   // PBKDF2-SHA256 密码凭据（Web Crypto）
      "links": ["..."]
    }
  }
}
```

无 `level` 字段。迁移策略为**全新开始**：非 v3 文件直接丢弃，不做 v1/v2 → v3 迁移。
