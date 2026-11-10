import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { sessionDirName } from '../../packages/api-media/src/index.js';
import type {} from '../../packages/api-memory/src/index.js'; // declaration merging：memory:clear 钩子类型
import { memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { App, events, type LifecycleCap, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import drawPlugin from '../../packages/plugin-draw/src/index.js';
import mediaPlugin from '../../packages/plugin-media/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { localize, resolveText, toSource } from '../../packages/schema-i18n/src/index.js';
import { type IncomingMessage, type Message, WellKnownMetadataKeys } from '../../packages/schema-message/src/index.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 会话媒体的目录约定（api-media 的 session-media）：写入方各用自己的子目录 `data:/<种类目录>/<会话目录>/<写入方>/`，
// 交出完整的存储地址；谁写的谁清，/clear 与删会话经 memory:clear 各清自己的子目录，每种一行、标 type，会话目录删空了
// 一并删掉，别的写入方（第三方）的子目录不动。存储是临时数据目录上的 storage-local，OneBot 实现端是本地起的假服务。
// ════════════════════════════════════════════════════════════

type WsSocket = { on(event: 'message', cb: (raw: Buffer) => void): void; send(data: string): void; terminate(): void };
type WsServer = {
  on(event: 'connection', cb: (socket: WsSocket) => void): void;
  once(event: 'listening', cb: () => void): void;
  address(): AddressInfo;
  clients: Set<WsSocket>;
  close(cb: () => void): void;
};
const { WebSocketServer } = createRequire(
  new URL('../../packages/plugin-adapter-onebot/package.json', import.meta.url),
)('ws') as { WebSocketServer: new (opts: { host: string; port: number }) => WsServer };

const renders = vi.hoisted(() => ({ png: new Uint8Array(0) }));
vi.mock(import('../../packages/util-chromium/src/index.js'), async importOriginal => ({
  ...(await importOriginal()),
  OfflineRenderer: class {
    renderPng = async () => renders.png;
    renderFrames = async () => ({ frames: [] });
    dispose = async () => {};
  } as never,
}));

const SELF = '10000';
const GROUP = `onebot:${SELF}:group:20001`;
const GROUP_DIR = 'onebot_10000_group_20001';
const OTHER_DIR = 'onebot_10000_group_20002';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 临时数据目录：data 根在它的 state/ 下 */
function home(): { base: string; state: (...parts: string[]) => string } {
  const base = mkdtempSync(join(tmpdir(), 'aalis-session-media-'));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return { base, state: (...parts) => join(base, 'state', ...parts) };
}

/** 在 data 根下放一个文件（相对 state/ 的路径） */
function seed(state: (...parts: string[]) => string, path: string): void {
  const file = state(...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, PNG);
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('会话目录名（sessionDirName）', () => {
  it('`:`、`/`、`\\`、`..` 与前导点换成 `_`；空 id 抛错', () => {
    expect(sessionDirName(GROUP)).toBe(GROUP_DIR);
    expect(sessionDirName('a/b\\c')).toBe('a_b_c');
    expect(sessionDirName('.x..y')).toBe('_x_y');
    expect(() => sessionDirName('')).toThrow();
  });
});

describe('onebot 入站附件落进自己的子目录', () => {
  /** 假实现端 + onebot（只装它，不装指令插件）+ 会话管理 + 存档；push 推一条带图的群消息，等它进了 inbound:message */
  async function boot() {
    const { base, state } = home();
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => server.once('listening', resolve));
    cleanups.push(
      () =>
        new Promise<void>(resolve => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    );
    let socket: WsSocket | undefined;
    const actions: string[] = [];
    server.on('connection', ws => {
      socket = ws;
      ws.on('message', raw => {
        const req = JSON.parse(raw.toString()) as { echo?: string; action?: string };
        if (req.action) actions.push(req.action);
        if (req.echo) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF }, echo: req.echo }));
      });
    });

    const app = new App({ name: 'T', logLevel: 'error' });
    cleanups.push(() => app.stop());
    await registerHubs(app);
    provideHostPaths(app, base);
    const host = app.bind({ provide, events, sessionManager, messageArchive, memory });
    host.provide.use(processService, {} as never);
    const inbound: IncomingMessage[] = [];
    host.events.use.on('inbound:message', (msg: IncomingMessage) => void inbound.push(msg));
    await app.pluginAll([
      { definition: storageLocalPlugin, config: {} },
      { definition: memoryInMemory },
      { definition: messageArchivePlugin, config: { debugLogs: false } },
      { definition: sessionManagerPlugin },
      {
        definition: onebotPlugin,
        config: { connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol: 'v11', selfId: SELF }] },
      },
    ]);
    await app.plugins.idle();
    const inactive = app.plugins
      .getStatus()
      .filter(p => p.state !== 'active')
      .map(p => `${p.instanceId}: ${p.state}`);
    expect(inactive).toEqual([]);
    await app.start();
    await until(() => socket !== undefined && actions.includes('get_login_info'));

    async function pushImage(): Promise<IncomingMessage> {
      const before = inbound.length;
      socket?.send(
        JSON.stringify({
          time: 0,
          post_type: 'message',
          message_type: 'group',
          sub_type: 'normal',
          self_id: Number(SELF),
          user_id: 30001,
          group_id: 20001,
          message_id: 1,
          message: [{ type: 'image', data: { file: 'a.png', url: `data:image/png;base64,${PNG.toString('base64')}` } }],
          raw_message: '',
          sender: { user_id: 30001, nickname: '<占位昵称>' },
        }),
      );
      await until(() => inbound.length > before);
      return inbound[inbound.length - 1] as IncomingMessage;
    }
    return { state, host, pushImage };
  }

  const landed = `data:/images/${GROUP_DIR}/onebot/${createHash('sha256').update(PNG).digest('hex').slice(0, 16)}.png`;

  it('落在 data:/images/<会话目录>/onebot/：消息的附件、正文占位符与存档的附件清单都是存储地址', async () => {
    const { state, host, pushImage } = await boot();
    const msg = await pushImage();
    expect(msg.attachments?.[0]?.data).toBe(landed);
    expect(msg.content).toContain(`ref:${landed}]`);
    expect(readdirSync(state('images', GROUP_DIR, 'onebot'))).toHaveLength(1);

    await host.messageArchive.use.archiveIncoming(msg);
    const [saved] = (await host.memory.use.getHistory(GROUP, 10)) as Message[];
    expect(saved.content).toContain(`ref:${landed}]`);
    expect(saved.metadata?.[WellKnownMetadataKeys.Attachments]).toEqual([
      { kind: 'image', name: 'a.png', ref: landed },
    ]);
  });

  it('不装指令插件也清：删会话后它的 onebot 子目录与删空了的会话目录都不在', async () => {
    const { state, host, pushImage } = await boot();
    await pushImage();
    expect(host.sessionManager.use.getSession(GROUP)).toBeDefined();
    await host.sessionManager.use.deleteSession(GROUP);
    expect(existsSync(state('images', GROUP_DIR))).toBe(false);
  });
});

