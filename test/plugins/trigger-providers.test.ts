import { afterEach, describe, expect, it } from 'vitest';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { type TriggerProvider, trigger } from '../../packages/api-trigger/src/index.js';
import { App, type Logger, LogHub, provide, services } from '../../packages/core/src/index.js';
import { askProvider, createAttachmentRecognition } from '../../packages/plugin-trigger-policy/src/consult.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// trigger-policy 作为相位宿主：「要不要开口」按 trigger.all() 的顺序问提供者，
// 第一个不弃权的说了算；规则提供者（本插件自带，优先级 0）兜底。开口后的清零、
// triggerType（按是否点名）与授权主体由宿主统一写。附件识别由提供者按需触发，
// 宿主往下传与归档都不等它跑完（agent 预处理器与归档按消息对象复用这次识别，整条链见
// trigger-attachment-chain.test.ts）。
//
// 直接驱动 inbound:trigger 钩子链（不装 gateway 插件与 flow-control），另一个提供者
// 由测试宿主以更高优先级登记，模拟判定模型。
// ════════════════════════════════════════════════════════════

const AT = '<at self id="10000">Aalis</at> ';
/** 每条消息都达到计数阈值：规则提供者对未点名的群消息一律开口 */
const EVERY_MESSAGE = { intervalMode: 'fixed', fixedInterval: 1 };
const RULE_LABEL = '规则（计数/评分）';

const groupMsg = (content: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  content,
  platform: 'onebot',
  sessionType: 'group',
  sessionId: 'onebot:10000:group:20001',
  groupId: '20001',
  userId: '30001',
  nickname: '甲',
  ...extra,
});

const imageMsg = (content = '看图', extra: Partial<IncomingMessage> = {}): IncomingMessage =>
  groupMsg(content, { attachments: [{ kind: 'image', data: 'https://example.invalid/pic/a.jpg' }], ...extra });

interface SetupOptions {
  config?: Record<string, unknown>;
  /** 以更高优先级（默认 10）登记的另一个提供者，标签默认「模型」 */
  provider?: TriggerProvider['decide'];
  media?: { processMessage(msg: IncomingMessage): Promise<unknown> };
  /** 提供 message-archive：记下归档时刻的正文与附件描述 */
  archived?: Array<{ content: string; descs?: Array<string | undefined> }>;
  /** 收集判定日志行 */
  logs?: string[];
}

const booted: App[] = [];

afterEach(async () => {
  for (const app of booted.splice(0)) await app.stop();
});

async function setup(opts: SetupOptions = {}) {
  const logHub = new LogHub();
  const logs = opts.logs;
  if (logs) {
    logHub.onEntry(e => {
      if (e.message.includes('[trigger] 判定')) logs.push(e.message);
    });
  }
  const app = new App({ name: 'T', logLevel: logs ? 'debug' : 'error', logHub });
  booted.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, hooks, services });
  host.provide(gateway, {} as never); // 满足 required 依赖；相位判定本身不经过 gateway
  if (opts.media) host.provide(media, opts.media as never);
  const archived = opts.archived;
  if (archived) {
    host.provide(messageArchive, {
      async archiveIncoming(m: IncomingMessage) {
        archived.push({ content: m.content, descs: m._attachmentDescriptions && [...m._attachmentDescriptions] });
      },
    } as never);
  }
  if (opts.provider) host.provide(trigger, { decide: opts.provider }, { priority: 10, label: '模型' });
  await app.plugins.register(triggerPolicyPlugin, opts.config ?? {});
  await app.plugins.idle();
  // 激活闸：required 依赖缺席时插件停在 pending 而不报错，不核状态会让整组用例伪装成绿
  const state = app.plugins.getPlugin(triggerPolicyPlugin.name)?.state;
  if (state !== 'active') throw new Error(`trigger-policy 插件未激活（state=${state}）`);
  return Object.assign(host, { app });
}

