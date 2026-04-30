# plugin-skills — AI 技能库系统

**包名**: `@aalis/plugin-skills`  
**源码**: `packages/plugin-skills/src/index.ts`

## 概述

AI 可自主学习和管理的技能系统。技能以 YAML 格式存储，支持模板参数化（`{{param}}` 语法），可在 `agent:llm:before` 钩子中自动注入相关技能到上下文。

## 插件声明

```typescript
meta.name = '@aalis/plugin-skills'
meta.inject = { optional: ['llm'] }
```

## 限制

| 限制 | 值 |
|---|---|
| 最大技能数量 | 100 |
| 单技能最大字符数 | 10,000 |

## 注册工具

| 工具 | 说明 |
|---|---|
| `create_skill` | 创建新技能 |
| `update_skill` | 更新已有技能 |
| `delete_skill` | 删除技能 |
| `search_skills` | 搜索技能库 |

## 工作方式

1. AI 通过工具管理技能 CRUD
2. 技能存储在 `data/skills/` 目录下的 YAML 文件中
3. `agent:llm:before` 钩子自动将相关技能注入为 system 消息
4. 技能模板支持 `{{param}}` 参数替换，从工具调用参数中取值
