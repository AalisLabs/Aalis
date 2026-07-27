import { describe, expect, it } from 'vitest';
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
import type { Message } from '../../packages/plugin-message-api/src/index.js';

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
  it('四锚位落点正确，注册顺序无关（逐字节确定）', async () => {
    const layouts: string[][] = [];
    for (const reversed of [false, true]) {
      const root = makeRoot();
      const regs: Array<[string, string, string, string]> = [
        ['p-identity', 'idn', 'identity', 'IDN'],
        ['p-knowledge', 'kn', 'knowledge', 'KN'],
        ['p-context', 'cx', 'context', 'CX'],
        ['p-turn', 'th', 'turn-hint', 'TH'],
      ];
      for (const [ctxId, id, anchor, out] of reversed ? [...regs].reverse() : regs) {
        root.fork(ctxId).contribute(POINT, spec(id, anchor, out));
      }
      const messages = baseMessages();
      await assemblePromptContributions(root, { messages, sessionId: 's' });
      layouts.push(messages.map(m => String(m.content)));
    }
    // persona → identity → knowledge → context → 历史 →（最后一条 user 前）turn-hint
    expect(layouts[0]).toEqual(['persona', 'IDN', 'KN', 'CX', 'u1', 'a1', 'TH', 'u2']);
    expect(layouts[1]).toEqual(layouts[0]);
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
