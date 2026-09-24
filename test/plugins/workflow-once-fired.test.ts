import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { type WorkflowDef, type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { type TriggerCaps, TriggerManager } from '../../packages/plugin-workflow/src/triggers.js';

// ════════════════════════════════════════════════════════════
// once 触发器一生只触发一次：firedAt 与运行历史同落 runsFile，
// 重复注册（workflow_define 再来一次）与重启/重建服务实例都不该再跑。
// 曾经只靠内存里的 setTimeout/setImmediate 记状态，于是"时间已过则立即补触发"
// 在每次注册、每次进程启动时都重放一遍——过期的 once 变成了"每次启动都跑"。
// 真 fs storage + 真 tools + 真插件装卸驱动。
// ════════════════════════════════════════════════════════════

const pastOnce = (id: string): WorkflowDef => ({
  id,
  trigger: { type: 'once', runAt: new Date(Date.now() - 60_000).toISOString() },
  nodes: [{ id: 'a', type: 'tool', tool: 'zz_count' }],
});

const waitUntil = async (pred: () => boolean, timeoutMs = 3000): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return pred();
};

describe('workflow once 触发器只触发一次（真 fs 持久化）', () => {
  let base: string;
  let apps: App[];
  let calls: number;

  const boot = async (): Promise<{ app: App; svc: WorkflowService }> => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await app.plugin(storageLocalPlugin, {
      roots: ['data', 'workspace'].map(name => ({
        name,
        path: join(base, name),
        label: name,
        kind: name === 'data' ? 'data' : 'workspace',
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      })),
    });
    await app.plugin(toolsPlugin, {});
    await app.plugin(cronEnginePlugin, {});
    // 宿主侧登记测试工具：与插件同一套描述符装配，登记归属根激活
    app.bind({ tools: toolsService }).tools.register({
      definition: {
        type: 'function',
        function: { name: 'zz_count', description: '计数', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => {
        calls++;
        return { content: 'ok' };
      },
    });
    await app.plugin(workflowPlugin, { enableTools: false });
    await app.plugins.idle();
    // 插件停在 pending（required 依赖缺席）时会让整条用例悄悄空转，装载后当场判死
    for (const id of [
      '@aalis/plugin-storage-local',
      '@aalis/plugin-tools',
      '@aalis/plugin-cron-engine',
      '@aalis/plugin-workflow',
    ]) {
      const state = app.plugins.getPlugin(id)?.state;
      if (state !== 'active') throw new Error(`插件 "${id}" 未激活（state=${state}）`);
    }
    return { app, svc: app.bind({ services }).services.get(workflow) as WorkflowService };
  };

  /** 读 runsFile 里的 once 记账（文件还没落盘视为空） */
  const readLedger = (): Record<string, number> => {
    try {
      const raw = JSON.parse(readFileSync(join(base, 'data', 'workflow-runs.json'), 'utf-8')) as {
        onceFired?: Record<string, number>;
      };
      return raw.onceFired ?? {};
    } catch {
      return {};
    }
  };

  /** 等 runsFile 里出现该 workflow 的 once 记账（落盘是异步串行链） */
  const waitLedger = (id: string) => waitUntil(() => typeof readLedger()[id] === 'number');

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-wf-once-'));
    mkdirSync(join(base, 'data'), { recursive: true });
    mkdirSync(join(base, 'workspace'), { recursive: true });
    apps = [];
    calls = 0;
  });

  afterEach(async () => {
    for (const a of apps) await a.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('同一 workflow 注册两次，只跑一次', async () => {
    const { svc } = await boot();
    const def = pastOnce('zz-once-twice');

    await svc.defineWorkflow(def, { persist: false });
    await svc.defineWorkflow(def, { persist: false });

    expect(await waitUntil(() => calls >= 1)).toBe(true);
    await new Promise(r => setTimeout(r, 200)); // 留出第二次触发的机会
    expect(calls, '第二次注册不得再触发').toBe(1);
    expect(await waitLedger('zz-once-twice'), 'firedAt 应落进 runsFile').toBe(true);
  });

  it('重建服务实例（同一持久化）后不再跑', async () => {
    const first = await boot();
    await first.svc.defineWorkflow(pastOnce('zz-once-restart'), { persist: true });

    expect(await waitUntil(() => calls >= 1)).toBe(true);
    expect(await waitLedger('zz-once-restart')).toBe(true);
    await first.app.stop();

    // 定义仍在 workspace:/workflows 里，新实例启动时会重新注册这个 once
    await boot();
    await new Promise(r => setTimeout(r, 200));
    expect(calls, '重建后 once 不得重放').toBe(1);
  });

  it('手删定义文件后同 id 重建，可再触发一次', async () => {
    const id = 'zz-once-rebuild';
    const first = await boot();
    await first.svc.defineWorkflow(pastOnce(id), { persist: true });

    expect(await waitUntil(() => calls >= 1)).toBe(true);
    expect(await waitLedger(id)).toBe(true);
    await first.app.stop();

    // 绕开 removeWorkflow 直接删定义文件：这条路清不了账，启动扫描时才补清
    rmSync(join(base, 'workspace', 'workflows', `${id}.yaml`));

    const second = await boot();
    expect(await waitUntil(() => readLedger()[id] === undefined), '定义不存在，记账应随之清除').toBe(true);

    await second.svc.defineWorkflow(pastOnce(id), { persist: true });
    expect(await waitUntil(() => calls >= 2), '同 id 重建算新工作流，应再触发一次').toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// 远期 once：setTimeout 的 delay 超过 2^31-1ms（约 24.8 天）会溢出成立即触发，
// 把"一个月后跑"变成"注册时就跑"。分段重排后必须在真正到点前一次都不触发、不记账。
// 直接驱动 TriggerManager（once 分支只用 logger），配假时钟推进月级时间。
// ════════════════════════════════════════════════════════════

const DAY = 86_400_000;

describe('once 触发器的远期 runAt 分段重排', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runAt = +30 天：推进 25 天不触发不记账，到点才触发一次', () => {
    const fired: string[] = [];
    const ledger = new Map<string, number>();
    const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
    // once 分支只排自己的 setTimeout：cron-engine 与事件总线一旦被碰就当场报错，
    // 免得哪天走岔了路还静默通过
    const unusable = (what: string) => (): never => {
      throw new Error(`once 触发器不应使用 ${what}`);
    };
    const caps: TriggerCaps = {
      cronEngine: {
        current: undefined,
        require: unusable('cron-engine'),
        all: unusable('cron-engine'),
        follow: unusable('cron-engine'),
      },
      events: { on: unusable('事件总线'), emit: unusable('事件总线') },
      logger: noopLogger,
    };
    const tm = new TriggerManager(
      caps,
      id => {
        fired.push(id);
      },
      {
        onceFiredAt: id => ledger.get(id),
        markOnceFired: id => {
          ledger.set(id, Date.now());
        },
      },
    );

    const runAt = new Date(Date.now() + 30 * DAY).toISOString();
    tm.register({
      id: 'zz-once-far',
      trigger: { type: 'once', runAt },
      nodes: [{ id: 'a', type: 'tool', tool: 'zz_count' }],
    } as WorkflowDef);

    // 25 天已越过 setTimeout 上限（24.8 天）：溢出写法在这里就已经触发过了
    vi.advanceTimersByTime(25 * DAY);
    expect(fired, '未到 runAt 不得触发').toEqual([]);
    expect(ledger.has('zz-once-far'), '未触发就不得记账').toBe(false);

    vi.advanceTimersByTime(5 * DAY);
    expect(fired).toEqual(['zz-once-far']);
    expect(ledger.get('zz-once-far')).toBeTypeOf('number');

    // 到点后不再有残留 timer 重复触发
    vi.advanceTimersByTime(5 * DAY);
    expect(fired).toEqual(['zz-once-far']);
    tm.dispose();
  });
});
