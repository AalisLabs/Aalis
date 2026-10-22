import { describe, expect, it, vi } from 'vitest';
import type { PersonaService, PersonaSessionOptions } from '../../packages/api-persona/src/index.js';
import {
  type AddressOptions,
  archiveSwallowed,
  createBotNames,
  hitsMuteKeyword,
  isActiveTrigger,
  isAddressed,
  markTriggered,
  type TriggerService,
} from '../../packages/api-trigger/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// @aalis/api-trigger 里触发插件共用的函数：两个触发插件（规则 trigger-policy、模型 trigger-laya）
// 的生效者判断、禁言关键词、名字表与点名识别、放行收尾与吞掉归档都走这里。
// ════════════════════════════════════════════════════════════

/** 人设的选择层：第一家是选中的那一家 */
const personasRef = (...services: PersonaService[]) =>
  ref(services.map((instance, i) => ({ instance, contextId: `persona-${i}` })));
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

  it('别名与在用人设的名字、昵称的并集：别名在前，去重、去空与非字符串；没有人设时只有别名', () => {
    const { logger } = recordingLogger();
    const names = createBotNames(personasRef(card('Aalis', ['', '小A', 'Aalis', 7])), logger, '[t]');
    expect(names(['阿狸', ''], AT_GROUP)).toEqual(['阿狸', 'Aalis', '小A']);
    expect(names([], AT_GROUP), '每次调用现取').toEqual(['Aalis', '小A']);
    expect(createBotNames(personasRef(), logger, '[t]')(['别名'], AT_GROUP)).toEqual(['别名']);
  });

  it('装了两个人设提供者：只取选中的那一家，叫没在用的那家的名字不算点名', () => {
    const { logger } = recordingLogger();
    const names = createBotNames(personasRef(card('Aalis', ['小A']), card('Bob', ['阿B'])), logger, '[t]');
    expect(names(['别名'], AT_GROUP)).toEqual(['别名', 'Aalis', '小A']);
    expect(isAddressed(text('Bob 在吗'), names(['别名'], AT_GROUP), opts())).toBe(false);
    expect(isAddressed(text('Aalis 在吗'), names(['别名'], AT_GROUP), opts())).toBe(true);
  });

  it('在用人设读名字抛错：名字表只剩别名，点名照常；同一原因只告警一次，恢复后再出错再告警', () => {
    const { logger, warns } = recordingLogger();
    let reason: string | undefined = 'persona 故障';
    const flaky: PersonaService = {
      getSystemPrompt: () => '',
      getPersonaName: () => {
        if (reason) throw new Error(reason);
        return 'Carol';
      },
    };
    const names = createBotNames(personasRef(flaky, card('Aalis', ['小A'])), logger, '[t]');
    expect(names(['阿狸'], AT_GROUP)).toEqual(['阿狸']);
    expect(names(['阿狸'], AT_GROUP)).toEqual(['阿狸']);
    expect(isAddressed(text('阿狸在吗'), names(['阿狸'], AT_GROUP), opts())).toBe(true);
    expect(isAddressed(text('Aalis 在吗'), names(['阿狸'], AT_GROUP), opts())).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^\[t\] 人设读名字失败.*persona 故障/);

    reason = '另一个故障';
    names([], AT_GROUP);
    expect(warns, '原因变了再记一次').toHaveLength(2);
    reason = undefined;
    expect(names([], AT_GROUP)).toEqual(['Carol']);
    reason = '另一个故障';
    names([], AT_GROUP);
    expect(warns, '读成功一次后再出错，同一原因也再记').toHaveLength(3);
  });

  /** 按会话选卡的人设提供者（卡由提供者按会话取，没有该卡时回落主卡），记下每次调用收到的参数 */
  function cards(primary: [string, string[]], bySession: Record<string, [string, string[]]>) {
    const calls: Array<PersonaSessionOptions | undefined> = [];
    const pick = (o?: PersonaSessionOptions) => (o?.sessionId && bySession[o.sessionId]) || primary;
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

  it('按会话取：消息的会话与入口平台交给在用的人设，由它按会话选卡；两个会话各用各的卡', () => {
    const { logger } = recordingLogger();
    const inBob = { sessionId: 'onebot:10000:group:1', platform: 'onebot' };
    const inMain = { sessionId: 'onebot:10000:group:2', platform: 'onebot' };
    const persona = cards(['Aalis', ['小A']], { [inBob.sessionId]: ['Bob', ['阿B']] });
    const names = createBotNames(personasRef(persona.svc), logger, '[t]');

    expect(names(['别名'], inBob)).toEqual(['别名', 'Bob', '阿B']);
    expect(names(['别名'], inMain)).toEqual(['别名', 'Aalis', '小A']);
    expect(persona.calls, '收到这条消息的会话选项').toEqual([inBob, inMain]);
  });
});

