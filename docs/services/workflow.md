# workflow 服务

## 1. 一句话定位

声明式的「触发器 + DAG」编排引擎：把多步骤任务（工具调用 / 发消息 / 等待 / 派发给 agent）按依赖图拓扑分层并行执行，支持 cron / interval / once / event / manual 多种触发方式。

- 服务注册名：`'workflow'`（`ctx.getService<WorkflowService>('workflow')`）。
- 契约包：`@aalis/plugin-workflow-api`。
- 该契约**有运行时服务**：`-api` 包只导出 interface + DSL 类型 + 事件契约 + helper（`useWorkflowService`），实现由 `@aalis/plugin-workflow` 提供。
- 设计取向（`packages/plugin-workflow-api/src/index.ts:7-13`）：工作流「定义」是用户/AI 资产，存 `workspace`；「运行实例」是运行时记录，存 `data`。

## 2. 契约

### 服务接口

```ts
// packages/plugin-workflow-api/src/index.ts:145-168
export interface WorkflowService {
  /** 列出全部工作流定义 */
  listWorkflows(): WorkflowDef[];
  /** 按 id 获取定义 */
  getWorkflow(id: string): WorkflowDef | undefined;
  /** 注册/覆盖一个工作流定义；persist=true 时同步写入 workspace/workflows/<id>.yaml */
  defineWorkflow(def: WorkflowDef, opts?: { persist?: boolean }): Promise<void>;
  /** 删除工作流（若 persist 文件存在则删除） */
  removeWorkflow(id: string): Promise<boolean>;
  /** 手动触发一次运行；vars 与定义中的 vars 浅合并 */
  runWorkflow(
    id: string,
    vars?: Record<string, unknown>,
    triggerSource?: string,
    /** 调用者身份：经 workflow_run 工具触发时透传，使内部工具按调用者权限裁决（缺省=匿名） */
    caller?: { platform?: string; userId?: string },
  ): Promise<WorkflowRun>;
  /** 取消一个运行中的实例（若执行引擎支持） */
  cancelRun(runId: string): boolean;
  /** 获取运行实例（含历史） */
  getRun(runId: string): WorkflowRun | undefined;
  /** 列出最近 N 个运行实例（按时间倒序） */
  listRuns(limit?: number, workflowId?: string): WorkflowRun[];
}
```

helper（取服务，可能 undefined）：

```ts
// packages/plugin-workflow-api/src/index.ts:172-174
export function useWorkflowService(ctx: Context): WorkflowService | undefined {
  return ctx.getService<WorkflowService>('workflow');
}
```

并通过 declaration merging 把服务名登记进核心 `ServiceTypeMap`（`packages/plugin-workflow-api/src/index.ts:201-205`），使 `getService('workflow')` 得到强类型。

### 工作流定义（DSL）

```ts
// packages/plugin-workflow-api/src/index.ts:92-107
export interface WorkflowDef {
  id: string;            // 唯一 id（文件名/外部引用键）
  name?: string;
  description?: string;
  vars?: Record<string, unknown>;  // 默认变量；运行时可覆盖（浅合并）
  trigger: TriggerSpec;            // manual 表示仅手动调用
  nodes: NodeSpec[];               // DAG 节点
  enabled?: boolean;
}
```

触发器（`packages/plugin-workflow-api/src/index.ts:19-24`）：

```ts
export type TriggerSpec =
  | { type: 'cron'; expr: string }
  | { type: 'interval'; seconds: number }
  | { type: 'once'; runAt: string }
  | { type: 'event'; event: string; filter?: Record<string, unknown> }
  | { type: 'manual' };
```

节点（`packages/plugin-workflow-api/src/index.ts:28-88`）。基础字段 `id` / `type` / `deps?`（上游依赖，空=根节点）/ `out?`（把结果存入 `outputs[out]` 供下游 `{{outputs.<out>}}` 插值）。四种类型：

- `tool`：`{ tool: string; args?: Record<string, unknown> }`——调用已注册工具；`args` 内字符串值会被插值（`:41-47`）。
- `send-message`：`{ sessionId: string; platform?: string; content: string }`——fire-and-forget 发一条消息（`:49-55`）。
- `wait`：`{ seconds: number }`——等待 N 秒（`:57-61`）。
- `agent`：`{ instruction: string; sessionId?: string; platform?: string; timeoutSeconds?: number }`——把指令派发给 agent **并等待本轮回复**，回复文本作为节点结果（`:70-86`，详见 §6）。

