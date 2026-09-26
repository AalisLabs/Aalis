import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { LogHub, provide } from '@aalis/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import type { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import { hostedApp } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// authority apply 的 ready 闸 —— storage 已在线时，apply 返回即等级表已载入
//
// 旧写法 `void authority.init()`：apply 返回后等级表还是空的，这个窗口里的裁决按默认
// 0 级走 —— 封禁用户（负等级）照样通过。窗口短但真实（load 要过一次真 fs 读）。
// 装载**之后**刻意不调 app.plugins.idle()：要测的就是「apply 自己把加载等完了」，
// 一 idle 就把所有异步收尾都等掉，这条回归会被静默吃掉。装载**之前**那次 idle 是另一回事：
// 它只让 App 回到静置，好让这次装载在返回前完成激活。
// ════════════════════════════════════════════════════════════

const ROOT: StorageRootInfo = {
  name: 'data',
  label: 'data',
  kind: 'data',
  browsable: true,
  readable: true,
  writable: true,
  deletable: true,
};

const OWNER = { platform: 'webui', userId: 'console' };

let dir = '';

/** 真 fs 存储：uri 末段即文件名 */
function fsStorage(): StorageService {
  const toPath = (uri: string): string => join(dir, basename(uri));
  return {
    listRoots: () => [ROOT],
    readFile: (uri: string) => readFile(toPath(uri), 'utf-8'),
    writeFile: (uri: string, data: string) => writeFile(toPath(uri), data),
  } as unknown as StorageService;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aalis-authority-ready-'));
  await writeFile(
    join(dir, 'users.json'),
    JSON.stringify({ version: 5, users: { 'onebot:banned': { level: -5, note: '封禁' } } }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('authority：storage 已在线时 apply 等完等级表加载', () => {
  it('装载返回即可读到 users.json 里的封禁记录（未调 idle）', async () => {
    const { app } = hostedApp();
    const host = app.bind({ provide, authority });
    host.provide(storage, fsStorage() as never);
    // provide 触发的反应式 recompute 还在飞时，装载请求会排队、在激活发生前就返回。
    // 先静置一次，下面这次装载才是「返回即 apply 已跑完」——被测的正是 apply 自己。
    await app.plugins.idle();
    await app.plugin(authorityPlugin, {});
    // 激活若被排队，下面读到的空表说明的是「还没轮到激活」，不是「加载没被等待」：
    // 把状态先钉死，免得这条回归换个失败原因继续「红得对不上」。
    expect(app.plugins.getPlugin(authorityPlugin.name)?.state, '装载返回时插件尚未激活').toBe('active');

    const auth = host.authority.current;
    if (!auth) throw new Error('authority 服务未注册');
    const banned = auth.listUsers().find(u => u.userId === 'banned');
    await app.stop();

    expect(banned, 'apply 返回时等级表仍是空的 —— 加载没被等待').toBeDefined();
    expect(banned?.level).toBe(-5);
  });
});

// storage 晚于本插件上线时首载是异步的（apply 无从等待）。save 写的是全量快照：首载还没读完时
// 插进来的一次等级改动若照常落盘，就拿「只有这条改动」的内存表覆盖掉健康的 users.json；
// 首载随后把原记录并回内存，但 dirty 已清，磁盘上一直缺这些记录。
// 管理入口还先等首载落定再改：读完之前内存里查不到文件里的记录，原等级按 0 级算，降权该撤的会话授予会漏撤。
describe('authority：storage 晚于本插件上线，首载在飞时的等级改动', () => {
  it('健康的 users.json 不被残缺快照覆盖，改动在首载完成后落盘', async () => {
    const { app, actions, release, writes } = await bootLateStorage();

    const setUserLevel = actions.get('setUserLevel');
    if (!setUserLevel) throw new Error('页面动作 setUserLevel 未登记');
    // 入口先等首载落定再改，回执要等到落盘之后
    const reply = setUserLevel({ platform: 'onebot', userId: 'newbie', level: 3 }, OWNER);
    await new Promise(r => setTimeout(r, 20));
    expect(writes(), '首载还没读完就写了全量快照').toBe(0);

    release();
    expect(await reply).toEqual({ message: 'onebot:newbie 等级已更新为 3' });
    // 先读盘再停机：停机时的拆卸落盘会把漏掉的补写掩盖掉
    const data = JSON.parse(await readFile(join(dir, 'users.json'), 'utf-8'));
    await app.stop();

    expect(data.users['onebot:banned']?.level, '原有封禁记录被残缺快照冲掉').toBe(-5);
    expect(data.users['onebot:newbie']?.level, '首载期间的改动没有落盘').toBe(3);
  });

  it('改的是文件里已有的用户：等首载读完再改，备注保留、删除生效', async () => {
    await writeFile(
      join(dir, 'users.json'),
      JSON.stringify({ version: 5, users: { 'onebot:x': { level: 5, note: '老朋友' }, 'onebot:y': { level: -1 } } }),
    );
    const { app, actions, release } = await bootLateStorage();

    const setUserLevel = actions.get('setUserLevel');
    const deleteUser = actions.get('deleteUser');
    if (!setUserLevel || !deleteUser) throw new Error('页面动作未登记');
    const replies = Promise.all([
      setUserLevel({ platform: 'onebot', userId: 'x', level: 3 }, OWNER),
      deleteUser({ platform: 'onebot', userId: 'y' }, OWNER),
    ]);
    release();
    await replies;
    const data = JSON.parse(await readFile(join(dir, 'users.json'), 'utf-8'));
    await app.stop();

    expect(data.users['onebot:x'], '首载没读完就改，文件里的备注被丢掉').toEqual({ level: 3, note: '老朋友' });
    expect(data.users['onebot:y'], '首载没读完就删，记录随首载回来').toBeUndefined();
  });

  it('首载读不懂 users.json：首载在飞时改等级，回执照样注明未落盘', async () => {
    const legacy = JSON.stringify({ version: 4, users: { 'onebot:banned': { tier: 'blocked' } } });
    await writeFile(join(dir, 'users.json'), legacy);
    const { app, actions, release } = await bootLateStorage();

    const setUserLevel = actions.get('setUserLevel');
    if (!setUserLevel) throw new Error('页面动作 setUserLevel 未登记');
    const reply = setUserLevel({ platform: 'onebot', userId: 'newbie', level: 3 }, OWNER);
    release();
    const { message } = (await reply) as { message: string };
    await app.stop();

    expect(message).toContain('仅本次运行生效，未写入 users.json');
    expect(await readFile(join(dir, 'users.json'), 'utf-8')).toBe(legacy);
  });
});

// storage 还没上线时首次读取尚未开始，入口无从等待，内存表是空的：删除扑空，改等级也带不上文件里的备注。
// 删除要作为墓碑记下、改等级只盖过内存里有的字段，降为 0 级也要留下记录（记成删除会连同文件里的备注删掉），
// 否则首次读取按文件重建时，删掉的封禁与降为 0 级前的等级又回来，备注被丢掉；回执也不能报成功——这时改动还没写进 users.json。
describe('authority：storage 上线前（首次读取尚未开始）的等级改动', () => {
  it('删记录、降为 0 级、改有备注的用户：回执注明未写入，storage 上线读完后照样生效并落盘，备注保留', async () => {
    await writeFile(
      join(dir, 'users.json'),
      JSON.stringify({
        version: 5,
        users: {
          'onebot:banned': { level: -5 },
          'onebot:mod': { level: 5 },
          'onebot:friend': { level: 1, note: '老朋友' },
          'onebot:pal': { level: 2, note: '同学' },
        },
      }),
    );
    const { app, host, actions } = await bootWithoutStorage();
    const setUserLevel = actions.get('setUserLevel');
    const deleteUser = actions.get('deleteUser');
    if (!setUserLevel || !deleteUser) throw new Error('页面动作未登记');

    const replies = [
      await deleteUser({ platform: 'onebot', userId: 'banned' }, OWNER),
      await setUserLevel({ platform: 'onebot', userId: 'mod', level: 0 }, OWNER),
      await setUserLevel({ platform: 'onebot', userId: 'friend', level: 3 }, OWNER),
      await setUserLevel({ platform: 'onebot', userId: 'pal', level: 0 }, OWNER),
    ] as Array<{ message: string }>;
    for (const { message } of replies)
      expect(message, '改动还没写进 users.json，回执却报成功').toContain('未写入 users.json');

    // storage 上线：follow 随后触发首次读取，读完补写
    const disk = fsStorage();
    let markReading = () => {};
    const reading = new Promise<void>(r => {
      markReading = () => r();
    });
    host.provide(storage, {
      ...disk,
      readFile: (uri: string) => {
        markReading();
        return disk.readFile(uri);
      },
    } as never);
    const manager = host.authority.current as AuthorityManager | undefined;
    if (!manager) throw new Error('authority 服务未注册');
    await reading;
    await manager.flushed();
    const data = JSON.parse(await readFile(join(dir, 'users.json'), 'utf-8'));
    await app.stop();

    expect(data.users['onebot:banned'], '删掉的封禁随首次读取回来').toBeUndefined();
    expect(data.users['onebot:mod']?.level ?? 0, '降为 0 级前的等级随首次读取回来').toBe(0);
    expect(data.users['onebot:friend'], '首次读取前改等级，文件里的备注被丢掉').toEqual({ level: 3, note: '老朋友' });
    expect(data.users['onebot:pal'], '首次读取前降为 0 级，整条记录连同备注被删').toEqual({ level: 0, note: '同学' });
  });

  it('回执注明等级表尚未载入：此时没有写盘，也就谈不上写入失败', async () => {
    const { app, actions } = await bootWithoutStorage();
    const setUserLevel = actions.get('setUserLevel');
    if (!setUserLevel) throw new Error('页面动作 setUserLevel 未登记');
    const { message } = (await setUserLevel({ platform: 'onebot', userId: 'mod', level: 2 }, OWNER)) as {
      message: string;
    };
    await app.stop();

    expect(message).toBe('onebot:mod 等级已更新为 2；未写入 users.json（等级表尚未载入），载入后写入');
  });

  it('storage 上线后首次读取在飞时停机：等读取落定再写入，原有记录保留', async () => {
    const { app, release } = await bootLateStorage(async actions => {
      const setUserLevel = actions.get('setUserLevel');
      if (!setUserLevel) throw new Error('页面动作 setUserLevel 未登记');
      const { message } = (await setUserLevel({ platform: 'onebot', userId: 'newbie', level: 3 }, OWNER)) as {
        message: string;
      };
      expect(message).toContain('等级表尚未载入');
    });

    let stopped = false;
    const stopping = app.stop().then(() => {
      stopped = true;
    });
    await new Promise(r => setTimeout(r, 20));
    expect(stopped, '停机没等进行中的首次读取').toBe(false);
    release();
    await stopping;
    const data = JSON.parse(await readFile(join(dir, 'users.json'), 'utf-8'));

    expect(data.users['onebot:banned']?.level, '原有封禁记录被残缺快照冲掉').toBe(-5);
    expect(data.users['onebot:newbie']?.level, '首次读取在飞时停机，storage 上线前的改动没有写入').toBe(3);
  });
});

// storage 上线后要过几个微任务 follow 才发起首次读取；这段间隙里 storage 已经能写，内存表却还缺文件里的记录。
// 此时保存若照常写盘，全量快照就会覆盖健康的 users.json。
describe('authority：storage 刚上线、首次读取尚未发起时的保存', () => {
  it('不写盘，首次读取落定后按正常路径写入，原有记录保留', async () => {
    const { app, host } = await bootWithoutStorage();
    const manager = host.authority.current as AuthorityManager | undefined;
    if (!manager) throw new Error('authority 服务未注册');
    const disk = fsStorage();
    const events: string[] = [];
    let markReading = () => {};
    const reading = new Promise<void>(r => {
      markReading = () => r();
    });
    host.provide(storage, {
      ...disk,
      readFile: (uri: string) => {
        events.push('read');
        markReading();
        return disk.readFile(uri);
      },
      writeFile: (uri: string, data: string) => {
        events.push('write');
        return disk.writeFile(uri, data);
      },
    } as never);
    // 与 provide 同一同步段：follow 还没发起首次读取
    manager.setUserLevel({ platform: 'onebot', userId: 'newbie' }, 3);
    manager.save();
    await reading;
    await manager.flushed();
    const data = JSON.parse(await readFile(join(dir, 'users.json'), 'utf-8'));
    await app.stop();

    expect(events[0], '首次读取发起前就写了盘').toBe('read');
    expect(data.users['onebot:banned']?.level, '原有封禁记录被残缺快照冲掉').toBe(-5);
    expect(data.users['onebot:newbie']?.level, '首次读取落定后没有补写').toBe(3);
  });
});

/** storage 缺席时装上 authority；返回页面动作登记表 */
async function bootWithoutStorage() {
  const { app } = hostedApp();
  const host = app.bind({ provide, authority });
  const actions = new Map<string, WebuiActionHandler>();
  host.provide(webuiServer, {
    registerPage: () => () => {},
    registerAction: (method: string, handler: WebuiActionHandler) => {
      actions.set(method, handler);
      return () => void actions.delete(method);
    },
  } as never);
  await app.plugins.idle();
  await app.plugin(authorityPlugin, {}); // storage 缺席：apply 不等加载就返回
  await app.plugins.idle();
  return { app, host, actions };
}

/**
 * storage 晚于 authority 上线，首载的读取卡在闸上；返回页面动作登记表与放闸句柄。
 * beforeStorage 在 storage 上线之前执行（此时首次读取尚未开始）。
 */
async function bootLateStorage(beforeStorage?: (actions: Map<string, WebuiActionHandler>) => Promise<void>) {
  const { app, host, actions } = await bootWithoutStorage();
  await beforeStorage?.(actions);

  // storage 随后上线，follow 触发首载；读卡在闸上
  const disk = fsStorage();
  let release = () => {};
  const gate = new Promise<void>(r => {
    release = () => r();
  });
  let markReading = () => {};
  const reading = new Promise<void>(r => {
    markReading = () => r();
  });
  let writes = 0;
  host.provide(storage, {
    listRoots: () => [ROOT],
    readFile: async (uri: string) => {
      markReading();
      await gate;
      return disk.readFile(uri);
    },
    writeFile: async (uri: string, data: string) => {
      writes++;
      await disk.writeFile(uri, data);
    },
  } as never);
  await reading;
  return { app, actions, release, writes: () => writes };
}

// users.json 加载结果的上报本身也可能抛（第三方日志订阅者同步抛错），失败的告警与成功的 debug 都算：
// 不接住的话，storage 已在线时 apply 的 await 抛出、authority 激活失败，受限能力全部 fail-closed。
describe('authority：加载结果的上报自身抛错', () => {
  it('日志订阅者对本插件的告警同步抛错，authority 照常激活', async () => {
    const hub = new LogHub();
    hub.onEntry(entry => {
      if (entry.scope.includes('plugin-authority')) throw new Error('sink 挂了');
    });
    const { app } = hostedApp({ logLevel: 'warn' }, { logHub: hub });
    const host = app.bind({ provide, authority });
    host.provide(storage, {
      listRoots: () => [ROOT],
      readFile: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
      writeFile: async () => undefined,
    } as never);
    await app.plugins.idle();
    await app.plugin(authorityPlugin, {});
    const state = app.plugins.getPlugin(authorityPlugin.name)?.state;
    await app.stop();

    expect(state, '告警抛错让 apply 的加载等待抛出，激活失败').toBe('active');
  });

  it('加载成功后的 debug 日志被订阅者同步抛错，authority 照常激活', async () => {
    const hub = new LogHub();
    hub.onEntry(entry => {
      if (entry.message === '授权用户等级已加载') throw new Error('sink 挂了');
    });
    const { app } = hostedApp({ logLevel: 'debug' }, { logHub: hub });
    const host = app.bind({ provide, authority });
    host.provide(storage, fsStorage() as never);
    await app.plugins.idle();
    await app.plugin(authorityPlugin, {});
    const state = app.plugins.getPlugin(authorityPlugin.name)?.state;
    await app.stop();

    expect(state, '成功回调里的上报抛错让 apply 的加载等待抛出，激活失败').toBe('active');
  });

  it('加载失败的错误值转不成字符串：告警照样记下', async () => {
    const hub = new LogHub();
    const warned: string[] = [];
    hub.onEntry(entry => {
      if (entry.level === 'warn') warned.push(entry.message);
      // 等级表那一层的读失败 error 被订阅者抛出 null 原型对象，它随之成为加载失败的错误值
      if (entry.message.startsWith('读取 users.json 失败')) throw Object.create(null);
    });
    const { app } = hostedApp({ logLevel: 'warn' }, { logHub: hub });
    const host = app.bind({ provide, authority });
    host.provide(storage, {
      listRoots: () => [ROOT],
      readFile: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
      writeFile: async () => undefined,
    } as never);
    await app.plugins.idle();
    await app.plugin(authorityPlugin, {});
    await app.stop();

    expect(
      warned.some(m => m.startsWith('授权用户等级加载失败')),
      '拼接错误值时抛错，告警被兜底静默吞掉',
    ).toBe(true);
  });
});
