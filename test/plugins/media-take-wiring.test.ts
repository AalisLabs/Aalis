import { afterEach, describe, expect, it } from 'vitest';
import { authority, type OriginTurn } from '../../packages/api-authority/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { sessionDirName } from '../../packages/api-media/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type RegisteredTool, type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, events, provide } from '../../packages/core/src/index.js';
import { principalKind } from '../../packages/plugin-authority/src/authority-model.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { registerMediaTools } from '../../packages/plugin-media/src/tools.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { silentLogger } from '../fixtures/authority.js';
import { storedRoom } from '../fixtures/rooms.js';
import { emptyMediaCaps } from '../fixtures/service-ref.js';
import { ONEBOT_TYPES, startSettings } from '../fixtures/session-settings.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 发媒体、看图的工具与回复里的媒体标记接上会话管理的取用规则（真的会话管理，默认的范围与开关：同平台、读别的群、不读
// 别人的私聊）：
// - send_attachment 与 analyze_image 按这次调用过 api-media 的 mediaScopeOf：取用判定经契约的包装函数、带这次调用的授权
//   身份（这里一轮只有一位参与者；几个人的一轮经 approveFor 逐个判，见 participant-take），本机文件交给本机文件判法（主体用
//   权限插件的 principalKind）。逐行的表跑 send_attachment，analyze_image 只核接线；
// - 她回复里存储地址的标记不带授权身份过同一份判据，受众只有 owner 的会话照旧不过判据。
// 存储、权限与工具服务是替身。
// ════════════════════════════════════════════════════════════

const SELF = '10000';
const G1 = `onebot:${SELF}:group:20001`;
const G2 = `onebot:${SELF}:group:20002`;
/** 群成员 A、B 与她的私聊，owner 与她的私聊 */
const PA = `onebot:${SELF}:private:30001`;
const PB = `onebot:${SELF}:private:30002`;
const PO = `onebot:${SELF}:private:39999`;
const A = { platform: 'onebot', userId: '30001' };
const OWNER = { platform: 'onebot', userId: '39999' };

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
/** 一个会话媒体目录里的图 */
const imageOf = (sessionId: string) => `data:/images/${sessionDirName(sessionId)}/onebot/0123456789abcdef.png`;
/** 不在任何会话媒体目录下的本机文件 */
const LOCAL = 'data:/downloads/zz-placeholder.png';
const FILES = new Map<string, Uint8Array>([...[G2, PA, PB].map(imageOf), LOCAL].map(uri => [uri, PNG]));

const SEND_OUT_OF_SCOPE =
  '这个文件不在这一轮能取的范围里：别的会话的媒体按这个会话的取用范围与开关；本机文件要这一轮里有 owner 的话、有别人时经她批准，或是 owner 授权的自动运行且会话里没有别人';
const VIEW_OUT_OF_SCOPE =
  '这张图不在这一轮能看的范围里：别的会话的媒体按这个会话的取用范围与开关；本机文件要这一轮里有 owner 的话、有别人时经她批准，或是 owner 授权的自动运行且会话里没有别人';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const fileStorage = {
  listRoots: () => [{ name: 'data', kind: 'data' }],
  readFile: async (uri: string) => read(uri),
  readFileRange: async (uri: string, start: number, end: number) => read(uri).subarray(start, end),
} as unknown as StorageService;

function read(uri: string): Uint8Array {
  const data = FILES.get(uri);
  if (!data) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
  return data;
}

