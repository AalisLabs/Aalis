import { describe, expect, it } from 'vitest';
import { App, type Logger } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// 第一方插件之间互为 optional 依赖是常态（agent 用 session-manager 解析会话配置，session-manager 用
// agent 中止回合）。optional 的契约本来就是「缺席也能工作」，这种环按自然次序让步即可，
// 不该在每次正常关停时告警——告警留给环里全是 required 边、确实无从保证的情形。

function recordingLogger(lines: string[]): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
    child: () => logger,
  };
  return logger;
}

describe('标准第一方组合的关停', () => {
  it('互为 optional 依赖的插件正常关停，不报依赖成环', async () => {
    const lines: string[] = [];
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger: recordingLogger(lines) });
    await app.plugin(createMockLLMPlugin({ responses: [{ content: 'ok' }] }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(gatewayPlugin, {});
    await app.plugin(commandsPlugin, {});
    await app.plugin(sessionManagerPlugin, {});
    await app.plugin(agentPlugin, { systemPrompt: 'test bot', preferredModel: '' });
    await app.plugins.idle();
    for (const id of ['@aalis/plugin-agent', '@aalis/plugin-session-manager', '@aalis/plugin-gateway']) {
      expect(app.plugins.getPlugin(id)?.state, id).toBe('active');
    }

    await app.stop();

    expect(lines.filter(line => line.includes('依赖成环'))).toEqual([]);
  });
});
