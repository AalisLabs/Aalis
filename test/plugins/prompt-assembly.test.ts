import { describe, expect, it, vi } from 'vitest';
import {
  ConfigManager,
  Context,
  ContributionRegistry,
  DefaultLogger,
  EventBus,
  HookRegistry,
  ServiceContainer,
} from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import type { Message } from '../../packages/schema-message/src/index.js';

// 测试直接从 core 源码路径导入，agent-api 对 '@aalis/core' 的 declaration
// merging 不在此路径生效——vitest 不做类型检查，用 never 断言绕过键约束。
const POINT = 'agent:prompt' as never;

function makeRoot(): Context {
  return new Context({
    id: 'root',
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger: new DefaultLogger('test'),
    config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
  });
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
      const root = makeRoot();
      const regs: Array<[string, string, string, string]> = [
        ['p-identity', 'idn', 'identity', 'IDN'],
        ['p-knowledge', 'kn', 'knowledge', 'KN'],
        ['p-context', 'cx', 'context', 'CX'],
        ['p-tctx', 'tc', 'turn-context', 'TC'],
        ['p-turn', 'th', 'turn-hint', 'TH'],
      ];
      for (const [ctxId, id, anchor, out] of reversed ? [...regs].reverse() : regs) {
        root.fork(ctxId).contribute(POINT, spec(id, anchor, out));
      }
      const messages = baseMessages();
      await assemblePromptContributions(root, { messages, sessionId: 's' });
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
      const root = makeRoot();
      root.fork('p-tctx').contribute(POINT, spec('tc', 'turn-context', 'TC'));
      const messages: Message[] = [
        { role: 'system', content: 'persona' },
        { role: 'user', content: 'hist-u1' },
        { role: 'assistant', content: 'hist-a1' },
        { role: 'user', content: 'hist-u2' },
        { role: 'system', content: '[跨会话委派] 任务', metadata: { injector: 'cross-session-delegation' } },
      ];
      await assemblePromptContributions(root, { messages, sessionId: 's' });
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
      const root = makeRoot();
      root.fork('p-tctx').contribute(POINT, spec('tc', 'turn-context', 'TC'));
      root.fork('p-turn').contribute(POINT, spec('th', 'turn-hint', 'TH'));
      const messages: Message[] = [
        { role: 'system', content: 'persona' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'system', content: '当前时间…', metadata: { injector: 'persona-volatile' } },
        { role: 'system', content: '【当前焦点】', metadata: { injector: 'focus-guidance' } },
        { role: 'user', content: 'u2' },
      ];
      await assemblePromptContributions(root, { messages, sessionId: 's' });
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
      const root = makeRoot();
      root.fork('p-tctx').contribute(POINT, spec('tc', 'turn-context', 'TC'));
      const messages: Message[] = [{ role: 'system', content: 'persona' }];
      await assemblePromptContributions(root, { messages, sessionId: 's' });
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
    const build = (turnMaterial: string, extraHistory: Message[]) => {
      const root = makeRoot();
      root.fork('p-knowledge').contribute(POINT, spec('kn', 'knowledge', 'KN-技能清单'));
      root.fork('p-context').contribute(POINT, spec('cx', 'context', 'CX-会话摘要'));
      root.fork('p-tctx').contribute(POINT, spec('tc', 'turn-context', turnMaterial));
      const messages: Message[] = [
        { role: 'system', content: 'persona' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        ...extraHistory,
        { role: 'user', content: '当前消息' },
      ];
      return assemblePromptContributions(root, { messages, sessionId: 's' }).then(() => messages);
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
    const root = makeRoot();
    root.fork('p-a').contribute(POINT, spec('cx', 'context', 'CX'));
    const messages = baseMessages();
    await assemblePromptContributions(root, { messages, sessionId: 's' });
    await assemblePromptContributions(root, { messages, sessionId: 's' });
    expect(messages.filter(m => String(m.content) === 'CX')).toHaveLength(1);

    // 回合中途注册新贡献（如 load_skill 激活新技能）→ 下一轮增量物化
    root.fork('p-b').contribute(POINT, spec('kn', 'knowledge', 'KN'));
    await assemblePromptContributions(root, { messages, sessionId: 's' });
    expect(messages.filter(m => String(m.content) === 'KN')).toHaveLength(1);
    const knIdx = messages.findIndex(m => String(m.content) === 'KN');
    const firstUserIdx = messages.findIndex(m => m.role === 'user');
    expect(knIdx).toBeGreaterThan(0);
    expect(knIdx).toBeLessThan(firstUserIdx); // 仍落在头部 system 区
  });

  it('错误隔离：单个 build 抛错仅自身缺席', async () => {
    const root = makeRoot();
    root.fork('p-bad').contribute(POINT, {
      id: 'bad',
      anchor: 'context',
      build: () => {
        throw new Error('boom');
      },
    } as never);
    root.fork('p-good').contribute(POINT, spec('good', 'context', 'OK'));
    const messages = baseMessages();
    await assemblePromptContributions(root, { messages, sessionId: 's' });
    expect(messages.some(m => String(m.content) === 'OK')).toBe(true);
    expect(messages.some(m => String(m.metadata?.injector ?? '').endsWith('/bad'))).toBe(false);
  });

  it('多块返回：保序、共用同一全局键；null 与空串跳过', async () => {
    const root = makeRoot();
    root.fork('p-multi').contribute(POINT, spec('m', 'identity', ['B1', '', 'B2']));
    root.fork('p-null').contribute(POINT, spec('n', 'identity', null));
    const messages = baseMessages();
    await assemblePromptContributions(root, { messages, sessionId: 's' });
    const contents = messages.map(m => String(m.content));
    expect(contents.indexOf('B1')).toBe(1);
    expect(contents.indexOf('B2')).toBe(2);
    expect(messages[1].metadata?.injector).toBe(messages[2].metadata?.injector);
    expect(messages.some(m => String(m.metadata?.injector ?? '').endsWith('/n'))).toBe(false);
  });

  it('dryRun 透传给 view；无 user 消息时 turn-hint 弃置', async () => {
    const root = makeRoot();
    const seen: boolean[] = [];
    root.fork('p-a').contribute(POINT, {
      id: 'probe',
      anchor: 'context',
      build: (view: { dryRun: boolean }) => {
        seen.push(view.dryRun);
        return null;
      },
    } as never);
    root.fork('p-b').contribute(POINT, spec('th', 'turn-hint', 'TH'));
    const messages: Message[] = [{ role: 'system', content: 'persona' }];
    await assemblePromptContributions(root, { messages, dryRun: true });
    expect(seen).toEqual([true]);
    expect(messages).toHaveLength(1); // turn-hint 无落点被弃置
  });
});

