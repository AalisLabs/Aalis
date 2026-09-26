# @aalis/api-flow-control

流控服务契约：会话级禁言、回复后冷却与限速硬闸。

## 安装

```bash
pnpm add @aalis/api-flow-control
```

## 提供

服务描述符：`flowControl`（服务名 `flow-control`）。

```ts
import { flowControl } from '@aalis/api-flow-control';
```

实现见 `@aalis/plugin-flow-control`。

## 文档

详见 [docs/services/flow-control.md](../../docs/services/flow-control.md)。

## 许可

见仓库根目录 LICENSE。
