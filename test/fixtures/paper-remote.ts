import {
  type ArtifactLimits,
  type ArtifactSink,
  type CollectReport,
  type EgressReport,
  isTerminalRun,
  RemoteAgentError,
  type RemoteAgentProvider,
  type RemoteAgentSummary,
  type RemoteRunSummary,
  type RunCost,
  type RunProgress,
  type RunState,
  type RunStatus,
  type WorkspaceLayout,
} from '../../packages/api-remote-agent/src/index.js';

// ════════════════════════════════════════════════════════════
// 白纸枢纽运行驱动的替身远端：在内存里模拟一个远端账号（代理、轮次、事件流、费用、成品、工程包），
// 每一步可由用例编排：
//   - intercept[方法] 截住调用（followRun 除外）：拿到默认实现 proceed 与参数，可先后调、改结果、抛错或挂起；
//   - finish / progress / spawnRun 由用例推动轮次，spawnRun 模拟代理自己唤醒出来的账本外轮次；
//   - outputs / bundles 是各任务要交出的成品与各代理的工程包，collectArtifacts 原样交给写入口，
//     不做任何过滤（写入口的净化与上限要由枢纽自己挡）。
// 所有方法都认 signal：中止时抛出 signal.reason。不连任何真实服务。
// ════════════════════════════════════════════════════════════

export interface FakeAgent {
  agentId: string;
  name: string;
  archived: boolean;
  /** 建代理时的首轮前言与之后每轮的前言，按先后 */
  prompts: string[];
}

export interface FakeRun {
  runId: string;
  agentId: string;
  status: RunStatus;
  resultText?: string;
  /** 已发出但还没被 followRun 取走的事件 */
  queue: RunProgress[];
  wake?: () => void;
}

type Method = keyof RemoteAgentProvider;
type Interceptor = (call: { proceed: () => Promise<unknown>; args: unknown[] }) => Promise<unknown> | unknown;

let accountSeq = 0;
/** 代理 id 与轮次 id 全局递增：真实的 id 是 UUID，几个替身之间也不能撞 */
let agentSeq = 0;
let runSeq = 0;

export class ScriptedRemote implements RemoteAgentProvider {
  readonly transcriptIsolation: 'shared' | 'per-agent';
  readonly layout: WorkspaceLayout = {
    workDir: '/agent',
    outDir: '/opt/out',
    bundlePath: '/opt/workspace.tar.gz',
    policyNotes: ['NOTE-RULE-FILES', 'NOTE-NO-TIMERS'],
  };
  /** 远端账号的凭据哨兵：替身自己持有，任何交给远端的前言与账本里都不该出现 */
  readonly secret = 'sk-SENTINEL-0123456789abcdef';
  readonly accountKey: string;
  readonly agents = new Map<string, FakeAgent>();
  readonly runs = new Map<string, FakeRun>();
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly intercept: Partial<Record<Method, Interceptor>> = {};
  /** 任务 id → 这件任务在远端交付目录里的文件（rel 已去掉 <outDir>/<任务 id>/ 前缀） */
  readonly outputs = new Map<string, Array<{ rel: string; data: Uint8Array }>>();
  /** 代理 id → 工程包；有的代理 collectArtifacts 会交出，bundleLink 会给链接 */
  readonly bundles = new Map<string, Uint8Array>();
  /** 每轮的费用；返回 undefined 即暂缺 */
  costOf: (runId: string) => RunCost | undefined = () => ({
    chargedCents: 10,
    inputTokens: 1000,
    cacheReadTokens: 500,
  });

  constructor(opts: { isolation?: 'shared' | 'per-agent'; accountKey?: string } = {}) {
    this.transcriptIsolation = opts.isolation ?? 'per-agent';
    this.accountKey = opts.accountKey ?? `acct-${++accountSeq}`;
  }

  // ----- 用例的控制面 -----

  count(method: string): number {
    return this.calls.filter(c => c.method === method).length;
  }

  /** 某方法的调用序列里第一个参数（通常是 agentId）为 id 的那些调用 */
  callsOn(method: string, id: string): Array<{ method: string; args: unknown[] }> {
    return this.calls.filter(c => c.method === method && c.args[0] === id);
  }

