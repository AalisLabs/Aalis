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
    plugins: optional(pluginsService),
    hostConfig: optional(hostConfig),
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

条目里的 `args` 是字符串数组（schema 类型 `list`，每项一个参数，可含空格），`env` 是 `KEY: VALUE` 映射（schema 类型 `map`）。旧版 WebUI 把两者存成多行文本；遇到字符串（含空串）或其它形态时，该 server 记录警告且不启动，需按上面的示例改写。

旧版 WebUI 建的条目常带 `args: ''` / `env: ''`，请删除该键或改为 `[]` / `{}`。改写多行文本时按旧版的解析规则拆分：`args` 先按行、再按空白切分，如 `args: "-y @scope/pkg"` 应改为 `["-y", "@scope/pkg"]`；`env` 每行一条 `KEY=VALUE`，忽略 `#` 开头的注释行，值去首尾空白。

## 行为

- 每个 server 是一个独立子进程，stdio 传输。
- 工具名映射为 `mcp_<server-id>_<tool-name>`：`[a-zA-Z0-9_-]` 以外的字符替换为 `_`，连续下划线合并为一个，超过 64 字符截断（OpenAI 工具名限制）。
- 工具分组：`mcp:<server-id>` —— 可在 platform 配置中按需启用/禁用。
- `inputSchema` 顶层非 `type: 'object'` 时自动包装为 `{ input: schema }`。
- 每个 server 连接成功后，经 `lifecycle.onDispose` 注册 `client.close()`；插件关闭时断开所有已连接的 server，关闭时抛出的错误被忽略，仅记 debug 日志。
- 远端工具的返回文本经 `wrapUntrustedContent` 套上不可信内容边界；返回 `isError` 时不套边界，加 `MCP 工具返回错误:` 前缀返回。
- 插件另外注册 `mcp:_meta` 分组下的两个自服务工具：`mcp_list_servers`（public，只读列出已配置 server 的 id / command / enabled / visibility）和 `mcp_set_server_enabled`（restricted，切换已有条目的 `enabled` 并持久化，插件经 bounce 后生效）。后者先经 `plugins.updateConfig` 改运行态，成功后经 `host-config` 写配置文档并 `save()`；`plugins` 或 `host-config` 任一缺席时返回失败，不改运行态。不提供新增 server 的工具；未配置任何有效 server 时只注册这两个。

## 安全注意事项

- 外部 server 是**不受信任的第三方进程**。默认 `auto` 按注解分档、未知即 restricted（失败关闭）；
  只有确认全部工具都只读的 server，才应显式放宽为 `public`（最低等级 0）。
- Aalis 自身的能力闸仍然生效：`restricted` 工具默认要求触发者等级 >= 2，`sensitive` 工具默认要求等级 >= 1，owner 不受等级限制；等级不足时，须有临时能力委托才能放行。

## 依赖

- `@modelcontextprotocol/sdk` ^1.0.4
- `uses.tools`：required，描述符来自 `@aalis/api-tools`

## 已知限制

- 仅支持 stdio transport，SSE / HTTP client 暂未实现。
- 单个 server 连接失败不会阻止插件或 Aalis 启动，也不影响其它 server：错误只写进日志（`连接 MCP server "<id>" 失败: …`），该 server 的工具不会注册。
