import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { SessionInfo } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin } from '../../packages/core/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { fieldsPlugin, ONEBOT_TYPES, SCHEMA, startSettings } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 入站收录先于入站相位：会话管理的 recordInbound 可等待，网关在跑入站相位之前等它。新群的第一条消息进入指令相位时会话已经
// 建档、带聊天窗口，各层按记下的类型取；网关在收录之后才记代号，问认领者的期间开始删除的那条按新的一代派发。同一会话并发的
// 入站只收录一次；带 source 的、没有会话 id 的、子会话与已收录的会话不等（已收录的照旧补名、更新窗口的显示名）；WebUI 与终端
// 的会话不写聊天窗口，带创建来源的会话收到聊天平台的入站也不补出生平台。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
};

const fromGroup = (sessionId = GROUP): IncomingMessage => ({
  content: '<消息>',
  sessionId,
  platform: 'onebot',
  sessionType: 'group',
  groupId: '20001',
  userId: '30002',
  selfId: '10000',
});

/** 认领要等一阵的 onebot 适配器：release 之前认领不返回，hold 之后的认领又不返回；claims 记下被问了几次 */
function slowAdapter() {
  let gate = deferred();
  const counter = { claims: 0 };
  const adapter = {
    platform: 'onebot',
    sessionTypes: ONEBOT_TYPES,
    canHandle: async (id: string) => {
      counter.claims++;
      await gate.promise;
      return id.startsWith('onebot:');
    },
  };
  return {
    adapter,
    counter,
    release: () => gate.resolve(),
    hold: () => {
      gate = deferred();
    },
  };
}

/** 在指令相位记下会话此刻的样子与读取器读到的工具分组 */
function phaseProbe(read: (sessionId: string) => unknown) {
  const seen: Array<{ session: SessionInfo | undefined; read: unknown }> = [];
  return {
    seen,
    plugin: (lookup: (id: string) => SessionInfo | undefined) =>
      definePlugin({
        name: 'zz-probe',
        uses: { hooks },
        apply({ hooks }) {
          hooks.use.middleware('inbound:command', async (data, next) => {
            seen.push({ session: structuredClone(lookup(data.message.sessionId)), read: read(data.message.sessionId) });
            await next();
          });
        },
      }),
  };
}

describe('网关等收录', () => {
  it('新群第一条消息进入指令相位时已建档、带聊天窗口；平台档开 system、平台类型档 onebot · group 不开时第一轮拿不到 system', async () => {
    const tools = fieldsPlugin('zz-tools', SCHEMA);
    const slow = slowAdapter();
    // 网关的插件 id 排在会话管理前面：它的入站监听先跑，不等收录的话指令相位会先于建档
    const started = await startSettings({
      doc: {
        sessionConfig: {
          platforms: { onebot: { 'zz-tools': { groups: ['system'] } } },
          platformTypes: { onebot: { group: { 'zz-tools': { groups: [] } } } },
        },
      },
      first: [gatewayPlugin],
      fields: [tools.definition],
      adapters: [slow.adapter],
    });
    apps.push(started.app);
    const probe = phaseProbe(id => tools.reader().get(id, { platform: 'onebot' }).groups);
    await started.app.plugin(probe.plugin(id => started.sm.getSession(id)));
    await started.app.plugins.idle();

    const done = new Promise<void>(resolve => started.host.events.use.on('gateway:phase:done', () => resolve()));
    const emitting = started.inbound(fromGroup());
    slow.release();
    await emitting;
    await done;
    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0].session?.originChat).toEqual({
      type: 'group',
      multiParty: true,
      selfId: '10000',
      targetId: '20001',
    });
    expect(probe.seen[0].read).toEqual([]);
  });

  it('问认领者的期间开始删除这个会话：代号在收录之后才记，按新的一代照常派发', async () => {
    const slow = slowAdapter();
    const { app, host, sm, inbound } = await startSettings({ first: [gatewayPlugin], adapters: [slow.adapter] });
    apps.push(app);
    // 按 id 兜底建档的空记录：要由这条原生入站补记
    await sm.ensureSession(GROUP);
    const sent: string[] = [];
    host.events.use.on('outbound:message', message => void sent.push(message.sessionId));
    const dispatched = new Promise<void>(resolve =>
      host.events.use.on('gateway:phase:done', ({ phase }) => {
        if (phase === 'inbound:dispatch') resolve();
      }),
    );
    const emitting = inbound(fromGroup());
    await new Promise(resolve => setImmediate(resolve));
    const deleting = sm.deleteSession(GROUP);
    slow.release();
    await Promise.all([emitting, deleting, dispatched]);
    expect(sent, '按新的一代派发：没有 agent 时回兜底的那句').toEqual([GROUP]);
  });
});

