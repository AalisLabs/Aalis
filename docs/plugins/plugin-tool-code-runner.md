# plugin-tool-code-runner — 代码执行工具

**包名**: `@aalis/plugin-tool-code-runner`  
**源码**: `packages/plugin-tool-code-runner/src/index.ts`

## 概述

执行 Python / JavaScript 代码的工具，带超时与输出大小限制。**默认在 OS 沙箱内运行**
（经 `code-sandbox` 服务，由 [plugin-code-sandbox-os](./plugin-code-sandbox-os.md) 提供）——
把代码的写入限制在「工作目录 + 本次临时目录」、默认断网、只放行白名单环境变量（读取不受限，
见下文「沙箱（隔离执行）」）。无可用沙箱后端时 **fail-closed**（拒绝执行，给出可操作提示），
不会退回无隔离运行。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tool-code-runner'
meta.inject = { required: ['storage', 'process'], optional: ['code-sandbox'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `python` | object | — | Python |
| `python.enabled` | boolean | `true` | 启用 run_python |
| `python.interpreter` | string | `'python3'` | 解释器路径：Python 解释器路径或命令名，如 python3、/usr/bin/python3 |
| `javascript` | object | — | JavaScript (Node.js) |
| `javascript.enabled` | boolean | `true` | 启用 run_javascript |
| `javascript.interpreter` | string | `'node'` | 解释器路径：Node.js 解释器路径或命令名 |
| `defaultTimeout` | number | `60000` | 默认超时 (ms)：脚本执行默认超时时间 |
| `maxTimeout` | number | `300000` | 最大超时 (ms)：允许指定的最大超时时间 |
| `maxOutputSize` | number | `131072` | 最大输出字节：stdout/stderr 各自的最大输出字节数 |
| `workingDirectory` | string | `'workspace:/'` | 逻辑工作目录：脚本执行时的 storage URI 工作目录，如 workspace:/ 或 tmp:/run；相对路径会解释为 workspace:/ 下路径。 |
| `sandbox` | object | — | 代码沙箱 |
| `sandbox.mode` | select | `'auto'` | 隔离模式：auto：经 code-sandbox 服务（Linux bubblewrap / macOS sandbox-exec）把代码限制在「工作区 + 本次临时目录」、默认断网、只放行白名单环境变量；无可用沙箱后端时拒绝执行（fail-closed）。none：退回无隔离裸进程，每次告警。说明：v1 读放开（解释器需系统库），防的是写出工作区/联网外泄/篡改系统，不防读取本机其它文件。 |
| `sandbox.network` | select | `'deny'` | 子进程网络：仅 auto 模式生效。deny：脚本内联网（含 fetch）会失败。allow：放开子进程网络（无法按域名白名单过滤）。 |

## 沙箱（隔离执行）

`auto` 模式下取 `code-sandbox` 服务执行：每次运行按本次工作目录与临时目录构造隔离策略
（目录写白名单 + 网络开关），连同环境变量白名单一起交给该服务，由 OS 沙箱后端强制执行。需安装一个 `code-sandbox` 实现
（默认 [plugin-code-sandbox-os](./plugin-code-sandbox-os.md)：macOS sandbox-exec / Linux bubblewrap）；
`npm create aalis` 选了本插件会自动带上它。**边界**：v1 防「写出工作区 / 联网外泄 / 篡改系统」，
**不防读取本机其它文件**（读放开，因解释器需系统库）；要防读取需更强的 WASM/microVM 实现。

## 注册工具

| 工具 | 说明 |
|---|---|
| `run_python` | 执行 Python 代码 |
| `run_javascript` | 执行 JavaScript 代码 |

## 工作目录解析

`workingDirectory` 必须是 storage URI（`workspace:/project`、`pluginData:/...` 等）或相对 `workspace:/` 的路径。**不接受宿主机绝对路径**。

解析使用 [`@aalis/api-storage`](../api/api-storage.md) 导出的共享函数 `resolveAgainstCwd`，与 [plugin-tool-system](./plugin-tool-system.md) 的 shell/file/http 工具行为一致。
