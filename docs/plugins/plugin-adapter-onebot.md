# plugin-adapter-onebot — OneBot 协议适配器

**包名**: `@aalis/plugin-adapter-onebot`  
**源码**: `packages/plugin-adapter-onebot/src/`

## 概述

OneBot 协议适配器，通过 WebSocket 连接一个或多个 OneBot 实现端（如 go-cqhttp、Lagrange 等），支持 v11/v12 协议自动检测。

## 插件声明

```typescript
meta.name = '@aalis/plugin-adapter-onebot'
meta.provides = ['platform']
meta.inject = { optional: ['llm'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `connections` | array | `[]` | 连接列表（SchemaArray） |

每个连接项包含：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `url` | string | `ws://127.0.0.1:6700` | WebSocket 地址 |
| `accessToken` | string | — | 认证 token（secret） |
| `selfId` | string | — | 机器人自身 QQ 号 |
| `protocol` | select | `auto` | 协议版本: auto / v11 / v12 |

## 文件结构

| 文件 | 说明 |
|---|---|
| `index.ts` | 主入口，连接管理、事件分发、PlatformAdapter 实现 |
| `types.ts` | 类型定义、`extractText()` 工具函数 |
| `v11.ts` | OneBot v11 协议处理器 |
| `v12.ts` | OneBot v12 协议处理器 |

## 协议处理

- **v11**: `post_type`/`message_type`，ID 为 number 类型，`send_private_msg`/`send_group_msg`
- **v12**: `type`/`detail_type`，ID 为 string 类型，统一 `send_message`，支持 channel/guild
- **auto**: 根据首条事件自动检测协议版本

## sessionId 格式

```
onebot:{selfId}:{detailType}:{targetId}
```

示例: `onebot:123456:group:789012`

## 连接管理

- 支持多连接同时在线
- 自动重连机制
- Action 请求-响应（带 echo ID + 超时）
- 心跳事件处理
