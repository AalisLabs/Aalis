# plugin-authority-api — 权限校验与执行守卫契约

**包名**: `@aalis/plugin-authority-api`  
**源码**: `packages/plugin-authority-api/src/index.ts`  
**实现**: `@aalis/plugin-authority`

## 概述

定义三件事：

1. **`AuthorityService.authorize`** —— capability 统一闸。任何 surface（tool /
   command / WebUI action / REST / scheduler）的敏感操作在边界过同一裁决：
   `deny > owner(*) > public > granted(restricted)`（逐能力）。
   模型详见 [docs/core/authority.md](../core/authority.md)。
2. **`ExecutionGuard`** —— tools/commands surface 的适配器。`plugin-commands` 与 `plugin-tools` 在执行前调用；裁决委托 authorize，受限被拒后的临时委托确认留在适配层。
3. **账户与身份** —— `UserIdentity`（全 surface 统一身份类型）、密码凭据（WebUI 登录）、受限能力的临时委托、平台 confirm 回调注册。

## 关键类型

```ts
type CapabilityId = string;                       // 例: "tool:file.write" / "storage:path:data:/users.json:write"
type CapabilityVisibility = 'public' | 'restricted'; // 操作默认可见性

interface ExecutionGuardContext {
  name: string;
  type: 'command' | 'tool';
  visibility: CapabilityVisibility;               // 主能力默认可见性（操作声明；未标默认 public）
  permissions?: CapabilityId[];                   // 额外触达的资源能力（可见性由 restrictedCapabilities 决定）
  sessionId: string;
  platform: string;
  userId?: string;
  args?: Record<string, unknown>;
  skipConfirm?: boolean;                          // 受信系统源（scheduler）：仍走 authorize，仅跳过交互确认弹窗，不绕过授权
}

type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<string | null>;
// 返回 null 放行；返回字符串表示拦截原因（会回复给用户）
```

## 服务接口

```ts
interface AuthorityService {
  // 是否 owner（owners 配置命中 → 拥有 `*`）
  isOwner(platform: string, userId?: string): boolean;

  // capability 统一闸：null 放行 | string 拒绝原因
  authorize(
    identity: UserIdentity | { platform: string; userId?: string },
    request: AuthorizeRequest, // { capability, visibility, resourceCapabilities? }
  ): string | null;

  // 委托（子集约束）：granter 非 owner 时只能授予自己持有的能力，越权抛 Error；
  // granter 为 null 表示系统/owner 上下文。记录 grantedBy 形成委托树。
  setUserCapabilities(granter: UserIdentity | null, target: UserIdentity, caps: UserCapabilityOverrides): void;
  removeUser(platform: string, userId: string): void;
  listDelegatees(granter: UserIdentity | null): AuthorityUserEntry[]; // owner 传 null 列顶层

  // 受限能力的临时委托
  requestAccess(request: AccessRequest): Promise<boolean>;
  listTemporaryGrants(): TemporaryGrant[];
  revokeTemporaryGrant(id: string): boolean;
  setConfirmHandler(platform: string, handler: AccessConfirmHandler): void;

  // 密码凭据（WebUI 登录，PBKDF2-SHA256）
  setPassword(platform: string, userId: string, password: string): Promise<void>;
  verifyPassword(platform: string, userId: string, password: string): Promise<boolean>;
  hasPassword(platform: string, userId: string): boolean;

  // 跨平台身份绑定（运行时零合并 + 绑时一次性合并，详见 docs/core/authority.md）
  createBindCode(platform: string, userId: string): { code: string; expiresAt: number };
  consumeBindCode(code: string, identity: UserIdentity): UserIdentity;
  unlinkIdentity(platform: string, userId: string): boolean;

  listUsers(): AuthorityUserEntry[]; // { platform, userId, isOwner, grant?, deny?, grantedBy?, hasPassword?, links?, linkedTo? }
  save(): void;
}
```

## 受限能力临时委托流程

1. command/tool 声明 `visibility: 'restricted'`，与/或 `permissions: ['xxx']`（资源能力）
2. 执行前 `ExecutionGuard` 委托 authorize；命中未授予的 restricted 能力被拒 → 触发 `requestAccess(request)`
3. 临时委托流程：`restrictedPolicy` 白名单 → 会话内临时授予复用（按 sessionId 隔离）→ 平台 `AccessConfirmHandler`（adapter 提供）询问用户
4. owner 确认后可返回 `{ allowed: true, grant: { scope: 'session', durationSeconds: 600, maxUses } }`，在该会话窗口内自动放行同名能力

## CapabilityId 命名约定

- 工具：`tool:<group>.<name>`，例 `tool:file.write`
- 存储：`storage:<rootName>:<read|write|delete>`；路径级（动态）`storage:path:<uri>:<op>`
- 指令：默认 `command:<path>`，可在 `permissions` 字段追加业务标识
- WebUI action：`action:<plugin>:<method>`（page-action 路由自动产出）
- WebUI REST：`webui:<area>:<op>`（webui-server gate.ts 产出）

## 配置字段（declaration merging 注入 `AalisConfig`）

- `owners?: UserIdentity[]` —— owner 列表（owner = `*`）
- `restrictedCapabilities?: string[]` —— 命中即默认 restricted（内置保护 + 本清单叠加）
- `deniedCapabilities?: string[]` —— 全局硬禁用（连 owner 都压过）
- `visibilityOverrides?: Record<string, CapabilityVisibility>` —— 单操作可见性覆盖
- `restrictedPolicy?: { allow?: string[]; duration?: number }` —— 受限能力临时放行策略

## 实现者

- [@aalis/plugin-authority](../plugins/plugin-authority.md)

## 相关

- 权限数据（grant / deny / grantedBy / 密码凭据）存于 `data/users.json`（v3 格式，无 `level`）
- 用户身份模型 `UserIdentity` 在本 api 包中定义，是全 surface 统一的调用者身份类型
  （WebUI action 的 caller 第三参、scheduler actor 快照等均为该类型）
