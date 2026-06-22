# code-sandbox 服务 — OS 级代码沙箱

> 面向：要为 Aalis **写一个代码沙箱后端**（provider），或在自己的插件里**安全执行不可信代码**（consumer）的第三方作者。

`code-sandbox` 把「在 OS 隔离下执行不可信代码」收口成一个独立服务。注册名是字符串
**`'code-sandbox'`**（`ctx.getService('code-sandbox')`），契约包是
[`@aalis/plugin-code-sandbox-api`](../../packages/plugin-code-sandbox-api/src/index.ts)。

为什么单独成服务而非塞进通用 `process`：「在 OS 隔离里跑不可信代码」是 `code_runner` 独有的诉求，
package-manager / scheduler 等跑子进程的插件都不需要它——把它塞进共享的 `process` 契约会污染公共面
（[`code-sandbox-api/src/index.ts:1-9`](../../packages/plugin-code-sandbox-api/src/index.ts) 的设计注释）。
未来可以有 `-docker` / `-wasm` / `-e2b` 等不同机制的实现，经同一 `code-sandbox` 服务名按优先级/偏好替换。

参考实现：[`@aalis/plugin-code-sandbox-os`](../../packages/plugin-code-sandbox-os/src/index.ts)
（Linux `bubblewrap` / macOS `sandbox-exec`）。唯一消费方：
[`@aalis/plugin-tool-code-runner`](../../packages/plugin-tool-code-runner/src/index.ts)。

---

## 1. 契约：`CodeSandboxService`

定义在 [`code-sandbox-api/src/index.ts:52-62`](../../packages/plugin-code-sandbox-api/src/index.ts)：

```ts
export interface CodeSandboxService {
  /** 本机是否有可用沙箱后端（无 → 调用方 fail-closed） */
  readonly available: boolean;
  /** 当前后端标识（诊断/展示用，如 'bwrap' / 'seatbelt' / 'none'） */
  readonly backend: string;
  /**
   * 在沙箱内运行命令并等待结束。返回 ExecResult；
   * 与 ProcessService.execFile 一致——非零退出会 reject（错误对象挂 `.result`）。
   */
  run(req: SandboxRunRequest): Promise<ExecResult>;
}
```

请求体 `SandboxRunRequest`（[`index.ts:30-44`](../../packages/plugin-code-sandbox-api/src/index.ts)）：

```ts
export interface SandboxRunRequest {
  cmd: string;                                  // 解释器路径/名，如 python3 / node
  args: string[];                               // 命令参数（含脚本路径）
  cwd?: string;                                 // 工作目录（本地绝对路径）
  env?: Record<string, string | undefined>;    // env 白名单：沙箱内仅这些键可见，其余宿主 env 清零（防 secrets 泄漏）
  timeout?: number;                             // 超时（毫秒）
  policy: SandboxPolicy;                        // 隔离策略
}
```

隔离策略 `SandboxPolicy`（[`index.ts:21-28`](../../packages/plugin-code-sandbox-api/src/index.ts)）：

```ts
export interface SandboxPolicy {
  /** 可读绝对目录白名单（信息性；v1 后端读放开，预留给更严格的读限定实现） */
  fsRead: string[];
  /** 可写绝对目录白名单（如 workspace + 临时目录）；此外一律只读/拒写 */
  fsWrite: string[];
  /** 子进程网络：'deny'=断网（推荐默认）；'allow'=放开（粗粒度，无法按域名过滤） */
  network: 'deny' | 'allow';
}
```

返回值 `ExecResult` 复用 `process` 契约
（[`plugin-process-api/src/index.ts:38-49`](../../packages/plugin-process-api/src/index.ts)）：
`{ code, signal, stdout, stderr, truncated? }`。**非零退出会 reject**，错误对象上挂 `.result`
（同 `ProcessService.execFile` 的约定，见 §5 错误处理）。

