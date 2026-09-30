import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { App, type BoundOf, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 角色卡的 outputFormatRetries 必须真的传到重试闸：asCard 曾漏抄这个键，
// 于是卡里写多少都被解析处当"未设"→ 一律回落缺省 1 次重试，写 0 也照样重试一次。
// 真 fs 角色卡 + 真 agent:reply:before 钩子驱动（生产路径），断言 0 = 不重试。
// ════════════════════════════════════════════════════════════

/** 宿主侧要的两样：驱动钩子链、取 persona 服务 */
const hostUses = { hooks, services };

describe('persona 角色卡 outputFormatRetries（真 fs + 真钩子）', () => {
  let base: string;
  let app: App;
  let host: BoundOf<typeof hostUses>;

  const boot = async (personaName: string): Promise<PersonaService> => {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    // storage 先装：persona 的 storage 是可选依赖，缺席时它照样激活，只是一张卡都读不到
    await app.plugin(storageLocal, {
      roots: [
        {
          name: 'data',
          path: base,
          label: 'data',
          kind: 'data',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    await app.plugin(personaPlugin, { persona: personaName, personasDir: 'data/personas' });
    await app.plugins.idle();
    // 停在 pending 的插件既不提供服务也不挂中间件，下面的钩子断言会退化成恒真
    expect(app.plugins.getPlugin(storageLocal.name)?.state, 'storage-local 未激活').toBe('active');
    expect(app.plugins.getPlugin(personaPlugin.name)?.state, 'persona 未激活').toBe('active');
    host = app.bind(hostUses);
    const svc = host.services.get(persona);
    if (!svc) throw new Error('persona 服务未就绪');
    return svc;
  };

  const card = (retriesLine: string) =>
    `name: 测试卡\ndescription: d\nprompt: p\n${retriesLine}outputFormat:\n  message:\n    description: 回复内容\n    reply: true\n  mood:\n    description: 心情\n`;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-persona-retries-'));
    mkdirSync(join(base, 'personas'), { recursive: true });
    writeFileSync(join(base, 'personas', 'zz-no-retry.yaml'), card('outputFormatRetries: 0\n'));
    writeFileSync(join(base, 'personas', 'zz-default.yaml'), card(''));
    // 脏值三种：负数 / 小数 / 字符串——asCard 的非负整数清洗是唯一防线
    writeFileSync(join(base, 'personas', 'zz-negative.yaml'), card('outputFormatRetries: -1\n'));
    writeFileSync(join(base, 'personas', 'zz-fractional.yaml'), card('outputFormatRetries: 2.5\n'));
    writeFileSync(join(base, 'personas', 'zz-string.yaml'), card("outputFormatRetries: '3'\n"));
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('角色卡 outputFormatRetries: 0 → 不重试，首次不合格即丢弃', async () => {
    const svc = await boot('zz-no-retry');
    expect(svc.getOutputFormat?.()?.retries).toBe(0);

    // 缺 mood 字段（声明字段必须齐全）→ 校验失败
    const data: Record<string, unknown> = {
      sessionId: 'zz-s',
      platform: 'test',
      content: '{"message":"你好"}',
      attempt: 0,
    };
    await host.hooks.run('agent:reply:before', data as never);

    expect(data.maxRetries).toBe(0);
    expect(data.retryRequested).not.toBe(true);
    expect(data.content).toBe('');
  });

  it('角色卡未写该键 → 仍是缺省 1 次重试', async () => {
    const svc = await boot('zz-default');
    expect(svc.getOutputFormat?.()?.retries).toBe(1);

    const data: Record<string, unknown> = {
      sessionId: 'zz-s',
      platform: 'test',
      content: '{"message":"你好"}',
      attempt: 0,
    };
    await host.hooks.run('agent:reply:before', data as never);

    expect(data.maxRetries).toBe(1);
    expect(data.retryRequested).toBe(true);
  });

  it('纯文本作品链接触发重试时，只要求修正格式并保留应传达的正文', async () => {
    await boot('zz-default');
    const url = 'https://example.com/works/new-story';
    const data: Record<string, unknown> = {
      sessionId: 'zz-work',
      platform: 'test',
      content: `作品已完成：${url}`,
      attempt: 0,
    };
    await host.hooks.run('agent:reply:before', data as never);

    expect(data.retryRequested).toBe(true);
    expect(data.retryFeedback).toContain('只修正格式');
    expect(data.retryFeedback).toContain('保留本来需要传达的正文');
    expect(data.retryFeedback).not.toContain('汇报已完成 / 不想再对外发送新内容');

    const corrected: Record<string, unknown> = {
      sessionId: 'zz-work',
      platform: 'test',
      content: JSON.stringify({ message: `作品已完成：${url}`, mood: '开心' }),
      attempt: 1,
    };
    await host.hooks.run('agent:reply:before', corrected as never);

    expect(corrected.content).toBe(`作品已完成：${url}`);
    expect(corrected.visibleContent).toBe(`作品已完成：${url}`);
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
    await host.hooks.run('agent:reply:before', silent as never);
    expect(silent.content).toBe('');
    expect(silent.visibleContent).toBe('');
    expect(silent.retryRequested).not.toBe(true);

    const invalid: Record<string, unknown> = {
      sessionId: 'zz-invalid',
      platform: 'test',
      content: '作品已完成：https://example.com/works/new-story',
      attempt: 1,
    };
    await host.hooks.run('agent:reply:before', invalid as never);
    expect(invalid.retryRequested).toBe(false);
    expect(invalid.content).toBe('');
    expect(invalid.archiveContent).not.toContain('https://example.com/works/new-story');
  });

  // 负数会让重试闸永不放行（maxRetries < 0），小数/字符串则一路带进比较——
  // 清洗只在 asCard 一处，破了就没有第二道。
  it.each([
    ['zz-negative', '负数'],
    ['zz-fractional', '小数'],
    ['zz-string', '字符串'],
  ])('角色卡 outputFormatRetries 写脏值（%s，%s）→ 按未设处理，回落缺省 1', async personaName => {
    const svc = await boot(personaName);
    expect(svc.getOutputFormat?.()?.retries).toBe(1);
  });
});
