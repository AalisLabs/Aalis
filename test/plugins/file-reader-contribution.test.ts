import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import type { AgentService, PreprocessorFn } from '../../packages/plugin-agent-api/src/index.js';
import * as fileReaderModule from '../../packages/plugin-file-reader/src/index.js';
import { computeFileId } from '../../packages/plugin-file-reader/src/index.js';
import type { IncomingMessage, Message } from '../../packages/plugin-message-api/src/index.js';
import type {
  StorageEntry,
  StorageListResult,
  StorageRootInfo,
  StorageService,
  StorageStat,
} from '../../packages/plugin-storage-api/src/index.js';

// ════════════════════════════════════════════════════════════
// plugin-file-reader 的 agent:prompt 贡献（局部 id = file-reader-history，
// 锚位 context）。三条互斥路径：
//   - 会话有文件 + 本轮无新上传 → 「历史上传文件」清单
//   - 本轮有新上传（最后一条 user 含 `[文件:` 且能提取已知 ID）→ 「本轮新上传」清单
//   - 会话无文件 / 无 sessionId / 提不出已知 ID → 不注入
// 上传面走插件自己注册的 preprocessor（经 agent 服务的 registerPreprocessor
// 拿到），存储面用最小内存 storage（根 pluginData），不碰真实文件系统。
// ════════════════════════════════════════════════════════════

const FIXED_TIME = '2026-01-01T00:00:00.000Z';

const PLUGIN_DATA_ROOT: StorageRootInfo = {
  name: 'pluginData',
  label: '插件数据',
  kind: 'pluginData',
  browsable: false,
  readable: true,
  writable: true,
  deletable: true,
};

/** 最小内存 storage：只实现 file-reader 实际调用的 list/stat/readFile/writeFile/delete。 */
function createMemoryStorage(): StorageService {
  const files = new Map<string, Buffer>();

  const relPath = (uri: string): string => uri.slice(uri.indexOf(':/') + 1);
  const extOf = (name: string): string => {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i) : '';
  };
  const isDir = (uri: string): boolean => {
    for (const key of files.keys()) if (key.startsWith(`${uri}/`)) return true;
    return false;
  };
  const makeEntry = (uri: string, directory: boolean, size: number): StorageEntry => {
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    return {
      name,
      path: relPath(uri),
      uri,
      isDirectory: directory,
      size,
      mtime: FIXED_TIME,
      ext: directory ? '' : extOf(name),
    };
  };

  return {
    listRoots: () => [PLUGIN_DATA_ROOT],
    async list(uri: string): Promise<StorageListResult> {
      const prefix = `${uri}/`;
      const seen = new Map<string, StorageEntry>();
      for (const [key, buf] of files) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        const childUri = slash === -1 ? key : `${prefix}${rest.slice(0, slash)}`;
        if (!seen.has(childUri)) seen.set(childUri, makeEntry(childUri, slash !== -1, slash === -1 ? buf.length : 0));
      }
      if (seen.size === 0) throw new Error(`目录不存在: ${uri}`);
      return { root: PLUGIN_DATA_ROOT, path: relPath(uri), entries: [...seen.values()] };
    },
    async stat(uri: string): Promise<StorageStat> {
      const buf = files.get(uri);
      if (!buf && !isDir(uri)) throw new Error(`不存在: ${uri}`);
      const entry = makeEntry(uri, !buf, buf?.length ?? 0);
      return { ...entry, birthtime: FIXED_TIME };
    },
    async readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer> {
      const buf = files.get(uri);
      if (!buf) throw new Error(`文件不存在: ${uri}`);
      return encoding ? buf.toString(encoding) : buf;
    },
    async writeFile(uri: string, data: string | Buffer): Promise<void> {
      files.set(uri, typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data));
    },
    async delete(uri: string): Promise<void> {
      files.delete(uri);
      for (const key of [...files.keys()]) if (key.startsWith(`${uri}/`)) files.delete(key);
    },
    async rename(): Promise<string> {
      throw new Error('测试桩不支持 rename');
    },
    async createReadStream(): Promise<never> {
      throw new Error('测试桩不支持 createReadStream');
    },
  };
}

