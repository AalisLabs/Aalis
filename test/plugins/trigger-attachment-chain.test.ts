import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type MediaProcessor, media } from '../../packages/api-media/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { trigger } from '../../packages/api-trigger/src/index.js';
import { App, events, type Logger, provide } from '../../packages/core/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import { buildPreprocessor } from '../../packages/plugin-media/src/preprocessor.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { emptyMediaCaps } from '../fixtures/service-ref.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 附件识别整条链：判定模型启动的识别，放行与吞掉都不等它
//
// 判定模型要看附件描述时，trigger 宿主启动识别并最多等 mediaWaitMs；之后放行（交给 flow 相位与
// agent）和吞掉（影子归档）都不等识别跑完。agent 预处理器与归档对同一个消息对象调 processMessage，
// 按对象记忆命中这次识别（在途则等它），整条链只识别一次。
//
// 真实插件：gateway + flow-control + trigger-policy + message-archive（内存 memory）。media 是真实的
// MediaServiceImpl，识别模型换成可卡住的替身；agent 替身按真实 agent 的顺序先跑 media 预处理器、
// 再归档。每个用例用不同的图片 URL，避开描述缓存。
// ════════════════════════════════════════════════════════════

const AT = '<at self id="10000">Aalis</at> ';
const SESSION = 'onebot:10000:group:20001';

const groupMsg = (content: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  content,
  platform: 'onebot',
  sessionType: 'group',
  sessionId: SESSION,
  groupId: '20001',
  userId: '30001',
  nickname: '甲',
  ...extra,
});

const imageMsg = (name: string): IncomingMessage =>
  groupMsg('看图', { attachments: [{ kind: 'image', data: `https://example.invalid/pic/${name}.jpg` }] });

const silent = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 让出若干轮事件循环：判定之后的归档、识别启动都在微任务与 I/O 回调里 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>(r => setImmediate(r));
}

/** 轮询到条件成立或超时，返回条件的最终值 */
async function eventually(cond: () => boolean, ms = 1000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
  return cond();
}

const booted: App[] = [];

afterEach(async () => {
  for (const app of booted.splice(0)) await app.stop();
});

async function setup(opts: { speak: boolean; flow?: Record<string, unknown> }) {
  const app = new App({ name: 'T', logLevel: 'error' });
  booted.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, gateway, messageArchive });

  // 识别模型替身：放行闸门前不返回，记调用次数
  const vision = { calls: 0, gate: deferred() };
  const cfg = {
    vision: { recognizeOnArrival: true, delivery: 'describe', maxTokens: 300, think: false, prompt: '' },
    audio: { mode: 'disabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
    senderContext: { enabled: false, profileMaxChars: 0 },
  } as unknown as MediaConfigResolved;
  const svc = new MediaServiceImpl(emptyMediaCaps(silent), cfg);
  svc.registerProcessor({
    name: 'fake-vision',
    capabilities: ['vision'],
    describe: async () => {
      vision.calls++;
      await vision.gate.promise;
      return { descriptions: ['一只橘猫'] };
    },
  } as MediaProcessor);
  host.provide(media, svc);

  const preprocess = buildPreprocessor({ events: host.events, logger: silent }, svc);
  const entered: IncomingMessage[] = [];
  host.provide(agent, {
    async handleMessage(msg: IncomingMessage) {
      entered.push(msg);
      await preprocess(msg, async () => {
        await host.messageArchive.require().archiveIncoming(msg);
      });
    },
  } as never);

  const archived: string[] = [];
  host.events.on('inbound:message:archived', ({ archivedMessage }) => {
    archived.push(archivedMessage.content ?? '');
  });

  let decided = 0;
  host.provide(
    trigger,
    {
      async decide({ awaitAttachmentDescriptions }) {
        await awaitAttachmentDescriptions();
        decided++;
        return { speak: opts.speak, reason: '模型' };
      },
    },
    { priority: 10, label: '模型' },
  );

  const plugins = [memoryInMemory, messageArchivePlugin, gatewayPlugin, flowControlPlugin, triggerPolicyPlugin];
  await app.plugins.register(memoryInMemory, {});
  await app.plugins.register(messageArchivePlugin, { debugLogs: false });
  await app.plugins.register(gatewayPlugin, {});
  await app.plugins.register(flowControlPlugin, opts.flow ?? {});
  // 规则提供者本会吞掉这些消息（计数 1/100）：放行都出自模型的判定
  await app.plugins.register(triggerPolicyPlugin, { fixedInterval: 100, mediaWaitMs: 30 });
  await app.plugins.idle();
  // 激活闸：required 依赖缺席时插件停在 pending 而不报错，不核状态会让整组用例伪装成绿
  for (const p of plugins) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }

  return {
    vision,
    entered,
    archived,
    decided: () => decided,
    send: (msg: IncomingMessage) => host.gateway.require().ingressMessage(msg),
    reply: () =>
      host.gateway
        .require()
        .dispatchOutbound({ content: '好的', sessionId: SESSION, platform: 'onebot', source: 'agent' }),
  };
}

describe('附件识别整条链只识别一次', () => {
  it('放行不等识别：识别未完成时 agent 已收到消息，预处理器等完这次识别，归档不再识别', async () => {
    const h = await setup({ speak: true });
    const msg = imageMsg('chain-release');

    const pending = h.send(msg);
    expect(await eventually(() => h.entered.length === 1), '识别未完成时就该交给 agent').toBe(true);
    expect(msg._attachmentDescriptions).toBeUndefined();
    expect(msg.triggerType).toBe('interval');

    h.vision.gate.resolve();
    await pending;
    await flush();
    expect(h.vision.calls, '判定、预处理器、归档共用一次识别').toBe(1);
    expect(h.archived).toHaveLength(1);
    expect(h.archived[0]).toContain('一只橘猫');
  });

  it('trigger 相位吞掉：归档命中判定启动的识别，等它写好描述', async () => {
    const h = await setup({ speak: false });
    const msg = imageMsg('chain-trigger-swallow');

    const pending = h.send(msg);
    expect(await eventually(() => h.decided() === 1)).toBe(true);
    await flush(); // 吞掉后的归档已开始
    expect(h.vision.calls, '归档不该对拷贝再识别一遍').toBe(1);

    h.vision.gate.resolve();
    await pending;
    await flush();
    expect(h.vision.calls).toBe(1);
    expect(h.entered).toHaveLength(0);
    expect(h.archived).toHaveLength(1);
    expect(h.archived[0]).toContain('一只橘猫');
  });

  it('flow 相位吞掉（回复后冷却）：归档同样命中判定启动的识别', async () => {
    const h = await setup({ speak: true, flow: { cooldownSeconds: 60 } });
    // 先有一条消息经过 flow 相位建出会话状态，agent 回复后进入冷却
    await h.send(groupMsg(`${AT}在吗`));
    expect(h.entered).toHaveLength(1);
    await h.reply();

    const msg = imageMsg('chain-flow-swallow');
    const pending = h.send(msg);
    expect(await eventually(() => h.decided() === 2)).toBe(true);
    await flush();
    expect(h.vision.calls, '归档不该对拷贝再识别一遍').toBe(1);

    h.vision.gate.resolve();
    await pending;
    await flush();
    expect(h.vision.calls).toBe(1);
    expect(h.entered, '冷却中的 interval 被 flow 相位吞掉').toHaveLength(1);
    expect(h.archived).toHaveLength(2);
    expect(h.archived[1]).toContain('一只橘猫');
  });
});
