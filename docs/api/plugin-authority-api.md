# plugin-authority-api — 权限校验与执行守卫契约

**包名**: `@aalis/plugin-authority-api`  
**源码**: `packages/plugin-authority-api/src/index.ts`  
**实现**: `@aalis/plugin-authority`

## 概述

定义两件事：

1. **`ExecutionGuard`** —— 跨切面守卫。`plugin-commands` 与 `plugin-tools` 在执行任何 command/tool 前调用该守卫；任何插件可通过 `setExecutionGuard()` 注入实现，统一拦截规则。
2. **`AuthorityService`** —— 用户权限等级、危险操作短时授权、平台 confirm 回调注册等。

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
  getAuthority(platform: string, userId?: string): number;
  setAuthority(platform: string, userId: string, level: number): void;
  isOwner(platform: string, userId?: string): boolean;
  isDangerousAllowed(name: string, permissions?: string[]): boolean;
  confirmDangerous(request: DangerousConfirmRequest): Promise<boolean>;
  listDangerousGrants(): DangerousGrant[];
  revokeDangerousGrant(id: string): boolean;
  setConfirmHandler(platform: string, handler: DangerousConfirmHandler): void;
  listUsers(): Array<{ platform: string; userId: string; authority: number }>;
  save(): void;
}
```

## 危险操作流程

1. command/tool 声明 `safety: 'dangerous'` 与/或 `permissions: ['xxx']`
2. 执行前 `ExecutionGuard` 判定权限不足或需二次确认 → 触发 `confirmDangerous(request)`
3. `AuthorityService` 调用平台对应的 `DangerousConfirmHandler`（adapter 提供）询问用户
4. 用户确认后可返回 `{ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }`，授权在该窗口内自动放行同名操作

## PermissionId 命名约定

- 工具：`tool:<group>.<name>`，例 `tool:file.write`
- 存储：`storage:<rootName>:<read|write|delete>`，例 `storage:workspace:write`
- 指令：默认 `command:<path>`，可在 `permissions` 字段追加业务标识

## 实现者

- [@aalis/plugin-authority](../plugins/plugin-authority.md)

## 相关

- 默认权限策略与 owner 名单存于 `data/authority.json`
- 用户身份模型（`UserIdentity` 等）也在本 api 包中定义
