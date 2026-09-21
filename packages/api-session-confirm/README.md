# @aalis/api-session-confirm

会话确认服务契约：createChannel(deliver) → {handler, feed}，让各平台复用同一套确认协调器

## 安装

```bash
pnpm add @aalis/api-session-confirm
```

## 提供

服务描述符：`sessionConfirm`（服务名 `session-confirm`）。

```ts
import { sessionConfirm } from '@aalis/api-session-confirm';
```

实现见 `@aalis/plugin-session-confirm`。

## 文档

详见 [docs/services/session-confirm.md](../../docs/services/session-confirm.md)。

## 许可

见仓库根目录 LICENSE。