async function setup() {
  const handlers = new Map<string, RegisteredTool['handler']>();
  const isOwner = (platform: string, userId?: string) => platform === OWNER.platform && userId === OWNER.userId;
  const started = await startSettings({
    adapters: [{ platform: 'onebot', sessionTypes: ONEBOT_TYPES }],
    stored: Object.fromEntries([G1, G2, PA, PB, PO].map(id => [id, storedRoom(id)])),
    first: [
      definePlugin({
        name: 'zz-tools',
        provides: [tools],
        uses: { provide },
        apply: ({ provide }) => {
          provide.use(tools, {
            register(tool: Omit<RegisteredTool, 'pluginName'>) {
              handlers.set(tool.definition.function.name, tool.handler);
              return () => void handlers.delete(tool.definition.function.name);
            },
            registerGroup: () => () => {},
          } as never);
        },
      }),
      definePlugin({
        name: 'zz-storage',
        provides: [storage],
        uses: { provide },
        apply: ({ provide }) => void provide.use(storage, fileStorage),
      }),
      definePlugin({
        name: 'zz-authority',
        provides: [authority],
        uses: { provide },
        apply: ({ provide }) =>
          void provide.use(authority, {
            isOwner,
            principalOf: (turn: OriginTurn) => principalKind(turn, isOwner),
          } as never),
      }),
    ],
    plugins: [imageSenderPlugin],
  });
  const { app } = started;
  apps.push(app);
  await app.start();
  await app.plugins.idle();
  started.host.events.use.on('outbound:message', message => {
    message.delivery = Promise.resolve({ ok: true });
  });
  setMediaRuntime({ proc: {} as never, storage: fileStorage });
  const config = {
    vision: { recognizeOnArrival: false, delivery: 'passthrough', maxTokens: 300, think: false },
    audio: { mode: 'disabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
    senderContext: { enabled: false, profileMaxChars: 0 },
  } as unknown as MediaConfigResolved;
  registerMediaTools(
    app.bind({ tools, memory, events, sessionManager, authority }),
    new MediaServiceImpl(emptyMediaCaps(silentLogger()), config),
  );
  const call = async (name: string, args: Record<string, unknown>, ctx: ToolCallContext) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`工具 ${name} 未注册`);
    return handler(args, ctx);
  };
  const dispatch = (message: OutgoingMessage) =>
    app.bind({ hooks }).hooks.use.run('outbound:dispatch', { message, metadata: {} }, async () => {});
  return { call, dispatch };
}

/** 在 G1 里亲手发来的一轮的工具调用 */
const inG1 = (who: { platform: string; userId: string }): ToolCallContext =>
  toolContext({ sessionId: G1, platform: who.platform, userId: who.userId, inbound: {}, acceptsImages: true });

const ROWS: Array<[label: string, ctx: ToolCallContext, target: string, allowed: boolean]> = [
  ['群成员取同平台别的群的', inG1(A), imageOf(G2), true],
  ['群成员取别人与她的私聊里的', inG1(A), imageOf(PB), false],
  ['群成员取他自己与她的私聊里的', inG1(A), imageOf(PA), true],
  ['群成员取本机文件', inG1(A), LOCAL, false],
  ['owner 在群里亲手取本机文件', inG1(OWNER), LOCAL, true],
];

describe('send_attachment 与 analyze_image 按会话管理的取用规则与本机文件判法', () => {
  it.each(ROWS)('send_attachment：%s', async (_label, ctx, target, allowed) => {
    const { call } = await setup();
    const result = JSON.parse(String(await call('send_attachment', { kind: 'image', storage_uri: target }, ctx)));
    expect(result).toEqual(
      allowed ? { ok: true, sent: { kind: 'image', via: 'storage_uri', ref: target } } : { error: SEND_OUT_OF_SCOPE },
    );
  });

  it('analyze_image 带这次调用判：owner 在群里亲手取本机文件能看，群成员取不到', async () => {
    const { call } = await setup();
    expect(await call('analyze_image', { image: LOCAL }, inG1(OWNER))).toMatchObject({
      images: [expect.stringMatching(/^data:image\/png;base64,/)],
    });
    expect(JSON.parse(String(await call('analyze_image', { image: LOCAL }, inG1(A))))).toEqual({
      error: VIEW_OUT_OF_SCOPE,
    });
  });
});

describe('她回复里存储地址的标记', () => {
  const markup = `一<image url="${imageOf(G2)}"/>二<image url="${imageOf(PB)}"/>三<image url="${LOCAL}"/>`;

  it('群里：同平台别的群（在会话表里）的转成附件；别人私聊里的与本机文件不转，留在正文里', async () => {
    const { dispatch } = await setup();
    const message: OutgoingMessage = { sessionId: G1, source: 'agent', markup: true, content: markup };
    await dispatch(message);
    expect(message.attachments).toEqual([{ kind: 'image', data: imageOf(G2) }]);
    expect(message.content).toBe(`一二<image url="${imageOf(PB)}"/>三<image url="${LOCAL}"/>`);
  });

  it('受众只有 owner 的私聊：不过判据，都转成附件', async () => {
    const { dispatch } = await setup();
    const message: OutgoingMessage = { sessionId: PO, source: 'agent', markup: true, content: markup };
    await dispatch(message);
    expect(message.attachments?.map(att => att.data)).toEqual([imageOf(G2), imageOf(PB), LOCAL]);
    expect(message.content).toBe('一二三');
  });
});
