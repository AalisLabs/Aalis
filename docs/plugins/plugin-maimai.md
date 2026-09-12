# plugin-maimai — 舞萌 DX 查分

**包名**: `@aalis/plugin-maimai`  
**源码**: `packages/plugin-maimai/src/index.ts`

## 概述

基于 maimai.lxns.net 开发者 API 的舞萌 DX 查分插件，提供指令与 Agent 工具双入口。工具经 `useToolService` 注册到 `maimai` 工具组，指令经 `useCommandService` 注册为 `/maimai` 及其子指令，两者调用同一组处理函数（`handleGetPlayer` / `handleGetBests` / `handleGetRecents` / `handleSearchSong` / `handleBind`），解绑则都直接清除绑定记录。用户与好友码的绑定关系存放在 `memory` 服务的元数据中，命名空间为 `maimai-binding`，键为 `platform:userId`。未配置 `developerToken` 时插件只输出一条警告，不注册任何工具或指令。

## 插件声明

```typescript
meta.name = '@aalis/plugin-maimai'
meta.subsystem = 'skills'
meta.inject = {}
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `developerToken` | string | `''` | 开发者 API Token：在 https://maimai.lxns.net 申请的开发者 token，必须配置（secret） |
| `baseUrl` | string | `'https://maimai.lxns.net'` | API Base URL：查分器域名，一般无需修改 |
| `enableTools` | boolean | `true` | 注册 Agent 工具：为 LLM Agent 注册结构化工具（推荐保持开启） |
| `enableCommands` | boolean | `true` | 注册斜杠指令：为用户注册 /maimai 等斜杠指令 |
| `defaultBindOnPrivateChat` | boolean | `true` | 私聊缺省绑定：在 OneBot 私聊中，若调用者未绑定但其 QQ 已注册查分器账号，自动以其 QQ 查分 |

## 相关

- 工具注册与工具组：[plugin-tools](./plugin-tools.md)
- 斜杠指令注册：[plugin-commands](./plugin-commands.md)
- 记忆服务元数据接口：[services/memory](../services/memory.md)
