import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { App, type Logger, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// 坏角色卡不能静默：YAML 解析失败曾被 catch 吞成 undefined，与"文件不存在"
// 不可区分 —— 主卡坏掉只会留下一句"未找到角色卡"，人照着这句去查文件名，
// 而真正的原因（语法错/顶层不是对象）一个字都没有。
//   1. 解析失败 → 点名 warn（含 uri + 原因），主卡回退默认时不复用"未找到"文案
//   2. 合法但非对象的 YAML（标量/数组）不再被当成"全空卡已加载"
//   3. scanAll 不把坏卡塞进可选人设列表
// 真 fs storage + 真 yaml 解析，日志经注入 logger 录制。
// ════════════════════════════════════════════════════════════

interface Recorded {
  level: string;
  text: string;
}

function recordingLogger(sink: Recorded[]): Logger {
  const push =
    (level: string) =>
    (message: string, ...args: unknown[]) =>
      sink.push({ level, text: [message, ...args.map(a => String(a))].join(' ') });
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

describe('persona 坏角色卡的告警与守卫（真 fs）', () => {
  let base: string;
  let app: App;
  let logs: Recorded[];

  const bootPersona = async (personaName: string): Promise<PersonaService> => {
    logs = [];
    app = new App({ name: 'T', logLevel: 'debug', logger: recordingLogger(logs) });
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
    // 停在 pending 的插件一行都不跑，日志断言会退化成「什么都没发生」的假绿
    expect(app.plugins.getPlugin(storageLocal.name)?.state, 'storage-local 未激活').toBe('active');
    expect(app.plugins.getPlugin(personaPlugin.name)?.state, 'persona 未激活').toBe('active');
    const svc = app.bind({ services }).services.get(persona);
    if (!svc) throw new Error('persona 服务未就绪');
    return svc;
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-persona-bad-'));
    mkdirSync(join(base, 'personas'), { recursive: true });
    // 语法坏卡（未闭合流式映射）、合法但非对象的卡、一张好卡
    writeFileSync(join(base, 'personas', 'zz-broken.yaml'), 'name: {unclosed\nprompt: 你好\n');
    writeFileSync(join(base, 'personas', 'zz-scalar.yaml'), '只是一行字符串\n');
    writeFileSync(join(base, 'personas', 'zz-good.yaml'), 'name: 好卡\ndescription: d\nprompt: p\n');
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('主卡 YAML 语法坏：点名 warn 含 uri 与原因，且不说"未找到角色卡"', async () => {
    await bootPersona('zz-broken');
    const warns = logs.filter(l => l.level === 'warn').map(l => l.text);
    expect(warns.some(t => t.includes('解析失败') && t.includes('data:/personas/zz-broken.yaml'))).toBe(true);
    expect(warns.some(t => t.includes('存在但解析失败'))).toBe(true);
    expect(logs.some(l => l.text.includes('未找到角色卡'))).toBe(false);
  });

  it('合法但非对象的 YAML 不再被当成空卡"已加载"，退回内置默认人设', async () => {
    const svc = await bootPersona('zz-scalar');
    expect(logs.some(l => l.text.includes('已加载角色卡'))).toBe(false);
    expect(logs.filter(l => l.level === 'warn').some(t => t.text.includes('YAML 顶层不是对象'))).toBe(true);
    expect(svc.getSystemPrompt()).toContain('请友好、专业地与用户交流。');
  });

  it('启动扫描跳过坏卡：可选人设只剩好卡', async () => {
    const svc = await bootPersona('zz-good');
    await app.start();
    expect(await svc.listModels?.()).toEqual(['zz-good']);
  });
});
