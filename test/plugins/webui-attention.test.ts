import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Approval, type ApprovalService, approvals } from '../../packages/api-approval/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import {
  type AttentionItem,
  type AttentionResponse,
  type PluginListItem,
  type WebuiAdminEvent,
  webuiServer,
} from '../../packages/api-webui/src/index.js';
import {
  App,
  config,
  definePlugin,
  defineService,
  events,
  type Logger,
  provide,
  services,
} from '../../packages/core/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { deferred } from '../helpers/deferred.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 「需要处理」：webui-server 把推出未结的审批、插件故障与插件的提示汇总成一个列表，经 GET /api/attention 给出，
// 变化时经 /admin 推 attention.changed。插件故障是失败与缺服务：缺的服务沿依赖链追到根（api-doctor 的共享判据），
// 只在等别的插件启动的不算；失败的另列必填却没填的配置项。起真的 webui-server，审批服务与会话管理用契约层面的替身：
// 审批推出与结算由用例发 approval:created、approval:settled，列表照 list() 给出
// ════════════════════════════════════════════════════════════

/** Node 自带的 WebSocket（undici）接受 headers，DOM 类型里没有这个重载 */
type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const TOKEN = 'attention-test-token-000000000000';
const COOKIE = `aalis_webui_token=${TOKEN}`;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const app of apps.splice(0)) await app.stop();
});

/** 推出未结的审批：用例往里放、从里拿，再发对应的事件 */
const shown: Approval[] = [];
afterEach(() => void shown.splice(0));

const approvalsDouble = definePlugin({
  name: 'zz-attention-approvals',
  provides: [approvals],
  uses: { provide },
  apply({ provide }) {
    const service: ApprovalService = {
      request: () => Promise.reject(new Error('替身不发起审批')),
      list: () => [...shown],
      attachSurface: () => ({
        attend: () => ({
          presence() {},
          respond: () => ({ ok: false, refusal: 'unavailable', message: '替身不应答' }),
          leave() {},
        }),
        detach() {},
      }),
    };
    provide.use(approvals, service);
  },
});

/** 会话管理的替身：只答 getSession，标题按 id 取 */
const TITLES: Record<string, string> = { 's-1': '整理周报' };
const sessionsDouble = definePlugin({
  name: 'zz-attention-sessions',
  provides: [sessionManager],
  uses: { provide },
  apply({ provide }) {
    provide.use(sessionManager, {
      getSession: (id: string) => (TITLES[id] ? ({ id, name: id, title: TITLES[id] } as SessionInfo) : undefined),
    } as never);
  },
});

/** 配置里 ok 不为 true 就起不来 */
const failing = definePlugin({
  name: 'zz-attention-failing',
  uses: { config },
  apply({ config: value }) {
    if (value.use.ok !== true) throw new Error('缺少服务地址');
  },
});

/** 要一个没人提供的服务：缺服务 */
const absent = defineService<object>('zz-attention-absent');
const needy = definePlugin({ name: 'zz-attention-needy', uses: { absent }, apply() {} });

/** 链：top 要 middle 提供的服务，middle 要 failing 提供的服务 */
const rootService = defineService<object>('zz-attention-root-svc');
const middleService = defineService<object>('zz-attention-middle-svc');
const failingRoot = definePlugin({
  name: 'zz-attention-root',
  provides: [rootService],
  uses: { config, provide },
  apply({ config: value, provide }) {
    if (value.use.ok !== true) throw new Error('打不开数据库');
    provide.use(rootService, {});
  },
});
const middle = definePlugin({
  name: 'zz-attention-middle',
  provides: [middleService],
  uses: { provide, root: rootService },
  apply({ provide }) {
    provide.use(middleService, {});
  },
});
const top = definePlugin({ name: 'zz-attention-top', uses: { middle: middleService }, apply() {} });

/** 必填的 apiKey 没填就起不来：待配置 */
const unconfigured = definePlugin({
  name: 'zz-attention-unconfigured',
  configSchema: { apiKey: { type: 'string', label: 'API Key', required: true } },
  uses: { config },
  apply({ config: value }) {
    if (!value.use.apiKey) throw new Error('缺少配置项 apiKey，在 WebUI 或配置文件中填入后生效');
  },
});

/** 激活要等用例放行的提供者：超过慢激活阈值转入后台，依赖它的只是在等 */
const slowService = defineService<object>('zz-attention-slow-svc');
function slowProvider(gate: Promise<void>) {
  return definePlugin({
    name: 'zz-attention-slow',
    provides: [slowService],
    uses: { provide },
    async apply({ provide }) {
      provide.use(slowService, {});
      await gate;
    },
  });
}
const patient = definePlugin({ name: 'zz-attention-patient', uses: { slow: slowService }, apply() {} });

/** 没有原因的插件项：失败、缺服务的各项照下面补 */
const clear = { lacking: [], waiting: [], unconfigured: [] };

const bystander = definePlugin({ name: 'zz-attention-bystander', apply() {} });

