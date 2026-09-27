import { afterEach, describe, expect, it, vi } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, LogHub, type PluginDefinition, services } from '../../packages/core/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import llmOllama from '../../packages/plugin-llm-ollama/src/index.js';
import llmOpenai from '../../packages/plugin-llm-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// 模型发现失败（不可达、非 2xx、响应不是模型列表）不等于「远端没有模型」：
// - 启动时按未发现远端模型继续（customModels 照常注册），但要记一条 warn 并带上真实原因，不带堆栈。fetch
//   网络失败的消息固定是「fetch failed」，原因（拒绝连接、DNS、TLS）在 cause 上，只拼 message 就丢了。
// - 一个模型都没有（发现失败且没配 customModels，或已连接但列表为空）时实例转 error，错误信息写明原因；
//   插件不抛的话，错误信息只剩 core 的「声明 provides [llm] 但未实际注册这些服务」。Ollama 的模型都是非对话模型
//   （如只装了嵌入模型）、一个都没注册时同理。
// - WebUI 触发的刷新要报错并保留已注册条目。按空列表处理会把自动发现的条目全部注销，路由还回成功。
// - 启动时发现失败后，注册结果那行日志不能再说「已连接」。
// - 关闭 discoverModels（网关不提供模型列表）时不发发现请求、不记 warn，只注册 customModels，也不提供刷新；
//   Ollama 照常经 /api/show 探测能力。
// - 响应是 200 但不是模型列表时写明「响应不是模型列表」并带上响应摘录（网关可能用 200 回错误说明），不是 JS 内部报错；
//   不是 JSON（如网关的门户页）时写明「响应不是 JSON」，摘录折成一行，不是 JSON.parse 带着换行的 SyntaxError。
// - 发现失败的原因会进实例的错误信息、日志与 WebUI：原因里的 URL 去掉查询串（有的网关把密钥写在查询串里），注册
//   结果那行日志与「已连接 …」的错误信息里的 URL 同样去掉。baseUrl 带用户名或密码、或解析不了时，读配置就抛配置
//   错误，不发请求：带凭据的 URL fetch 拒发，凭据还会出现在报错与条目名称（WebUI 的模型下拉）里。
//
// fetch 用替身，不发真实请求。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
});

type Mode = 'ok' | 'empty' | 'http500' | 'refused' | 'refusedBoth' | 'notList' | 'longNotList' | 'badItems' | 'html200';

/**
 * 发现端点按 mode 应答；Ollama 能力探测答 showCapabilities（默认是最小可用的对话能力）。refused 仿 undici 网络失败：
 * 消息固定、原因在 cause。refusedBoth 仿连 localhost 时两个地址族都被拒：cause 是消息为空的 AggregateError，原因在
 * 子错误上。empty 仿已连接但列表为空。notList 仿网关用 200 回错误说明，longNotList 同样但说明很长，badItems 仿列表项
 * 缺 id（Ollama 缺 name），html200 仿网关用 200 回多行的门户页。
 * 与真实 fetch 一样先构造 Request：带凭据或解析不了的 URL 在这里就被拒绝。discoveryCalls 记发现请求（/models、
 * /api/tags）的次数，shown 记经 /api/show 探测过的模型
 */
