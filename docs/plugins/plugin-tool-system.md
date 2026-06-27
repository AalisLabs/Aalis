# plugin-tool-system — 系统工具集

**包名**: `@aalis/plugin-tool-system`  
**源码**: `packages/plugin-tool-system/src/index.ts`

## 概述

机器交互基础工具集，提供 Shell 命令、文件操作、系统信息和 HTTP 请求等工具。按工具组管理，各组可独立启用/禁用。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tool-system'
meta.inject = { required: ['tools'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `workingDirectory` | string | `workspace:/` | 进程启动时的初始 cwd（unix 心智模型）。agent 可用 `cd` 工具在会话内切换，不会写回配置 |
| **shell** (分组) | | | |
| `shell.enabled` | boolean | true | 启用 Shell 工具 |
| `shell.defaultTimeout` | number | 30000 | 默认超时 (ms) |
| `shell.maxTimeout` | number | 300000 | 最大超时 (ms) |
| `shell.maxOutputSize` | number | 65536 | 最大输出大小 (bytes) |
| **file** (分组) | | | |
| `file.enabled` | boolean | true | 启用文件工具 |
| `file.maxReadSize` | number | 1048576 | 最大读取大小 (1MB) |
| `file.maxWriteSize` | number | 10485760 | 最大写入大小 (10MB) |
| `file.allowedRoots` | string[] | [`workspace`, `tmp`] | 文件工具可访问的 storage 根；默认仅 agent 工作区，不含 `data` 等系统根（防裸读 `data:/users.json` 等）。设为 `*` 放开全部 readable 根；写入/删除仍受根自身权限限制 |
| **system** (分组) | | | |
| `system.enabled` | boolean | true | 启用系统信息工具（含 `cwd` / `cd`） |
| **http** (分组) | | | |
| `http.enabled` | boolean | true | 启用 HTTP 工具 |
| `http.defaultTimeout` | number | 30000 | 默认超时 (ms) |
| `http.maxResponseSize` | number | 1048576 | 最大响应大小 (1MB) |

## 路径与 cwd 心智模型

所有 `file_*` 工具的 `path` 参数遵循 unix shell 风格：

- **完整 storage URI**（`aalis:/packages/core`、`workspace:/notes/a.md`）→ 直接定位
- **相对路径**（`packages/core`、`./a.ts`、`../plugin-tools`）→ 基于当前 session 的 cwd 解析
- **宿主机绝对路径**（`/Users/...`、`C:\...`）→ 一律拒绝

`cwd` 工具返回当前目录 + 所有可用 storage 根的清单（含读/写/删权限），调用一次即可看清"我在哪、能去哪"。`cd` 工具切换当前 session 的 cwd（仅内存，进程重启回到 `workingDirectory` 配置值，不写配置文件）。

`shell` 与 `code-runner` 仍使用各自独立的 `workingDirectory` 配置，**不**受 `cd` 影响 —— 子进程模型决定了它们只能在文件系统型根下执行。


## 工具组

工具从 `./tools/` 目录下的独立模块导入：
- **shell**: Shell 命令执行
- **file**: 文件读写操作
- **system**: 系统信息查询
- **http**: HTTP 请求

## file 工具：exclude/include 与 file_search 行为

`file_search` 与 `file_tree` 接受可选参数 `exclude`、`include`（数组，glob 字符串）。

### 默认排除（DEFAULT_EXCLUDE_PATTERNS）

```
node_modules/**   dist/**    build/**    .git/**    .pnpm/**
.next/**          .turbo/**  .yarn/**    coverage/**
__pycache__/**    *.pyc      .DS_Store   Thumbs.db
```

调用方传入 `exclude` 时**追加**到默认列表（不替换），避免常见的 node_modules 污染。
`include` 仅做**正向白名单**（命中即保留），未指定时所有未被 exclude 的条目都纳入。

### Glob 语义

- `*` 匹配单段内任意字符（不跨 `/`）
- `**/` / `/**` 匹配**零或多层**目录（修复了之前"至少一层"导致 `node_modules/**` 不命中根目录下 `node_modules/foo.js` 的 bug）
- `?` 单字符（不跨 `/`）

### 目录级早跳

`collectFiles()` 在递归进入目录前先用 exclude 测试目录路径，命中则整棵子树短路。
对 `node_modules` / `.git` 等大目录是 O(命中即跳)，不会逐文件遍历再丢弃。

### 截断提示

`file_search` 结果默认上限 200 条；超出时 `advice` 字段会建议缩小搜索范围或追加 `include`。

## 共享 runtime 工具

storage URI 规范化（`toStorageUri` / `resolveAgainstCwd` / `parseStorageUri`）已**抽取到** [@aalis/plugin-storage-api](../api/plugin-storage-api.md)，SSRF 私网判定（`isPrivateHost` / `isPrivateAddress`）已**抽取到** [@aalis/util-network-guard](../utils/network-guard.md)；本包内部以及 `plugin-tool-browser` / `plugin-tool-code-runner` 都直接复用，不再各写一份。`plugin-tools-api` 现为纯契约包，原 `utils` 已删除。

## 指令

- `/tools` — 列出所有已启用的工具组和工具
