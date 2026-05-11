# plugin-tool-code-runner — 代码执行工具

**包名**: `@aalis/plugin-tool-code-runner`  
**源码**: `packages/plugin-tool-code-runner/src/index.ts`

## 概述

支持 Python 和 JavaScript 代码执行的沙盒工具，带超时和输出大小限制。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tool-code-runner'
meta.inject = {}
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultTimeout` | number | `60000` | 默认超时（ms） |
| `maxTimeout` | number | `300000` | 最大超时（5 分钟） |
| `maxOutputSize` | number | `131072` | 输出大小限制（128KB） |

## 注册工具

| 工具 | 说明 |
|---|---|
| `run_python` | 执行 Python 代码 |
| `run_javascript` | 执行 JavaScript 代码 |

## 工作目录解析

`workingDirectory` 必须是 storage URI（`workspace:/project`、`pluginData:/...` 等）或相对 `workspace:/` 的路径。**不接受宿主机绝对路径**。

解析使用共享工具 [`toStorageUri`](../api/plugin-tools-api.md#共享-runtime-工具utilsts)，与 `plugin-tools` 的 shell/file/http 工具保持一致行为。
