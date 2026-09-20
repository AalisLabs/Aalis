import { describe, expect, it } from 'vitest';
import { registerUploadedFilesRoutes } from '../../packages/plugin-webui-server/src/routes/uploaded-files.js';

// ════════════════════════════════════════════════════════════
// 下载路由此前是裸 `result.stream.pipe(res)`。Node 的 pipe 在 dest 关闭时只 unpipe、
// 不 destroy 源流——客户端中断下载（取消/关标签页/断网重试都是正常行为）后，
// fs.ReadStream 停在 paused 态永不 end，fd 不回收。撞到进程 fd 上限后全进程所有
// storage 读写一起失败，爆炸半径远超「一次下载失败」。
// ════════════════════════════════════════════════════════════

type Handler = (req: unknown, res: unknown) => Promise<void> | void;

const SESSION = 'onebot:1:group:2';
const FILE_ID = 'aaaaaaaaaaaaaaaa';

function setup() {
  const files = new Map<string, string>();
  files.set(
    `pluginData:/file-reader/onebot_1_group_2/${FILE_ID}.meta.json`,
    JSON.stringify({ id: FILE_ID, name: 'a.txt', mimeType: 'text/plain', size: 3, sessionId: SESSION, uploadedAt: 1 }),
  );
  files.set(`pluginData:/file-reader/onebot_1_group_2/${FILE_ID}.txt`, 'abc');

  const destroyed: string[] = [];
  const storage = {
    async readFile(uri: string) {
      const v = files.get(uri);
      if (v === undefined) throw new Error(`不存在: ${uri}`);
      return v;
    },
    async createReadStream(uri: string) {
      return {
        stream: {
          pipe: () => {},
          destroy: () => destroyed.push(uri),
        },
        stat: { size: 3 },
      };
    },
  };

  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...h: Handler[]) => void routes.set(`GET ${path}`, h[h.length - 1]),
    post: (path: string, ...h: Handler[]) => void routes.set(`POST ${path}`, h[h.length - 1]),
  };
  registerUploadedFilesRoutes(
    app as never,
    { storage: storage as never, logger: { debug() {}, warn() {} } as never, fileIndex: () => undefined },
    (() => () => {}) as never,
  );
  return { routes, destroyed };
}

/** 假 res：记录 close 监听器，便于模拟客户端中断 */
function fakeRes() {
  const listeners = new Map<string, () => void>();
  const res = {
    status() {
      return res;
    },
    json() {
      return res;
    },
    setHeader() {},
    on(ev: string, fn: () => void) {
      listeners.set(ev, fn);
      return res;
    },
  };
  return { res, fireClose: () => listeners.get('close')?.() };
}

describe('WebUI 下载：客户端中断必须销毁源流', () => {
  it('res close 时 destroy 源流（否则 fd 永久泄漏）', async () => {
    const { routes, destroyed } = setup();
    const { res, fireClose } = fakeRes();

    await routes.get('GET /api/uploaded-files/download')!({ query: { sessionId: SESSION, fileId: FILE_ID } }, res);
    expect(destroyed, '下载进行中不应销毁').toEqual([]);

    fireClose(); // 客户端取消
    expect(destroyed.length, '中断后必须销毁源流——裸 pipe 只 unpipe，不关 fd').toBe(1);
  });
});
