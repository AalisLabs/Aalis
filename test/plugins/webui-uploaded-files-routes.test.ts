import { describe, expect, it } from 'vitest';
import { registerUploadedFilesRoutes } from '../../packages/plugin-webui-server/src/routes/uploaded-files.js';

// ════════════════════════════════════════════════════════════
// WebUI「已上传的文件」路由与 plugin-file-reader 共用同一套落盘布局，却各自拼路径：
// file-reader 把会话目录名里的冒号替换成下划线后，路由若仍按原样 sessionId 拼，含冒号会话
// （onebot:*、带 parentId 的子会话）的列表为空、下载/删除 404。契约：读侧两种目录名都试，
// 数据文件跟着 meta 实际所在目录走。用假 express + 内存 storage 直接驱动路由处理器。
// ════════════════════════════════════════════════════════════

type Handler = (req: unknown, res: unknown) => Promise<void> | void;

function memoryStorage(files: Map<string, string>) {
  return {
    async list(uri: string) {
      const prefix = `${uri}/`;
      const seen = new Map<string, boolean>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        seen.set(name, seen.get(name) === true || slash !== -1);
      }
      if (seen.size === 0) throw new Error(`目录不存在: ${uri}`);
      return { entries: [...seen].map(([name, isDirectory]) => ({ name, isDirectory, uri: `${prefix}${name}` })) };
    },
    async readFile(uri: string) {
      const v = files.get(uri);
      if (v === undefined) throw new Error(`不存在: ${uri}`);
      return v;
    },
    async delete(uri: string) {
      if (!files.delete(uri)) throw new Error(`不存在: ${uri}`);
    },
    async createReadStream(uri: string) {
      const v = files.get(uri);
      if (v === undefined) throw new Error(`不存在: ${uri}`);
      const pipe = (res: { piped: string }): void => {
        res.piped = v;
      };
      return { stream: { pipe }, stat: { size: v.length } };
    },
  };
}

function fakeRes() {
  const out = { status: 200, body: undefined as unknown, piped: '' };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
    setHeader() {},
    get piped() {
      return out.piped;
    },
    set piped(v: string) {
      out.piped = v;
    },
  };
  return { res, out };
}

function setup() {
  const files = new Map<string, string>();
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...handlers: Handler[]) => void routes.set(`GET ${path}`, handlers[handlers.length - 1]),
    post: (path: string, ...handlers: Handler[]) => void routes.set(`POST ${path}`, handlers[handlers.length - 1]),
  };
  const ctx = { logger: { debug() {}, warn() {} }, getService: () => undefined };
  registerUploadedFilesRoutes(app as never, ctx as never, { storage: memoryStorage(files) as never }, (() =>
    () => {}) as never);
  const call = async (key: string, req: Record<string, unknown>) => {
    const { res, out } = fakeRes();
    await routes.get(key)!(req, res);
    return out;
  };
  return { files, call };
}

const SESSION = 'onebot:1:group:2';
const NEW_ID = 'aaaaaaaaaaaaaaaa';
const OLD_ID = 'bbbbbbbbbbbbbbbb';
const meta = (id: string, name: string) =>
  JSON.stringify({ id, name, mimeType: 'text/plain', size: 3, sessionId: SESSION, uploadedAt: 1 });

function seed(files: Map<string, string>) {
  // 新布局（替换后的目录名）与老布局（原样 sessionId）并存
  files.set(`pluginData:/file-reader/onebot_1_group_2/${NEW_ID}.txt`, 'NEW');
  files.set(`pluginData:/file-reader/onebot_1_group_2/${NEW_ID}.meta.json`, meta(NEW_ID, 'new.txt'));
  files.set(`pluginData:/file-reader/${SESSION}/${OLD_ID}.txt`, 'OLD');
  files.set(`pluginData:/file-reader/${SESSION}/${OLD_ID}.meta.json`, meta(OLD_ID, 'old.txt'));
}

describe('webui-server 上传文件路由与 file-reader 目录名对齐', () => {
  it('列表：含冒号会话两种目录名下的文件都列出', async () => {
    const { files, call } = setup();
    seed(files);
    const out = await call('GET /api/uploaded-files', { query: { sessionId: SESSION } });
    expect(out.status).toBe(200);
    expect((out.body as { files: Array<{ name: string }> }).files.map(f => f.name).sort()).toEqual([
      'new.txt',
      'old.txt',
    ]);
  });

  it('下载：数据文件跟着 meta 实际所在目录走', async () => {
    const { files, call } = setup();
    seed(files);
    expect(
      (await call('GET /api/uploaded-files/download', { query: { sessionId: SESSION, fileId: NEW_ID } })).piped,
    ).toBe('NEW');
    expect(
      (await call('GET /api/uploaded-files/download', { query: { sessionId: SESSION, fileId: OLD_ID } })).piped,
    ).toBe('OLD');
    expect(
      (await call('GET /api/uploaded-files/download', { query: { sessionId: SESSION, fileId: 'cccccccccccccccc' } }))
        .status,
    ).toBe(404);
  });

  it('删除：删的是文件实际所在目录里的数据与 meta，另一布局不受影响', async () => {
    const { files, call } = setup();
    seed(files);
    const out = await call('POST /api/uploaded-files/delete', { body: { sessionId: SESSION, fileId: OLD_ID } });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, name: 'old.txt', id: OLD_ID });
    expect([...files.keys()].filter(k => k.includes(OLD_ID))).toEqual([]);
    expect([...files.keys()].filter(k => k.includes(NEW_ID))).toHaveLength(2);
    const again = await call('POST /api/uploaded-files/delete', { body: { sessionId: SESSION, fileId: NEW_ID } });
    expect(again.status).toBe(200);
    expect(files.size).toBe(0);
  });
});
