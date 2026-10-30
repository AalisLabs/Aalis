import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { media } from '../../packages/api-media/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import toolOnebot from '../../packages/plugin-tool-onebot/src/index.js';
import { buildIncomingContent, type IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// tool-onebot 的结局：失败一律抛错（执行层按失败记），成功才返回结果。
// - 戳一戳只在实现端回「不支持该动作」时才换动作名，超时、没权限这类错误原样交出，不换个动作再戳一次。
// - 群管工具在机器人不够权限时报错，不发出动作；查目标成员与撤回失败时报错只带适配器的原话，不猜原因；查目标成员时实现端
//   没给成员信息或没给角色的同样报错，不当普通成员；机器人自身没给角色的与取不到自身信息一样跳过检查。
// - 合并转发命中适配器缓存时，截断标志与没列出的参与人数写在结果的头一行；没命中时节点为空回「内容为空」，返回格式认不出、拉取失败都报错，
//   报错只带适配器的原话，不猜原因。入站展开时拉取失败的不进缓存，工具照常重新拉。没展开过的（关掉展开、拉不到的）同样按收到它的
//   会话过取用判定，过了才向实现端现拉；从没收到过的判不出、不拉（这里没有会话管理：只取得到当前会话里收到的）。
// - 群会话里写明 self_id 时动作发给写明的账号，不被会话的账号盖掉。
// - 两个群请求工具各认自己的申请类型：入群邀请不能用审批加群申请的工具批；没有这条申请时报错。
// - 合并转发里的图经 get_image 换成存储地址时，读出来按文件头认：是图片才转成 data URI（类型取判定结果），不是的交原地址。
//   图片段里写的只有网址与 base64 的 data URL 当来源，别的只交给 get_image 换地址，换不出就不识别。
// 群请求与转发缓存两组起真适配器加本地的假 OneBot 实现端（记忆用内存实现，转发缓存的持久化层落在里面），其余各组的平台是
// 宿主桩（tools 同样是只记处理函数的桩）。
// ════════════════════════════════════════════════════════════

const SELF = '10001';
const GROUP = `onebot:${SELF}:group:20002`;
const PRIVATE = `onebot:${SELF}:private:30001`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

/** 只记处理函数的 tools 桩；call 以 OneBot 会话的上下文调一个工具 */
function toolRecorder(app: App) {
  const handlers = new Map<string, RegisteredTool['handler']>();
  app.bind({ provide }).provide.use(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  return (name: string, args: Record<string, unknown>, sessionId = GROUP) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`工具 ${name} 未注册`);
    return handler(args, toolContext({ sessionId, platform: 'onebot' }));
  };
}

/**
 * 宿主桩：一个在线账号的 OneBot 平台，动作交给 respond，记下动作名与动作发往的会话 id（工具用账号的合成会话 id）；extra 是
 * 适配器另给的扩展方法，host 是宿主另给的存储与媒体服务
 */
async function withStub(
  respond: (action: string, params: Record<string, unknown>) => Promise<unknown>,
  extra: Record<string, unknown> = {},
  host: { storage?: unknown; media?: unknown } = {},
) {
  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const call = toolRecorder(app);
  const { provide: services } = app.bind({ provide });
  if (host.storage) services.use(storage, host.storage as never);
  if (host.media) services.use(media, host.media as never);
  const actions: string[] = [];
  const targets: string[] = [];
  const adapter: PlatformAdapter = {
    adapterName: 'onebot',
    platform: 'onebot',
    getConnections: () => [{ id: `onebot:${SELF}`, platform: 'onebot', selfId: SELF, status: 'online' }],
    sendMessage: async () => {},
    callAction: async (sessionId, action, params) => {
      actions.push(action);
      targets.push(sessionId);
      return respond(action, params);
    },
    ...extra,
  };
  app.bind({ provide }).provide.use(platform, adapter);
  await app.plugin(toolOnebot);
  await app.start();
  await app.plugins.idle();
  return { call, actions, targets };
}

