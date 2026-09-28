import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { App, LogHub, services } from '../../packages/core/src/index.js';
import llmOpenai from '../../packages/plugin-llm-openai/src/index.js';

// ════════════════════════════════════════════════════════════
// plugin-llm-openai 读配置：parseConfig 管类型与默认值，插件自己的规则作用于它的结果。
// - timeout 以秒计，0 或负数表示不限时（换成定时器能接受的最大毫秒数）；加了引号的数字照常可用（'0' 同样不限时），
//   不是数字的值回落默认的 120 秒并告警。
// - temperature、maxTokens、contextLength 加了引号时按数字使用，不以字符串写进请求体。
// - apiKey 只在 baseUrl 是 OpenAI 官方端点时必填（空串也算没填）；别家端点不填时不发 Authorization。
// - 显式写错 baseUrl / apiKey 时不能改用默认地址或丢掉鉴权继续发请求。
// fetch 用替身，不发真实请求。
// ════════════════════════════════════════════════════════════

const GATEWAY = { apiKey: 'k', baseUrl: 'https://gw.invalid/v1' };
const UNLIMITED_MS = 2_147_483_647;
const messages = [{ role: 'user' as const, content: '在吗' }];

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** 模型发现答一个模型 m；对话请求记下请求头与请求体，答最小可用的应答 */
function stubFetch(): { sent: Sent[]; requests: string[] } {
  const sent: Sent[] = [];
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push(String(url));
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'm' }] });
      sent.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }] });
    }),
  );
  return { sent, requests };
}

async function start(config: Record<string, unknown>) {
  const { sent, requests } = stubFetch();
  const hub = new LogHub();
  const warns: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn') warns.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'info', logHub: hub });
  apps.push(app);
  await app.plugin(llmOpenai, config);
  await app.plugins.idle();
  const model = (): LLMModel => {
    const found = app.bind({ services }).services.all(llm)[0]?.instance;
    if (!found) throw new Error(`未登记模型：${app.plugins.getPlugin(llmOpenai.name)?.error}`);
    return found;
  };
  return { app, model, sent, requests, warns };
}

describe('baseUrl：缺省走官方默认；显式非法值拒绝激活', () => {
  it('未配置 baseUrl、有 apiKey 时向官方默认端点发请求', async () => {
    const { app, model, requests, sent } = await start({ apiKey: 'official-key' });
    expect(app.plugins.getPlugin(llmOpenai.name)?.state).toBe('active');
    expect(requests).toEqual(['https://api.openai.com/v1/models']);

    await model().chat({ messages });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent[0].headers.Authorization).toBe('Bearer official-key');
  });

  it.each([
    { name: '类型错误', baseUrl: { url: GATEWAY.baseUrl } },
    { name: '解析不了', baseUrl: 'not-a-url' },
    { name: '带用户名密码', baseUrl: 'https://user:pass@gw.invalid/v1' },
  ])('$name 时配置错误且不发请求', async ({ baseUrl }) => {
    const { app, requests } = await start({ apiKey: 'secret-key', baseUrl });
    expect(app.plugins.getPlugin(llmOpenai.name)?.state).toBe('error');
    expect(app.plugins.getPlugin(llmOpenai.name)?.error).toContain('baseUrl');
    expect(requests).toEqual([]);
  });

  it('自定义端点与合法密钥保持原目标和鉴权', async () => {
    const { app, model, requests, sent } = await start(GATEWAY);
    expect(app.plugins.getPlugin(llmOpenai.name)?.state).toBe('active');
    expect(requests).toEqual(['https://gw.invalid/v1/models']);

    await model().chat({ messages });
    expect(sent[0].url).toBe('https://gw.invalid/v1/chat/completions');
    expect(sent[0].headers.Authorization).toBe('Bearer k');
  });
});

describe('timeout：0 或负数不限时，加引号的数字照常可用，不是数字的回落默认', () => {
  it.each([
    { name: '未配置', timeout: undefined, ms: 120_000, warned: false },
    { name: '0', timeout: 0, ms: UNLIMITED_MS, warned: false },
    { name: '负数', timeout: -1, ms: UNLIMITED_MS, warned: false },
    { name: "'0'", timeout: '0', ms: UNLIMITED_MS, warned: false },
    { name: "'45'", timeout: '45', ms: 45_000, warned: false },
    { name: "'abc'", timeout: 'abc', ms: 120_000, warned: true },
  ])('$name', async ({ timeout, ms, warned }) => {
    const { model, warns } = await start(timeout === undefined ? GATEWAY : { ...GATEWAY, timeout });
    const armed = vi.spyOn(AbortSignal, 'timeout');
    await model().chat({ messages });

    expect(armed.mock.calls, '对话请求的超时定时器').toEqual([[ms]]);
    expect(warns).toEqual(warned ? ['配置项 timeout 期望有限数值，得到 string，改用默认值 120'] : []);
  });
});

describe('temperature、maxTokens、contextLength 加了引号时按数字使用', () => {
  it('请求没指定时请求体里取配置值，类型是数字', async () => {
    const { model, sent, warns } = await start({
      ...GATEWAY,
      temperature: '0.3',
      maxTokens: '256',
      contextLength: '64000',
    });
    await model().chat({ messages });

    expect(sent).toHaveLength(1);
    expect(sent[0].body.temperature).toBe(0.3);
    expect(sent[0].body.max_tokens).toBe(256);
    expect(model().contextLength).toBe(64000);
    expect(warns).toEqual([]);
  });
});

describe('apiKey 只在 OpenAI 官方端点必填', () => {
  it('别家端点显式写错 apiKey 类型：拒绝激活，不发无鉴权请求', async () => {
    const { app, requests } = await start({ baseUrl: GATEWAY.baseUrl, apiKey: { value: 'secret' } });
    expect(app.plugins.getPlugin(llmOpenai.name)?.state).toBe('error');
    expect(app.plugins.getPlugin(llmOpenai.name)?.error).toContain('apiKey');
    expect(requests).toEqual([]);
  });
  it('官方端点、apiKey 为空串：实例转 error，点名 apiKey', async () => {
    const { app } = await start({ baseUrl: 'https://api.openai.com/v1', apiKey: '' });

    expect(app.plugins.getPlugin(llmOpenai.name)?.state).toBe('error');
    expect(app.plugins.getPlugin(llmOpenai.name)?.error).toContain('缺少配置项 apiKey');
  });

  it('别家端点不填 apiKey：照常激活，请求不带 Authorization', async () => {
    const { model, sent } = await start({ baseUrl: GATEWAY.baseUrl });
    await model().chat({ messages });

    expect(sent).toHaveLength(1);
    expect(sent[0].headers).not.toHaveProperty('Authorization');
  });
});