function stubFetch(
  mode: Mode,
  showCapabilities = ['completion'],
): { mode: Mode; discoveryCalls: number; shown: string[] } {
  const state = { mode, discoveryCalls: 0, shown: [] as string[] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      new Request(u);
      if (u.endsWith('/api/show')) {
        state.shown.push((JSON.parse(String(init?.body)) as { model: string }).model);
        return Response.json({ capabilities: showCapabilities });
      }
      state.discoveryCalls++;
      if (state.mode === 'refused')
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
      if (state.mode === 'refusedBoth')
        throw new TypeError('fetch failed', {
          cause: new AggregateError([
            new Error('connect ECONNREFUSED ::1:9'),
            new Error('connect ECONNREFUSED 127.0.0.1:9'),
          ]),
        });
      if (state.mode === 'http500') return new Response('upstream down', { status: 500 });
      if (state.mode === 'empty') return Response.json(u.endsWith('/api/tags') ? { models: [] } : { data: [] });
      if (state.mode === 'notList') return Response.json({ error: { message: 'quota exceeded' } });
      if (state.mode === 'longNotList') return Response.json({ error: { message: 'x'.repeat(5_000) } });
      if (state.mode === 'html200')
        return new Response('<html>\r\n  <head><title>portal</title></head>\r\n</html>\r\n', { status: 200 });
      if (state.mode === 'badItems')
        return Response.json(
          u.endsWith('/api/tags') ? { models: [{ id: 'qwen3:8b' }] } : { data: [{ name: 'gpt-4o' }] },
        );
      return Response.json(u.endsWith('/api/tags') ? { models: [{ name: 'qwen3:8b' }] } : { data: [{ id: 'gpt-4o' }] });
    }),
  );
  return state;
}

function world() {
  const hub = new LogHub();
  const warns: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  hub.onEntry(entry => {
    logs.push(entry.message);
    if (entry.level === 'warn') warns.push(entry.message);
    if (entry.level === 'error') errors.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'info', logHub: hub });
  apps.push(app);
  const modelIds = (): string[] =>
    app
      .bind({ services })
      .services.all(llm)
      .map(e => e.instance.id);
  return { app, warns, errors, logs, modelIds };
}

const STACK_FRAME = /\n\s+at /;

const OLLAMA = { baseUrl: 'http://127.0.0.1:11434' };
const GATEWAY = { apiKey: 'k', baseUrl: 'https://gw.invalid/v1' };
const FAILURES = [
  { mode: 'http500' as const, reason: 'HTTP 500' },
  { mode: 'refused' as const, reason: 'ECONNREFUSED' },
  { mode: 'refusedBoth' as const, reason: 'ECONNREFUSED ::1' },
  { mode: 'notList' as const, reason: '响应不是模型列表' },
  { mode: 'html200' as const, reason: '响应不是 JSON' },
];

const startupCases: Array<{ name: string; plugin: PluginDefinition; config: Record<string, unknown> }> = [
  { name: 'llm-ollama', plugin: llmOllama, config: { ...OLLAMA, customModels: 'mine' } },
  { name: 'llm-openai', plugin: llmOpenai, config: { ...GATEWAY, customModels: 'mine' } },
  { name: 'llm-deepseek', plugin: deepseek, config: { ...GATEWAY, customModels: 'mine' } },
];

describe('启动时模型发现失败：记 warn 并带上原因，customModels 照常注册', () => {
  it.each(startupCases.flatMap(c => FAILURES.map(f => ({ ...c, ...f }))))('$name / $mode', async ({
    plugin,
    config,
    mode,
    reason,
  }) => {
    stubFetch(mode);
    const { app, warns, modelIds } = world();
    await app.plugin(plugin, config);
    await app.plugins.idle();

    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('active');
    expect(warns, `应只有一条发现失败的 warn: ${JSON.stringify(warns)}`).toHaveLength(1);
    // 原因只出现一次：消息里内联过的 cause 不再由 logger 按因果链渲染一遍
    expect(
      warns.join('\n').split(reason).length - 1,
      `发现失败没有记下原因，或原因重复记了多遍，warn: ${JSON.stringify(warns)}`,
    ).toBe(1);
    expect(warns[0], '发现失败的 warn 不该带堆栈').not.toMatch(STACK_FRAME);
    expect(modelIds()).toEqual(['mine']);
  });
});

const withoutCustom = startupCases.map(({ config: { customModels: _, ...config }, ...rest }) => ({
  ...rest,
  config,
}));