const approval = (id: string, sessionId: string): Approval => ({
  id,
  sessionId,
  origin: { kind: 'owner', platform: 'webui', userId: 'console' },
  target: 'tool',
  tool: 'exec',
  facts: { command: 'ls', params: {} },
  options: ['approve', 'deny'],
  contentHash: `hash-${id}`,
  state: 'pending',
});

async function start(extra: Parameters<App['plugin']>[0][] = [], options: { slowThresholdMs?: number } = {}) {
  const app = new App({ name: 'T', logLevel: 'error', logger: silent, ...options });
  apps.push(app);
  const port = await freePort();
  for (const definition of extra) await app.plugin(definition, {});
  await app.plugin(webuiServerPlugin, {
    host: '127.0.0.1',
    port,
    autoOpen: false,
    tokenMode: 'fixed',
    fixedToken: TOKEN,
  });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);

  const ws = new (WebSocket as unknown as NodeWebSocketCtor)(`ws://127.0.0.1:${port}/admin`, {
    headers: { cookie: COOKIE },
  });
  sockets.push(ws);
  const received: WebuiAdminEvent[] = [];
  ws.onmessage = event => void received.push(JSON.parse(String(event.data)) as WebuiAdminEvent);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('连不上 /admin'));
  });
  const pushes = () => received.filter(e => e.type === 'attention.changed').length;
  const attention = async (): Promise<AttentionItem[]> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/attention`, { headers: { cookie: COOKIE } });
    expect(res.status).toBe(200);
    return ((await res.json()) as AttentionResponse).items;
  };
  /** 插件列表的一行：与「需要处理」共用同一份原因 */
  const row = async (instance: string): Promise<PluginListItem | undefined> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins`, { headers: { cookie: COOKIE } });
    return ((await res.json()) as { plugins: PluginListItem[] }).plugins.find(p => p.instanceId === instance);
  };
  /** 等到再推一次 attention.changed，返回推送之后重取的列表 */
  const next = async (before: number) => {
    await vi.waitFor(() => expect(pushes()).toBe(before + 1));
    return attention();
  };
  return { app, received, pushes, attention, row, next, emit: app.bind({ events }).events.use.emit };
}