helper（契约包导出，给消费方）：
```ts
export function useCodeSandbox(ctx: Context): CodeSandboxService | undefined;
```
取服务，未就绪/未安装实现时返回 `undefined`（[`index.ts:71-73`](../../packages/plugin-code-sandbox-api/src/index.ts)）。

> 注意：契约包 [`package.json`](../../packages/plugin-code-sandbox-api/package.json) 没有 `aalis.service` 块，
> 因为它是**纯契约包**（`keywords: ["aalis","aalis-api"]`）——只导出 interface/type/helper，不在运行时注册服务。
> 真正的 `provides: ['code-sandbox']` 由实现包声明（见 §4）。

---

## 2. 谁提供 / 谁消费

| 角色 | 包 | 入口 |
|---|---|---|
| 契约 | `@aalis/plugin-code-sandbox-api` | [`src/index.ts`](../../packages/plugin-code-sandbox-api/src/index.ts) |
| 参考实现 | `@aalis/plugin-code-sandbox-os` | `provide('code-sandbox', …)` @ [`src/index.ts:75`](../../packages/plugin-code-sandbox-os/src/index.ts) |
| 唯一消费方 | `@aalis/plugin-tool-code-runner` | `useCodeSandbox(ctx)` @ [`src/index.ts:174`](../../packages/plugin-tool-code-runner/src/index.ts)；`codeSandbox.run(...)` @ [`src/runner.ts:94`](../../packages/plugin-tool-code-runner/src/runner.ts) |

参考实现的关键点（[`code-sandbox-os/src/index.ts`](../../packages/plugin-code-sandbox-os/src/index.ts)）：

- **不直接 import `node:child_process` / `node:fs`**：把不可信代码包成沙箱启动器命令后，经**现有 `process`
  服务网关** spawn（`inject.required = ['process']`，`index.ts:18-20`）。OS 探测也靠经网关功能性试跑。
- **功能性探测**（`probeBackend`，`index.ts:26-44`）：经 `process` 网关真跑一次最小沙箱命令
  （macOS `sandbox-exec -p '(version 1)(allow default)' true`、Linux `bwrap --ro-bind / / --unshare-all true`），
  跑通才算可用。比「命令是否存在」更强——一次覆盖**存在性 + Linux unprivileged userns 是否真能用**。
  探测失败（未装 bwrap / userns 被禁）→ `backend = 'none'` → `available = false`。
- **命令改写**（[`sandbox.ts`](../../packages/plugin-code-sandbox-os/src/sandbox.ts)，纯逻辑、便于单测）：
  `wrapForSandbox()` 把 `(cmd,args)` 改写为「经沙箱启动器运行」，全程 **shell-free**（不拼 shell 字符串）。

---

## 3. 写一个 provider

### 最小契约
必须实现 `CodeSandboxService` 的三个成员：`available`（getter）、`backend`（getter）、`run()`。

不变量（写 provider 时必须守住）：

1. **`available === false` 时 `run()` 不应被调用**，但仍要防御性抛错而非裸跑——参考实现里
   `backend === 'none'` 时 `run()` 直接 throw（[`code-sandbox-os/src/index.ts:60-63`](../../packages/plugin-code-sandbox-os/src/index.ts)）。
2. **强制 `policy`**：`fsWrite` 之外只读/拒写、`network==='deny'` 必须真正断网、`env` 之外的宿主环境变量必须清零。
   这是契约的安全语义，consumer 依赖它来防「写出工作区 / 联网外泄 / secrets 泄漏」。
3. **`run()` 的错误约定要对齐 `ExecResult`**：非零退出 reject，错误对象挂 `.result`（见 §5）。

### 注册（`ctx.provide`）
参考实现在 `apply` 里探测后端、再注册单例（[`code-sandbox-os/src/index.ts:71-79`](../../packages/plugin-code-sandbox-os/src/index.ts)）：

