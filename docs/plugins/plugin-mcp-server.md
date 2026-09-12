# plugin-mcp-server — MCP 协议服务端桥

**包名**: `@aalis/plugin-mcp-server`
**源码**: `packages/plugin-mcp-server/src/index.ts`

## 概述

把 Aalis 注册的 tools 通过 [MCP](https://modelcontextprotocol.io) 协议**反向暴露**给外部 client（Claude Desktop / Cursor 等 MCP-aware host），让外部 LLM 也能调用这些工具。

总体架构与定位见 [docs/plugins/mcp.md](mcp.md)。

## 插件声明

```ts
name = '@aalis/plugin-mcp-server'
displayName = 'MCP 服务端'
subsystem = 'tools'
inject = { required: ['tools'] }
```

## 传输

HTTP + SSE。Aalis 是常驻进程，stdio 已被日志占用，因此不使用 stdio 传输。

- SSE endpoint: `http://<bind>:<port>/sse`
- POST messages: `http://<bind>:<port>/messages`

> 本插件同一时间只维护一个活跃 SSE 连接：新的 `GET /sse` 会关闭旧连接；没有活跃连接时 `POST /messages` 返回 409。

## 配置

```yaml
plugins:
  "@aalis/plugin-mcp-server":
    port: 7861
    bind: 127.0.0.1
    toolGroups:               # 白名单分组（空数组 = 全部允许）
      - search
      - system
    allowRestricted: false    # restricted（受限）工具一律拒绝
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `port` | number | `7861` | 监听端口：必须 1-65535；非法值会报错不启动。要暂停服务请在「插件列表」里禁用本插件。 |
| `bind` | string | `'127.0.0.1'` | 监听地址 |
| `toolGroups` | array | `[]` | 允许的工具分组（空=全部，受受限开关约束）：空列表 = 暴露所有分组的工具（仍受 allowRestricted 约束）。 |
| `allowRestricted` | boolean | `false` | 允许暴露 restricted（受限）工具 |

## 安全边界

- **`ListTools` 与 `CallTool` 共用同一个暴露判定**（allowRestricted + toolGroups 白名单）：client 按工具名直接调用未暴露的工具时，返回错误 `工具不可用或未暴露: <工具名>`。toolGroups 非空时，未归入任何分组的工具不会暴露。
- 工具执行仍经 `ToolService.execute`。若加载了 [plugin-authority](plugin-authority.md)，其注入的 ExecutionGuard（权限守卫）同样生效：MCP 调用以 platform `mcp`、userId `mcp-client` 身份参与等级裁决，因此即使开启 allowRestricted，restricted/sensitive 工具仍可能被拒；声明了 confirm 的工具因 mcp 平台没有可应答的确认通道，调用通常会被取消。
- 没有外部 client 鉴权 —— 完全依赖网络层（`127.0.0.1` + 防火墙）做隔离。

## 外部 client 配置示例

以支持 HTTP+SSE 传输的 MCP client 为例（各 host 配置格式不同，以其文档为准）：

```json
{
  "mcpServers": {
    "aalis": {
      "type": "sse",
      "url": "http://127.0.0.1:7861/sse"
    }
  }
}
```

## 工具调用上下文

MCP 协议不传 session / user 概念，server 每次调用注入合成 `ToolCallContext`：

```ts
{ sessionId: 'mcp-server', userId: 'mcp-client', platform: 'mcp' }
```

所有 MCP 调用共用上述固定的 sessionId/userId，工具无法区分不同的外部 client。

## 依赖

- `@modelcontextprotocol/sdk` ^1.0.4
- inject.required: `tools`

## 已知限制

- 仅支持 HTTP/SSE 传输，不提供 stdio 模式。
- 同一时间仅支持一个 SSE 连接（实现限制）。
- CallTool 仅返回工具结果的文本部分，工具返回的图片（images）不经 MCP 透传。