  runsOf(agentId: string): FakeRun[] {
    return [...this.runs.values()].filter(r => r.agentId === agentId);
  }

  /** 推一条进展事件 */
  progress(runId: string): string {
    const run = this.#run(runId);
    const eventId = `ev-${run.queue.length + 1}-${runId}`;
    run.queue.push({ kind: 'progress', eventId });
    run.wake?.();
    return eventId;
  }

  /** 让一轮到终态 */
  finish(runId: string, status: RunStatus = 'finished', resultText?: string): void {
    const run = this.#run(runId);
    if (isTerminalRun(run.status)) return;
    run.status = status;
    run.resultText = resultText;
    run.queue.push({ kind: 'terminal', state: this.#state(run) });
    run.wake?.();
  }

  /** 远端自己开出的一轮（代理自设定时器唤醒）：账本里没有它 */
  spawnRun(agentId: string, status: RunStatus = 'running'): string {
    return this.#newRun(agentId, status).runId;
  }

  /** 远端账号下有一个不是 Aalis 建的代理 */
  addForeignAgent(agentId: string, name: string): void {
    this.agents.set(agentId, { agentId, name, archived: false, prompts: [] });
  }

  /** 直接在远端建好一个代理和它的首轮（模拟崩溃前请求已落到远端） */
  seedAgent(agentId: string, name = 'aalis-paper-seeded'): string {
    this.agents.set(agentId, { agentId, name, archived: false, prompts: [] });
    return this.#newRun(agentId, 'running').runId;
  }

  // ----- RemoteAgentProvider -----

  async egress(): Promise<EgressReport> {
    return { mode: 'allowlist', source: 'owner-config' };
  }

  ready(signal: AbortSignal): Promise<{ accountKey: string }> {
    return this.#call('ready', [], signal, async () => ({ accountKey: this.accountKey }));
  }

  mintAgentId(): string {
    this.calls.push({ method: 'mintAgentId', args: [] });
    return `bc-${String(++agentSeq).padStart(8, '0')}`;
  }

  createAgent(req: { agentId: string; name: string; prompt: string }, signal: AbortSignal): Promise<{ runId: string }> {
    return this.#call('createAgent', [req], signal, async () => {
      const existing = this.agents.get(req.agentId);
      if (existing) {
        const first = this.runsOf(req.agentId)[0];
        if (!first) throw new RemoteAgentError('rejected', '代理已存在但没有首轮');
        return { runId: first.runId };
      }
      this.agents.set(req.agentId, { agentId: req.agentId, name: req.name, archived: false, prompts: [req.prompt] });
      return { runId: this.#newRun(req.agentId, 'running').runId };
    });
  }

  startRun(agentId: string, prompt: string, signal: AbortSignal): Promise<{ runId: string }> {
    return this.#call('startRun', [agentId, prompt], signal, async () => {
      const agent = this.#agent(agentId);
      if (agent.archived) throw new RemoteAgentError('archived', '代理已归档');
      if (this.runsOf(agentId).some(r => !isTerminalRun(r.status)))
        throw new RemoteAgentError('busy', '代理上有一轮在跑');
      agent.prompts.push(prompt);
      return { runId: this.#newRun(agentId, 'running').runId };
    });
  }