describe('没有可注册的模型：实例转 error，错误信息写明原因', () => {
  it.each(
    withoutCustom.flatMap(c => [
      { ...c, mode: 'http500' as const, reason: 'HTTP 500' },
      { ...c, mode: 'refused' as const, reason: 'ECONNREFUSED' },
      { ...c, mode: 'empty' as const, reason: '未发现任何可用模型' },
    ]),
  )('$name / $mode', async ({ plugin, config, mode, reason }) => {
    stubFetch(mode);
    const { app, warns, errors } = world();
    await app.plugin(plugin, config);
    await app.plugins.idle();

    const instance = app.plugins.getPlugin(plugin.name);
    expect(instance?.state).toBe('error');
    expect(instance?.error, '错误信息没有写明原因').toContain(reason);
    expect(instance?.error, '错误信息退回了 core 的通用文案').not.toContain('声明 provides');
    if (mode !== 'empty') expect(instance?.error, '发现失败却说已连接').not.toContain('已连接');
    expect(warns, `原因已在错误信息里，不该另记 warn: ${JSON.stringify(warns)}`).toEqual([]);
    expect(errors, `应只有一条激活失败日志: ${JSON.stringify(errors)}`).toHaveLength(1);
    expect(errors[0], '配置错误的日志不该带堆栈').not.toMatch(STACK_FRAME);
  });

  it.each([
    { name: '发现的模型都是非对话模型', config: OLLAMA, model: 'qwen3:8b' },
    {
      name: '关闭模型发现，customModels 都是非对话模型',
      config: { ...OLLAMA, customModels: 'mine', discoverModels: false },
      model: 'mine',
    },
  ])('llm-ollama / $name', async ({ config, model }) => {
    stubFetch('ok', ['embedding']);
    const { app, warns, errors } = world();
    await app.plugin(llmOllama, config);
    await app.plugins.idle();

    const instance = app.plugins.getPlugin(llmOllama.name);
    expect(instance?.state).toBe('error');
    expect(instance?.error, '错误信息没有写明原因').toContain('没有可用的对话模型');
    expect(instance?.error, '错误信息没有点名被跳过的模型').toContain(model);
    expect(instance?.error, '错误信息退回了 core 的通用文案').not.toContain('声明 provides');
    expect(warns).toEqual([]);
    expect(errors, `应只有一条激活失败日志: ${JSON.stringify(errors)}`).toHaveLength(1);
    expect(errors[0], '配置错误的日志不该带堆栈').not.toMatch(STACK_FRAME);
  });
});

const refreshCases: Array<{ name: string; plugin: PluginDefinition; config: Record<string, unknown> }> = [
  { name: 'llm-ollama', plugin: llmOllama, config: OLLAMA },
  { name: 'llm-openai', plugin: llmOpenai, config: GATEWAY },
];

describe('刷新时模型发现失败：报错并带上原因，已注册条目保留', () => {
  it.each(refreshCases.flatMap(c => FAILURES.map(f => ({ ...c, ...f }))))('$name / $mode', async ({
    plugin,
    config,
    mode,
    reason,
  }) => {
    const state = stubFetch('ok');
    const { app, modelIds } = world();
    await app.plugin(plugin, config);
    await app.plugins.idle();
    const before = modelIds();
    expect(before, '前置：启动时发现了模型').toHaveLength(1);
    const [entry] = app.bind({ services }).services.all(llm);
    if (!entry?.instance.refresh) throw new Error(`${plugin.name} 未登记可刷新的条目`);

    state.mode = mode;
    await expect(entry.instance.refresh()).rejects.toThrow(reason);
    expect(modelIds(), '发现失败被当成远端没有模型，自动发现的条目被注销').toEqual(before);
  });
});

describe('启动时模型发现失败：日志不说「已连接」', () => {
  it.each(
    [...startupCases, ...withoutCustom].flatMap(c => [
      { ...c, mode: 'refused' as const, custom: 'customModels' in c.config },
      { ...c, mode: 'ok' as const, custom: 'customModels' in c.config },
    ]),
  )('$name / $mode / customModels=$custom', async ({ plugin, config, mode, custom }) => {
    stubFetch(mode);
    const { app, logs } = world();
    await app.plugin(plugin, config);
    await app.plugins.idle();

    const connected = logs.filter(m => m.includes('已连接'));
    if (mode === 'ok') {
      expect(connected, '对照：发现成功时照常说「已连接」').toHaveLength(1);
      return;
    }
    expect(connected, `发现失败后日志仍说「已连接」: ${JSON.stringify(connected)}`).toEqual([]);
    if (custom) {
      expect(
        logs.some(m => m.includes('注册 customModels 里的 1 个 model entry')),
        `注册结果没有说明发现失败: ${JSON.stringify(logs)}`,
      ).toBe(true);
    } else {
      expect(app.plugins.getPlugin(plugin.name)?.error, '错误信息没有写明发现失败的原因').toContain('ECONNREFUSED');
    }
  });
});