/** 驱动 inbound:trigger 钩子链；记下是否放行，以及放行那一刻的附件描述 */
async function run(chain: Hooks, message: IncomingMessage) {
  let reached = false;
  let descsAtNext: Array<string | undefined> | undefined;
  await chain.run('inbound:trigger', { message, metadata: {}, agent: undefined }, async () => {
    reached = true;
    descsAtNext = message._attachmentDescriptions && [...message._attachmentDescriptions];
  });
  return { reached, descsAtNext, message };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 假 media：记下被识别的消息，识别完写一条图片描述 */
function fakeMedia(finish: () => Promise<void> = async () => {}) {
  const calls: IncomingMessage[] = [];
  const svc = {
    async processMessage(msg: IncomingMessage) {
      calls.push(msg);
      await finish();
      msg._attachmentDescriptions = ['[图片: 一只猫]'];
      return { total: 1, successCount: 1, items: [] };
    },
  };
  return { svc, calls };
}

describe('trigger 宿主：按序问提供者', () => {
  it('高优先级提供者先问：未点名时开口记 interval 并回填无主体授权；计数随之清零', async () => {
    let modelSpeaks = true;
    const host = await setup({
      config: { intervalMode: 'fixed', fixedInterval: 3 },
      provider: async () => (modelSpeaks ? { speak: true, reason: '模型开口' } : null),
    });

    const first = await run(host.hooks, groupMsg('随便聊聊'));
    expect(first.reached).toBe(true);
    expect(first.message.triggerType).toBe('interval');
    expect(first.message.actor).toEqual({ platform: 'onebot', userId: '' });

    // 模型开口同样清零计数：之后模型弃权、规则从 0 计，第 3 条才触发（未清零则第 2 条就凑满）
    modelSpeaks = false;
    const reached: boolean[] = [];
    for (let i = 1; i <= 3; i++) reached.push((await run(host.hooks, groupMsg(`第 ${i} 条`))).reached);
    expect(reached).toEqual([false, false, true]);
  });

  it('点名交给模型判定：模型开口记 immediate、授权主体不回填；模型不开口则吞掉并归档', async () => {
    let speak = true;
    const seen: boolean[] = [];
    const archived: Array<{ content: string }> = [];
    const host = await setup({
      provider: async ({ addressed }) => {
        seen.push(addressed);
        return { speak, reason: '模型' };
      },
      archived,
    });

    const spoke = await run(host.hooks, groupMsg(`${AT}在吗`));
    expect(spoke.reached).toBe(true);
    expect(spoke.message.triggerType).toBe('immediate');
    expect(spoke.message.actor).toBeUndefined();

    speak = false;
    const silent = await run(host.hooks, groupMsg(`${AT}还在吗`));
    expect(silent.reached).toBe(false);
    expect(silent.message.triggerType).toBeUndefined();
    expect(archived.map(a => a.content)).toEqual([`${AT}还在吗`]);
    expect(seen, '宿主把点名作为类别信息交给提供者').toEqual([true, true]);
  });

  const abstaining: Array<[what: string, tag: string, decide: TriggerProvider['decide']]> = [
    ['返回 null', '弃权', async () => null],
    [
      '抛错',
      '出错',
      async () => {
        throw new Error('侧车不可达');
      },
    ],
    ['超过截止时间', '超时', () => new Promise<never>(() => {})],
  ];
  it.each(abstaining)('提供者%s按弃权处理，转问规则提供者', async (_what, tag, decide) => {
    const logs: string[] = [];
    const host = await setup({ config: { ...EVERY_MESSAGE, decisionTimeoutMs: 30 }, provider: decide, logs });

    const r = await run(host.hooks, groupMsg('随便聊聊'));
    expect(r.reached).toBe(true);
    expect(r.message.triggerType).toBe('interval');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`决定者=${RULE_LABEL}`);
    expect(logs[0]).toContain(`弃权=模型(${tag})`);
  });

  it('偏好切到规则提供者（WebUI 服务页的回滚方式）：即时生效，模型不再被问', async () => {
    let asked = 0;
    const host = await setup({
      config: EVERY_MESSAGE,
      provider: async () => {
        asked++;
        return { speak: false, reason: '模型' };
      },
    });

    expect((await run(host.hooks, groupMsg('第一条'))).reached).toBe(false);
    expect(asked).toBe(1);

    const rule = host.services.all(trigger).find(v => v.label === RULE_LABEL);
    expect(rule, '规则提供者应在 trigger 服务里').toBeDefined();
    host.services.prefer(trigger, rule?.contextId ?? '');
    expect((await run(host.hooks, groupMsg('第二条'))).reached).toBe(true);
    expect(asked).toBe(1);
  });

  it('判定日志：每条一行，含会话、决定者、speak、addressed、reason、score、耗时，不含消息正文', async () => {
    const logs: string[] = [];
    const host = await setup({ provider: async () => ({ speak: true, reason: '模型判定', score: 1.5 }), logs });

    await run(host.hooks, groupMsg('这是一段不该进日志的正文'));
    expect(logs).toHaveLength(1);
    const line = logs[0];
    for (const part of [
      'session=onebot:10000:group:20001',
      '决定者=模型',
      'speak=true',
      'addressed=false',
      'reason=模型判定',
      'score=1.5',
    ]) {
      expect(line).toContain(part);
    }
    expect(line).toMatch(/耗时=\d+ms/);
    expect(line).not.toContain('不该进日志');
  });

  it('判定途中宿主重载：在途消息仍由规则按旧状态判定，不落入「全部弃权、默认放行」', async () => {
    const gate = deferred();
    const archived: Array<{ content: string }> = [];
    const logs: string[] = [];
    const host = await setup({
      config: { intervalMode: 'fixed', fixedInterval: 100 },
      provider: async () => {
        await gate.promise;
        return null;
      },
      archived,
      logs,
    });

    const pending = run(host.hooks, groupMsg('随便聊聊'));
    await sleep(20); // 模型提供者已被问到、挂起
    expect(await host.app.plugins.bounce(triggerPolicyPlugin.name)).toBe(true);
    gate.resolve();
    const r = await pending;
    expect(r.reached, '计数 1/100，规则应判不开口').toBe(false);
    expect(r.message.triggerType).toBeUndefined();
    expect(archived.map(a => a.content)).toEqual(['随便聊聊']);
    expect(logs[0]).toContain(`决定者=${RULE_LABEL}`);
  });
});

