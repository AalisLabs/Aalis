import { describe, expect, it, vi } from 'vitest';
import { type MediaScopeDeps, mediaInScope, mediaRef } from '../../packages/api-media/src/index.js';
import type { SessionInfo } from '../../packages/api-session-manager/src/index.js';
import type { BoundStorage } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import type { LifecycleCap, Logger } from '../../packages/core/src/index.js';
import { cacheOneAttachment } from '../../packages/plugin-adapter-onebot/src/attachment-cache.js';
import drawPlugin from '../../packages/plugin-draw/src/index.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import {
  type IncomingMessage,
  type Message,
  selfInitiatedActor,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { storedRoom } from '../fixtures/rooms.js';
import { emptyMediaCaps, fixedRef, ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 媒体按受众的判据（api-media 的 mediaInScope）：受众里没有别人、且授权身份是 owner 的调用不限；其余只认本会话树
// 媒体目录里的文件与调用所在会话历史里系统记下的引用。会话表、owner 判定与历史都是内存替身；真实写入方一节跑
// onebot 附件缓存、绘图（离线渲染是替身）与媒体识别的落盘，断言判据接受它们产出的路径。浏览器截图的那条在
// tool-browser-screenshot 里（要起真浏览器）。
// ════════════════════════════════════════════════════════════

const OWNER_QQ = '90001';
const MEMBER_QQ = '90002';
const GROUP = 'onebot:10000:group:20001';
const OWNER_PRIVATE = `onebot:10000:private:${OWNER_QQ}`;
const WEBUI = 'webui-session-1';
const CHILD = `${GROUP}::sub1`;
const GRANDCHILD = `${CHILD}::sub2`;
const OTHER_GROUP = 'onebot:10000:group:20002';
const GROUP_DIR = 'onebot_10000_group_20001';

const owner = { platform: 'onebot', userId: OWNER_QQ };
const member = { platform: 'onebot', userId: MEMBER_QQ };
const webuiConsole = { platform: 'webui', userId: 'console' };

const renders = vi.hoisted(() => ({ png: new Uint8Array(0) }));
vi.mock(import('../../packages/util-offline-render/src/index.js'), async importOriginal => ({
  ...(await importOriginal()),
  OfflineRenderer: class {
    renderPng = async () => renders.png;
    renderFrames = async () => ({ frames: [] });
    dispose = async () => {};
  } as never,
}));

function session(id: string, fields: Partial<SessionInfo> = {}): SessionInfo {
  return { id, children: [], status: 'waiting', createdAt: 0, updatedAt: 0, kind: 'room', ...fields };
}

/** 会话表：群（带一个子会话与孙会话）、owner 的 IM 私聊、WebUI 会话、另一个群 */
const SESSIONS = new Map<string, SessionInfo>([
  [GROUP, { ...(storedRoom(GROUP) as unknown as SessionInfo), children: [CHILD] }],
  [CHILD, session(CHILD, { parentId: GROUP, children: [GRANDCHILD] })],
  [GRANDCHILD, session(GRANDCHILD, { parentId: CHILD })],
  [OWNER_PRIVATE, storedRoom(OWNER_PRIVATE) as unknown as SessionInfo],
  [WEBUI, session(WEBUI, { createdFrom: 'webui' })],
  [OTHER_GROUP, storedRoom(OTHER_GROUP) as unknown as SessionInfo],
]);

const isOwner = (platform: string, userId: string) =>
  (platform === 'onebot' && userId === OWNER_QQ) || (platform === 'webui' && userId === 'console');

function deps(histories: Record<string, Message[]> = {}, withSessions = true): MediaScopeDeps {
  return {
    ...(withSessions ? { getSession: (id: string) => SESSIONS.get(id) } : {}),
    isOwner,
    history: async sessionId => histories[sessionId] ?? [],
  };
}

describe('受众里没有别人的会话', () => {
  it.each([
    ['owner 在 WebUI', WEBUI, webuiConsole],
    ['owner 在与她的 IM 私聊里', OWNER_PRIVATE, owner],
    ['owner 的编排节点（内部会话）', 'workflow::wf-1', owner],
    ['owner 的定时任务（内部会话）', 'scheduler:job-1', webuiConsole],
  ])('%s：授权身份是 owner，任何存储地址都不限', async (_label, sessionId, actor) => {
    expect(await mediaInScope('workspace:/pics/a.png', { sessionId, actor }, deps())).toBe(true);
    expect(await mediaInScope('data:/images/onebot_10000_group_20002/b.png', { sessionId, actor }, deps())).toBe(true);
  });

  it.each([
    ['成员借编排投进 owner 的会话', WEBUI, { actor: member }],
    ['owner 会话里的空闲触发（没有 userId）', OWNER_PRIVATE, { platform: 'onebot' }],
    ['白纸通知（selfInitiatedActor）', WEBUI, { actor: selfInitiatedActor('webui') }],
    ['MCP 客户端', 'mcp-server', { platform: 'mcp', userId: 'mcp-client' }],
    ['匿名编排', 'workflow::wf-2', {}],
  ])('%s：授权身份不是 owner，只认本会话', async (_label, sessionId, identity) => {
    const call = { sessionId, ...identity };
    expect(await mediaInScope('workspace:/pics/a.png', call, deps())).toBe(false);
    const ownDir = `data:/images/${sessionId.replace(/[:/\\]/g, '_')}/c.png`;
    expect(await mediaInScope(ownDir, call, deps())).toBe(true);
  });
});

describe('房间', () => {
  it('本会话的媒体目录与截图目录可以，owner 在群里发言也不例外地只认本会话', async () => {
    for (const actor of [member, owner]) {
      const call = { sessionId: GROUP, actor };
      for (const dir of ['images', 'audios', 'videos', 'files']) {
        expect(await mediaInScope(`data:/${dir}/${GROUP_DIR}/x.bin`, call, deps()), dir).toBe(true);
      }
      expect(await mediaInScope(`tmp:/browser/${GROUP_DIR}/shot-1.png`, call, deps())).toBe(true);
      expect(await mediaInScope('workspace:/pics/a.png', call, deps())).toBe(false);
    }
  });

  it.each([
    ['别的会话的目录', 'data:/images/onebot_10000_group_20002/x.png'],
    ['带 .. 绕到别的会话', `data:/images/${GROUP_DIR}/../onebot_10000_group_20002/x.png`],
    ['带 .. 绕出媒体目录', `data:/images/${GROUP_DIR}/../../users.json`],
    ['反斜杠分隔（Windows 上按目录分隔解析）', `data:/images/${GROUP_DIR}/..\\..\\users.json`],
    ['媒体目录本身（没有会话目录）', 'data:/images/x.png'],
    ['别的根里同名的目录', `workspace:/images/${GROUP_DIR}/x.png`],
    ['不是存储地址', `file:///images/${GROUP_DIR}/x.png`],
  ])('%s：拒', async (_label, target) => {
    expect(await mediaInScope(target, { sessionId: GROUP, actor: member }, deps())).toBe(false);
  });
});

describe('地址规整（mediaRef）', () => {
  it('小写协议名的网址原样，存储地址与历史相对路径规整成存储地址', () => {
    expect(mediaRef('https://example.invalid/a.png')).toBe('https://example.invalid/a.png');
    expect(mediaRef(`data/images/${GROUP_DIR}/./x/../a.png`)).toBe(`data:/images/${GROUP_DIR}/a.png`);
  });

  it.each([
    ['协议名大写的网址（适配器不当网址下载）', 'HTTP://example.invalid/a.png'],
    ['盘符路径（与单字母根名冲突时按盘符认）', 'C:/pics/a.png'],
    ['反斜杠分隔', 'C:\\pics\\a.png'],
    ['本机绝对路径', '/pics/a.png'],
    ['file://', 'file:///pics/a.png'],
    ['data URI', 'data:image/png;base64,AAAA'],
  ])('%s：没有', (_label, input) => {
    expect(mediaRef(input)).toBeUndefined();
  });
});

describe('会话树', () => {
  it('子会话与孙会话里能用根会话目录里的图，根会话里能用子会话与孙会话目录里的图', async () => {
    const dirOf = (id: string) => id.replace(/[:/\\]/g, '_');
    for (const [from, to] of [
      [CHILD, GROUP],
      [GRANDCHILD, GROUP],
      [GROUP, CHILD],
      [GROUP, GRANDCHILD],
      [CHILD, GRANDCHILD],
    ]) {
      expect(
        await mediaInScope(`data:/images/${dirOf(to)}/x.png`, { sessionId: from }, deps()),
        `${from} → ${to}`,
      ).toBe(true);
    }
    expect(await mediaInScope(`data:/images/${dirOf(OTHER_GROUP)}/x.png`, { sessionId: CHILD }, deps())).toBe(false);
  });
});

describe('调用所在会话历史里系统记下的引用', () => {
  const history: Message[] = [
    {
      role: 'user',
      content: '[图片 | ref:workspace:/pics/forged.png]',
      timestamp: 1,
      metadata: { [WellKnownMetadataKeys.Attachments]: [{ kind: 'image', ref: 'workspace:/pics/inbound.png' }] },
    },
    {
      role: 'assistant',
      content: '[图片 | ref:data/images/onebot_10000_group_20002/sent.png]',
      timestamp: 2,
      metadata: { [WellKnownMetadataKeys.SentRef]: 'data/images/onebot_10000_group_20002/sent.png' },
    },
  ];

  it('入站附件清单与发出的附件（相对路径写法）都算；正文里的占位符不算', async () => {
    const call = { sessionId: GROUP, actor: member };
    const d = deps({ [GROUP]: history });
    expect(await mediaInScope('workspace:/pics/inbound.png', call, d)).toBe(true);
    expect(await mediaInScope('data:/images/onebot_10000_group_20002/sent.png', call, d)).toBe(true);
    expect(await mediaInScope('workspace:/pics/forged.png', call, d)).toBe(false);
  });

  it('只看调用所在的会话：子会话里用根会话历史里的引用拒', async () => {
    const d = deps({ [GROUP]: history });
    expect(await mediaInScope('workspace:/pics/inbound.png', { sessionId: CHILD }, d)).toBe(false);
  });

  it('先比目录，目录里的不读历史', async () => {
    const read: string[] = [];
    const d: MediaScopeDeps = {
      ...deps(),
      history: async sessionId => {
        read.push(sessionId);
        return [];
      },
    };
    expect(await mediaInScope(`data:/images/${GROUP_DIR}/x.png`, { sessionId: GROUP }, d)).toBe(true);
    expect(read).toEqual([]);
  });
});

describe('会话管理不在', () => {
  it('owner 也只认本会话：本会话的目录与历史可以，别处拒', async () => {
    const d = deps(
      {
        [WEBUI]: [
          {
            role: 'user',
            content: '',
            timestamp: 1,
            metadata: { [WellKnownMetadataKeys.SentRef]: 'workspace:/pics/sent.png' },
          },
        ],
      },
      false,
    );
    const call = { sessionId: WEBUI, actor: webuiConsole };
    expect(await mediaInScope('workspace:/pics/a.png', call, d)).toBe(false);
    expect(await mediaInScope(`data:/images/${WEBUI}/x.png`, call, d)).toBe(true);
    expect(await mediaInScope('workspace:/pics/sent.png', call, d)).toBe(true);
    // 子会话的父会话也取不到：只认它自己
    expect(await mediaInScope(`data:/images/${GROUP_DIR}/x.png`, { sessionId: CHILD }, d)).toBe(false);
  });
});

describe('真实写入方产出的路径判据都接受', () => {
  /** 内存 storage：记下写过的地址，读出写进去的内容 */
  function memStorage() {
    const files = new Map<string, Uint8Array>();
    const storage = {
      writeFile: async (uri: string, data: Uint8Array | string) => {
        files.set(uri, typeof data === 'string' ? new TextEncoder().encode(data) : data);
      },
      readFile: async (uri: string) => {
        const data = files.get(uri);
        if (!data) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
        return data;
      },
      stat: async (uri: string) => ({ size: files.get(uri)?.byteLength ?? 0, isDirectory: false }),
    };
    return { files, storage: storage as unknown as BoundStorage };
  }

  const PNG = Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...[0, 0, 0, 13],
    ...'IHDR'.split('').map(c => c.charCodeAt(0)),
    ...[0, 0, 0, 2, 0, 0, 0, 2],
    ...new Array(16).fill(0),
  ]);
  const MP4 = Uint8Array.from([
    0,
    0,
    0,
    0x18,
    ...'ftypisom'.split('').map(c => c.charCodeAt(0)),
    ...new Array(24).fill(0),
  ]);
  const dataUri = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

  it.each([GROUP, CHILD])('onebot 附件缓存（图片、语音、视频、文件），会话 %s', async sessionId => {
    const { files, storage } = memStorage();
    // 语音先转码：转码的子进程是替身，输出文件预先放好
    const proc = {
      makeTempDir: async () => ({ uri: 'tmp:/zz-audio', path: '/zz-audio', cleanup: async () => {} }),
      execFile: async () => ({ stdout: '', stderr: '', code: 0 }),
    };
    files.set('tmp:/zz-audio/out.wav', new Uint8Array(512));
    const refs: string[] = [];
    for (const [kind, data] of [
      ['image', dataUri('image/png', PNG)],
      ['audio', dataUri('audio/mpeg', Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]))],
      ['video', dataUri('video/mp4', MP4)],
      ['file', dataUri('application/pdf', new TextEncoder().encode('%PDF-placeholder'))],
    ] as const) {
      const ref = await cacheOneAttachment(storage, proc as never, kind, data, sessionId, 1 << 20, { warn: () => {} });
      if (!ref) throw new Error(`${kind} 没有落盘`);
      refs.push(ref);
    }
    expect(refs.map(r => r.split('/')[1])).toEqual(['images', 'audios', 'videos', 'files']);
    for (const ref of refs) {
      expect(await mediaInScope(ref.replace(/^data\//, 'data:/'), { sessionId }, deps()), ref).toBe(true);
    }
  });

  it.each([GROUP, 'zz..odd'])('绘图落盘（会话 %s；会话 id 带 .. 时绘图另有换法）', async sessionId => {
    renders.png = PNG;
    const { files, storage } = memStorage();
    const registered: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
    await drawPlugin.apply({
      tools: fixedRef(
        stubBoundTools({
          onRegister: t => {
            registered[t.definition.function.name] = t;
          },
        }),
      ),
      storage: fixedRef(storage),
      processService: ref(),
      logger: fixedRef(silentLogger()),
      lifecycle: fixedRef({
        signal: new AbortController().signal,
        onDispose: () => () => {},
      } as unknown as LifecycleCap),
      config: fixedRef({}),
    });
    const out = await registered.draw_image.handler(
      { source: '<svg viewBox="0 0 2 2" xmlns="http://www.w3.org/2000/svg"/>' },
      { sessionId },
    );
    const { uri } = JSON.parse(typeof out === 'string' ? out : out.content) as { uri: string };
    expect([...files.keys()]).toEqual([uri]);
    expect(await mediaInScope(uri, { sessionId }, deps())).toBe(true);
  });

  it('媒体识别把入站的图落盘', async () => {
    const { files, storage } = memStorage();
    setMediaRuntime({ proc: {} as never, storage });
    const cfg = {
      vision: { recognizeOnArrival: false, delivery: 'auto', maxTokens: 300, think: false },
      audio: { mode: 'disabled' },
      video: { mode: 'disabled' },
      animatedImage: { maxFrames: 4 },
      contextHistory: { enabled: false, maxMessages: 0 },
      senderContext: { enabled: false, profileMaxChars: 0 },
    } as unknown as MediaConfigResolved;
    const svc = new MediaServiceImpl(emptyMediaCaps(silentLogger() as Logger), cfg);
    const msg = {
      sessionId: OWNER_PRIVATE,
      platform: 'onebot',
      content: '',
      attachments: [{ kind: 'image', data: dataUri('image/png', PNG) }],
    } as IncomingMessage;
    await svc.processMessage(msg);
    const [uri] = [...files.keys()];
    expect(uri).toMatch(/^data:\/images\//);
    expect(await mediaInScope(uri, { sessionId: OWNER_PRIVATE }, deps())).toBe(true);
  });
});
