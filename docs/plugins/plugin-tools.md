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

## 指令

- `/tools` — 列出所有已启用的工具组和工具
