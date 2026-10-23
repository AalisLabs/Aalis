import { afterEach, describe, expect, it } from 'vitest';
import { checkpoint } from '../../packages/api-checkpoint/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import checkpointPlugin from '../../packages/plugin-checkpoint/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { ONEBOT_TYPES, startSettings } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 哪些回合记检查点：按会话读 coverage，默认按受众，只记受众只有 owner 的会话（WebUI、终端、owner 自己的 IM 私聊）。
// 受众按根会话的房间类别判，不看这一轮从哪个入口进来：owner 从 WebUI 发进群的那一轮也不记。在一个群的场所层设成「记」，
// 只这个群记。会话管理不在时判不出受众，不记。
// ════════════════════════════════════════════════════════════

const CHECKPOINT = '@aalis/plugin-checkpoint';
const GROUP = 'onebot:10000:group:20001';
const OTHER_GROUP = 'onebot:10000:group:20002';
const OWNER_PRIVATE = 'onebot:10000:private:30001';
const OTHERS_PRIVATE = 'onebot:10000:private:30002';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 只记下写入地址的存储：回合提交时写这一轮的清单，写了哪一轮的清单，哪一轮就建了检查点 */
function recordingStorage() {
  const written: string[] = [];
  const plugin = definePlugin({
    name: 'zz-storage',
    provides: [storage],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(storage, { listRoots: () => [], writeFile: async (uri: string) => void written.push(uri) } as never);
    },
  });
  return { plugin, recorded: (turnId: string) => written.some(uri => uri.endsWith(`/${turnId}/manifest.json`)) };
}

/** 跑一轮：这一轮里经存储改一个文件 */
function turnsOf(app: App) {
  const host = app.bind({ hooks, checkpoint });
  return (turnId: string, message: Pick<IncomingMessage, 'sessionId' | 'platform' | 'userId'>) =>
    host.hooks.use.run(
      'agent:turn:before',
      { turnId, sessionId: message.sessionId, inputs: [{ message: { content: '', ...message } }] },
      () => host.checkpoint.use.beforeMutate('workspace:/a.txt', 'write', async () => null),
    );
}

async function setup() {
  const store = recordingStorage();
  const started = await startSettings({
    doc: { plugins: { [CHECKPOINT]: { keepSessions: 0 } } },
    adapters: [{ platform: 'onebot', sessionTypes: ONEBOT_TYPES }],
    owners: [{ platform: 'onebot', userId: '30001' }],
    plugins: [store.plugin, checkpointPlugin],
  });
  apps.push(started.app);
  /** 一条 IM 原生入站，会话管理据此收录这个房间 */
  const im = (sessionId: string, userId: string) => {
    const group = sessionId.includes(':group:') ? { groupId: sessionId.split(':').at(-1) } : {};
    const sessionType = sessionId.includes(':group:') ? 'group' : 'private';
    return started.inbound({ sessionId, platform: 'onebot', sessionType, ...group, userId, selfId: '10000' });
  };
  return { ...started, im, turn: turnsOf(started.app), recorded: store.recorded };
}

describe('默认只记受众只有 owner 的会话', () => {
  it('终端与 WebUI 会话、owner 自己的 IM 私聊记；群与别人的私聊不记，owner 从 WebUI 发进群的那一轮也不记', async () => {
    const { sm, im, turn, recorded } = await setup();
    const cli = await sm.createSession({}, { createdFrom: 'cli' });
    const webui = await sm.createSession({}, { createdFrom: 'webui' });
    await im(GROUP, '30002');
    await im(OWNER_PRIVATE, '30001');
    await im(OTHERS_PRIVATE, '30002');
    await turn('t-cli', { sessionId: cli.id, platform: 'cli', userId: 'console' });
    await turn('t-webui', { sessionId: webui.id, platform: 'webui', userId: 'console' });
    await turn('t-owner-private', { sessionId: OWNER_PRIVATE, platform: 'onebot', userId: '30001' });
    await turn('t-others-private', { sessionId: OTHERS_PRIVATE, platform: 'onebot', userId: '30002' });
    await turn('t-group', { sessionId: GROUP, platform: 'onebot', userId: '30002' });
    await turn('t-group-from-webui', { sessionId: GROUP, platform: 'webui', userId: 'console' });
    const ids = ['t-cli', 't-webui', 't-owner-private', 't-others-private', 't-group', 't-group-from-webui'];
    expect(Object.fromEntries(ids.map(id => [id, recorded(id)]))).toEqual({
      't-cli': true,
      't-webui': true,
      't-owner-private': true,
      't-others-private': false,
      't-group': false,
      't-group-from-webui': false,
    });
  });

  it('coverage 在一个群的场所层设成「记」：只这个群记', async () => {
    const { admin, im, turn, recorded } = await setup();
    await im(GROUP, '30002');
    await im(OTHER_GROUP, '30002');
    await admin.update(
      { layer: { scope: 'place', key: 'onebot:group:20001' } },
      { plugin: CHECKPOINT, key: 'coverage', value: 'all' },
    );
    await turn('t-group', { sessionId: GROUP, platform: 'onebot', userId: '30002' });
    await turn('t-other-group', { sessionId: OTHER_GROUP, platform: 'onebot', userId: '30002' });
    expect([recorded('t-group'), recorded('t-other-group')]).toEqual([true, false]);
  });
});

describe('会话管理不在', () => {
  it('判不出受众，WebUI 的一轮也不记', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const store = recordingStorage();
    await app.plugins.register(store.plugin);
    await app.plugins.register(checkpointPlugin, { keepSessions: 0 });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(CHECKPOINT)?.state).toBe('active');
    await turnsOf(app)('t-webui', { sessionId: 'webui:console:1', platform: 'webui', userId: 'console' });
    expect(store.recorded('t-webui')).toBe(false);
  });
});
