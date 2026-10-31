import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, type Logger, provide, services } from '../../packages/core/src/index.js';
import skillsPlugin, { type SkillsService, skills } from '../../packages/plugin-skills/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import type { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';
import { toolRequest } from '../fixtures/tool-call.js';
import { makeToolRegistry } from '../fixtures/tool-registry.js';

// ════════════════════════════════════════════════════════════
// 技能的设置页：过登记门槛，表格列出技能，选中一行在详情里看属性与 SKILL.md 正文；删除失败（技能不存在、目录删不掉）
// 回错误而不是当成功；技能增删后推 invalidate。表格、详情与动作报错按读者的语言（测试台不渲染，按语言渲染后比），删不掉的
// 原因经工具交给模型的照旧是原文。真 fs storage，技能在内容目录 self:/skills/ 里；删不掉的情形把技能目录整棵改成只读
// （EACCES），root 不受目录权限约束，这几条按 root 跑时跳过。
// ════════════════════════════════════════════════════════════

let base: string;
let app: App;
let pages: PageHost;
let registry: ToolRegistry;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/** 技能 zz-demo 的目录与它下面的各级目录 */
const demoDirs = (): string[] => {
  const root = join(base, 'self', 'skills', 'zz-demo');
  return [
    root,
    ...readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(e.parentPath, e.name)),
  ];
};
/** 把技能目录整棵改成只读：里面的条目删不掉 */
const lockDemo = () => {
  for (const dir of demoDirs()) chmodSync(dir, 0o555);
};
const asRoot = process.platform === 'win32' || process.getuid?.() === 0;

async function boot(): Promise<SkillsService> {
  base = mkdtempSync(join(tmpdir(), 'aalis-skills-page-'));
  mkdirSync(join(base, 'self', 'skills', 'zz-demo', 'scripts'), { recursive: true });
  writeFileSync(
    join(base, 'self', 'skills', 'zz-demo', 'SKILL.md'),
    '---\nname: zz-demo\ndescription: 演示技能\ntriggers:\n  - 演示\nlicense: MIT\n---\n# 用法\n\n照做即可\n',
  );
  writeFileSync(join(base, 'self', 'skills', 'zz-demo', 'scripts', 'run.sh'), 'echo hi');
  app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  provideHostPaths(app, base);
  pages = pageHost();
  app.bind({ provide }).provide.use(webuiServer, pages.service);
  registry = makeToolRegistry(silent);
  registry.setExecutionGuard(async () => ({ ok: true }));
  app.bind({ provide }).provide.use(tools, registry);
  await app.plugins.register(storageLocal, {});
  await app.plugins.register(skillsPlugin, {});
  await app.plugins.idle();
  const svc = app.bind({ services }).services.use.get(skills) as SkillsService;
  await svc.rescan();
  return svc;
}

afterEach(async () => {
  await app.stop();
  pages.dispose();
  if (existsSync(join(base, 'self', 'skills', 'zz-demo'))) for (const dir of demoDirs()) chmodSync(dir, 0o755);
  rmSync(base, { recursive: true, force: true });
});

