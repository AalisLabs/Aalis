import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { App } from '@aalis/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorityService } from '../../packages/api-authority/src/index.js';
import type { StorageRootInfo, StorageService } from '../../packages/api-storage/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';

// ════════════════════════════════════════════════════════════
// authority apply 的 ready 闸 —— storage 已在线时，apply 返回即等级表已载入
//
// 旧写法 `void authority.init()`：apply 返回后等级表还是空的，这个窗口里的裁决按默认
// 0 级走 —— 封禁用户（负等级）照样通过。窗口短但真实（load 要过一次真 fs 读）。
// 断言刻意**不调 app.plugins.idle()**：要测的就是「apply 自己把加载等完了」，
// 一 idle 就把所有异步收尾都等掉，这条回归会被静默吃掉。
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
  it('useModule 返回即可读到 users.json 里的封禁记录（未调 idle）', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    app.ctx.provide('storage', fsStorage() as never);
    await app.ctx.useModule(authorityPlugin, {});

    const auth = app.ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('authority 服务未注册');
    const banned = auth.listUsers().find(u => u.userId === 'banned');
    await app.stop();

    expect(banned, 'apply 返回时等级表仍是空的 —— 加载没被等待').toBeDefined();
    expect(banned?.level).toBe(-5);
  });
});
