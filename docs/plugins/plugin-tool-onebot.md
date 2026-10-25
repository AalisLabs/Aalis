# plugin-tool-onebot — OneBot 群管/账号/历史工具

**包名**: `@aalis/plugin-tool-onebot`
**源码**: [packages/plugin-tool-onebot/src/index.ts](https://github.com/AalisLabs/Aalis/blob/main/packages/plugin-tool-onebot/src/index.ts)

## 概述

把 OneBot 协议的群管理、群信息、账号查询、特殊交互、会话历史读取，以及好友/群请求处理封装成 LLM 可调用的工具，按职责分为 `onebot-daily`、`onebot-group`、`onebot-personal` 三个工具组。

工具命名统一前缀 `onebot_*`，可在任意会话（包括 webui、其它平台）中调用——只要指定了目标 `group_id` / `user_id`。如未传入，会回退到当前 OneBot 会话上下文。三个工具组默认不对任何平台暴露，需要在 session-manager 的平台档里列出（或写 `'*'`）；`npm create aalis` 生成的配置只给 `cli` / `webui` 写了 `'*'`，接入 OneBot 后要为 onebot 平台单独列组。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-tool-onebot',
  uses: {
    tools: optional(tools),
    platform: optional(platform),
    storage: optional(storage),
    media: optional(media),
    sessionHistory: optional(sessionHistory),
    sessionManager: optional(sessionManager),
    events,
    logger,
    config,
  },
  apply(caps) { /* 见源码 */ },
});
```


> 工具经 `withToolGroups(tools, …)` 登记到 `tools` 服务，分为三个工具组：`onebot-daily`（只读查询与戳一戳、好友赞）、`onebot-group`（群务管理、群打卡、审批加群申请）、`onebot-personal`（退群、删好友、处理好友申请与入群邀请）。工具在 `app:ready` 与每次 `platform` 提供者上线时检测，出现 OneBot 平台即注册一次，平台离场不反注册；没有 OneBot 平台时不注册。

## 跨会话调用

多数群/私聊相关工具接受可选的 `group_id`（目标群号）或 `user_id`（目标 QQ 号，私聊场景）；不传时回退到当前 OneBot 会话。用到机器人账号的工具都有可选参数 `self_id`（`onebot_list_self_mutes` 汇总全部账号，没有它）：在 OneBot 会话里可以省，不在 OneBot 会话里且有多个账号时必填。

解析优先级：

1. 显式传入的 `group_id` / `user_id` / `self_id`
2. 回退到当前会话的 OneBot 上下文（如果当前会话恰好是 onebot 群/私聊）。子任务会话不算 OneBot 会话，账号不从根会话推
3. 都没有时，`self_id` 取各 OneBot 实例的已知账号（不论在不在线）：恰好一个就用它；没有则报错；多于一个时报错，列出各账号与连接状态，要求用 `self_id` 写明。

这意味着 LLM 不需要切到目标群的会话再调工具——一次性把目标 ID 传进来即可。

## 注册工具

### 群管理（`groupManagement.enabled`）

| 工具 | 说明 |
|---|---|
| `onebot_group_ban` | 禁言群成员（duration=0 解除） |
| `onebot_group_whole_ban` | 全员禁言开关 |
| `onebot_group_kick` | 踢出群成员 |
| `onebot_leave_group` | 机器人主动退群 |
| `onebot_set_group_card` | 设置群名片 |
| `onebot_set_group_name` | 修改群名 |
| `onebot_set_group_special_title` | 设置专属头衔 |
| `onebot_set_group_admin` | 设置/取消管理员 |
| `onebot_delete_msg` | 撤回消息（需 message_id，撤回他人消息需管理员） |
| `onebot_recall_self` | 撤回机器人自己最近发的消息（无需 message_id，可 count 撤回最近 N 条） |

### 群信息查询（`groupInfo.enabled`）

| 工具 | 说明 |
|---|---|
| `onebot_get_group_info` | 群基础信息 |
| `onebot_get_group_member_info` | 单个成员信息 |
| `onebot_get_group_member_list` | 群成员列表，支持关键词、角色筛选与分页 |
| `onebot_get_group_honor_info` | 群荣誉（龙王、群聊之火等） |
| `onebot_get_forward_msg` | 解析合并转发消息，可调用 `media` 服务识别其中的图片 |
| `onebot_get_msg` | 按 message_id 取原始消息；取到的消息所在的会话按会话管理的跨会话规则判，经工具调用上下文的 `approveFor` 逐个参与者判（某个参与者自己私聊里的、别人过不了的发一道参与者审批由他本人批），规则不放行时回原因，判不出对端的（她自己发的私聊消息、实现端不给群号或发送者）拒绝 |
| `onebot_get_self_mute_status` | 查询机器人在某群被禁言剩余时长 |
| `onebot_list_self_mutes` | 列出所有"我在被禁言"的群 |

### 账号与好友（`account.enabled`）

| 工具 | 说明 |
|---|---|
| `onebot_get_group_list` | 机器人加入的所有群 |
| `onebot_get_friend_list` | 好友列表 |
| `onebot_get_stranger_info` | 陌生人信息 |
| `onebot_get_login_info` | 当前账号资料 |
| `onebot_delete_friend` | 删除好友 |

### 特殊交互（`interaction.enabled`）

| 工具 | 说明 |
|---|---|
| `onebot_poke` | 戳一戳（群内或私聊） |
| `onebot_send_like` | 给好友点赞 |
| `onebot_send_group_sign` | 群打卡 |

### 会话历史（`sessionHistory.enabled`）

`onebot_get_session_history` 需要 [`plugin-tool-session`](plugin-tool-session.md) 提供的 `session-history` 服务（可选依赖，缺失时该工具报错）。

| 工具 | 说明 |
|---|---|
| `onebot_resolve_session_id` | 把（self_id, target_type, target_id）解析成 Aalis 内部 sessionId |
| `onebot_get_session_history` | 按 QQ 群/私聊号读取最近若干条历史 |

这两个工具可从任意会话调用。`onebot_resolve_session_id` 只拼会话 id、不读历史；`onebot_get_session_history` 能读哪些会话按会话管理的跨会话规则（[plugin-session-manager](./plugin-session-manager.md)），与通用的 `session_get_history` 同一条。

### 请求处理（无配置开关）

| 工具 | 说明 |
|---|---|
| `onebot_handle_friend_request` | 同意/拒绝好友申请 |
| `onebot_approve_join_request` | 同意/拒绝加群申请 |
| `onebot_handle_group_invite` | 同意/拒绝被邀请入群 |

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `groupManagement` | object | — | 群管理工具 |
| `groupManagement.enabled` | boolean | `true` | 启用群管理工具：禁言、踢人、设置群名片、撤回消息等 |
| `groupInfo` | object | — | 群信息查询 |
| `groupInfo.enabled` | boolean | `true` | 启用群信息查询：查询群/成员信息 |
| `account` | object | — | 账号与好友 |
| `account.enabled` | boolean | `true` | 启用账号与好友查询：群列表、好友列表等 |
| `interaction` | object | — | 特殊交互 |
| `interaction.enabled` | boolean | `true` | 启用特殊交互：戳一戳、群打卡等 |
| `sessionHistory` | object | — | 会话历史读取 |
| `sessionHistory.enabled` | boolean | `true` | 启用 OneBot 专属历史工具：注册 `onebot_resolve_session_id` / `onebot_get_session_history` |
| `sessionHistory.maxLimit` | number | `100` | 单次最多读取条数上限：agent 传入的 limit 参数会被截断到该上限。 |
| `sessionHistory.defaultLimit` | number | `20` | 默认读取条数（agent 不传 limit 时）：不能超过 maxLimit。 |

工具启用开关若显式给出非布尔值（如 YAML 的 `no`、带引号的 `'false'`），按表中默认值处理并告警，插件照常激活。历史条数仍按既有上下限收口。

> 群管理等工具不要求在目标群的会话内调用；除 `assertAdminPermission` 检查机器人在群内的角色外，插件本身不对调用者做访问控制。

## 行为说明

- **adapter 调用**：内部以合成 sessionId `onebot:<selfId>:internal:0` 经 `@aalis/api-platform` 的 `callPlatformAction` 发出，按 selfId 路由到账号所属的 OneBot 实例（适配器的 `canHandle`），适配器再按 selfId 定位连接，因此与目标会话类型无关。装了多个 OneBot 实例时，动作总是发到账号所在的实例。
- **结局**：失败一律报错（执行层按失败记，日志与 WebUI 的工具卡显示失败，模型拿到的是带 `error` 的结果），成功才返回结果。`onebot_recall_self` 全部撤回失败时报错，部分失败仍返回成功并列出失败项。报错只带适配器的原话，不猜原因。
- **扩展方法按实例取**：撤回自己发的消息（`onebot_recall_self`）按目标会话找到发出消息的实例；处理好友申请、加群申请与入群邀请按当前会话（或 `self_id`）的账号找到收到申请的实例，申请通知注入在收到它的账号的会话里，在那里调用即落到对的实例；`onebot_list_self_mutes` 汇总所有实例记下的自身禁言。
- **群请求认申请类型**：`onebot_approve_join_request` 只处理加群申请，`onebot_handle_group_invite` 只处理入群邀请，账号与类型一起交给适配器，对不上或没有这条申请时报错（可能已处理）。
- **换动作名只看不支持**：戳一戳的动作名各实现端不同，只在实现端回不支持该动作时才改用另一个动作名（群里 `group_poke` 之后 `send_group_poke`，私聊 `friend_poke` 之后 `send_poke`）；超时、没权限等别的错误原样报出，不换个动作再戳一次。
- **图像识别联动**：适配器缓存未命中时，`onebot_get_forward_msg` 会把转发消息中的图片交给 `media` 服务的 `describeImage`（若可用），识别结果以 `[图片: 描述]` 的形式嵌入返回文本；缓存命中时直接返回适配器缓存的原文与摘要，展开时截断过的在头一行注明「已截断（嵌套超深、节点超限）」中的对应项。
- **转发里的图从哪读**：图片段里写的只有网址与 base64 的 data URL 直接交给识图；别的（文件名、本机路径、像存储地址的串）只当 `get_image` 的 `file` 参数，读的是实现端交回的地址，换不出地址的不识别、写 `[图片]`。
- **权限预检**：禁言、全员禁言、踢人、设置群名片、改群名、设置专属头衔、设管理员这些工具会先调用 `assertAdminPermission`，检查机器人在目标群的角色（专属头衔与设管理员要求群主，禁言与踢人还会比较目标成员的角色），不满足时报错，执行层按失败记；取不到机器人自身成员信息或其中没有角色时跳过检查（真不够权限时实现端的返回码会报出来），查不到目标成员时报错带适配器的原话，实现端回成功却没给成员信息或没给角色时同样报错（写明没给的是哪样），不当成普通成员。
