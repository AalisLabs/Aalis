import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import skillsPlugin, { type SkillsService, skills } from '../../packages/plugin-skills/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 技能的设置页：过登记门槛，表格列出技能，选中一行在详情里看属性与 SKILL.md 正文；删除失败（技能不存在、目录删不掉）
// 回错误而不是当成功；技能增删后推 invalidate。真 fs storage，技能放在自定义根 store 下。
// ════════════════════════════════════════════════════════════

let base: string;
let app: App;
let pages: PageHost;

async function boot(deletable = true): Promise<SkillsService> {
  base = mkdtempSync(join(tmpdir(), 'aalis-skills-page-'));
  mkdirSync(join(base, 'skills', 'zz-demo', 'scripts'), { recursive: true });
  writeFileSync(
    join(base, 'skills', 'zz-demo', 'SKILL.md'),
    '---\nname: zz-demo\ndescription: 演示技能\ntriggers:\n  - 演示\nlicense: MIT\n---\n# 用法\n\n照做即可\n',
  );
  writeFileSync(join(base, 'skills', 'zz-demo', 'scripts', 'run.sh'), 'echo hi');
  app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  provideHostPaths(app, base);
  pages = pageHost();
  app.bind({ provide }).provide(webuiServer, pages.service);
  await app.plugins.register(storageLocal, {
    roots: [
      {
        name: 'store',
        path: base,
        label: 'store',
        kind: 'custom',
        browsable: true,
        readable: true,
        writable: true,
        deletable,
      },
    ],
  });
  await app.plugins.register(skillsPlugin, { skillsUri: 'store:/skills' });
  await app.plugins.idle();
  const svc = app.bind({ services }).services.get(skills) as SkillsService;
  await svc.rescan();
  return svc;
}

afterEach(async () => {
  await app.stop();
  pages.dispose();
  rmSync(base, { recursive: true, force: true });
});

describe('技能的设置页', () => {
  it('过登记门槛、放在设置里；表格一行一个技能，详情给属性（空的不列）与正文', async () => {
    await boot();
    expect(pages.logs).toEqual([]);
    expect(pages.view('skills')).toMatchObject({ title: '技能', placement: 'settings', icon: 'sparkles' });
    expect(await pages.data('skills', 'skills')).toEqual([
      { name: 'zz-demo', description: '演示技能', triggers: '演示', files: '脚本 1 / 引用 0 / 资源 0' },
    ]);
    expect(await pages.data('skills', 'skill', { rowKey: 'zz-demo' })).toEqual([
      { label: '名称', value: 'zz-demo' },
      { label: '描述', value: '演示技能' },
      { label: '自动触发', value: '演示' },
      { label: '许可证', value: 'MIT' },
      { label: '位置', value: 'store:/skills/zz-demo', kind: 'code' },
      { label: '脚本', value: 'run.sh' },
    ]);
    expect(await pages.data('skills', 'body', { rowKey: 'zz-demo' })).toBe('# 用法\n\n照做即可\n');
    await expect(pages.data('skills', 'body', { rowKey: 'zz-none' })).rejects.toThrow('500');
  });

  it('删除：成功后目录不在、推 invalidate；技能不存在回错误，不当成功', async () => {
    await boot();
    const before = pages.invalidations.length;
    expect(await pages.act('skills', 'deleteSkill', { rowKey: 'zz-demo' })).toEqual({
      status: 200,
      body: { message: '已删除技能 zz-demo' },
    });
    expect(existsSync(join(base, 'skills', 'zz-demo'))).toBe(false);
    expect(pages.invalidations.slice(before)).toContainEqual({ instance: '@aalis/plugin-skills', pageKey: 'skills' });
    expect(await pages.act('skills', 'deleteSkill', { rowKey: 'zz-demo' })).toEqual({
      status: 500,
      body: { error: '技能 zz-demo 不存在' },
    });
  });

  it('目录删不掉（根不可删）：回 500 带原因，技能留在表里', async () => {
    await boot(false);
    const reply = await pages.act('skills', 'deleteSkill', { rowKey: 'zz-demo' });
    expect(reply.status).toBe(500);
    expect((reply.body as { error: string }).error).toContain('删除技能目录失败');
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
