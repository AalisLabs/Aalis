import { afterEach, describe, expect, it } from 'vitest';
import { type AgentService, agent, type PreprocessorFn } from '../../packages/api-agent/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import fileReaderPlugin, { computeFileId } from '../../packages/plugin-file-reader/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';
import { memoryStorage, sessionInfoOf } from '../fixtures/paper.js';

// ════════════════════════════════════════════════════════════
// file-reader 的会话面板「上传的文件」：取代宿主写死的文件标签。只在本会话有上传文件时出现，列出本会话的文件，
// 行动作删除；文件增删后带会话 id 推 invalidate，只有那个会话的面板重取。数据由 file-reader 从自己的存储读。
// 上传走插件自己注册的 preprocessor；页面经 webui-server 的真实登记表登记与调用。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:20001';
const OTHER = 'onebot:10000:group:20002';

const running: Array<{ app: App; pages: PageHost }> = [];
afterEach(async () => {
  for (const { app, pages } of running.splice(0)) {
    await app.stop();
    pages.dispose();
  }
});

interface BootOptions {
  /** 存储删除这些地址时抛 EPERM（如 Windows 上文件被占用） */
  refuse?: (uri: string) => boolean;
  /** 激活前就在盘上的文件 */
  seed?: Record<string, string>;
  config?: Record<string, unknown>;
}

/** `files` 是盘上内容，测试可以直接改 */
async function boot({ refuse, seed = {}, config = {} }: BootOptions = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  const pages = pageHost({ sessions: id => sessionInfoOf(id) });
  running.push({ app, pages });
  await registerHubs(app);
  const host = app.bind({ provide, events });
  const files = new Map<string, string | Uint8Array>(Object.entries(seed));
  const store: StorageService = memoryStorage(files);
  host.provide.use(storage, {
    ...store,
    async delete(uri: string) {
      if (refuse?.(uri))
        throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${uri}'`), { code: 'EPERM' });
      return store.delete(uri);
    },
  } as StorageService);
  host.provide.use(webuiServer, pages.service);
  let preprocessor: PreprocessorFn | undefined;
  host.provide.use(agent, {
    async handleMessage() {},
    registerPreprocessor(_name: string, handler: PreprocessorFn) {
      preprocessor = handler;
      return () => {
        preprocessor = undefined;
      };
    },
  } satisfies AgentService);
  await app.plugin(fileReaderPlugin, config);
  await app.plugins.idle();
  const upload = async (sessionId: string, name: string, content: string) => {
    if (!preprocessor) throw new Error('插件未注册 preprocessor');
    const data = Buffer.from(content);
    const message: IncomingMessage = {
      content: '看看这个',
      sessionId,
      platform: 'onebot',
      attachments: [
        { kind: 'file', name, mimeType: 'text/plain', data: `data:text/plain;base64,${data.toString('base64')}` },
      ],
    };
    await preprocessor(message, async () => undefined);
    return computeFileId(sessionId, data);
  };
  return { host, pages, files, upload };
}

