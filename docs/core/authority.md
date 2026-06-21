# 权限系统 — 纯能力委托图

管理调用者身份、capability 裁决、账户登录与受限操作的临时委托。

**源码**: `packages/plugin-authority/src/index.ts`（实现）/ `packages/plugin-authority-api/src/index.ts`（契约）
纯判定逻辑见 `packages/plugin-authority/src/capability-model.ts`，策略层见 `authority-manager.ts`。

> 2026-06 模型重写：**取消数字等级与角色链**，改为纯能力委托图。每个 capability 有默认
> 可见性 `public`/`restricted`；用户有效能力 = owner ? 全部 : (所有 public ∪ 被授予的
> restricted) − 被禁用的。委托遵循子集约束（孙 ⊆ 子 ⊆ owner），天然防越权。

## capability 词汇

capability 即细粒度能力标识（`CapabilityId`，glob，`*` 通配任意字符段），现有词汇族：

| 形状 | 产出者 | 示例 |
|---|---|---|
| `tool:<name>` | 工具注册自动生成 + 声明 | `tool:file.write` |
| `command:<name>` | 指令注册自动生成 | `command:shutdown` |
| `action:<plugin>:<method>` | WebUI page-action 路由 | `action:@aalis/plugin-skills:reload` |
| `webui:<area>:<op>` | WebUI REST 路由闸（gate.ts） | `webui:config:write` |

## owner 与可见性

- **owner = `*`**（拥有一切，可委托一切）。判定见 `authority-manager.ts` `isOwner`：
  `config.owners`（`UserIdentity[]`）命中即 owner；且 `webui` / `cli` 的 `console`
  身份恒为 owner（单 token / 单终端语义——持有即等同控制服务器）。
- 每个操作声明默认**可见性**：`public`（默认所有人拥有，除非被 deny）或
  `restricted`（默认禁止，须被 owner / 上层委托授予），类型 `CapabilityVisibility`。
- 某 capability 是否属 restricted，由其所在工具/指令声明的 `visibility` 决定；
  owner 可经 `config.visibilityOverrides`（操作名 → public/restricted）临时调整。

## 裁决：authorize 统一闸

任何 surface（tool / command / WebUI action / REST / scheduler）的敏感操作在边界统一调用：

```typescript
authority.authorize(identity, { capability, visibility })
// → null 放行 | string 拒绝原因
```

逐能力裁决，**优先级**：

```
deny  >  owner(*)  >  public  >  granted(restricted)
```

1. `config.deniedCapabilities`（glob）命中即拒——**连 owner 都压过**（系统级硬禁用，慎用）。
2. 用户 **deny** 命中即拒（对 owner 同样生效，可临时收回某能力）。
3. owner → 放行。
4. 该能力 `public` → 放行。
5. 该能力 `restricted` 且被 grant 命中 → 放行；否则拒绝（提示「需授予后使用」）。

能力按 `request.visibility`（已应用 `visibilityOverrides`）判可见性。

`ExecutionGuard` 是 tools/commands surface 的适配器：`plugin-commands` / `plugin-tools`
执行前调用，裁决全部委托 authorize；受限被拒后的交互确认（临时委托）留在适配层。
守卫**永远先跑 authorize**——`skipConfirm`（受信系统源如 scheduler）只跳过交互确认弹窗，
**不**绕过 authorize（防提权）。

**可视化**：WebUI 权限页以委托树展示 owner → 子 → 孙的授予关系，逐用户看 grant/deny
与绑定身份。

## 委托（子集约束）

```typescript
authority.setUserCapabilities(granter, target, { grant?, deny? });
// grant/deny 为 glob 列表（覆盖式）；两表皆空则清记录
```

- `granter` 为 `null` 表示系统/owner 上下文（不校验）。
- `granter` 非 owner 时受**子集约束**：只能授予「自己当前有效持有」的能力，越权抛
  `Error`（message 含「越权」可回显，被拒项见 `rejectedDelegations`）。单调递减，
  孙 ⊆ 子 ⊆ owner，天然防越权放大。
- 记录 `grantedBy = granter 身份键`，形成委托树（`listDelegatees` 按 grantedBy 展开；
  owner 传 `null` 列顶层非 owner 用户）。

owner 可经 `config.visibilityOverrides`（操作名 → `public`/`restricted`）临时把某操作
放开或收紧，无需改插件声明。

## 账户与 WebUI 登录

账户 = 带密码凭据的用户记录（`setPassword` / `verifyPassword` / `hasPassword`，
Web Crypto PBKDF2-SHA256，凭据存 users.json、永不经 API 返回）。

