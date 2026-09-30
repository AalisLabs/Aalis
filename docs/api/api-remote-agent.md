# api-remote-agent — 远端代理契约

**包名**: `@aalis/api-remote-agent`  
**源码**: `packages/api-remote-agent/src/index.ts`  
**实现**: `@aalis/plugin-remote-agent-cursor`

## 概述

本包定义 `remoteAgent` 描述符（服务名 `remote-agent`）、提供者接口 `RemoteAgentProvider`，以及按名取提供者与判定用的几个纯函数，不含实现。远端代理是运行在第三方平台上的长期编码代理：消费方把任务交给它，跟踪每一轮到终态，取回成品，按轮记账。第一方的消费方是白纸枢纽 [plugin-paper](../plugins/plugin-paper.md)。

`remote-agent` 是多提供者服务。每个提供者插件实例对应一个远端账号与模型的组合，各自 `provide(remoteAgent, 实例)`。消费方按配置里写的提供者实例 id 精确取，不用 `current`：偏好与优先级选出的胜者不一定是配置点名的那个，取错提供者就是把任务交给了另一个账号、另一种出网方式。

远端账号的凭据只在提供者所在的宿主进程里用，契约里没有任何接口把它传出。以后接自托管 worker 时，`createAgent` 会按次版本加一个可选的「白纸执行环境」参数，不影响现有提供者。

## 服务接口

```ts
interface RemoteAgentProvider {
  readonly transcriptIsolation: 'shared' | 'per-agent';
  readonly layout: WorkspaceLayout;
  egress(signal: AbortSignal): Promise<EgressReport>;
  ready(signal: AbortSignal): Promise<{ accountKey: string }>;
  mintAgentId(): string;
  createAgent(req: { agentId: string; name: string; prompt: string }, signal: AbortSignal): Promise<{ runId: string; startedAt?: number }>;
  startRun(agentId: string, prompt: string, signal: AbortSignal): Promise<{ runId: string }>;
  followRun(agentId: string, runId: string, opts: { lastEventId?: string; signal: AbortSignal }): AsyncIterable<RunProgress>;
  getRun(agentId: string, runId: string, signal: AbortSignal): Promise<RunState>;
  cancelRun(agentId: string, runId: string, signal: AbortSignal): Promise<void>;
  listRuns(agentId: string, signal: AbortSignal): Promise<RemoteRunSummary[]>;
  runCost(agentId: string, runId: string, signal: AbortSignal): Promise<RunCost | undefined>;
  collectArtifacts(agentId: string, taskId: string, sink: ArtifactSink, limits: ArtifactLimits, signal: AbortSignal): Promise<CollectReport>;
  bundleLink(agentId: string, signal: AbortSignal): Promise<string | undefined>;
  archiveAgent(agentId: string, signal: AbortSignal): Promise<void>;
  unarchiveAgent(agentId: string, signal: AbortSignal): Promise<void>;
  deleteAgent(agentId: string, signal: AbortSignal): Promise<void>;
  listAgents(signal: AbortSignal): Promise<RemoteAgentSummary[]>;
}
```

方法失败时抛 `RemoteAgentError`（`signal` 中止引起的拒绝除外）。各方法的约定：

- `transcriptIsolation`：`shared` 表示同一远端账号下的代理能互读对话（Cursor 即如此），消费方按 `ready()` 报告的 `accountKey` 限制使用它的场合；`per-agent` 表示代理之间互相看不到。
- `layout`：提供者的工作区布局，消费方据此写每轮的前言：
  - `workDir`：代理的工作目录；
  - `outDir`：交付目录，每件任务的成品放在 `${outDir}/<任务 id>/`；
  - `bundlePath`：每轮结束时的工程包路径；
  - `policyNotes`：提供者特有的约束，逐条写进前言，如不改会影响以后各轮的规则文件、不用定时唤醒工具。
