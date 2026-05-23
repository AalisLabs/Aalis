# plugin-webui-server — WebUI 服务端

**包名**: `@aalis/plugin-webui-server`  
**源码**: `packages/plugin-webui-server/src/index.ts`

## 概述

Express + WebSocket 实现的 Web 管理后台和聊天平台，提供完整的 REST API 和实时 WebSocket 通信。

## 插件声明

```typescript
meta.name = '@aalis/plugin-webui-server'
meta.provides = ['webui-server', 'platform']
meta.inject = {} // 无依赖
```

注册能力: `webui-server` 带 `api-v1`, `platform` 带 `web`

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `port` | number | 3000 | HTTP 监听端口 |
| `host` | string | `127.0.0.1` | HTTP 监听地址 |
| `tokenMode` | `ephemeral` \| `persist` \| `fixed` | `persist` | 访问 token 策略，详见下方"认证" |
| `fixedToken` | string | `''` | tokenMode=fixed 时使用；为空时降级为 persist |
| `autoOpen` | boolean | true | 启动时自动打开浏览器到访问 URL |

## 认证 / 访问 token

WebUI 通过短 token + HttpOnly cookie 完成认证；所有 HTTP/WebSocket 都走相同闭包内的常量校验，没有"一次性"语义——**同一进程内任意多个用户/浏览器都可以反复用同一个 token 登录**。

### tokenMode 三种模式

| 模式 | token 生命周期 | 文件 |
|---|---|---|
| `ephemeral` | 每次进程启动随机生成，重启失效 | 仅写出 `data:/webui/access.txt` |
| `persist`（默认） | 首次生成后写入 `data:/webui/token`，重启沿用 | 同时写出 `data:/webui/access.txt` |
| `fixed` | 来自配置 `fixedToken`，不变；空则降级 persist | 同上 |

### 访问凭据文件

- **URI**: `data:/webui/access.txt`
- **物理路径**: `<storage root>/webui/access.txt`，启动日志 `访问凭据已写入: ... （绝对路径: ...）` 直接给出
- **内容**: 注释 + `URL:` + `Token:` + `一键登录:`（带 `?token=` 的完整 URL）

> ⚠️ 不要再读历史路径 `data/webui-access.txt`，已被 `data/webui/access.txt` 取代。

### 登录方式

1. **一键登录 URL**：浏览器打开 `http://host:port/?token=<TOKEN>` → 服务端校验后 `Set-Cookie` 并 302 到干净 URL。
2. **手动登录**：访问 `http://host:port/`，在登录页粘贴 token → POST `/api/auth/login` `{ token }`。
3. **登出**：POST `/api/auth/logout` 清除 cookie。

### Cookie

- 名称：`aalis_webui_token`
- 属性：`HttpOnly; SameSite=Strict; Path=/; Max-Age=30d`
- 进程重启且 tokenMode=ephemeral 时 cookie 自动失效。

### 自动打开浏览器

`autoOpen=true` 时通过 `ProcessService.spawn('open'|'cmd /c start'|'xdg-open', [accessUrl], { detached:true, stdio:'ignore' })` 后 `unref()` 启动系统默认浏览器，跨平台失败静默。

## REST API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/status` | GET | 系统状态、服务可用性、上传能力检测 |
| `/api/plugins` | GET | 插件列表（含状态、配置、Schema、错误信息） |
| `/api/pages` | GET | 所有激活插件注册的 WebUI 页面（按 order 排序） |
| `/api/page-action/:plugin/:method` | POST | 动态调用插件页面处理器（统一 RPC 入口） |
| `/api/config` | GET/PUT | 全局配置读写（安全字段 + 重启检测） |
| `/api/authority` | — | 权限管理（用户列表、owner 设置） |
| `/api/services` | GET | 服务列表与能力查询 |
| `/api/platforms` | GET | 平台连接状态 |
| `/api/models` | GET | 模型列表（LLM / Embedding / Persona） |
| `/api/logs` | GET | 历史日志查询 |

## WebSocket

### 入站消息类型 (Client → Server)

| 类型 | 说明 |
|---|---|
| `message` | 用户发送聊天消息 |
| `subscribe_logs` | 订阅实时日志推送 |
| `subscribe_session` | 订阅指定会话更新 |
| `unsubscribe_session` | 取消会话订阅 |
| `abort` | 中断当前生成 |

### 出站消息类型 (Server → Client)

| 类型 | 说明 |
|---|---|
| `message` | 完整消息推送 |
| `stream` | 流式增量推送（contentDelta / reasoningDelta） |
| `stream_resume` | 页面刷新后恢复中断的流（累积缓冲内容） |
| `status` | 系统状态更新 |
| `tool_call` | 工具调用开始/结束事件 |
| `state_changed` | 插件/服务状态变化 |
| `sessions_changed` | 会话列表更新 |
| `todo_updated` | 待办事项变化 |
| `restarting` | 应用即将重启通知 |
| `reload` | 前端应重新加载 |
| `confirm` | 高危操作确认请求 |
| `log` | 实时日志推送 |

## 流式缓冲管理

服务端为每个会话维护流式缓冲 `streamBuffers`，存储累积的 `content`、`reasoningContent` 和 `generating` 状态。当客户端断线重连（页面刷新）后，通过 `stream_resume` 消息恢复已产生但未收到的内容，实现无缝续流。

## 前端挂载

前端静态文件由 `plugin-webui-client` 通过 `setClientDir()` 方法挂载到 Express。
