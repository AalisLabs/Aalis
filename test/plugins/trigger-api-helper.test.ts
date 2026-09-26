import { describe, expect, it } from 'vitest';
import type { PersonaService } from '../../packages/api-persona/src/index.js';
import {
  type AddressOptions,
  archiveSwallowed,
  hitsMuteKeyword,
  isActiveTrigger,
  isAddressed,
  markTriggered,
  type TriggerService,
  waitForAttachmentDescriptions,
} from '../../packages/api-trigger/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// @aalis/api-trigger 的共用宿主函数：两个触发插件（规则 trigger-policy、模型 trigger-laya）
// 的生效者判断、禁言关键词、点名识别、附件识别等待、放行收尾与吞掉归档都走这里。
// ════════════════════════════════════════════════════════════

/** 名字检测只读 persona 的当前提供者：给出 current 即可 */
const personaRef = (service?: PersonaService) => ({ current: service });
const NO_PERSONA = personaRef();
const opts = (extra: Partial<AddressOptions> = {}): AddressOptions => ({
  triggerOnAt: true,
  triggerOnPoke: true,
  triggerNames: [],
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
    expect(isAddressed(text('<at self>123</at> hi'), NO_PERSONA, opts())).toBe(true);
    expect(isAddressed(text('<at self qq="1">x</at>'), NO_PERSONA, opts())).toBe(true);
  });
  it('裸 CQ 码不命中（adapter 入站已规范化成 <at self>，CQ 码到不了这里）', () => {
    expect(isAddressed(text('[CQ:at,qq=12345] 你好'), NO_PERSONA, opts())).toBe(false);
  });
  it('@别人（<at> 无 self）不命中', () => {
    expect(isAddressed(text('<at id="999">路人</at> 你好'), NO_PERSONA, opts())).toBe(false);
  });
  it('普通文本 @nickname 不算 @ 提及（避免 @他人 误触发，名字检测另算）', () => {
    expect(isAddressed(text('hi @aalis 帮我'), NO_PERSONA, opts())).toBe(false);
  });
  it('triggerOnAt 关闭时不认 @', () => {
    expect(isAddressed(text('<at self id="1">bot</at> hi'), NO_PERSONA, opts({ triggerOnAt: false }))).toBe(false);
  });
});

describe('isAddressed：名字', () => {
  const persona: PersonaService = {
    getSystemPrompt: () => '',
    getPersonaName: () => 'Aalis',
    getNickNames: () => ['', '小A'],
  };

  it('别名、人设名字与昵称：正文包含即命中；空名字不命中', () => {
    expect(isAddressed(text('阿狸你好'), NO_PERSONA, opts({ triggerNames: ['阿狸'] }))).toBe(true);
    expect(isAddressed(text('随便聊聊'), NO_PERSONA, opts({ triggerNames: ['阿狸'] }))).toBe(false);
    expect(isAddressed(text('hello'), NO_PERSONA, opts({ triggerNames: [''] }))).toBe(false);
    expect(isAddressed(text('Aalis 在吗'), personaRef(persona), opts({ triggerOnAt: false }))).toBe(true);
    expect(isAddressed(text('小A 在吗'), personaRef(persona), opts())).toBe(true);
    expect(isAddressed(text('随便聊聊'), personaRef(persona), opts())).toBe(false);
  });

  it('persona 抛错时照抛，由调用方决定放行', () => {
    const broken: PersonaService = {
      getSystemPrompt: () => '',
      getPersonaName: () => {
        throw new Error('persona 故障');
      },
    };
    expect(() => isAddressed(text('随便聊聊'), personaRef(broken), opts())).toThrow('persona 故障');
  });
});

describe('isAddressed：戳一戳', () => {
  it('按 triggerOnPoke', () => {
    expect(isAddressed(poke(), NO_PERSONA, opts())).toBe(true);
    expect(isAddressed(poke(), NO_PERSONA, opts({ triggerOnPoke: false }))).toBe(false);
  });

  it('关闭后戳者昵称含 bot 名、正文含 @ 也不算点名（合成文案是元数据不是发言）', () => {
    const content = '[戳一戳: Aalis的小跟班(12345) 戳了你] <at self>x</at>';
    expect(isAddressed(poke(content), NO_PERSONA, opts({ triggerOnPoke: false, triggerNames: ['Aalis'] }))).toBe(false);
    // 对照：同样正文的普通消息命中
    expect(isAddressed(text(content), NO_PERSONA, opts({ triggerOnPoke: false, triggerNames: ['Aalis'] }))).toBe(true);
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
    await waitForAttachmentDescriptions(m, ref, 1000, recordingLogger().logger);
    expect(calls).toEqual([m]);
    expect(m._attachmentDescriptions).toEqual(['[图片: 一只猫]']);
  });

  it('没有 media、没有附件、已有描述：不启动识别，立即返回', async () => {
    const { ref, calls } = fakeMedia();
    const { logger } = recordingLogger();
    await waitForAttachmentDescriptions(image(), { current: undefined }, 1000, logger);
    await waitForAttachmentDescriptions(image({ attachments: [] }), ref, 1000, logger);
    await waitForAttachmentDescriptions(image({ _attachmentDescriptions: ['[图片: 早就有了]'] }), ref, 1000, logger);
    expect(calls).toHaveLength(0);
  });

  it('超过上限照常返回，识别在后台继续写到同一个消息对象上', async () => {
    const gate = deferred();
    const { ref } = fakeMedia(() => gate.promise);
    const m = image();
    await waitForAttachmentDescriptions(m, ref, 20, recordingLogger().logger);
    expect(m._attachmentDescriptions).toBeUndefined();
    gate.resolve();
    await sleep(5);
    expect(m._attachmentDescriptions).toEqual(['[图片: 一只猫]']);
  });

  it('识别失败：记 warn，不抛错', async () => {
    const { logger, warns } = recordingLogger();
    const failing = {
      current: {
        processMessage: async () => {
          throw new Error('识别模型不可用');
        },
      } as never,
    };
    await expect(waitForAttachmentDescriptions(image(), failing, 1000, logger)).resolves.toBeUndefined();
    expect(warns.some(w => w.includes('识别模型不可用'))).toBe(true);
  });
});

describe('archiveSwallowed', () => {
  const msg: IncomingMessage = { content: 'x', platform: 'onebot', sessionId: 'onebot:10000:group:20001' };

  it('message-archive 缺席时跳过；归档失败记 warn，不抛错', async () => {
    const { logger, warns } = recordingLogger();
    await archiveSwallowed(msg, { current: undefined }, logger);
    const broken = {
      current: {
        archiveIncoming: async () => {
          throw new Error('库不可用');
        },
      } as never,
    };
    await expect(archiveSwallowed(msg, broken, logger)).resolves.toBeUndefined();
    expect(warns.some(w => w.includes('库不可用'))).toBe(true);
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
