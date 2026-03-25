# Tools 插件 — Basic Tools & Tool Search

机器交互工具（shell / file / system / http）以及工具搜索层。

---

## plugin-tools-basic

提供 Shell、File、System、HTTP 四组工具，覆盖本机操作的常见需求。

**包名**: `@aalis/plugin-tools-basic`  
**源码**: `packages/plugin-tools-basic/src/`

### 提供的能力

```typescript
provides = ['machine-tools']
```

其他插件可通过 `MachineToolsService` 接口注册额外工具组：

```typescript
const mt = ctx.getService<MachineToolsService>('machine-tools');
mt.registerToolGroup('my-tools', (ctx, config) => { ... });
```

### 配置结构

```yaml
plugin-tools-basic:
  workingDirectory: ""      # 默认工作目录
  shell:
    enabled: true
    defaultTimeout: 30000   # 30s
    maxTimeout: 300000      # 5min
    maxOutputSize: 65536    # 64KB
  file:
    enabled: true
    maxReadSize: 1048576    # 1MB
    maxWriteSize: 10485760  # 10MB
  system:
    enabled: true
  http:
    enabled: true
    defaultTimeout: 30000
    maxResponseSize: 1048576
```

---

### Shell 工具组

| 工具 | 说明 | authority | dangerous |
|---|---|---|---|
| `exec` | 执行 shell 命令并返回输出 | 3 | ✓ |
| `exec_background` | 后台启动长期进程 | 3 | ✓ |
| `process_list` | 列出当前会话后台进程 | — | — |
| `process_read` | 读取后台进程输出 | — | — |
| `process_kill` | 终止后台进程 | 2 | ✓ |

**关键实现**:
- **平台适配**: Windows 用 `cmd /c`，其他用 `/bin/sh -c`
- **超时**: 钳位到 `[1000, maxTimeout]`；超时先 SIGTERM，3 秒后 SIGKILL
- **输出截断**: 超过 `maxOutputSize` 时截断，后台进程缓冲区超过 `maxOutputSize × 2` 时保留尾部
- **session 隔离**: 每个 session 独立的 `Map<string, ManagedProcess>`
- **dispose 清理**: 插件卸载时终止所有存活进程

---

### File 工具组

| 工具 | 说明 | dangerous |
|---|---|---|
| `file_read` | 读取文件，支持行范围和 base64 | — |
| `file_write` | 创建/覆盖文件，自动建目录 | ✓ (authority: 2) |
| `file_edit` | 精确字符串替换（oldText→newText） | — |
| `file_append` | 追加内容到末尾 | — |
| `file_list` | 列出目录内容 | — |
| `file_info` | 获取文件元信息 | — |
| `file_search` | grep 搜索（支持正则） | — |
| `file_tree` | 递归目录树 | — |

**关键实现**:
- **大小限制**: `file_read` 超过 `maxReadSize` 拒绝并建议按行读取；`file_write` 超过 `maxWriteSize` 拒绝
- **file_edit 唯一匹配**: `oldText` 必须在文件中恰好出现一次
- **file_search**: `maxResults` 上限 200
- **file_tree**: `maxDepth` 上限 10

---

### System 工具组

| 工具 | 说明 |
|---|---|
| `system_info` | OS / CPU / 内存 / Node.js / 用户信息 |
| `env_get` | 读取环境变量（按名称列表或前缀匹配） |
| `system_time` | 当前时间 / 时区 / Unix 时间戳 |
| `cwd` | 当前工作目录 |

**安全**: `env_get` 自动过滤敏感变量名（匹配 `key|secret|password|token|credential|auth|private|apikey|api_key`），返回 `[REDACTED]`。

---

### HTTP 工具组

| 工具 | 说明 |
|---|---|
| `http_request` | 发送 HTTP 请求（GET/POST/PUT/DELETE/PATCH） |
| `http_download` | 下载文件到本地 |

**安全措施**:
- **协议限制**: 仅允许 `http://` 和 `https://`
- **SSRF 防护** (`isPrivateHost()`): 阻止请求以下地址：
  - `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`
  - `10.x.x.x`, `192.168.x.x`, `172.16-31.x.x` (RFC 1918)
  - `169.254.x.x` (链路本地)
- **响应大小限制**: 检查 `Content-Length`，超过 `maxResponseSize` 拒绝读取
- **超时**: `AbortSignal.timeout()`，下载默认超时为普通请求的 3 倍

---

## plugin-tool-search

工具搜索层——在 LLM 和实际工具之间加一层间接层，减少每次传给 LLM 的工具数量。

**包名**: `@aalis/plugin-tool-search`  
**源码**: `packages/plugin-tool-search/src/index.ts`

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | true | 关闭后所有工具直接暴露给 LLM |
| `showToolNames` | boolean | true | description 中附带所有工具名列表 |
| `maxDirectTools` | number | 5 | 工具总数 ≤ 此值时跳过搜索层 |

### 工作原理

```
LLM 调用 → llm-call:before (优先级 100) → 替换 tools 列表
                                          ├─ 工具 ≤ 5 → 直接暴露全部
                                          └─ 工具 > 5 → 仅暴露 search_tools + 已发现工具
```

#### search_tools 工具

```
参数: { query: string }    // 必填，空字符串返回全部
返回: 匹配工具的完整定义（parameters + authority + safety）
```

搜索逻辑：关键词按空格分词，任意关键词匹配工具名或描述即命中。

#### 已发现工具追踪

`extractDiscoveredTools()` 扫描消息历史：
1. 找到所有 `search_tools` 的 tool call → 获取 tool_call_id
2. 在后续 tool 消息中找到对应结果
3. 解析 JSON 中的 `tools[].name`
4. 已发现的工具在后续 LLM 调用中保持可用（完整 definition 传入）

### 中间件优先级

优先级 100（高于 memory-vector 的 50），确保工具列表在消息注入之前就已替换完成。
