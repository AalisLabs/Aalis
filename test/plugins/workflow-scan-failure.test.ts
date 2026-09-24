import { describe, expect, it } from 'vitest';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';

// ════════════════════════════════════════════════════════════
// once 记账按「现存定义集」清账：列目录失败那次启动看到的是空集，曾据此把记账全清——
// 下次启动所有过期 once 全部重放。目录不存在（ENOENT）是真正的零定义，照常清。
// ════════════════════════════════════════════════════════════

const RUNS_FILE = 'data:/workflow-runs.json';

function fakeStorage(listError: string) {
  const files = new Map<string, string>();
  files.set(RUNS_FILE, JSON.stringify({ runs: [], onceFired: { 'zz-old': 1 } }));
  const root = (name: string, kind: string) => ({
    name,
    label: name,
    kind,
    browsable: true,
    readable: true,
    writable: true,
    deletable: true,
  });
  return {
    files,
    service: {
      listRoots: () => [root('data', 'data'), root('workspace', 'workspace')],
      async list(uri: string): Promise<never> {
        throw new Error(`${listError} ${uri}`);
      },
      async readFile(uri: string) {
        const v = files.get(uri);
        if (v === undefined) throw new Error(`ENOENT: ${uri}`);
        return v;
      },
      async writeFile(uri: string, data: string | Buffer) {
        files.set(uri, typeof data === 'string' ? data : data.toString('utf-8'));
      },
    },
  };
}

/** 启动一次 workflow 插件再停掉（dispose 等落盘），返回 runsFile 里的 once 记账 */
async function bootOnce(listError: string): Promise<Record<string, number>> {
  const store = fakeStorage(listError);
  const app = new App({ name: 'T', logLevel: 'error' });
  // 宿主侧提供桩 storage：只实现本用例走到的那几个方法
  app.bind({ provide }).provide(storage, store.service as never);
  await app.plugin(cronEnginePlugin, {});
  await app.plugin(workflowPlugin, { enableTools: false });
  await app.plugins.idle();
  // 插件停在 pending（required 依赖缺席）时，"没清账" 会因为根本没启动而恒真
  for (const id of ['@aalis/plugin-cron-engine', '@aalis/plugin-workflow']) {
    const state = app.plugins.getPlugin(id)?.state;
    if (state !== 'active') throw new Error(`插件 "${id}" 未激活（state=${state}）`);
  }
  await app.stop();
  return (JSON.parse(store.files.get(RUNS_FILE) as string) as { onceFired: Record<string, number> }).onceFired;
}

describe('workflow once 记账与定义扫描', () => {
  it('列目录失败（EACCES）那次启动不清账', async () => {
    expect(await bootOnce('EACCES: permission denied, scandir')).toEqual({ 'zz-old': 1 });
  });

  it('目录不存在（ENOENT）= 零定义，记账照常清', async () => {
    expect(await bootOnce('ENOENT: no such file or directory, scandir')).toEqual({});
  });
});
