# @aalis/api-session-protocol

会话协议契约（实验性）：owner 的客户端与守护进程之间的线上格式。JSON-RPC 2.0 帧、握手、错误码，会话列表与增量、订阅与条目、回合控制、在场与审批，全部写成 zod schema，类型由 schema 推导。不含服务实现，默认实现是 `@aalis/plugin-session-server`。

## 角色

- `SESSION_PROTOCOL_VERSION`：协议版本（现为 `0.2.0`），握手时比的部分不同即断开。
- 给人看的文字字段（会话标题、场所名、分组名、通知条目的文字、原因、设置项的标签与说明等）是产出方的形状：服务端交出字符串或文字对象（`@aalis/schema-i18n` 的 `TextRef`），发出前按全局层的语言（读者是 owner 自己）渲染成字符串，日期与时间按服务进程的时区，线上一律是字符串。读线上的一方按 `Localized<…>` 读。错误帧的 `message` 只描述线上：服务端内部的 `ProtocolError` 与 `failure` 收文字对象，线上是渲染后的字符串。
- `sessionMethods` / `sessionNotifications`：方法与推送的 schema 表，服务端据它校验收到的帧，客户端照它实现。
- `RequestFrameSchema`、`ResultFrameSchema`、`ErrorFrameSchema`、`NotificationFrameSchema`，`RPC_ERROR_CODES` 与业务错误码 `ErrorCodeSchema`。
- `sessionProtocol`：服务描述符，接口为 `connect(peer, send) → { receive(frame), close() }`。传输层（WebUI 的 WebSocket 等）认证之后把连接接到这里，对端带着传输层经 `@aalis/api-approval` 登记的审批面。

标 experimental。协议号只跟协议自己的变化走，不跟包版本：没到 1.0 写成 0.x 三段，不兼容的修改升第二位，只做加法升第三位，握手比前两段；1.0 以后不兼容的修改升第一位，握手比第一段。对象 schema 不拒多余的键，旧客户端读到新加的字段照常解析。

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
