import { describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { RunStore } from '../../packages/plugin-workflow/src/persistence.js';

// ════════════════════════════════════════════════════════════
// RunStore 的写入是链式排队的：dispose 必须等链尾落盘，
// 否则 app.stop() 返回后仍有一次写入在飞（全量测试并行时 rmSync 撞 ENOTEMPTY 就是它）。
// ════════════════════════════════════════════════════════════

const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

describe('RunStore.flushed', () => {
  it('等到排队中的写入全部完成', async () => {
    let writes = 0;
    let inFlight = 0;
    const storage = {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      writeFile: async () => {
        inFlight++;
        await new Promise(r => setTimeout(r, 30));
        inFlight--;
        writes++;
      },
    } as unknown as StorageService;
    const store = new RunStore(storage, 'data:/runs.json', 100, logger);
    await store.init();
    store.markOnceFired('a');
    store.markOnceFired('b');
    expect(writes).toBe(0); // 还在飞
    await store.flushed();
    expect(inFlight).toBe(0);
    expect(writes).toBe(2);
  });
});
