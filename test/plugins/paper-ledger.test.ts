import { describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
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
