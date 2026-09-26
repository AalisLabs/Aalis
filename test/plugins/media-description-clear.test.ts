import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import type {} from '../../packages/api-memory/src/index.js'; // declaration merging：memory:clear 钩子类型
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import {
  flushDescriptionCache,
  lookupCachedDescription,
  rememberDescription,
  rememberDescriptionAlias,
} from '../../packages/plugin-media/src/cache.js';
import media from '../../packages/plugin-media/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 图片描述缓存参与 memory:clear（/clear 与删除会话）。
//
// 带会话语境的描述（contextHistory 开启时，默认即开）以含会话目录的落盘路径为键，
// 也进快照 data:/media/descriptions.json。此前 media 不参与 /clear：回执写「图片缓存已清空」，
// 重启后这些描述照样灌回、同一张截图再发直接命中旧描述。
//
// 模块级缓存与「本次运行是否允许落盘」在同一文件内共享：禁写场景（读快照失败）必须排在
// 任何一次成功灌回之前，故放在第一个 describe。
// ════════════════════════════════════════════════════════════

const SNAPSHOT = 'data:/media/descriptions.json';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

interface StorageOpts {
  /** 模拟快照读不出（非「不存在」） */
  readError?: string;
  /** 让读盘停在半途（内容已读到、结果尚未交回），模拟清理时启动灌回还在途 */
  readGate?: Promise<void>;
  /** 让写盘停在半途，模拟清理时正有一次落盘在途 */
  writeGate?: Promise<void>;
}

/** data 根的内存 storage：读写删 */
function fakeStorage(seed: Record<string, string>, { readError, readGate, writeGate }: StorageOpts) {
  const files = new Map(Object.entries(seed));
  const service = {
    listRoots: () => [
      { name: 'data', label: 'data', kind: 'data', browsable: true, readable: true, writable: true, deletable: true },
    ],
    async readFile(uri: string) {
      if (readError) throw new Error(readError);
      const v = files.get(uri);
      await readGate; // 内容已读到、结果尚未交回
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
      return v;
    },
    async writeFile(uri: string, data: string | Buffer) {
      await writeGate;
      files.set(uri, typeof data === 'string' ? data : data.toString('utf8'));
    },
    async delete(uri: string) {
      if (!files.delete(uri)) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
    },
  };
  return { files, service };
}

async function boot(seed: Record<string, string>, opts: StorageOpts = {}) {
  const store = fakeStorage(seed, opts);
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, hooks });
  host.provide(processService, {} as never);
  host.provide(storage, store.service as never);
  await app.plugin(media, {});
  await app.plugins.idle();
  if (app.plugins.getPlugin(media.name)?.state !== 'active') throw new Error('plugin-media 未激活');
  const clear = async (req: Omit<HookContextMap['memory:clear'], 'results'>) => {
    const data: HookContextMap['memory:clear'] = { ...req, results: [] };
    await host.hooks.run('memory:clear', data, async () => {});
    return data.results.filter(r => r.source === 'media-description');
  };
  return { files: store.files, clear };
}

function gate(): { wait: Promise<void>; release: () => void } {
  let release = () => {};
  const wait = new Promise<void>(resolve => {
    release = resolve;
  });
  return { wait, release };
}

const snapshotKeys = (files: Map<string, string>) =>
  (JSON.parse(files.get(SNAPSHOT) as string) as Array<[string, string]>).map(([k]) => k);

describe('本次运行读快照失败（禁写）', () => {
  it('会话级清理删掉内存条目后如实报失败；全局清理照样删掉快照文件，此后会话级清理不再报失败', async () => {
    const { files, clear } = await boot({ [SNAPSHOT]: '[]' }, { readError: 'EACCES: permission denied' });
    const aPath = 'data:/images/onebot_t_group_A/aaaa1111aaaa1111.jpg';
    rememberDescription(aPath, 'A 群语境', false);

    const session = await clear({ scope: 'session', sessionId: 'onebot:t:group:A' });
    expect(session).toHaveLength(1);
    expect(session[0].success, '磁盘上的旧快照没改写，不能报成功').toBe(false);
    expect(session[0].message).toContain('快照未改写');
    expect(lookupCachedDescription(aPath, false)).toBeNull();

    const all = await clear({ scope: 'all' });
    expect(all).toEqual([expect.objectContaining({ success: true })]);
    expect(files.has(SNAPSHOT), '禁写时也要删掉旧快照，否则重启后描述照样灌回').toBe(false);

    // 快照已删：磁盘上没有会在重启时恢复的描述，会话级清理清完内存即成功（删除会话也不再逐次告警）
    rememberDescription(aPath, 'A 群语境（清空后再识别）', false);
    expect(await clear({ scope: 'session', sessionId: 'onebot:t:group:A' })).toEqual([
      { source: 'media-description', success: true, message: '当前会话图片描述缓存已清空（1 条）' },
    ]);
    expect(lookupCachedDescription(aPath, false)).toBeNull();
    expect(files.has(SNAPSHOT), '禁写运行照样不写快照').toBe(false);
  });
});

