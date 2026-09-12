import { afterEach, describe, expect, it } from 'vitest';
import type { TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as agentModule from '../../packages/plugin-agent/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as messageArchiveModule from '../../packages/plugin-message-archive/src/index.js';
import { resolveSessionPlatform } from '../../packages/plugin-webui-server/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// token:request 的 platform：契约原先没有这个字段，唯一发射方（webui-server）
// 也不带，而处理器按 data.platform 解析模型与会话配置——于是预算快照绕过
// 平台 profile 层，算成另一个模型的窗口，末尾还真发一条 token:usage
// （platform 为空串），memory-summary 可据此触发一次无谓自动压缩。
// 处理器统一按 'webui' 兜底；显式传入的平台照用。
// ════════════════════════════════════════════════════════════

const AGENT_CONFIG = {
  systemPrompt: 'test',
  historyLimit: 50,
  memoryTokenBudget: 1024,
  maxToolIterations: 5,
  toolResultMaxRatio: 0.15,
  trimThresholdRatio: 1.0,
  preferredModel: '',
};

let app: App;

afterEach(async () => {
  // 纯函数用例不启动 app
  await app?.stop();
});

async function boot(): Promise<TokenUsageEvent[]> {
  app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(createMockLLMPlugin({}));
  await app.ctx.useModule(memoryInMemoryModule as never);
  await app.ctx.useModule(messageArchiveModule as never, { debugLogs: false });
  await app.ctx.useModule(agentModule as never, AGENT_CONFIG);
  const seen: TokenUsageEvent[] = [];
  app.ctx.on('token:usage', (u: TokenUsageEvent) => {
    seen.push(u);
  });
  return seen;
}

describe('resolveSessionPlatform（webui-server 发射侧的平台归属）', () => {
  // WebUI 是管理面，订阅的会话可以属于任何平台；一律报 'webui' 会让快照算到错的档上
  const known = new Set(['onebot', 'telegram']);

  it('已注册平台的会话前缀照用', () => {
    expect(resolveSessionPlatform('onebot:123456', known)).toBe('onebot');
    expect(resolveSessionPlatform('telegram:g:1', known)).toBe('telegram');
  });

  it('不带前缀的会话落回 webui（CLI 的 cli-default、webui 自己的会话）', () => {
    expect(resolveSessionPlatform('cli-default', known)).toBe('webui');
    expect(resolveSessionPlatform('webui-default', known)).toBe('webui');
  });

  it('前缀未注册为平台时落回 webui，不凭字面猜', () => {
    expect(resolveSessionPlatform('discord:9', known)).toBe('webui');
    expect(resolveSessionPlatform(':x', known)).toBe('webui');
  });
});

describe('token:request 的平台归属', () => {
  it('缺省 platform：快照按 webui 归属，不发空平台', async () => {
    const seen = await boot();
    await app.ctx.emit('token:request', { sessionId: 'webui-default' });
    expect(seen.length).toBe(1);
    expect(seen[0].platform).toBe('webui');
  });

  it('显式 platform 照用，不被兜底覆盖', async () => {
    const seen = await boot();
    await app.ctx.emit('token:request', { sessionId: 'onebot:1', platform: 'onebot' });
    expect(seen.length).toBe(1);
    expect(seen[0].platform).toBe('onebot');
  });
});
