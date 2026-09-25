# plugin-mcp-client

作为 [MCP (Model Context Protocol)](https://modelcontextprotocol.io) **client** 连接外部 MCP servers（通过 stdio），把它们暴露的 tools 包装注册到 Aalis 的 `ToolService`，让 Aalis agent 可以直接调用外部生态的工具。

## 接入要点

- 每个 server 在 config 中独立一项（`id` / `command` / `args` / `env`）
- 工具名会加前缀 `mcp_<server-id>_<tool-name>` 避免与本地工具命名冲突
- 每个 server 注册一个工具分组 `mcp:<server-id>`，可在 platform 配置中按需启用
- `lifecycle.onDispose` 注册了 client 关闭回调，插件卸载时自动断开
- 工具档位默认 `auto`——按 MCP 工具注解分档：自称只读（`readOnlyHint`）→ `sensitive`
  （等级 1），有破坏提示或未声明 → `restricted`（等级 2，未知按可破坏算）。
  server 级 `visibility` 可显式覆盖为 `public` / `sensitive` / `restricted`

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
        visibility: restricted   # 显式收紧：文件系统访问全部按等级 2
```

## 依赖

- `@modelcontextprotocol/sdk`
- uses：`tools`（必需，api-tools / plugin-tools）；可选 `plugins`、`hostConfig`

## 注意

- `args` 必须是字符串数组、`env` 必须是映射；字符串（含空串）或其它形态会让该 server 记录警告且不启动，需按上面的示例改写
  - 旧版 WebUI 建的条目常带 `args: ''` / `env: ''`，请删除该键或改为 `[]` / `{}`
  - 旧版按以下规则解析字符串，改写时照此拆分：`args` 先按行、再按空白切分，如 `args: "-y @scope/pkg"` 应改为 `["-y", "@scope/pkg"]`；`env` 每行一条 `KEY=VALUE`，忽略 `#` 开头的注释行，值去首尾空白
- MCP `inputSchema` 顶层非 `type: 'object'` 时会被包装为 `{ input: schema }`
- 工具名超过 64 字符（OpenAI 限制）会被截断
- 非法字符（`/` `.` 等）会被替换为下划线
