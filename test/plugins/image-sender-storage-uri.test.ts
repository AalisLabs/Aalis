import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authority, type OriginTurn } from '../../packages/api-authority/src/index.js';
import { type SessionInfo, sessionManager, TAKE_UNKNOWN } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type Events, events, provide } from '../../packages/core/src/index.js';
import { principalKind } from '../../packages/plugin-authority/src/authority-model.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { storedRoom } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// send_attachment 的 storage_uri 只收存储地址。
//
// 历史里的附件引用一律是存储地址（`data:/images/<会话目录>/<写入方>/…`），agent 照引用填 storage_uri 即可；
// 照旧写成相对路径（`data/images/…`，没有冒号）的回「要写存储地址」，不再替它补成存储地址。发出的附件引用
// 记规整后的存储地址。
//
// 会话是群（会话表里预置收录过的房间）：别的会话的媒体按会话管理的取用规则（这里是一律不放行的替身），不属于任何会话的
// 本机文件按本机文件判法，都先判后读。
// ════════════════════════════════════════════════════════════

const OWNER_QQ = '90001';
const OUT_OF_SCOPE =
  '这个文件不在这一轮能取的范围里：别的会话的媒体按这个会话的取用范围与开关；本机文件要这一轮里有 owner 的话、有别人时经她批准，或是 owner 授权的自动运行且会话里没有别人';

