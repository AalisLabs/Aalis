import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptContributionView } from '../../packages/api-agent/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { App, definePlugin, logger } from '../../packages/core/src/index.js';
import {
  assemblePromptContributions,
  type PromptAssemblyCaps,
} from '../../packages/plugin-agent/src/prompt-assembly.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// 测试从源码路径导入，api-agent 对 '@aalis/api-contributions' 的 declaration
// merging 不在此路径生效——vitest 不做类型检查，用 never 断言绕过键约束。
const POINT = 'agent:prompt' as never;

/** 装起来的 App 在用例末尾统一停掉，定时器与监听器不泄漏到别的用例。 */
const booted: App[] = [];

afterEach(async () => {
  for (const app of booted.splice(0)) await app.stop();
});

interface Harness {
  /**
   * 组装器只要「收集贡献」与「记日志」两样能力——贡献仍由真实激活登记（全局键带实例 id 前缀，
   * 断言要比对它），故收集面直接转发给根激活。
   */
  caps: PromptAssemblyCaps;
  /**
   * 以 `pluginName` 的身份登记一条贡献：全局键是 `<插件名>/<spec.id>`，锚位与槽内排序
   * 的断言比对的就是它。
   */
  contribute(pluginName: string, contribution: unknown): Promise<void>;
}

async function boot(): Promise<Harness> {
  const app = new App({ name: 'T', logLevel: 'error' });
  booted.push(app);
  await registerHubs(app);
  const host = app.bind({ contributions, logger });
  return {
    caps: { contributions: { collect: point => host.contributions.collect(point) }, logger: host.logger },
    async contribute(pluginName, contribution) {
      await app.plugin(
        definePlugin({
          name: pluginName,
          uses: { contributions },
          apply(caps) {
            caps.contributions.contribute(POINT, contribution as never);
          },
        }),
      );
      await app.plugins.idle();
      // 停在 pending 的探针一条贡献都没登记，组装断言会退化成「什么都没发生」的假绿
      expect(app.plugins.getPlugin(pluginName)?.state, `${pluginName} 未激活`).toBe('active');
    },
  };
}

function baseMessages(): Message[] {
  return [
    { role: 'system', content: 'persona', metadata: { injector: 'persona' } },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
  ];
}

function spec(id: string, anchor: string, out: unknown): never {
  return { id, anchor, build: () => out } as never;
}

