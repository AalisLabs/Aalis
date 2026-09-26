import { describe, expect, it } from 'vitest';
import type { PersonaService, PersonaSessionOptions } from '../../packages/api-persona/src/index.js';
import type { SessionManagerService } from '../../packages/api-session-manager/src/index.js';
import {
  type AddressOptions,
  archiveSwallowed,
  createBotNames,
  hitsMuteKeyword,
  isActiveTrigger,
  isAddressed,
  markTriggered,
  type TriggerService,
  waitForAttachmentDescriptions,
} from '../../packages/api-trigger/src/index.js';
import type { Logger, ServiceView } from '../../packages/core/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// @aalis/api-trigger 的共用宿主函数：两个触发插件（规则 trigger-policy、模型 trigger-laya）
// 的生效者判断、禁言关键词、名字表与点名识别、附件识别等待、放行收尾与吞掉归档都走这里。
// ════════════════════════════════════════════════════════════

/** 名字表枚举 persona 的全部提供者：给出 all 即可 */
const personasRef = (...services: PersonaService[]) => ({
  all: (): ServiceView<PersonaService>[] =>
    services.map((instance, i) => ({ instance, contextId: `persona-${i}`, priority: 0 })),
});
/** session-manager 缺席：名字表不带参数取（全局默认的卡） */
const NO_SM = { current: undefined };
/** 名字表按会话取时传的消息：只用 sessionId 与 platform */
const AT_GROUP = { sessionId: 'onebot:10000:group:20001', platform: 'onebot' };
const NO_NAMES: string[] = [];
const opts = (extra: Partial<AddressOptions> = {}): AddressOptions => ({
  triggerOnAt: true,
  triggerOnPoke: true,
  ...extra,
});
const text = (content: string) => ({ content });
const poke = (content = '') => ({ content, noticeType: 'poke' });

