# plugin-mcp-client — MCP 协议客户端桥

**包名**: `@aalis/plugin-mcp-client`
**源码**: `packages/plugin-mcp-client/src/index.ts`

## 概述

作为 [MCP (Model Context Protocol)](https://modelcontextprotocol.io) **client**，通过 stdio 连接外部 MCP server（如 `@modelcontextprotocol/server-github`、`server-filesystem`、`server-playwright` 等），把这些 server 暴露的 tools 注册进 Aalis 的 `ToolService`，供 agent 直接调用外部工具。

总体架构与定位见 [docs/plugins/mcp.md](mcp.md)。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-mcp-client',
  uses: {
    tools,
    logger,
    lifecycle,
    config,
    hostConfig: optional(hostConfig),
    webui: optional(webuiServer),
  },
  apply(caps) { /* 见源码 */ },
});
```


## 配置

```yaml
plugins:
  "@aalis/plugin-mcp-client":
    servers:
      - id: github
        command: npx
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxx"
        enabled: true            # 可省略，默认 true
        visibility: auto         # auto | public | sensitive | restricted（默认 auto，按工具注解分档）

      - id: fs
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
        visibility: restricted   # 文件系统访问视为受限，须被 owner/委托授予
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `servers` | array | `[]` | MCP 服务器列表：通过 stdio 连接的 MCP 服务器。每条目至少需要 id 与 command；安全级别按需调整。 |

条目里的 `args` 是字符串数组（schema 类型 `list`，每项一个参数，可含空格或为空串），`env` 是 `KEY: VALUE` 映射（schema 类型 `map`），两者中不加引号的有限数字按字符串处理。

`env` 声明了 `secret: true`，每个 server 的整份 `env` 算一个密钥：Node 宿主把它移进家目录的 `secrets.yaml`，配置文件里只留引用（第一个键是 `@aalis/plugin-mcp-client.servers.env`，其后的依次加 `-2`、`-3`；空的 `env` 不算密钥，原样留着），WebUI 不回显变量名与值，要改就整份重填。token 等凭据放进 `env`，不要写进 `args`：连接成功时的日志会写出 `command` 与全部 `args`。存放规则见 [运行态与配置文档](../core/config.md#密钥配置)。

条目按 schema 逐项解析，问题都记录警告：

- 缺少 `id` 或 `command`（含空串），或其中之一只有空白的条目跳过，其它 server 不受影响。`id` 与 `command` 去掉首尾空白后使用。
- `command` 写命令名（按 PATH 查找）或绝对路径（schema 声明 `format: 'executable'`）。写法判定忽略首尾空白：带前导空格的绝对路径照常通过，去掉空白后使用；写成相对路径的条目跳过并告警，其它 server 照常工作。`args` 原样传给命令，参数里的文件路径请写绝对路径：宿主进程的 cwd 不带语义。
- 缺省的 `args` / `env` 分别补 `[]` / `{}`；显式给出错误形态，或数组、映射中有不能转换为字符串的成员时，整条 server 跳过，绝不截短参数后启动。
- `visibility` 不是四个取值之一、`enabled` 不是布尔值时，整条 server 跳过。

旧版 WebUI 把 `args` / `env` 存成多行文本；该 server 不会启动，需按示例改写：`args` 先按行、再按空白切分，如 `args: "-y @scope/pkg"` 应改为 `["-y", "@scope/pkg"]`；`env` 每行一条 `KEY=VALUE`，忽略 `#` 开头的注释行，值去首尾空白。旧版条目常带的 `args: ''` / `env: ''` 也要删除该键或改为 `[]` / `{}`。

## 行为

- 每个 server 是一个独立子进程，stdio 传输。
- 工具名映射为 `mcp_<server-id>_<tool-name>`：`[a-zA-Z0-9_-]` 以外的字符替换为 `_`，连续下划线合并为一个，超过 64 字符截断（OpenAI 工具名限制）。
- 工具分组：`mcp:<server-id>` —— 可在 platform 配置中按需启用/禁用。
- `inputSchema` 顶层非 `type: 'object'` 时自动包装为 `{ input: schema }`。
- 某个 server 连不上（握手或列工具失败）时记一行 error 日志（`连接 MCP server "<id>" 失败: …`），并经 `webuiServer` 发一条 `level: 'error'` 的提示：id 为 `connect:<server-id>`，标题「MCP 服务器「<id>」连不上」，`detail` 是失败原因，跳转「去配置」。提示出现在 WebUI 的「需要处理」与本插件的详情里；它归属这次激活，改好配置后插件重载，旧提示随之撤回，新的激活连上了就不再发。连接只在激活时做一次，没有自动重连。WebUI 服务端不在时只记日志。
- 启动时的握手与列工具在停用或停机时中止，中止不记连接失败，也不发提示。每个 server 连接成功后，经 `lifecycle.onDispose` 注册 `client.close()`；插件关闭时断开所有已连接的 server，关闭时抛出的错误被忽略，仅记 debug 日志。
- 远端工具的返回文本经 `wrapUntrustedContent` 套上不可信内容边界；返回 `isError` 时不套边界，加 `MCP 工具返回错误:` 前缀返回。
- 插件另外注册 `mcp:_meta` 分组下的两个自服务工具：`mcp_list_servers`（public，只读列出有效 server 的 id / command / enabled / visibility）和 `mcp_set_server_enabled`（restricted，切换列表中已有条目的 `enabled` 并持久化，插件经 bounce 后生效）。后者以插件在配置文档里的原配置为底，只改目标条目的 `enabled`（`env` 的引用原样交回，密钥不变），经 `host-config` 的 `applyPluginConfig` 一步改运行态、写文档并落盘；`host-config` 缺席时返回失败，不改运行态；插件停机中或正在卸载、运行态不受理时返回失败，配置不变。落盘失败（如配置文件有尚未生效的外部修改而拒写）时运行态已经切换、插件照常 bounce，返回的文本注明这一点与写入失败的原因：配置文件里仍是原值，重启或配置重新载入后可能回退（拒写时配置重新载入以文件为准；其它写入错误时改动仍留在配置文档里，之后别处保存成功会一并写进文件）。不提供新增 server 的工具；未配置任何有效 server 时只注册这两个。

## 安全注意事项

- 外部 server 是**不受信任的第三方进程**。默认 `auto` 按注解分档、未知即 restricted（失败关闭）；
  只有确认全部工具都只读的 server，才应显式放宽为 `public`（最低等级 0）。
- Aalis 自身的能力闸仍然生效：`restricted` 工具默认要求触发者等级 >= 2，`sensitive` 工具默认要求等级 >= 1，owner 不受等级限制；等级不足即拒。

## 依赖

- `@modelcontextprotocol/sdk` ^1.29.0
- `uses.tools`：required，描述符来自 `@aalis/api-tools`
- `uses.webui`：optional，描述符来自 `@aalis/api-webui`，用来发连不上的提示

## 已知限制

- 仅支持 stdio transport，SSE / HTTP client 暂未实现。
- 单个 server 连接失败不会阻止插件或 Aalis 启动，也不影响其它 server：错误写进日志并发提示（见「行为」），该 server 的工具不会注册。已连上的 server 中途断开时不发提示，它的工具调用回失败原因；重载插件后重新连接。
