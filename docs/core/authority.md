# AuthorityManager — 权限系统

管理用户权限等级、Owner 识别和高危操作确认。

**源码**: `packages/core/src/authority.ts`

## 权限等级

| 等级 | 角色 | 说明 |
|---|---|---|
| 0 | 匿名用户 | 无指令权限 |
| 1 | 普通用户 | 默认等级（`defaultAuthority`） |
| 2 | 管理员 | 可执行 /grant 等管理指令 |
| 5 | Owner | 可执行 dangerous 操作 |

### 权限判定优先级

1. Owner 列表（配置文件 `owners`）→ 返回 `ownerAuthority`
2. WebUI console 用户（platform=webui, userId=console）→ 恒为 Owner
3. 持久化记录（`data/users.json`）
4. 默认等级（`defaultAuthority`，默认 1）

## 高危操作确认

### 流程

```
confirmDangerous(request)
  │
  ├─ 检查白名单: isDangerousAllowed(name) → 已在白名单且未过期 → 通过
  │
  ├─ 查找平台确认处理器: confirmHandlers[platform]
  │     └─ 如无处理器 → 拒绝
  │
  ├─ 调用 handler(request) → 用户交互式确认
  │     └─ CLI: 终端提示 Y/N
  │     └─ WebUI: WebSocket 推送确认请求
  │
  └─ 确认通过 → 加入白名单（含有效期）
```

### DangerousConfirmRequest

```typescript
interface DangerousConfirmRequest {
  name: string;                 // 操作名
  type: 'command' | 'tool';
  args?: Record<string, unknown>;
  sessionId: string;
  platform: string;
}
```

## 关键方法

```typescript
// 获取权限
authority.getAuthority('onebot', '123456')  // → number

// 设置权限（会持久化）
authority.setAuthority('onebot', '123456', 2)

// 检查是否为 Owner
authority.isOwner('webui', 'console')  // → true

// 注册平台确认处理器
authority.setConfirmHandler('cli', async (req) => {
  // 显示确认提示，等待用户输入
  return userConfirmed;
});

// 列出所有已设权限的用户
authority.listUsers()
// → [{ platform: 'onebot', userId: '123', authority: 2 }]

// 持久化
authority.save()  // → data/users.json
authority.load()
```

## 数据持久化

权限数据保存在 `data/users.json`，格式：

```json
{
  "onebot:123456": 2,
  "webui:admin": 5
}
```
