# plugin-mcp-client

作为 [MCP (Model Context Protocol)](https://modelcontextprotocol.io) **client** 连接外部 MCP servers（通过 stdio），把它们暴露的 tools 包装注册到 Aalis 的 `ToolService`，让 Aalis agent 可以直接调用外部生态的工具。

## 接入要点

- 每个 server 在 config 中独立一项（`id` / `command` / `args` / `env`）
- 工具名会加前缀 `mcp_<server-id>_<tool-name>` 避免与本地工具命名冲突
- 每个 server 注册一个工具分组 `mcp:<server-id>`，可在 platform 配置中按需启用
- `ctx.onDispose` 注册了 client 关闭回调，插件卸载时自动断开
- 工具的 `safety` / `authority` 由 config 中按 server 配置，**默认 `safe`**——
  对接 filesystem / shell 等高危 server 时务必显式设为 `dangerous`

## 配置示例

```yaml
plugins:
  "@aalis/plugin-mcp-client":
    servers:
      - id: github
        command: npx
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxx"
        enabled: true

      - id: fs
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
        safety: dangerous   # 文件系统访问视为高危
        authority: 3
```

## 依赖

- `@modelcontextprotocol/sdk` ^1.0.4
- inject.required: `tools`（plugin-tools-api / plugin-tools）

## 注意

- MCP `inputSchema` 顶层非 `type: 'object'` 时会被包装为 `{ input: schema }`
- 工具名超过 64 字符（OpenAI 限制）会被截断
- 非法字符（`/` `.` 等）会被替换为下划线
