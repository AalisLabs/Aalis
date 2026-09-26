import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { App, type LogEntry, LogHub, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { HUB_PLUGINS } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// persona 从 storage 载入角色卡：
//   1. 冷启动同批登记时 persona 排在 storage-local 前面（按字母序加载的实际顺序）：apply 时读不到卡，
//      先用内置默认；主卡完全靠 app:ready 跟随 storage 的首扫（refresh → reloadPrimaryCardFromCache）载入。
//      这一步回归时人设会静默退回内置的 Aalis，其它用例都让 storage 先上线，照样全绿。
//   2. 非主卡的 outputFormat 缓存曾按显示名写入、按文件名删除：同名的两张卡共用先解析的那份格式，
//      热改非主卡的 outputFormat 要重启才生效（此时 outputFormatPrompt 已是新文本，两边对不上）。
//      现按卡对象缓存，重扫换入新卡对象后旧缓存自然失效。
//   3. 热改主卡：监听触发重扫，经 reloadPrimaryCardFromCache 换入新卡，人设名与提示词不必重启即更新。
// 真 storage-local（workspace + data 两个根）+ 真 persona。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const waitUntil = async (pred: () => boolean, timeoutMs = 3000): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
};

const root = (name: string, path: string) => ({
  name,
  path,
  label: name,
  kind: name,
  browsable: true,
  readable: true,
  writable: true,
  deletable: true,
});

/** 带结构化输出的卡：replyKey 为回复字段名 */
const formatCard = (name: string, replyKey: string, description = 'd'): string =>
  [
    `name: ${name}`,
    `description: ${description}`,
    'prompt: p',
    'outputFormat:',
    `  ${replyKey}:`,
    '    description: 回复',
    '    reply: true',
    '',
  ].join('\n');

