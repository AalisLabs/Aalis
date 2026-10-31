import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { App, type BoundOf } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 角色卡的 outputFormatRetries 必须真的传到重试闸：asCard 曾漏抄这个键，
// 于是卡里写多少都被解析处当"未设"→ 一律回落缺省 1 次重试，写 0 也照样重试一次。
// 真 fs 角色卡 + 真 agent:reply:before 钩子驱动（生产路径），断言 0 = 不重试。
// 回复只认卡上声明的回复字段：缺了就重试，不拿别名或别的字段顶上；没有 outputFormat 的卡不动回复，以 { 开头的照原样交出。
// ════════════════════════════════════════════════════════════

/** 宿主侧驱动钩子链 */
const hostUses = { hooks };

describe('persona 角色卡 outputFormatRetries（真 fs + 真钩子）', () => {
  let base: string;
  let app: App;
  let host: BoundOf<typeof hostUses>;

  /** 选中的卡写成主卡 default.yaml */
  const boot = async (name: string): Promise<void> => {
    writeFileSync(join(base, 'self', 'personas', 'default.yaml'), CARDS[name]);
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    provideHostPaths(app, base);
    // storage 先装：persona 的 storage 是可选依赖，缺席时它照样激活，只是一张卡都读不到
    await app.plugin(storageLocal, {});
    await app.plugin(personaPlugin, { personasDir: 'personas:/' });
    await app.plugins.idle();
    // 停在 pending 的插件既不提供服务也不挂中间件，下面的钩子断言会退化成恒真
    expect(app.plugins.getPlugin(storageLocal.name)?.state, 'storage-local 未激活').toBe('active');
    expect(app.plugins.getPlugin(personaPlugin.name)?.state, 'persona 未激活').toBe('active');
    host = app.bind(hostUses);
  };

  /** 带结构化输出的卡，retriesLine 是它的 outputFormatRetries 一行 */
  const card = (retriesLine: string) =>
    `name: 测试卡\ndescription: d\nprompt: p\n${retriesLine}outputFormat:\n  message:\n    description: 回复内容\n    reply: true\n  mood:\n    description: 心情\n`;

  /** 各用例用的卡：zz-plain 没有 outputFormat，其余按 outputFormatRetries 一行区分 */
  const CARDS: Record<string, string> = {
    'zz-plain': 'name: 纯文本卡\ndescription: d\nprompt: p\n',
    'zz-no-retry': card('outputFormatRetries: 0\n'),
    'zz-default': card(''),
    // 脏值三种：负数 / 小数 / 字符串——asCard 的非负整数清洗是唯一防线
    'zz-negative': card('outputFormatRetries: -1\n'),
    'zz-fractional': card('outputFormatRetries: 2.5\n'),
    'zz-string': card("outputFormatRetries: '3'\n"),
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-persona-retries-'));
    mkdirSync(join(base, 'self', 'personas'), { recursive: true });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('角色卡 outputFormatRetries: 0 → 不重试，首次不合格即丢弃', async () => {
    await boot('zz-no-retry');

    // 缺 mood 字段（声明字段必须齐全）→ 校验失败
    const data: Record<string, unknown> = {
      sessionId: 'zz-s',
      platform: 'test',
      content: '{"message":"你好"}',
      attempt: 0,
    };
    await host.hooks.use.run('agent:reply:before', data as never);

    expect(data.maxRetries).toBe(0);
    expect(data.retryRequested).not.toBe(true);
    expect(data.content).toBe('');
  });

  it('角色卡未写该键 → 仍是缺省 1 次重试', async () => {
    await boot('zz-default');

    const data: Record<string, unknown> = {
      sessionId: 'zz-s',
      platform: 'test',
      content: '{"message":"你好"}',
      attempt: 0,
    };
    await host.hooks.use.run('agent:reply:before', data as never);

    expect(data.maxRetries).toBe(1);
    expect(data.retryRequested).toBe(true);
  });

  it('带链接的纯文本回复触发重试时，只要求修正格式并保留应传达的正文', async () => {
    await boot('zz-default');
    const url = 'https://example.com/reports/weekly';
    const data: Record<string, unknown> = {
      sessionId: 'zz-work',
      platform: 'test',
      content: `报告已生成：${url}`,
      attempt: 0,
    };
    await host.hooks.use.run('agent:reply:before', data as never);

    expect(data.retryRequested).toBe(true);
    expect(data.retryFeedback).toContain('只修正格式');
    expect(data.retryFeedback).toContain('保留本来需要传达的正文');
    expect(data.retryFeedback).not.toContain('汇报已完成 / 不想再对外发送新内容');

    const corrected: Record<string, unknown> = {
      sessionId: 'zz-work',
      platform: 'test',
      content: JSON.stringify({ message: `报告已生成：${url}`, mood: '开心' }),
      attempt: 1,
    };
    await host.hooks.use.run('agent:reply:before', corrected as never);

    expect(corrected.content).toBe(`报告已生成：${url}`);
    expect(corrected.visibleContent).toBe(`报告已生成：${url}`);
    expect(corrected.retryRequested).not.toBe(true);
  });

  it('显式空 message 可以静默；最终仍不合格则丢弃原始内容', async () => {
    await boot('zz-default');
    const silent: Record<string, unknown> = {
      sessionId: 'zz-silent',
      platform: 'test',
      content: '{"message":"","mood":"平静"}',
      attempt: 0,
    };
    await host.hooks.use.run('agent:reply:before', silent as never);
    expect(silent.content).toBe('');
    expect(silent.visibleContent).toBe('');
    expect(silent.retryRequested).not.toBe(true);

    const invalid: Record<string, unknown> = {
      sessionId: 'zz-invalid',
      platform: 'test',
      content: '报告已生成：https://example.com/reports/weekly',
      attempt: 1,
    };
    await host.hooks.use.run('agent:reply:before', invalid as never);
    expect(invalid.retryRequested).toBe(false);
    expect(invalid.content).toBe('');
    expect(invalid.archiveContent).toBeUndefined();
  });

  it.each([
    ['{"mood":"开心"}', '开心'],
    ['{"response":"在","mood":"平静"}', '在'],
  ])('回复字段缺了（%s）：要求重试，不拿别的字段（%s）顶上', async (content, standIn) => {
    await boot('zz-default');
    const data: Record<string, unknown> = { sessionId: 'zz-missing', platform: 'test', content, attempt: 0 };
    await host.hooks.use.run('agent:reply:before', data as never);

    expect(data.retryRequested).toBe(true);
    expect(data.content).not.toBe(standIn);
  });

  it('没有 outputFormat 的卡：以 { 开头的回复照原样交出，不解包', async () => {
    await boot('zz-plain');
    const content = '{"message":"ok","code":0}';
    const data: Record<string, unknown> = { sessionId: 'zz-plain', platform: 'test', content, attempt: 0 };
    await host.hooks.use.run('agent:reply:before', data as never);

    expect(data.content).toBe(content);
    expect(data.archiveContent).toBeUndefined();
    expect(data.visibleContent).toBeUndefined();
  });

  // 负数会让重试闸永不放行（maxRetries < 0），小数/字符串则一路带进比较——
  // 清洗只在 asCard 一处，破了就没有第二道。
  it.each([
    ['zz-negative', '负数'],
    ['zz-fractional', '小数'],
    ['zz-string', '字符串'],
  ])('角色卡 outputFormatRetries 写脏值（%s，%s）→ 按未设处理，回落缺省 1', async name => {
    await boot(name);
    const data: Record<string, unknown> = {
      sessionId: 'zz-s',
      platform: 'test',
      content: '{"message":"你好"}',
      attempt: 0,
    };
    await host.hooks.use.run('agent:reply:before', data as never);
    expect(data.maxRetries).toBe(1);
  });
});
