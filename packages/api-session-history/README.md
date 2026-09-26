# @aalis/api-session-history

会话历史服务契约：统一读历史入口与平台访问控制。本包由 `@aalis/api-tool-session` 改名而来，服务名 `session-history` 不变。

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
