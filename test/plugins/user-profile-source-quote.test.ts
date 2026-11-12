import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { type ChatModelRequest, llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { type Message, WellKnownMetadataKeys } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 画像的增、改、删一律附本人原话，核对只认发言人自己写的话（存档另记的 SpokenContent，没记就是归档正文本身），片段要落在
// 他的某一条消息里：被引用的原文、附件描述（识图、语音转写、视频描述、文件正文）与合并转发的展开都在归档正文里，不在发言人
// 的话里，都不算。核对前两边同样规整（NFKC、小写，去掉标点、空白与不显示的字符，符号照留）；规整后不含字母或数字的引用
// （全是标点、符号或表情）按没给原话。提取模型用替身，回一份给定的 JSON
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:g1';
const PROFILE_NS = 'user:profile';

/** 一条提问：content 是归档正文，spoken 是存档另记的发言人的话（不给就不记） */
function asked(content: string, spoken?: string, userId = 'u1'): Message {
  const metadata: Record<string, unknown> = { userId, platform: 'onebot' };
  if (spoken !== undefined) metadata[WellKnownMetadataKeys.SpokenContent] = spoken;
  return { role: 'user', content, metadata };
}

/** 模型回一条 add，原话是 sourceQuote */
const adds = (text: string, sourceQuote: string) => ({
  add: [{ text, category: '兴趣爱好', temporality: 'permanent', sourceQuote }],
  update: [],
  remove: [],
});
const removes = (remove: unknown[]) => ({ add: [], update: [], remove });
const NOT_HIS = '片段不在目标用户 u1 发言中';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 预置 history 与 u1 的档案（facts 给了才写），跑一轮 u1 的提取；返回替身收到的请求、warn 与读事实的方法 */
async function extract(history: Message[], reply: unknown, facts?: Array<{ id: string; text: string }>) {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, memory });
  const requests: ChatModelRequest[] = [];
  const chat = vi.fn(async (request: ChatModelRequest) => {
    requests.push(request);
    return { content: JSON.stringify(reply), finishReason: 'stop' as const };
  });
  host.provide.use(llm, { id: 'stub-model', capabilities: ['chat'], chat } as never);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  await app.plugin(userProfile, { extractEveryNMessages: 1, relationIncrementWitness: 0 });
  await app.plugins.idle();
  for (const message of history) await host.memory.use.saveMessage(SESSION, message);
  if (facts) {
    await host.memory.use.saveMetadata(PROFILE_NS, 'onebot:u1', {
      facts: facts.map(f => ({ ...f, temporality: 'permanent', observedAt: 1, updatedAt: 1 })),
      updatedAt: 1,
    });
  }
  await host.events.use.emit('inbound:message:archived', {
    sessionId: SESSION,
    incoming: { userId: 'u1', platform: 'onebot' },
  } as never);
  return {
    requests,
    chat,
    warns,
    facts: async () => {
      const profile = await host.memory.use.getMetadata(PROFILE_NS, 'onebot:u1');
      return ((profile?.facts as Array<{ text: string }> | undefined) ?? []).map(f => f.text);
    },
  };
}

/** 等这一轮提取执行完毕：调够次数之后再让写入落完 */
async function settle(chat: ReturnType<typeof vi.fn>, calls: number): Promise<void> {
  await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(calls));
  await new Promise(resolve => setTimeout(resolve, 50));
}