- `egress()`：提供者报告的出网方式，见下文「出网」。取自 owner 配置的立即返回；要问远端接口或执行环境的按次读取，结果由提供者自己缓存。失败时消费方按取不到处理，不当作放行。
- `ready()`：懒连接，做鉴权与模型参数校验。失败抛 `unavailable` 并写明原因。成功结果由提供者缓存，消费方可以频繁调用（受理、出队与诊断都直接调它，不另设缓存）。`accountKey` 是远端账号的不透明标识（哈希）：同一账号的实例返回同一个值，值里不含账号原文；账号原文取值范围小时可以枚举反推（如 Cursor 取整数账号的哈希），只用于分组比较，不要展示或记录。
- `createAgent`：用消费方先 `mintAgentId()` 得到的 id 建代理，返回首轮的 `runId`，以及远端首轮开跑的时刻 `startedAt`（毫秒时间戳，远端的时钟；取不到时省略）。远端收到请求就开跑，响应可能要几十秒才回，消费方按 `startedAt` 计这一轮的用时与时长上限。同一个 `agentId` 重试是安全的，消费方可以先把 id 记进账本再调用。
- `startRun`：在已有代理上开新一轮。它不幂等：结果未知时（读超时、临时故障）重发可能开出两轮，消费方应先 `listRuns` 认领。
- `followRun`：跟踪一轮直到终态，最后一项必为 `{ kind: 'terminal' }`。断线重连、事件流过期后改为轮询都在提供者内部处理；`progress` 的 `eventId` 供消费方落盘，重启后作为 `lastEventId` 续传。
  进展可附带 `activity`：`action` 为 `planning`、`responding`、`reading`、`writing`、`command` 或 `tool`，`status` 为 `running`、`completed` 或 `failed`；可选 `tool`、`target`、`summary`、`exitCode` 提供管理端详细动作。它描述最近动作，不表示整件任务的完成比例；旧提供者可省略此字段。`record` 是公开执行日志，可记录代理回复、工具调用和连接事件；消费方应限制它向聊天暴露。
- `cancelRun`：这一轮已到终态时视为成功。
- `runCost`：返回 `undefined` 表示费用暂缺（远端还没结算），消费方应稍后重试。`cents` 是计入额度的花费（美分），消费方的日上限与换新都按它判：远端不另收费的用量（如计划内额度）也按实际消耗计，不能写 0。
- `collectArtifacts`：只取这件任务交付目录下的文件与工程包，去掉前缀后交给消费方的写入口 `sink`。路径不合格、超过上限、取不到下载链接的文件记进 `rejected`，不中断其余文件；临时故障与限流照抛，由消费方整次重来。取回了哪些文件由写入口自己记着。
- `bundleLink`：旧代理工程包的位置，写进新代理的前言、由新代理自己取得：新代理能访问的链接（如临时下载链接），或执行环境不出网时新代理能读的路径。没有工程包返回 `undefined`。
- `deleteAgent`：代理不存在时视为成功。
- `listRuns`、`listAgents`：消费方对账与认领都依赖列表完整；提供者要么翻到底，要么在拿不全时抛错，不能只交出第一页。
- `listAgents`：列出账号下的代理；提供者可以按 owner 配置排除 owner 自管的代理，消费方对账时不把它们当成账本外的代理。

## 类型

```ts
type EgressMode = 'none' | 'allowlist' | 'open' | 'unknown';
type EgressCeiling = Exclude<EgressMode, 'unknown'>;
interface EgressReport {
  mode: EgressMode;
  source: 'provider-api' | 'owner-config';
}

type RunStatus = 'creating' | 'running' | 'finished' | 'error' | 'cancelled' | 'expired';
interface RunState { runId: string; status: RunStatus; resultText?: string }
interface RunActivity {
  action: 'planning' | 'responding' | 'reading' | 'writing' | 'command' | 'tool';
  status: 'running' | 'completed' | 'failed';
  tool?: string; target?: string; summary?: string; exitCode?: number;
}
interface RunLogEntry {
  type: 'assistant' | 'tool' | 'connection';
  text?: string; callId?: string; tool?: string;
  status?: 'running' | 'completed' | 'failed';
  input?: unknown; output?: unknown;
}
type RunProgress =
  | { kind: 'progress'; eventId: string; activity?: RunActivity; record?: RunLogEntry }
  | { kind: 'log'; record: RunLogEntry }
  | { kind: 'terminal'; state: RunState };
interface RunCost { cents: number }

interface ArtifactLimits { maxFileBytes: number; maxRunBytes: number; maxRunFiles: number; maxBundleBytes: number }
interface ArtifactSink {
  putFile(rel: string, data: Uint8Array): Promise<void>;
  putBundle(data: Uint8Array): Promise<void>;
}
interface CollectReport {
  rejected: Array<{ path: string; reason: string }>;
}

interface RemoteAgentSummary { agentId: string; name: string }
interface RemoteRunSummary { runId: string; status: RunStatus }
```

