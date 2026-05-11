# plugin-tools — 系统工具集

**包名**: `@aalis/plugin-tools`  
**源码**: `packages/plugin-tools/src/index.ts`

## 概述

机器交互基础工具集，提供 Shell 命令、文件操作、系统信息和 HTTP 请求等工具。按工具组管理，各组可独立启用/禁用。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tools'
meta.inject = { required: ['tools'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `workingDirectory` | string | `''` | 默认工作目录 |
| **shell** (分组) | | | |
| `shell.enabled` | boolean | true | 启用 Shell 工具 |
| `shell.defaultTimeout` | number | 30000 | 默认超时 (ms) |
| `shell.maxTimeout` | number | 300000 | 最大超时 (ms) |
| `shell.maxOutputSize` | number | 65536 | 最大输出大小 (bytes) |
| **file** (分组) | | | |
| `file.enabled` | boolean | true | 启用文件工具 |
| `file.maxReadSize` | number | 1048576 | 最大读取大小 (1MB) |
| `file.maxWriteSize` | number | 10485760 | 最大写入大小 (10MB) |
| `file.defaultRoot` | string | `workspace` | 相对路径默认解释到的 storage 根 |
| `file.allowedRoots` | string[] | [`*`] | 文件工具可访问的 storage 根；`*` 表示所有 readable 根，写入/删除仍受根自身权限限制 |
| **system** (分组) | | | |
| `system.enabled` | boolean | true | 启用系统信息工具 |
| **http** (分组) | | | |
| `http.enabled` | boolean | true | 启用 HTTP 工具 |
| `http.defaultTimeout` | number | 30000 | 默认超时 (ms) |
| `http.maxResponseSize` | number | 1048576 | 最大响应大小 (1MB) |

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

storage URI 规范化与 SSRF 私网判定已**抽取到** [@aalis/plugin-tools-api](../api/plugin-tools-api.md) 的 `utils`，本包内部以及 `plugin-tool-browser` / `plugin-tool-code-runner` 都直接复用，不再各写一份。

## 指令

- `/tools` — 列出所有已启用的工具组和工具
