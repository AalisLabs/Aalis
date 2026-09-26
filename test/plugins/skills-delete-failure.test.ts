import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, services } from '../../packages/core/src/index.js';
import skillsPlugin, { type SkillsService, skills } from '../../packages/plugin-skills/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 技能删除失败要报出来：以前删不掉（根不可删、EACCES、文件锁）只记 warn，
// deleteSkill 照常移除缓存并返回 true，技能从列表消失，重扫或重启后又回来；
// removeSkillFile 返回 false，工具回「skill 不存在或文件不存在」，把权限失败说成不存在。
// 真 fs storage，data 根配成 deletable:false，删除必然失败。
// ════════════════════════════════════════════════════════════

describe('skills 删除失败（真 fs，根不可删）', () => {
  let base: string;
  let app: App;
  let svc: SkillsService;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-skills-del-'));
    mkdirSync(join(base, 'skills', 'zz-demo', 'references'), { recursive: true });
    writeFileSync(join(base, 'skills', 'zz-demo', 'SKILL.md'), '---\nname: zz-demo\ndescription: d\n---\nbody\n');
    writeFileSync(join(base, 'skills', 'zz-demo', 'references', 'a.md'), 'a');

    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugins.register(storageLocal, {
      roots: [
        {
          name: 'data',
          path: base,
          label: 'data',
          kind: 'data',
          browsable: true,
          readable: true,
          writable: true,
          deletable: false,
        },
      ],
    });
    await app.plugins.register(skillsPlugin, { skillsUri: 'data:/skills' });
    await app.plugins.idle();
    svc = app.bind({ services }).services.get(skills)!;
    await svc.rescan();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('deleteSkill 抛错，技能留在列表里，目录仍在', async () => {
    await expect(svc.deleteSkill('zz-demo')).rejects.toThrow('删除技能目录失败');
    expect(svc.getSkill('zz-demo')).toBeDefined();
    expect(existsSync(join(base, 'skills', 'zz-demo', 'SKILL.md'))).toBe(true);
  });

  it('removeSkillFile 抛错而不是返回 false（false 会被说成「不存在」）', async () => {
    await expect(svc.removeSkillFile('zz-demo', 'references/a.md')).rejects.toThrow('删除附属文件失败');
    expect(existsSync(join(base, 'skills', 'zz-demo', 'references', 'a.md'))).toBe(true);
  });
});
