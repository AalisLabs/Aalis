import { afterEach, describe, expect, it, vi } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { sessionHistory } from '../../packages/api-session-history/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import draw from '../../packages/plugin-draw/src/index.js';
import codeRunner from '../../packages/plugin-tool-code-runner/src/index.js';
import onebotTools from '../../packages/plugin-tool-onebot/src/index.js';
import toolSystem from '../../packages/plugin-tool-system/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';

// 只装服务替身以满足激活依赖；不提供实际进程、文件或网络操作能力，也不调用工具 handler。
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function start(
  plugin: typeof codeRunner | typeof toolSystem | typeof draw | typeof onebotTools,
  config: Record<string, unknown>,
) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const host = app.bind({ provide });
  const registry = new ToolRegistry(app.logger);
  const registerTool = vi.spyOn(registry, 'register');
  const registerGroup = vi.spyOn(registry, 'registerGroup');
  const registerChecker = vi.fn(() => () => {});
  host.provide(tools, registry);
  host.provide(sessionHistory, { registerAccessChecker: registerChecker } as never);
  if (plugin === codeRunner) {
    host.provide(storage, {} as never);
    host.provide(processService, {} as never);
  }
  await app.plugin(plugin, config);
  await app.plugins.idle();
  return {
    state: app.plugins.getStatus().find(p => p.instanceId === plugin.name),
    registry,
    registerTool,
    registerGroup,
    registerChecker,
  };
}

describe('执行工具配置边界', () => {
  it.each([
    { python: { interpreter: false } },
    { python: { enabled: 'false' } },
    { sandbox: { mode: 'unknown' } },
    { sandbox: { network: ['allow'] } },
    { workingDirectory: {} },
  ])('code-runner 的坏执行配置在注册工具前拒绝：%j', async config => {
    const { state, registerTool, registerGroup } = await start(codeRunner, config);
    expect(state?.state).toBe('error');
    expect(state?.error).toContain('配置项');
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it.each([
    { file: { allowedRoots: ['workspace', true] } },
    { file: { enabled: 'false' } },
    { shell: { enabled: 1 } },
    { workingDirectory: [] },
  ])('tool-system 的坏访问配置拒绝激活：%j', async config => {
    const { state, registerTool, registerGroup } = await start(toolSystem, config);
    expect(state?.state).toBe('error');
    expect(state?.error).toContain('配置项');
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it.each([
    { executablePath: false },
    { headless: 'false' },
  ])('draw 的坏浏览器配置在引擎构造前拒绝：%j', async config => {
    const { state, registerTool, registerGroup } = await start(draw, config);
    expect(state?.state).toBe('error');
    expect(state?.error).toContain('配置项');
    expect(state?.error).toContain(Object.keys(config)[0]);
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it('draw 合法配置可激活并登记绘图工具', async () => {
    const { state, registry, registerTool, registerGroup } = await start(draw, { headless: true });
    expect(state?.state).toBe('active');
    expect(registerGroup).toHaveBeenCalled();
    expect(registerTool).toHaveBeenCalled();
    expect(registry.getAll().map(tool => tool.name)).toContain('draw_image');
  });

  it.each([
    { groupManagement: { enabled: 'false' } },
    { sessionHistory: { allowCrossPrivate: 'false' } },
  ])('OneBot 的坏工具或历史访问开关拒绝激活：%j', async config => {
    const { state, registerTool, registerGroup, registerChecker } = await start(onebotTools, config);
    expect(state?.state).toBe('error');
    expect(state?.error).toContain('配置项');
    expect(state?.error).toContain(Object.keys(config)[0]);
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerGroup).not.toHaveBeenCalled();
    expect(registerChecker).not.toHaveBeenCalled();
  });

  it('OneBot 合法配置可激活并注册会话历史访问规则', async () => {
    const { state, registerChecker } = await start(onebotTools, {
      sessionHistory: { allowCrossPrivate: false },
    });
    expect(state?.state).toBe('active');
    expect(registerChecker).toHaveBeenCalledOnce();
  });
});
