import { afterEach, describe, expect, it, vi } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import { rememberDescription } from '../../packages/plugin-media/src/cache.js';
import media from '../../packages/plugin-media/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 图片描述缓存是模块级共享的：本插件这次激活关掉时（onDispose）落盘一次，之后晚到的描述只进内存、不再由这次激活排落盘定时器，
// 关掉之后不再写快照；下一次激活灌回快照时才重新开落盘，关掉之前发起的灌回读完时不开。存储是只记写入的替身，防抖时钟用假时钟。
// ════════════════════════════════════════════════════════════

const SNAPSHOT = 'data:/media/descriptions.json';

const apps: App[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
});

/** 装上真插件：存储是只记写入的替身，读盘由 readFile 定；交回 App 与写过的地址 */
async function boot(readFile: (uri: string) => Promise<unknown>) {
  const writes: string[] = [];
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide });
  host.provide.use(processService, {} as never);
  host.provide.use(storage, {
    readFile,
    writeFile: async (uri: string) => {
      writes.push(uri);
    },
  } as never);
  await app.plugin(media, {});
  await app.plugins.idle();
  if (app.plugins.getPlugin(media.name)?.state !== 'active') throw new Error('plugin-media 未激活');
  return { app, writes };
}

const notFound = (uri: string) => Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });

describe('描述缓存随本激活关掉', () => {
  it('onDispose 落盘之后晚到的描述：过了防抖时限也不再写快照', async () => {
    const { app, writes } = await boot(async uri => {
      throw notFound(uri);
    });
    await new Promise(resolve => setImmediate(resolve)); // 等灌回（快照不存在）落定，开落盘
    rememberDescription('data:/images/onebot_t_group_A/onebot/aaaa1111aaaa1111.jpg', '关掉之前的描述');
    await app.plugins.disable(media.name);
    expect(writes, 'onDispose 落盘一次').toEqual([SNAPSHOT]);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rememberDescription('data:/images/onebot_t_group_A/onebot/bbbb2222bbbb2222.jpg', '关掉之后晚到的描述');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(writes, '关掉之后不再写快照').toEqual([SNAPSHOT]);
  });

  it.each([
    'snapshot',
    'missing',
  ] as const)('灌回快照还没读完就关掉（%s）：读完不再开落盘，晚到的描述过了防抖时限也不写快照', async outcome => {
    let readBack!: () => void;
    const { app, writes } = await boot(
      uri =>
        new Promise((resolve, reject) => {
          readBack = () => (outcome === 'snapshot' ? resolve('[]') : reject(notFound(uri)));
        }),
    );
    await vi.waitFor(() => expect(readBack).toBeTypeOf('function'));
    await app.plugins.disable(media.name);
    readBack();
    await new Promise(resolve => setImmediate(resolve));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rememberDescription('data:/images/onebot_t_group_A/onebot/cccc3333cccc3333.jpg', '关掉之后晚到的描述');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(writes).toEqual([]);
  });

  it('灌回排在前一次激活的灌回之后、还没轮到就关掉：读完不再开落盘', async () => {
    const reads: Array<() => void> = [];
    const { app, writes } = await boot(() => new Promise(resolve => reads.push(() => resolve('[]'))));
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await app.plugins.disable(media.name);
    await app.plugins.enable(media.name);
    await app.plugins.disable(media.name);
    reads[0]();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]();
    await new Promise(resolve => setImmediate(resolve));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rememberDescription('data:/images/onebot_t_group_A/onebot/dddd4444dddd4444.jpg', '关掉之后晚到的描述');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(writes).toEqual([]);
  });
});
