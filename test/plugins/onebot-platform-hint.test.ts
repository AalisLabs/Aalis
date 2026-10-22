import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { platform, sessionTypesOf } from '../../packages/api-platform/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, logger, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import { resolveText, type TextRef, toSource } from '../../packages/schema-i18n/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// OneBot 声明的三个类型带显示名（进本插件的字典，有英文）；平台提示里「群聊历史含多位群友」那一句按会话 id 里的类型查
// 本插件声明的多方标记：群与频道给，私聊不给。不连实现端（没有连接，提示照常出）。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';
const CHANNEL = 'onebot:10000:channel:40001:50001';
const MULTI_PARTY_HINT = '本轮上下文中的群聊历史记录包含多位群友的发言';

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, contributions, logger, platform });
  host.provide.use(storage, { listRoots: () => [] } as never);
  host.provide.use(processService, {} as never);
  await app.plugin(onebotPlugin, { connections: [] });
  await app.plugins.idle();
  if (app.plugins.getPlugin(onebotPlugin.name)?.state !== 'active') throw new Error('onebot 适配器未激活');
  return host;
}

describe('OneBot 的类型声明与群聊历史提示', () => {
  it('三个类型带显示名：原文是群聊、私聊、频道，有英文', async () => {
    const host = await boot();
    const [adapter] = host.platform.list();
    expect(
      sessionTypesOf(adapter?.use).map(({ name, label, multiParty }) => [
        name,
        multiParty,
        toSource(label),
        resolveText(label as TextRef, ['en']),
      ]),
    ).toEqual([
      ['group', true, '群聊', 'Group chat'],
      ['private', false, '私聊', 'Private chat'],
      ['channel', true, '频道', 'Channel'],
    ]);
  });

  it('群聊历史含多位群友那一句：群与频道给，私聊不给', async () => {
    const host = await boot();
    const hinted = async (sessionId: string) => {
      const messages: Message[] = [
        { role: 'system', content: '人设' },
        { role: 'user', content: '<占位>' },
      ];
      await assemblePromptContributions(host, { messages, sessionId });
      return messages.some(m => typeof m.content === 'string' && m.content.includes(MULTI_PARTY_HINT));
    };
    expect(await hinted(GROUP), '群').toBe(true);
    expect(await hinted(CHANNEL), '频道').toBe(true);
    expect(await hinted(PRIVATE), '私聊').toBe(false);
  });
});