/** 适配器对没展开过、在本群收到过的转发交回的形状：收到它的会话与按 id 现拉的办法，现拉得到 data */
const unexpanded = (data: unknown) => ({ __aalisForwardReceipt: true, sessionIds: [GROUP], fetch: async () => data });

/** 适配器的动作失败：超时（结果未知）与实现端回不支持该动作 */
const timedOut = () => new Error('OneBot action 没等到回执（30 秒超时），结果未知，可能已经执行');
const unsupported = (action: string) =>
  Object.assign(new Error(`OneBot action ${action} 失败（retcode=1404）：不支持的API ${action}`), {
    unsupported: true,
    retcode: 1404,
  });

describe('戳一戳：只在实现端不支持该动作时换动作名', () => {
  it('群里 group_poke 超时：报这个错，不再调 send_group_poke', async () => {
    const { call, actions } = await withStub(async action => {
      if (action === 'group_poke') throw timedOut();
      return {};
    });
    await expect(call('onebot_poke', { user_id: '30001' })).rejects.toThrow('结果未知');
    expect(actions).toEqual(['group_poke']);
  });

  it('私聊 friend_poke 超时：报这个错，不再调 send_poke', async () => {
    const { call, actions } = await withStub(async action => {
      if (action === 'friend_poke') throw timedOut();
      return {};
    });
    await expect(call('onebot_poke', {}, PRIVATE)).rejects.toThrow('结果未知');
    expect(actions).toEqual(['friend_poke']);
  });

  it('实现端不支持 group_poke：改调 send_group_poke 并成功', async () => {
    const { call, actions } = await withStub(async action => {
      if (action === 'group_poke') throw unsupported(action);
      return {};
    });
    expect(String(await call('onebot_poke', { user_id: '30001' }))).toContain('戳了 30001');
    expect(actions).toEqual(['group_poke', 'send_group_poke']);
  });
});

