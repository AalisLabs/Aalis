# Platform 插件 — CLI / WebUI / OneBot

三个平台适配器将 Aalis 连接到不同的交互渠道。

---

## plugin-cli

终端 REPL 交互界面。

**包名**: `@aalis/plugin-cli`  
**源码**: `packages/plugin-cli/src/index.ts`

### 提供的能力

```typescript
provides = ['cli', 'platform']
inject = { optional: ['llm'] }
```

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `prompt` | string | `You` | 命令行输入提示符前缀 |
| `sessionId` | string | `cli-default` | 固定 session ID |

### 工作流程

```
ready 事件
  → startREPL()
    → readline.createInterface()
    → 显示欢迎信息
    → 注册高危操作确认处理器
    → 循环:
        ← 读取用户输入
        → parseCommand() → 匹配指令则执行
        → 否则 emit message:received
```

### 特性

- **高危确认**: 注册 `cli` 平台的 confirm handler，终端提示 Y/N
- **消息输出**: 监听 `message:send` 事件，用 `chalk.green('Aalis')` 格式化输出
- **dispose**: 关闭 readline，Ctrl+C 发送 SIGINT 退出进程
- **PlatformAdapter**: 提供 `sendMessage()`、`getConnections()` 标准接口

---

## plugin-webui-server

Express + WebSocket 的 Web 管理界面后端。

**包名**: `@aalis/plugin-webui-server`  
**源码**: `packages/plugin-webui-server/src/index.ts`

### 提供的能力

```typescript
provides = ['webui-server', 'platform']
```

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `port` | number | 3000 | HTTP 端口 |
| `host` | string | `127.0.0.1` | 绑定地址（`0.0.0.0` 对外） |

### REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 系统状态（服务、工具、指令） |
| GET | `/api/plugins` | 插件列表及状态 |
| GET | `/api/config` | 全局配置 + schema |
| PUT | `/api/config` | 更新全局配置 |
| GET | `/api/plugins/:name/config` | 单个插件原始配置 |
| PUT | `/api/plugins/:name/config` | 更新插件配置 |
| POST | `/api/plugins/:name/enable` | 启用插件 |
| POST | `/api/plugins/:name/disable` | 禁用插件 |
| POST | `/api/plugins/scan` | 重新扫描并加载新插件 |
| POST | `/api/plugins/install` | 从 npm 安装插件 |
| POST | `/api/plugins/:name/uninstall` | 卸载插件 |
| POST | `/api/config/save` | 保存配置到磁盘 |
| GET | `/api/logs` | 获取历史日志 |
| GET | `/api/services` | 服务列表及提供者 |
| GET | `/api/platforms` | 平台适配器及连接状态 |
| POST | `/api/services/:name/prefer` | 切换服务偏好提供者 |
| GET | `/api/models/:service` | 获取服务可用模型列表 |
| GET | `/api/authority` | 权限概览 |
| PUT | `/api/authority/user` | 设置用户权限 |
| DELETE | `/api/authority/user` | 删除用户权限 |
| PUT | `/api/authority/owners` | 更新 owner 列表 |
| PUT | `/api/authority/dangerous` | 更新高危策略 |
| PUT | `/api/authority/config` | 更新权限配置 |
| PUT | `/api/authority/command` | 设置指令权限覆盖 |
| DELETE | `/api/authority/command` | 重置指令覆盖 |
| PUT | `/api/authority/tool` | 设置工具权限覆盖 |
| DELETE | `/api/authority/tool` | 重置工具覆盖 |

### WebSocket 协议

连接路径: `ws://{host}:{port}/ws`

#### 入站消息 (客户端 → 服务端)

```typescript
{ type: 'message', content: string, sessionId?: string }
{ type: 'subscribe_logs' }
```

#### 出站消息 (服务端 → 客户端)

| type | 字段 | 说明 |
|---|---|---|
| `message` | content, sessionId, reasoningContent | 完整消息 |
| `stream` | contentDelta, reasoningDelta, done, sessionId | 流式增量 |
| `tool_call` | toolName, toolArgs, toolPhase, toolResult, sessionId | 工具调用事件 |
| `log` | log (LogEntry) | 实时日志推送 |
| `state_changed` | — | 插件状态变更通知 |
| `restarting` | — | 应用即将重启通知 |
| `status` | status | 系统状态推送 |

### 高危操作确认

WebUI 使用**内联对话式**确认：

1. 将确认提示作为普通 `message` 发送到会话
2. 用户下一条消息会被拦截（`pendingSessionConfirms`）
3. 用户输入 `Y` → 确认，其他 → 取消
4. 60 秒超时自动取消

### 安全

- 插件安装验证 npm 包名格式（正则 `/^(@[a-z0-9\-_.]+\/)?[a-z0-9\-_.]+$/i`）
- 全局配置更新仅允许白名单字段（`name`, `logLevel`, `commandPrefix`, `commandAsTools`）
- WebUI console 用户自动识别为 Owner

---

## plugin-webui-client

前端静态文件插件，挂载 React SPA 到 webui-server。

**包名**: `@aalis/plugin-webui-client`  
**源码**: `packages/plugin-webui-client/src/index.ts`

### 依赖

```typescript
inject = { required: [{ service: 'webui-server', capabilities: ['api-v1'] }] }
provides = ['webui-client']
```

### 工作原理

通过 `webui-server` 服务的 `setClientDir()` 方法将 `client/dist` 目录挂载为 Express 静态文件目录。SPA fallback 由 server 端的 `{*path}` catch-all 路由处理。

---

## plugin-adapter-onebot

连接 QQ 机器人（通过 OneBot 协议实现端如 Lagrange / NapCat）。

**包名**: `@aalis/plugin-adapter-onebot`  
**源码**: `packages/plugin-adapter-onebot/src/`

### 提供的能力

```typescript
provides = ['platform']
inject = { optional: ['llm'] }
```

### 配置项

```yaml
plugin-adapter-onebot:
  connections:
    - url: ws://127.0.0.1:8080
      accessToken: ""
      selfId: ""              # 可选，连接后自动获取
      protocol: auto          # v11 | v12 | auto
```

### 文件结构

| 文件 | 说明 |
|---|---|
| `types.ts` | 共享类型 + `OneBotProtocol` 接口 |
| `v11.ts` | OneBotV11 协议实现 |
| `v12.ts` | OneBotV12 协议实现 |
| `index.ts` | 主入口 + 连接管理 + 协议检测 |

### 协议版本

| 特性 | V11 | V12 |
|---|---|---|
| 发送消息 | `send_private_msg` / `send_group_msg` | `send_message` |
| 获取身份 | `get_login_info` → `.user_id` | `get_self_info` → `.user_id` |
| 事件类型 | `post_type` / `message_type` | `type` / `detail_type` |
| ID 类型 | number | string |
| 版本检测 | `get_version_info` | `get_version` |

### 协议自动检测

当 `protocol: auto` 时：

```
detectProtocol(ws, conn)
  → 尝试 get_version_info (v11 API)
    → 成功 → V11
  → 尝试 get_version (v12 API)
    → 成功 → V12
  → 全部失败 → 默认 V11
```

### sessionId 格式

```
onebot:{selfId}:{detailType}:{targetId}
```

示例：
- 私聊: `onebot:12345:private:67890`
- 群聊: `onebot:12345:group:111222`
- 频道: `onebot:12345:channel:guild_id:channel_id`

### 重连机制

断开连接后 5 秒自动重连，dispose 时清理所有定时器。
