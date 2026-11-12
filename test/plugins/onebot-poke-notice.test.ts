import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { type ArchiveNoticeOptions, messageArchive } from '../../packages/api-message-archive/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import { resolveText, type TextRef, toSource } from '../../packages/schema-i18n/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

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

const SELF = '10000';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

type Protocol = 'v11' | 'v12';
/** nicknames 是假实现端查得到的昵称（账号 → 昵称），群名片与陌生人昵称都按它答；缺省一个都查不到 */
async function boot(protocol: Protocol, nicknames: Record<string, string> = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(
    () =>
      new Promise<void>(resolve => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );

  let socket: WsSocket | undefined;
  const actions: string[] = [];
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as { echo?: string; action?: string; params?: { user_id?: unknown } };
      if (req.action) actions.push(req.action);
      const nickname = nicknames[String(req.params?.user_id)];
      if (req.echo) {
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF, nickname }, echo: req.echo }));
      }
    });
  });

  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events });
  host.provide.use(storage, { listRoots: () => [] } as never);
  host.provide.use(processService, {} as never);
  const directNotices: ArchiveNoticeOptions[] = [];
  host.provide.use(messageArchive, {
    async archiveNotice(opts: ArchiveNoticeOptions) {
      directNotices.push(opts);
      return null;
    },
  } as never);
  const inbound: IncomingMessage[] = [];
  host.events.use.on('inbound:message', (msg: IncomingMessage) => {
    inbound.push(msg);
  });
  await app.plugins.register(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol, selfId: SELF }],
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(onebotPlugin.name)?.state !== 'active') throw new Error('onebot 适配器未激活');
  await app.start();
  await until(() => socket !== undefined && actions.includes(protocol === 'v11' ? 'get_login_info' : 'get_self_info'));

  function poke(userId: number, targetId: number, groupId?: number): void {
    const event =
      protocol === 'v11'
        ? {
            post_type: 'notice',
            notice_type: 'notify',
            sub_type: 'poke',
            self_id: Number(SELF),
            user_id: userId,
            target_id: targetId,
            group_id: groupId,
            time: 0,
          }
        : {
            type: 'notice',
            detail_type: 'poke',
            self: { user_id: SELF },
            user_id: String(userId),
            target_id: String(targetId),
            group_id: groupId == null ? undefined : String(groupId),
            time: 0,
          };
    socket?.send(JSON.stringify(event));
  }
  /** 发一个 v11 事件 */
  const post = (event: Record<string, unknown>) =>
    socket?.send(JSON.stringify({ self_id: Number(SELF), time: 0, ...event }));
  return { poke, post, inbound, directNotices };
}

describe.each(['v11', 'v12'] as const)('OneBot %s poke 入站', protocol => {
  it('群友互戳、戳 bot 及重复互动均逐条进入各自群会话，并保留是否戳 bot 的身份', async () => {
    const t = await boot(protocol);
    t.poke(30001, 30002, 20001);
    t.poke(30003, 30004, 20002);
    t.poke(30001, 30002, 20001);
    t.poke(30005, Number(SELF), 20001);
    await until(() => t.inbound.length === 4);

    expect(
      t.inbound.map(m => [m.sessionId, m.sessionType, m.groupId, m.userId, m.noticeType, m.noticeTargetIsSelf]),
    ).toEqual([
      [`onebot:${SELF}:group:20001`, 'group', '20001', '30001', 'poke', false],
      [`onebot:${SELF}:group:20002`, 'group', '20002', '30003', 'poke', false],
      [`onebot:${SELF}:group:20001`, 'group', '20001', '30001', 'poke', false],
      [`onebot:${SELF}:group:20001`, 'group', '20001', '30005', 'poke', true],
    ]);
    expect(t.inbound[0]?.content).toContain('30001');
    expect(t.inbound[0]?.content).toContain('30002');
    expect(t.inbound[0]?.content).not.toContain('戳了你');
    expect(t.inbound[1]?.content).toContain('30003');
    expect(t.inbound[1]?.content).toContain('30004');
    expect(t.inbound[3]?.content).toContain('30005');
    expect(t.directNotices).toEqual([]);
  });

  it('私聊戳一戳继续走入站，且不直接调用 notice 归档', async () => {
    const t = await boot(protocol);
    t.poke(30001, Number(SELF));
    await until(() => t.inbound.length === 1);
    expect(t.inbound[0]).toMatchObject({
      sessionId: `onebot:${SELF}:private:30001`,
      sessionType: 'private',
      userId: '30001',
      noticeType: 'poke',
      noticeTargetIsSelf: true,
    });
    expect(t.directNotices).toEqual([]);
  });

  it('机器人自己发出的群 poke 回显不重新触发入站', async () => {
    const t = await boot(protocol);
    t.poke(Number(SELF), 30002, 20001);
    t.poke(30001, Number(SELF), 20001);
    await until(() => t.inbound.length === 1);
    expect(t.inbound).toHaveLength(1);
    expect(t.inbound[0]).toMatchObject({ userId: '30001', noticeTargetIsSelf: true });
    expect(t.directNotices).toEqual([]);
  });
});

