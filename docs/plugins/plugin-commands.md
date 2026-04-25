# plugin-commands — 指令系统

**包名**: `@aalis/plugin-commands`  
**源码**: `packages/plugin-commands/src/index.ts`

## 概述

内置指令注册与执行系统，支持指令前缀配置和指令→工具自动桥接。

## 插件声明

```typescript
meta.name = '@aalis/plugin-commands'
meta.provides = ['commands']
meta.inject = { required: ['authority'] }
```

## 内置指令

| 指令 | 说明 | 权限 |
|---|---|---|
| `/help` | 显示帮助信息 | 0 |
| `/status` | 系统状态 | 0 |
| `/clear [scope]` | 清空记忆（子指令：context/summary/vector/image/nuke） | 0 |
| `/model` | 查看或切换会话模型 | 0 |
| `/tools` | 列出所有 AI 工具 | 0 |
| `/shutdown` | 关闭应用 | 5 (dangerous) |
| `/restart` | 重启应用 | 5 (dangerous) |
| `/grant` | 设置用户权限 | 2 |
| `/authority` | 查看权限等级 | 0 |

## 指令→工具桥接

当 `commandAsTools: true` 时：
- 指令自动暴露为 AI 工具，工具名格式 `cmd_{command_name}`
- AI 可在对话中主动调用指令
- 安全等级和权限等级继承自原指令
