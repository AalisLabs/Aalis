import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { type WorkflowDef, type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import { App, type Logger, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { WorkflowLoader } from '../../packages/plugin-workflow/src/loader.js';
import { RunStore } from '../../packages/plugin-workflow/src/persistence.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// workflow 的运行历史（含 once 记账）是整份快照：读不懂时必须拒写，once 也不能据空记账安排。
// 曾经的三处缺口：
// - 「不存在」只看文案：带 EACCES 等 code 但文案含 not found 的错误被当成全新，整份覆盖；
//   读与解析在同一个 try 里，短坏文件的原文（如 `Not Found`）进了解析报错文案，同样被当成全新。
// - 合法 JSON 但结构不对（null、数组、runs 不是数组）静默按空处理，下一次写覆盖。
// - 记账读不出的那次运行里 onceFired 为空，runAt 已过的 once 被补触发——每次重启都重放一次。
// ════════════════════════════════════════════════════════════

const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

/** 假 storage：readFile 按给定方式失败或返回内容，只数 writeFile 次数 */
function runStoreWith(read: () => Promise<string>) {
  let writes = 0;
  const storage = {
    readFile: read,
    writeFile: async () => {
      writes++;
    },
  } as unknown as StorageService;
  const store = new RunStore(storage, 'data:/workflow-runs.json', 100, logger);
  return { store, writes: () => writes };
}

/** init 后触发一次整份写（markOnceFired），等写链落完，返回写入次数与记账可信度 */
async function initAndWrite(read: () => Promise<string>) {
  const { store, writes } = runStoreWith(read);
  await store.init();
  store.markOnceFired('zz-a');
  await store.flushed();
  return { writes: writes(), readable: store.onceLedgerReadable() };
}

describe('RunStore 加载三态', () => {
  it('文件不存在（code ENOENT，文案不含关键词）：按全新照常落盘', async () => {
    const r = await initAndWrite(async () => {
      throw coded('ENOENT', '文件缺失');
    });
    expect(r).toEqual({ writes: 1, readable: true });
  });

  it('非 ENOENT 的 code、文案却含 not found：读不懂，拒写', async () => {
    const r = await initAndWrite(async () => {
      throw coded('EACCES', 'EACCES: credentials not found, open data:/workflow-runs.json');
    });
    expect(r).toEqual({ writes: 0, readable: false });
  });

  it('文件内容恰为 `Not Found`：解析失败不进「不存在」判据，拒写', async () => {
    const r = await initAndWrite(async () => 'Not Found');
    expect(r).toEqual({ writes: 0, readable: false });
  });

  it.each([
    'null',
    '[]',
    '"x"',
    '{"runs":{}}',
    '{"runs":null}',
    '{"onceFired":[1]}',
    '{"onceFired":"x"}',
  ])('合法 JSON 但结构不对（%s）：拒写', async content => {
    const r = await initAndWrite(async () => content);
    expect(r).toEqual({ writes: 0, readable: false });
  });

  it('空对象与完整形状照常读入、照常写', async () => {
    expect(await initAndWrite(async () => '{}')).toEqual({ writes: 1, readable: true });
    const full = await initAndWrite(async () => JSON.stringify({ runs: [], onceFired: { 'zz-b': 1 } }));
    expect(full).toEqual({ writes: 1, readable: true });
  });
});

describe('WorkflowLoader 扫描判据', () => {
  const loaderWith = (listError: unknown) =>
    new WorkflowLoader(
      {
        list: async () => {
          throw listError;
        },
      } as unknown as StorageService,
      'workspace:/workflows',
      logger,
    );

  it('列目录报错带非 ENOENT 的 code、文案含 not found：扫描失败（不据空集清 once 记账）', async () => {
    expect(await loaderWith(coded('EACCES', 'bucket not found')).loadAll()).toBe(false);
  });

  it('目录不存在（code ENOENT）：扫描成功、零定义', async () => {
    expect(await loaderWith(coded('ENOENT', '目录缺失')).loadAll()).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// once 记账读不出时本次运行不安排任何 once：真 storage-local + 真 tools + 真插件装卸。
// ════════════════════════════════════════════════════════════

const ONCE_YAML = `id: zz-once
trigger:
  type: once
  runAt: '2020-01-01T00:00:00Z'
nodes:
  - id: a
    type: tool
    tool: zz_count
`;

/** 给补触发的 setImmediate 与一次工作流运行留足时间 */
const settle = () => new Promise(r => setTimeout(r, 300));

describe('workflow：once 记账读不出时不安排 once', () => {
  let base: string;
  let app: App;
  let calls: number;

  const runsPath = () => join(base, 'data', 'workflow-runs.json');

  const boot = async (): Promise<WorkflowService> => {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(storageLocalPlugin, {
      roots: ['workspace', 'data'].map(name => ({
        name,
        path: join(base, name),
        label: name,
        kind: name,
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      })),
    });
    await app.plugin(toolsPlugin, {});
    await app.plugin(cronEnginePlugin, {});
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
    const state = app.plugins.getPlugin('@aalis/plugin-workflow')?.state;
    if (state !== 'active') throw new Error(`workflow 未激活（state=${state}）`);
    return app.bind({ services }).services.get(workflow) as WorkflowService;
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-wf-ledger-'));
    mkdirSync(join(base, 'data'), { recursive: true });
    mkdirSync(join(base, 'workspace', 'workflows'), { recursive: true });
    writeFileSync(join(base, 'workspace', 'workflows', 'zz-once.yaml'), ONCE_YAML);
    calls = 0;
  });

  afterEach(async () => {
    await app?.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('运行历史文件损坏：过期 once 不补触发', async () => {
    writeFileSync(runsPath(), '{"runs":[],"onceFired":{"zz-once":1}');
    const svc = await boot();
    await settle();
    expect(calls, '记账读不出却补触发了已触发过的 once').toBe(0);
    expect(svc.listRuns()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '运行历史文件读不出（EACCES）：过期 once 不补触发',
    async () => {
      writeFileSync(runsPath(), JSON.stringify({ runs: [], onceFired: { 'zz-once': 1 } }));
      chmodSync(runsPath(), 0o000);
      try {
        await boot();
        await settle();
      } finally {
        chmodSync(runsPath(), 0o644);
      }
      expect(calls).toBe(0);
    },
  );

  it('运行期 defineWorkflow 一个过期 once：记账读不出时同样不触发', async () => {
    rmSync(join(base, 'workspace', 'workflows', 'zz-once.yaml'));
    writeFileSync(runsPath(), 'null');
    const svc = await boot();
    const def: WorkflowDef = {
      id: 'zz-once-rt',
      trigger: { type: 'once', runAt: new Date(Date.now() - 60_000).toISOString() },
      nodes: [{ id: 'a', type: 'tool', tool: 'zz_count' }],
    };
    await svc.defineWorkflow(def, { persist: false });
    await settle();
    expect(calls).toBe(0);
  });

  it('对照：运行历史文件不存在时过期 once 照常补触发一次', async () => {
    await boot();
    await expect.poll(() => calls, { timeout: 2000 }).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════
// defsDir / runsFile 只接受 storage URI：旧的相对路径写法不再被归一，直接拒绝激活，
// 否则定义一个都扫不到、运行历史读写全失败，只留几条 warn。
// ════════════════════════════════════════════════════════════

describe('workflow 路径配置只接受 storage URI', () => {
  let app: App;

  afterEach(async () => {
    await app?.stop();
  });

  it.each([
    ['defsDir', 'workspace/workflows'],
    ['runsFile', 'data/workflow-runs.json'],
  ])('%s 写成相对路径（%s）：拒绝激活', async (key, value) => {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(cronEnginePlugin, {});
    await app.plugin(workflowPlugin, { enableTools: false, [key]: value });
    await app.plugins.idle();
    expect(app.plugins.getPlugin('@aalis/plugin-workflow')?.state).toBe('error');
  });
});