// 戳一戳与群文件上传是平台事件转成的入站：写给模型的 content 一字不改，给人看的那句另作文字对象放进 IncomingMessage.text
// （会话历史据此画成通知）；不带 source，照旧经触发策略判定
describe('OneBot 戳一戳与群文件上传：给模型的正文与给人看的那句', () => {
  it('戳我、戳别人与上传文件：content 照旧，text 按读者语言，称呼在句首', async () => {
    const t = await boot('v11');
    t.poke(30005, Number(SELF), 20001);
    t.poke(30001, 30002, 20001);
    await until(() => t.inbound.length === 2);
    t.post({
      post_type: 'notice',
      notice_type: 'group_upload',
      group_id: 20001,
      user_id: 30003,
      file: { name: 'a.txt' },
    });
    await until(() => t.inbound.length === 3);
    expect(t.inbound.map(m => [m.content, m.source])).toEqual([
      ['[戳一戳: 30005 戳了你]', undefined],
      ['[戳一戳: 30001 戳了30002]', undefined],
      ['[文件上传: 30003 上传了 a.txt]', undefined],
    ]);
    expect(t.inbound.map(m => m.text && [toSource(m.text), resolveText(m.text, ['en'])])).toEqual([
      ['30005 戳了我', '30005 poked the assistant'],
      ['30001 戳了 30002', '30001 poked 30002'],
      ['30003 上传了 a.txt', '30003 uploaded a.txt'],
    ]);
  });

  it('查得到昵称：给人看的那句里的人一律写「昵称(id)」，content 里只有戳人的一方带昵称', async () => {
    const t = await boot('v11', { 30001: '甲', 30002: '乙', 30003: '丙' });
    t.poke(30001, 30002, 20001);
    await until(() => t.inbound.length === 1);
    t.post({
      post_type: 'notice',
      notice_type: 'group_upload',
      group_id: 20001,
      user_id: 30003,
      file: { name: 'a.txt' },
    });
    await until(() => t.inbound.length === 2);
    expect(t.inbound.map(m => [m.content, m.text && toSource(m.text)])).toEqual([
      ['[戳一戳: 甲(30001) 戳了30002]', '甲(30001) 戳了 乙(30002)'],
      ['[文件上传: 30003 上传了 a.txt]', '丙(30003) 上传了 a.txt'],
    ]);
  });
});

// 平台通知两用拆分：写给模型的 content 一字不改（带 [notice/…] 与排查细节），给人看的那句另作文字对象经
// archiveNotice 的 text 入档。英文里称呼在句首时首字母大写。假实现端查不到昵称，人写成 id，没有 id 时写称呼。
describe('OneBot 平台通知：给模型的正文与给人看的那句', () => {
  const english = (text: TextRef | undefined) => (text ? resolveText(text, ['en']) : undefined);

  it('入档：content 照旧，text 是去掉 [notice/…] 与排查细节的那句', async () => {
    const h = await boot('v11');
    const events = [
      { notice_type: 'group_increase', sub_type: 'approve', group_id: 20001, user_id: 30004, operator_id: 30005 },
      { notice_type: 'group_decrease', sub_type: 'kick', group_id: 20001, user_id: 30006, operator_id: 30005 },
      { notice_type: 'group_increase', sub_type: 'approve', group_id: 20001, user_id: Number(SELF) },
      { notice_type: 'group_increase', sub_type: 'approve', group_id: 20001 },
      { notice_type: 'group_admin', sub_type: 'set', group_id: 20001, user_id: 30007 },
      { notice_type: 'friend_add', user_id: 30008 },
      { notice_type: 'group_ban', sub_type: 'lift_ban', group_id: 20001, user_id: 30009, operator_id: 30005 },
      { notice_type: 'group_recall', group_id: 20001, user_id: 30010, operator_id: 30005, message_id: 456 },
      { notice_type: 'friend_recall', user_id: 30011, message_id: 789 },
    ];
    for (const [i, event] of events.entries()) {
      h.post({ post_type: 'notice', ...event });
      await until(() => h.directNotices.length === i + 1);
    }
    expect(h.directNotices.map(n => n.content)).toEqual([
      '[notice/group_increase/approve] 30004 加入了群',
      '[notice/group_decrease/kick] 30006 被 30005 移出群聊',
      '[notice/group_increase/approve] 我 加入了群',
      '[notice/group_increase/approve] 某人 加入了群',
      '[notice/group_admin/set] 30007 被设置为管理员',
      '[notice/friend_add] 30008 成为了我的好友',
      '[notice/group_ban/lift] 30005 把 30009 解除了禁言',
      '[notice/group_recall] 30005 撤回了 30010 的消息（msg=456）',
      '[notice/friend_recall] 30011 撤回了一条私聊消息（msg=789）',
    ]);
    expect(h.directNotices.map(n => english(n.text))).toEqual([
      '30004 joined the group',
      '30006 was removed from the group by 30005',
      'The assistant joined the group',
      'Someone joined the group',
      '30007 was made an admin',
      '30008 became a friend of the assistant',
      '30005 unmuted 30009',
      "30010's message was recalled by 30005",
      '30011 recalled a private message',
    ]);
  });

  it('禁言：content 照旧写秒数与 ISO 时刻，text 的时长与解禁时刻按读者语言；没有操作者时写管理员', async () => {
    const h = await boot('v11');
    const before = Date.now();
    const ban = { post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban', group_id: 20001, user_id: 30009 };
    h.post({ ...ban, operator_id: 30005, duration: 60 });
    await until(() => h.directNotices.length === 1);
    h.post({ ...ban, duration: 60 });
    await until(() => h.directNotices.length === 2);
    const [notice, byAdmin] = h.directNotices;
    expect(notice?.content).toMatch(
      /^\[notice\/group_ban\] 30005 把 30009 禁言了 60 秒（解禁于 \d{4}-\d\d-\d\dT[\d:.]+Z）$/,
    );
    expect(english(notice?.text)).toMatch(/^30005 muted 30009 for 1 min \(until .+\)$/);
    const until_ = (notice?.text?.params?.until as number) - before;
    expect(until_).toBeGreaterThanOrEqual(60_000);
    expect(byAdmin?.content).toMatch(/^\[notice\/group_ban\] 管理员 把 30009 禁言了 60 秒（/);
    expect(english(byAdmin?.text)).toMatch(/^An admin muted 30009 for 1 min \(until .+\)$/);
  });
});
