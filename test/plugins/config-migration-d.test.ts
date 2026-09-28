import { afterEach, describe, expect, it, vi } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import cli from '../../packages/plugin-cli/src/index.js';
import commands from '../../packages/plugin-commands/src/index.js';
import { Registry as ContributionRegistry } from '../../packages/plugin-contributions/src/index.js';
import { Registry as HookRegistry } from '../../packages/plugin-hooks/src/index.js';
import office from '../../packages/plugin-office/src/index.js';
import persona from '../../packages/plugin-persona/src/index.js';
import skills from '../../packages/plugin-skills/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import todo from '../../packages/plugin-todo-list/src/index.js';
import flat from '../../packages/plugin-vectorstore-flat/src/index.js';
import lancedb from '../../packages/plugin-vectorstore-lancedb/src/index.js';

const dbConnect = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('unexpected LanceDB connect');
  }),
);
vi.mock('@lancedb/lancedb', () => ({ connect: dbConnect }));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  dbConnect.mockClear();
});

async function activate(plugin: PluginDefinition, config: Record<string, unknown>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const calls: string[] = [];
  const host = app.bind({ provide });
  host.provide(storage, {
    listRoots: () => [{ name: 'data', readable: true, writable: true, deletable: true }],
    readFile: async (uri: string) => {
      calls.push(`read:${uri}`);
      throw new Error('fake storage is empty');
    },
    resolveLocalPath: async (uri: string) => {
      calls.push(`resolve:${uri}`);
      return '/tmp/fake-db';
    },
  } as never);
  host.provide(tools, {
    registerGroup: () => {
      calls.push('registerGroup');
      return () => {};
    },
    register: () => {
      calls.push('registerTool');
      return () => {};
    },
  } as never);
  host.provide(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} } as never);
  host.provide(hooks, new HookRegistry());
  host.provide(contributions, new ContributionRegistry());
  await app.plugin(plugin, config);
  await app.plugins.idle();
  return { entry: app.plugins.getPlugin(plugin.name), calls };
}

describe('批 D：配置解析先于资源访问与工具注册', () => {
  it.each([
    { plugin: cli, config: { sessionId: {} }, field: 'sessionId' },
    { plugin: commands, config: { commandPrefix: [] }, field: 'commandPrefix' },
    { plugin: persona, config: { personasDir: [] }, field: 'personasDir' },
    { plugin: skills, config: { skillsUri: [] }, field: 'skillsUri' },
    { plugin: subtask, config: { enabled: 'false' }, field: 'enabled' },
    { plugin: todo, config: { enabled: 'false' }, field: 'enabled' },
    { plugin: flat, config: { path: [] }, field: 'path' },
    { plugin: lancedb, config: { path: [] }, field: 'path' },
    { plugin: office, config: { outputDir: [] }, field: 'outputDir' },
  ])('$plugin.name：显式无效 $field 拒绝激活', async ({ plugin, config, field }) => {
    const { entry, calls } = await activate(plugin, config);
    expect(entry?.state).toBe('error');
    expect(entry?.error).toContain(field);
    expect(calls).toEqual([]);
    expect(dbConnect).not.toHaveBeenCalled();
  });

  it('Office 空输出目录沿用默认 URI，分组开关仍生效', async () => {
    const { entry, calls } = await activate(office, {
      outputDir: '',
      docx: { enabled: false },
      xlsx: { enabled: false },
      pptx: { enabled: false },
      pdf: { enabled: false },
    });
    expect(entry?.state).toBe('active');
    expect(calls).toEqual(['registerGroup']);
  });

  it('Flat 旧相对路径仍归一到相同 storage URI', async () => {
    const { entry, calls } = await activate(flat, { path: 'data/vectorstore' });
    expect(entry?.state).toBe('active');
    expect(calls).toContain('read:data:/vectorstore/vectors.json');
    expect(dbConnect).not.toHaveBeenCalled();
  });

  it('CLI help 启动视图仍是静态可选值', async () => {
    const { entry } = await activate(cli, { startupView: 'help', maxLogEntries: '0' });
    expect(entry?.state).toBe('active');
  });

  it.each([
    { plugin: skills, config: { skillsUri: 'data/skills' }, field: 'skillsUri' },
    { plugin: lancedb, config: { tableName: '' }, field: 'tableName' },
    { plugin: office, config: { docx: { enabled: 'false' } }, field: 'docx.enabled' },
  ])('$plugin.name：后置语义与分组开关拒绝无效值', async ({ plugin, config, field }) => {
    const { entry, calls } = await activate(plugin, config);
    expect(entry?.state).toBe('error');
    expect(entry?.error).toContain(field);
    expect(calls).toEqual([]);
    expect(dbConnect).not.toHaveBeenCalled();
  });
});
