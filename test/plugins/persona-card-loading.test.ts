import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { createBotNames } from '../../packages/api-trigger/src/index.js';
import { App, type LogEntry, LogHub, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { HUB_PLUGINS } from '../fixtures/hubs.js';
import { sessionValuesPlugin } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// persona 从 storage 载入角色卡：
//   1. 冷启动同批登记时 persona 排在 storage-local 前面（按字母序加载的实际顺序）：apply 时读不到卡，
//      先用内置默认；主卡完全靠 app:ready 跟随 storage 的首扫（refresh → reloadPrimaryCardFromCache）载入。
//      这一步回归时人设会静默退回内置的 Aalis，其它用例都让 storage 先上线，照样全绿。
//   2. 非主卡的 outputFormat 缓存曾按显示名写入、按文件名删除：同名的两张卡共用先解析的那份格式，
//      热改非主卡的 outputFormat 要重启才生效（此时 outputFormatPrompt 已是新文本，两边对不上）。
//      现按卡对象缓存，重扫换入新卡对象后旧缓存自然失效。
//   3. 热改主卡：监听触发重扫，经 reloadPrimaryCardFromCache 换入新卡，人设名与提示词不必重启即更新。
// 真 storage-local（workspace 根 + 内置 personas 根）+ 真 persona；会话用哪张卡由会话设置的替身给（会话 id 即卡名）。
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

  const personasDir = (): string => join(base, 'self', 'personas');
  const writeCard = (file: string, text: string): void => writeFileSync(join(personasDir(), file), text);
  const getService = (): PersonaService => {
    const svc = app.bind({ services }).services.use.get(persona);
    if (!svc) throw new Error('persona 服务未就绪');
    return svc;
  };

  /** 会话用的卡：会话 id 就是卡名，它的「人设」设成这张卡 */
  const as = (card: string) => ({ sessionId: card });
  const SESSIONS = Object.fromEntries(
    ['a', 'b', 'c', 'd', 'nameless', 'missing'].map(card => [card, { persona: card }]),
  );

  /**
   * storageFirst=false 时 persona 排在 storage-local 前面同批登记；传 logHub 时收 warn 及以上的日志；
   * config 并进人设插件的配置
   */
  async function boot(
    storageFirst: boolean,
    { logHub, config = {} }: { logHub?: LogHub; config?: Record<string, unknown> } = {},
  ): Promise<PersonaService> {
    const personaEntry = {
      definition: personaPlugin,
      // 不传 personasDir：走默认的 personas:/，即家目录的 self/personas
      config: { timeInjection: false, ...config },
    };
    const storageEntry = {
      definition: storageLocal,
      config: { roots: [root('workspace', join(base, 'workspace'))] },
    };
    app = new App({ name: 'T', logLevel: logHub ? 'warn' : 'error', logHub });
    provideHostPaths(app, base);
    await app.pluginAll([
      ...HUB_PLUGINS.map(definition => ({ definition })),
      { definition: sessionValuesPlugin(SESSIONS) },
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
    writeCard('default.yaml', 'name: 探针主卡\ndescription: d\nprompt: 主卡正文\n');
    const svc = await boot(false);
    // 前提：apply 时 storage 尚未上线，主卡还是内置默认——否则本用例测的是 apply 而不是首扫
    expect(svc.getPersonaName(), '前提不成立：apply 时已读到主卡').toBe('Aalis');
    await app.start();
    expect(svc.getPersonaName()).toBe('探针主卡');
    expect(svc.getSystemPrompt()).toContain('主卡正文');
  });

  it('两张非主卡显示名相同：各自用自己的 outputFormat', async () => {
    writeCard('default.yaml', 'name: Main\ndescription: m\nprompt: m\n');
    writeCard('a.yaml', formatCard('Same', 'msgA'));
    writeCard('b.yaml', formatCard('Same', 'msgB'));
    const svc = await boot(true);
    await app.start();
    expect(svc.getOutputFormat?.(as('a'))?.replyField).toBe('msgA');
    expect(svc.getOutputFormat?.(as('b'))?.replyField).toBe('msgB');
    const promptB = svc.getSystemPrompt(as('b'));
    expect(promptB).toContain('"msgB"');
    expect(promptB).not.toContain('"msgA"');
  });

  it('名字与昵称按 options 取卡：不传取主卡；指定的卡没写名字时为空串；找不到该卡时回落主卡', async () => {
    writeCard('default.yaml', 'name: Main\nnick_name: [小M]\ndescription: m\nprompt: m\n');
    writeCard('b.yaml', 'name: Bob\nnick_name: [阿B]\ndescription: b\nprompt: b\n');
    writeCard('nameless.yaml', 'description: n\nprompt: n\n');
    const svc = await boot(true);
    await app.start();
    expect([svc.getPersonaName(), svc.getNickNames?.()]).toEqual(['Main', ['小M']]);
    expect([svc.getPersonaName(as('b')), svc.getNickNames?.(as('b'))]).toEqual(['Bob', ['阿B']]);
    expect([svc.getPersonaName(as('nameless')), svc.getNickNames?.(as('nameless'))]).toEqual(['', []]);
    expect(svc.getPersonaName(as('missing'))).toBe('Main');
  });

  it('主卡没写名字：点名的名字表只有别名与昵称，不混进兜底文字', async () => {
    writeCard('default.yaml', 'nick_name: [小N]\ndescription: m\nprompt: m\n');
    await boot(true);
    await app.start();
    const names = createBotNames(app.bind({ persona }).persona, app.logger, '[t]');
    expect(names(['别名'], { sessionId: 's', platform: 'onebot' })).toEqual(['别名', '小N']);
  });

  it('nick_name 写成单个字符串按一个昵称取、不拆成单字；列表各项去空白、滤掉非字符串与空串；留空不告警；其它类型忽略并记 warn', async () => {
    writeCard('default.yaml', 'name: Main\nnick_name: 小明同学\ndescription: m\nprompt: m\n');
    writeCard('b.yaml', "name: Bob\nnick_name: [' 阿B ', '', '  ', 233, 阿波]\ndescription: b\nprompt: b\n");
    writeCard('c.yaml', 'name: Cat\nnick_name: {a: 1}\ndescription: c\nprompt: c\n');
    writeCard('d.yaml', 'name: Dan\nnick_name:\ndescription: d\nprompt: d\n');
    const logHub = new LogHub();
    const logs: LogEntry[] = [];
    logHub.onEntry(e => logs.push(e));
    const svc = await boot(true, { logHub });
    await app.start();
    expect(svc.getNickNames?.()).toEqual(['小明同学']);
    expect(svc.getNickNames?.(as('b'))).toEqual(['阿B', '阿波']);
    expect(svc.getNickNames?.(as('c'))).toEqual([]);
    expect(svc.getNickNames?.(as('d')), '留空（null）与不写相同').toEqual([]);
    const warns = logs.filter(e => e.level === 'warn').map(e => e.message);
    expect(warns.some(m => m.includes('nick_name 应为字符串列表') && m.includes('c.yaml'))).toBe(true);
    expect(
      warns.filter(m => m.includes('nick_name')).every(m => m.includes('c.yaml')),
      '只有 c 卡告警',
    ).toBe(true);
  });

  it('热改非主卡的 outputFormat：重扫后提示词与回复字段都换成新的', async () => {
    writeCard('default.yaml', 'name: Main\ndescription: m\nprompt: m\n');
    writeCard('a.yaml', formatCard('Alice', 'old'));
    const svc = await boot(true);
    await app.start();
    // 先取一次，让旧格式进缓存
    expect(svc.getOutputFormat?.(as('a'))?.replyField).toBe('old');
    await sleep(250); // 等 fs 监听就绪

    writeCard('a.yaml', formatCard('Alice', 'new', 'EDITED'));
    expect(await waitUntil(() => svc.getSystemPrompt(as('a')).includes('EDITED')), '改卡未被重扫载入').toBe(true);
    expect(svc.getOutputFormat?.(as('a'))?.replyField).toBe('new');
    const prompt = svc.getSystemPrompt(as('a'));
    expect(prompt).toContain('"new"');
    expect(prompt).not.toContain('"old"');
  });

  it('热改主卡：重扫后 getPersonaName 与系统提示词都换成新的', async () => {
    writeCard('default.yaml', 'name: 旧主卡名\ndescription: m\nprompt: 旧主卡正文\n');
    const svc = await boot(true);
    await app.start();
    expect(svc.getPersonaName()).toBe('旧主卡名');
    await sleep(250); // 等 fs 监听就绪

    writeCard('default.yaml', 'name: 新主卡名\ndescription: m\nprompt: 新主卡正文\n');
    expect(await waitUntil(() => svc.getPersonaName() === '新主卡名'), '改主卡未被重扫载入').toBe(true);
    const prompt = svc.getSystemPrompt();
    expect(prompt).toContain('新主卡正文');
    expect(prompt).not.toContain('旧主卡正文');
  });

  it('「人设」的全局层是插件配置：作者默认 default 即主卡；配置里写了别的卡时没设人设的会话也用它，会话设的压过它', async () => {
    writeCard('default.yaml', 'name: 默认卡\ndescription: d\nprompt: 默认卡正文\n');
    writeCard('other.yaml', 'name: 别的卡\ndescription: o\nprompt: 别的卡正文\n');
    writeCard('b.yaml', 'name: Bob\ndescription: b\nprompt: b\n');
    expect((personaPlugin.configSchema as Record<string, { default?: unknown }>).persona.default).toBe('default');
    const svc = await boot(true, { config: { persona: 'other' } });
    await app.start();
    expect(svc.getPersonaName()).toBe('别的卡');
    expect(svc.getSystemPrompt({ sessionId: '<没设人设的会话>' })).toContain('别的卡正文');
    expect(svc.getPersonaName(as('b'))).toBe('Bob');
  });
});
