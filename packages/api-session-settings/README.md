# @aalis/api-session-settings

会话设置契约：插件配置字段可按会话覆盖的声明、层表、按会话读的读取器与 session-settings 服务描述符。不含服务实现。

## 角色

- 声明：在 configSchema 的顶层字段上写 `session`（`appliesTo`、`prominence`，可选 `narrowest`、`order`、`dependsOn`、`unset`、`minLevel`、`preference`），这一项即可按会话覆盖。宿主不把它交给插件的运行态配置（`caps.config` 里没有），改了不重载插件。
- 层（后面的压过前面的）：全局（插件配置）› 平台档 › 平台类型档 › 场所 › 本会话。要对所有群生效的设置按平台分别设在平台类型档。层表是 `SESSION_LAYERS`，解析是纯函数 `resolveFields`。
- `sessionFields`：读取门面。插件在 apply 里调 `fields(configSchema, caps)` 拿读取器，调用路径上 `get(sessionId, { platform })` 读生效值；读取器的 `set` 只写本实例、本会话层。会话设置缺席时只取全局层，插件配置里的值照常生效。
- `sessionSettings`：管理面，只给会话服务与建子会话的插件：各层的行、写入、可设的层、写过的各处、建子会话时并进 metadata 的 `childMetadata`，以及以给定身份写本会话层的 `setAs`。
- `'session-settings:changed'` 事件：宿主文档以外的设置变了（场所与会话记录上的值、字段登记增减、会话增删）。宿主文档的变化另有 `host-config:changed`。

## 安装

```bash
pnpm add @aalis/api-session-settings
```

## 使用

```ts
import { ownHostConfig } from '@aalis/api-host-config';
import { sessionFields } from '@aalis/api-session-settings';
import { config, definePlugin, optional } from '@aalis/core';
import { defineConfig } from '@aalis/schema-config';

const configSchema = defineConfig({
  greeting: {
    type: 'string',
    label: 'Greeting',
    default: 'hello',
    session: { appliesTo: ['owner', 'room', 'task'], prominence: 'common', minLevel: 1 },
  },
});

export default definePlugin({
  name: 'aalis-plugin-example',
  configSchema,
  uses: { sessionFields: optional(sessionFields), document: optional(ownHostConfig), config },
  apply(caps) {
    const fields = caps.sessionFields.use.fields(configSchema, caps);
    // 回合里：fields.get(message.sessionId, { platform: message.platform }).greeting
  },
});
```

## 许可

见仓库根目录 LICENSE。
