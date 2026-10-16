# @aalis/api-session-protocol

会话协议契约（实验性）：owner 的客户端与守护进程之间的线上格式。JSON-RPC 2.0 帧、握手、错误码，会话列表与增量、订阅与条目、回合控制、在场与审批，全部写成 zod schema，类型由 schema 推导。不含服务实现，默认实现是 `@aalis/plugin-session-server`。

## 角色

- `SESSION_PROTOCOL_VERSION`：协议版本 `<主>.<次>`，握手时主版本不同即断开。
- 握手的 `languages`（语言链，靠前的优先）与 `timeZone`（1.1 起）：这条连接收到的文字按它们渲染，不给语言（或给的一种都不合法）时按全局默认层的设置；换语言要重连。
- 给人看的文字字段（会话标题、场所名、分组名、通知条目的文字、原因、设置项的标签与说明等）是产出方的形状：服务端交出字符串或文字对象（`@aalis/schema-i18n` 的 `TextRef`），发出前按连接的读者渲染成字符串，线上一律是字符串。读线上的一方按 `Localized<…>` 读。错误帧的 `message` 只描述线上：服务端内部的 `ProtocolError` 与 `failure` 收文字对象，线上是渲染后的字符串。
- `sessionMethods` / `sessionNotifications`：方法与推送的 schema 表，服务端据它校验收到的帧，客户端照它实现。
- `RequestFrameSchema`、`ResultFrameSchema`、`ErrorFrameSchema`、`NotificationFrameSchema`，`RPC_ERROR_CODES` 与业务错误码 `ErrorCodeSchema`。
- `sessionProtocol`：服务描述符，接口为 `connect(peer, send) → { receive(frame), close() }`。传输层（WebUI 的 WebSocket 等）认证之后把连接接到这里，对端带着传输层经 `@aalis/api-approval` 登记的审批面。

第一版标 experimental：终端客户端接入之前允许不兼容的修改，之后只做加法，加字段升次版本。

## 安装

```bash
pnpm add @aalis/api-session-protocol
```

## 使用

```ts
import { approvals } from '@aalis/api-approval';
import { sessionProtocol } from '@aalis/api-session-protocol';

// uses: { sessionProtocol: optional(sessionProtocol), approvals: optional(approvals) }
const surface = caps.approvals.use.registerSurface('webui');
const conn = caps.sessionProtocol.use.connect(
  { identity: { platform: 'webui', userId: 'console' }, surface, disconnect: reason => socket.close(1000, reason) },
  frame => socket.send(frame),
);
socket.on('message', data => void conn.receive(String(data)));
socket.on('close', () => conn.close());
```

详见 [docs/api/api-session-protocol.md](../../docs/api/api-session-protocol.md)。
