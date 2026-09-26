import { describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { mkConfig, silentLogger } from '../fixtures/authority.js';

// users.json 重读与写盘失败：重读以文件重建内存表，再叠加自上次成功落盘以来改过的键（内存优先）。
// 读取在飞或 storage 离线期间的改动还没进文件，按文件值覆盖就是静默撤回封禁；
// 运行中从文件里删掉的记录则要随重读生效。写盘失败要留下标记，管理入口据此在回执里注明。

/**
 * 内存 users.json：offline 时读写都抛（storage 不在线）。readGate 给出时读卡在闸上：
 * 内容在发起读取时就已取到，闸只推迟交回（字节读完、close 等后续步骤还没走完）
 */
function memStorage(initial: Record<string, { level?: number; note?: string }>) {
  const disk = { text: JSON.stringify({ version: 5, users: initial }) };
  const state: { offline: boolean; readGate?: Promise<void>; writeGate?: Promise<void>; writes: number } = {
    offline: false,
    writes: 0,
  };
  const storage = {
    readFile: async () => {
      const text = disk.text;
      if (state.readGate) await state.readGate;
      if (state.offline) throw new Error('未知存储根: data');
      return text;
    },
    writeFile: async (_uri: string, data: string) => {
      if (state.writeGate) await state.writeGate;
      if (state.offline) throw new Error('未知存储根: data');
      state.writes++;
      disk.text = data;
    },
  } as unknown as StorageService;
  const users = (): Record<string, { level?: number; note?: string }> => JSON.parse(disk.text).users;
  const edit = (next: Record<string, { level?: number; note?: string }>): void => {
    disk.text = JSON.stringify({ version: 5, users: next });
  };
  return { storage, state, users, edit };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>(r => {
    open = () => r();
  });
  return { promise, open };
}

const levelOf = (m: AuthorityManager, userId: string) =>
  m.listUsers().find(u => u.platform === 'onebot' && u.userId === userId)?.level;

describe('UserStore 重读：以文件重建，未落盘的改动以内存为准', () => {
  it('运行中从文件删掉的记录随重读消失，下次保存不写回', async () => {
    const disk = memStorage({ 'onebot:a': { level: 2 }, 'onebot:b': { level: -1 } });
    const m = new AuthorityManager(mkConfig(), silentLogger(), disk.storage);
    await m.init();
    disk.edit({ 'onebot:a': { level: 2 } }); // 手工删掉 b
    await m.init(); // storage 重新上线触发重读

    expect(levelOf(m, 'b'), '重读把文件里没有的旧记录并回来了').toBeUndefined();
    m.setUserLevel({ platform: 'onebot', userId: 'c' }, 1);
    m.save();
    await m.flushed();
    expect(Object.keys(disk.users()).sort()).toEqual(['onebot:a', 'onebot:c']);
  });

  it('重读在飞期间改的是文件里已有的用户：以内存为准并落盘', async () => {
    const disk = memStorage({ 'onebot:x': { level: 3 } });
    const m = new AuthorityManager(mkConfig(), silentLogger(), disk.storage);
    await m.init();
    const g = gate();
    disk.state.readGate = g.promise;
    const reloading = m.init();
    m.setUserLevel({ platform: 'onebot', userId: 'x' }, -1);
    m.save();
    g.open();
    await reloading;
    await m.flushed();

    expect(levelOf(m, 'x'), '重读用文件值盖掉了读取期间的封禁').toBe(-1);
    expect(disk.users()['onebot:x']?.level).toBe(-1);
  });

  it('storage 离线期间的改动与删除：写盘失败有标记，storage 回来重读后仍以内存为准并补写', async () => {
    const disk = memStorage({ 'onebot:x': { level: 3 }, 'onebot:y': { level: -2 } });
    const errors: string[] = [];
    const logger = {
      child: () => logger,
      debug() {},
      info() {},
      warn() {},
      error: (msg: string) => errors.push(msg),
    } as unknown as Logger;
    const m = new AuthorityManager(mkConfig(), logger, disk.storage);
    await m.init();

    disk.state.offline = true;
    m.setUserLevel({ platform: 'onebot', userId: 'x' }, -1);
    m.removeUser('onebot', 'y');
    m.save();
    await m.flushed();
    expect(m.lastSaveFailed, '写盘失败没有留下标记').toBe(true);
    expect(
      errors.some(e => e.includes('保存用户等级数据失败')),
      '写盘失败应记 error',
    ).toBe(true);

    disk.state.offline = false;
    await m.init(); // storage 回来：follow 触发重读，收尾补写
    await m.flushed();

    expect(levelOf(m, 'x')).toBe(-1);
    expect(levelOf(m, 'y'), '离线期间删掉的记录被文件值复活').toBeUndefined();
    expect(disk.users()).toEqual({ 'onebot:x': { level: -1 } });
    expect(m.lastSaveFailed, '写盘成功后应清除失败标记').toBe(false);
  });

  it('写盘成功只清掉快照已含的改动：写在飞时又改的键，重读时仍以内存为准', async () => {
    const disk = memStorage({});
    const m = new AuthorityManager(mkConfig(), silentLogger(), disk.storage);
    await m.init();
    const x = { platform: 'onebot', userId: 'x' };

    const g = gate();
    disk.state.writeGate = g.promise;
    m.setUserLevel(x, 1);
    m.save(); // 快照 x=1，写卡在闸上
    m.setUserLevel(x, 2); // 写在飞时再改，不保存
    g.open();
    await m.flushed();
    disk.state.writeGate = undefined;
    expect(disk.users()['onebot:x']?.level, '前置：文件里是快照值').toBe(1);

    await m.init();
    expect(levelOf(m, 'x'), '快照之后的改动被当成已落盘，重读用文件值盖掉了').toBe(2);
  });

  it('重读与在飞的写重叠：读到写入前的内容、写先成功，刚写入的封禁仍以内存为准', async () => {
    const disk = memStorage({ 'onebot:x': { level: 3 } });
    const m = new AuthorityManager(mkConfig(), silentLogger(), disk.storage);
    await m.init();

    const w = gate();
    disk.state.writeGate = w.promise;
    m.setUserLevel({ platform: 'onebot', userId: 'x' }, -1);
    m.save(); // 快照 x=-1，写卡在闸上
    const r = gate();
    disk.state.readGate = r.promise;
    const reloading = m.init(); // storage 重新上线触发重读，取到的是写入前的内容
    w.open();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(disk.users()['onebot:x']?.level, '前置：写已落盘').toBe(-1);

    r.open(); // 读的续体此时才跑：写成功已清掉 x 的脏键
    await reloading;
    await m.flushed();
    expect(levelOf(m, 'x'), '重读按写入前的内容重建，撤回了刚写进去的封禁').toBe(-1);

    m.setUserLevel({ platform: 'onebot', userId: 'y' }, 1);
    m.save();
    await m.flushed();
    expect(disk.users()['onebot:x']?.level, '下一次保存把撤回后的旧等级写回了盘上').toBe(-1);
  });

  it('写盘成功后改动不再占优：之后手工改文件，重读以文件为准', async () => {
    const disk = memStorage({});
    const m = new AuthorityManager(mkConfig(), silentLogger(), disk.storage);
    await m.init();
    m.setUserLevel({ platform: 'onebot', userId: 'x' }, 1);
    m.save();
    await m.flushed();

    disk.edit({ 'onebot:x': { level: 4 } });
    await m.init();
    expect(levelOf(m, 'x')).toBe(4);
  });
});
