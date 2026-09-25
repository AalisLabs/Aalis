import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { mkConfig, silentLogger } from '../fixtures/authority.js';

// 背景：users.json 读/解析失败时只记一行日志、不留失败标记，而 save() 写的是**全量快照**——
// 坏文件 load 之后任何一次等级改动都会把原有封禁/等级记录静默覆盖成「只剩新记录」。
// 契约：区分「文件不存在」（全新，照写）与「文件在但读不出/解析不了」（拒写，保原文件）。

let dir = '';
/** 真 fs 存储：uri 末段即文件名，ENOENT 由真文件系统抛出 */
function fsStorage(): StorageService {
  const pathOf = (uri: string) => join(dir, uri.split('/').pop() ?? 'users.json');
  return {
    readFile: async (uri: string) => readFile(pathOf(uri), 'utf-8'),
    writeFile: async (uri: string, data: string) => writeFile(pathOf(uri), data),
  } as unknown as StorageService;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aalis-user-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('UserStore：加载失败后拒写，不让全量快照吃掉原数据', () => {
  it('坏 JSON（解析失败）：load 后改等级并 save，原文件一字不动', async () => {
    const file = join(dir, 'users.json');
    const broken = '{"version":5,"users":{"onebot:banned":{"level":-5}';
    await writeFile(file, broken);

    const m = new AuthorityManager(mkConfig(), silentLogger(), fsStorage());
    await m.init();
    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    await new Promise(r => setTimeout(r, 20));

    expect(await readFile(file, 'utf-8'), '坏文件不该被新快照覆盖').toBe(broken);
  });

  it('读取失败（非 ENOENT）：同样拒写', async () => {
    const file = join(dir, 'users.json');
    await writeFile(file, '{"version":5,"users":{}}');
    const failing = {
      readFile: async () => {
        throw Object.assign(new Error('EACCES: permission denied, open users.json'), { code: 'EACCES' });
      },
      writeFile: async (_uri: string, data: string) => writeFile(file, data),
    } as unknown as StorageService;

    const m = new AuthorityManager(mkConfig(), silentLogger(), failing);
    await m.init();
    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    await new Promise(r => setTimeout(r, 20));

    expect(await readFile(file, 'utf-8'), '读不出时不该写入').toBe('{"version":5,"users":{}}');
  });

  it('失败 load 后成功 re-load 恢复写入：拒写闸不永久钉死', async () => {
    const file = join(dir, 'users.json');
    await writeFile(file, '{"version":5,"users":{"onebot:banned":{"level":-5}');

    const m = new AuthorityManager(mkConfig(), silentLogger(), fsStorage());
    await m.init(); // 坏文件 → 拒写
    // 人工修好文件（或换上可读的 storage）后再 load：重读成功即恢复落盘
    await writeFile(file, '{"version":5,"users":{"onebot:banned":{"level":-5}}}');
    await m.init();

    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    await new Promise(r => setTimeout(r, 20));

    const data = JSON.parse(await readFile(file, 'utf-8'));
    expect(data.users['onebot:newbie'].level, '重读成功后应恢复写入').toBe(3);
    expect(data.users['onebot:banned'].level, '原有封禁记录仍在').toBe(-5);
  });

  it('重读在飞期间沿用上次的拒写判定：插进来的 save 不覆盖读不懂的原文件', async () => {
    const file = join(dir, 'users.json');
    const legacy = JSON.stringify({ version: 4, users: { 'onebot:bad': { level: -1 } } });
    await writeFile(file, legacy);
    let gate: Promise<void> | undefined;
    let writes = 0;
    const slowReload = {
      readFile: async () => {
        if (gate) await gate;
        return readFile(file, 'utf-8');
      },
      writeFile: async (_uri: string, data: string) => {
        writes++;
        await writeFile(file, data);
      },
    } as unknown as StorageService;

    const m = new AuthorityManager(mkConfig(), silentLogger(), slowReload);
    await m.init(); // 非 v5 → 拒写
    // storage 重新上线时 follow 对同一个 manager 再跑一次 init；读还没回来时插进一次等级改动
    let release = () => {};
    gate = new Promise<void>(r => {
      release = () => r();
    });
    const reloading = m.init();
    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    expect(m.persistBlocked, '重读没读完就把拒写判定清掉了').toBe(true);
    release();
    await reloading;
    await m.flushed();

    expect(writes, '重读在飞时不得按「未失败」放行写入').toBe(0);
    expect(await readFile(file, 'utf-8')).toBe(legacy);
  });

  it('两次 load 重叠：先读完的那次不解除推迟，最后一次读完才补落盘', async () => {
    const file = join(dir, 'users.json');
    await writeFile(file, JSON.stringify({ version: 5, users: { 'onebot:banned': { level: -5 } } }));
    const gates: Array<() => void> = [];
    let writes = 0;
    const gated = {
      readFile: async () => {
        await new Promise<void>(r => gates.push(r));
        return readFile(file, 'utf-8');
      },
      writeFile: async (_uri: string, data: string) => {
        writes++;
        await writeFile(file, data);
      },
    } as unknown as StorageService;

    const m = new AuthorityManager(mkConfig(), silentLogger(), gated);
    const first = m.init();
    const second = m.init(); // storage 换人时 follow 再挂一次，前一次还没读完
    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    gates[0]();
    await first;
    expect(writes, '还有一次 load 在读，不得写盘').toBe(0);
    gates[1]();
    await second;
    await m.flushed();

    expect(writes).toBe(1);
    const data = JSON.parse(await readFile(file, 'utf-8'));
    expect(data.users['onebot:banned'].level).toBe(-5);
    expect(data.users['onebot:newbie'].level).toBe(3);
  });

  it('读取抛出转不成字符串的值：load 照样解除推迟、按读不懂拒写，flushed 能落定', async () => {
    const file = join(dir, 'users.json');
    const original = '{"version":5,"users":{"onebot:banned":{"level":-5}}}';
    await writeFile(file, original);
    let writes = 0;
    const errors: string[] = [];
    const logger = {
      child: () => logger,
      debug() {},
      info() {},
      warn() {},
      error: (msg: string) => errors.push(msg),
    } as unknown as Logger;
    const weird = {
      readFile: async () => {
        throw Object.create(null); // 兜底里的 String(err) 会再抛，readUsersFile 整体 reject
      },
      writeFile: async (_uri: string, data: string) => {
        writes++;
        await writeFile(file, data);
      },
    } as unknown as StorageService;

    const m = new AuthorityManager(mkConfig(), logger, weird);
    await expect(m.init(), '意外异常应交还调用方').rejects.toThrow();
    expect(m.persistBlocked, '文件状态不明，应按读不懂拒写').toBe(true);
    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    // 同步断言在前：推迟没解除时 save 会无声早退，接下来的 flushed 会在微任务里原地打转、连定时器都跑不到
    expect(
      errors.some(e => e.includes('拒绝写入')),
      'save 应当场拒写并记 error，而不是被推迟',
    ).toBe(true);
    await m.flushed();

    expect(writes).toBe(0);
    expect(await readFile(file, 'utf-8')).toBe(original);
  });

  it('errno 为 ENOENT 但文案不含关键词：仍按全新安装照常写入', async () => {
    const file = join(dir, 'users.json');
    const enoentish = {
      readFile: async () => {
        throw Object.assign(new Error('storage: 读取被拒绝'), { code: 'ENOENT' });
      },
      writeFile: async (_uri: string, data: string) => writeFile(file, data),
    } as unknown as StorageService;

    const m = new AuthorityManager(mkConfig(), silentLogger(), enoentish);
    await m.init();
    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    await new Promise(r => setTimeout(r, 20));

    expect(JSON.parse(await readFile(file, 'utf-8')).users['onebot:newbie'].level).toBe(3);
  });

  it('errno 非 ENOENT 但文案含 "not found"：按读不出拒写，不被文案骗过', async () => {
    const file = join(dir, 'users.json');
    await writeFile(file, '{"version":5,"users":{"onebot:banned":{"level":-5}}}');
    const misleading = {
      readFile: async () => {
        throw Object.assign(new Error('EIO: backend not found while reading users.json'), { code: 'EIO' });
      },
      writeFile: async (_uri: string, data: string) => writeFile(file, data),
    } as unknown as StorageService;

    const m = new AuthorityManager(mkConfig(), silentLogger(), misleading);
    await m.init();
    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    await new Promise(r => setTimeout(r, 20));

    expect(await readFile(file, 'utf-8'), '读不出时不该写入').toBe(
      '{"version":5,"users":{"onebot:banned":{"level":-5}}}',
    );
  });

  it('版本为 v5 但 users 结构非法：按解析失败拒写', async () => {
    const file = join(dir, 'users.json');
    const broken = '{"version":5,"users":"onebot:banned"}';
    await writeFile(file, broken);

    const m = new AuthorityManager(mkConfig(), silentLogger(), fsStorage());
    await m.init();
    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    await new Promise(r => setTimeout(r, 20));

    expect(await readFile(file, 'utf-8'), 'v5 坏结构不该被新快照覆盖').toBe(broken);
  });

  it('非 v5（旧的 v4 档位模型）：不丢弃、不覆写，记 error 并拒写', async () => {
    const file = join(dir, 'users.json');
    const legacy = JSON.stringify({ version: 4, users: { 'onebot:banned': { tier: 'blocked' } } });
    await writeFile(file, legacy);
    const errors: string[] = [];
    const logger = {
      child: () => logger,
      debug() {},
      info() {},
      warn() {},
      error: (msg: string) => errors.push(msg),
    } as unknown as Logger;

    const m = new AuthorityManager(mkConfig(), logger, fsStorage());
    await m.init();
    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    await new Promise(r => setTimeout(r, 20));

    expect(await readFile(file, 'utf-8'), 'v4 文件不该被新快照覆盖').toBe(legacy);
    expect(errors.some(e => e.includes('users.json') && e.includes('v5'))).toBe(true);
  });

  it('文件不存在（ENOENT）仍照常写入：拒写闸不误伤全新安装', async () => {
    const m = new AuthorityManager(mkConfig(), silentLogger(), fsStorage());
    await m.init();
    m.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    m.save();
    await new Promise(r => setTimeout(r, 20));

    const data = JSON.parse(await readFile(join(dir, 'users.json'), 'utf-8'));
    expect(data.version).toBe(5);
    expect(data.users['onebot:newbie'].level).toBe(3);
  });
});