describe('关闭 discoverModels：不发发现请求、不记 warn，只注册 customModels', () => {
  it.each(startupCases)('$name', async ({ plugin, config }) => {
    // 替身按不可达应答：真发了发现请求就会记 warn
    const state = stubFetch('refused');
    const { app, warns, logs, modelIds } = world();
    await app.plugin(plugin, { ...config, discoverModels: false });
    await app.plugins.idle();

    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('active');
    expect(state.discoveryCalls, '关闭后仍请求了模型列表').toBe(0);
    expect(warns).toEqual([]);
    expect(modelIds()).toEqual(['mine']);
    expect(
      logs.filter(m => m.includes('未开启模型发现')),
      `注册结果应有一行说明未开启模型发现: ${JSON.stringify(logs)}`,
    ).toHaveLength(1);
    const [entry] = app.bind({ services }).services.all(llm);
    expect(entry?.instance.refresh, '关闭模型发现后不该提供刷新').toBeUndefined();
    expect(state.shown, 'Ollama 关闭模型发现时仍要经 /api/show 探测能力').toEqual(plugin === llmOllama ? ['mine'] : []);
  });

  it.each(withoutCustom)('$name / 未配置 customModels：实例转 error，点名缺的配置', async ({ plugin, config }) => {
    const state = stubFetch('ok');
    const { app } = world();
    await app.plugin(plugin, { ...config, discoverModels: false });
    await app.plugins.idle();

    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('error');
    expect(app.plugins.getPlugin(plugin.name)?.error).toContain('缺少配置项 customModels');
    expect(state.discoveryCalls).toBe(0);
  });
});

describe('响应是 200 但不是模型列表：写明原因并带上响应摘录', () => {
  it.each(
    withoutCustom.flatMap(c => [
      { ...c, mode: 'notList' as const, excerpt: 'quota exceeded' },
      { ...c, mode: 'badItems' as const, excerpt: c.plugin === llmOllama ? '"id":"qwen3:8b"' : '"name":"gpt-4o"' },
    ]),
  )('$name / $mode', async ({ plugin, config, mode, excerpt }) => {
    stubFetch(mode);
    const { app } = world();
    await app.plugin(plugin, config);
    await app.plugins.idle();

    const instance = app.plugins.getPlugin(plugin.name);
    expect(instance?.state).toBe('error');
    expect(instance?.error).toContain('响应不是模型列表');
    expect(instance?.error, '没有带上响应摘录').toContain(excerpt);
  });

  it.each(withoutCustom)('$name / 不是 JSON：写明并带上一行摘录', async ({ plugin, config }) => {
    stubFetch('html200');
    const { app, errors } = world();
    await app.plugin(plugin, config);
    await app.plugins.idle();

    const error = app.plugins.getPlugin(plugin.name)?.error ?? '';
    expect(error).toContain('响应不是 JSON: <html> <head><title>portal</title></head> </html>');
    expect(error, '错误信息带着响应体里的换行').not.toMatch(/[\r\n]/);
    expect(errors, `应只有一条激活失败日志: ${JSON.stringify(errors)}`).toHaveLength(1);
    expect(errors[0], '激活失败日志带着响应体里的换行').not.toMatch(/[\r\n]/);
  });

  it.each(withoutCustom)('$name / 响应很长时摘录截断', async ({ plugin, config }) => {
    stubFetch('longNotList');
    const { app } = world();
    await app.plugin(plugin, config);
    await app.plugins.idle();

    const error = app.plugins.getPlugin(plugin.name)?.error ?? '';
    expect(error).toContain('响应不是模型列表');
    expect(error.endsWith('…'), '摘录没有截断').toBe(true);
    expect(error.length, `错误信息带着整段响应，长 ${error.length}`).toBeLessThan(1_000);
  });
});