describe('会话面板「上传的文件」', () => {
  it('过登记门槛，是会话面板；没上传过文件的会话不出现，上传后出现并推带会话 id 的 invalidate', async () => {
    const { pages, upload } = await boot();
    expect(pages.logs).toEqual([]);
    expect(pages.view('uploads')).toMatchObject({ title: '上传的文件', placement: 'session', icon: 'paperclip' });
    expect(await pages.panels(ROOM)).toEqual([]);
    await upload(ROOM, 'notes.txt', '正文');
    expect(pages.invalidations).toContainEqual({
      instance: '@aalis/plugin-file-reader',
      pageKey: 'uploads',
      sessionId: ROOM,
    });
    expect(await pages.panels(ROOM)).toEqual(['uploads']);
    expect(await pages.panels(OTHER)).toEqual([]);
  });

  it('只列本会话的文件：名字、大小、类型与上传时间', async () => {
    const { pages, upload } = await boot();
    const id = await upload(ROOM, 'notes.txt', '正文');
    await upload(OTHER, 'other.txt', '别处');
    expect(await pages.data('uploads', 'files', { sessionId: ROOM })).toEqual([
      { id, name: 'notes.txt', size: 6, mimeType: 'text/plain', uploadedAt: expect.any(Number) },
    ]);
  });

  it('删除：本会话的文件删掉后面板不再适用；别的会话的文件与不存在的回错误', async () => {
    const { pages, upload } = await boot();
    const mine = await upload(ROOM, 'notes.txt', '正文');
    const theirs = await upload(OTHER, 'other.txt', '别处');
    expect(await pages.act('uploads', 'deleteUpload', { rowKey: theirs, sessionId: ROOM })).toEqual({
      status: 500,
      body: { error: '本会话没有这个文件' },
    });
    const before = pages.invalidations.length;
    expect(await pages.act('uploads', 'deleteUpload', { rowKey: mine, sessionId: ROOM })).toEqual({
      status: 200,
      body: { message: '已删除 notes.txt' },
    });
    expect(pages.invalidations.slice(before)).toContainEqual({
      instance: '@aalis/plugin-file-reader',
      pageKey: 'uploads',
      sessionId: ROOM,
    });
    expect(await pages.data('uploads', 'files', { sessionId: ROOM })).toEqual([]);
    expect(await pages.panels(ROOM)).toEqual([]);
    expect(await pages.panels(OTHER)).toEqual(['uploads']);
    expect(await pages.act('uploads', 'deleteUpload', { rowKey: mine, sessionId: ROOM })).toEqual({
      status: 500,
      body: { error: '本会话没有这个文件' },
    });
  });

  it('删除：存储删不掉时回失败并写明原因，文件留在面板里可以重试', async () => {
    let locked = true;
    const { pages, upload } = await boot({ refuse: uri => locked && !uri.endsWith('.meta.json') });
    const id = await upload(ROOM, 'notes.txt', '正文');
    expect(await pages.act('uploads', 'deleteUpload', { rowKey: id, sessionId: ROOM })).toEqual({
      status: 500,
      body: { error: expect.stringMatching(/^删除 notes\.txt 失败：EPERM/) },
    });
    expect(await pages.data('uploads', 'files', { sessionId: ROOM })).toMatchObject([{ id, name: 'notes.txt' }]);
    locked = false;
    expect(await pages.act('uploads', 'deleteUpload', { rowKey: id, sessionId: ROOM })).toEqual({
      status: 200,
      body: { message: '已删除 notes.txt' },
    });
    expect(await pages.data('uploads', 'files', { sessionId: ROOM })).toEqual([]);
  });

  it('删除：盘上的数据文件已经不在时当作删掉了', async () => {
    const { pages, files, upload } = await boot();
    const id = await upload(ROOM, 'notes.txt', '正文');
    for (const uri of [...files.keys()]) if (uri.endsWith(`${id}.txt`)) files.delete(uri);
    expect(await pages.act('uploads', 'deleteUpload', { rowKey: id, sessionId: ROOM })).toEqual({
      status: 200,
      body: { message: '已删除 notes.txt' },
    });
  });

  it('会话删除时逐个清理：一个文件删不掉不拦后面的，删不掉的留在索引里', async () => {
    let stuck = '';
    const { host, pages, upload } = await boot({ refuse: uri => stuck !== '' && uri.includes(stuck) });
    stuck = await upload(ROOM, 'stuck.txt', '占用中');
    await upload(ROOM, 'loose.txt', '可删');
    await host.events.use.emit('session:deleted', ROOM);
    const left = await pages.data<Array<{ id: string }>>('uploads', 'files', { sessionId: ROOM });
    expect(left.map(row => row.id)).toEqual([stuck]);
  });

  it('过期清理：先到期的那个删不掉，不拦后面到期的', async () => {
    const dir = `pluginData:/file-reader/${ROOM.replace(/:/g, '_')}`;
    const seed: Record<string, string> = {};
    for (const [id, uploadedAt] of [
      ['stuck', 1],
      ['loose', 2],
    ] as const) {
      seed[`${dir}/${id}.txt`] = 'x';
      seed[`${dir}/${id}.meta.json`] = JSON.stringify({
        id,
        name: `${id}.txt`,
        mimeType: 'text/plain',
        size: 1,
        sessionId: ROOM,
        uploadedAt,
      });
    }
    const { pages } = await boot({ refuse: uri => uri.includes('/stuck'), seed, config: { retentionDays: 1 } });
    const left = await pages.data<Array<{ id: string }>>('uploads', 'files', { sessionId: ROOM });
    expect(left.map(row => row.id)).toEqual(['stuck']);
  });
});
