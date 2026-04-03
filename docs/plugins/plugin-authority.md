# plugin-authority — 权限管理系统

**包名**: `@aalis/plugin-authority`  
**源码**: `packages/plugin-authority/src/index.ts`

## 概述

基于角色的权限管理系统，管理用户权限等级、高危操作时限白名单和平台级确认处理器。

## 插件声明

```typescript
meta.name = '@aalis/plugin-authority'
meta.provides = ['authority']
meta.inject = {}
```

## 权限等级

| 等级 | 角色 | 说明 |
|---|---|---|
| 0 | 默认 | 未注册用户 |
| 1 | 普通用户 | 配置中 `defaultAuthority` |
| 2 | 管理员 | 可执行 `/grant` 等管理指令 |
| 5 | Owner | 最高权限（`ownerAuthority`，可配置） |

## 高危操作白名单

标记为 `safety: 'dangerous'` 的工具或指令执行时：

1. 检查用户权限 ≥ 要求等级
2. 检查时限白名单（`isDangerousAllowed`）
3. 未在白名单 → 向平台发送确认请求
4. 用户确认后加入临时白名单（含有效期）
5. 执行操作

每个平台（CLI / WebUI / OneBot）有独立的 `confirmHandler` 实现，适配各自的交互方式。