describe('plugin-user-profile: 原话只认发言人自己写的话', () => {
  it('引用的原文不算', async () => {
    const run = await extract(
      [asked('[甲(u1)]: 是的\n[引用 乙(u2) 的消息: 我喜欢猫]', '是的')],
      adds('喜欢猫', '我喜欢猫'),
    );
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual([]);
    expect(run.warns.some(w => w.includes(NOT_HIS))).toBe(true);
  });

  it('附件描述不算：识图、语音转写、视频描述与文件正文同一条路', async () => {
    const run = await extract(
      [asked('[甲(u1)]: 看\n[图片: 截图上写着我是程序员 | ref:data:/images/x.png]', '看')],
      adds('是程序员', '我是程序员'),
    );
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual([]);
    expect(run.warns.some(w => w.includes(NOT_HIS))).toBe(true);
  });

  it('合并转发的展开不算：发言人的话里只有它的占位', async () => {
    const run = await extract(
      [
        asked(
          '[甲(u1)]: <forward id="F1" count=1 participants="乙(u2)">\n1. 乙(u2): 我住在上海\n</forward>',
          '<forward id="F1">[合并转发消息]</forward>',
        ),
      ],
      adds('住在上海', '我住在上海'),
    );
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual([]);
    expect(run.warns.some(w => w.includes(NOT_HIS))).toBe(true);
  });

  it('只发了图（发言人的话是空串）：附件描述里的字不算', async () => {
    const run = await extract(
      [asked('[甲(u1)]: \n[图片: 一张纸，写着我养了一只猫 | ref:data:/images/y.png]', '')],
      adds('养了一只猫', '我养了一只猫'),
    );
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual([]);
    expect(run.warns.some(w => w.includes(NOT_HIS))).toBe(true);
  });

  it('没记 SpokenContent 的就是归档正文本身，照收', async () => {
    const run = await extract([asked('我喜欢猫')], adds('喜欢猫', '我喜欢猫'));
    await vi.waitFor(async () => expect(await run.facts()).toEqual(['喜欢猫']));
  });

  it('片段要落在同一条消息里：两条首尾接起来才对得上的不算', async () => {
    const run = await extract(
      [asked('[甲(u1)]: 他说我', '他说我'), asked('[甲(u1)]: 喜欢猫是假的', '喜欢猫是假的')],
      adds('喜欢猫', '我喜欢猫'),
    );
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual([]);
    expect(run.warns.some(w => w.includes(NOT_HIS))).toBe(true);
  });

  it('改写事实的原话同样只认他自己写的：只在引用里的不改', async () => {
    const run = await extract(
      [asked('[甲(u1)]: 是的\n[引用 乙(u2) 的消息: 我现在喜欢狗]', '是的')],
      {
        add: [],
        update: [
          { id: 'f1', text: '喜欢狗', category: '兴趣爱好', temporality: 'permanent', sourceQuote: '我现在喜欢狗' },
        ],
        remove: [],
      },
      [{ id: 'f1', text: '喜欢猫' }],
    );
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual(['喜欢猫']);
    expect(run.warns.some(w => w.includes(NOT_HIS))).toBe(true);
  });

  it('标点那一行不算片段，别的行照常核对：「...」接一行他说过的话照收', async () => {
    const run = await extract([asked('[甲(u1)]: 我喜欢猫', '我喜欢猫')], adds('喜欢猫', '...\n我喜欢猫'));
    await vi.waitFor(async () => expect(await run.facts()).toEqual(['喜欢猫']));
  });

  it('符号照留：「C++」对不上只有「cat」的话', async () => {
    const run = await extract([asked('[甲(u1)]: 我在看cat的视频', '我在看cat的视频')], adds('会写 C++', 'C++'));
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual([]);
    expect(run.warns.some(w => w.includes(NOT_HIS))).toBe(true);
  });

  it('全角与半角按同一个字核对：他写「价格１００」，原话写成「价格100」照收', async () => {
    const run = await extract([asked('[甲(u1)]: 价格１００', '价格１００')], adds('在问价格', '价格100'));
    await vi.waitFor(async () => expect(await run.facts()).toEqual(['在问价格']));
  });

  it('大小写按同一个字核对：他写「I like Cats」，原话写成「i like cats」照收', async () => {
    const run = await extract([asked('[甲(u1)]: I like Cats', 'I like Cats')], adds('喜欢猫', 'i like cats'));
    await vi.waitFor(async () => expect(await run.facts()).toEqual(['喜欢猫']));
  });

  it('不显示的字符不算：他写不带变体选择符的「我爱你❤」，原话写成「我爱你❤️」照收', async () => {
    const run = await extract([asked('[甲(u1)]: 我爱你❤', '我爱你❤')], adds('说过我爱你', '我爱你❤️'));
    await vi.waitFor(async () => expect(await run.facts()).toEqual(['说过我爱你']));
  });

  it.each(['...', '……'])('全是标点的引用「%s」按没给原话丢弃', async quote => {
    const run = await extract([asked('[甲(u1)]: 好吧……', '好吧……')], adds('认可这个安排', quote));
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual([]);
    expect(run.warns.some(w => w.includes('未提供 sourceQuote'))).toBe(true);
  });

  it.each(['👍', '❤️', '#️⃣'])('只有表情的引用「%s」按没给原话丢弃', async quote => {
    const run = await extract([asked('[甲(u1)]: 好的👍❤️#️⃣', '好的👍❤️#️⃣')], adds('认可这个安排', quote));
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual([]);
    expect(run.warns.some(w => w.includes('未提供 sourceQuote'))).toBe(true);
  });
});

describe('plugin-user-profile: 删除事实也要附本人原话', () => {
  const LIKES_CATS = [{ id: 'f1', text: '喜欢猫' }];

  it('只给 id 的旧写法按没给原话：事实还在，记 warn', async () => {
    const run = await extract([asked('[甲(u1)]: 我早就不喜欢猫了', '我早就不喜欢猫了')], removes(['f1']), LIKES_CATS);
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual(['喜欢猫']);
    expect(run.warns.some(w => w.includes('丢弃 remove fact（未提供 sourceQuote）: id=f1'))).toBe(true);
  });

  it('附了他自己写的原话：删掉', async () => {
    const run = await extract(
      [asked('[甲(u1)]: 我早就不喜欢猫了', '我早就不喜欢猫了')],
      removes([{ id: 'f1', sourceQuote: '我早就不喜欢猫了' }]),
      LIKES_CATS,
    );
    await vi.waitFor(async () => expect(await run.facts()).toEqual([]));
  });

  it('原话只在别人的发言里：别人一句话删不了他的事实', async () => {
    const run = await extract(
      [asked('[甲(u1)]: 嗯', '嗯'), asked('[乙(u2)]: 他不喜欢猫了', '他不喜欢猫了', 'u2')],
      removes([{ id: 'f1', sourceQuote: '他不喜欢猫了' }]),
      LIKES_CATS,
    );
    await settle(run.chat, 1);
    expect(await run.facts()).toEqual(['喜欢猫']);
  });
});

describe('plugin-user-profile: 提取提示', () => {
  it('删除也要原话、原话只算 ta 自己写的字，remove 的格式示例带 sourceQuote', async () => {
    const run = await extract([asked('我喜欢猫')], removes([]));
    await settle(run.chat, 1);
    const system = String(run.requests[0].messages[0].content);
    expect(system).toContain(
      '\n- remove: 用 id 删除已被目标用户推翻的事实，同样需 sourceQuote（目标用户推翻它的那句原话）\n',
    );
    expect(system).toContain(
      '只算 ta 自己写的字：行首的发送者前缀、行里附带的「[引用 … 的消息: …]」、图片与语音视频的描述、文件内容、合并转发都不算\n',
    );
    expect(system).toContain('"remove": [{"id": "已知事实的id", "sourceQuote": "目标用户发言中的原话片段"}]');
    expect(system).not.toContain('不需 sourceQuote');
  });
});
