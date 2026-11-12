import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import type {} from '../../packages/api-gateway/src/index.js';
import { hostRestart } from '../../packages/api-host-restart/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

// /restart 经宿主的 host-restart 服务发起重启：core 没有重启入口。宿主不提供这个服务时（嵌入式宿主、子命令进程），
// 指令回报失败，不抛到入站链之外。

const OWNER = { platform: 'webui', userId: 'console', sessionId: 'webui:s1', sessionType: 'private' };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const { app } = hostedApp({});
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(gatewayPlugin);
  await app.plugin(commandsPlugin);
  await app.plugin(authorityPlugin);
  await app.plugins.idle();
  const host = app.bind({ events, provide });
  const replies: string[] = [];
  host.events.use.on('outbound:message', msg => {
    replies.push(msg.content);
  });
  /** 以 owner 的身份发一句，取这一句的回复 */
  const ask = async (content: string): Promise<string> => {
    const before = replies.length;
    await host.events.use.emit('inbound:message', { ...OWNER, content } as IncomingMessage);
    await vi.waitFor(() => expect(replies.length).toBe(before + 1));
    return replies[before];
  };
  return { host, ask };
}

describe('/restart', () => {
  it('宿主提供 host-restart：调它一次，不带回滚凭据，回「正在重启应用…」', async () => {
    const { host, ask } = await setup();
    const asked: unknown[] = [];
    host.provide.use(hostRestart, { restart: opts => void asked.push(opts) }, { exclusive: true });
    expect(await ask('/restart')).toBe('正在重启应用…');
    expect(asked).toEqual([undefined]);
  });

  it('宿主不提供 host-restart：回报失败，写明服务不可用', async () => {
    const { ask } = await setup();
    const reply = await ask('/restart');
    expect(reply).toContain('指令执行失败');
    expect(reply).toContain('服务 "host-restart" 不可用');
  });
});
