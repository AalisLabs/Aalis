import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import { type IncomingMessage, WellKnownMetadataKeys } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { mkConfig, noFileStorage, silentLogger } from '../fixtures/authority.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { storedRoom } from '../fixtures/rooms.js';
import { sessionTableManager } from '../fixtures/session-table.js';

// ════════════════════════════════════════════════════════════
// 入站归档文本的发送者前缀按房间类别：带 source 的注入与受众只有 owner 的会话不加；owner 从别的平台往房间里插话写
// owner 在房间所在平台登记的账号；其余写这条消息自己的说话人。存档、agent 的兜底正文同一规则（api-message-archive 的
// speakerOf）。会话管理用只实现 getSession 的桩，权限服务用真插件（owners 在配置文档里）。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const OWNER_DM = 'onebot:10000:private:40001';
const OTHER_DM = 'onebot:10000:private:30001';
/** owner 在这个平台没登记账号 */
const FOREIGN_GROUP = 'acmechat:7:group:8';
const WEBUI = 'webui-1';
/** 第三方单人客户端（登记名不是 webui、cli）建的会话 */
const CLIENT = 'acme-1';
/** 群里派出的子任务 */
const CHILD = 'session-0000abcd';

const ownerFace = (id: string, createdFrom: string) => ({
  id,
  children: [],
  status: 'waiting',
  createdAt: 0,
  updatedAt: 0,
  createdFrom,
});

const SESSIONS = [
  storedRoom(GROUP, '群'),
  storedRoom(OWNER_DM),
  storedRoom(OTHER_DM),
  storedRoom(FOREIGN_GROUP),
  ownerFace(WEBUI, 'webui'),
  ownerFace(CLIENT, 'acme'),
  { id: CHILD, parentId: GROUP, children: [], status: 'active', createdAt: 0, updatedAt: 0 },
];

const OWNER = { platform: 'onebot', userId: '40001' };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 启动一个带配置文档（owners）的宿主，登记权限插件与会话表桩；不给会话管理时会话表桩不登记 */
async function host(opts: { sessions?: boolean } = {}) {
  const { app } = hostedApp({ owners: [OWNER] });
  apps.push(app);
  await registerHubs(app);
  const bound = app.bind({ provide, messageArchive, agent });
  if (opts.sessions !== false) bound.provide.use(sessionManager, sessionTableManager(SESSIONS));
  await app.plugin(memoryInMemory);
  await app.plugin(authorityPlugin, {});
  return { app, bound };
}

async function active(app: App, ...defs: { name: string }[]) {
  await app.plugins.idle();
  for (const def of defs) {
    const state = app.plugins.getPlugin(def.name)?.state;
    if (state !== 'active') throw new Error(`${def.name} 未激活（state=${state}）`);
  }
}

/** 真存档：回 archiveIncoming 落库的消息 */
async function archivedBy(opts: { sessions?: boolean } = {}) {
  const { app, bound } = await host(opts);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await active(app, memoryInMemory, authorityPlugin, messageArchivePlugin);
  return async (message: IncomingMessage) => (await bound.messageArchive.use.archiveIncoming(message))?.message;
}

/** 真存档：回落库的正文 */
async function archiver(opts: { sessions?: boolean } = {}) {
  const archive = await archivedBy(opts);
  return async (message: IncomingMessage) => (await archive(message))?.content;
}

const said = (sessionId: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  content: '你好',
  sessionId,
  platform: 'onebot',
  ...extra,
});
const fromWebui = (sessionId: string): IncomingMessage => said(sessionId, { platform: 'webui', userId: 'console' });

