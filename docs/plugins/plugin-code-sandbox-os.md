# plugin-code-sandbox-os — 代码沙箱（OS 原生）

**包名**: `@aalis/plugin-code-sandbox-os`  
**契约**: `@aalis/plugin-code-sandbox-api`  
**源码**: `packages/plugin-code-sandbox-os/src/index.ts`（纯逻辑 `sandbox.ts`）

## 概述

`code-sandbox` 服务的 OS 原生实现：用系统自带的隔离机制把不可信代码（[code_runner](./plugin-tool-code-runner.md)
的 Python/JS）关进牢笼运行。**不是容器**（不依赖 Docker/守护进程），用 `npm` 装上即用。

| 平台 | 机制 | 是否需额外安装 |
|---|---|---|
| macOS | `sandbox-exec`（Seatbelt/SBPL） | 否（系统自带；Apple 标记 deprecated 但仍可用，Codex CLI/Chromium 在用） |
| Linux | `bubblewrap`（`bwrap`） | 是：`apt/dnf install bubblewrap`，且需启用 unprivileged user namespaces |
| 其它 | — | 无后端 → `available=false` |

## 设计要点

- **独立服务，不污染通用 `process` 契约**：「隔离执行不可信代码」是 code_runner 独有诉求，故自成
  `code-sandbox` 服务，而非给所有子进程共享的 `ProcessService` 加字段。
- **经 `process` 网关 spawn**：把命令包成 `bwrap …` / `sandbox-exec …` 后交给现有 `process` 服务执行——
  **零改** process-api / process-local；也不直接 import `node:child_process`/`node:fs`（后端探测用经网关的功能性试跑）。
- **功能性探测**：启动时真跑一次最小沙箱命令，跑通才 `available=true`——一次覆盖「存在性」+「Linux userns 是否真能用」。
- **可换可叠**：未来 `-docker` / `-wasm` / `-e2b` 等不同机制各自提供 `code-sandbox`，经优先级/偏好替换。

## 隔离语义（v1）

| 维度 | 行为 |
|---|---|
| 文件**写** | 仅 workspace + 本次临时目录可写，其余只读/拒写 |
| 文件**读** | 放开（解释器需系统库；故**不防读取本机其它文件**——要防读需 WASM/microVM 实现） |
| 网络 | 默认断网（`code_runner` 的 `sandbox.network=deny`）；可整体放开，但**无法按域名过滤** |
| 环境变量 | 仅放行白名单（`--clearenv`/`env -i`），宿主 secrets 不进沙箱 |
| 资源/超时 | 沿用 code_runner 的 timeout（SIGKILL） |

**一句话**：防「写出工作区 / 联网外泄 / 篡改系统」，是对原「裸子进程」的实打实安全升级；不防本机文件读取。

## 服务接口（`code-sandbox`）

```typescript
interface CodeSandboxService {
  readonly available: boolean;  // 无后端 → 调用方应 fail-closed
  readonly backend: string;     // 'bwrap' | 'seatbelt' | 'none'
  run(req: { cmd; args; cwd?; env?; timeout?; policy }): Promise<ExecResult>;
}
```

`code_runner` 用法：取服务 → `available` 为假则拒绝执行（不裸跑）→ 为真则 `run()`。见
[plugin-tool-code-runner](./plugin-tool-code-runner.md) 的「沙箱」节。
