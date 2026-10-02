import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { registerUploadedFilesRoutes } from '../../packages/plugin-webui-server/src/routes/uploaded-files.js';

// ════════════════════════════════════════════════════════════
// WebUI「已上传的文件」路由与 plugin-file-reader 共用同一套落盘布局，却各自拼路径：
// file-reader 把会话目录名里的冒号替换成下划线后，路由若仍按原样 sessionId 拼，含冒号会话
// （onebot:*、带 parentId 的子会话）的列表为空、下载/删除 404。契约：路由与 file-reader 用同一套
// 替换拼会话目录名。用假 express + 内存 storage 直接驱动路由处理器。
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
      return { stream: Readable.from([Buffer.from(v)]), stat: { size: v.length } };
    },
  };
}

function fakeRes() {
  const out = { status: 200, body: undefined as unknown, piped: '' };
  // 下载路由把读流 pipeline 进响应，响应得是可写流；写出的正文收进 piped
  class Res extends Writable {
    status(code: number) {
      out.status = code;
      return this;
    }
    json(body: unknown) {
      out.body = body;
      return this;
    }
    setHeader() {}
    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      out.piped += chunk.toString();
      callback();
    }
  }
  return { res: new Res(), out };
}

function setup() {
  const files = new Map<string, string>();
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...handlers: Handler[]) => void routes.set(`GET ${path}`, handlers[handlers.length - 1]),
    post: (path: string, ...handlers: Handler[]) => void routes.set(`POST ${path}`, handlers[handlers.length - 1]),
  };
  registerUploadedFilesRoutes(
    app as never,
    {
      storage: memoryStorage(files) as never,
      logger: { debug() {}, warn() {} } as never,
      fileIndex: () => undefined,
    },
    (() => () => {}) as never,
  );
  const call = async (key: string, req: Record<string, unknown>) => {
    const { res, out } = fakeRes();
    await routes.get(key)!(req, res);
    return out;
  };
  return { files, call };
}

const SESSION = 'onebot:1:group:2';
const FILE_ID = 'aaaaaaaaaaaaaaaa';
const meta = (id: string, name: string) =>
  JSON.stringify({ id, name, mimeType: 'text/plain', size: 3, sessionId: SESSION, uploadedAt: 1 });

function seed(files: Map<string, string>) {
  files.set(`pluginData:/file-reader/onebot_1_group_2/${FILE_ID}.txt`, 'DATA');
  files.set(`pluginData:/file-reader/onebot_1_group_2/${FILE_ID}.meta.json`, meta(FILE_ID, 'a.txt'));
}

describe('webui-server 上传文件路由与 file-reader 目录名对齐', () => {
  it('列表：含冒号会话按替换后的目录名列出', async () => {
    const { files, call } = setup();
    seed(files);
    const out = await call('GET /api/uploaded-files', { query: { sessionId: SESSION } });
    expect(out.status).toBe(200);
    expect((out.body as { files: Array<{ name: string }> }).files.map(f => f.name)).toEqual(['a.txt']);
  });

  it('下载：数据文件与 meta 同在替换后的目录', async () => {
    const { files, call } = setup();
    seed(files);
    const out = await call('GET /api/uploaded-files/download', { query: { sessionId: SESSION, fileId: FILE_ID } });
    await vi.waitFor(() => expect(out.piped).toBe('DATA'));
    expect(
      (await call('GET /api/uploaded-files/download', { query: { sessionId: SESSION, fileId: 'cccccccccccccccc' } }))
        .status,
    ).toBe(404);
  });

  it('删除：删掉替换后目录里的数据与 meta', async () => {
    const { files, call } = setup();
    seed(files);
    const out = await call('POST /api/uploaded-files/delete', { body: { sessionId: SESSION, fileId: FILE_ID } });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, name: 'a.txt', id: FILE_ID });
    expect(files.size).toBe(0);
  });
});