interface Fixture {
  app: App;
  /** 经插件注册的 preprocessor 上传一个文本文件，返回文件 ID 与附件描述 */
  upload(sessionId: string, name: string, content: string): Promise<{ id: string; desc: string }>;
  dispose(): void;
}

async function setup(config: Record<string, unknown> = {}): Promise<Fixture> {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  app.ctx.provide('storage', createMemoryStorage());

  // agent 桩：只负责把插件的 preprocessor 交到测试手上（file-reader 走
  // useAgent(ctx).registerPreprocessor 分支，因为桩实现了 registerPreprocessor）
  let preprocessor: PreprocessorFn | undefined;
  const agentStub: AgentService = {
    async handleMessage() {
      /* 测试不驱动完整对话 */
    },
    registerPreprocessor(_name: string, handler: PreprocessorFn) {
      preprocessor = handler;
      return () => {
        preprocessor = undefined;
      };
    },
  };
  app.ctx.provide('agent', agentStub);

  const off = await app.ctx.useModule(fileReaderModule, config);

  return {
    app,
    async upload(sessionId: string, name: string, content: string) {
      if (!preprocessor) throw new Error('插件未注册 preprocessor');
      const buffer = Buffer.from(content, 'utf-8');
      const msg: IncomingMessage = {
        content: '看看这个',
        sessionId,
        platform: 'test',
        attachments: [
          {
            kind: 'file',
            name,
            mimeType: 'text/plain',
            data: `data:text/plain;base64,${buffer.toString('base64')}`,
          },
        ],
      };
      await preprocessor(msg, async () => undefined);
      const desc = msg._attachmentDescriptions?.[0] ?? '';
      return { id: await computeFileId(sessionId, buffer), desc };
    },
    dispose: off,
  };
}

/**
 * 跑一轮组装，返回 messages 与 file-reader 注入的那条（若有）。
 * history 插在 persona 与最后一条 user 之间，用于多轮 fixture。
 */
async function assemble(
  app: App,
  opts: { sessionId?: string; lastUser: string; history?: Message[] },
): Promise<{ messages: Message[]; injected?: Message }> {
  const messages: Message[] = [
    { role: 'system', content: 'persona' },
    ...(opts.history ?? []),
    { role: 'user', content: opts.lastUser },
  ];
  await assemblePromptContributions(app.ctx, { messages, sessionId: opts.sessionId, platform: 'test' });
  return {
    messages,
    injected: messages.find(m => String(m.metadata?.injector ?? '').endsWith('/file-reader-history')),
  };
}

function contentOf(msg?: Message): string {
  return typeof msg?.content === 'string' ? msg.content : '';
}