WebUI 双模式登录（`plugin-webui-server/src/auth.ts`）：

- **账户登录**：username/password → 内存 session + HttpOnly cookie，身份 `webui:<username>`；
  连续失败 5 次锁定 60s
- **单 token 模式**（向后兼容）：访问 token → 身份 `webui:console`（owner 语义——
  token 存于服务器磁盘/启动日志，持有 token ≈ 控制服务器 ≈ owner，信任映射诚实）
- **多用户收口**：`tokenMode: disabled` 时，只要存在任一带密码的 webui 账户，token
  登录全面失效（cookie / `?token=` / 登录表单均拒）；无账户时 token 仍兜底生效（防锁死）

REST 路由经 `gate.ts` 按 `gate(capability, visibility)` 过 authorize 闸；可对单个账户
grant `webui:files:read` 这类细粒度放行。`/api/auth/me` 返回 `{ identity, isOwner }`
（无数字等级）。

## 跨平台身份绑定

把外部平台身份（如 `onebot:12345`）绑定到 WebUI 主账户，证明"同一自然人"，
权限随账户走。语义与依据见
[multiuser-identity-survey](../architecture/multiuser-identity-survey.md)（2026-06-13 调研决议）。

- **流程**：WebUI 登录 → 权限页"绑定平台身份"生成 8 位码（一次性、5 分钟、
  重复生成作废旧码）→ 用外部平台账号**私聊** bot 发送 `/bind <码>`（非私聊
  拒绝，防码泄露）→ 绑定成立。解绑：权限页 ×，或 owner 代解。
- **运行时零合并**：被绑身份的 grant 直接以主账户记录为单一真源解析；
  deny 取自身 ∪ 账户并集（防"绑定洗白封禁"）。
- **绑定时一次性合并**：平台身份原记录的 grant/deny 并入账户；
  原记录留底不动，解绑即还原。
- 一个平台身份至多绑一个账户；webui/cli 身份不可被绑定。

## 临时能力委托（受限能力的时限/限次放行）

用户触达**未被授予的 restricted 能力**时，`ExecutionGuard` 调用 `requestAccess` 走临时委托流程：

```
requestAccess(request)
  ├─ ① restrictedPolicy 白名单（config.restrictedPolicy.allow glob + duration 时限，
  │     markPolicyEnabled 记起点）→ 通过
  ├─ ② 会话内临时授予复用（按 capability + sessionId 匹配——
  │     一次会话的临时批准不跨会话泄漏）→ 通过
  ├─ ③ 平台确认处理器 confirmHandlers[platform]（CLI 终端 Y/N、WebUI 弹窗）→ 交互确认
  │     owner 批准可返回 { allowed: true, grant: { scope:'session', durationSeconds, maxUses } }
  │     建立会话内临时授予
  └─ 无处理器 → 拒绝
```

`listTemporaryGrants` / `revokeTemporaryGrant` 查看/撤销生效中的临时委托。临时授予
时长上限 3600s，且随进程态存活（重启即失效）。

## 数据持久化（users.json v3）

```json
{
  "version": 3,
  "users": {
    "qq:789": { "caps": { "grant": ["tool:file.*"], "deny": ["tool:shell.*"] }, "grantedBy": "webui:alice" },
    "webui:alice": { "caps": { "grant": ["webui:*"] }, "secret": "pbkdf2:<iter>:<salt>:<hash>", "links": ["onebot:123456"] }
  }
}
```

- 无 `level` 字段；能力委托在 `caps.{grant,deny}`，委托父在 `grantedBy`。
- **迁移策略：clean slate**——非 v3 文件直接丢弃，不做 v1/v2 → v3 迁移。

## 关键方法速览

```typescript
authority.isOwner('onebot', '123456');                       // → boolean（owner = `*`）
authority.authorize({ platform, userId }, { capability: 'tool:x', visibility: 'restricted' });
authority.setUserCapabilities(granter, target, { grant: ['tool:file.*'], deny: [] }); // 委托（子集约束）
authority.listDelegatees(granter);                           // 委托树展开（owner 传 null）
authority.removeUser('qq', '789');                           // 整条记录删除
await authority.setPassword('webui', 'alice', pw);           // 账户凭据
await authority.verifyPassword('webui', 'alice', pw);
authority.requestAccess(accessRequest);                      // 受限能力临时委托流程
authority.listTemporaryGrants();                             // 生效中的临时委托
authority.listUsers();  // → [{ platform, userId, isOwner, grant?, deny?, grantedBy?, hasPassword?, links?, linkedTo? }]
authority.save();       // 落盘 data:/users.json（v3）
```
