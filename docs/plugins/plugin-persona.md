# plugin-persona — 人设/角色卡

**包名**: `@aalis/plugin-persona`  
**源码**: `packages/plugin-persona/src/index.ts`

## 概述

人设（Persona）服务，从 YAML 文件读取角色卡定义，生成系统提示词。支持结构化输出格式。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-persona',
  provides: [persona],
  uses: {
    provide,
    config,
    logger,
    events,
    hooks,
    lifecycle,
    platform: optional(platform),
    storage: optional(storage),
    sessionManager: optional(sessionManager),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `persona` | select | `'default'` | 人设：人设文件名（不含后缀） |
| `personasDir` | string | `'data/personas'` | 人设目录：存放人设文件的目录路径（相对于项目根目录） |
| `statePersistence` | boolean | `false` | 状态持久化：启用后，角色状态（心情、当前行为等 outputFormat 字段）会在同一会话内延续并注入到下一轮提示中 |
| `timeInjection` | boolean | `true` | 时间注入：启用后，当前时间会自动注入到系统提示中 |
| `timeZone` | string | `''` | 时区 (IANA)：例如 Asia/Shanghai、Europe/London、America/New_York。留空使用系统本地时区。 |

## 角色卡格式

人设以 YAML 文件定义，文件名（不含 `.yaml` / `.yml` 后缀）即 `persona` 配置值。插件先查 `personasDir`；存储中存在 `configDir` 根时，再查 `configDir:/personas`。找不到指定人设时使用内置默认角色。插件监听上述目录（需存储支持 watch），文件变化后自动重新加载。

```yaml
name: Alice
description: 一个友善的 AI 助手
prompt: |
  你是 Alice，一个友善、乐于助人的 AI 助手。
traits:
  - 友善
  - 专业
outputFormat:
  reply:
    description: 回复给用户的内容
    reply: true
  emotion:
    description: 当前的情绪状态
```

`outputFormat` 的每个键即一个输出字段，可选 `type`（`string` / `number` / `boolean`，缺省 `string`）；必须有一个字段标记 `reply: true`，否则整个 `outputFormat` 视为未定义。

其它可选字段：

| 字段 | 说明 |
|---|---|
| `nick_name` | 昵称列表，供触发检测使用 |
| `skills` | 可用 skill 白名单；缺省不限制，空数组表示禁用全部 skill |
| `outputFormatPrompt` | 替换默认的输出格式说明与字段说明；JSON 字段骨架仍按 `outputFormat` 自动生成。仅在定义了 `outputFormat` 时生效 |
| `outputFormatRetries` | `outputFormat` 校验失败时允许的重试次数（不含首次），缺省 `1`；`0` = 不重试，首次不合格即丢弃该回复。仅接受非负整数，其它值按未设处理 |
| `clientSideJsonRendering` | 为 `true` 时不提取回复字段，保留 JSON 由客户端渲染 |

## 结构化输出

插件始终注册 `agent:reply:before` 中间件。没有 `outputFormat` 时，若回复以 `{` 开头且能解析为 JSON 对象，则依次取 `response` / `reply` / `content` / `answer` / `text` / `msg` / `message` 中第一个字符串字段作为回复。

当角色卡定义了 `outputFormat` 时：

1. 在 system prompt 中追加 JSON 格式要求，指示 LLM 以特定 JSON 结构回复
2. 按 `replyField`（标记 `reply: true` 的字段）提取回复；若该字段缺失，先按 `response` / `reply` / `content` / `answer` / `text` / `msg` 别名回退，再退到唯一的字符串字段。角色卡设置 `clientSideJsonRendering: true`（或会话配置如此覆盖）时不提取回复字段，保留原始 JSON 由客户端渲染
3. 所有声明字段都必须出现且类型正确，否则要求模型重试（次数由 `outputFormatRetries` 定，缺省 1 次，`0` 表示不重试）；重试用尽则丢弃本次回复
4. 启用 `statePersistence` 时，非回复字段作为会话状态保存，下一轮注入提示
5. 当回复字段为空字符串时跳过发送

## API

- `getSystemPrompt(options?)`: 返回静态人设提示（名称、描述、性格、prompt 及 outputFormat 格式说明），同一张卡下逐轮不变
- `getVolatilePrompt(options?)`: 返回逐轮变化的上下文，包括当前时间（`timeInjection`，时区取 `timeZone`）、当前会话环境、上一轮状态（`statePersistence`）；调用方应把它放在历史消息之后、当前用户消息之前
- `getPersonaName()`: 返回角色名称
- `getOutputFormat(options?)`: 返回生效角色卡的结构化输出定义；角色卡没有 outputFormat、没有字段标记 `reply: true`，或会话设置了 `disableOutputFormat` 时返回 undefined
- `isClientSideJsonRendering(options?)`: 返回是否由客户端渲染 JSON；会话选项优先于角色卡设置
- `getNickNames()`: 返回角色卡的 `nick_name` 列表，供触发检测使用
- `getPersonaSkills(options?)`: 返回角色卡的 `skills` 白名单；未声明时返回 undefined
- `isTimeInjectionEnabled()`: 返回是否启用时间注入，供其它插件判断是否需要注册时间相关工具
- `getSessionState(sessionId)`: 返回该会话最近一次保存的结构化输出状态（仅 `statePersistence` 启用时有值）
- `listModels()`: 列出可用的人设文件供 WebUI 下拉选择