```ts
export async function apply(ctx: Context): Promise<void> {
  const logger = ctx.logger.child('my-sandbox');
  const proc = createProcessGateway(ctx);          // 经 process 网关，别直接碰 child_process
  const backend = await probeBackend(proc, logger);
  ctx.provide('code-sandbox', new MyCodeSandboxService(proc, backend));
  // 默认 priority = ServicePriority.Backend(0)。想默认压过别的后端用 Override(50)。
}
```

priority 取值见 [`core/src/types/service.ts:28-30`](../../packages/core/src/types/service.ts)：
`Backend=0` / `Override=50` / `System=200`（不要用裸数字，dev 校验会警告，
`service-helpers.ts:62`）。同名多实现时胜者 = `preference > priority > 注册顺序`——这是纯按名选择，
**没有能力维度的匹配**（详见 [服务模型](../concepts/service-model.md)）。

### 双源元数据要同步
`provides` / `inject` 有**两套独立来源**，部署时都要写对（见 [清单元数据](../concepts/manifest-metadata.md)）：

- 代码导出：`export const provides = ['code-sandbox']`、`export const inject = { required: ['process'] }`
  （[`code-sandbox-os/src/index.ts:17-20`](../../packages/plugin-code-sandbox-os/src/index.ts)）。
- `package.json` 的 `aalis.service`（[`code-sandbox-os/package.json`](../../packages/plugin-code-sandbox-os/package.json)）：

```jsonc
{
  "keywords": ["aalis", "aalis-plugin"],
  "aalis": {
    "service": {
      "required": ["process"],
      "provides": ["code-sandbox"]
    }
  }
}
```

> 注意 `keywords` 要含 `aalis-plugin`——npm 部署的加载器靠这个关键词门识别可加载插件。

### 最小可编译骨架

```ts
import type { Context, PluginModule } from '@aalis/core';
import type { CodeSandboxService, SandboxRunRequest } from '@aalis/plugin-code-sandbox-api';
import { type ExecResult, type ProcessService, createProcessGateway } from '@aalis/plugin-process-api';

export const name = '@example/plugin-code-sandbox-mybackend';
export const provides = ['code-sandbox'];
export const inject = { required: ['process'] };

class MyCodeSandboxService implements CodeSandboxService {
  constructor(private readonly proc: ProcessService, private readonly _ok: boolean) {}
  get available() { return this._ok; }
  get backend() { return this._ok ? 'mybackend' : 'none'; }

  async run(req: SandboxRunRequest): Promise<ExecResult> {
    if (!this._ok) throw new Error('code-sandbox: 无可用后端，run() 不应被调用');
    // 1) 用 req.policy 把 (req.cmd, req.args) 改写成「经你的隔离机制运行」的启动器命令；
    //    必须强制：fsWrite 外只读、network==='deny' 断网、env 外宿主变量清零。
    // 2) 经 process 网关 spawn（别直接 import node:child_process）。
    const wrapped = wrapForMyBackend(req);       // 你的纯改写逻辑
    return this.proc.execFile(wrapped.cmd, wrapped.args, { cwd: req.cwd, timeout: req.timeout });
  }
}

export async function apply(ctx: Context): Promise<void> {
  const proc = createProcessGateway(ctx);
  const ok = await probeMyBackend(proc);         // 功能性试跑，跑通才 true
  ctx.provide('code-sandbox', new MyCodeSandboxService(proc, ok));
}

const plugin: PluginModule = { name, apply };
export default plugin;
```

---

## 4. 标准消费姿势

`code-sandbox` 通常是**可选依赖**：consumer 把它声明在 `inject.optional`，运行时取不到就 fail-closed。
`code_runner` 就是这么做的（[`tool-code-runner/src/index.ts:15-19`](../../packages/plugin-tool-code-runner/src/index.ts)）：

```ts
export const inject = {
  required: ['storage', 'process'],
  optional: ['code-sandbox'],
};
```

