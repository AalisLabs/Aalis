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

## REST API

- **系统**: 状态查询
- **插件管理**: 列表、启用/禁用、配置读写、安装/卸载、扫描
- **全局配置**: 读写
- **权限管理**: 用户列表、owner 设置、指令/工具覆盖
- **服务**: 列表、能力查询
- **平台**: 连接状态
- **模型**: 列表（LLM / Embedding / Persona）
- **日志**: 历史查询

## WebSocket

- 实时聊天（含高危操作确认流程）
- 流式回复增量推送
- 工具调用事件推送
- 日志实时推送

## 前端挂载

前端静态文件由 `plugin-webui-client` 通过 `setClientDir()` 方法挂载到 Express。