function recordingLogger() {
  const warns: string[] = [];
  const logger = { warn: (m: string) => warns.push(m), info: () => {}, debug: () => {} } as unknown as Logger;
  return { logger, warns };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('isAddressed：@ 自己', () => {
  it('只认 <at self> 标记', () => {
    expect(isAddressed(text('<at self>123</at> hi'), NO_NAMES, opts())).toBe(true);
    expect(isAddressed(text('<at self qq="1">x</at>'), NO_NAMES, opts())).toBe(true);
  });
  it('裸 CQ 码不命中（adapter 入站已规范化成 <at self>，CQ 码到不了这里）', () => {
    expect(isAddressed(text('[CQ:at,qq=12345] 你好'), NO_NAMES, opts())).toBe(false);
  });
  it('@别人（<at> 无 self）不命中', () => {
    expect(isAddressed(text('<at id="999">路人</at> 你好'), NO_NAMES, opts())).toBe(false);
  });
  it('普通文本 @nickname 不算 @ 提及（避免 @他人 误触发，名字检测另算）', () => {
    expect(isAddressed(text('hi @aalis 帮我'), NO_NAMES, opts())).toBe(false);
  });
  it('triggerOnAt 关闭时不认 @', () => {
    expect(isAddressed(text('<at self id="1">bot</at> hi'), NO_NAMES, opts({ triggerOnAt: false }))).toBe(false);
  });
});

describe('isAddressed：名字', () => {
  it('名字表里任一个出现在正文里即命中；空名字不命中', () => {
    expect(isAddressed(text('阿狸你好'), ['阿狸'], opts())).toBe(true);
    expect(isAddressed(text('小A 在吗'), ['Aalis', '小A'], opts({ triggerOnAt: false }))).toBe(true);
    expect(isAddressed(text('随便聊聊'), ['阿狸', 'Aalis'], opts())).toBe(false);
    expect(isAddressed(text('hello'), [''], opts())).toBe(false);
  });
});

describe('createBotNames', () => {
  const card = (name: string, nicks?: unknown[]): PersonaService => ({
    getSystemPrompt: () => '',
    getPersonaName: () => name,
    ...(nicks ? { getNickNames: () => nicks as string[] } : {}),
  });
  const broken = (message: string): PersonaService => ({
    getSystemPrompt: () => '',
    getPersonaName: () => {
      throw new Error(message);
    },
  });

  it('别名与全部人设的名字、昵称的并集：别名在前，去重、去空与非字符串', () => {
    const { logger } = recordingLogger();
    const names = createBotNames(
      personasRef(card('Aalis', ['', '小A', 'Aalis']), card('Bob', ['阿狸', 7])),
      NO_SM,
      logger,
      '[t]',
    );
    expect(names(['阿狸', ''], AT_GROUP)).toEqual(['阿狸', 'Aalis', '小A', 'Bob']);
    expect(names([], AT_GROUP), '每次调用现取').toEqual(['Aalis', '小A', 'Bob', '阿狸']);
    expect(createBotNames(personasRef(), NO_SM, logger, '[t]')(['别名'], AT_GROUP)).toEqual(['别名']);
  });

  it('某个人设读名字抛错：只跳过它的名字，其余照常；同一原因只告警一次，恢复后再出错再告警', () => {
    const { logger, warns } = recordingLogger();
    let reason: string | undefined = 'persona 故障';
    const flaky: PersonaService = {
      getSystemPrompt: () => '',
      getPersonaName: () => {
        if (reason) throw new Error(reason);
        return 'Carol';
      },
    };
    const names = createBotNames(personasRef(flaky, card('Aalis', ['小A'])), NO_SM, logger, '[t]');
    expect(names(['别名'], AT_GROUP)).toEqual(['别名', 'Aalis', '小A']);
    expect(names(['别名'], AT_GROUP)).toEqual(['别名', 'Aalis', '小A']);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^\[t\] 人设「persona-0」读名字失败.*persona 故障/);

    reason = '另一个故障';
    names([], AT_GROUP);
    expect(warns, '原因变了再记一次').toHaveLength(2);
    reason = undefined;
    expect(names([], AT_GROUP)).toEqual(['Carol', 'Aalis', '小A']);
    reason = '另一个故障';
    names([], AT_GROUP);
    expect(warns, '读成功一次后再出错，同一原因也再记').toHaveLength(3);
  });

  it('人设全部抛错时只剩别名，点名识别照常（不抛错）', () => {
    const { logger } = recordingLogger();
    const names = createBotNames(personasRef(broken('故障甲'), broken('故障乙')), NO_SM, logger, '[t]');
    expect(names(['阿狸'], AT_GROUP)).toEqual(['阿狸']);
    expect(isAddressed(text('阿狸在吗'), names(['阿狸'], AT_GROUP), opts())).toBe(true);
    expect(isAddressed(text('随便聊聊'), names(['阿狸'], AT_GROUP), opts())).toBe(false);
  });

  /** 按 options.persona 选卡的人设提供者（同 plugin-persona：没有该卡时回落主卡），记下每次调用收到的参数 */
  function cards(primary: [string, string[]], others: Record<string, [string, string[]]>) {
    const calls: Array<PersonaSessionOptions | undefined> = [];
    const pick = (o?: PersonaSessionOptions) => (o?.persona && others[o.persona]) || primary;
    const svc: PersonaService = {
      getSystemPrompt: () => '',
      getPersonaName: o => {
        calls.push(o);
        return pick(o)[0];
      },
      getNickNames: o => pick(o)[1],
    };
    return { svc, calls };
  }

  /** session-manager 替身：按会话 ID 给 persona，记下每次解析的参数 */
  function sessionManagerOf(byId: Record<string, string>) {
    const resolved: Array<[string, string | undefined]> = [];
    const svc = {
      resolveConfig: (sessionId: string, platform?: string) => {
        resolved.push([sessionId, platform]);
        return { persona: byId[sessionId] };
      },
    } as unknown as SessionManagerService;
    return { ref: { current: svc }, resolved };
  }

  it('按会话取：session-manager 解析会话配置，其中的 persona 传给每个人设提供者；两个会话各用各的卡', () => {
    const { logger } = recordingLogger();
    const first = cards(['Aalis', ['小A']], { bob: ['Bob', ['阿B']] });
    const second = cards(['Carol', []], {});
    const sm = sessionManagerOf({ 'onebot:10000:group:1': 'bob' });
    const names = createBotNames(personasRef(first.svc, second.svc), sm.ref, logger, '[t]');
    const inBob = { sessionId: 'onebot:10000:group:1', platform: 'onebot' };
    const inMain = { sessionId: 'onebot:10000:group:2', platform: 'onebot' };

    expect(names(['别名'], inBob)).toEqual(['别名', 'Bob', '阿B', 'Carol']);
    expect(names(['别名'], inMain)).toEqual(['别名', 'Aalis', '小A', 'Carol']);
    expect(sm.resolved).toEqual([
      ['onebot:10000:group:1', 'onebot'],
      ['onebot:10000:group:2', 'onebot'],
    ]);
    expect(second.calls, '每个提供者收到同一份会话选项').toEqual([{ persona: 'bob' }, { persona: undefined }]);
  });

  it('session-manager 缺席：不带参数取（全局默认的卡）', () => {
    const { logger } = recordingLogger();
    const one = cards(['Aalis', []], { bob: ['Bob', []] });
    expect(createBotNames(personasRef(one.svc), NO_SM, logger, '[t]')([], AT_GROUP)).toEqual(['Aalis']);
    expect(one.calls).toEqual([undefined]);
  });

  it('session-manager 解析抛错：按全局默认的卡取、照常返回名字；同一原因只告警一次，解析成功后再出错再告警', () => {
    const { logger, warns } = recordingLogger();
    const one = cards(['Aalis', []], { bob: ['Bob', []] });
    let failure: string | undefined = '会话库不可用';
    const sm = {
      current: {
        resolveConfig: () => {
          if (failure) throw new Error(failure);
          return { persona: 'bob' };
        },
      } as unknown as SessionManagerService,
    };
    const names = createBotNames(personasRef(one.svc), sm, logger, '[t]');
    expect(names(['别名'], AT_GROUP)).toEqual(['别名', 'Aalis']);
    expect(names(['别名'], AT_GROUP)).toEqual(['别名', 'Aalis']);
    expect(warns).toEqual(['[t] 解析会话配置失败，名字表按全局默认的人设取: Error: 会话库不可用']);

    failure = undefined;
    expect(names([], AT_GROUP)).toEqual(['Bob']);
    failure = '会话库不可用';
    names([], AT_GROUP);
    expect(warns, '解析成功一次后再出错，同一原因也再记').toHaveLength(2);
  });
});

