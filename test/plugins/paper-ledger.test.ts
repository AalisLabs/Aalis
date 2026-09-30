import { describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { paperBudgetUsage } from '../../packages/plugin-paper/src/budget.js';
import { LedgerStore, type PaperLedger } from '../../packages/plugin-paper/src/ledger.js';

// ════════════════════════════════════════════════════════════
// 白纸账本的落盘（U10a）：写按调用顺序排队，每次写出的是调用 save 那一刻的账本。受理、取消、通知标记
// 「写失败就回滚内存」依赖这一点：排在它前面、晚于这次修改才执行的写不能把被回滚的修改带上磁盘。
// ════════════════════════════════════════════════════════════

const quiet: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quiet,
} as unknown as Logger;

describe('账本落盘', () => {
  it('旧版本 1 日账没有 papers、旧预留没有 paperId 仍可加载并保守计费', async () => {
    const legacy: PaperLedger = {
      version: 1,
      papers: {},
      agents: {},
      tasks: {},
      runs: {},
      alerts: [],
      spend: { '2026-09-27': { global: 80, rooms: {}, users: {} } },
      reserves: { 't-00000001': { cents: 20, day: '2026-09-26', room: 'room', user: 'user' } },
    };
    const storage = { readFile: async () => JSON.stringify(legacy) } as unknown as StorageService;
    const store = new LedgerStore(storage, quiet);
    await store.load();
    expect(store.failure).toBeUndefined();
    expect(paperBudgetUsage(store.data, '2026-09-27', 'n:paper-a')).toEqual({
      spentCents: 0,
      unattributedCents: 80,
      reservedCents: 20,
    });
  });

  it('每次写出的是调用 save 那一刻的账本：排在前面的写不会带出之后才做的修改', async () => {
    const written: PaperLedger[] = [];
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let blocking = true;
    const storage = {
      async readFile() {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      async writeFile(_uri: string, data: string) {
        if (blocking) {
          blocking = false;
          await gate;
        }
        written.push(JSON.parse(data) as PaperLedger);
      },
    } as unknown as StorageService;
    const store = new LedgerStore(storage, quiet);
    await store.load();

    const inFlight = store.save();
    const queued = store.save();
    store.data.papers['n:zz-later'] = { lastClearedAt: 1 };
    const after = store.save();
    release();
    await Promise.all([inFlight, queued, after]);

    expect(written).toHaveLength(3);
    expect(written[1].papers['n:zz-later'], '修改之前调用的写不带这次修改').toBeUndefined();
    expect(written[2].papers['n:zz-later']).toEqual({ lastClearedAt: 1 });
  });
});