### 运行实例

```ts
// packages/plugin-workflow-api/src/index.ts:111-141
export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
export type NodeStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  status: RunStatus;
  triggerSource: string;             // cron:/interval:/event:/manual: ... 前缀
  startedAt: number;
  finishedAt?: number;
  vars: Record<string, unknown>;     // 实例变量（def.vars + trigger payload/运行时传入）
  nodes: NodeRunInfo[];              // 节点运行明细
  error?: string;                    // 整体错误（首个失败的简要）
}
```

### 事件契约

`-api` 通过 declaration merging 往 `AalisEvents` 注入以下事件（`packages/plugin-workflow-api/src/index.ts:178-198`）：

- `'trigger:fired'`：**入站**——由 scheduler / 其它触发源 emit，workflow 订阅。payload 形如 `{ source, type, workflowId?, payload? }`，其中 `payload` 会被透传进运行实例 `vars`。
- `'workflow:run:start'` / `'workflow:run:done'` / `'workflow:run:error'`：以 `WorkflowRun` 为参数，**出站**——workflow 在运行各阶段 emit。
- `'workflow:node:done'`：`{ runId, node: NodeRunInfo }`，每个节点完成时 emit。

`@aalis/plugin-workflow-api/package.json` 标记 `aalis.types: true` 且 keywords 含 `aalis-api`——是纯契约包，非可加载插件。

## 3. 谁提供 / 谁消费

### 参考实现（provider）

唯一一等实现 **`@aalis/plugin-workflow`**：
- 注册：`ctx.provide('workflow', service)`（`packages/plugin-workflow/src/index.ts:503`）。
- 模块拆分：`engine.ts`（DAG 拓扑调度 + 节点执行 + `{{...}}` 插值）、`triggers.ts`（`TriggerManager`，cron/interval/once/event 接线）、`loader.ts`（YAML 定义加载/持久化）、`persistence.ts`（`RunStore` 运行历史滚动写盘）、`index.ts`（服务装配 + AI 工具 + WebUI 页）。
- 依赖（`package.json` `aalis.service` 与 `index.ts:31-36` 双源）：`required: ['cron-engine']`（周期型触发器全部委托 cron-engine，见 §6）；`optional: ['tools', 'storage', 'webui']`。

### 触发源（trigger:fired 的 emit 者）

**`@aalis/plugin-scheduler`** 在执行调度任务时同时广播 `trigger:fired`，供 workflow 订阅（`packages/plugin-scheduler/src/index.ts:471-480`）：

```ts
await ctx.emit('trigger:fired' as any, {
  source: `scheduler:${jobName}`,
  type: rt.config.cron ? 'cron' : 'interval',
  payload: { jobName, sessionId, platform, content },
});
```

注意 scheduler 不直接依赖 workflow-api（事件类型由后者增广，scheduler 用 `as any` 解耦）。

### 典型消费点

- **AI 工具**（同插件内自我消费）：`enableTools` 开启时向 LLM 暴露 `workflow_define` / `workflow_list` / `workflow_run` / `workflow_get_runs` / `workflow_remove`（`packages/plugin-workflow/src/index.ts:525-689`），全部走 `tools` 服务注册（optional 依赖，`getService('tools')` 缺失则跳过，`:506`）。
- **WebUI actions**（同插件内）：`workflowStats` / `listWorkflowsTable` / `listRunsTable` / `triggerWorkflow` / `toggleWorkflow` / `removeWorkflow` / `upsertWorkflowYaml` 等都以 `const svc = ctx.getService<WorkflowService>('workflow')` 取服务、判空降级（`:200-330`）——这是**每次用都重新 getService** 的标准范例。
- 跨插件外部消费者：当前仓内 workflow 服务的主要消费方就是 workflow 自身的工具/WebUI 层 + scheduler 的事件桥；第三方插件可经 `useWorkflowService(ctx)` 编程式触发/查询。

## 4. 写一个 provider

> 多数场景**不需要**自己写 provider——直接用 `@aalis/plugin-workflow` 即可。仅当你要替换执行引擎（如换调度策略、加新节点类型）时才重实现。

### 必须 vs 可选

