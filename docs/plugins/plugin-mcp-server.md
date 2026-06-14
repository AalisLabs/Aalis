# plugin-mcp-server — MCP 协议服务端桥

**包名**: `@aalis/plugin-mcp-server`
**源码**: `packages/plugin-mcp-server/src/index.ts`

## 概述

把 Aalis 注册的 tools 通过 [MCP](https://modelcontextprotocol.io) 协议**反向暴露**给外部 client（Claude Desktop / Cursor 等 MCP-aware host），让外部 LLM 也能调用 Aalis 自家的工具。

总体架构与定位见 [docs/plugins/mcp.md](mcp.md)。

## 插件声明

```ts
name = '@aalis/plugin-mcp-server'
provides = []
inject.required = ['tools']
```

## 传输

HTTP + SSE。因为 Aalis 是常驻进程、stdio 已被日志占用，所以不走 Anthropic 默认的 stdio transport。

- SSE endpoint: `http://<bind>:<port>/sse`
- POST messages: `http://<bind>:<port>/messages`

> SSE 同时只支持一个活跃连接（协议标准），新连接会挤掉旧连接。

## 配置

```yaml
plugins:
  "@aalis/plugin-mcp-server":
    enabled: true
    port: 39870
    bind: 127.0.0.1
    toolGroups:               # 白名单分组（空数组 = 全部允许）
      - websearch
      - memory
    allowRestricted: false    # restricted（受限）工具一律拒绝
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否启用 |
| `port` | number | `39870` | 监听端口 |
| `bind` | string | `127.0.0.1` | 监听地址（**不要随便暴露到公网**） |
| `toolGroups` | string[] | `[]` | 允许暴露的工具分组（空 = 全部，但仍受 allowRestricted 约束） |
| `allowRestricted` | boolean | `false` | 是否允许 `visibility='restricted'` 工具被外部调用 |

## 安全边界

- **`ListTools` 与 `CallTool` 两端都过滤 restricted**，防止 client 通过 list 看不到却仍能 call 的越界。
- 工具执行仍走 Aalis 的 `ToolService.execute`，因此 ExecutionGuard / 能力统一闸全部生效。
- 没有外部 client 鉴权 —— 完全依赖网络层（`127.0.0.1` + 防火墙）做隔离。

## 外部 client 配置示例

Claude Desktop（MCP 配置因 host 而异，下方仅供参考）：

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

## 工具调用上下文

MCP 协议不传 session / user 概念，server 每次调用注入合成 `ToolCallContext`：

```ts
{ sessionId: 'mcp-server', userId: 'mcp-client', platform: 'mcp' }
```

如果工具依赖 sessionId 做权限隔离，需自行处理 `platform === 'mcp'` 分支。

## 依赖

- `@modelcontextprotocol/sdk` ^1.0.4
- inject.required: `tools`

## 已知限制

- 仅 HTTP/SSE，**没有** stdio mode（需要新增独立 entry 脚本如 `bin/aalis-mcp-stdio.js`）。
- 单 SSE 连接限制（协议约束）。