describe('失败抛错', () => {
  it('机器人不是管理员时禁言报错，不发出 set_group_ban', async () => {
    const { call, actions } = await withStub(async action =>
      action === 'get_group_member_info' ? { role: 'member' } : {},
    );
    await expect(call('onebot_group_ban', { user_id: '30001' })).rejects.toThrow('不是管理员');
    expect(actions).not.toContain('set_group_ban');
  });

  it('查目标成员失败：报错只带适配器的原话，不猜「可能不在群中」', async () => {
    const { call, actions } = await withStub(async (action, params) => {
      if (action !== 'get_group_member_info') return {};
      if (params.user_id === Number(SELF)) return { role: 'admin' };
      throw new Error('<占位原话>');
    });
    await expect(call('onebot_group_ban', { user_id: '30001' })).rejects.toThrow(
      /^操作失败：无法获取用户 30001 的信息：<占位原话>$/,
    );
    expect(actions).not.toContain('set_group_ban');
  });

  it('查目标成员时实现端回成功却没给成员信息：按失败报，不当普通成员放行', async () => {
    const { call, actions } = await withStub(async (action, params) => {
      if (action !== 'get_group_member_info') return {};
      return params.user_id === Number(SELF) ? { role: 'admin' } : null;
    });
    await expect(call('onebot_group_ban', { user_id: '30001' })).rejects.toThrow(
      /^操作失败：无法获取用户 30001 的信息：实现端没给成员信息$/,
    );
    expect(actions).not.toContain('set_group_ban');
  });

  it('查目标成员时实现端给了成员信息却没给角色：按失败报，不当普通成员放行', async () => {
    const { call, actions } = await withStub(async (action, params) => {
      if (action !== 'get_group_member_info') return {};
      return params.user_id === Number(SELF) ? { role: 'admin' } : { nickname: '占位' };
    });
    await expect(call('onebot_group_ban', { user_id: '30001' })).rejects.toThrow(
      /^操作失败：无法获取用户 30001 的信息：实现端没给成员角色$/,
    );
    expect(actions).not.toContain('set_group_ban');
  });

  it('机器人自身的成员信息没给角色：与取不到自身信息一样跳过检查，不当普通成员拦下', async () => {
    const { call, actions } = await withStub(async () => ({}));
    await call('onebot_group_ban', { user_id: '30001' });
    expect(actions).toContain('set_group_ban');
  });

  it('撤回自己发的消息全部失败：报错只带适配器的原话，不猜可撤回的时限', async () => {
    const { call } = await withStub(
      async action => {
        if (action === 'delete_msg') throw new Error('<占位原话>');
        return {};
      },
      { getSentMessages: () => [{ messageId: '1', ts: 0, preview: '占位' }] },
    );
    await expect(call('onebot_recall_self', {})).rejects.toThrow(/^撤回失败：「占位」: <占位原话>$/);
  });

  it('合并转发命中适配器缓存、节点超限截断过：结果头一行写明已截断', async () => {
    const { call } = await withStub(async action =>
      action === 'get_forward_msg'
        ? {
            __aalisForwardEntry: true,
            fullText: '1. 甲(30001): 一\n2. 甲(30001): 二',
            summary: null,
            count: 3,
            participants: ['甲(30001)'],
            truncatedDepth: false,
            truncatedNodes: true,
            sessionIds: [GROUP],
          }
        : {},
    );
    const [header] = String(await call('onebot_get_forward_msg', { id: 'zz-forward' })).split('\n');
    expect(header).toContain('已截断（节点超限）');
  });

  it('合并转发没命中缓存：节点为空回「内容为空」，返回格式认不出时报错', async () => {
    let data: unknown = { messages: [] };
    const { call } = await withStub(async action => (action === 'get_forward_msg' ? unexpanded(data) : {}));
    expect(await call('onebot_get_forward_msg', { id: 'zz-forward' })).toBe('合并转发内容为空');
    data = { zz: 1 };
    await expect(call('onebot_get_forward_msg', { id: 'zz-forward' })).rejects.toThrow('返回格式认不出');
  });

  it('拉取失败：报错只带适配器的原话，不猜原因', async () => {
    const { call } = await withStub(async () => {
      throw new Error('<占位原话>');
    });
    await expect(call('onebot_get_forward_msg', { id: 'zz-forward' })).rejects.toThrow(
      /^合并转发读取失败：<占位原话>$/,
    );
    const pulling = await withStub(async () => ({
      __aalisForwardReceipt: true,
      sessionIds: [GROUP],
      fetch: async () => {
        throw new Error('<占位原话>');
      },
    }));
    await expect(pulling.call('onebot_get_forward_msg', { id: 'zz-forward' })).rejects.toThrow(
      /^合并转发读取失败：<占位原话>$/,
    );
    await expect(call('onebot_get_msg', { message_id: '1' })).rejects.toThrow(/^获取消息失败：<占位原话>$/);
  });
});

describe('合并转发里的图：get_image 给的地址原样交给识图', () => {
  it('get_image 给的是存储地址：不读存储，原地址交给 media（由它按文件头认）', async () => {
    const reads: string[] = [];
    const sources: string[] = [];
    const { call } = await withStub(
      async action => {
        if (action === 'get_image') return { file: 'zz:/x.png' };
        if (action === 'get_forward_msg') {
          return unexpanded({
            messages: [
              { type: 'node', data: { nickname: '甲', content: [{ type: 'image', data: { file: 'zz-image-id' } }] } },
            ],
          });
        }
        return {};
      },
      {},
      {
        storage: {
          readFile: async (uri: string) => {
            reads.push(uri);
            return Buffer.from('ffd8ffe000104a464946', 'hex');
          },
        },
        media: {
          describeImage: async (source: string) => {
            sources.push(source);
            return '占位描述';
          },
        },
      },
    );
    await call('onebot_get_forward_msg', { id: 'zz-forward' });
    expect(sources).toEqual(['zz:/x.png']);
    expect(reads).toEqual([]);
  });
});