  followRun(
    agentId: string,
    runId: string,
    opts: { lastEventId?: string; signal: AbortSignal },
  ): AsyncIterable<RunProgress> {
    this.calls.push({ method: 'followRun', args: [agentId, runId, opts.lastEventId] });
    const run = this.#run(runId);
    const { signal } = opts;
    return {
      [Symbol.asyncIterator]: async function* () {
        while (true) {
          const next = run.queue.shift();
          if (next) {
            yield next;
            if (next.kind === 'terminal') return;
            continue;
          }
          await new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            const onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            run.wake = () => {
              signal.removeEventListener('abort', onAbort);
              run.wake = undefined;
              resolve();
            };
          });
        }
      },
    };
  }

  getRun(agentId: string, runId: string, signal: AbortSignal): Promise<RunState> {
    return this.#call('getRun', [agentId, runId], signal, async () => this.#state(this.#run(runId)));
  }

  cancelRun(agentId: string, runId: string, signal: AbortSignal): Promise<void> {
    return this.#call('cancelRun', [agentId, runId], signal, async () => {
      this.finish(runId, 'cancelled');
    });
  }

  listRuns(agentId: string, signal: AbortSignal): Promise<RemoteRunSummary[]> {
    return this.#call('listRuns', [agentId], signal, async () => {
      this.#agent(agentId);
      return this.runsOf(agentId).map(r => ({ runId: r.runId, status: r.status }));
    });
  }

  runCost(agentId: string, runId: string, signal: AbortSignal): Promise<RunCost | undefined> {
    return this.#call('runCost', [agentId, runId], signal, async () => this.costOf(runId));
  }

  collectArtifacts(
    agentId: string,
    taskId: string,
    sink: ArtifactSink,
    _limits: ArtifactLimits,
    signal: AbortSignal,
  ): Promise<CollectReport> {
    return this.#call('collectArtifacts', [agentId, taskId], signal, async () => {
      const report: CollectReport = { rejected: [] };
      for (const { rel, data } of this.outputs.get(taskId) ?? []) {
        try {
          await sink.putFile(rel, data);
        } catch (err) {
          report.rejected.push({ path: rel, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      const bundle = this.bundles.get(agentId);
      if (bundle) {
        try {
          await sink.putBundle(bundle);
        } catch (err) {
          report.rejected.push({ path: 'bundle', reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return report;
    });
  }

  bundleLink(agentId: string, signal: AbortSignal): Promise<string | undefined> {
    return this.#call('bundleLink', [agentId], signal, async () =>
      this.bundles.has(agentId) ? `https://bundle.invalid/${agentId}.tar.gz?sig=BUNDLE-SIG` : undefined,
    );
  }

  archiveAgent(agentId: string, signal: AbortSignal): Promise<void> {
    return this.#call('archiveAgent', [agentId], signal, async () => {
      this.#agent(agentId).archived = true;
    });
  }

  unarchiveAgent(agentId: string, signal: AbortSignal): Promise<void> {
    return this.#call('unarchiveAgent', [agentId], signal, async () => {
      this.#agent(agentId).archived = false;
    });
  }

  deleteAgent(agentId: string, signal: AbortSignal): Promise<void> {
    return this.#call('deleteAgent', [agentId], signal, async () => {
      if (!this.agents.delete(agentId)) return;
      for (const run of this.runsOf(agentId)) {
        this.finish(run.runId, 'cancelled');
        this.runs.delete(run.runId);
      }
    });
  }

  listAgents(signal: AbortSignal): Promise<RemoteAgentSummary[]> {
    return this.#call('listAgents', [], signal, async () =>
      [...this.agents.values()].map(a => ({ agentId: a.agentId, name: a.name })),
    );
  }

  // ----- 内部 -----

  async #call<T>(method: Method, args: unknown[], signal: AbortSignal, impl: () => Promise<T>): Promise<T> {
    this.calls.push({ method, args });
    if (signal.aborted) throw signal.reason;
    const interceptor = this.intercept[method];
    const out = interceptor ? await interceptor({ proceed: impl, args }) : await impl();
    if (signal.aborted) throw signal.reason;
    return out as T;
  }

  #agent(agentId: string): FakeAgent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new RemoteAgentError('not-found', `代理 ${agentId} 不存在`);
    return agent;
  }

  #run(runId: string): FakeRun {
    const run = this.runs.get(runId);
    if (!run) throw new RemoteAgentError('not-found', `轮次 ${runId} 不存在`);
    return run;
  }

  #newRun(agentId: string, status: RunStatus): FakeRun {
    const run: FakeRun = { runId: `run-${++runSeq}-${agentId}`, agentId, status, queue: [] };
    this.runs.set(run.runId, run);
    return run;
  }

  #state(run: FakeRun): RunState {
    return { runId: run.runId, status: run.status, ...(run.resultText ? { resultText: run.resultText } : {}) };
  }
}

/** 一次性截获：只截下一次调用，之后恢复默认 */
export function once(remote: ScriptedRemote, method: Method, fn: Interceptor): void {
  remote.intercept[method] = call => {
    delete remote.intercept[method];
    return fn(call);
  };
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
export const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
export const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);
export const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
export const text = (s: string) => new TextEncoder().encode(s);
