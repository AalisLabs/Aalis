# @aalis/api-trigger

触发判定契约：`trigger` 服务描述符与提供者接口 `TriggerProvider`。判定一条入站消息要不要让 agent 开口；不含实现。

## 角色

- `trigger`：多提供者服务。相位宿主 `@aalis/plugin-trigger-policy` 按 `trigger.all()` 的顺序（偏好 > 优先级 > 注册顺序）逐个调用 `decide`，第一个不弃权的提供者说了算。
- 宿主自带规则提供者（计数、评分、点名，优先级 0），它不弃权，是兜底；模型等提供者以更高优先级登记，未就绪或超时时弃权。
- 提供者只判定、不写状态：开口后的计数清零、`triggerType` 与授权主体由宿主统一写。

## 安装

```bash
pnpm add @aalis/api-trigger
```

## 提供

服务描述符：`trigger`（服务名 `trigger`）。

```ts
import { trigger } from '@aalis/api-trigger';
```

宿主与规则提供者见 `@aalis/plugin-trigger-policy`。

## 文档

详见 [docs/services/trigger.md](../../docs/services/trigger.md)。

## 许可

见仓库根目录 LICENSE。
