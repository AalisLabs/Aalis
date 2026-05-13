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

## Agent 触发路径

**MCP 工具在 Aalis 内部就是普通工具**——没有任何特殊代码路径。一旦 plugin-mcp-client 完成 `bridgeClientToTools()` 把远端工具注册到 `ToolService`：

1. **LLM tool-calling 阶段**：agent（如 plugin-agent-default）调用 `useToolService(ctx).getDefinitions({ groups })` 拼装 `tools` 参数发给模型；MCP 工具与 `file_read` / `bash` 等本地工具混在同一个数组里返给 LLM
2. **执行阶段**：LLM 返回 `tool_call { name: 'mcp_<id>_<tool>', arguments }` → `ToolService.execute()` 找到注册的 handler → handler 内部走 MCP `client.callTool({...})` → 远端 server 返回 content → 文本化后回到 agent
3. **权限/安全**：`safety` 与 `authority` 由 server config 中按条目设置（默认 `safe` / `1`），执行前会走 Aalis 标准的 ExecutionGuard

也就是说：**agent 既不知道也不需要知道**这条工具是不是来自 MCP。配置上线后无需修改任何 agent 代码。

反向（plugin-mcp-server）同理：外部 Claude Desktop / Cursor 通过 SSE 看到的就是符合 MCP 规范的 `tools/list` 与 `tools/call`，背后是 Aalis ToolService 的过滤视图。

## 配置示例

详见各插件 README：
- [packages/plugin-mcp-client/README.md](../packages/plugin-mcp-client/README.md)
- [packages/plugin-mcp-server/README.md](../packages/plugin-mcp-server/README.md)

## 测试与验证

集成测试位于 [test/plugins/mcp.test.ts](../../test/plugins/mcp.test.ts)，使用 SDK 自带的 `InMemoryTransport.createLinkedPair()` 在同进程内拉起一对联通的 client/server，**无需子进程**即可端到端覆盖：

- mcp-server：`buildMcpServer` 通过 in-memory transport 返回工具列表、调用工具、过滤 dangerous
- mcp-client：`bridgeClientToTools` 将远端工具按 `mcp_<id>_<tool>` 命名注册到 ToolService、callTool 链路透传

两个内部 helper 均显式 export 以便测试与第三方扩展复用。