describe('/clear 的附件清理归写入方', () => {
  /**
   * 两个 onebot 实例、媒体识别与绘图，存储是 storage-local；预先放好两个会话里各家写的文件与一个第三方写入方的子目录。
   * clear 直接跑 memory:clear（与 /clear、删会话同一条路），回结果行
   */
  async function world() {
    const { base, state } = home();
    for (const path of [
      `images/${GROUP_DIR}/onebot/1111222233334444.png`,
      `images/${GROUP_DIR}/media/5555666677778888.png`,
      `images/${GROUP_DIR}/draw/draw-9999aaaabbbbcccc.png`,
      `images/${GROUP_DIR}/zz-third/x.png`,
      `videos/${GROUP_DIR}/onebot/ddddeeeeffff0000.mp4`,
      `images/${OTHER_DIR}/onebot/1111222233334444.png`,
      `images/${OTHER_DIR}/draw/draw-0000111122223333.png`,
      `images/${OTHER_DIR}/zz-third/y.png`,
    ])
      seed(state, path);
    const app = new App({ name: 'T', logLevel: 'error' });
    cleanups.push(() => app.stop());
    await registerHubs(app);
    provideHostPaths(app, base);
    const host = app.bind({ provide, hooks, contributions });
    host.provide.use(processService, {} as never);
    await app.plugin(storageLocalPlugin, {});
    await app.plugin(onebotPlugin, { connections: [] });
    await app.plugin(onebotPlugin, { connections: [] }, `${onebotPlugin.name}:b`);
    await app.plugin(mediaPlugin, {});
    await app.plugin(drawPlugin, {});
    await app.plugins.idle();
    const inactive = app.plugins
      .getStatus()
      .filter(p => p.state !== 'active')
      .map(p => `${p.instanceId}: ${p.state}`);
    expect(inactive).toEqual([]);
    async function clear(req: Omit<HookContextMap['memory:clear'], 'results'>) {
      const data: HookContextMap['memory:clear'] = { ...req, results: [] };
      await host.hooks.use.run('memory:clear', data, async () => {});
      return data.results;
    }
    const left = (kindDir: string, dir: string) =>
      existsSync(state(kindDir, dir)) ? readdirSync(state(kindDir, dir)).sort() : [];
    /** 登记的清理类型：全局键 → 类型 id */
    const registered = () =>
      Object.fromEntries(host.contributions.use.collect('memory:clear-type').map(({ key, spec }) => [key, spec.id]));
    return { clear, left, registered };
  }

  it('各写入方登记自己清的种类，/clear -t 选得中', async () => {
    const { registered } = await world();
    const ids = Object.entries(registered());
    for (const [instance, kinds] of [
      [onebotPlugin.name, ['audio', 'file', 'image', 'video']],
      [`${onebotPlugin.name}:b`, ['audio', 'file', 'image', 'video']],
      [mediaPlugin.name, ['image', 'video']],
      [drawPlugin.name, ['image']],
    ] as const)
      expect(
        ids.filter(([key]) => key.startsWith(`${instance}/`)).map(([, id]) => id),
        instance,
      ).toEqual(kinds);
  });

  it('会话级 -t image：onebot、媒体识别、绘图各删本会话自己的子目录，各出一行标 image 的结果；别的会话、别的种类与第三方不动', async () => {
    const { clear, left } = await world();
    const results = await clear({ scope: 'session', sessionId: GROUP, types: ['image'] });
    const files = results.filter(r => r.source !== 'media-description');
    expect(files.map(r => [r.source, r.type, r.success, toSource(r.message)])).toEqual([
      ['onebot-image', 'image', true, 'OneBot 收发的图片已清空（1 个）'],
      ['media-image', 'image', true, '上传的图片已清空（1 个）'],
      ['draw', 'image', true, '绘图产物已清空（1 个）'],
    ]);
    expect(
      files.map(r => localize(r.message, text => resolveText(text, ['en']))),
      '英文同样按文件计',
    ).toEqual([
      'Cleared images sent and received over OneBot (1 file)',
      'Cleared uploaded images (1 file)',
      'Cleared drawings (1 file)',
    ]);
    expect(left('images', GROUP_DIR)).toEqual(['zz-third']);
    expect(left('images', OTHER_DIR)).toEqual(['draw', 'onebot', 'zz-third']);
    expect(left('videos', GROUP_DIR)).toEqual(['onebot']);
  });

  it('全局 -t image：各家删全部会话里自己的子目录，第三方写入方的子目录不动', async () => {
    const { clear, left } = await world();
    const results = await clear({ scope: 'all', types: ['image'] });
    expect(
      results
        .filter(r => r.source !== 'media-description')
        .map(r => [r.source, r.type, r.success, toSource(r.message)]),
      '与会话级同一套句子，按删掉的文件数计',
    ).toEqual([
      ['onebot-image', 'image', true, 'OneBot 收发的图片已清空（2 个）'],
      ['media-image', 'image', true, '上传的图片已清空（1 个）'],
      ['draw', 'image', true, '绘图产物已清空（2 个）'],
    ]);
    expect(left('images', GROUP_DIR)).toEqual(['zz-third']);
    expect(left('images', OTHER_DIR)).toEqual(['zz-third']);
    expect(left('videos', GROUP_DIR)).toEqual(['onebot']);
  });

  it('这种附件一个都没有（目录不在）：会话级与全局都回「已清空（0 个）」', async () => {
    const { clear } = await world();
    for (const req of [{ scope: 'session', sessionId: GROUP }, { scope: 'all' }] as const)
      expect((await clear({ ...req, types: ['audio'] })).map(r => [r.source, r.success, toSource(r.message)])).toEqual([
        ['onebot-audio', true, 'OneBot 收发的语音已清空（0 个）'],
      ]);
  });
});