describe('isAddressed：戳一戳', () => {
  it('按 triggerOnPoke', () => {
    expect(isAddressed(poke(), NO_NAMES, opts())).toBe(true);
    expect(isAddressed(poke(), NO_NAMES, opts({ triggerOnPoke: false }))).toBe(false);
  });

  it('关闭后戳者昵称含 bot 名、正文含 @ 也不算点名（合成文案是元数据不是发言）', () => {
    const content = '[戳一戳: Aalis的小跟班(12345) 戳了你] <at self>x</at>';
    expect(isAddressed(poke(content), ['Aalis'], opts({ triggerOnPoke: false }))).toBe(false);
    // 对照：同样正文的普通消息命中
    expect(isAddressed(text(content), ['Aalis'], opts({ triggerOnPoke: false }))).toBe(true);
  });
});

describe('hitsMuteKeyword', () => {
  it('正文包含任一关键词即命中；空表不命中', () => {
    expect(hitsMuteKeyword(text('你给我闭嘴'), ['别说话', '闭嘴'])).toBe(true);
    expect(hitsMuteKeyword(text('hello world'), ['x'])).toBe(false);
    expect(hitsMuteKeyword(text('please stop'), [])).toBe(false);
  });
  it('戳一戳恒不命中（合成文案内嵌戳者昵称）', () => {
    expect(hitsMuteKeyword(poke('[戳一戳: 闭嘴(12345) 戳了你]'), ['闭嘴'])).toBe(false);
  });
});

describe('markTriggered', () => {
  const group = (extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
    content: 'x',
    platform: 'onebot',
    sessionType: 'group',
    sessionId: 'onebot:10000:group:20001',
    groupId: '20001',
    userId: '10001',
    ...extra,
  });

  it('点名为 immediate，授权主体维持缺省', () => {
    const m = group();
    markTriggered(m, true);
    expect(m.triggerType).toBe('immediate');
    expect(m.actor).toBeUndefined();
  });

  it('非点名为 interval：多人会话回填无主体授权，发言者字段不变', () => {
    const m = group();
    markTriggered(m, false);
    expect(m.triggerType).toBe('interval');
    expect(m.actor).toEqual({ platform: 'onebot', userId: '' });
    expect(m.userId).toBe('10001');
  });

  it('频道等其它多人会话的 interval 同样回填：条件是「不是私聊」，不是「是群聊」', () => {
    const channel = group({
      sessionType: 'channel',
      sessionId: 'onebot:10000:channel:40001:50001',
      groupId: undefined,
    });
    markTriggered(channel, false);
    expect(channel.triggerType).toBe('interval');
    expect(channel.actor).toEqual({ platform: 'onebot', userId: '' });
  });

  it('私聊的 interval 不回填；消息已带 actor 时不覆盖', () => {
    const priv = group({ sessionType: 'private', sessionId: 'onebot:10000:private:10001', groupId: undefined });
    markTriggered(priv, false);
    expect(priv.actor).toBeUndefined();
    const delegated = group({ actor: { platform: 'webui', userId: 'console' } });
    markTriggered(delegated, false);
    expect(delegated.actor).toEqual({ platform: 'webui', userId: 'console' });
  });
});