describe('合并转发里的图：消息段里写的只有网址与 base64 的 data URL 当来源', () => {
  it.each([
    '/zz-placeholder/a.png',
    'file:///zz-placeholder/a.png',
    'data:/zz-placeholder/a.png',
    'data:/zz-placeholder/;base64,x/../a.png',
  ])('图片段只有 file（%s）、get_image 换不出地址：不读存储，不交给识图', async file => {
    const reads: string[] = [];
    const sources: string[] = [];
    const { call, actions } = await withStub(
      async action => {
        if (action === 'get_image') throw new Error('<占位原话>');
        if (action === 'get_forward_msg') {
          return unexpanded({
            messages: [{ type: 'node', data: { nickname: '甲', content: [{ type: 'image', data: { file } }] } }],
          });
        }
        return {};
      },
      {},
      {
        storage: {
          readFile: async (uri: string) => {
            reads.push(uri);
            return Buffer.from('ffd8ffe000104a464946', 'hex');
          },
        },
        media: {
          describeImage: async (source: string) => {
            sources.push(source);
            return '占位描述';
          },
        },
      },
    );
    expect(String(await call('onebot_get_forward_msg', { id: 'zz-forward' }))).toContain('甲: [图片]');
    expect(actions).toContain('get_image');
    expect(reads).toEqual([]);
    expect(sources).toEqual([]);
  });
});

describe('账号', () => {
  it('群会话里写明 self_id：动作发给写明的账号，不被会话的账号盖掉', async () => {
    const { call, targets } = await withStub(async () => ({}));
    await call('onebot_get_group_info', { self_id: '20000' });
    expect(targets).toEqual(['onebot:20000:internal:0']);
  });
});

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

/**
 * 真适配器连本地的假实现端（failing 里的动作回失败、带给定的原话，其余回成功，data 里有的动作回给定的数据），push 以这个账号推一个
 * 事件；inbound 是适配器发出的入站。config 并进适配器的配置
 */
async function withAdapter(
  failing: Record<string, string> = {},
  opts: { config?: Record<string, unknown>; data?: Record<string, unknown> } = {},
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.once('listening', r));
  cleanups.push(
    () =>
      new Promise<void>(r => {
        for (const c of server.clients) c.terminate();
        server.close(() => r());
      }),
  );
  const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
  let socket: WsSocket | undefined;
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as { action: string; params: Record<string, unknown>; echo?: string };
      if (!req.echo) return;
      actions.push({ action: req.action, params: req.params });
      const failure = failing[req.action];
      ws.send(
        JSON.stringify(
          failure === undefined
            ? { status: 'ok', retcode: 0, data: opts.data?.[req.action] ?? { user_id: SELF }, echo: req.echo }
            : { status: 'failed', retcode: 100, message: failure, echo: req.echo },
        ),
      );
    });
  });

  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events });
  host.provide.use(storage, { listRoots: () => [] } as never);
  host.provide.use(processService, {} as never);
  const call = toolRecorder(app);
  const inbound: IncomingMessage[] = [];
  host.events.use.on('inbound:message', msg => void inbound.push(msg));
  await app.pluginAll([
    { definition: memoryInMemory },
    {
      definition: onebotPlugin,
      config: {
        connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol: 'v11', selfId: SELF }],
        ...opts.config,
      },
    },
    { definition: toolOnebot },
  ]);
  await app.plugins.idle();
  await app.start();
  await until(() => actions.some(a => a.action === 'get_login_info'));
  const push = (event: Record<string, unknown>) =>
    socket?.send(JSON.stringify({ self_id: Number(SELF), time: 0, ...event }));
  return { call, actions, push, inbound };
}

