import { afterEach, describe, expect, it, vi } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, LogHub, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import asrOpenai from '../../packages/plugin-asr-openai/src/index.js';
import whisper from '../../packages/plugin-asr-whisper-cpp/src/index.js';
import embeddingOpenai from '../../packages/plugin-embedding-openai/src/index.js';
import deepseek from '../../packages/plugin-llm-deepseek/src/index.js';
import llmOpenai from '../../packages/plugin-llm-openai/src/index.js';
import serper from '../../packages/plugin-websearch-serper/src/index.js';
import { configError, missingConfigError } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// 缺必填配置时激活失败是对的，但那是配置没填，不是程序出错：日志只打一行「ConfigError: 消息」，
// 不带堆栈（App 缺省的 DefaultLogger 对没有 stack 的错误只写名称与消息）。真正的程序错误仍带堆栈。
// fetch 用替身：缺配置的插件在发请求前就失败，替身只防万一。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  vi.unstubAllGlobals();
});

function world() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('测试不发真实请求');
    }),
  );
  const hub = new LogHub();
  const errors: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'error') errors.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'info', logHub: hub });
  apps.push(app);
  // whisper.cpp 的 process / storage 是 required：给桩，让它走到 apply 里的配置检查
  const host = app.bind({ provide });
  host.provide(processService, {} as never);
  host.provide(storage, {} as never);
  return { app, errors };
}

const STACK_FRAME = /\n\s+at /;

const cases: Array<{ name: string; plugin: PluginDefinition; config: Record<string, unknown>; field: string }> = [
  { name: 'llm-deepseek', plugin: deepseek, config: {}, field: 'apiKey' },
  {
    name: 'llm-openai（官方端点）',
    plugin: llmOpenai,
    config: { baseUrl: 'https://api.openai.com/v1' },
    field: 'apiKey',
  },
  { name: 'embedding-openai', plugin: embeddingOpenai, config: {}, field: 'apiKey' },
  { name: 'websearch-serper', plugin: serper, config: {}, field: 'apiKey' },
  { name: 'asr-openai', plugin: asrOpenai, config: {}, field: 'apiKey' },
  { name: 'asr-whisper-cpp', plugin: whisper, config: {}, field: 'modelPath' },
];

describe('缺必填配置：激活失败日志只有一行，不带堆栈', () => {
  it.each(cases)('$name', async ({ plugin, config, field }) => {
    const { app, errors } = world();
    await app.plugin(plugin, config);
    await app.plugins.idle();

    expect(app.plugins.getPlugin(plugin.name)?.state).toBe('error');
    expect(errors, `应只有一条激活失败日志，实际: ${JSON.stringify(errors)}`).toHaveLength(1);
    const [line] = errors;
    expect(line).toContain('激活失败');
    expect(line).toContain(`ConfigError: 缺少配置项 ${field}`);
    expect(line, '配置错误的日志不该带堆栈').not.toMatch(STACK_FRAME);
    expect(line.includes('\n'), `日志应只有一行: ${line}`).toBe(false);
    expect(app.plugins.getPlugin(plugin.name)?.error).toContain(`缺少配置项 ${field}`);
  });
});

describe('真正的程序错误仍带堆栈', () => {
  it('apply 抛普通 Error 时激活失败日志带堆栈帧', async () => {
    const { app, errors } = world();
    const buggy = definePlugin({
      name: 'buggy',
      apply() {
        throw new TypeError('boom');
      },
    });
    await app.plugin(buggy);
    await app.plugins.idle();

    expect(app.plugins.getPlugin('buggy')?.state).toBe('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('TypeError: boom');
    expect(errors[0], '程序错误的堆栈不能丢').toMatch(STACK_FRAME);
  });
});

describe('configError / missingConfigError', () => {
  it('name 为 ConfigError、没有 stack', () => {
    for (const err of [configError('端口非法'), missingConfigError('apiKey')]) {
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ConfigError');
      expect(err.stack).toBeUndefined();
    }
    expect(configError('端口非法').message).toBe('端口非法');
  });

  it('missingConfigError 的消息点名字段与补充说明，并说明填入后生效', () => {
    expect(missingConfigError('apiKey', '使用官方 API 时必填').message).toBe(
      '缺少配置项 apiKey（使用官方 API 时必填），在 WebUI 或配置文件中填入后生效',
    );
    expect(missingConfigError('modelPath').message).toBe('缺少配置项 modelPath，在 WebUI 或配置文件中填入后生效');
  });
});
