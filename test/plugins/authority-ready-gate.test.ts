import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { provide } from '@aalis/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
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