describe('群请求：各认自己的申请类型', () => {
  it('没有这条申请时报错，写明可能已处理', async () => {
    const { call } = await withAdapter();
    await expect(
      call('onebot_approve_join_request', { user_id: '30001', group_id: '20002', approve: true }),
    ).rejects.toThrow('可能已处理');
  });

  it('收到的是入群邀请：审批加群申请的工具报错、不发出动作，处理入群邀请的工具照常', async () => {
    const { call, actions, push, inbound } = await withAdapter();
    push({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'invite',
      user_id: 30001,
      group_id: 20002,
      flag: 'f1',
    });
    await until(() => inbound.length > 0);
    const handle = { user_id: '30001', group_id: '20002', approve: true };
    await expect(call('onebot_approve_join_request', handle, PRIVATE)).rejects.toThrow('加群申请');
    expect(actions.map(a => a.action)).not.toContain('set_group_add_request');
    expect(String(await call('onebot_handle_group_invite', handle, PRIVATE))).toContain('已同意');
    expect(actions.find(a => a.action === 'set_group_add_request')?.params).toMatchObject({
      flag: 'f1',
      sub_type: 'invite',
      approve: true,
    });
  });
});

describe('合并转发：入站展开过的命中缓存', () => {
  it('参与人多于 8 个：结果头一行列前 8 个，末尾写没列出的人数', async () => {
    const { call, push, inbound } = await withAdapter();
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      type: 'node',
      data: { nickname: `p${i}`, user_id: 30100 + i, content: [{ type: 'text', data: { text: '在' } }] },
    }));
    push({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 802,
      group_id: 20002,
      user_id: 30001,
      sender: { user_id: 30001, nickname: '甲' },
      message: [{ type: 'forward', data: { id: 'zz-forward', content: nodes } }],
    });
    await until(() => inbound.length > 0);
    const [header] = String(await call('onebot_get_forward_msg', { id: 'zz-forward' })).split('\n');
    expect(header).toBe(
      `合并转发共 10 条，参与人：${nodes
        .slice(0, 8)
        .map((_, i) => `p${i}(${30100 + i})`)
        .join(', ')}, ...(+2 人未列出)`,
    );
  });
});

describe('合并转发：入站展开时拉取失败的不进缓存', () => {
  it('工具照常重新拉，拉不到报实现端原话', async () => {
    const { call, actions, push, inbound } = await withAdapter({ get_forward_msg: '<占位原话>' });
    push({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 801,
      group_id: 20002,
      user_id: 30001,
      sender: { user_id: 30001, nickname: '甲' },
      message: [{ type: 'forward', data: { id: 'zz-forward' } }],
    });
    await until(() => inbound.length > 0);
    expect(buildIncomingContent(inbound[0])).toContain('拉取失败');
    await expect(call('onebot_get_forward_msg', { id: 'zz-forward' })).rejects.toThrow('<占位原话>');
    expect(actions.filter(a => a.action === 'get_forward_msg')).toHaveLength(2);
  });
});

describe('合并转发：没展开过的按收到它的会话过取用判定', () => {
  it('关掉展开时只在私聊里收到过的：群里调工具被拒、不向实现端拉；在那个私聊里照常现拉；从没收到过的判不出、不拉', async () => {
    const node = {
      type: 'node',
      data: { nickname: '甲', user_id: 30001, content: [{ type: 'text', data: { text: '<私聊转发里的话>' } }] },
    };
    const { call, actions, push, inbound } = await withAdapter(
      {},
      { config: { forward: { enabled: false } }, data: { get_forward_msg: { messages: [node] } } },
    );
    push({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 803,
      user_id: 30001,
      sender: { user_id: 30001, nickname: '甲' },
      message: [{ type: 'forward', data: { id: 'zz-forward' } }],
    });
    await until(() => inbound.length > 0);
    const fetched = () => actions.filter(a => a.action === 'get_forward_msg').length;
    const refused = (id: string, sessionId: string) =>
      Promise.resolve(call('onebot_get_forward_msg', { id }, sessionId)).then(
        () => '',
        (err: Error) => err.message,
      );
    expect(await refused('zz-forward', GROUP)).toContain('判不出');
    expect(fetched()).toBe(0);
    expect(String(await call('onebot_get_forward_msg', { id: 'zz-forward' }, PRIVATE))).toContain('<私聊转发里的话>');
    expect(fetched()).toBe(1);
    expect(await refused('zz-unknown', PRIVATE)).toContain('判不出');
    expect(fetched()).toBe(1);
  });
});
