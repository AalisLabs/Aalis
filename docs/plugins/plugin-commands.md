# plugin-commands — 指令系统

**包名**: `@aalis/plugin-commands`  
**源码**: `packages/plugin-commands/src/index.ts`

## 概述

内置指令注册与执行系统，支持指令前缀配置、递归子指令和声明式参数/选项解析。

## 插件声明

```typescript
meta.name = '@aalis/plugin-commands'
meta.provides = ['commands']
meta.inject = {}
```

## 内置指令

| 指令 | 说明 | 可见性 |
|---|---|---|
| `/help` | 显示帮助信息 | public |
| `/status` | 系统状态 | public |
| `/clear [--type/-t <type>]` | 清空当前会话记忆；类型可重复或逗号分隔 | public |
| `/clear list` | 列出可清理类型 | public |
| `/clear all [--type/-t <type>]` | 全局清空指定类型或全部类型 | restricted |
| `/model` | 查看或切换会话模型 | public |
| `/tools` | 列出所有 AI 工具 | public |
| `/shutdown` | 关闭应用 | restricted |
| `/restart` | 重启应用 | restricted |
| `/authority [target]` | 查看自己或指定用户的权限等级 | public |
| `/level <target> <n>` | 设置用户权限等级（整数，越大越高；0 默认，负数封禁） | restricted |
| `/auto [分钟\|off\|on]` | 自动确认模式：临时免 dangerous 二次确认（仅 owner 本人） | restricted |

## `/clear` 类型

`/clear` 通过 `memory:clear` hook 让各插件参与清理，命令插件只负责编排和基础缓存清理。可用类型：

| 类型 | 内容 |
|---|---|
| `context` | 消息历史与会话上下文 |
| `summary` | 会话摘要 |
| `vector` | 向量记忆 |
| `image` | 图片缓存 |
| `persona` | 会话角色状态 |
| `user-profile` | 用户档案，仅全局清理 |

示例：

```text
/clear
/clear --type context,summary
/clear -t vector -t image
/clear all --type user-profile
```
