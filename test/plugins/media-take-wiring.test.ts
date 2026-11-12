import { afterEach, describe, expect, it } from 'vitest';
import type { TurnInput } from '../../packages/api-agent/src/index.js';
import { authority, type OriginTurn } from '../../packages/api-authority/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { sessionDirName } from '../../packages/api-media/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type RegisteredTool, type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, provide } from '../../packages/core/src/index.js';
import { principalKind } from '../../packages/plugin-authority/src/authority-model.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { registerMediaTools } from '../../packages/plugin-media/src/tools.js';
import type { IncomingMessage, OutgoingMessage } from '../../packages/schema-message/src/index.js';
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
// - 她回复里存储地址的标记过同一份判据：按回复的回合 id 取回这一轮的输入（agent:turn:before 记下的引用），授权身份取
//   actingIdentity（几个人时不传）；认不出这一轮的不带授权身份判。
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
  const host = app.bind({ hooks });
  const dispatch = (message: OutgoingMessage) =>
    host.hooks.use.run('outbound:dispatch', { message, metadata: {} }, async () => {});
  let turns = 0;
  /**
   * 一轮里她的回复经网关派发：先跑 agent:turn:before（输入是 inputs），回复带这一轮的回合 id、发往 to（缺省是这一轮的会话）；
   * during 在派发之前跑，拿到这一轮的钩子数据（往 inputs 里追加的就是插进来的输入）
   */
  const replyIn = async (
    inputs: IncomingMessage[],
    content: string,
    { during, to }: { during?: (data: HookContextMap['agent:turn:before']) => void; to?: string } = {},
  ) => {
    const turnId = `t${++turns}`;
    const sessionId = inputs[0].sessionId;
    const message: OutgoingMessage = { sessionId: to ?? sessionId, source: 'agent', markup: true, content, turnId };
    const data = { turnId, sessionId, inputs: inputs.map(m => ({ message: m })) };
    await host.hooks.use.run('agent:turn:before', data, async () => {
      during?.(data);
      await dispatch(message);
    });
    return message.attachments?.map(att => att.data) ?? [];
  };
  return { call, dispatch, replyIn };
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
});

describe('她回复里存储地址的标记按这一轮的授权身份判（与工具同一份判据）', () => {
  /** sessionId 里 who 亲手说的一句 */
  const said = (sessionId: string, who: { platform: string; userId: string }): IncomingMessage => ({
    content: '<占位>',
    sessionId,
    platform: who.platform,
    userId: who.userId,
  });
  const tag = (uri: string) => `<image url="${uri}"/>`;

  it('同平台别的群的：群成员那一轮、受众只有 owner 的会话里空闲开话题那一轮都转', async () => {
    const { replyIn } = await setup();
    expect(await replyIn([said(G1, A)], tag(imageOf(G2)))).toEqual([imageOf(G2)]);
    const idle: IncomingMessage = { content: '<占位>', sessionId: PO, platform: 'onebot', source: 'idle-trigger' };
    expect(await replyIn([idle], tag(imageOf(G2)))).toEqual([imageOf(G2)]);
  });

  it('别人私聊里的不转，owner 那一轮同样不转；群友 A 那一轮里他自己私聊里的转', async () => {
    const { replyIn } = await setup();
    expect(await replyIn([said(G1, A)], tag(imageOf(PB)))).toEqual([]);
    expect(await replyIn([said(PO, OWNER)], tag(imageOf(PB)))).toEqual([]);
    expect(await replyIn([said(G1, A)], tag(imageOf(PA)))).toEqual([imageOf(PA)]);
  });

  it('本机文件：只有 owner 的那一轮转，群成员那一轮不转；受众判不出的会话里授权身份是 owner 的非人回合也转', async () => {
    const { replyIn } = await setup();
    expect(await replyIn([said(PO, OWNER)], tag(LOCAL))).toEqual([LOCAL]);
    expect(await replyIn([said(G1, OWNER)], tag(LOCAL))).toEqual([LOCAL]);
    expect(await replyIn([said(G1, A)], tag(LOCAL))).toEqual([]);
    const scheduled: IncomingMessage = {
      content: '<占位>',
      sessionId: 'zz-internal:1',
      platform: 'onebot',
      source: 'scheduler',
      actor: OWNER,
    };
    expect(await replyIn([scheduled], tag(LOCAL))).toEqual([LOCAL]);
  });

  it('按回合记下的是 inputs 的引用：A 那一轮插进 owner 的输入之后，回复里 A 私聊的标记不再转', async () => {
    const { replyIn } = await setup();
    const sent = await replyIn([said(G1, A)], tag(imageOf(PA)), {
      during: data => {
        // 钩子数据里的 inputs 对中间件只读，插进来的输入由 agent 追加：这里替它追加
        (data.inputs as TurnInput[]).push({ message: said(G1, OWNER) });
      },
    });
    expect(sent).toEqual([]);
  });

  it('取用范围按出站的目标会话判：带着这一轮的回合 id 发往别的会话的，那个会话自己的媒体照转', async () => {
    const { replyIn } = await setup();
    expect(await replyIn([said(G1, A)], tag(imageOf(PB)), { to: PB })).toEqual([imageOf(PB)]);
  });
});
