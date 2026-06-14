# plugin-mcp-client — MCP 协议客户端桥

**包名**: `@aalis/plugin-mcp-client`
**源码**: `packages/plugin-mcp-client/src/index.ts`

## 概述

作为 [MCP (Model Context Protocol)](https://modelcontextprotocol.io) **client** 通过 stdio 连接外部 MCP server（如 `@modelcontextprotocol/server-github`、`server-filesystem`、`server-playwright` 等），把这些 server 暴露的 tools 自动注册到 Aalis 的 `ToolService`，让 agent 直接调用外部生态工具。

总体架构与定位见 [docs/plugins/mcp.md](mcp.md)。

## 插件声明

```ts
name = '@aalis/plugin-mcp-client'
provides = []                 // 不提供服务，只往 tools 上挂工具
inject.required = ['tools']
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
        visibility: public       # public | restricted（默认 public）

      - id: fs
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
        visibility: restricted   # 文件系统访问视为受限，须被 owner/委托授予
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `servers[].id` | string | 必填 | server 标识，会作为工具名前缀与分组名 |
| `servers[].command` | string | 必填 | 启动 server 的可执行命令 |
| `servers[].args` | string[] | `[]` | 命令参数 |
| `servers[].env` | Record<string,string> | `{}` | 环境变量（继承当前进程 env） |
| `servers[].enabled` | boolean | `true` | 是否启动此 server |
| `servers[].visibility` | `'public' \| 'restricted'` | `'public'` | 该 server 所有工具的默认可见性（restricted 须授予后才能调用） |

## 行为

- 每个 server 是一个独立子进程，stdio 传输。
- 工具名映射：`mcp_<server-id>_<tool-name>`，非法字符替换为 `_`，超长截断到 64（OpenAI 限制）。
- 工具分组：`mcp:<server-id>` —— 可在 platform 配置中按需启用/禁用。
- `inputSchema` 顶层非 `type: 'object'` 时自动包装为 `{ input: schema }`。
- 插件 `apply()` 内通过 `ctx.onDispose` 注册关闭回调，`ctx.dispose()` 时自动断开所有 server。

## 安全注意

- 外部 server 是**不受信任的第三方进程**，工具的 `visibility` 必须显式配置——
  默认 `public` 仅适合纯查询类 server（如 GitHub READ）；对接 filesystem / shell / browser 类务必显式设为 `restricted`。
- Aalis 自身的能力统一闸仍生效：`restricted` 工具被调用时须 owner 或被委托授予才放行。

## 依赖

- `@modelcontextprotocol/sdk` ^1.0.4
- inject.required: `tools`

## 已知限制

- 仅支持 stdio transport，SSE / HTTP client 暂未实现。
- server 启动失败不会阻止 Aalis 启动，仅在 logger 中报错；可通过 `aalis status` / WebUI 查看插件状态。
