# @aalis/api-trigger

触发判定契约：`trigger` 服务描述符，以及触发插件共用的宿主函数。判定一条入站消息要不要让 agent 开口的是触发插件本身，本包不含判定。

## 角色

- `trigger`：标记当前生效的触发插件。触发插件各自 `provide(trigger, 自己的实例)` 并在 `inbound:trigger` 相位挂中间件；服务胜者（偏好 > 优先级 > 注册顺序）即生效者，其余触发插件对每条消息直接放行。二选一，同一条消息只由生效者判定。
- 共用的宿主函数：`isActiveTrigger`（这次入站是否由自己判定）、`hitsMuteKeyword`、`isAddressed`、`waitForAttachmentDescriptions`、`markTriggered`、`archiveSwallowed`。

## 安装

```bash
pnpm add @aalis/api-trigger
```

## 提供

服务描述符：`trigger`（服务名 `trigger`），服务接口 `TriggerService`（`{ readonly label: string }`）。

```ts
import { trigger } from '@aalis/api-trigger';
```

触发插件：规则判定 `@aalis/plugin-trigger-policy`；模型判定 `@aalis/plugin-trigger-laya`（仓库内私有插件，不发布到 npm）。

## 文档

详见 [docs/services/trigger.md](../../docs/services/trigger.md)。

## 许可

见仓库根目录 LICENSE。