`WorkflowService` 的 9 个方法都应实现（接口无可选成员）。最小语义：
- `listWorkflows` / `getWorkflow`：返回内存中的定义。
- `defineWorkflow`：校验图（无环、deps 引用合法、节点必填字段齐全）后注册触发器；`persist !== false` 时落盘。
- `runWorkflow`：拓扑执行，返回完整 `WorkflowRun`。**务必透传 `caller` 身份到内部工具调用**（见 §6）。
- `cancelRun` / `getRun` / `listRuns`：运行实例管理（`cancelRun` 可降级为始终返回 false，但参考实现用 cancelToken 真实支持）。

### provides/inject 双源必须同步

DI 靠包清单 + 代码导出**双源**声明（见 [manifest-metadata](../concepts/manifest-metadata.md)）。两处都要写 `provides: ['workflow']`：

`package.json`（参考 `packages/plugin-workflow/package.json` 的 `aalis.service`）：
```jsonc
{
  "keywords": ["aalis", "aalis-plugin"],
  "aalis": {
    "service": {
      "required": ["cron-engine"],
      "optional": ["tools", "storage", "webui"],
      "provides": ["workflow"]
    }
  }
}
```

`src/index.ts` 导出（`packages/plugin-workflow/src/index.ts:29-40`）：
```ts
export const subsystem = 'workflow';
export const provides = ['workflow'];
export const inject = { required: ['cron-engine'], optional: ['tools', 'storage', 'webui'] };
```

### 最小可编译骨架

```ts
import type { Context } from '@aalis/core';
import type { WorkflowDef, WorkflowRun, WorkflowService } from '@aalis/plugin-workflow-api';

export const name = '@yourscope/plugin-workflow-foo';
export const subsystem = 'workflow';
export const provides = ['workflow'];
export const inject = { required: ['cron-engine'], optional: ['tools', 'storage', 'webui'] };

export async function apply(ctx: Context): Promise<void> {
  const defs = new Map<string, WorkflowDef>();
  const runs: WorkflowRun[] = [];

  const service: WorkflowService = {
    listWorkflows: () => [...defs.values()],
    getWorkflow: id => defs.get(id),
    async defineWorkflow(def) {
      // TODO: 校验无环 + deps 合法 + 注册触发器（参考 engine.validateGraph / TriggerManager）
      defs.set(def.id, def);
    },
    async removeWorkflow(id) {
      return defs.delete(id);
    },
    async runWorkflow(id, vars, source, caller) {
      const def = defs.get(id);
      if (!def) throw new Error(`workflow "${id}" 不存在`);
      const run: WorkflowRun = {
        runId: `${id}-${Date.now()}`,
        workflowId: id,
        status: 'running',
        triggerSource: source ?? 'manual',
        startedAt: Date.now(),
        vars: { ...(def.vars ?? {}), ...(vars ?? {}) }, // 浅合并：运行时覆盖默认
        nodes: def.nodes.map(n => ({ id: n.id, type: n.type, status: 'pending' })),
      };
      runs.push(run);
      // TODO: 拓扑执行 def.nodes；工具节点必须带 caller 身份过 authority（见 §6）
      run.status = 'success';
      run.finishedAt = Date.now();
      return run;
    },
    cancelRun: () => false,
    getRun: id => runs.find(r => r.runId === id),
    listRuns: (limit, wfId) => {
      const arr = (wfId ? runs.filter(r => r.workflowId === wfId) : runs)
        .slice()
        .sort((a, b) => b.startedAt - a.startedAt);
      return limit && limit > 0 ? arr.slice(0, limit) : arr;
    },
  };

  ctx.provide('workflow', service);
}
```

### priority / entryId / label

`ctx.provide(name, instance, { priority?, label?, entryId? })`：
- `priority`：默认 `ServicePriority.Backend = 0`。同名服务竞争时 winner = **preference > priority > 注册顺序**（无能力匹配，0.5.0 已移除——能力挂在实例上而非 DI 层）。普通第三方实现保持 `0`，让用户在 WebUI 用 preference 选；要默认压过参考实现才用 `Override = 50`（`ServicePriority` 定义见 `packages/core/src/types/service.ts:27-31`）。
- `entryId`：默认 `ctx.id`，**必须以 `ctx.id` 为前缀**，否则卸载时无法连带注销。
- `label`：WebUI 选择器展示名。

详见 [service-model](../concepts/service-model.md) 与 [core/service](../core/service.md)。

## 5. 标准消费姿势

### lazy getService（不要缓存实例）

提供者重新 `provide` / 切换会使旧实例失效，所以**每次用都重新取**（见 [lazy-service-access](../concepts/lazy-service-access.md)）。参考实现的 WebUI action 就是逐次 `getService`：

