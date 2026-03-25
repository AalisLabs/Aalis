# Misc 插件 — Persona / WebSearch / Tool Search

人设管理、网络搜索和工具搜索层。

---

## plugin-persona

角色卡/人设管理，生成系统提示词和结构化输出解析。

**包名**: `@aalis/plugin-persona`  
**源码**: `packages/plugin-persona/src/index.ts`

### 提供的能力

```typescript
provides = ['persona']
```

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `persona` | select | `default` | 人设文件名（不含后缀），支持动态列表 |
| `personasDir` | string | `data/personas` | 人设文件目录（相对路径） |

### 角色卡 YAML 格式

```yaml
name: Alice
description: 一个有自我意识的 AI 少女
prompt: |
  你是 Alice，请以 Alice 的身份与用户对话...
traits:
  - 好奇心旺盛
  - 温柔
  - 偶尔毒舌
greeting: 你好呀~
outputFormat:
  thoughts:
    description: 内心独白，用户不可见
  reply:
    description: 发送给用户的回复
    reply: true
```

### 系统提示词生成

`getSystemPrompt()` 按以下顺序拼接：

1. `你的名字是 {name}。`
2. `{description}`
3. `性格特点: {traits.join('、')}`
4. `{prompt}` — 核心行为指令
5. outputFormat 指令（如果有）

当配置了 `outputFormat` 时，追加结构化输出指令：

```
# 输出格式
你必须始终以如下 JSON 格式回复，不要输出 JSON 之外的任何内容：
{
  "thoughts": "...",  // 内心独白，用户不可见
  "reply": "..."      // 发送给用户的回复（发送给用户的回复）
}
严格遵守此格式。不要在 JSON 外包裹 markdown 代码块标记。直接输出纯 JSON。
```

### outputFormat 解析

注册 `response:before` 中间件，解析 LLM 返回的 JSON：

```
LLM原始回复                  解析流程
─────────                   ──────
'{"thoughts":"...","reply":"你好"}'
    │
    ├─ 尝试 JSON.parse
    │     ├─ 成功 → 提取 reply 字段值
    │     │     ├─ 非空字符串 → data.content = reply
    │     │     └─ 空字符串 "" → data.content = "" (静默)
    │     └─ 失败 → 保留原始内容
    │
    └─ 兼容 markdown 代码块标记 → 先 strip ```json ... ```
```

### 文件搜索顺序

1. `{cwd}/{personasDir}/{name}.yaml`
2. `{cwd}/{personasDir}/{name}.yml`
3. `{configDir}/personas/{name}.yaml`
4. `{configDir}/personas/{name}.yml`

未找到时使用内置默认角色（Aalis，友好 AI 助手）。

### PersonaService 方法

| 方法 | 返回 |
|---|---|
| `getSystemPrompt()` | 完整系统提示词 |
| `getPersonaName()` | 角色名称 |
| `getOutputFormat()` | OutputFormat 对象或 undefined |
| `listModels()` | 可用人设文件名列表（供 WebUI 选择） |

---

## plugin-websearch-serper

基于 Serper.dev 的网络搜索工具。

**包名**: `@aalis/plugin-websearch-serper`  
**源码**: `packages/plugin-websearch-serper/src/index.ts`

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | (必填) | Serper.dev API 密钥 |
| `maxPerMinute` | number | 10 | 每分钟最大搜索次数 |
| `maxPerDay` | number | 100 | 每天最大搜索次数 |
| `maxConcurrent` | number | 3 | 最大并发搜索数 |
| `defaultNumResults` | number | 5 | 默认结果条数 |

### 注册的工具

```
web_search(query: string, numResults?: number)
```

- `query`: 搜索关键词（必填）
- `numResults`: 结果数量，1-10，默认 5
- `strict: true` — 启用 JSON Schema strict 模式

### RateLimiter 类

内置三维速率限制器：

```
check() → 检测三项限制
  ├─ 并发数 ≥ maxConcurrent → 拒绝
  ├─ 分钟内调用 ≥ maxPerMinute → 拒绝
  ├─ 日内调用 ≥ maxPerDay → 拒绝
  └─ 全部通过 → 允许

acquire() → 记录时间戳 + concurrent++
release() → concurrent--
```

时间窗口基于滑动窗口（过期记录在 check 时清理）。

### 搜索结果格式化

Serper 返回的结构化数据被格式化为纯文本：

```
【直接回答】{answerBox}

【知识图谱】{knowledgeGraph.title}: {description}

【搜索结果】
1. {title}
   {link}
   {snippet}
```

### 请求超时

搜索请求使用 `AbortSignal.timeout(15000)`（15 秒固定超时）。