describe('isAddressed：戳一戳', () => {
  it('旁观互戳不算点名，即使正文中出现 bot 名或 @；戳 bot 才按开关判定', () => {
    const message = { ...poke('Aalis <at self>'), noticeTargetIsSelf: false };
    expect(isAddressed(message, ['Aalis'], opts())).toBe(false);
    expect(isAddressed({ ...message, noticeTargetIsSelf: true }, ['Aalis'], opts())).toBe(true);
    expect(isAddressed({ ...message, noticeTargetIsSelf: true }, ['Aalis'], opts({ triggerOnPoke: false }))).toBe(
      false,
    );
  });

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
    markTriggered(m, true, true);
    expect(m.triggerType).toBe('immediate');
    expect(m.actor).toBeUndefined();
  });

  it('非点名为 interval：多方窗口回填无主体授权，发言者字段不变', () => {
    const m = group();
    markTriggered(m, false, true);
    expect(m.triggerType).toBe('interval');
    expect(m.actor).toEqual({ platform: 'onebot', userId: '' });
    expect(m.userId).toBe('10001');
  });

  it('条件是调用方给的多方标记，不看类型名：一对一窗口的类型名不叫 private 也不回填，叫 group 的多方窗口照常回填', () => {
    const dm = group({ sessionType: 'dm', sessionId: 'zz:dm:10001', groupId: undefined });
    markTriggered(dm, false, false);
    expect(dm.triggerType).toBe('interval');
    expect(dm.actor).toBeUndefined();
    const channel = group({ sessionType: 'channel', sessionId: 'onebot:10000:channel:40001:50001' });
    markTriggered(channel, false, true);
    expect(channel.actor).toEqual({ platform: 'onebot', userId: '' });
  });

  it('消息已带 actor 时不覆盖', () => {
    const delegated = group({ actor: { platform: 'webui', userId: 'console' } });
    markTriggered(delegated, false, true);
    expect(delegated.actor).toEqual({ platform: 'webui', userId: 'console' });
  });
});

describe('archiveSwallowed', () => {
  const msg: IncomingMessage = { content: 'x', platform: 'onebot', sessionId: 'onebot:10000:group:20001' };

  it('message-archive 缺席时跳过；归档失败记 warn（前缀由调用方给），不抛错', async () => {
    const { logger, warns } = recordingLogger();
    await archiveSwallowed(msg, ref(), logger, '[laya]');
    const broken = fixedRef({
      archiveIncoming: async () => {
        throw new Error('库不可用');
      },
    } as never);
    await expect(archiveSwallowed(msg, broken, logger, '[laya]')).resolves.toBeUndefined();
    expect(warns).toEqual(['[laya] shadow 归档失败: Error: 库不可用']);
  });
});

describe('isActiveTrigger', () => {
  /** trigger 选中的那一家（条目 id）可以在两次判定之间换 */
  function triggerSelection(selected: string) {
    const state = { selected };
    const list = () => ref<TriggerService>([{ instance: { label: state.selected }, contextId: state.selected }]).list();
    return { state, ref: { list } };
  }

  it('胜者每次入站只取一次：取下之后换胜者，这次入站仍按取下的算', () => {
    const { state, ref: trigger } = triggerSelection('laya');
    const phase = {};
    expect(isActiveTrigger(phase, trigger, 'rule')).toBe(false);
    state.selected = 'rule'; // 判定途中切了偏好
    expect(isActiveTrigger(phase, trigger, 'rule'), '同一次入站不再换人').toBe(false);
    expect(isActiveTrigger(phase, trigger, 'laya')).toBe(true);
    // 下一次入站按新的胜者
    expect(isActiveTrigger({}, trigger, 'rule')).toBe(true);
  });

  it('没有胜者时谁都不判', () => {
    expect(isActiveTrigger({}, ref<TriggerService>(), 'rule')).toBe(false);
  });

  it('进程内装了两份 api-trigger：两个触发插件各用一份时，同一次入站仍只取一次胜者', async () => {
    vi.resetModules();
    const copyA = await import('../../packages/api-trigger/src/index.js');
    vi.resetModules();
    const copyB = await import('../../packages/api-trigger/src/index.js');
    expect(copyA.isActiveTrigger, '确是两份模块').not.toBe(copyB.isActiveTrigger);

    const { state, ref: trigger } = triggerSelection('rule');
    const phase = {};
    // 第三方插件用副本 B 先跑到，取下胜者（规则）；随后偏好切到第三方，规则插件用副本 A 判
    expect(copyB.isActiveTrigger(phase, trigger, 'other')).toBe(false);
    state.selected = 'other';
    expect(copyA.isActiveTrigger(phase, trigger, 'rule'), '各记各的表时这条消息谁都不判').toBe(true);
  });
});
