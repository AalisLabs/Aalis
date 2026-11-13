import { afterEach, describe, expect, it } from 'vitest';
import { asr } from '../../packages/api-asr/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import asrOpenai from '../../packages/plugin-asr-openai/src/index.js';
import asrWhisper from '../../packages/plugin-asr-whisper-cpp/src/index.js';

// ════════════════════════════════════════════════════════════
// 两个 asr 插件的插件配置里没有优先级：登记时的优先级是插件里的常量（只作插件作者内部排序：本地的 whisper.cpp 在云端接口
// 之前），配置里留着旧的 priority 也不起作用。process 与 storage 是替身，只为让 whisper.cpp 激活。云端接口在 baseUrl 后面拼
// 路径，带查询串或片段的 baseUrl 读配置时就报错
// ════════════════════════════════════════════════════════════

const OPENAI = '@aalis/plugin-asr-openai';
const WHISPER = '@aalis/plugin-asr-whisper-cpp';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 登记这几个插件，返回 asr 服务的提供者按解析先后的实例 id */
async function boot(plugins: Array<[typeof asrOpenai | typeof asrWhisper, Record<string, unknown>]>) {
  const app = new App({ logLevel: 'error' });
  apps.push(app);
  const host = app.bind({ provide, services });
  host.provide.use(processService, {} as never);
  host.provide.use(storage, {} as never);
  for (const [definition, config] of plugins) await app.plugins.register(definition, config);
  await app.plugins.idle();
  for (const [{ name }] of plugins) expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  return host.services.use.inspect(asr).map(entry => entry.contextId);
}

describe('asr 提供者的优先级', () => {
  it('登记用插件里的常量：whisper.cpp 在云端接口之前，云端接口配置里留着旧的 priority 也不起作用', async () => {
    const winners = await boot([
      [asrOpenai, { apiKey: '<密钥>', priority: 999 }],
      [asrWhisper, { modelPath: '/models/ggml.bin' }],
    ]);
    expect(winners).toEqual([WHISPER, OPENAI]);
  });
});

describe('asr-openai 的 baseUrl', () => {
  // 按原文判：末尾单个问号与片段解析后查询串为空，拼出来的地址照样是坏的
  it.each([
    ['带查询串', 'https://example.test/v1?key=zz-placeholder-secret'],
    ['末尾单个问号', 'https://example.test/v1?'],
    ['带片段', 'https://example.test/v1#frag'],
  ])('%s：读配置时报错，不注册服务', async (_form, baseUrl) => {
    const app = new App({ logLevel: 'error' });
    apps.push(app);
    const host = app.bind({ provide, services });
    host.provide.use(processService, {} as never);
    host.provide.use(storage, {} as never);
    await app.plugins.register(asrOpenai, { apiKey: '<密钥>', baseUrl });
    await app.plugins.idle();

    const instance = app.plugins.getPlugin(OPENAI);
    expect(instance?.state).toBe('error');
    expect(instance?.error).toContain('baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径');
    expect(host.services.use.inspect(asr)).toEqual([]);
  });
});