describe('组装器护栏：非法锚位与 build 超时', () => {
  it('未知 anchor：产物丢弃并 warn 点名，其余贡献照常物化', async () => {
    const root = makeRoot();
    const warns: string[] = [];
    vi.spyOn(root.logger, 'warn').mockImplementation((msg: unknown) => {
      warns.push(String(msg));
    });
    root.fork('p-bad').contribute(POINT, spec('b', 'bogus-anchor', 'BAD'));
    root.fork('p-ok').contribute(POINT, spec('ok', 'context', 'OK'));
    const messages = baseMessages();
    await assemblePromptContributions(root, { messages, sessionId: 's' });
    expect(messages.some(m => String(m.content) === 'OK')).toBe(true);
    expect(messages.some(m => String(m.content) === 'BAD')).toBe(false);
    expect(warns.some(w => w.includes('bogus-anchor') && w.includes('不是合法锚位'))).toBe(true);
  });

  it('build 超时：该贡献本轮缺席并 warn，其余照常；键未物化下一轮重试', async () => {
    const root = makeRoot();
    const warns: string[] = [];
    vi.spyOn(root.logger, 'warn').mockImplementation((msg: unknown) => {
      warns.push(String(msg));
    });
    let stuck = true;
    root.fork('p-slow').contribute(POINT, {
      id: 'slow',
      anchor: 'context',
      build: () => (stuck ? new Promise<string>(() => {}) : 'SLOW-DONE'),
    } as never);
    root.fork('p-fast').contribute(POINT, spec('fast', 'context', 'FAST'));

    const messages = baseMessages();
    await assemblePromptContributions(root, { messages, sessionId: 's' }, { buildTimeoutMs: 30 });
    expect(messages.some(m => String(m.content) === 'FAST')).toBe(true);
    expect(messages.some(m => String(m.content) === 'SLOW-DONE')).toBe(false);
    expect(warns.some(w => w.includes('/slow') && w.includes('超过 30ms'))).toBe(true);

    // 键未物化 → 下一轮恢复后补上
    stuck = false;
    await assemblePromptContributions(root, { messages, sessionId: 's' }, { buildTimeoutMs: 30 });
    expect(messages.filter(m => String(m.content) === 'SLOW-DONE')).toHaveLength(1);
    expect(messages.filter(m => String(m.content) === 'FAST')).toHaveLength(1); // 已物化不重复
  });

  it('buildTimeoutMs 缺省/0 不设限（慢而有终的 build 正常完成）', async () => {
    const root = makeRoot();
    root.fork('p-a').contribute(POINT, {
      id: 'slowok',
      anchor: 'context',
      build: () => new Promise<string>(r => setTimeout(() => r('DONE'), 40)),
    } as never);
    const messages = baseMessages();
    await assemblePromptContributions(root, { messages, sessionId: 's' }, { buildTimeoutMs: 0 });
    expect(messages.some(m => String(m.content) === 'DONE')).toBe(true);
  });
});