describe('plugin-file-reader: agent:prompt 贡献', () => {
  it('上传后本轮无新上传 → 注入历史文件清单（含文件名与 ID），落在 context 锚位', async () => {
    const fx = await setup();
    try {
      const a = await fx.upload('s-1', 'notes.txt', '第一个文件正文');
      const b = await fx.upload('s-1', 'plan.md', '第二个文件正文');

      // 同槽区对照探针：fixture 只有 [system, ...history, user] 时各锚位插入点重合，
      // 单看下标无法区分锚位。identity 探针给出上界；knowledge 探针的 ctx id 必须
      // **码元序排在被测插件全局键之后**（插件经 useModule 加载，键形如
      // `root#@aalis/plugin-file-reader`，故用 zz- 前缀）——否则 anchor 错标成
      // knowledge 时两块仍按同样次序落位，断言恒真、变异测不出。
      fx.app.ctx
        .fork('probe-identity')
        .contribute('agent:prompt' as never, { id: 'idn', anchor: 'identity', build: () => 'IDN' } as never);
      fx.app.ctx
        .fork('zz-probe-knowledge')
        .contribute('agent:prompt' as never, { id: 'kn', anchor: 'knowledge', build: () => 'KN' } as never);

      // 带一轮历史：没有它时"第一条非 system"与"最后一条 user"重合，
      // context 与 turn-hint 落点相同，锚位断言对 turn-hint 恒真。
      const { messages, injected } = await assemble(fx.app, {
        sessionId: 's-1',
        lastUser: '刚才那些文件讲了啥',
        history: [
          { role: 'user', content: '旧问' },
          { role: 'assistant', content: '旧答' },
        ],
      });
      const text = contentOf(injected);

      expect(injected).toBeDefined();
      expect(text).toContain('本会话历史上传文件');
      expect(text).toContain('当前轮次未新上传');
      expect(text).toContain('(2 个');
      expect(text).toContain('notes.txt');
      expect(text).toContain(a.id);
      expect(text).toContain('plan.md');
      expect(text).toContain(b.id);
      expect(text).toContain('read_uploaded_file');
      expect(text).toContain('list_uploaded_files');

      // context 锚位可判伪：IDN（identity）紧跟 persona；KN（knowledge）在 file-reader
      // 块**之前**——若 anchor 错标成 knowledge，两块同槽按键序排，zz- 探针会落到
      // file-reader 之后，下面这条比较即翻转。
      const idnIdx = messages.findIndex(m => String(m.content) === 'IDN');
      const knIdx = messages.findIndex(m => String(m.content) === 'KN');
      const frIdx = messages.indexOf(injected as Message);
      expect(idnIdx).toBe(1);
      expect(frIdx).toBeGreaterThan(idnIdx);
      expect(knIdx, 'knowledge 槽须先于 context 槽').toBeLessThan(frIdx);
      // 落在首条非 system（历史第一条）之前——turn-hint 会落到最后一条 user 前，故可判伪
      expect(frIdx).toBeLessThan(messages.findIndex(m => m.role !== 'system'));
      expect(messages[frIdx].role).toBe('system');
      expect(messages[messages.length - 1].role).toBe('user');
    } finally {
      fx.dispose();
    }
  });

  it('本轮有新上传 → 注入「本轮新上传」清单，并把往轮文件另列为历史', async () => {
    const fx = await setup();
    try {
      const old = await fx.upload('s-1', 'old.txt', '往轮上传的正文');
      const fresh = await fx.upload('s-1', 'fresh.txt', '本轮上传的正文');

      // 真实链路里 user message 会带上 preprocessor 生成的附件描述
      expect(fresh.desc).toContain('[文件: fresh.txt');
      expect(fresh.desc).toContain(`(ID: ${fresh.id})`);

      const { injected } = await assemble(fx.app, {
        sessionId: 's-1',
        lastUser: `帮我看看\n${fresh.desc}`,
      });
      const text = contentOf(injected);

      expect(injected).toBeDefined();
      expect(text).toContain('本轮用户新上传了 1 个文件');
      expect(text).toContain('fresh.txt');
      expect(text).toContain(fresh.id);
      expect(text).toContain('历史还有 1 个文件可用');
      expect(text).toContain('old.txt');
      expect(text).toContain(old.id);
      // 本轮分支不再打「当前轮次未新上传」的历史抬头
      expect(text).not.toContain('当前轮次未新上传');
    } finally {
      fx.dispose();
    }
  });

  it('本轮新上传是会话内唯一文件 → 只有本轮段，无「历史还有」段', async () => {
    const fx = await setup();
    try {
      const only = await fx.upload('s-1', 'only.txt', '唯一的正文');
      const { injected } = await assemble(fx.app, { sessionId: 's-1', lastUser: `请总结\n${only.desc}` });
      const text = contentOf(injected);

      expect(text).toContain('本轮用户新上传了 1 个文件');
      expect(text).toContain('only.txt');
      expect(text).not.toContain('历史还有');
    } finally {
      fx.dispose();
    }
  });

  it('多轮对话：文件描述在往轮 user、最后一条 user 无新上传 → 走历史清单分支', async () => {
    const fx = await setup();
    try {
      const old = await fx.upload('s-1', 'old.txt', '往轮上传的正文');

      // 判定「本轮是否新上传」只看倒序第一条 user；往轮 user 虽含 [文件: 描述，
      // 不该把本轮误判成新上传
      const { injected } = await assemble(fx.app, {
        sessionId: 's-1',
        history: [
          { role: 'user', content: `看看这个\n${old.desc}` },
          { role: 'assistant', content: '好的' },
        ],
        lastUser: '那它讲了啥',
      });
      const text = contentOf(injected);

      expect(injected).toBeDefined();
      expect(text).toContain('本会话历史上传文件');
      expect(text).toContain('当前轮次未新上传');
      expect(text).toContain('old.txt');
      expect(text).toContain(old.id);
      expect(text).not.toContain('本轮用户新上传');
    } finally {
      fx.dispose();
    }
  });

  it('多轮对话：最后一条 user 带新上传描述 → 走本轮新上传分支，往轮文件归历史段', async () => {
    const fx = await setup();
    try {
      const old = await fx.upload('s-1', 'old.txt', '往轮上传的正文');
      const fresh = await fx.upload('s-1', 'fresh.txt', '本轮上传的正文');

      const { injected } = await assemble(fx.app, {
        sessionId: 's-1',
        history: [
          { role: 'user', content: `看看这个\n${old.desc}` },
          { role: 'assistant', content: '好的' },
        ],
        lastUser: `那这个新的呢\n${fresh.desc}`,
      });
      const text = contentOf(injected);

      expect(injected).toBeDefined();
      expect(text).toContain('本轮用户新上传了 1 个文件');
      expect(text).not.toContain('当前轮次未新上传');
      // 分段归属：fresh 在本轮段（历史段抬头之前），old 在「历史还有」段之后
      const histIdx = text.indexOf('历史还有 1 个文件可用');
      expect(histIdx).toBeGreaterThan(-1);
      expect(text.indexOf('fresh.txt')).toBeGreaterThan(-1);
      expect(text.indexOf('fresh.txt')).toBeLessThan(histIdx);
      expect(text.indexOf('old.txt')).toBeGreaterThan(histIdx);
      expect(text).toContain(fresh.id);
    } finally {
      fx.dispose();
    }
  });

  it('user 消息含 [文件: 但提不出本会话已知 ID → 不注入', async () => {
    const fx = await setup();
    try {
      await fx.upload('s-1', 'notes.txt', '正文');
      const { injected } = await assemble(fx.app, {
        sessionId: 's-1',
        lastUser: '[文件: ghost.txt (ID: deadbeefdeadbeef)] 这个呢',
      });
      expect(injected).toBeUndefined();
    } finally {
      fx.dispose();
    }
  });

  it('会话无文件 → 不注入', async () => {
    const fx = await setup();
    try {
      await fx.upload('s-1', 'notes.txt', '正文');
      const { injected } = await assemble(fx.app, { sessionId: 's-other', lastUser: '有文件吗' });
      expect(injected).toBeUndefined();
    } finally {
      fx.dispose();
    }
  });

  it('清单只列本会话文件（跨会话隔离）', async () => {
    const fx = await setup();
    try {
      await fx.upload('s-1', 'alice.txt', 'A 的正文');
      const mine = await fx.upload('s-2', 'bob.txt', 'B 的正文');

      const { injected } = await assemble(fx.app, { sessionId: 's-2', lastUser: '我传过什么' });
      const text = contentOf(injected);

      expect(text).toContain('(1 个');
      expect(text).toContain('bob.txt');
      expect(text).toContain(mine.id);
      expect(text).not.toContain('alice.txt');
    } finally {
      fx.dispose();
    }
  });

  it('无 sessionId → 不注入', async () => {
    const fx = await setup();
    try {
      await fx.upload('s-1', 'notes.txt', '正文');
      const { injected } = await assemble(fx.app, { lastUser: '随便聊聊' });
      expect(injected).toBeUndefined();
    } finally {
      fx.dispose();
    }
  });

  it('historyHintEnabled=false → 完全不贡献', async () => {
    const fx = await setup({ historyHintEnabled: false });
    try {
      await fx.upload('s-1', 'notes.txt', '正文');
      const { messages, injected } = await assemble(fx.app, { sessionId: 's-1', lastUser: '那个文件呢' });
      expect(injected).toBeUndefined();
      expect(messages).toHaveLength(2);
    } finally {
      fx.dispose();
    }
  });

  it('同会话重复上传同一文件 → 清单仍只有一个条目', async () => {
    const fx = await setup();
    try {
      const first = await fx.upload('s-1', 'dup.txt', '同样的正文');
      const second = await fx.upload('s-1', 'dup.txt', '同样的正文');
      expect(second.id).toBe(first.id);

      const { injected } = await assemble(fx.app, { sessionId: 's-1', lastUser: '刚那个文件' });
      const text = contentOf(injected);
      expect(text).toContain('(1 个');
      expect((text.match(/dup\.txt/g) ?? []).length).toBe(1);
    } finally {
      fx.dispose();
    }
  });
});
