# plugin-tool-code-runner — 代码执行工具

**包名**: `@aalis/plugin-tool-code-runner`  
**源码**: `packages/plugin-tool-code-runner/src/index.ts`

## 概述

执行 Python / JavaScript 代码的工具，带超时与输出大小限制。**默认在 OS 沙箱内运行**
（经 `code-sandbox` 服务，由 [plugin-code-sandbox-os](./plugin-code-sandbox-os.md) 提供）——
把代码限制在「工作区 + 本次临时目录」、默认断网、只放行白名单环境变量。无可用沙箱后端时
**fail-closed**（拒绝执行，给出可操作提示），绝不静默裸跑。

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
| `sandbox.mode` | select | `auto` | `auto`=有沙箱后端则强制隔离、无则拒绝运行（fail-closed）；`none`=无隔离裸跑（危险，仅信任环境，每次告警） |
| `sandbox.network` | select | `deny` | 仅 auto 生效。`deny`=子进程断网（脚本内 fetch 会失败）；`allow`=放开（粗粒度，无法按域名过滤） |

## 沙箱（隔离执行）

`auto` 模式下取 `code-sandbox` 服务执行：每次运行按本次工作目录+临时目录构造策略
（写白名单 + 网络 + env 白名单），交由 OS 沙箱后端强制。需安装一个 `code-sandbox` 实现
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

解析使用共享工具 [`resolveAgainstCwd`](../api/plugin-storage-api.md#helper)，与 `plugin-tools` 的 shell/file/http 工具保持一致行为。
