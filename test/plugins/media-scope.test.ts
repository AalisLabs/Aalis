import { describe, expect, it, vi } from 'vitest';
import { originTurnOf } from '../../packages/api-authority/src/index.js';
import {
  localFileInScope,
  type MediaScopeCall,
  type MediaScopeDeps,
  mediaInScope,
  mediaRef,
  sessionDirName,
} from '../../packages/api-media/src/index.js';
import type { SessionInfo } from '../../packages/api-session-manager/src/index.js';
import type { BoundStorage } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import type { LifecycleCap, Logger } from '../../packages/core/src/index.js';
import { cacheOneAttachment } from '../../packages/plugin-adapter-onebot/src/attachment-cache.js';
import { principalKind } from '../../packages/plugin-authority/src/authority-model.js';
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
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 媒体判据（api-media 的 mediaInScope）按目标分三类：会话媒体目录里的按目录名反查会话（按大小写折叠比，候选取并集），
// 都在本会话树里的与调用所在会话历史里系统记下的放行、不问别的，本会话树以外的候选（含与本会话树撞名的）都过调用方给的
// 取用判定 take 才放行；不在任何会话媒体目录下的本机文件交给调用方给的本机文件判定 local，历史里记过的也一样。取用规则
// 本身由会话管理的参数化表钉住（session-take-rule），这里的 take 与 local 是替身，只看分流。本机文件判法（localFileInScope）
// 直接测，主体用权限插件的 principalKind。会话表、owner 判定与历史都是内存替身；真实写入方一节跑 onebot 附件缓存、绘图
// （离线渲染是替身）与媒体识别的落盘，断言它们按 api-media 的目录约定落进各自的子目录、判据接受它们产出的地址，是会话
// 目录名的唯一守卫。浏览器截图的那条在 tool-browser-screenshot 里（要启动真浏览器）。
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
const OTHER_DIR = 'onebot_10000_group_20002';
/** 目录名撞车的两组会话：只在 `:` 与 `_` 上有区别的，与只差大小写的 */
const SAME_DIR = ['zz:a_b', 'zz:a:b'];
const CASE_ONLY = ['zz:s', 'ZZ:S'];

const owner = { platform: 'onebot', userId: OWNER_QQ };
const webuiConsole = { platform: 'webui', userId: 'console' };

