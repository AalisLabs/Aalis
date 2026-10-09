import { afterEach, describe, expect, it } from 'vitest';
import { asr } from '../../packages/api-asr/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import asrOpenai from '../../packages/plugin-asr-openai/src/index.js';
import asrWhisper from '../../packages/plugin-asr-whisper-cpp/src/index.js';

// ════════════════════════════════════════════════════════════
// 两个 asr 插件的插件配置里没有优先级：登记时的优先级是插件里的常量（只作插件作者内部排序：本地的 whisper.cpp 在云端接口
// 之前），配置里留着旧的 priority 也不起作用。process 与 storage 是替身，只为让 whisper.cpp 激活
// ════════════════════════════════════════════════════════════

const OPENAI = '@aalis/plugin-asr-openai';
const WHISPER = '@aalis/plugin-asr-whisper-cpp';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 登记这几个插件，返回 asr 服务的提供者按解析先后的实例 id */
async function boot(plugins: Array<[typeof asrOpenai | typeof asrWhisper, Record<string, unknown>]>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const host = app.bind({ provide, services });
  host.provide(processService, {} as never);
  host.provide(storage, {} as never);
  for (const [definition, config] of plugins) await app.plugins.register(definition, config);
  await app.plugins.idle();
  for (const [{ name }] of plugins) expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  return host.services.inspect(asr).map(entry => entry.contextId);
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