describe('技能的设置页', () => {
  it('过登记门槛、放在设置里；表格一行一个技能，详情给属性（空的不列）与正文', async () => {
    await boot();
    expect(pages.logs).toEqual([]);
    expect(toSource(pages.view('skills'))).toMatchObject({ title: '技能', placement: 'settings', icon: 'sparkles' });
    expect(toSource(await pages.data('skills', 'skills'))).toEqual([
      { name: 'zz-demo', description: '演示技能', triggers: '演示', files: '脚本 1 / 引用 0 / 资源 0' },
    ]);
    expect(toSource(await pages.data('skills', 'skill', { rowKey: 'zz-demo' }))).toEqual([
      { label: '名称', value: 'zz-demo' },
      { label: '描述', value: '演示技能' },
      { label: '自动触发', value: '演示' },
      { label: '许可证', value: 'MIT' },
      { label: '位置', value: 'self:/skills/zz-demo', kind: 'code' },
      { label: '脚本', value: 'run.sh' },
    ]);
    expect(await pages.data('skills', 'body', { rowKey: 'zz-demo' })).toBe('# 用法\n\n照做即可\n');
    await expect(pages.data('skills', 'body', { rowKey: 'zz-none' })).rejects.toThrow('500');
  });

  it('删除：成功后目录不在、推 invalidate；技能不存在回错误，不当成功', async () => {
    await boot();
    const before = pages.invalidations.length;
    expect(toSource(await pages.act('skills', 'deleteSkill', { rowKey: 'zz-demo' }))).toEqual({
      status: 200,
      body: { message: '已删除技能 zz-demo' },
    });
    expect(existsSync(join(base, 'self', 'skills', 'zz-demo'))).toBe(false);
    expect(pages.invalidations.slice(before)).toContainEqual({ instance: '@aalis/plugin-skills', pageKey: 'skills' });
    expect(toSource(await pages.act('skills', 'deleteSkill', { rowKey: 'zz-demo' }))).toEqual({
      status: 500,
      body: { error: '技能 zz-demo 不存在' },
    });
  });

  it.skipIf(asRoot)('目录删不掉（文件系统拒绝）：回 500 带原因，技能留在表里', async () => {
    await boot();
    lockDemo();
    const reply = await pages.act('skills', 'deleteSkill', { rowKey: 'zz-demo' });
    expect(reply.status).toBe(500);
    expect(toSource((reply.body as { error: string }).error)).toContain('删除技能目录失败');
    expect(await pages.data('skills', 'skills')).toHaveLength(1);
  });

  it('经服务新建与重扫后推 invalidate', async () => {
    const svc = await boot();
    const before = pages.invalidations.length;
    await svc.createSkill({ name: 'zz-new', description: '新技能' });
    expect(pages.invalidations.length).toBeGreaterThan(before);
    const created = pages.invalidations.length;
    await svc.rescan();
    expect(pages.invalidations.length).toBeGreaterThan(created);
    expect((await pages.data<unknown[]>('skills', 'skills')).length).toBe(2);
  });
});

describe('技能的设置页按读者的语言', () => {
  const CASES = {
    en: {
      row: { triggers: 'zz-a, zz-b', files: 'Scripts 1 / References 1 / Assets 2' },
      missing: 'Skill zz-none does not exist',
      deleteFailed: /^Failed to delete the skill directory self:\/skills\/zz-demo: EACCES/,
    },
    'zh-CN': {
      row: { triggers: 'zz-a、zz-b', files: '脚本 1 / 引用 1 / 资源 2' },
      missing: '技能 zz-none 不存在',
      deleteFailed: /^删除技能目录失败 self:\/skills\/zz-demo: EACCES/,
    },
  };

  it.skipIf(asRoot).each(Object.entries(CASES))(
    '%s：触发词与附属文件两列，技能不存在与目录删不掉的报错',
    async (language, expected) => {
      const svc = await boot();
      await svc.updateSkill('zz-demo', {
        triggers: ['zz-a', 'zz-b'],
        files: [
          { relPath: 'references/api.md', content: '' },
          { relPath: 'assets/a.json', content: '{}' },
          { relPath: 'assets/b.json', content: '{}' },
        ],
      });
      const [row] = await pages.data<Array<{ triggers: string; files: string }>>('skills', 'skills');
      expect({ triggers: renderIn(row.triggers, language), files: renderIn(row.files, language) }).toEqual(
        expected.row,
      );
      lockDemo();
      const missing = await pages.act('skills', 'deleteSkill', { rowKey: 'zz-none' });
      expect(renderIn((missing.body as { error: string }).error, language)).toBe(expected.missing);
      const failed = await pages.act('skills', 'deleteSkill', { rowKey: 'zz-demo' });
      expect(renderIn((failed.body as { error: string }).error, language)).toMatch(expected.deleteFailed);
    },
  );

  it.skipIf(asRoot)('目录删不掉的原因经 skill_delete 交给模型的是原文', async () => {
    await boot();
    lockDemo();
    const result = await registry.execute('skill_delete', { name: 'zz-demo' }, toolRequest({ sessionId: 'zz-s' }));
    expect(JSON.parse(result.content as string).error).toMatch(/^删除技能目录失败 self:\/skills\/zz-demo: EACCES/);
  });
});
