# plugin-persona — 人设/角色卡

**包名**: `@aalis/plugin-persona`  
**源码**: `packages/plugin-persona/src/index.ts`

## 概述

人设（Persona）服务，从 YAML 文件读取角色卡定义，生成系统提示词。支持结构化输出格式。

## 插件声明

```typescript
meta.name = '@aalis/plugin-persona'
meta.provides = ['persona']
meta.inject = {} // 无依赖
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `persona` | select | `default` | 当前使用的人设文件名（动态选项来源: persona） |
| `personasDir` | string | `data/personas` | 人设文件目录 |

## 角色卡格式

人设以 YAML 文件定义（存放在 `personasDir` 目录下）：

```yaml
name: Alice
description: 一个友善的 AI 助手
prompt: |
  你是 Alice，一个友善、乐于助人的 AI 助手。
traits:
  - 友善
  - 专业
greeting: 你好！有什么可以帮你的吗？
outputFormat:
  fields:
    reply:
      description: 回复给用户的内容
      reply: true
    emotion:
      description: 当前的情绪状态
```

## 结构化输出

当角色卡定义了 `outputFormat` 时：

1. 在 system prompt 中追加 JSON 格式要求，指示 LLM 以特定 JSON 结构回复
2. 注册 `response:before` 中间件，解析 LLM 输出中的 JSON
3. 提取 `replyField`（标记为 `reply: true` 的字段）作为最终发送给用户的回复
4. 当回复字段为空字符串时跳过发送

## API

- `getSystemPrompt()`: 返回完整的系统提示词
- `getPersonaName()`: 返回角色名称
- `getOutputFormat()`: 返回结构化输出定义（无 outputFormat 时返回 undefined）
- `listModels()`: 列出可用的人设文件供 WebUI 下拉选择