const SECRET = 'PLACEHOLDER-SECRET';
const QUERY = 'PLACEHOLDER-QUERY';

describe('错误信息与日志不带 URL 里的查询串', () => {
  // plain 是 URL 规范化会改写的写法：没有路径的地址补上「/」，默认端口被去掉
  const plugins = [
    {
      name: 'llm-ollama',
      plugin: llmOllama,
      extra: {},
      scheme: 'http',
      host: '127.0.0.1:11434',
      plain: 'http://127.0.0.1:11434',
    },
    {
      name: 'llm-openai',
      plugin: llmOpenai,
      extra: { apiKey: 'k' },
      scheme: 'https',
      host: 'gw.invalid/v1',
      plain: 'https://gw.invalid:443/v1',
    },
    {
      name: 'llm-deepseek',
      plugin: deepseek,
      extra: { apiKey: 'k' },
      scheme: 'https',
      host: 'gw.invalid/v1',
      plain: 'https://gw.invalid:443/v1',
    },
  ];
  it.each(
    plugins.flatMap(p => [false, true].map(custom => ({ ...p, custom }))),
  )('$name / 发现失败 / customModels=$custom', async ({ plugin, extra, scheme, host, custom }) => {
    stubFetch('refused');
    const { app, logs } = world();
    await app.plugin(plugin, {
      ...extra,
      baseUrl: `${scheme}://${host}?key=${QUERY}`,
      ...(custom ? { customModels: 'mine' } : {}),
    });
    await app.plugins.idle();

    const instance = app.plugins.getPlugin(plugin.name);
    expect(instance?.state).toBe(custom ? 'active' : 'error');
    const reported = custom ? logs.filter(m => m.includes('启动时只注册')) : [instance?.error ?? ''];
    expect(reported, '前置：发现失败的原因没有报出来').toHaveLength(1);
    expect(reported[0]).toContain('ECONNREFUSED');
    expect(reported[0], '原因里没有 URL 的主机').toContain(host.split('/')[0]);
    for (const text of [...reported, ...logs]) expect(text).not.toContain(QUERY);
  });

  // 注册结果那行 info 与「已连接 …」的配置错误里同样写着地址
  it.each(
    plugins.flatMap(p => {
      const withQuery = `${p.scheme}://${p.host}?key=${QUERY}`;
      const noDiscovery = { discoverModels: false, customModels: 'mine' };
      return [
        { ...p, branch: '未开启模型发现', url: withQuery, config: noDiscovery, mode: 'ok' as const, chat: true },
        { ...p, branch: '已连接:', url: withQuery, config: {}, mode: 'ok' as const, chat: true },
        { ...p, branch: '未发现任何可用模型', url: withQuery, config: {}, mode: 'empty' as const, chat: true },
        ...(p.plugin === llmOllama
          ? [{ ...p, branch: '没有可用的对话模型', url: withQuery, config: {}, mode: 'ok' as const, chat: false }]
          : []),
      ];
    }),
  )('$name / $branch', async ({ plugin, extra, host, branch, url, config, mode, chat }) => {
    stubFetch(mode, chat ? ['completion'] : ['embedding']);
    const { app, logs } = world();
    await app.plugin(plugin, { ...extra, baseUrl: url, ...config });
    await app.plugins.idle();

    // 前两条分支是注册结果那行 info，后两条是实例的错误信息
    const instance = app.plugins.getPlugin(plugin.name);
    const reported = instance?.state === 'active' ? logs.filter(m => m.includes(branch)) : [instance?.error ?? ''];
    expect(reported, '前置：没有走到这条分支').toHaveLength(1);
    expect(reported[0]).toContain(branch);
    expect(reported[0], '没有写出 URL 的主机').toContain(host.split('/')[0]);
    for (const text of [...reported, ...logs]) expect(text).not.toContain(QUERY);
  });

  it.each(plugins)('$name / 没有要去掉的部分时 URL 照配置原样显示', async ({ plugin, extra, plain }) => {
    stubFetch('refused');
    const { app, logs } = world();
    await app.plugin(plugin, { ...extra, baseUrl: plain, customModels: 'mine' });
    await app.plugins.idle();

    expect(
      logs.filter(m => m.includes(`${plain}，注册`)),
      `注册结果那行没有照原样写出 ${plain}`,
    ).toHaveLength(1);
    expect(
      logs.filter(m => m.includes(`模型发现失败 ${plain}/`)),
      `发现失败的原因没有照原样写出 ${plain}`,
    ).toHaveLength(1);
  });
});

