# plugin-authority-api — 权限校验与执行守卫契约

**包名**: `@aalis/plugin-authority-api`  
**源码**: `packages/plugin-authority-api/src/index.ts`  
**实现**: `@aalis/plugin-authority`

## 概述

定义三件事：

1. **`AuthorityService.authorize`** —— capability 统一闸。任何 surface（tool /
   command / WebUI action / REST / scheduler）的敏感操作在边界过同一裁决：
   permissionPolicy > 用户 deny > 用户 grant > 角色链等级门槛（per-capability）。
   模型详见 [docs/core/authority.md](../core/authority.md)。
2. **`ExecutionGuard`** —— tools/commands surface 的适配器。`plugin-commands` 与 `plugin-tools` 在执行前调用；裁决委托 authorize，dangerous 确认留在适配层。
3. **账户与身份** —— `UserIdentity`（全 surface 统一身份类型）、密码凭据（WebUI 登录）、危险操作短时授权、平台 confirm 回调注册。

## 关键类型

```ts
type PermissionId = string; // 例: "tool:file.write" / "storage:workspace:read"

interface ExecutionGuardContext {
  name: string;
  type: 'command' | 'tool';
  authority: number;
  safety: SafetyLevel;
  permissions?: PermissionId[];
  sessionId: string;
  platform: string;
  userId?: string;
  args?: Record<string, unknown>;
  skipSafetyCheck?: boolean;
}

type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<string | null>;
// 返回 null 放行；返回字符串表示拦截原因（会回复给用户）
```

## 服务接口

```ts
interface AuthorityService {
  // capability 统一闸：null 放行 | string 拒绝原因
  authorize(identity: { platform: string; userId?: string }, request: AuthorizeRequest): string | null;
  getAuthority(platform: string, userId?: string): number;
  setAuthority(platform: string, userId: string, level: number): void;
  isOwner(platform: string, userId?: string): boolean;
  requiredAuthorityFor(permissions: string[]): number;       // 参数级动态提权
  setUserCapabilities(platform: string, userId: string, o: UserCapabilityOverrides): void;
  removeUser(platform: string, userId: string): void;
  setPassword(platform: string, userId: string, password: string): Promise<void>;
  verifyPassword(platform: string, userId: string, password: string): Promise<boolean>;
  hasPassword(platform: string, userId: string): boolean;
  isDangerousAllowed(name: string, permissions?: string[]): boolean;
  confirmDangerous(request: DangerousConfirmRequest): Promise<boolean>;
  listDangerousGrants(): DangerousGrant[];
  revokeDangerousGrant(id: string): boolean;
  setConfirmHandler(platform: string, handler: DangerousConfirmHandler): void;
  listUsers(): AuthorityUserEntry[]; // { platform, userId, authority, grants?, denies?, hasPassword? }
  save(): void;
}
```

## 危险操作流程

1. command/tool 声明 `safety: 'dangerous'` 与/或 `permissions: ['xxx']`
2. 执行前 `ExecutionGuard` 判定权限不足或需二次确认 → 触发 `confirmDangerous(request)`
3. `AuthorityService` 调用平台对应的 `DangerousConfirmHandler`（adapter 提供）询问用户
4. 用户确认后可返回 `{ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }`，授权在该窗口内自动放行同名操作

## PermissionId（capability）命名约定

- 工具：`tool:<group>.<name>`，例 `tool:file.write`
- 存储：`storage:<rootName>:<read|write|delete>`；路径级（动态）`storage:path:<uri>:<op>`
- 指令：默认 `command:<path>`，可在 `permissions` 字段追加业务标识
- WebUI action：`action:<plugin>:<method>`（page-action 路由自动产出）
- WebUI REST：`webui:<area>:<op>`（webui-server gate.ts 产出）

## 实现者

- [@aalis/plugin-authority](../plugins/plugin-authority.md)

## 相关

- 权限数据（等级 / grants / denies / 密码凭据）存于 `data/users.json`（v2 格式）
- 用户身份模型 `UserIdentity` 在本 api 包中定义，是全 surface 统一的调用者身份类型
  （WebUI action 的 caller 第三参、scheduler actor 快照等均为该类型）