```ts
const svc = ctx.getService<WorkflowService>('workflow');
if (!svc) return { ok: false, error: 'workflow 服务未就绪' };
const run = await svc.runWorkflow(id, vars, 'manual:foo', { platform, userId });
```

### 编程式触发

```ts
import { useWorkflowService } from '@aalis/plugin-workflow-api';

const wf = useWorkflowService(ctx);          // 可能 undefined
if (!wf) return;                             // optional 依赖：判空降级
const run = await wf.runWorkflow('daily-report', { date: '2026-06-22' }, 'event:custom');
if (run.status !== 'success') ctx.logger.warn(run.error);
```

### 用事件触发（解耦，推荐跨插件做法）

不直接拿服务，而是 emit `trigger:fired`（像 scheduler 那样）——workflow 订阅后会按 `workflowId` 跑，并把 `payload` 注入 `vars`：

```ts
await ctx.emit('trigger:fired', {
  source: 'myplugin:something',
  type: 'event',
  workflowId: 'my-workflow',
  payload: { foo: 'bar' },   // 工作流里用 {{vars.foo}} 读取
});
```

注意：`trigger:fired` 只有携带 `workflowId` 时才会被执行（`packages/plugin-workflow/src/index.ts:378-383`：`if (!info?.workflowId) return;`）。scheduler 当前广播的 `trigger:fired` **不带 workflowId**，因此那条桥目前不会自动触发任何 workflow——它是为平滑迁移预留的（`scheduler/src/index.ts:467-469` 注释）。

### 错误边界

- `runWorkflow` 在「workflow 不存在 / 已禁用」时**会抛**（`index.ts:393-394`），消费者要兜 try/catch（工具 handler 与 WebUI action 都这么做）。
- DAG 内部某节点失败**不抛到 `runWorkflow`**——整个 run 标记 `failed`、`run.error` 带首个失败原因，`runWorkflow` 仍正常 resolve（`engine.ts:317-322`、`350-352`）。所以判结果要看 `run.status`，不能只靠 try/catch。

## 6. 能力 / 风险 → 影响

### authority：调用者身份透传（核心安全约束）

工作流定义是 owner 资产，但**「谁触发就按谁的权限裁决」**，杜绝借他人 workflow 提权（`packages/plugin-workflow/src/index.ts:421-429`）：

- `workflow_run` 工具触发时把调用者 `{ platform, userId }` 透传给 `runWorkflow` 的 `caller`（`:612-616`），引擎再据此构造 `toolCallContext`，让工作流内部的 `tool` 节点按**调用者**等级过 authority 闸（`engine.ts:147` 把 `toolCallContext` 传给 `tools.execute`）。
- cron / event / once / WebUI「立即运行」触发**无调用者** → 保持匿名（`platform: 'workflow'`、`userId: undefined`），只能跑 `public`（risk safe、minLevel 0）工具（`index.ts:424-428`）。
- provider 作者重实现时**必须保留这条透传链**：否则匿名触发的工作流能跑 owner 才允许的危险工具，等于绕过 [authority](../core/authority.md)。risk{safe/sensitive/dangerous}→minLevel、确认（confirm 轴）等都在 `tools.execute` 那层裁决，workflow 只负责传对身份。

### agent 节点：join 串扰与隔离

`agent` 节点复用 `delegate_to_session` 的 join 机制——emit `inbound:message`（`triggerType: 'proactive'`）前先注册 `agent:turn:after` middleware，按 `sessionId` 捕获首条回复（`engine.ts:185-235`）。约束：
- **同一并行层内不要让多个 agent 节点指向相同的显式 `sessionId`**：`agent:turn:after` 按 sessionId 匹配会串扰捕获（A 拿到 B 的回复）。需要隔离子任务就**省略 sessionId**，引擎自动生成一次性子会话 `workflow:agent:<runId>:<nodeId>`（`engine.ts:188-190`，`-api:74-81` 文档）。
- `source` 含 nodeId（`workflow:<wf>:<nodeId>`）以隔离 agent 的并发 lane，避免同会话两回合互相 abort（`engine.ts:212-214`）。
- 默认 `timeoutSeconds = 120`；超时或 `outcome=error/aborted` → 节点失败（`engine.ts:170,228-233`）。
- 若目标 platform/sessionType 落入 trigger-policy / flow-control 生效 scope，proactive 消息可能被吞，节点会等满超时才失败——放宽 scope 时要为编排消息留通路（`engine.ts:182-183`）。

