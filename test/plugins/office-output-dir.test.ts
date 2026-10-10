import { afterEach, describe, expect, it } from 'vitest';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, LogHub, provide } from '../../packages/core/src/index.js';
import office from '../../packages/plugin-office/src/index.js';

// ════════════════════════════════════════════════════════════
// office.outputDir 只接受 storage URI：裸名 / 相对路径不再转换，插件拒绝激活并在错误里给出正确写法。
// 这是配置错误，不是程序出错：激活失败日志只有一行，不带堆栈。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function activate(outputDir: string) {
  const registered: string[] = [];
  const errors: string[] = [];
  const logHub = new LogHub();
  logHub.onEntry(entry => {
    if (entry.level === 'error') errors.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'error', logHub });
  apps.push(app);
  const host = app.bind({ provide });
  host.provide.use(tools, {
    register(tool: { definition: { function: { name: string } } }) {
      registered.push(tool.definition.function.name);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide.use(storage, { listRoots: () => [] } as never);
  await app.plugins.register(office, { outputDir });
  await app.plugins.idle();
  return { entry: app.plugins.getPlugin(office.name), registered, errors };
}

describe('office outputDir', () => {
  it('storage URI 照常激活', async () => {
    const { entry, registered } = await activate('data:/docs');
    expect(entry?.state).toBe('active');
    expect(registered).toContain('doc_save');
  });

  it.each(['workspace', 'data/docs', './out'])('非 storage URI「%s」拒绝激活，不注册任何工具', async outputDir => {
    const { entry, registered, errors } = await activate(outputDir);
    expect(entry?.state).toBe('error');
    expect(entry?.error).toContain('outputDir 必须是 storage URI');
    expect(entry?.error).toContain('workspace:/');
    expect(registered).toEqual([]);
    expect(errors, '应只有一条激活失败日志').toHaveLength(1);
    expect(errors[0], '配置错误的日志不该带堆栈').not.toMatch(/\n\s+at /);
  });
});
