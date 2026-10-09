# plugin-maimai — 舞萌 DX 查分

**包名**: `@aalis/plugin-maimai`  
**源码**: `packages/plugin-maimai/src/index.ts`

## 概述

基于 maimai.lxns.net 开发者 API 的舞萌 DX 查分插件，提供指令与 Agent 工具双入口。工具经 `tools` 绑定门面登记到 `maimai` 工具组，指令经 `commands.command` 登记为 `/maimai` 及其子指令，两者调用同一组处理函数（`handleGetPlayer` / `handleGetBests` / `handleGetRecents` / `handleSearchSong` / `handleBind` / `handleUnbind`）。用户与好友码的绑定关系存放在 `memory` 服务的元数据中，命名空间为 `maimai-binding`，键为 `platform:userId`。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-maimai',
  uses: {
    tools: optional(tools),
    commands: optional(commands),
    memory: optional(memory),
    sessionManager: optional(sessionManager),
    logger,
    config,
  },
  apply(caps) { /* 见源码 */ },
});
```


## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `developerToken` | string | 必填 | 开发者 API Token：在 https://maimai.lxns.net 申请的开发者 token（secret） |
| `baseUrl` | string | `'https://maimai.lxns.net'` | API Base URL：查分器域名，一般无需修改 |
| `enableTools` | boolean | `true` | 注册 Agent 工具：为 LLM Agent 注册结构化工具（推荐保持开启） |
| `enableCommands` | boolean | `true` | 注册斜杠指令：为用户注册 /maimai 等斜杠指令 |
| `defaultBindOnPrivateChat` | boolean | `true` | 私聊缺省绑定：在 OneBot 私聊中，若调用者未绑定但其 QQ 已注册查分器账号，自动以其 QQ 查分 |

## 指令

| 指令 | 说明 |
|---|---|
| `/maimai info [target]` | 查询玩家信息 |
| `/maimai b50 [target] [--ap]` | 查询 Best 50；`--ap` 只查 AP 成绩 |
| `/maimai recent [target] [count]` | 查询最近游玩，`count` 默认 10、最多 50 |
| `/maimai song <keyword>` | 按曲名、艺术家或别名搜索曲目 |
| `/maimai bind <code>` | 绑定你的好友码 |
| `/maimai unbind` | 解绑你的好友码 |

`target` 是好友码或 `qq:QQ 号`；不写时查你绑定的好友码，开着 `defaultBindOnPrivateChat` 时 OneBot 私聊里没绑定也按你的 QQ 号查。私聊指会话管理记下的一对一聊天窗口（`originChat.multiParty` 为 false，子会话取根会话的），不看会话 id 的写法；session-manager 不在场时不这样查。裸敲 `/maimai` 回的就是 `/help maimai`。

查询失败时回复写明怎么办：查分器不认开发者凭据（HTTP 401、403）时写去检查 `developerToken`，超时或连不上时写稍后再试并带出底层原因，其余照查分器的原话。绑定与解绑分开写两种原因：没有在运行的记忆后端（写去启用一个记忆后端），会话认不出发消息的人（没有平台用户 id）。

## 相关

- 工具注册与工具组：[plugin-tools](./plugin-tools.md)
- 斜杠指令注册：[plugin-commands](./plugin-commands.md)
- 记忆服务元数据接口：[services/memory](../services/memory.md)

## 配置校验

没填 `developerToken` 时插件激活失败，报「缺少配置项 developerToken」，WebUI 把它标成待配置。显式无效的 token、地址或功能开关会报配置错误，地址格式在注册前校验。数字字符串 `timeoutMs` 按数值解析。
