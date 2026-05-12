# MCP 接入

Aalis 既可以**作为 MCP client** 接入外部生态的工具（GitHub / Filesystem / Playwright 等），也可以**作为 MCP server** 把自身工具暴露给 Claude Desktop / Cursor 等外部 host。

两侧实现位于：

- [packages/plugin-mcp-client](../packages/plugin-mcp-client) — Aalis as client（通过 stdio 连接外部 server）
- [packages/plugin-mcp-server](../packages/plugin-mcp-server) — Aalis as server（通过 HTTP/SSE 反向暴露）

## 为什么 1:1 桥接成本极低

Aalis 内部的 `ToolService` 抽象与 MCP 协议是同构的：

| Aalis 概念                                        | MCP 概念             |
| ------------------------------------------------- | -------------------- |
| `ToolDefinition` (OpenAI shape, parameters=JSON Schema) | `tool` (inputSchema) |
| `ToolService.execute(name, args, ctx)`            | `tools/call`         |
| `RegisteredTool.safety` + `authority`             | client 侧手工管控     |
| `Context.capability` / service                    | MCP capabilities     |

因此两侧只是适配层薄壁封装（client ~200 行；server ~230 行）。

## 安全边界

- **plugin-mcp-client**：外部 server 是不受信任的第三方进程，工具的 `safety`/`authority` 由 config 中按 server 配置，**默认 `safe`**——对接 filesystem / shell 类务必显式调高
- **plugin-mcp-server**：默认 `bind: 127.0.0.1` + `allowDangerous: false`，`ListTools` 与 `CallTool` 两端都过滤 dangerous；工具执行仍走 Aalis 完整 authority guard

## 工具命名

Client 端工具名采用 `mcp_<server-id>_<tool-name>` 前缀避免冲突；非法字符（`/`、`.`）替换为 `_`；超长截断到 64 字符（OpenAI 限制）。

## 现状

- ✅ Client：stdio transport，可接 npx-style MCP server
- ✅ Server：HTTP/SSE transport，可被 Claude Desktop / Cursor 类 host 通过 SSE URL 接入
- ⏳ 未实现：Server 端的 stdio mode（需要新增独立 entry 脚本如 `bin/aalis-mcp-stdio.js`）
- ⏳ 未实现：Client 端的 SSE / HTTP transport（仅 stdio）

## 配置示例

详见各插件 README：
- [packages/plugin-mcp-client/README.md](../packages/plugin-mcp-client/README.md)
- [packages/plugin-mcp-server/README.md](../packages/plugin-mcp-server/README.md)