### 触发器全部委托 cron-engine

`cron` / `interval` 触发器都转成 cron-engine 的 `subscribe`（`interval` → `@every Ns`），与 scheduler 共享整分钟 tick，不再各自 `setInterval`（`triggers.ts:39-62`）。所以 `cron-engine` 是**硬依赖**（`required`）。`once` 用 `setTimeout`、`event` 用 `ctx.on` 订阅（`triggers.ts:64-92`）。

### storage 不是沙盒

定义存 `defsDir`（默认 `workspace:/workflows`）、运行历史存 `runsFile`（默认 `data:/workflow-runs.json`），都走 storage URI（`index.ts:51-77`、`createStorageGateway`）。storage 按 root 做权限位但**不是沙盒**，见 [storage-uri-grammar](../concepts/storage-uri-grammar.md)。`send-message` / `tool` 节点能触达任意会话与已注册工具，等价于 owner 资产的执行面——把 `workflow_define` 暴露给低权限用户即等于给了编排执行能力，注意 authority 配置。

## 7. 边界与坑

- **event 触发的 payload 形态（近期修复）**：`event` 触发时 `TriggerManager` 把监听到的事件参数**包成 `{ args }`** 传给 fire（`triggers.ts:88`：`this.fire(def.id, ..., { args })`），fire 再把它整体作为 `extraVars` 注入运行实例 `vars`（`index.ts:367-374`）。因此事件触发的工作流里要用 **`{{vars.args}}`**（或 `{{vars.args[0].xxx}}` 走路径访问）读取事件负载，而**不是** `{{vars.xxx}}` 直接读事件字段。对比之下 `trigger:fired`（含 webhook/scheduler 桥）的 `info.payload` 是**直接展开**进 vars 的（`index.ts:380`），其字段名直接用 `{{vars.字段}}`。两条入口的 vars 形态不同，写定义时别混。
- **event filter 只做顶层等值匹配**：`filter` 的每个 key 必须在事件第一个参数（顶层）等值命中；payload 不是对象时只有空 filter 通过（`triggers.ts:128-141`）。无嵌套/范围匹配。
- **DAG 失败即停**：任一节点失败，引擎不再调度新批次，未跑的节点标 `skipped`，整 run = `failed`（`engine.ts:330,344-352`）。没有节点级重试 / 部分继续。
- **取消不打断进行中的节点**：`cancelRun` 置 cancelToken，引擎只在**下一批调度前**检查；已 `running` 的节点（尤其 `wait` / `agent` 的阻塞等待）不会被中断（`engine.ts:302,330`）。
- **运行历史是滚动 + 整体重写**：`RunStore` 超过 `maxRuns`（默认 200、最小 10）裁剪最旧，每次变更整体重写文件、写入串行化（`persistence.ts:22-23,41-67`）。历史不是无限审计日志。
- **节点 `output` 截断**：存入 `outputs` 的是完整结果，但 `NodeRunInfo.output` 展示字段截断到 1000 字符（`engine.ts:20,314`）。下游插值用的是完整值，UI 看到的是预览。
- **同名服务无能力选择**：0.5.0 起 DI 不做能力匹配；多个 workflow provider 并存时靠 preference/priority 选，能力信息在实例上自管（见 [service-model](../concepts/service-model.md)）。

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名解析 / 同名竞争）、[lazy-service-access](../concepts/lazy-service-access.md)（每次 getService）、[manifest-metadata](../concepts/manifest-metadata.md)（provides/inject 双源）、[storage-uri-grammar](../concepts/storage-uri-grammar.md)（定义/历史存储）、[security-model](../concepts/security-model.md)、[message-llm-pipeline](../concepts/message-llm-pipeline.md)（agent 节点经 `inbound:message` 接入主链路）。
- 核心：[core/service](../core/service.md)、[core/context](../core/context.md)、[core/plugin](../core/plugin.md)、[core/events](../core/events.md)、[core/authority](../core/authority.md)、[core/tools](../core/tools.md)。
- 相关服务：[services/tools](./tools.md)（`tool` 节点的执行面 + `workflow_*` 工具）、[services/agent](./agent.md)（`agent` 节点的回复 join）、[services/storage](./storage.md)（定义/历史落盘）。相关插件：`@aalis/plugin-scheduler`（`trigger:fired` 触发源）、`@aalis/plugin-cron-engine`（cron/interval 调度底座）。