describe('recordInbound', () => {
  async function setup(adapter: Record<string, unknown> = { platform: 'onebot', sessionTypes: ONEBOT_TYPES }) {
    const started = await startSettings({ adapters: [adapter] });
    apps.push(started.app);
    let created = 0;
    started.host.events.use.on('session:created', () => void created++);
    return { ...started, created: () => created };
  }

  it('同一会话并发两条入站只收录一次，两次调用都在建档落定之后兑现', async () => {
    const slow = slowAdapter();
    const { sm, created } = await setup(slow.adapter);
    const first = sm.recordInbound(fromGroup());
    const second = sm.recordInbound(fromGroup());
    slow.release();
    await Promise.all([first, second]);
    expect(sm.getSession(GROUP)?.originChat?.type).toBe('group');
    expect(created()).toBe(1);
    expect(slow.counter.claims).toBe(1);
  });

  it('带 source 的入站直接兑现，不问认领者、不建档：工作流节点的一次性会话的消息也带 source', async () => {
    const slow = slowAdapter();
    const { sm } = await setup(slow.adapter);
    await sm.recordInbound({ ...fromGroup(), source: 'scheduler' });
    await sm.recordInbound({
      ...fromGroup('workflow::<编排>::<节点>'),
      platform: 'workflow',
      source: 'workflow:<编排>:<节点>',
    });
    expect(slow.counter.claims).toBe(0);
    expect(sm.getSession(GROUP)).toBeUndefined();
    expect(sm.getSession('workflow::<编排>::<节点>')).toBeUndefined();
  });

  it('子会话的入站不收录、不问认领者：按 parentId 判，与会话 id 的写法无关', async () => {
    const slow = slowAdapter();
    const { sm } = await setup(slow.adapter);
    const parent = await sm.createSession({}, { createdFrom: 'webui' });
    const child = await sm.createChildSession(parent.id, { name: '<子任务>' });
    await sm.recordInbound({ ...fromGroup(child.id), platform: 'webui' });
    expect(slow.counter.claims).toBe(0);
    expect(sm.getSession(child.id)?.originChat).toBeUndefined();
  });

  it('会话 id 带 :: 的原生入站照常收录：不按 id 的写法判', async () => {
    const slow = slowAdapter();
    slow.release();
    const { sm } = await setup(slow.adapter);
    const id = 'onebot:10000:group:<分区>::<群>';
    await sm.recordInbound(fromGroup(id));
    expect(sm.getSession(id)?.originChat).toMatchObject({ type: 'group', multiParty: true });
  });

  it('已收录的会话不等认领者：照旧补上没取的名字', async () => {
    const slow = slowAdapter();
    const { sm } = await setup(slow.adapter);
    const recording = sm.recordInbound(fromGroup());
    slow.release();
    await recording;
    // 之后的认领一直不返回：已收录的会话不该等它
    slow.hold();
    await sm.recordInbound({ ...fromGroup(), groupName: '<群名>' });
    await expect.poll(() => sm.getSession(GROUP)?.name).toBe('<群名>');
  });

  it('问认领者的期间开始删除这个会话：等删除做完再从头收录，删除当中不按这条重新建档', async () => {
    const slow = slowAdapter();
    const { host, sm } = await setup(slow.adapter);
    // 按 id 兜底建档的空记录：要由这条原生入站补记
    await sm.ensureSession(GROUP);
    const order: string[] = [];
    const gate = deferred();
    host.events.use.on('session:created', () => void order.push('created'));
    host.events.use.on('session:deleted', async () => {
      order.push('deleted');
      await gate.promise;
    });
    const recording = sm.recordInbound(fromGroup());
    const deleting = sm.deleteSession(GROUP);
    slow.release();
    await new Promise(resolve => setImmediate(resolve));
    expect(order, '删除当中不按这条重新建档').toEqual(['deleted']);
    expect(sm.getSession(GROUP)).toBeUndefined();
    gate.resolve();
    await Promise.all([deleting, recording]);
    expect(order, '删完之后才建档').toEqual(['deleted', 'created']);
    expect(sm.getSession(GROUP)?.originChat?.type).toBe('group');
  });

  it('WebUI 与终端的会话走快路径：不写聊天窗口，不问认领者', async () => {
    const slow = slowAdapter();
    const { sm } = await setup(slow.adapter);
    const webui = await sm.createSession({}, { createdFrom: 'webui' });
    const cli = await sm.ensureSession('cli-default', {}, { createdFrom: 'cli' });
    await sm.recordInbound({ content: '<消息>', sessionId: webui.id, platform: 'webui', userId: 'console' });
    await sm.recordInbound({ content: '<消息>', sessionId: cli.id, platform: 'cli', userId: 'console' });
    expect(sm.getSession(webui.id)?.originChat).toBeUndefined();
    expect(sm.getSession(cli.id)?.originChat).toBeUndefined();
    expect(slow.counter.claims).toBe(0);
  });

  it('带创建来源的会话收到同一个 id 的聊天平台入站：不补出生平台与聊天窗口，仍是本机会话，工具分组没设时照开', async () => {
    // 守的不变式：创建来源与出生平台不同时出现在一条会话记录上。plugin-tools 没设工具分组时按根会话的创建来源开全部分组，
    // 补上出生平台就成了聊天平台的会话
    const { app, sm } = await startSettings({
      adapters: [{ platform: 'onebot', sessionTypes: ONEBOT_TYPES }],
      fields: [toolsPlugin],
    });
    apps.push(app);
    await sm.ensureSession(GROUP, {}, { createdFrom: 'webui' });
    await sm.recordInbound(fromGroup());
    expect(sm.getSession(GROUP)).toMatchObject({ createdFrom: 'webui' });
    expect(sm.getSession(GROUP)?.originPlatform).toBeUndefined();
    expect(sm.getSession(GROUP)?.originChat).toBeUndefined();
    expect(app.bind({ tools }).tools.use.sessionGroups(GROUP, 'onebot')).toEqual(['*']);
  });
});