const renders = vi.hoisted(() => ({ png: new Uint8Array(0) }));
vi.mock(import('../../packages/util-chromium/src/index.js'), async importOriginal => ({
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

/** 会话表：群（带一个子会话与孙会话）、owner 的 IM 私聊、WebUI 会话、另一个群，与目录名撞车的两组 */
const SESSIONS = new Map<string, SessionInfo>([
  [GROUP, { ...(storedRoom(GROUP) as unknown as SessionInfo), children: [CHILD] }],
  [CHILD, session(CHILD, { parentId: GROUP, children: [GRANDCHILD] })],
  [GRANDCHILD, session(GRANDCHILD, { parentId: CHILD })],
  [OWNER_PRIVATE, storedRoom(OWNER_PRIVATE) as unknown as SessionInfo],
  [WEBUI, session(WEBUI, { createdFrom: 'webui' })],
  [OTHER_GROUP, storedRoom(OTHER_GROUP) as unknown as SessionInfo],
  ...[...SAME_DIR, ...CASE_ONLY].map(id => [id, session(id, { createdFrom: 'webui' })] as const),
]);

const isOwner = (platform: string, userId?: string) =>
  (platform === 'onebot' && userId === OWNER_QQ) || (platform === 'webui' && userId === 'console');

/**
 * 判据的依赖：会话表（sessions 为 false 时不给，即会话管理不在）、按会话给的历史；take 与 local 是替身，记下被问到的，
 * 回给定的结果（缺省都不放行）
 */
function deps(
  opts: {
    histories?: Record<string, Message[]>;
    sessions?: boolean;
    take?: (ids: readonly string[]) => boolean;
    local?: boolean;
  } = {},
) {
  const asked = { take: [] as string[][], local: 0 };
  const scope: MediaScopeDeps = {
    ...(opts.sessions === false
      ? {}
      : { sessions: { getSession: (id: string) => SESSIONS.get(id), listSessions: () => [...SESSIONS.values()] } }),
    take: async ids => {
      asked.take.push([...ids]);
      return opts.take?.(ids) ?? false;
    },
    local: async () => {
      asked.local += 1;
      return opts.local ?? false;
    },
    history: async sessionId => opts.histories?.[sessionId] ?? [],
  };
  return { ...scope, asked };
}

describe('三类目标的分流', () => {
  const history: Message[] = [
    {
      role: 'user',
      content: '',
      timestamp: 1,
      metadata: { [WellKnownMetadataKeys.Attachments]: [{ kind: 'image', ref: 'workspace:/pics/inbound.png' }] },
    },
    {
      role: 'assistant',
      content: '',
      timestamp: 2,
      metadata: { [WellKnownMetadataKeys.SentRef]: `data:/images/${OTHER_DIR}/onebot/sent.png` },
    },
  ];

  it('本会话树的媒体目录与本会话历史里记下的会话媒体：放行，不问 take 与 local', async () => {
    const d = deps({ histories: { [GROUP]: history } });
    for (const target of [
      ...['images', 'audios', 'videos', 'files'].map(dir => `data:/${dir}/${GROUP_DIR}/x.bin`),
      `tmp:/browser/${GROUP_DIR}/shot-1.png`,
      `data:/images/${sessionDirName(CHILD)}/x.png`,
      `data:/images/${OTHER_DIR}/onebot/sent.png`,
    ]) {
      expect(await mediaInScope(target, { sessionId: GROUP }, d), target).toBe(true);
    }
    expect(d.asked).toEqual({ take: [], local: 0 });
  });

  it.each([
    ['图片目录', `data:/images/${OTHER_DIR}/x.png`],
    ['文件目录', `data:/files/${OTHER_DIR}/x.pdf`],
    ['浏览器截图目录', `tmp:/browser/${OTHER_DIR}/shot-1.png`],
    ['带 .. 从本会话的目录绕过去', `data:/images/${GROUP_DIR}/../${OTHER_DIR}/x.png`],
    // 大小写不敏感的卷上读到的是同一个目录，不能按本机文件交给 local
    ['种类目录写成大写', `data:/Images/${OTHER_DIR}/x.png`],
    ['种类目录里的 s 写成 ſ', `data:/imageſ/${OTHER_DIR}/x.png`],
    ['截图目录写成大写', `tmp:/Browser/${OTHER_DIR}/shot-1.png`],
  ])('别的会话的媒体（%s）：交给 take，按它的结果，不问 local', async (_label, target) => {
    for (const verdict of [true, false]) {
      const d = deps({ take: () => verdict });
      expect(await mediaInScope(target, { sessionId: GROUP }, d)).toBe(verdict);
      expect(d.asked).toEqual({ take: [[OTHER_GROUP]], local: 0 });
    }
  });

  it.each([
    ['工作区的文件', 'workspace:/pics/a.png'],
    ['媒体目录本身（没有会话目录）', 'data:/images/x.png'],
    ['带 .. 绕出媒体目录', `data:/images/${GROUP_DIR}/../../users.json`],
    ['别的根里同名的目录', `workspace:/images/${GROUP_DIR}/x.png`],
  ])('不在任何会话媒体目录下的（%s）：交给 local，按它的结果，不问 take', async (_label, target) => {
    for (const verdict of [true, false]) {
      const d = deps({ local: verdict });
      expect(await mediaInScope(target, { sessionId: GROUP }, d)).toBe(verdict);
      expect(d.asked).toEqual({ take: [], local: 1 });
    }
  });

  it.each([
    ['反斜杠分隔（Windows 上按目录分隔解析）', `data:/images/${GROUP_DIR}/..\\..\\users.json`],
    ['不是存储地址', `file:///images/${GROUP_DIR}/x.png`],
    ['网址', 'https://example.invalid/a.png'],
  ])('%s：不能，不问 take 与 local', async (_label, target) => {
    const d = deps({ take: () => true, local: true });
    expect(await mediaInScope(target, { sessionId: GROUP }, d)).toBe(false);
    expect(d.asked).toEqual({ take: [], local: 0 });
  });
});

describe('目录名有损', () => {
  it.each([
    ['会话 id 只在 `:` 与 `_` 上有区别', SAME_DIR, sessionDirName(SAME_DIR[0])],
    ['只差大小写（大小写不敏感的卷上同一个目录）', CASE_ONLY, sessionDirName(CASE_ONLY[1])],
    ['目录名里的 s 写成 ſ（大小写不敏感的卷上同一个目录）', CASE_ONLY, 'zz_ſ'],
  ])('%s：两个会话都算候选，都过 take 才能取', async (_label, ids, dir) => {
    const target = `data:/images/${dir}/x.png`;
    const both = deps({ take: () => true });
    expect(await mediaInScope(target, { sessionId: GROUP }, both)).toBe(true);
    expect(both.asked.take.map(asked => [...asked].sort())).toEqual([[...ids].sort()]);
    for (const passing of ids) {
      const one = deps({ take: asked => asked.every(id => id === passing) });
      expect(await mediaInScope(target, { sessionId: GROUP }, one), passing).toBe(false);
    }
  });

  it.each([
    ['只在 `:` 与 `_` 上有区别', SAME_DIR[0], sessionDirName(SAME_DIR[0]), [SAME_DIR[1]]],
    ['只差大小写', CASE_ONLY[0], sessionDirName(CASE_ONLY[0]), [CASE_ONLY[1]]],
    ['只差大小写，写成撞上的那个会话的目录名', CASE_ONLY[0], sessionDirName(CASE_ONLY[1]), [CASE_ONLY[1]]],
  ])('本会话的目录名与别的会话撞车（%s）：撞上的别的会话也要过 take，本会话树的不问', async (_label, sessionId, dir, others) => {
    for (const verdict of [true, false]) {
      const d = deps({ take: () => verdict });
      expect(await mediaInScope(`data:/images/${dir}/x.png`, { sessionId }, d)).toBe(verdict);
      expect(d.asked).toEqual({ take: [others], local: 0 });
    }
  });

  it('本会话的目录名换了大小写、没有撞名：按折叠比认出是本会话，放行、不问 take', async () => {
    const d = deps({ take: () => false });
    expect(await mediaInScope(`data:/images/${GROUP_DIR.toUpperCase()}/x.png`, { sessionId: GROUP }, d)).toBe(true);
    expect(d.asked).toEqual({ take: [], local: 0 });
  });

  it('目录名反查不到会话（会话已删）：不能，不问 take', async () => {
    const d = deps({ take: () => true, local: true });
    expect(await mediaInScope('data:/images/onebot_10000_group_29999/x.png', { sessionId: GROUP }, d)).toBe(false);
    expect(d.asked).toEqual({ take: [], local: 0 });
  });

  it('会话管理不在：只认调用所在会话自己的目录，别的会话的媒体一律不能，本机文件照样交给 local', async () => {
    const d = deps({ sessions: false, take: () => true, local: true });
    expect(await mediaInScope(`data:/images/${GROUP_DIR}/x.png`, { sessionId: GROUP }, d)).toBe(true);
    expect(await mediaInScope(`data:/images/${OTHER_DIR}/x.png`, { sessionId: GROUP }, d)).toBe(false);
    // 子会话的父会话也取不到：只认它自己
    expect(await mediaInScope(`data:/images/${GROUP_DIR}/x.png`, { sessionId: CHILD }, d)).toBe(false);
    expect(d.asked.take).toEqual([]);
    expect(await mediaInScope('workspace:/pics/a.png', { sessionId: GROUP }, d)).toBe(true);
    expect(d.asked.local).toBe(1);
  });
});

describe('本机文件判法（localFileInScope）', () => {
  const lookup = { getSession: (id: string) => SESSIONS.get(id) };
  const fileDeps = (sessions = true) => ({
    principalOf: (call: MediaScopeCall) => principalKind({ ...call, platform: call.platform ?? '' }, isOwner),
    isOwner,
    ...(sessions ? { sessions: lookup } : {}),
  });
  /** 一轮的工具调用：由这一轮的输入拼出，与 agent 给工具调用上下文的一样 */
  const turn = (message: Omit<IncomingMessage, 'content'>): MediaScopeCall =>
    originTurnOf([{ content: '', ...message }]);
  /** owner 在群里亲手那一轮 */
  const ownerInGroup = turn({ sessionId: GROUP, platform: 'onebot', userId: OWNER_QQ });

  it.each([
    ['owner 在群里亲手那一轮', ownerInGroup, true],
    [
      'owner 在群里那一轮派的子任务',
      turn({
        sessionId: CHILD,
        platform: 'onebot',
        userId: `parent:${GROUP}`,
        source: 'subtask',
        fromTurn: { platform: 'onebot', userId: OWNER_QQ, participants: [owner] },
      }),
      true,
    ],
    ['群成员在群里亲手那一轮', turn({ sessionId: GROUP, platform: 'onebot', userId: MEMBER_QQ }), false],
    [
      '群里 owner 建的定时任务（授权身份是 owner）',
      turn({ sessionId: GROUP, platform: 'onebot', source: 'scheduler', actor: owner }),
      false,
    ],
    [
      'owner 私聊里她建的定时任务（非人回合的条款）',
      turn({ sessionId: OWNER_PRIVATE, platform: 'onebot', source: 'scheduler', actor: owner }),
      true,
    ],
    [
      'owner 私聊里的非人回合、参与者不只 owner（非人回合的条款只认唯一的参与者）',
      {
        sessionId: OWNER_PRIVATE,
        platform: 'onebot',
        inbound: { source: 'scheduler' },
        participants: [owner, { platform: 'onebot', userId: MEMBER_QQ }],
      },
      false,
    ],
    [
      'owner 会话里的宿主通知（selfInitiatedActor）',
      { sessionId: WEBUI, participants: [selfInitiatedActor('webui')] },
      false,
    ],
    [
      'MCP 客户端',
      { sessionId: 'mcp-server', platform: 'mcp', participants: [{ platform: 'mcp', userId: 'mcp-client' }] },
      false,
    ],
    ['匿名编排', { sessionId: 'workflow::wf-2', participants: [selfInitiatedActor('workflow')] }, false],
  ] satisfies [string, MediaScopeCall, boolean][])('%s', (_label, call, expected) => {
    expect(localFileInScope(call, fileDeps())).toBe(expected);
  });

  it('会话管理不在：非人回合的条款判不出受众，不放行；主体是 owner 的照旧能取', () => {
    const scheduled = { sessionId: WEBUI, platform: 'webui', participants: [webuiConsole] };
    expect(localFileInScope(scheduled, fileDeps())).toBe(true);
    expect(localFileInScope(scheduled, fileDeps(false))).toBe(false);
    expect(localFileInScope(ownerInGroup, fileDeps(false))).toBe(true);
  });
});

describe('地址规整（mediaRef）', () => {
  it('网址（协议名不分大小写）原样，存储地址规整（消 `.`、`..`）', () => {
    expect(mediaRef('https://example.invalid/a.png')).toBe('https://example.invalid/a.png');
    expect(mediaRef('HTTP://example.invalid/a.png')).toBe('HTTP://example.invalid/a.png');
    expect(mediaRef(`data:/images/${GROUP_DIR}/./x/../a.png`)).toBe(`data:/images/${GROUP_DIR}/a.png`);
  });

  it.each([
    ['盘符路径（与单字母根名冲突时按盘符认）', 'C:/pics/a.png'],
    ['反斜杠分隔', 'C:\\pics\\a.png'],
    ['本机绝对路径', '/pics/a.png'],
    ['file://', 'file:///pics/a.png'],
    ['data URI', 'data:image/png;base64,AAAA'],
    ['相对路径（不是存储地址）', `data/images/${GROUP_DIR}/a.png`],
  ])('%s：没有', (_label, input) => {
    expect(mediaRef(input)).toBeUndefined();
  });
});

describe('会话树', () => {
  it('子会话与孙会话里能用根会话目录里的图，根会话里能用子会话与孙会话目录里的图', async () => {
    for (const [from, to] of [
      [CHILD, GROUP],
      [GRANDCHILD, GROUP],
      [GROUP, CHILD],
      [GROUP, GRANDCHILD],
      [CHILD, GRANDCHILD],
    ]) {
      expect(
        await mediaInScope(`data:/images/${sessionDirName(to)}/x.png`, { sessionId: from }, deps()),
        `${from} → ${to}`,
      ).toBe(true);
    }
    expect(await mediaInScope(`data:/images/${OTHER_DIR}/x.png`, { sessionId: CHILD }, deps())).toBe(false);
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
  ];

  it('正文里的占位符不算：按本机文件交给 local', async () => {
    const d = deps({ histories: { [GROUP]: history } });
    expect(await mediaInScope('workspace:/pics/forged.png', { sessionId: GROUP }, d)).toBe(false);
    expect(d.asked.local).toBe(1);
  });

  it('历史里记过的本机文件（入站附件清单与发出的附件）：照旧按本机文件交给 local，按地址取到的是此刻的内容', async () => {
    const sent: Message = {
      role: 'assistant',
      content: '',
      timestamp: 2,
      metadata: { [WellKnownMetadataKeys.SentRef]: 'workspace:/shots/latest.png' },
    };
    const d = deps({ histories: { [GROUP]: [...history, sent] } });
    expect(await mediaInScope('workspace:/shots/latest.png', { sessionId: GROUP }, d)).toBe(false);
    expect(await mediaInScope('workspace:/pics/inbound.png', { sessionId: GROUP }, d)).toBe(false);
    expect(d.asked.local).toBe(2);
    const owner = deps({ histories: { [GROUP]: [...history, sent] }, local: true });
    expect(await mediaInScope('workspace:/shots/latest.png', { sessionId: GROUP }, owner)).toBe(true);
  });

  it('只看调用所在的会话：子会话里用根会话历史里的引用，按本机文件交给 local', async () => {
    const d = deps({ histories: { [GROUP]: history } });
    expect(await mediaInScope('workspace:/pics/inbound.png', { sessionId: CHILD }, d)).toBe(false);
    expect(d.asked.local).toBe(1);
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
      const ref = await cacheOneAttachment(
        storage,
        proc as never,
        kind,
        data,
        sessionId,
        1 << 20,
        { warn: () => {} },
        new AbortController().signal,
      );
      if (!ref) throw new Error(`${kind} 没有落盘`);
      refs.push(ref);
    }
    expect(refs.map(r => r.split('/').slice(1, 4))).toEqual(
      ['images', 'audios', 'videos', 'files'].map(dir => [dir, sessionDirName(sessionId), 'onebot']),
    );
    for (const ref of refs) expect(await mediaInScope(ref, { sessionId }, deps()), ref).toBe(true);
  });

  it.each([GROUP, 'zz..odd'])('绘图落盘（会话 %s）', async sessionId => {
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
      toolContext({ sessionId }),
    );
    const { uri } = JSON.parse(typeof out === 'string' ? out : out.content) as { uri: string };
    expect([...files.keys()]).toEqual([uri]);
    expect(uri.startsWith(`data:/images/${sessionDirName(sessionId)}/draw/`), uri).toBe(true);
    expect(await mediaInScope(uri, { sessionId }, deps())).toBe(true);
  });

  it('媒体识别把入站的图落盘，地址写在附件的 ref 上（存档的附件清单按它记）', async () => {
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
    expect(uri.startsWith(`data:/images/${sessionDirName(OWNER_PRIVATE)}/media/`), uri).toBe(true);
    expect(msg.attachments?.[0]?.ref).toBe(uri);
    expect(await mediaInScope(uri, { sessionId: OWNER_PRIVATE }, deps())).toBe(true);
  });
});