// 重组前（1b582a0a）记入站、判定、清零在同一拍同步做完，同一 tick 到达的一簇消息逐条计数：
// fixedInterval=2 时 4 条放行第 2、4 条。判定改成异步后，一簇消息先全部记入再陆续判定；规则若读
// 判定那一刻的会话状态，4 条都达标、全部放行。现在规则按各自记入站那一刻的计数判定，判定期间本会话
// 已有放行的作废：4 条只放行撞上阈值的第 2 条（不多于重组前，第 4 条的计数随第 2 条的放行清零）。
describe('trigger 宿主：同一会话突发', () => {
  const EVERY_TWO = { intervalMode: 'fixed', fixedInterval: 2 };

  it('只装规则、同一 tick 发 4 条：只放行撞上阈值的第 2 条', async () => {
    const logs: string[] = [];
    const host = await setup({ config: EVERY_TWO, logs });
    const results = await Promise.all([1, 2, 3, 4].map(i => run(host.hooks, groupMsg(`第 ${i} 条`))));
    expect(results.map(r => r.reached)).toEqual([false, true, false, false]);
    expect(logs.filter(l => l.includes('判定期间本会话已放行'))).toHaveLength(2);
  });

  it('突发里被点名的消息照常放行（与重组前相同）', async () => {
    const host = await setup({ config: EVERY_TWO });
    const contents = ['第 1 条', '第 2 条', `${AT}第 3 条`, '第 4 条'];
    const results = await Promise.all(contents.map(c => run(host.hooks, groupMsg(c))));
    expect(results.map(r => r.reached)).toEqual([false, true, true, false]);
    expect(results[2].message.triggerType).toBe('immediate');
  });

  it('前置慢弃权的提供者（如影子期的判定模型）、每隔 5ms 发 3 条：放行撞上阈值的第 2 条（与重组前相同）', async () => {
    const host = await setup({
      config: EVERY_TWO,
      provider: async () => {
        await sleep(50);
        return null;
      },
    });
    const pending: Array<ReturnType<typeof run>> = [];
    for (let i = 1; i <= 3; i++) {
      pending.push(run(host.hooks, groupMsg(`第 ${i} 条`)));
      await sleep(5);
    }
    // 修复前按判定那一刻读状态，3 条都已记入：第 1 条读到计数 3 被放行，撞上阈值的第 2 条反被吞掉
    expect((await Promise.all(pending)).map(r => r.reached)).toEqual([false, true, false]);
  });

  it('其它提供者的逐条判定不受约束：模型对同一 tick 的 3 条都判开口，3 条都放行', async () => {
    const host = await setup({ config: EVERY_TWO, provider: async () => ({ speak: true, reason: '模型' }) });
    const results = await Promise.all([1, 2, 3].map(i => run(host.hooks, groupMsg(`第 ${i} 条`))));
    expect(results.map(r => r.reached)).toEqual([true, true, true]);
  });
});

