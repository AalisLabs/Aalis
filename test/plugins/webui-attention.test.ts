import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Approval, type ApprovalService, approvals } from '../../packages/api-approval/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import {
  type AttentionItem,
  type AttentionResponse,
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
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 「需要处理」：webui-server 把推出未结的审批、插件故障与插件的提示汇总成一个列表，经 GET /api/attention 给出，
// 变化时经 /admin 推 attention.changed。起真的 webui-server，审批服务与会话管理用契约层面的替身：
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
    provide(approvals, service);
  },
});

/** 会话管理的替身：只答 getSession，标题按 id 取 */
const TITLES: Record<string, string> = { 's-1': '整理周报' };
const sessionsDouble = definePlugin({
  name: 'zz-attention-sessions',
  provides: [sessionManager],
  uses: { provide },
  apply({ provide }) {
    provide(sessionManager, {
      getSession: (id: string) => (TITLES[id] ? ({ id, name: id, title: TITLES[id] } as SessionInfo) : undefined),
    } as never);
  },
});

/** 配置里 ok 不为 true 就起不来 */
const failing = definePlugin({
  name: 'zz-attention-failing',
  uses: { config },
  apply({ config: value }) {
    if (value.ok !== true) throw new Error('缺少服务地址');
  },
});

/** 要一个没人提供的服务：缺服务 */
const absent = defineService<object>('zz-attention-absent');
const needy = definePlugin({ name: 'zz-attention-needy', uses: { absent }, apply() {} });

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

async function start(extra: Parameters<App['plugin']>[0][] = []) {
  const app = new App({ name: 'T', logLevel: 'error', logger: silent });
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
  /** 等到再推一次 attention.changed，返回推送之后重取的列表 */
  const next = async (before: number) => {
    await vi.waitFor(() => expect(pushes()).toBe(before + 1));
    return attention();
  };
  return { app, received, pushes, attention, next, emit: app.bind({ events }).events.emit };
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
    expect(await attention()).toEqual([
      { kind: 'plugin', instance: failing.name, state: 'error', error: '缺少服务地址', missing: [] },
      { kind: 'plugin', instance: needy.name, state: 'pending', missing: [absent.name] },
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
    expect(await next(0)).toEqual([{ kind: 'plugin', instance: needy.name, state: 'pending', missing: [absent.name] }]);

    app.bind({ provide }).provide(absent, {});
    expect(await next(1)).toEqual([]);

    await app.plugins.updateConfig(failing.name, {});
    expect(await next(2)).toEqual([
      { kind: 'plugin', instance: failing.name, state: 'error', error: '缺少服务地址', missing: [] },
    ]);
  });

  it('提示登记、替换与撤回各推一次，带所属实例；审批在前，其后是插件故障与提示', async () => {
    const { app, pushes, next, emit } = await start([approvalsDouble, failing]);
    const service = app.bind({ services }).services.get(webuiServer)!;

    const off = service.addNotice(
      { id: 'pending', level: 'action', title: '1 件作品待裁决', open: 'config' },
      'zz-owner',
    );
    expect(await next(0)).toEqual([
      { kind: 'plugin', instance: failing.name, state: 'error', error: '缺少服务地址', missing: [] },
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
