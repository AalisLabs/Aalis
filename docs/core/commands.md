# CommandRegistry — 指令系统

管理指令的注册、解析、权限检查和执行。

**源码**: `packages/core/src/commands.ts`

## 指令定义

```typescript
interface CommandDefinition {
  name: string;              // 指令名
  description: string;       // 描述
  action: (ctx: CommandContext) => Promise<string | void>;
  authority?: number;        // 最低权限等级（默认 0）
  safety?: SafetyLevel;      // 'safe' | 'dangerous'
  asTools?: boolean;         // 是否暴露为 AI 工具
}
```

## 指令上下文

```typescript
interface CommandContext {
  sessionId: string;
  platform: string;
  userId?: string;
  args: string[];            // 按空格分割的参数
  raw: string;               // 原始输入文本
  skipSafetyCheck?: boolean; // 工具桥接时跳过重复确认
}
```

## 指令解析

`parseCommand(input)` 根据配置的前缀模式解析用户输入：

- **有前缀模式** (`prefix = '/'`): 匹配 `/指令名 参数...`
- **无前缀模式** (`prefix = ''`): 匹配 `指令名 参数...`（精确匹配指令名）

## 指令执行流程

```
parseCommand(input)
  │
  ▼
execute(name, cmdCtx)
  │
  ├─ 查找指令（含覆盖的权限/安全等级）
  ├─ 权限检查: authority.getAuthority() ≥ 指令要求
  ├─ 如果 safety='dangerous':
  │     authority.confirmDangerous() → 交互式确认
  └─ 调用 action(cmdCtx) → 返回结果
```

## 指令→工具桥接

当 `asTools: true`（单指令）或 `commandAsTools: true`（全局）时：

1. 指令自动注册为 AI 工具
2. 工具名: `cmd_{command_name}`
3. 参数: `{ args: string }`（工具描述内含指令说明）
4. 安全等级和权限等级继承自原指令
5. 工具执行时设置 `skipSafetyCheck=true`（安全检查已在工具层执行过）

## 覆盖系统

支持通过配置覆盖指令的权限等级和安全等级：

```yaml
commandOverrides:
  shutdown:
    authority: 3         # 降低关闭指令的权限要求
    safety: safe         # 改为安全操作（不需确认）
```

```typescript
commands.setOverride('shutdown', { authority: 3, safety: 'safe' });
commands.removeOverride('shutdown');
commands.getOverrides();
```
