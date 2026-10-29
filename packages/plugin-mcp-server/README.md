# plugin-mcp-server

把 Aalis 注册的 tools 通过 [MCP (Model Context Protocol)](https://modelcontextprotocol.io) 协议**反向暴露**给外部 client（Claude Desktop / Cursor / 其他 MCP-aware app）。

## 传输方式

HTTP + SSE。Aalis 是常驻进程，stdio 已被日志占用，因此不使用 stdio 传输。

- SSE endpoint: `http://<bind>:<port>/sse`
- POST messages: `http://<bind>:<port>/messages`

> SSE 同时只支持一个活跃连接（协议标准），带对令牌的新连接会挤掉旧连接。

## 安全约束

- 默认 `bind: 127.0.0.1`（仅本机访问）—— **不要随便暴露到公网**
- 每个请求要带 `Authorization: Bearer <token>`，否则回 401；这是静态令牌，不是 OAuth 授权，配不了请求头的客户端连不上
- 默认 `allowRestricted: false`，可见性为 `restricted` 的工具一律拒绝
  - `ListTools` 与 `CallTool` 两端都过滤，防止 client 越界
- `toolGroups` 白名单：仅暴露指定分组（空数组或 `['*']` = 全部允许，但仍受 `allowRestricted` 约束）
  - 必须是分组名的字符串数组；非数组或含对象、布尔成员时激活失败、不监听，数字成员转成字符串分组名
- 工具执行仍走 Aalis 的 `ToolService.execute`，因此 authority 注入的 ExecutionGuard 同样生效

## 配置示例

```yaml
plugins:
  "@aalis/plugin-mcp-server":
    port: 39870
    bind: 127.0.0.1
    token: "<至少 32 个可见 ASCII 字符的随机串>"   # 密钥：启动时移进 secrets.yaml
    toolGroups:
      - search
      - system
    allowRestricted: false
```

以支持 HTTP+SSE 传输、能配请求头的 MCP client 为例（令牌是静态 Bearer 令牌，不走 OAuth；各 host 配置格式不同，以其文档为准；只认 URL 的客户端可以经能加请求头的本地桥接转发）：

```json
{
  "mcpServers": {
    "aalis": {
      "type": "sse",
      "url": "http://127.0.0.1:39870/sse",
      "headers": { "Authorization": "Bearer <令牌>" }
    }
  }
}
```

## 依赖

- `@modelcontextprotocol/sdk` ^1.29.0
- required 依赖：`tools`（在插件定义的 `uses` 里声明）

## 工具调用上下文

由于 MCP 协议不传递 session/user 概念，每次调用注入合成 `ToolCallContext`：

```ts
{ sessionId: 'mcp-server', userId: 'mcp-client', platform: 'mcp', participants: [{ platform: 'mcp', userId: 'mcp-client' }] }
```

如果你的工具依赖 sessionId 做权限隔离，需自行处理 platform === 'mcp' 分支。
