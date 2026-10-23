import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { PublishOrigin } from '../../packages/api-publish/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import { ReviewNotices } from '../../packages/plugin-publish-review/src/notices.js';
import { defineTexts, resolveText, toSource } from '../../packages/schema-i18n/src/index.js';
import type { IncomingMessage, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 作品通知的两用拆分：交给她转述的入站正文照旧是写给模型的原文，给人看的那句作为 hostNotice.text 一并交出；
// 宿主正文兜底（重发或转述没成）出站带文字对象，content 是它的原文。旧的待发通知没有文字对象，兜底照旧发正文。
// 真的 gateway；agent 与平台适配器是替身（适配器立即确认收下）。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:20001';
const origin: PublishOrigin = {
  producer: 'paper',
  ref: 'task-1',
  label: '测试房间',
  notify: { sessionId: ROOM, platform: 'onebot' },
};
const t = defineTexts({
  ns: '@zz/publish-review-notices',
  language: 'zh-CN',
  source: { rejected: '作品未获批准，这次不发布' } as const,
  locales: { en: { rejected: 'The work was not approved' } },
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot() {
  const app = new App({ logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ events, provide, hooks, gateway });
  const incoming: IncomingMessage[] = [];
  host.provide.use(agent, {
    async handleMessage(message) {
      incoming.push(message);
      await host.gateway.use.dispatchOutbound({
        content: '收到',
        sessionId: message.sessionId,
        platform: message.platform,
        source: 'agent',
        hostNotice: message.hostNotice,
      });
    },
    async assignModel() {},
    abort: () => false,
    async clearing(_sessionIds, clear) {
      await clear();
    },
  });
  await app.plugin(gatewayPlugin);
  await app.plugins.idle();
  const outgoing: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', message => {
    outgoing.push(message);
    message.delivery = Promise.resolve({ ok: true });
  });
  const notices = new ReviewNotices(host.events.use, app.logger, host.gateway, host.hooks.use);
  notices.open();
  return { notices, incoming, outgoing };
}

describe('作品通知：给模型的正文与给人看的那句', () => {
  it('转述回合：入站正文照旧，给人看的那句进 hostNotice.text', async () => {
    const h = await boot();
    const text = t('rejected');
    await h.notices.enqueue(origin, { content: toSource(text), text }, 'zz-work');
    expect(h.incoming.map(m => m.content)).toEqual(['作品未获批准，这次不发布']);
    expect(h.incoming[0]?.hostNotice?.text).toEqual(text);
  });

  it('宿主正文兜底：出站带文字对象、content 是它的原文；旧通知没有文字对象时照旧发正文', async () => {
    const h = await boot();
    await h.notices.enqueue(origin, { content: '作品未获批准，这次不发布', text: t('rejected') }, 'zz-a', undefined, {
      direct: true,
    });
    await h.notices.enqueue(origin, { content: '旧的正文' }, 'zz-b', undefined, { direct: true });
    expect(h.incoming).toEqual([]);
    expect(h.outgoing.map(m => m.content)).toEqual(['[作品通知] 作品未获批准，这次不发布', '[作品通知] 旧的正文']);
    expect(
      h.outgoing.map(m => m.markup),
      '宿主正文按纯文字发，不设 markup',
    ).toEqual([undefined, undefined]);
    expect(h.outgoing.map(m => m.text && resolveText(m.text, ['en']))).toEqual([
      '[Work notice] The work was not approved',
      '[Work notice] 旧的正文',
    ]);
  });
});