describe('「需要处理」的读口与 attention.changed', () => {
  it('审批推出与结算各推一次；读口与推送后重取的结果一致，带会话标题，会话管理不认识的会话没有标题', async () => {
    const { pushes, attention, next, emit } = await start([approvalsDouble, sessionsDouble]);
    expect(await attention()).toEqual([]);

    const first = approval('ap-1', 's-1');
    shown.push(first);
    void emit('approval:created', first);
    expect(await next(0)).toEqual([
      { kind: 'approval', id: 'ap-1', sessionId: 's-1', session: '整理周报', tool: 'exec' },
    ]);

    const second = approval('ap-2', 's-unknown');
    shown.push(second);
    void emit('approval:created', second);
    expect(await next(1)).toEqual([
      { kind: 'approval', id: 'ap-1', sessionId: 's-1', session: '整理周报', tool: 'exec' },
      { kind: 'approval', id: 'ap-2', sessionId: 's-unknown', tool: 'exec' },
    ]);

    shown.shift();
    void emit('approval:settled', { ...first, state: 'approved' });
    expect(await next(2)).toEqual([{ kind: 'approval', id: 'ap-2', sessionId: 's-unknown', tool: 'exec' }]);
    expect(pushes()).toBe(3);
  });

  it('插件失败与恢复、缺服务与补上都推；故障没变时（别的插件启停）只推 plugins.changed，不推 attention.changed', async () => {
    const { app, received, pushes, attention, next } = await start([failing, needy, bystander]);
    const needyItem = {
      kind: 'plugin',
      instance: needy.name,
      state: 'pending',
      ...clear,
      lacking: [{ service: absent.name, chain: [], root: { kind: 'unprovided', service: absent.name } }],
    };
    expect(await attention()).toEqual([
      { kind: 'plugin', instance: failing.name, state: 'error', error: '缺少服务地址', ...clear },
      needyItem,
    ]);

    const changes = () => received.filter(e => e.type === 'plugins.changed').length;
    const before = changes();
    await app.plugins.disable(bystander.name);
    await app.plugins.enable(bystander.name);
    await vi.waitFor(() => expect(changes()).toBeGreaterThanOrEqual(before + 2));
    // 推送与读口的回应走两条连接：读口回来时，同一拍里要推的 attention.changed 早已到了
    await attention();
    expect(pushes()).toBe(0);

    await app.plugins.updateConfig(failing.name, { ok: true });
    expect(await next(0)).toEqual([needyItem]);

    app.bind({ provide }).provide.use(absent, {});
    expect(await next(1)).toEqual([]);

    await app.plugins.updateConfig(failing.name, {});
    expect(await next(2)).toEqual([
      { kind: 'plugin', instance: failing.name, state: 'error', error: '缺少服务地址', ...clear },
    ]);
  });

  it('链：缺的服务沿依赖链追到根，链上每个没起来的插件各计 1；插件列表给同一份原因', async () => {
    const { attention, row } = await start([failingRoot, middle, top]);
    const root = { kind: 'error', instance: failingRoot.name, error: '打不开数据库' };
    const items = await attention();
    expect(items).toEqual([
      { kind: 'plugin', instance: failingRoot.name, state: 'error', error: '打不开数据库', ...clear },
      {
        kind: 'plugin',
        instance: middle.name,
        state: 'pending',
        ...clear,
        lacking: [{ service: rootService.name, chain: [failingRoot.name], root }],
      },
      {
        kind: 'plugin',
        instance: top.name,
        state: 'pending',
        ...clear,
        lacking: [{ service: middleService.name, chain: [middle.name, failingRoot.name], root }],
      },
    ]);
    expect(await row(top.name)).toMatchObject({
      state: 'pending',
      ...clear,
      lacking: items[2].kind === 'plugin' && items[2].lacking,
    });
  });

  it('根的状态变了（失败转停用）推 attention.changed：链上的插件改写根已停用，根自己不再是故障', async () => {
    const { app, next } = await start([failingRoot, middle, top]);
    await app.plugins.disable(failingRoot.name);
    const root = { kind: 'disabled', instance: failingRoot.name };
    expect(await next(0)).toEqual([
      {
        kind: 'plugin',
        instance: middle.name,
        state: 'pending',
        ...clear,
        lacking: [{ service: rootService.name, chain: [failingRoot.name], root }],
      },
      {
        kind: 'plugin',
        instance: top.name,
        state: 'pending',
        ...clear,
        lacking: [{ service: middleService.name, chain: [middle.name, failingRoot.name], root }],
      },
    ]);
  });

  it('故障的插件没变、链变了（提供者卸掉了）也推：比较连同链与根', async () => {
    const { app, attention, next } = await start([middle, failingRoot]);
    await app.plugins.disable(failingRoot.name);
    await next(0);
    await app.plugins.unload(failingRoot.name);
    expect(await next(1)).toEqual([
      {
        kind: 'plugin',
        instance: middle.name,
        state: 'pending',
        ...clear,
        lacking: [{ service: rootService.name, chain: [], root: { kind: 'unprovided', service: rootService.name } }],
      },
    ]);
    expect((await attention()).map(item => item.kind === 'plugin' && item.instance)).toEqual([middle.name]);
  });

  it('只在等别的插件启动的不算故障：不在列表里、不计数；插件列表照样给出在等谁', async () => {
    const gate = deferred();
    try {
      const { attention, row } = await start([slowProvider(gate.promise), patient, needy], { slowThresholdMs: 20 });
      expect((await attention()).map(item => item.kind === 'plugin' && item.instance)).toEqual([needy.name]);
      expect(await row(patient.name)).toMatchObject({
        state: 'pending',
        lacking: [],
        waiting: [
          {
            service: slowService.name,
            chain: ['zz-attention-slow'],
            root: { kind: 'starting', instance: 'zz-attention-slow' },
          },
        ],
      });
    } finally {
      gate.resolve();
    }
  });

  it('失败而必填项没填：列出没填的配置项', async () => {
    const { attention } = await start([unconfigured]);
    expect(await attention()).toEqual([
      {
        kind: 'plugin',
        instance: unconfigured.name,
        state: 'error',
        error: '缺少配置项 apiKey，在 WebUI 或配置文件中填入后生效',
        ...clear,
        unconfigured: ['apiKey'],
      },
    ]);
  });

  it('提示登记、替换与撤回各推一次，带所属实例；审批在前，其后是插件故障与提示', async () => {
    const { app, pushes, next, emit } = await start([approvalsDouble, failing]);
    const service = app.bind({ services }).services.use.get(webuiServer)!;

    const off = service.addNotice(
      { id: 'pending', level: 'action', title: '1 件作品待裁决', open: 'config' },
      'zz-owner',
    );
    expect(await next(0)).toEqual([
      { kind: 'plugin', instance: failing.name, state: 'error', error: '缺少服务地址', ...clear },
      { kind: 'notice', instance: 'zz-owner', id: 'pending', level: 'action', title: '1 件作品待裁决', open: 'config' },
    ]);

    const replace = service.addNotice({ id: 'pending', level: 'action', title: '2 件作品待裁决' }, 'zz-owner');
    expect((await next(1)).at(-1)).toMatchObject({ kind: 'notice', title: '2 件作品待裁决' });
    const pending = approval('ap-1', 's-1');
    shown.push(pending);
    void emit('approval:created', pending);
    expect((await next(2)).map(item => item.kind)).toEqual(['approval', 'plugin', 'notice']);

    // 撤回已被替换的那次登记不算变化：之后只有 replace() 的一次
    off();
    replace();
    expect((await next(3)).map(item => item.kind)).toEqual(['approval', 'plugin']);
    expect(pushes()).toBe(4);
  });
});

describe('契约', () => {
  it('删掉了 missing：插件列表与「需要处理」的插件项改由 lacking 与 waiting 给出', () => {
    const listed = {} as PluginListItem;
    const item = {} as Extract<AttentionItem, { kind: 'plugin' }>;
    // @ts-expect-error 插件列表不再有 missing
    expect(listed.missing).toBeUndefined();
    // @ts-expect-error 「需要处理」的插件项不再有 missing
    expect(item.missing).toBeUndefined();
  });
});