describe('存档正文的发送者前缀', () => {
  it('owner 从 WebUI 往群里发：写 owner 在群所在平台登记的账号', async () => {
    const archive = await archiver();
    expect(await archive(fromWebui(GROUP))).toBe('[40001]: 你好');
  });

  it('owner 在群所在平台没登记账号：写这条消息自己的身份', async () => {
    const archive = await archiver();
    expect(await archive(fromWebui(FOREIGN_GROUP))).toBe('[console]: 你好');
  });

  it('按授权身份判是不是 owner：授权身份是 owner、物理身份不是的写 owner 的账号，反过来写这条消息自己的身份', async () => {
    const archive = await archiver();
    const guest = said(GROUP, { platform: 'webui', userId: 'guest' });
    expect(await archive({ ...guest, actor: OWNER })).toBe('[40001]: 你好');
    expect(await archive({ ...fromWebui(GROUP), actor: { platform: 'onebot', userId: '30001' } })).toBe(
      '[console]: 你好',
    );
  });

  it('owner 自己的 IM 私聊不带，从 WebUI 往里发也不带', async () => {
    const archive = await archiver();
    expect(await archive(said(OWNER_DM, { sessionType: 'private', userId: '40001', nickname: '主人' }))).toBe('你好');
    expect(await archive(fromWebui(OWNER_DM))).toBe('你好');
  });

  it('第三方单人客户端（登记名不是 webui、cli）的 owner 会话不带，WebUI 会话照旧不带', async () => {
    const archive = await archiver();
    expect(await archive(said(CLIENT, { platform: 'acme', userId: 'me' }))).toBe('你好');
    expect(await archive(fromWebui(WEBUI))).toBe('你好');
  });

  it('IM 房间里派出的子任务：任务正文不带 [parent:…]', async () => {
    const archive = await archiver();
    const task = said(CHILD, {
      content: '查一下天气',
      userId: `parent:${GROUP}`,
      source: 'subtask',
      actor: { platform: 'onebot', userId: '30001' },
    });
    expect(await archive(task)).toBe('查一下天气');
  });

  it('onebot 好友申请的合成通知不带', async () => {
    const archive = await archiver();
    const request = said('onebot:10000:private:30009', {
      content: '[系统通知] 用户 30009 向我发出了好友申请。',
      selfId: '10000',
      userId: '30009',
      sessionType: 'private',
      source: 'onebot-request',
    });
    expect(await archive(request)).toBe('[系统通知] 用户 30009 向我发出了好友申请。');
  });

  it('编排发进群的消息不带前缀，带 owner 运行身份的也不带 owner 的账号', async () => {
    const archive = await archiver();
    const workflow = said(GROUP, { content: '日报', platform: 'internal', source: 'workflow:wf' });
    expect(await archive(workflow)).toBe('日报');
    expect(await archive({ ...workflow, actor: OWNER })).toBe('日报');
  });

  it('别人的私聊与群里的发言照旧写说话人，owner 在群里用 IM 账号说话也一样', async () => {
    const archive = await archiver();
    const other = { userId: '30001', nickname: '甲' };
    expect(await archive(said(GROUP, { sessionType: 'group', groupId: '20001', ...other }))).toBe('[甲(30001)]: 你好');
    expect(await archive(said(OTHER_DM, { sessionType: 'private', ...other }))).toBe('[甲(30001)]: 你好');
    expect(await archive(said(GROUP, { userId: '40001', nickname: '主人' }))).toBe('[主人(40001)]: 你好');
  });

  it('会话管理不在：判不出房间类别，一律写这条消息自己的说话人（WebUI 的也写 console）', async () => {
    const archive = await archiver({ sessions: false });
    expect(await archive(fromWebui(WEBUI))).toBe('[console]: 你好');
    expect(await archive(fromWebui(GROUP))).toBe('[console]: 你好');
  });
});

describe('存档元数据：前缀用的标签与被 @ 的人', () => {
  it('加了前缀时把这次用的标签记成 SenderLabel，没加前缀的不记', async () => {
    const archive = await archivedBy();
    const label = async (message: IncomingMessage) =>
      (await archive(message))?.metadata?.[WellKnownMetadataKeys.SenderLabel];
    expect(await label(fromWebui(GROUP))).toBe('40001');
    expect(await label(said(GROUP, { userId: '30001', nickname: '甲' }))).toBe('甲(30001)');
    expect(await label(said(OWNER_DM, { sessionType: 'private', userId: '40001' }))).toBeUndefined();
    expect(await label(said(GROUP, { source: 'workflow:wf' }))).toBeUndefined();
  });

  it('Mentions 只取发言人自己写的 @：引用里别人 @ 的人不算', async () => {
    const archive = await archivedBy();
    const message = await archive(
      said(GROUP, {
        content: '<at id="30002">乙</at> 你看',
        userId: '30001',
        nickname: '甲',
        replyTo: { messageId: 'zz-1', content: '<at id="30003">丙</at> 在吗', userId: '30004' },
      }),
    );
    expect(message?.content).toContain('30003');
    expect(message?.metadata?.[WellKnownMetadataKeys.Mentions]).toEqual(['30002']);
  });
});

describe('存档不在时 agent 当轮的正文', () => {
  it('与存档同一规则：owner 的 WebUI 会话里不带 [console]，owner 从 WebUI 往群里发写 owner 的账号，群里按发言人带', async () => {
    const { app, bound } = await host();
    const recorder: ChatModelRequest[] = [];
    await app.plugin(createMockLLMPlugin({ responses: [{ content: '收到' }], recorder }));
    await app.plugin(agentPlugin);
    await active(app, memoryInMemory, authorityPlugin, agentPlugin);
    const current = () => {
      const users = (recorder.at(-1)?.messages ?? []).filter(m => m.role === 'user');
      return users.at(-1)?.content;
    };

    await bound.agent.use.handleMessage(fromWebui(WEBUI));
    expect(current()).toMatch(/^\([^)]*\) 你好$/);
    await bound.agent.use.handleMessage(fromWebui(GROUP));
    expect(current()).toMatch(/^\([^)]*\) \[40001\]: 你好$/);
    await bound.agent.use.handleMessage(
      said(GROUP, { sessionType: 'group', groupId: '20001', userId: '30001', nickname: '甲' }),
    );
    expect(current()).toMatch(/^\([^)]*\) \[甲\(30001\)\]: 你好$/);
  });
});

describe('权限服务的 ownerOn', () => {
  it('取配置 owners 里这个平台的第一个账号；本机控制台恒为 owner 但不是登记的账号，不算', () => {
    const owners = [OWNER, { platform: 'onebot', userId: '40002' }, { platform: 'acme', userId: 'me' }];
    const manager = new AuthorityManager(mkConfig({ owners }), silentLogger(), noFileStorage);
    expect(manager.ownerOn('onebot')).toEqual(OWNER);
    expect(manager.ownerOn('acme')).toEqual({ platform: 'acme', userId: 'me' });
    expect(manager.isOwner('webui', 'console')).toBe(true);
    expect(manager.ownerOn('webui')).toBeUndefined();
    expect(manager.ownerOn('acmechat')).toBeUndefined();
  });
});