describe('send_attachment 的 storage_uri', () => {
  let base: string;
  let app: App;
  let hostEvents: Events;
  let handlers: Record<string, (a: Record<string, unknown>, c: { sessionId: string }) => Promise<string>>;
  let confirmDelivery: boolean;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-imgsend-'));
    // data 是 storage-local 的内置根，映射到家目录的 state/
    mkdirSync(join(base, 'state', 'images', 'onebot_x_group_1', 'onebot'), { recursive: true });
    // 落一张真图（内容随意，只验证路径解析）
    writeFileSync(
      join(base, 'state', 'images', 'onebot_x_group_1', 'onebot', 'abcd1234.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0]),
    );
    // 别的群的图与不是媒体的文件
    mkdirSync(join(base, 'state', 'images', 'onebot_x_group_2'), { recursive: true });
    writeFileSync(join(base, 'state', 'images', 'onebot_x_group_2', 'other.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0]));
    mkdirSync(join(base, 'state', 'secret'), { recursive: true });
    writeFileSync(join(base, 'state', 'secret', 'config.yaml'), 'token: PLACEHOLDER\n');
    app = new App({ name: 'T', logLevel: 'error' });
    handlers = {};
    const host = app.bind({ provide, events });
    hostEvents = host.events.use;
    confirmDelivery = true;
    // 本文件只验证 storage_uri 解析；模拟平台适配器确认，不声称走过真实 OneBot。
    hostEvents.on('outbound:message', msg => {
      if (confirmDelivery) msg.delivery = Promise.resolve({ ok: true });
    });
    host.provide.use(tools, {
      register: (t: { definition: { function: { name: string } }; handler: (typeof handlers)[string] }) => {
        handlers[t.definition.function.name] = t.handler;
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
    const rooms = new Map(
      ['onebot:x:group:1', 'onebot:x:group:2'].map(id => [id, storedRoom(id) as unknown as SessionInfo]),
    );
    host.provide.use(sessionManager, {
      getSession: (id: string) => rooms.get(id),
      listSessions: () => [...rooms.values()],
      canTake: () => ({ ok: false, reason: TAKE_UNKNOWN }),
    } as never);
    const isOwner = (p: string, u?: string) => p === 'onebot' && u === OWNER_QQ;
    host.provide.use(authority, { isOwner, principalOf: (turn: OriginTurn) => principalKind(turn, isOwner) } as never);
    provideHostPaths(app, base);
    await app.plugins.register(storageLocalPlugin, {});
    await app.plugins.register(imageSenderPlugin, {});
    await app.plugins.idle();
    const state = app.plugins.getPlugin(imageSenderPlugin.name)?.state;
    if (state !== 'active') throw new Error(`plugin-image-sender 未激活（state=${state}）`);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('相对路径（data/images/…，没有冒号）→ 回「要写存储地址」，不出站', async () => {
    const outbound: unknown[] = [];
    hostEvents.on('outbound:message', m => {
      outbound.push(m); // 花括号吞掉 push 的返回值：监听器签名要求 void | Promise<void>
    });
    const out = JSON.parse(
      await handlers.send_attachment(
        { kind: 'image', storage_uri: 'data/images/onebot_x_group_1/onebot/abcd1234.jpg' },
        { sessionId: 'onebot:x:group:1' },
      ),
    );
    expect(out.error).toBe('storage_uri 要写存储地址（如 data:/images/…），不能写本机路径');
    expect(outbound).toHaveLength(0);
  });

  it('发出的消息带这次工具调用的 callId：界面据此把它挂到对应的工具卡上', async () => {
    const outbound: OutgoingMessage[] = [];
    hostEvents.on('outbound:message', m => {
      outbound.push(m);
    });
    await handlers.send_attachment(
      { kind: 'image', storage_uri: 'data:/images/onebot_x_group_1/onebot/abcd1234.jpg' },
      {
        sessionId: 'onebot:x:group:1',
        callId: 'call-7',
      } as { sessionId: string },
    );
    expect(outbound.map(m => m.callId)).toEqual(['call-7']);
  });

  it('存储地址 → 成功发送，发出的附件引用记规整后的地址', async () => {
    const outbound: OutgoingMessage[] = [];
    hostEvents.on('outbound:message', m => {
      outbound.push(m);
    });
    const out = JSON.parse(
      await handlers.send_attachment(
        { kind: 'image', storage_uri: 'data:/images/onebot_x_group_1/onebot/./abcd1234.jpg' },
        { sessionId: 'onebot:x:group:1' },
      ),
    );
    expect(out.ok).toBe(true);
    expect(outbound.map(m => m.attachments?.[0]?.ref)).toEqual(['data:/images/onebot_x_group_1/onebot/abcd1234.jpg']);
  });

  it('真不存在的图 → 如实报错', async () => {
    const out = JSON.parse(
      await handlers.send_attachment(
        { kind: 'image', storage_uri: 'data:/images/onebot_x_group_1/onebot/nonexistent.jpg' },
        { sessionId: 'onebot:x:group:1' },
      ),
    );
    expect(out.error).toMatch(/存储资源不存在/);
  });

  it('发别的群的 data:/images/…，会话管理的取用规则不放行 → 拒，不出站', async () => {
    const outbound: unknown[] = [];
    hostEvents.on('outbound:message', m => {
      outbound.push(m);
    });
    const out = JSON.parse(
      await handlers.send_attachment({ kind: 'image', storage_uri: 'data:/images/onebot_x_group_2/other.jpg' }, {
        sessionId: 'onebot:x:group:1',
        platform: 'onebot',
        userId: OWNER_QQ,
        inbound: {},
      } as { sessionId: string }),
    );
    expect(out.error).toBe(OUT_OF_SCOPE);
    expect(outbound).toHaveLength(0);
  });

  it('先判后读：本会话以外的地址，不存在的与不是媒体的回同一句', async () => {
    const send = async (uri: string) =>
      JSON.parse(
        await handlers.send_attachment({ kind: 'image', storage_uri: uri }, { sessionId: 'onebot:x:group:1' }),
      );
    const missing = await send('data:/secret/nonexistent.png');
    const notMedia = await send('data:/secret/config.yaml');
    expect(missing.error).toBe(OUT_OF_SCOPE);
    expect(notMedia).toEqual(missing);
  });

  it('没有适配器确认时，即使路径正确也不报告已发送', async () => {
    confirmDelivery = false;
    const out = JSON.parse(
      await handlers.send_attachment(
        { kind: 'image', storage_uri: 'data:/images/onebot_x_group_1/onebot/abcd1234.jpg' },
        { sessionId: 'onebot:x:group:1' },
      ),
    );
    expect(out.ok).toBeUndefined();
    expect(out.error).toMatch(/没有目标适配器确认/);
  });
});
