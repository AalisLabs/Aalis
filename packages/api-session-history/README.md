# @aalis/api-session-history

会话历史服务契约：统一的读历史入口，能读哪些会话按会话管理的规则（`@aalis/api-session-manager` 的 `takeFrom`）。本包由 `@aalis/api-tool-session` 改名而来，服务名 `session-history` 不变。

## 安装

```bash
pnpm add @aalis/api-session-history
```

## 提供

服务描述符：`sessionHistory`（服务名 `session-history`）。

```ts
import { sessionHistory } from '@aalis/api-session-history';
```

实现见 `@aalis/plugin-tool-session`。

## 文档

详见 [docs/services/tool-session.md](../../docs/services/tool-session.md)。

## 许可

见仓库根目录 LICENSE。