describe('trigger 宿主：附件识别', () => {
  it('纯规则判定不启动识别：图片消息的判定不等 media', async () => {
    const { svc, calls } = fakeMedia();
    const archived: Array<{ content: string }> = [];
    const host = await setup({ media: svc, archived });

    await run(host.hooks, imageMsg('未到阈值的图')); // 默认 fixedInterval=5：规则判不开口，吞掉归档
    await run(host.hooks, imageMsg(`${AT}看图`));
    expect(calls).toHaveLength(0);
    expect(archived).toHaveLength(1);
  });

  it('提供者要描述：宿主识别一次并等待；往下传与归档之前描述已写好', async () => {
    const { svc, calls } = fakeMedia(() => sleep(10));
    const archived: Array<{ content: string; descs?: Array<string | undefined> }> = [];
    const seenByProvider: Array<Array<string | undefined> | undefined> = [];
    const host = await setup({
      media: svc,
      archived,
      provider: async ({ message, awaitAttachmentDescriptions }) => {
        await awaitAttachmentDescriptions();
        await awaitAttachmentDescriptions(); // 多次调用共享同一次识别
        seenByProvider.push(message._attachmentDescriptions);
        return { speak: message.content === '开口', reason: '模型' };
      },
    });

    const spoke = await run(host.hooks, imageMsg('开口'));
    const silent = await run(host.hooks, imageMsg('不开口'));
    expect(calls, '每条消息只识别一次').toHaveLength(2);
    expect(seenByProvider).toEqual([['[图片: 一只猫]'], ['[图片: 一只猫]']]);
    expect(spoke.descsAtNext).toEqual(['[图片: 一只猫]']);
    expect(silent.reached).toBe(false);
    expect(archived).toEqual([{ content: '不开口', descs: ['[图片: 一只猫]'] }]);
  });

  it('已有附件描述或没有 media：不启动识别，等待立即返回', async () => {
    const { svc, calls } = fakeMedia();
    const host = await setup({
      media: svc,
      provider: async ({ awaitAttachmentDescriptions }) => {
        await awaitAttachmentDescriptions();
        return { speak: true, reason: '模型' };
      },
    });
    const r = await run(host.hooks, imageMsg('已识别过', { _attachmentDescriptions: ['[图片: 早就有了]'] }));
    expect(r.reached).toBe(true);
    expect(calls).toHaveLength(0);

    const noMedia = await setup({
      provider: async ({ awaitAttachmentDescriptions }) => {
        await awaitAttachmentDescriptions();
        return { speak: true, reason: '模型' };
      },
    });
    expect((await run(noMedia.hooks, imageMsg())).reached).toBe(true);
  });

  it.each([
    ['开口', true],
    ['不开口', false],
  ] as const)('识别超过等待上限：提供者照常判定（%s），宿主不等识别跑完就往下传或归档', async (_what, speak) => {
    const gate = deferred();
    const { svc, calls } = fakeMedia(() => gate.promise);
    const archived: Array<{ content: string; descs?: Array<string | undefined> }> = [];
    // 提供者回调里的断言会被宿主当作「出错」弃权吞掉，所以只记下来，判定结束后再断言
    let seenByProvider: Array<string | undefined> | undefined = ['尚未判定'];
    const host = await setup({
      config: { mediaWaitMs: 20 },
      media: svc,
      archived,
      provider: async ({ message, awaitAttachmentDescriptions }) => {
        await awaitAttachmentDescriptions();
        seenByProvider = message._attachmentDescriptions;
        return { speak, reason: '模型' };
      },
    });

    const message = imageMsg();
    const r = await Promise.race([run(host.hooks, message), sleep(1000).then(() => undefined)]);
    expect(r, '识别未完成时宿主就该往下传或归档').toBeDefined();
    expect(seenByProvider, '等待超时时描述尚未写好').toBeUndefined();
    expect(r?.reached).toBe(speak);
    if (speak) expect(r?.descsAtNext).toBeUndefined();
    else expect(archived).toEqual([{ content: '看图', descs: undefined }]);

    // 识别在后台继续，写在同一个消息对象上，agent 预处理器与归档随后对它调 processMessage
    gate.resolve();
    await sleep(10);
    expect(calls).toEqual([message]);
    expect(message._attachmentDescriptions).toEqual(['[图片: 一只猫]']);
  });

  it('等附件识别的时间不计入判定截止时间', async () => {
    const { svc } = fakeMedia(() => sleep(100));
    const logs: string[] = [];
    const host = await setup({
      // 规则提供者对这条会开口：若模型因等识别被判超时，消息就会被规则放行
      config: { ...EVERY_MESSAGE, decisionTimeoutMs: 40, mediaWaitMs: 1000 },
      media: svc,
      logs,
      provider: async ({ awaitAttachmentDescriptions }) => {
        await awaitAttachmentDescriptions();
        return { speak: false, reason: '模型看过图' };
      },
    });

    const r = await run(host.hooks, imageMsg());
    expect(r.reached, '模型的判定应被采纳').toBe(false);
    expect(logs[0]).toContain('决定者=模型');
  });
});