describe('baseUrl 带用户名或密码、或解析不了：读配置时抛配置错误，不发请求', () => {
  const plugins = [
    {
      name: 'llm-ollama',
      plugin: llmOllama,
      extra: {},
      scheme: 'http',
      host: '127.0.0.1:11434',
      credentialsError: 'ConfigError: baseUrl 不能带用户名或密码（user:pass@），本插件不支持带凭据访问 Ollama',
    },
    {
      name: 'llm-openai',
      plugin: llmOpenai,
      extra: { apiKey: 'k' },
      scheme: 'https',
      host: 'gw.invalid/v1',
      credentialsError: 'ConfigError: baseUrl 不能带用户名或密码（user:pass@），密钥请填在 apiKey',
    },
    {
      name: 'llm-deepseek',
      plugin: deepseek,
      extra: { apiKey: 'k' },
      scheme: 'https',
      host: 'gw.invalid/v1',
      credentialsError: 'ConfigError: baseUrl 不能带用户名或密码（user:pass@），密钥请填在 apiKey',
    },
  ];
  it.each(
    plugins.flatMap(p => [
      { ...p, form: '用户名与密码', url: `${p.scheme}://user:${SECRET}@${p.host}`, error: p.credentialsError },
      // 密钥写在用户名的位置
      { ...p, form: '只有用户名', url: `${p.scheme}://${SECRET}@${p.host}`, error: p.credentialsError },
      // 密钥写在密码的位置，用户名留空
      { ...p, form: '只有密码', url: `${p.scheme}://:${SECRET}@${p.host}`, error: p.credentialsError },
      // 特殊协议少写斜杠时 URL 解析照样补上，凭据照样在
      { ...p, form: '协议后没有斜杠', url: `${p.scheme}:user:${SECRET}@${p.host}`, error: p.credentialsError },
      // 端口非法，解析不了，无从判断有没有凭据
      {
        ...p,
        form: '解析不了且带凭据',
        url: `${p.scheme}://user:${SECRET}@gw.invalid:99999/v1`,
        error: 'ConfigError: baseUrl 不是有效的 URL',
      },
      { ...p, form: '没写协议', url: 'gw.invalid/v1', error: 'ConfigError: baseUrl 不是有效的 URL' },
    ]),
  )('$name / $form', async ({ plugin, extra, url, error }) => {
    const state = stubFetch('ok');
    const { app, logs, errors, modelIds } = world();
    // 配了 customModels：不校验 baseUrl 的话实例照常转 active，凭据随条目名称进 WebUI 的模型下拉
    await app.plugin(plugin, { ...extra, baseUrl: url, customModels: 'mine' });
    await app.plugins.idle();

    const instance = app.plugins.getPlugin(plugin.name);
    expect(instance?.state).toBe('error');
    expect(errors, `应只有一条激活失败日志: ${JSON.stringify(errors)}`).toHaveLength(1);
    expect(errors[0], '激活失败日志不是这条配置错误').toContain(error);
    expect(errors[0], '配置错误的日志不该带堆栈').not.toMatch(STACK_FRAME);
    expect(modelIds(), '不该注册任何条目').toEqual([]);
    expect(state.discoveryCalls + state.shown.length, '不该发出请求').toBe(0);
    for (const text of [instance?.error ?? '', ...logs]) expect(text).not.toContain(SECRET);
  });
});