describe('会话级清理（/clear 与删除会话）', () => {
  it('只删带本会话语境的条目与指向本会话目录的别名并重写快照；内容哈希键与别的会话保留', async () => {
    const { files, clear } = await boot({});
    const aPath = 'data:/images/onebot_t_group_A/1111aaaa2222bbbb.jpg';
    const aLegacy = 'data/images/onebot_t_group_A/3333aaaa4444bbbb.jpg';
    const bPath = 'data:/images/onebot_t_group_B/5555aaaa6666bbbb.jpg';
    const upload = 'data:image/png;base64,QUFB';
    const uploadRef = 'data/images/onebot_t_group_A/9999aaaa0000bbbb.png';
    rememberDescription(aPath, 'A 群语境', false);
    rememberDescription(aLegacy, 'A 群旧路径（详）', false, 'detailed');
    rememberDescription(bPath, 'B 群语境', false);
    rememberDescription('data:/images/onebot_t_group_A/7777aaaa8888bbbb.jpg', '无语境共享', true);
    rememberDescriptionAlias(upload, uploadRef);
    rememberDescription(upload, 'A 群上传', false);

    expect(await clear({ scope: 'session', sessionId: 'onebot:t:group:A', types: ['vector'] })).toEqual([]);
    expect(lookupCachedDescription(aPath, false), '类型不含 image 时不动').toBe('A 群语境');

    const results = await clear({ scope: 'session', sessionId: 'onebot:t:group:A' });
    expect(results).toEqual([
      { source: 'media-description', success: true, message: '当前会话图片描述缓存已清空（3 条）' },
    ]);
    expect(lookupCachedDescription(aPath, false)).toBeNull();
    expect(lookupCachedDescription(aLegacy, false, 'detailed')).toBeNull();
    expect(lookupCachedDescription(upload, false)).toBeNull();
    expect(lookupCachedDescription(bPath, false)).toBe('B 群语境');
    expect(lookupCachedDescription('data/images/onebot_t_group_C/7777aaaa8888bbbb.jpg')).toBe('无语境共享');
    // 别名已删：同一落盘路径再写一条，按上传来源串查不到
    rememberDescription(uploadRef, '再次识别', false);
    expect(lookupCachedDescription(upload, false)).toBeNull();

    const keys = snapshotKeys(files);
    expect(keys).toContain(bPath);
    expect(keys).toContain('7777aaaa8888bbbb');
    expect(keys.some(k => k.includes('/onebot_t_group_A/'))).toBe(false);
  });

  it('本会话没有带语境的条目 → 回执 0 条，不重写快照', async () => {
    const { files, clear } = await boot({});
    expect(await clear({ scope: 'session', sessionId: 'onebot:t:group:none' })).toEqual([
      { source: 'media-description', success: true, message: '当前会话图片描述缓存已清空（0 条）' },
    ]);
    expect(files.has(SNAPSHOT), '没删掉条目，快照不必重写').toBe(false);
  });
});

describe('全局清理（/clear all）', () => {
  it('类型为空或含 image 时清空内存条目与别名并删掉快照；类型不含 image 时不动', async () => {
    const seeded = JSON.stringify([
      ['cccc0000dddd1111', '上次进程的共享描述'],
      ['data:/images/onebot_t_group_A/eeee0000ffff1111.jpg', '上次进程的 A 群语境'],
    ]);
    const { files, clear } = await boot({ [SNAPSHOT]: seeded });
    const remote = 'https://example.invalid/pic.jpg';
    rememberDescriptionAlias(remote, 'data/images/onebot_t_group_A/1234123412341234.jpg');
    rememberDescription(remote, '经别名的描述');
    await vi.waitFor(() => expect(lookupCachedDescription('data/images/x/cccc0000dddd1111.png')).not.toBeNull());

    expect(await clear({ scope: 'all', types: ['vector'] })).toEqual([]);
    expect(files.has(SNAPSHOT)).toBe(true);

    const results = await clear({ scope: 'all', types: ['image'] });
    expect(results).toEqual([expect.objectContaining({ success: true })]);
    expect(results[0].message).toMatch(/^所有图片描述缓存已清空/);
    expect(files.has(SNAPSHOT)).toBe(false);
    expect(lookupCachedDescription('data/images/x/cccc0000dddd1111.png')).toBeNull();
    expect(lookupCachedDescription('data:/images/onebot_t_group_A/eeee0000ffff1111.jpg', false)).toBeNull();
    expect(lookupCachedDescription(remote)).toBeNull();
    // 别名已清：落盘路径的内容哈希键再有描述，按原始 URL 也查不到
    rememberDescription('data/images/onebot_t_group_A/1234123412341234.jpg', '新描述');
    expect(lookupCachedDescription(remote)).toBeNull();

    // 快照本就不存在时照样成功
    expect(await clear({ scope: 'all' })).toEqual([expect.objectContaining({ success: true })]);
  });

  it('等在途的落盘写完再删：清理之前的内容不会在删除之后写回', async () => {
    const write = gate();
    const { files, clear } = await boot({}, { writeGate: write.wait });
    rememberDescription('data/images/onebot_t_group_A/abab0000abab0000.jpg', '清理之前的描述');
    const flushing = flushDescriptionCache(); // 写盘停在半途
    const clearing = clear({ scope: 'all' });
    write.release();
    await flushing;
    expect(await clearing).toEqual([expect.objectContaining({ success: true })]);
    expect(files.has(SNAPSHOT), '在途的写盘落在删除之后，旧描述又回到了磁盘').toBe(false);
  });

  it('等启动灌回完成再清：快照里的旧描述不会在清理之后灌回内存', async () => {
    const read = gate();
    const seed = { [SNAPSHOT]: JSON.stringify([['cdcd0000cdcd0000', '快照里的旧描述']]) };
    const { clear } = await boot(seed, { readGate: read.wait });
    const clearing = clear({ scope: 'all' }); // 灌回还停在读盘
    read.release();
    expect(await clearing).toEqual([expect.objectContaining({ success: true })]);
    expect(lookupCachedDescription('data/images/x/cdcd0000cdcd0000.png')).toBeNull();
  });
});