describe('askProvider：截止时间与放弃', () => {
  const silent = { warn: () => {} } as unknown as Logger;

  it('截止时间累计等识别前后的耗时，只扣掉等识别那段', async () => {
    // 前后各 80ms、中间等识别 60ms、截止 120ms：累计 160ms 应超时；
    // 若等完识别就重置满额截止时间，后段只算 80ms，会被当作按时判完
    const answer = await askProvider(
      {
        async decide({ awaitAttachmentDescriptions }) {
          await sleep(80);
          await awaitAttachmentDescriptions();
          await sleep(80);
          return { speak: true, reason: '模型' };
        },
      },
      { message: imageMsg(), addressed: false },
      { wait: () => sleep(60) },
      120,
    );
    expect(answer.abstain).toBe('超时');
  });

  it('宿主放弃超时的提供者后，它再等附件描述直接返回，不启动识别', async () => {
    const { svc, calls } = fakeMedia();
    const message = imageMsg();
    const returned = deferred();
    const answer = await askProvider(
      {
        async decide({ awaitAttachmentDescriptions }) {
          await sleep(60);
          await awaitAttachmentDescriptions();
          returned.resolve();
          return { speak: true, reason: '模型' };
        },
      },
      { message, addressed: false },
      createAttachmentRecognition(message, { current: svc as never }, 1000, silent),
      30,
    );
    expect(answer.abstain).toBe('超时');
    await returned.promise;
    expect(calls).toHaveLength(0);
  });
});