describe('persona 角色卡载入（真 storage-local）', () => {
  let base: string;
  let app: App;

  const personasDir = (): string => join(base, 'data', 'personas');
  const writeCard = (file: string, text: string): void => writeFileSync(join(personasDir(), file), text);
  const getService = (): PersonaService => {
    const svc = app.bind({ services }).services.get(persona);
    if (!svc) throw new Error('persona 服务未就绪');
    return svc;
  };

  /** storageFirst=false 时 persona 排在 storage-local 前面同批登记；传 logHub 时收 warn 及以上的日志 */
  async function boot(primary: string, storageFirst: boolean, logHub?: LogHub): Promise<PersonaService> {
    const personaEntry = {
      definition: personaPlugin,
      config: { persona: primary, personasDir: 'data/personas', timeInjection: false },
    };
    const storageEntry = {
      definition: storageLocal,
      config: { roots: [root('workspace', join(base, 'workspace')), root('data', join(base, 'data'))] },
    };
    app = new App({ name: 'T', logLevel: logHub ? 'warn' : 'error', logHub });
    await app.pluginAll([
      ...HUB_PLUGINS.map(definition => ({ definition })),
      ...(storageFirst ? [storageEntry, personaEntry] : [personaEntry, storageEntry]),
    ]);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(personaPlugin.name)?.state, 'persona 未激活').toBe('active');
    return getService();
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-persona-load-'));
    mkdirSync(join(base, 'workspace'), { recursive: true });
    mkdirSync(personasDir(), { recursive: true });
  });

  afterEach(async () => {
    await app?.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('persona 先于 storage-local 同批登记：start() 返回时主卡已经首扫载入', async () => {
    writeCard('zzmain.yaml', 'name: 探针主卡\ndescription: d\nprompt: 主卡正文\n');
    const svc = await boot('zzmain', false);
    // 前提：apply 时 storage 尚未上线，主卡还是内置默认——否则本用例测的是 apply 而不是首扫
    expect(svc.getPersonaName(), '前提不成立：apply 时已读到主卡').toBe('Aalis');
    await app.start();
    expect(svc.getPersonaName()).toBe('探针主卡');
    expect(svc.getSystemPrompt()).toContain('主卡正文');
  });

  it('两张非主卡显示名相同：各自用自己的 outputFormat', async () => {
    writeCard('main.yaml', 'name: Main\ndescription: m\nprompt: m\n');
    writeCard('a.yaml', formatCard('Same', 'msgA'));
    writeCard('b.yaml', formatCard('Same', 'msgB'));
    const svc = await boot('main', true);
    await app.start();
    expect(svc.getOutputFormat?.({ persona: 'a' })?.replyField).toBe('msgA');
    expect(svc.getOutputFormat?.({ persona: 'b' })?.replyField).toBe('msgB');
    const promptB = svc.getSystemPrompt({ persona: 'b' });
    expect(promptB).toContain('"msgB"');
    expect(promptB).not.toContain('"msgA"');
  });

  it('名字与昵称按 options 取卡：不传取主卡；指定的卡没写名字时报那张卡的文件名；找不到该卡时回落主卡', async () => {
    writeCard('main.yaml', 'name: Main\nnick_name: [小M]\ndescription: m\nprompt: m\n');
    writeCard('b.yaml', 'name: Bob\nnick_name: [阿B]\ndescription: b\nprompt: b\n');
    writeCard('nameless.yaml', 'description: n\nprompt: n\n');
    const svc = await boot('main', true);
    await app.start();
    expect([svc.getPersonaName(), svc.getNickNames?.()]).toEqual(['Main', ['小M']]);
    expect([svc.getPersonaName({ persona: 'b' }), svc.getNickNames?.({ persona: 'b' })]).toEqual(['Bob', ['阿B']]);
    expect([svc.getPersonaName({ persona: 'nameless' }), svc.getNickNames?.({ persona: 'nameless' })]).toEqual([
      'nameless，未设置名字',
      [],
    ]);
    expect(svc.getPersonaName({ persona: 'missing' })).toBe('Main');
  });

  it('nick_name 写成单个字符串按一个昵称取、不拆成单字；列表各项去空白、滤掉非字符串与空串；其它类型忽略并记 warn', async () => {
    writeCard('main.yaml', 'name: Main\nnick_name: 小明同学\ndescription: m\nprompt: m\n');
    writeCard('b.yaml', "name: Bob\nnick_name: [' 阿B ', '', '  ', 233, 阿波]\ndescription: b\nprompt: b\n");
    writeCard('c.yaml', 'name: Cat\nnick_name: {a: 1}\ndescription: c\nprompt: c\n');
    const logHub = new LogHub();
    const logs: LogEntry[] = [];
    logHub.onEntry(e => logs.push(e));
    const svc = await boot('main', true, logHub);
    await app.start();
    expect(svc.getNickNames?.()).toEqual(['小明同学']);
    expect(svc.getNickNames?.({ persona: 'b' })).toEqual(['阿B', '阿波']);
    expect(svc.getNickNames?.({ persona: 'c' })).toEqual([]);
    const warns = logs.filter(e => e.level === 'warn').map(e => e.message);
    expect(warns.some(m => m.includes('nick_name 应为字符串列表') && m.includes('c.yaml'))).toBe(true);
    expect(
      warns.filter(m => m.includes('nick_name')).every(m => m.includes('c.yaml')),
      '只有 c 卡告警',
    ).toBe(true);
  });

  it('热改非主卡的 outputFormat：重扫后提示词与回复字段都换成新的', async () => {
    writeCard('main.yaml', 'name: Main\ndescription: m\nprompt: m\n');
    writeCard('a.yaml', formatCard('Alice', 'old'));
    const svc = await boot('main', true);
    await app.start();
    // 先取一次，让旧格式进缓存
    expect(svc.getOutputFormat?.({ persona: 'a' })?.replyField).toBe('old');
    await sleep(250); // 等 fs 监听就绪

    writeCard('a.yaml', formatCard('Alice', 'new', 'EDITED'));
    expect(await waitUntil(() => svc.getSystemPrompt({ persona: 'a' }).includes('EDITED')), '改卡未被重扫载入').toBe(
      true,
    );
    expect(svc.getOutputFormat?.({ persona: 'a' })?.replyField).toBe('new');
    const prompt = svc.getSystemPrompt({ persona: 'a' });
    expect(prompt).toContain('"new"');
    expect(prompt).not.toContain('"old"');
  });

  it('热改主卡：重扫后 getPersonaName 与系统提示词都换成新的', async () => {
    writeCard('main.yaml', 'name: 旧主卡名\ndescription: m\nprompt: 旧主卡正文\n');
    const svc = await boot('main', true);
    await app.start();
    expect(svc.getPersonaName()).toBe('旧主卡名');
    await sleep(250); // 等 fs 监听就绪

    writeCard('main.yaml', 'name: 新主卡名\ndescription: m\nprompt: 新主卡正文\n');
    expect(await waitUntil(() => svc.getPersonaName() === '新主卡名'), '改主卡未被重扫载入').toBe(true);
    const prompt = svc.getSystemPrompt();
    expect(prompt).toContain('新主卡正文');
    expect(prompt).not.toContain('旧主卡正文');
  });
});
