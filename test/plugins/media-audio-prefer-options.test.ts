import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asr } from '../../packages/api-asr/src/index.js';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type App, type Logger, provide } from '../../packages/core/src/index.js';
import mediaPlugin from '../../packages/plugin-media/src/index.js';
import type { SchemaField } from '../../packages/schema-config/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// plugin-media 的「音频识别 → 识别后端」下拉：可选项是统一池里的音频处理器（asr 服务的各提供者，与有音频能力的模型），
// 写在配置表单的 live 对象上。媒体插件可能先于 asr、llm 的提供者激活，激活时池是空的：提供者上线、下线时随之刷新。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const notFound = (uri: string) => Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
/** data 根的存储替身：什么文件都不存在 */
const STORAGE = {
  listRoots: () => [
    { name: 'data', label: 'data', kind: 'data', browsable: true, readable: true, writable: true, deletable: true },
  ],
  async readFile(uri: string) {
    throw notFound(uri);
  },
  async list(uri: string) {
    throw notFound(uri);
  },
  async writeFile() {},
  async delete(uri: string) {
    throw notFound(uri);
  },
};

/** 下拉此刻的可选值 */
function preferOptions(): unknown[] {
  const group = mediaPlugin.configSchema?.audio as { fields: { prefer: SchemaField } };
  return (group.fields.prefer.options ?? []).map(option => option.value);
}

describe('音频识别后端的可选项', () => {
  it('随 asr 与有音频能力的模型上线、下线刷新', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zz-media-prefer-'));
    homes.push(home);
    const { app } = hostedApp({}, { logger: silent });
    apps.push(app);
    provideHostPaths(app, home);
    await registerHubs(app);
    const host = app.bind({ provide });
    host.provide.use(processService, {} as never);
    host.provide.use(storage, STORAGE as never);
    await app.plugin(mediaPlugin, {});
    await app.plugins.idle();
    expect(app.plugins.getPlugin(mediaPlugin.name)?.state).toBe('active');
    expect(preferOptions(), '激活时池是空的，只有「自动」').toEqual(['']);

    const offAsr = host.provide.use(asr, { transcribe: async () => ({ text: '' }) }, { entryId: 'whisper' });
    await tick();
    expect(preferOptions()).toEqual(['', 'asr:whisper']);

    const model = { id: 'listener', capabilities: ['chat', 'audio'], chat: async () => ({ content: '' }) };
    const offLlm = host.provide.use(llm, model as unknown as LLMModel, { entryId: 'zz/listener' });
    await tick();
    expect(preferOptions()).toEqual(['', 'llm:zz/listener#audio', 'asr:whisper']);

    offAsr();
    await tick();
    expect(preferOptions()).toEqual(['', 'llm:zz/listener#audio']);

    offLlm();
    await tick();
    expect(preferOptions()).toEqual(['']);
  });
});
