# plugin-tool-onebot — OneBot 群管/账号/历史工具

**包名**: `@aalis/plugin-tool-onebot`
**源码**: [packages/plugin-tool-onebot/src/index.ts](https://github.com/AalisLabs/Aalis/blob/main/packages/plugin-tool-onebot/src/index.ts)

## 概述

把 OneBot 协议的群管理、群信息、账号查询、特殊交互、会话历史读取，以及好友/群请求处理封装成 LLM 可调用的工具，按职责分为 `onebot-daily`、`onebot-group`、`onebot-personal` 三个工具组。

工具命名统一前缀 `onebot_*`，可在任意会话（包括 webui、其它平台）中调用——只要指定了目标 `group_id` / `user_id`。如未传入，会回退到当前 OneBot 会话上下文。三个工具组默认不对任何平台暴露，需要在 session-manager 的平台档里列出（或写 `'*'`）；`npm create aalis` 生成的配置只给 `cli` / `webui` 写了 `'*'`，接入 OneBot 后要为 onebot 平台单独列组。

## 插件声明

```typescript
export const name = '@aalis/plugin-tool-onebot'
export const inject = {
  optional: ['platform', 'session-history'],
}
```

> 工具经 `useToolService(ctx)` 注册到 `tools` 服务，分为三个工具组：`onebot-daily`（只读查询与戳一戳、好友赞）、`onebot-group`（群务管理、群打卡、审批加群申请）、`onebot-personal`（退群、删好友、处理好友申请与入群邀请）。工具只在 `ready` 时检测到 OneBot 平台才注册，否则整体跳过。

## 跨会话调用

多数群/私聊相关工具接受可选的 `group_id`（目标群号）或 `user_id`（目标 QQ 号，私聊场景）；不传时回退到当前 OneBot 会话。机器人账号 `self_id` 只在两个会话历史工具里是公开参数，其余工具按下述优先级自动确定。

解析优先级：

1. 显式传入的 `group_id` / `user_id` / `self_id`
2. 回退到当前会话的 OneBot 上下文（如果当前会话恰好是 onebot 群/私聊）
3. `self_id` 还有一层兜底：优先取任一在线 OneBot 连接的 selfId，没有在线连接时取任一已知连接的 selfId；都没有则报错。

这意味着 LLM 不需要先调 `delegate_to_session` 切到目标群再调工具——一次性把目标 ID 传进来即可。

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
| `onebot_get_msg` | 按 message_id 取原始消息 |
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

`onebot_get_session_history` 需要 [`plugin-tool-session`](plugin-tool-session.md) 提供的 `session-history` 服务（可选依赖，缺失时该工具返回错误）。

| 工具 | 说明 |
|---|---|
| `onebot_resolve_session_id` | 把（self_id, target_type, target_id）解析成 Aalis 内部 sessionId |
| `onebot_get_session_history` | 按 QQ 群/私聊号读取最近若干条历史 |

这两个工具可从任意会话调用。当调用方本身处于 OneBot 会话时，读取受下文 `sessionHistory.allow*` 配置约束；从非 OneBot 会话调用时，这些规则不参与判定。

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
| `sessionHistory.enabled` | boolean | `true` | 启用 OneBot 会话历史读取：允许按群号/QQ 号读取对应 OneBot 会话的近期历史 |
| `sessionHistory.maxLimit` | number | `100` | 单次最多读取条数上限：agent 传入的 limit 参数会被截断到该上限。 |
| `sessionHistory.defaultLimit` | number | `20` | 默认读取条数（agent 不传 limit 时）：不能超过 maxLimit。 |
| `sessionHistory.allowGroupReadPrivate` | boolean | `false` | 允许群聊读取私聊历史：在群会话中调用历史读取工具时，是否允许目标是某个私聊。 |
| `sessionHistory.allowCrossSelf` | boolean | `false` | 允许跨机器人账号读取：不同 selfId 之间跨读。多账号部署才需要。 |
| `sessionHistory.allowCrossGroup` | boolean | `true` | 允许群聊读取其他群聊历史：群会话 → 另一个群会话。默认允许（便于跨群取上下文）。 |
| `sessionHistory.allowCrossPrivate` | boolean | `false` | 允许私聊读取其他私聊历史：私聊会话 → 另一个 QQ 的私聊。默认拒绝（隐私敏感）。 |

> `allow*` 规则以访问检查器（AccessChecker）的形式注册到 `session-history` 服务，通用的 `session_get_history` 和 `onebot_get_session_history` 都会经过它；规则只在调用方处于 OneBot 会话时生效。群管理等工具不要求在目标群的会话内调用；除 `checkAdminPermission` 检查机器人在群内的角色外，插件本身不对调用者做访问控制。

## 行为说明

- **adapter 调用**：内部以合成 sessionId `onebot:<selfId>:internal:0` 调用 OneBot 适配器的 `callAction`；适配器只从 sessionId 中取 selfId 定位连接，因此与目标会话类型无关。
- **图像识别联动**：适配器缓存未命中时，`onebot_get_forward_msg` 会把转发消息中的图片交给 `media` 服务的 `describeImage`（若可用），识别结果以 `[图片: 描述]` 的形式嵌入返回文本；缓存命中时直接返回适配器缓存的原文与摘要。
- **权限预检**：禁言、全员禁言、踢人、设置群名片、改群名、设置专属头衔、设管理员这些工具会先调用 `checkAdminPermission`，检查机器人在目标群的角色（专属头衔与设管理员要求群主，禁言与踢人还会比较目标成员的角色），不满足时返回「操作失败：……」文本；取不到机器人自身成员信息时跳过检查。