describe('绘图：会话 id 为空', () => {
  it('回工具错误，不落盘', async () => {
    renders.png = Uint8Array.from([...PNG.subarray(0, 16), 0, 0, 0, 2, 0, 0, 0, 2, ...new Array(8).fill(0)]);
    const written: string[] = [];
    const registered: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
    await drawPlugin.apply({
      tools: fixedRef(
        stubBoundTools({
          onRegister: t => {
            registered[t.definition.function.name] = t;
          },
        }),
      ),
      storage: fixedRef({ writeFile: async (uri: string) => void written.push(uri) } as never),
      processService: ref(),
      hooks: fixedRef({ middleware: () => () => {} } as never),
      contributions: fixedRef({ contribute: () => () => {} } as never),
      logger: fixedRef(silentLogger()),
      lifecycle: fixedRef({
        signal: new AbortController().signal,
        onDispose: () => () => {},
      } as unknown as LifecycleCap),
      config: fixedRef({}),
    });
    const out = await registered.draw_image.handler(
      { source: '<svg viewBox="0 0 2 2" xmlns="http://www.w3.org/2000/svg"/>' },
      toolContext({
        sessionId: '',
      }),
    );
    expect(JSON.parse(typeof out === 'string' ? out : out.content)).toHaveProperty('error');
    expect(written).toEqual([]);
  });
});