`ArtifactSink` 由消费方提供。写入口不只信提供者：它按同一个 `artifactRelProblem` 对 `rel` 再判一次，并做上限检查，不合格就抛错，提供者把这个文件记进 `rejected`。`resultText` 是远端代理这一轮最后的文字说明，属于远端控制的内容，消费方应按不可信数据处理。`RunLogEntry` 的工具 `input` / `output` 保留结构与细节，仅清洗已知密钥和常见凭据；`sanitizeRunLog` 不能识别任意秘密。`log` 事件没有 SSE id，不推进续传位置。

### 出网

`EgressReport.source` 说明这份报告从哪里来：`provider-api` 是提供者从远端接口读到的；`owner-config` 是取自 owner 写的配置，Aalis 无法核实，展示方应标「未核实」。出网方式从严到宽依次是 `none`、`allowlist`、`open`，`unknown` 与 `open` 同级。

### 错误

```ts
type RemoteAgentErrorCode =
  | 'unavailable' | 'busy' | 'archived' | 'not-found' | 'rate-limited' | 'rejected' | 'transient';

class RemoteAgentError extends Error {
  readonly code: RemoteAgentErrorCode;
  readonly retryAfterMs?: number;
  constructor(code: RemoteAgentErrorCode, message: string, options?: ErrorOptions & { retryAfterMs?: number });
}
```

| 错误码 | 含义 |
|---|---|
| `unavailable` | 提供者不能用（鉴权失败、模型或参数不成立），`message` 写明原因 |
| `busy` | 代理上已有一轮在跑 |
| `archived` | 代理已归档，先 `unarchiveAgent` |
| `not-found` | 代理或这一轮不存在 |
| `rate-limited` | 远端限流，`retryAfterMs` 给出要等多久 |
| `rejected` | 远端拒绝这次请求，原样重试没有用 |
| `transient` | 断线、超时、远端临时故障，可以重试 |

`message` 与 `cause` 里不得带凭据或预签名链接的查询串。

## 函数

```ts
function resolveRemoteAgent(source: ServiceRef<RemoteAgentProvider>, type: string): RemoteAgentEntry | undefined;
function egressWithin(report: EgressReport, ceiling: EgressCeiling): boolean;
function artifactRelProblem(rel: string): string | undefined;
function isTerminalRun(status: RunStatus): boolean;
function isRemoteAgentError(err: unknown): err is RemoteAgentError;

interface RemoteAgentEntry { instance: RemoteAgentProvider; contextId: string; label?: string }
```

- `resolveRemoteAgent`：在 `source.all()` 里找 `contextId` 与 `type` 完全相同的那一项。找不到返回 `undefined`，不回落到 `current`、`all()[0]` 或别的提供者，也不按前缀匹配。
- `egressWithin`：报告的出网方式是否不超过上限，`unknown` 按 `open` 算；`source` 不影响判定。认不出的取值一律判为超过。
- `artifactRelProblem`：成品相对路径（去掉交付目录前缀之后）能否交给写入口，不能时返回原因：空路径、绝对路径、反斜杠、控制字符与不可见的格式字符、`..`、空段与 `.` 段。提供者与写入口都按它判定。
- `isTerminalRun`：`finished`、`error`、`cancelled`、`expired` 为终态；认不出的状态判为非终态。
- `isRemoteAgentError`：按 `name` 认提供者抛出的 `RemoteAgentError`。进程里装有两份本包时，提供者抛出的是它解析到的那份类，换一份做 `instanceof` 不成立，消费方应当用这个函数。

## 获取方式

```ts
import { remoteAgent, resolveRemoteAgent } from '@aalis/api-remote-agent';
import { definePlugin, lifecycle, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-remote',
  uses: { remoteAgent: optional(remoteAgent), lifecycle },
  apply({ remoteAgent, lifecycle }) {
    // 在需要时按配置写的实例 id 现取；不存在就不做，不换用别的提供者
    async function check(type: string): Promise<string> {
      const entry = resolveRemoteAgent(remoteAgent, type);
      if (!entry) return `远端代理「${type}」不在场`;
      await entry.instance.ready(lifecycle.signal);
      return 'ok';
    }
    void check;
  },
});
```

## 消费方

| 插件 | 用途 | 服务缺席时 |
|---|---|---|
| [plugin-paper](../plugins/plugin-paper.md) | 白纸枢纽：按白纸配置的实例 id 取提供者，开轮、跟踪、取回成品、按轮记账与对账 | 远端任务不开，`paper_task` 回「远端代理不在场」 |

## 实现者

- [@aalis/plugin-remote-agent-cursor](../plugins/plugin-remote-agent-cursor.md) — Cursor Cloud Agents API