### lazy getService + fail-closed
**每次用都重新取**（不要把服务句柄缓存进类字段——provider 替换/bounce 会让旧引用失效，见
[惰性服务访问](../concepts/lazy-service-access.md)）。`code_runner` 在每次工具调用前经 `createRunnerConfig`
重新 `useCodeSandbox(ctx)`（[`index.ts:174`](../../packages/plugin-tool-code-runner/src/index.ts)），
再在 `runCode` 里检查 `available`：

```ts
// runner.ts:75-101（节选）
const policy = config.sandbox
  ? { fsRead: [config.cwd], fsWrite: [config.cwd, tmp.path], network: config.sandbox.network }
  : undefined;

// fail-closed：要求隔离但本机无可用后端 → 拒绝执行（不静默裸跑）
if (policy && !config.codeSandbox?.available) {
  return { exitCode: -1, stdout: '', stderr: '',
    error: `代码执行已禁用（沙箱不可用，backend=${config.codeSandbox?.backend ?? 'none'}）：…` };
}

const result = policy
  ? await config.codeSandbox!.run({ cmd: interpreter, args: [...extraArgs, scriptPath],
      cwd: config.cwd, env, timeout: effectiveTimeout, policy })
  : await proc.execFile(interpreter, [...extraArgs, scriptPath], { cwd: config.cwd, env, timeout });
```

要点：
- **`policy` 用本次运行实际解析出的本地路径构造**（`config.cwd` 来自 `storage.resolveLocalPath`，
  `index.ts:170`；`tmp.path` 来自 `proc.makeTempDir`，`runner.ts:67`）。这样路径随运行时变化，
  将来 storage 按 session 命名空间化后会自动变 per-session 隔离。
- **要求隔离就别给退路**：consumer 必须自己实现 fail-closed——`available` 为假直接拒绝，
  不要回退到 `proc.execFile` 裸跑。`code_runner` 只有在 owner 显式把配置设成 `sandbox.mode='none'`
  时才走无 `policy` 的裸进程分支（每次启动告警，`index.ts:182-186`）。

### 错误边界
`run()` 与 `ProcessService.execFile` 同约定——**非零退出 reject、错误对象挂 `.result`**。
`code_runner` 的处理（[`runner.ts:112-132`](../../packages/plugin-tool-code-runner/src/runner.ts)）：

```ts
} catch (err) {
  const e = err as Error & { result?: { code; signal; stdout; stderr } };
  if (e.result) {
    const timedOut = e.result.signal === 'SIGKILL';  // 超时被杀
    return { exitCode: e.result.code ?? -1, stdout: …, stderr: …, ...(timedOut ? { timedOut: true } : {}) };
  }
  return { exitCode: -1, stdout: '', stderr: '', error: e.message };  // 进程根本没起来
}
```

---

## 5. 能力 / 风险 → 影响

`code-sandbox` 是 Aalis 安全模型里**对抗不可信代码**的那道 OS 减速带，写两端都要懂它的边界。
威胁模型：LLM 生成的脚本属于**不可信代码**——把 LLM 当会被提示注入收买的内鬼
（[安全模型 §1](../concepts/security-model.md)）。`code_runner` 的两个工具 `run_python` / `run_javascript`
都标了 `visibility: 'restricted'`（[`index.ts:244`、`295`](../../packages/plugin-tool-code-runner/src/index.ts)），
受 [权限两轴](../core/authority.md) 闸门约束。

参考实现 `code-sandbox-os` **强制**（[`sandbox.ts`](../../packages/plugin-code-sandbox-os/src/sandbox.ts)）：

- **写限定**：只放行 `policy.fsWrite`，其余只读（Seatbelt `(deny default)` + `(allow file-write* (subpath …))`
  仅白名单，`sandbox.ts:42`；bwrap `--ro-bind / /` + `--bind` 写白名单，`sandbox.ts:84`）。
