import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersonaService } from '../../packages/api-persona/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as personaModule from '../../packages/plugin-persona/src/index.js';
import * as storageLocalModule from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// 角色卡的 outputFormatRetries 必须真的传到重试闸：asCard 曾漏抄这个键，
// 于是卡里写多少都被解析处当"未设"→ 一律回落缺省 1 次重试，写 0 也照样重试一次。
// 真 fs 角色卡 + 真 agent:reply:before 钩子驱动（生产路径），断言 0 = 不重试。
// ════════════════════════════════════════════════════════════

describe('persona 角色卡 outputFormatRetries（真 fs + 真钩子）', () => {
  let base: string;
  let app: App;

  const boot = async (persona: string): Promise<PersonaService> => {
    app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(storageLocalModule as never, {
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
    await app.ctx.useModule(personaModule as never, { persona, personasDir: 'data/personas' });
    return app.ctx.getService<PersonaService>('persona')!;
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
    await app.ctx.runHook('agent:reply:before', data as never);

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
    await app.ctx.runHook('agent:reply:before', data as never);

    expect(data.maxRetries).toBe(1);
    expect(data.retryRequested).toBe(true);
  });

  // 负数会让重试闸永不放行（maxRetries < 0），小数/字符串则一路带进比较——
  // 清洗只在 asCard 一处，破了就没有第二道。
  it.each([
    ['zz-negative', '负数'],
    ['zz-fractional', '小数'],
    ['zz-string', '字符串'],
  ])('角色卡 outputFormatRetries 写脏值（%s，%s）→ 按未设处理，回落缺省 1', async persona => {
    const svc = await boot(persona);
    expect(svc.getOutputFormat?.()?.retries).toBe(1);
  });
});
