# @aalis/api-session-protocol

会话协议契约（实验性）：owner 的客户端与守护进程之间的线上格式。JSON-RPC 2.0 帧、握手、错误码，会话列表与增量、订阅与条目、回合控制，全部写成 zod schema，类型由 schema 推导。不含服务实现，默认实现是 `@aalis/plugin-session-server`。

## 角色

- `SESSION_PROTOCOL_VERSION`：协议版本 `<主>.<次>`，握手时主版本不同即断开。
- `sessionMethods` / `sessionNotifications`：方法与推送的 schema 表，服务端据它校验收到的帧，客户端照它实现。
- `RequestFrameSchema`、`ResultFrameSchema`、`ErrorFrameSchema`、`NotificationFrameSchema`，`RPC_ERROR_CODES` 与业务错误码 `ErrorCodeSchema`。
- `sessionProtocol`：服务描述符，接口为 `connect(peer, send) → { receive(frame), close() }`。传输层（WebUI 的 WebSocket 等）认证之后把连接接到这里。

第一版标 experimental：终端客户端接入之前允许不兼容的修改，之后只做加法，加字段升次版本。

## 安装

```bash
pnpm add @aalis/api-session-protocol
```

## 使用

```ts
import { sessionProtocol } from '@aalis/api-session-protocol';

// uses: { sessionProtocol: optional(sessionProtocol) }
const conn = caps.sessionProtocol.require().connect(
  { identity: { platform: 'webui', userId: 'console' }, surface: 'webui', disconnect: reason => socket.close(1000, reason) },
  frame => socket.send(frame),
);
socket.on('message', data => void conn.receive(String(data)));
socket.on('close', () => conn.close());
```

详见 [docs/api/api-session-protocol.md](../../docs/api/api-session-protocol.md)。