- **网络粗粒度开关**：`policy.network==='deny'` 默认断网（Seatbelt `(deny network*)`、bwrap `--unshare-all`
  含 net 命名空间隔离，`sandbox.ts:43`、`83`）；`'allow'` 才放开——**无法按域名过滤**。
  注意：这与 owner 自己的网络出口 [safeFetch](../concepts/security-model.md)（SSRF 防护）是两套机制；
  沙箱内 `'allow'` 的子进程网络**不经 safeFetch 的内网防护**，能联网就能打内网。
- **env 清零仅留白名单**：`sandbox-exec … env -i <白名单>` / bwrap `--clearenv --setenv`，
  防宿主 secrets 泄漏给不可信代码（`sandbox.ts:7`、`56`、`80`）。consumer 传 `env` 时要明确只放安全键
  （`code_runner` 的 `safeEnv()` 只保留 `PATH/LANG/...` 等，`index.ts:151-158`）。

provider 实现必须落实这三条强制语义；consumer 必须传一个**收紧的** `policy`
（`fsWrite` 最小化、默认 `network: 'deny'`、`env` 白名单）才有意义。

---

## 6. 边界与坑（v1 真实限制）

契约在 [`code-sandbox-api/src/index.ts:18-19`](../../packages/plugin-code-sandbox-api/src/index.ts) 明写了 v1 语义，
安全模型 [§4](../concepts/security-model.md) 也单列了这道边界：

- **不防「读取本机其它文件」**：v1 后端**读放开**（解释器需要系统库），`policy.fsRead` 目前是**信息性**的，
  预留给将来更严格的读限定实现。要防读需要更强的 **WASM / microVM** 后端。所以**不要把不该被读到的 secrets
  放进沙箱进程能访问的路径**——别指望沙箱挡读。
- **不是强隔离**：这是 OS 级减速带，不防内核漏洞 / 提权 / sandbox 逃逸，不等于 gVisor / 虚拟机级隔离。
- **storage 不是沙箱**：`resolveLocalPath(uri)` 把 storage URI 解析成 OS 绝对路径交给子进程后，
  storage 那层的 root 校验对子进程**毫无约束力**——真正的隔离全靠这里的 OS 沙箱
  （见 [安全模型 §5](../concepts/security-model.md)、[存储 URI 文法](../concepts/storage-uri-grammar.md)）。
- **平台覆盖**：参考实现只覆盖 macOS（seatbelt）/ Linux（bwrap）。Windows 等其它平台 `backend='none'`，
  `code_runner` auto 模式会 fail-closed（[`code-sandbox-os/src/index.ts:37`](../../packages/plugin-code-sandbox-os/src/index.ts)）。
- **`env` 不在 `run()` 外层重复传**：参考实现把 env 白名单注入交给 wrapper（`env -i` / `--clearenv --setenv`），
  外层经 `process` 网关 spawn 时**不再传 `env`**——外层启动器进程继承宿主 env 无妨，因为 wrapper 已为内层
  不可信子进程清空（[`code-sandbox-os/src/index.ts:64-67`](../../packages/plugin-code-sandbox-os/src/index.ts)）。
  写 provider 时别把宿主 env 透传到内层。

---

## 7. 交叉链接

- 概念：[服务模型](../concepts/service-model.md)（按名 DI / 同名多实现 / 优先级选择）·
  [惰性服务访问](../concepts/lazy-service-access.md)（每次用都重取）·
  [清单元数据](../concepts/manifest-metadata.md)（`provides`/`inject` 双源）·
  [安全模型](../concepts/security-model.md)（§4 OS 沙箱边界、§5 存储不是沙箱）·
  [存储 URI 文法](../concepts/storage-uri-grammar.md)。
- 核心：[权限两轴（authority）](../core/authority.md)（`restricted` 工具受闸）。
- 相关服务/插件：[`process` 契约](../../packages/plugin-process-api/src/index.ts)（`ExecResult` / spawn 网关）·
  消费方插件 [`plugin-tool-code-runner`](../plugins/plugin-tool-code-runner.md) ·
  参考实现 [`plugin-code-sandbox-os`](../plugins/plugin-code-sandbox-os.md)。
