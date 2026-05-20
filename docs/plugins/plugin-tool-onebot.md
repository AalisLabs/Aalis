# plugin-tool-onebot — OneBot 群管/账号/历史工具

**包名**: `@aalis/plugin-tool-onebot`
**源码**: [packages/plugin-tool-onebot/src/index.ts](../../packages/plugin-tool-onebot/src/index.ts)

## 概述

把 OneBot 协议的群管理、群信息、账号查询、特殊交互、会话历史读取，以及好友/群请求处理统一封装成 LLM 可调用的 daily 工具。

工具命名统一前缀 `onebot_*`，可在任意会话（包括 webui、其它平台）中调用——只要指定了目标 `group_id` / `user_id`。如未传入，会回退到当前 OneBot 会话上下文。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tool-onebot'
meta.inject = {
  required: ['platform', 'authority'],
  optional: ['session-history', 'persona', 'tool-manager'],
}
```

> 工具集会被注册到 daily ToolService（即 `getService<ScopedToolService>('tools:daily')`），由 plugin-agent-default 等消费方按需公开给 LLM。

## 跨会话调用心智模型（重要）

所有群/私聊相关工具都接受**可选**的目标参数：

- `group_id`：目标 QQ 群号
- `user_id`：目标 QQ 号（私聊场景）
- `self_id`：机器人账号（多账号部署时使用）

解析优先级：

1. 显式传入的 `group_id` / `user_id` / `self_id`
2. 回退到当前会话的 OneBot 上下文（如果当前会话恰好是 onebot 群/私聊）
3. `self_id` 还会再兜底一次：任取一个在线的 OneBot 适配器

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
| `onebot_delete_msg` | 撤回消息（message_id） |
| `onebot_send_group_sign` | 群打卡 |

### 群信息查询（`groupInfo.enabled`）

| 工具 | 说明 |
|---|---|
| `onebot_get_group_info` | 群基础信息 |
| `onebot_get_group_member_info` | 单个成员信息 |
| `onebot_get_group_member_list` | 全员列表 |
| `onebot_get_group_honor_info` | 群荣誉（龙王、群聊之火等） |
| `onebot_get_forward_msg` | 解析合并转发消息，可联动 image-recognition 识图 |
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

### 会话历史（`sessionHistory.enabled`）

依赖 [`plugin-tool-session`](plugin-tool-session.md) 提供的 `session-history` 服务。

| 工具 | 说明 |
|---|---|
| `onebot_resolve_session_id` | 把（self_id, target_type, target_id）解析成 Aalis 内部 sessionId |
| `onebot_get_session_history` | 按 QQ 群/私聊号读取最近若干条历史 |

这两个工具与上面的群/私聊工具一致，可从任意会话调用，但仍受用户级权限开关约束（见下）。

### 请求处理

| 工具 | 说明 |
|---|---|
| `onebot_handle_friend_request` | 同意/拒绝好友申请 |
| `onebot_approve_join_request` | 同意/拒绝加群申请 |
| `onebot_handle_group_invite` | 同意/拒绝被邀请入群 |

## 配置

```yaml
'@aalis/plugin-tool-onebot':
  groupManagement: { enabled: true }
  groupInfo:       { enabled: true }
  account:         { enabled: true }
  interaction:     { enabled: true }
  sessionHistory:
    enabled: true
    maxLimit: 100          # 单次最多条数硬上限
    defaultLimit: 20       # agent 不传 limit 时的默认值
    allowGroupReadPrivate: false   # 群会话 → 读某人私聊
    allowCrossSelf: false          # 跨机器人账号
    allowCrossGroup: true          # 群 → 别的群
    allowCrossPrivate: false       # 私聊 → 别人的私聊
```

> `allow*` 是用户级权限开关，由 sessionHistory 工具与 session-history 服务执行，不会被 LLM 绕过。群管理等工具本身没有"必须在当前群"的会话级闸门——访问控制完全交给上层 authority/persona。

## 行为说明

- **adapter 调用**：内部通过合成 sessionId `onebot:<selfId>:internal:0` 调 OneBot 适配器；adapter 只用 selfId 定位连接，因此不会污染目标会话的消息上下文。
- **图像识别联动**：`onebot_get_forward_msg` 会自动把转发消息里的图片喂给 `image-recognition` 服务（若可用），把识别结果嵌入返回的文本。
- **权限提示**：群管理工具（禁言、踢人、设管理员等）会调用 `checkAdminPermission` 校验机器人在目标群是否具备相应权限，并在失败时返回明确的 `error` 字段。