describe('assemblePromptContributions', () => {
  it('五锚位落点正确，注册顺序无关（逐字节确定）', async () => {
    const layouts: string[][] = [];
    for (const reversed of [false, true]) {
      const h = await boot();
      const regs: Array<[string, string, string, string]> = [
        ['p-identity', 'idn', 'identity', 'IDN'],
        ['p-knowledge', 'kn', 'knowledge', 'KN'],
        ['p-context', 'cx', 'context', 'CX'],
        ['p-tctx', 'tc', 'turn-context', 'TC'],
        ['p-turn', 'th', 'turn-hint', 'TH'],
      ];
      for (const [pluginName, id, anchor, out] of reversed ? [...regs].reverse() : regs) {
        await h.contribute(pluginName, spec(id, anchor, out));
      }
      const messages = baseMessages();
      await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
      layouts.push(messages.map(m => String(m.content)));
    }
    // persona → identity → knowledge → context → 历史 →（最后一条 user 前）
    // turn-context → turn-hint（hint 贴 user 最近，靠 ANCHOR_ORDER 串行 splice 保证）
    expect(layouts[0]).toEqual(['persona', 'IDN', 'KN', 'CX', 'u1', 'a1', 'TC', 'TH', 'u2']);
    expect(layouts[1]).toEqual(layouts[0]);
  });

  it('turn-context 三级落点：委派块前 > 易变块前 > 最后 user 前 > 落尾', async () => {
    // proactive 委派轮：历史里有旧 user 消息、没有当前 user 消息。
    // 若按「最后一条 user」定位，材料会 splice 进历史内部——既割裂转录，
    // 又在 append-only 区制造新的缓存断点（对抗审查实测抓到的回归）。
    {
      const h = await boot();
      await h.contribute('p-tctx', spec('tc', 'turn-context', 'TC'));
      const messages: Message[] = [
        { role: 'system', content: 'persona' },
        { role: 'user', content: 'hist-u1' },
        { role: 'assistant', content: 'hist-a1' },
        { role: 'user', content: 'hist-u2' },
        { role: 'system', content: '[跨会话委派] 任务', metadata: { injector: 'cross-session-delegation' } },
      ];
      await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
      expect(messages.map(m => String(m.content))).toEqual([
        'persona',
        'hist-u1',
        'hist-a1',
        'hist-u2', // 历史完整，材料没有插进转录中间
        'TC',
        '[跨会话委派] 任务',
      ]);
    }
    // 普通轮有易变块：材料落其前——历史/当前轮的分界线，focus 与 turn-hint
    // 保持与改动前相同的先行语邻接，不被整批材料隔断
    {
      const h = await boot();
      await h.contribute('p-tctx', spec('tc', 'turn-context', 'TC'));
      await h.contribute('p-turn', spec('th', 'turn-hint', 'TH'));
      const messages: Message[] = [
        { role: 'system', content: 'persona' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'system', content: '当前时间…', metadata: { injector: 'persona-volatile' } },
        { role: 'system', content: '【当前焦点】', metadata: { injector: 'focus-guidance' } },
        { role: 'user', content: 'u2' },
      ];
      await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
      expect(messages.map(m => String(m.content))).toEqual([
        'persona',
        'u1',
        'a1',
        'TC',
        '当前时间…',
        '【当前焦点】',
        'TH',
        'u2',
      ]);
    }
    // 全列表无 user（空历史特殊形状）：落尾，材料仍可用
    {
      const h = await boot();
      await h.contribute('p-tctx', spec('tc', 'turn-context', 'TC'));
      const messages: Message[] = [{ role: 'system', content: 'persona' }];
      await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
      expect(messages.map(m => String(m.content))).toEqual(['persona', 'TC']);
    }
  });

  it('前缀稳定性：turn-context 内容每轮变，历史结尾之前的序列逐字节不变（缓存命中的守卫）', async () => {
    // 这条测试守的是新锚位存在的全部理由：per-turn 材料放历史后，相邻两轮
    // 请求在「历史最后一条」之前的序列必须完全一致——provider 前缀缓存从
    // 第 0 个 token 逐位比对，此性质破坏即退回 12.7% 命中率。
    //
    // 断言锚在**历史尾（'assistant a1'）**而非材料自身：首版锚在材料位置，
    // 材料错标回 context（正是要防的回归）时截断点跟着前移，比较范围缩到
    // 头部稳定块、断言恒真——对抗审查实测证伪，据此重写。
    const build = async (turnMaterial: string, extraHistory: Message[]): Promise<Message[]> => {
      const h = await boot();
      await h.contribute('p-knowledge', spec('kn', 'knowledge', 'KN-技能清单'));
      await h.contribute('p-context', spec('cx', 'context', 'CX-会话摘要'));
      await h.contribute('p-tctx', spec('tc', 'turn-context', turnMaterial));
      const messages: Message[] = [
        { role: 'system', content: 'persona' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        ...extraHistory,
        { role: 'user', content: '当前消息' },
      ];
      await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
      return messages;
    };

    // 第 N 轮与第 N+1 轮：历史 append 了一对消息，turn 材料完全不同
    const turnA = await build('检索片段：关于出游的记忆', []);
    const turnB = await build('检索片段：关于记账的记忆', [
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]);

    const serialize = (ms: Message[]) => ms.map(m => `${m.role} ${String(m.content)}`);
    const a = serialize(turnA);
    const b = serialize(turnB);

    // 判别力的来源：材料必须在历史尾之后（错标回 context 时这条直接翻红）
    const histEndA = a.indexOf('assistant a1');
    expect(a.indexOf('system 检索片段：关于出游的记忆')).toBeGreaterThan(histEndA);

    // 截断点锚在历史尾：第 N 轮到历史尾为止的序列必须是第 N+1 轮的严格前缀
    const cut = histEndA + 1;
    expect(cut).toBeGreaterThan(1);
    expect(b.slice(0, cut)).toEqual(a.slice(0, cut));
  });

  it('幂等：重复组装不重复物化；中途新增贡献增量落位', async () => {
    const h = await boot();
    await h.contribute('p-a', spec('cx', 'context', 'CX'));
    const messages = baseMessages();
    await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
    await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
    expect(messages.filter(m => String(m.content) === 'CX')).toHaveLength(1);

    // 回合中途注册新贡献（如 load_skill 激活新技能）→ 下一轮增量物化
    await h.contribute('p-b', spec('kn', 'knowledge', 'KN'));
    await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
    expect(messages.filter(m => String(m.content) === 'KN')).toHaveLength(1);
    const knIdx = messages.findIndex(m => String(m.content) === 'KN');
    const firstUserIdx = messages.findIndex(m => m.role === 'user');
    expect(knIdx).toBeGreaterThan(0);
    expect(knIdx).toBeLessThan(firstUserIdx); // 仍落在头部 system 区
  });

  it('错误隔离：单个 build 抛错仅自身缺席', async () => {
    const h = await boot();
    await h.contribute('p-bad', {
      id: 'bad',
      anchor: 'context',
      build: () => {
        throw new Error('boom');
      },
    });
    await h.contribute('p-good', spec('good', 'context', 'OK'));
    const messages = baseMessages();
    await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
    expect(messages.some(m => String(m.content) === 'OK')).toBe(true);
    expect(messages.some(m => String(m.metadata?.injector ?? '').endsWith('/bad'))).toBe(false);
  });

  it('多块返回：保序、共用同一全局键；null 与空串跳过', async () => {
    const h = await boot();
    await h.contribute('p-multi', spec('m', 'identity', ['B1', '', 'B2']));
    await h.contribute('p-null', spec('n', 'identity', null));
    const messages = baseMessages();
    await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
    const contents = messages.map(m => String(m.content));
    expect(contents.indexOf('B1')).toBe(1);
    expect(contents.indexOf('B2')).toBe(2);
    expect(messages[1].metadata?.injector).toBe(messages[2].metadata?.injector);
    expect(messages.some(m => String(m.metadata?.injector ?? '').endsWith('/n'))).toBe(false);
  });

  it('dryRun 透传给 view；无 user 消息时 turn-hint 弃置', async () => {
    const h = await boot();
    const seen: boolean[] = [];
    await h.contribute('p-a', {
      id: 'probe',
      anchor: 'context',
      build: (view: { dryRun: boolean }) => {
        seen.push(view.dryRun);
        return null;
      },
    });
    await h.contribute('p-b', spec('th', 'turn-hint', 'TH'));
    const messages: Message[] = [{ role: 'system', content: 'persona' }];
    await assemblePromptContributions(h.caps, { messages, dryRun: true });
    expect(seen).toEqual([true]);
    expect(messages).toHaveLength(1); // turn-hint 无落点被弃置
  });
});

describe('组装器护栏：非法锚位与 build 超时', () => {
  it('未知 anchor：产物丢弃并 warn 点名，其余贡献照常物化', async () => {
    const h = await boot();
    const warns: string[] = [];
    vi.spyOn(h.caps.logger, 'warn').mockImplementation((msg: unknown) => {
      warns.push(String(msg));
    });
    await h.contribute('p-bad', spec('b', 'bogus-anchor', 'BAD'));
    await h.contribute('p-ok', spec('ok', 'context', 'OK'));
    const messages = baseMessages();
    await assemblePromptContributions(h.caps, { messages, sessionId: 's' });
    expect(messages.some(m => String(m.content) === 'OK')).toBe(true);
    expect(messages.some(m => String(m.content) === 'BAD')).toBe(false);
    expect(warns.some(w => w.includes('bogus-anchor') && w.includes('不是合法锚位'))).toBe(true);
  });

  it('build 超时：该贡献本轮缺席并 warn，其余照常；键未物化下一轮重试', async () => {
    const h = await boot();
    const warns: string[] = [];
    vi.spyOn(h.caps.logger, 'warn').mockImplementation((msg: unknown) => {
      warns.push(String(msg));
    });
    let stuck = true;
    await h.contribute('p-slow', {
      id: 'slow',
      anchor: 'context',
      build: () => (stuck ? new Promise<string>(() => {}) : 'SLOW-DONE'),
    });
    await h.contribute('p-fast', spec('fast', 'context', 'FAST'));

    const messages = baseMessages();
    await assemblePromptContributions(h.caps, { messages, sessionId: 's' }, { buildTimeoutMs: 30 });
    expect(messages.some(m => String(m.content) === 'FAST')).toBe(true);
    expect(messages.some(m => String(m.content) === 'SLOW-DONE')).toBe(false);
    expect(warns.some(w => w.includes('/slow') && w.includes('超过 30ms'))).toBe(true);

    // 键未物化 → 下一轮恢复后补上
    stuck = false;
    await assemblePromptContributions(h.caps, { messages, sessionId: 's' }, { buildTimeoutMs: 30 });
    expect(messages.filter(m => String(m.content) === 'SLOW-DONE')).toHaveLength(1);
    expect(messages.filter(m => String(m.content) === 'FAST')).toHaveLength(1); // 已物化不重复
  });

  it('build 超时会中止该贡献，且不影响同轮兄弟贡献', async () => {
    const h = await boot();
    let aborted = false;
    await h.contribute('p-slow', {
      id: 'slow',
      anchor: 'context',
      build: (view: PromptContributionView) =>
        new Promise<string>((_resolve, reject) => {
          view.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(view.signal?.reason);
            },
            { once: true },
          );
        }),
    });
    await h.contribute('p-fast', spec('fast', 'context', 'FAST'));

    const messages = baseMessages();
    await assemblePromptContributions(h.caps, { messages, sessionId: 's' }, { buildTimeoutMs: 30 });

    expect(aborted, '超时不能只放弃等待，必须通知底层构建取消').toBe(true);
    expect(messages.some(m => String(m.content) === 'FAST')).toBe(true);
    expect(messages.some(m => String(m.metadata?.injector ?? '').endsWith('/slow'))).toBe(false);
  });

  it('父 signal 已中止时不执行 build', async () => {
    const h = await boot();
    const parent = new AbortController();
    parent.abort();
    let calls = 0;
    await h.contribute('p-probe', {
      id: 'probe',
      anchor: 'context',
      build: () => {
        calls++;
        return 'SHOULD-NOT-BUILD';
      },
    });

    await expect(
      assemblePromptContributions(h.caps, { messages: baseMessages(), sessionId: 's' }, { signal: parent.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });

  it('父 signal 会中止无限等待的 build 并让组装立即失败', async () => {
    const h = await boot();
    const parent = new AbortController();
    let observedAbort = false;
    await h.contribute('p-stuck', {
      id: 'stuck',
      anchor: 'context',
      build: (view: PromptContributionView) =>
        new Promise<string>((_resolve, reject) => {
          view.signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(view.signal?.reason);
            },
            { once: true },
          );
        }),
    });

    const timer = setTimeout(() => parent.abort(), 30);
    try {
      await expect(
        assemblePromptContributions(h.caps, { messages: baseMessages(), sessionId: 's' }, { signal: parent.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(timer);
    }
    expect(observedAbort).toBe(true);
  }, 1_000);

  it('buildTimeoutMs 缺省/0 不设限（慢而有终的 build 正常完成）', async () => {
    const h = await boot();
    await h.contribute('p-a', {
      id: 'slowok',
      anchor: 'context',
      build: () => new Promise<string>(r => setTimeout(() => r('DONE'), 40)),
    });
    const messages = baseMessages();
    await assemblePromptContributions(h.caps, { messages, sessionId: 's' }, { buildTimeoutMs: 0 });
    expect(messages.some(m => String(m.content) === 'DONE')).toBe(true);
  });
});
