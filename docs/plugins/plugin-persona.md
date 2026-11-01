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
    platform: optional(platform),
    storage: optional(storage),
    sessionManager: optional(sessionManager),
    sessionFields: optional(sessionFields),
    document: optional(ownHostConfig),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `statePersistence` | boolean | `false` | 状态持久化：启用后，角色状态（心情、当前行为等 outputFormat 字段）会在同一会话内延续并注入到下一轮提示中 |
| `timeInjection` | boolean | `true` | 时间注入：启用后，当前时间会自动注入到系统提示中 |
| `timeZone` | string | `''` | 时区 (IANA)：例如 Asia/Shanghai、Europe/London、America/New_York。留空使用系统本地时区。只管模型看到的当前时间；给人看的时间一律按服务进程的时区 |
| `persona` | select | `'default'` | 人设：角色卡名，可选项来自 `listModels()`，可以写列表里没有的卡（找不到时用主卡）；可按会话设，1 级能改 |
| `systemPromptExtra` | textarea | `''` | 额外提示：追加在人设提示之后、结构化输出格式说明之前；可按会话设，只有 owner 能改 |
| `disableOutputFormat` | boolean | `false` | 不用结构化输出：回复纯文本；可按会话设，只有 owner 能改 |
| `clientSideJsonRendering` | select | `'card'` | 客户端渲染 JSON：`card` 按角色卡、`on`、`off`；可按会话设，只有 owner 能改 |

## 按会话设

后四项是可按会话覆盖的字段（[api-session-settings](../api/api-session-settings.md)），各种会话都适用：全局层就是本插件的配置（插件详情或「会话默认」的全局层改的是同一个值），也可以设到平台档、平台类型档、场所或单个会话。人设服务的方法按调用方给的会话（`PersonaSessionOptions` 的 `sessionId` 与入口平台）读它们。会话设置不在场时只取插件配置里的值。人设写成空串时回执写「无」，实际用主卡。

## 角色卡格式

人设以 YAML 文件定义，放在存储的内容目录 `self:/persona/`（`caps.storage.use.content`，即数据目录的 `self/persona`）下，目录不能配置；文件名（不含 `.yaml` / `.yml` 后缀）即会话设置 `persona` 的取值。主卡是 `default`（`default.yaml`），会话没设人设、或设的卡找不到时用它；目录里没有 `default.yaml`（或它解析失败）时，主卡是内置的默认角色。插件监听该目录（需存储支持 watch），文件变化后自动重新加载；存储提供者重启、改配置或晚于启动上线时自动重挂监听并重新扫描。

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
| `nick_name` | 昵称列表（字符串列表），供触发检测使用。各项去掉首尾空白，非字符串与空串的项丢弃；写成单个字符串时按一个昵称取；留空（`nick_name:` 后不写值，即 null）与不写相同，不告警；其它类型整项忽略，每次载入该卡记一条 warn |
| `outputFormatPrompt` | 替换默认的输出格式说明与字段说明；JSON 字段骨架仍按 `outputFormat` 自动生成。仅在定义了 `outputFormat` 时生效 |
| `outputFormatRetries` | `outputFormat` 校验失败时允许的重试次数（不含首次），缺省 `1`；`0` = 不重试，首次不合格即丢弃该回复。仅接受非负整数，其它值按未设处理 |
| `clientSideJsonRendering` | 为 `true` 时不提取回复字段，保留 JSON 由客户端渲染 |

## 结构化输出

角色卡没有 `outputFormat` 时回复照原样交出。

当角色卡定义了 `outputFormat` 时：

1. 在 system prompt 中追加 JSON 格式要求，指示 LLM 以特定 JSON 结构回复
2. 按 `replyField`（标记 `reply: true` 的字段）提取回复。角色卡设置 `clientSideJsonRendering: true`（或这个会话的「客户端渲染 JSON」设成开）时不提取回复字段，保留原始 JSON 由客户端渲染。历史里存的是规范化后的整串 JSON，解码出的回复另作为可见正文随 assistant 消息的 metadata 落库
3. 所有声明字段都必须出现且类型正确，否则要求模型重试（次数由 `outputFormatRetries` 定，缺省 1 次，`0` 表示不重试）；重试用尽则丢弃本次回复
4. 启用 `statePersistence` 时，非回复字段作为会话状态保存，下一轮注入提示
5. 当回复字段为空字符串时跳过发送

## API

- `getSystemPrompt(options?)`: 返回静态人设提示（名称、描述、性格、prompt、这个会话的额外提示 `systemPromptExtra` 及 outputFormat 格式说明），同一张卡下逐轮不变
- `getVolatilePrompt(options?)`: 返回逐轮变化的上下文，包括当前时间（`timeInjection`，时区取 `timeZone`）、当前会话环境、上一轮状态（`statePersistence`）；调用方应把它放在历史消息之后、当前用户消息之前。会话环境里的会话事实（当前平台、自己在该平台的账号、会话类型与群号）按会话管理记下的来源字段取，都取根会话的（房间里的子任务也在房间的平台、账号与聊天窗口上）：当前平台取出生平台（没有出生平台的会话取开轮那条输入的平台），会话类型写聊天窗口的类型在平台声明里的显示名（取原文，如 OneBot 的群聊、私聊、频道；没声明显示名时写类型名）；群名、群号、自己的群身份与头衔，以及按群身份判断成员的提示，只在聊天窗口记下的是多方时给（OneBot 的群与频道、第三方平台声明的多方类型），不看类型名。说话人事实（发送者 ID、昵称、群身份与头衔）取自开轮的输入，只在这一轮各条输入的说话人相同时写，几个人的话一起开的一轮不写；消息的入口平台与出生平台不同（如 owner 从 WebUI 往群里插话，回复仍发进群里）时另加一行「当前消息经 `<入口平台>` 发来」。消息上的类型名不算数，合成回合（定时、编排等）与经别的入口发来的消息同样按记下的聊天窗口，只用于提示词，不回写消息；没装会话管理、或根会话没有聊天窗口（WebUI、终端）时不写会话类型与群信息
- `getPersonaName(options?)`: 返回角色名称：按 `options` 这个会话的「人设」取卡（找不到该卡时回落主卡）
- `getNickNames(options?)`: 返回角色卡的 `nick_name` 列表，供触发检测使用；按 `options` 取卡，同上
- `listModels()`: 列出可用的人设文件供 WebUI 下拉选择