describe('waitForAttachmentDescriptions', () => {
  const image = (extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
    content: '看图',
    platform: 'onebot',
    sessionId: 'onebot:10000:group:20001',
    attachments: [{ kind: 'image', data: 'https://example.invalid/a.jpg' }],
    ...extra,
  });

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
    return { ref: { current: svc as never }, calls };
  }

  it('识别在上限内写好描述：等到描述', async () => {
    const { ref, calls } = fakeMedia(() => sleep(5));
    const m = image();
    await waitForAttachmentDescriptions(m, ref, 1000, recordingLogger().logger, '[t]');
    expect(calls).toEqual([m]);
    expect(m._attachmentDescriptions).toEqual(['[图片: 一只猫]']);
  });

  it('没有 media、没有附件、已有描述：不启动识别，立即返回', async () => {
    const { ref, calls } = fakeMedia();
    const { logger } = recordingLogger();
    await waitForAttachmentDescriptions(image(), { current: undefined }, 1000, logger, '[t]');
    await waitForAttachmentDescriptions(image({ attachments: [] }), ref, 1000, logger, '[t]');
    await waitForAttachmentDescriptions(
      image({ _attachmentDescriptions: ['[图片: 早就有了]'] }),
      ref,
      1000,
      logger,
      '[t]',
    );
    expect(calls).toHaveLength(0);
  });

  it('超过上限照常返回，识别在后台继续写到同一个消息对象上', async () => {
    const gate = deferred();
    const { ref } = fakeMedia(() => gate.promise);
    const m = image();
    await waitForAttachmentDescriptions(m, ref, 20, recordingLogger().logger, '[t]');
    expect(m._attachmentDescriptions).toBeUndefined();
    gate.resolve();
    await sleep(5);
    expect(m._attachmentDescriptions).toEqual(['[图片: 一只猫]']);
  });

  it('识别失败：记 warn（前缀由调用方给），不抛错', async () => {
    const { logger, warns } = recordingLogger();
    const failing = {
      current: {
        processMessage: async () => {
          throw new Error('识别模型不可用');
        },
      } as never,
    };
    await expect(waitForAttachmentDescriptions(image(), failing, 1000, logger, '[laya]')).resolves.toBeUndefined();
    expect(warns).toEqual(['[laya] 附件识别失败: Error: 识别模型不可用']);
  });
});

describe('archiveSwallowed', () => {
  const msg: IncomingMessage = { content: 'x', platform: 'onebot', sessionId: 'onebot:10000:group:20001' };

  it('message-archive 缺席时跳过；归档失败记 warn（前缀由调用方给），不抛错', async () => {
    const { logger, warns } = recordingLogger();
    await archiveSwallowed(msg, { current: undefined }, logger, '[laya]');
    const broken = {
      current: {
        archiveIncoming: async () => {
          throw new Error('库不可用');
        },
      } as never,
    };
    await expect(archiveSwallowed(msg, broken, logger, '[laya]')).resolves.toBeUndefined();
    expect(warns).toEqual(['[laya] shadow 归档失败: Error: 库不可用']);
  });
});

describe('isActiveTrigger', () => {
  it('胜者每次入站只取一次：取下之后换胜者，这次入站仍按取下的算', () => {
    const rule: TriggerService = { label: '规则' };
    const laya: TriggerService = { label: '模型' };
    const ref: { current: TriggerService | undefined } = { current: laya };
    const phase = {};
    expect(isActiveTrigger(phase, ref, rule)).toBe(false);
    ref.current = rule; // 判定途中切了偏好
    expect(isActiveTrigger(phase, ref, rule), '同一次入站不再换人').toBe(false);
    expect(isActiveTrigger(phase, ref, laya)).toBe(true);
    // 下一次入站按新的胜者
    expect(isActiveTrigger({}, ref, rule)).toBe(true);
  });

  it('没有胜者时谁都不判', () => {
    const self: TriggerService = { label: '规则' };
    expect(isActiveTrigger({}, { current: undefined }, self)).toBe(false);
  });
});
