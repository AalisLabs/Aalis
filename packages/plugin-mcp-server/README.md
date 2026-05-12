# plugin-mcp-server

把 Aalis 注册的 tools 通过 [MCP (Model Context Protocol)](https://modelcontextprotocol.io) 协议**反向暴露**给外部 client（Claude Desktop / Cursor / 其他 MCP-aware app）。

## 传输方式

HTTP + SSE。Aalis 是常驻进程，stdio 已被日志占用，因此不走 Anthropic 默认的 stdio transport。

- SSE endpoint: `http://<bind>:<port>/sse`
- POST messages: `http://<bind>:<port>/messages`

> SSE 同时只支持一个活跃连接（协议标准），新连接会挤掉旧连接。

## 安全约束

- 默认 `bind: 127.0.0.1`（仅本机访问）—— **不要随便暴露到公网**
- 默认 `allowDangerous: false`，`safetyLevel='dangerous'` 工具一律拒绝
  - `ListTools` 与 `CallTool` 两端都过滤，防止 client 越界
- `toolGroups` 白名单：仅暴露指定分组（空数组 = 全部允许，但仍受 dangerous 开关约束）
- 工具执行仍走 Aalis 的 `ToolService.execute`，因此 authority guard / permissions resolver 全部生效

## 配置示例

```yaml
plugins:
  "@aalis/plugin-mcp-server":
    enabled: true
    port: 39870
    bind: 127.0.0.1
    toolGroups:
      - websearch
      - memory
    allowDangerous: false
```

Claude Desktop 客户端配置（仅供参考；MCP client 配置因 host app 而异）：

```json
{
  "mcpServers": {
    "aalis": {
      "type": "sse",
      "url": "http://127.0.0.1:39870/sse"
    }
  }
}
```

## 依赖

- `@modelcontextprotocol/sdk` ^1.0.4
- inject.required: `tools`

## 工具调用上下文

由于 MCP 协议不传递 session/user 概念，每次调用注入合成 `ToolCallContext`：

```ts
{ sessionId: 'mcp-server', userId: 'mcp-client', platform: 'mcp' }
```

如果你的工具依赖 sessionId 做权限隔离，需自行处理 platform === 'mcp' 分支。
