# plugin-mcp-server — MCP 协议服务端桥

**包名**: `@aalis/plugin-mcp-server`
**源码**: `packages/plugin-mcp-server/src/index.ts`

## 概述

把 Aalis 注册的 tools 通过 [MCP](https://modelcontextprotocol.io) 协议**反向暴露**给外部 client（Claude Desktop / Cursor 等 MCP-aware host），让外部 LLM 也能调用这些工具。

总体架构与定位见 [docs/plugins/mcp.md](mcp.md)。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-mcp-server',
  displayName: 'MCP 服务端',
  subsystem: 'tools',
  uses: { tools, logger, lifecycle, config },
  apply(caps) { /* 见源码 */ },
});
```

## 传输

HTTP + SSE。Aalis 是常驻进程，stdio 已被日志占用，因此不使用 stdio 传输。

- SSE endpoint: `http://<bind>:<port>/sse`
- POST messages: `http://<bind>:<port>/messages`

> 本插件同一时间只维护一个活跃 SSE 连接：带对令牌的新 `GET /sse` 会关闭旧连接；没有活跃连接时 `POST /messages` 返回 409。

## 配置

```yaml
plugins:
  "@aalis/plugin-mcp-server":
    port: 7861
    bind: 127.0.0.1
    token: "<至少 32 个可见 ASCII 字符的随机串>"   # 密钥：启动时移进 secrets.yaml
    toolGroups:               # 白名单分组（空数组或 ['*'] = 全部允许）
      - search
      - system
    allowRestricted: false    # restricted（受限）工具一律拒绝
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `port` | number | `7861` | 监听端口：必须 1-65535；非法值会报错不启动。要暂停服务请在「插件列表」里禁用本插件。 |
| `bind` | string | `'127.0.0.1'` | 监听地址 |
| `token` | string（密钥，必填） | 无 | 访问令牌：外部 MCP 客户端要在请求头带上 `Authorization: Bearer <令牌>`。至少 32 个可见 ASCII 字符、不含空白，可用 `openssl rand -hex 32` 生成 |
| `toolGroups` | multiselect | `[]` | 允许的工具分组：分组名的字符串数组；空列表或 `['*']` = 暴露所有分组的工具（仍受「允许暴露 restricted（受限）工具」约束）。非数组或含对象、布尔成员时拒绝激活；数字成员转换为字符串分组名，仍按白名单匹配。`null` 按缺省空数组处理。 |
| `allowRestricted` | boolean | `false` | 允许暴露 restricted（受限）工具 |

`token` 是密钥，存进密钥存储，WebUI 不回显；连 `/sse` 与 `/messages` 都要带它（见下文「安全边界」）。没填时插件标待配置、不监听。

## 安全边界

- **`ListTools` 与 `CallTool` 共用同一个暴露判定**（allowRestricted + toolGroups 白名单）：client 按工具名直接调用未暴露的工具时，返回错误 `工具不可用或未暴露: <工具名>`。toolGroups 非空时，未归入任何分组的工具不会暴露。
- 工具执行仍经 `ToolService.execute`。若加载了 [plugin-authority](plugin-authority.md)，其注入的 ExecutionGuard（权限守卫）同样生效：MCP 调用以 platform `mcp`、userId `mcp-client` 身份参与等级裁决，因此即使开启 allowRestricted，restricted/sensitive 工具仍可能被拒；声明了 confirm 的工具调用不在由入站消息驱动的回合里，不能产生 owner 审批，直接被拒。
- 每个请求都要带 `Authorization: Bearer <token>`，否则回 401，带 `WWW-Authenticate: Bearer`（令牌不对时加 `error="invalid_token"`），不建会话，也不挤掉已经连上的客户端。这是静态 Bearer 令牌，不是 MCP 规范的 OAuth 授权：只会走 OAuth、配不了请求头的客户端连不上，会以 OAuth 发现或注册失败报错。不校验 Host 与 Origin：借 DNS 重绑连上来的网页拿不到令牌。

## 外部 client 配置示例

以支持 HTTP+SSE 传输、能配请求头的 MCP client 为例（令牌是静态 Bearer 令牌，不走 OAuth；各 host 配置格式不同，以其文档为准；只认 URL 的客户端可以经能加请求头的本地桥接转发）：

```json
{
  "mcpServers": {
    "aalis": {
      "type": "sse",
      "url": "http://127.0.0.1:7861/sse",
      "headers": { "Authorization": "Bearer <令牌>" }
    }
  }
}
```

## 工具调用上下文

MCP 协议不传 session / user 概念，server 每次调用注入合成 `ToolCallContext`：

```ts
{ sessionId: 'mcp-server', userId: 'mcp-client', platform: 'mcp', participants: [{ platform: 'mcp', userId: 'mcp-client' }] }
```

所有 MCP 调用共用上述固定的 sessionId/userId，工具无法区分不同的外部 client。唯一的参与者是 `mcp:mcp-client`，权限守卫按这个身份裁决；调用不在入站回合里，取用判定（`approveFor`）只按它判、不出审批。

## 依赖

- `@modelcontextprotocol/sdk` ^1.29.0
- uses required: `tools`

## 已知限制

- 仅支持 HTTP/SSE 传输，不提供 stdio 模式。
- 同一时间仅支持一个 SSE 连接（实现限制）。
- CallTool 仅返回工具结果的文本部分，工具返回的图片（images）不经 MCP 透传。
