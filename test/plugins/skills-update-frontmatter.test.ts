import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, services } from '../../packages/core/src/index.js';
import skillsPlugin, { type SkillsService, skills } from '../../packages/plugin-skills/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// skill_update 的 frontmatter 合并次序：新值必须压过旧值。
//   反过来的话（旧 spread 在后）除 description/triggers/license 三个后置赋值外，
//   任何已存在的 frontmatter 键都改不动，而 updateSkill 仍返回 true。
//   同时钉死 name：目录名由创建时的 sanitizeFolderName(name) 决定，
//   让 frontmatter 改名会使卡片脱离自己的目录。
// 真 fs storage + 真 SKILL.md 读写，断言落盘文本。
// ════════════════════════════════════════════════════════════

const SKILL_MD = `---
name: zz-demo
description: 演示技能
compatibility: old
---

正文。
`;

describe('skills updateSkill frontmatter 合并（真 fs）', () => {
  let base: string;
  let app: App;
  let svc: SkillsService;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-skills-fm-'));
    mkdirSync(join(base, 'skills', 'zz-demo'), { recursive: true });
    writeFileSync(join(base, 'skills', 'zz-demo', 'SKILL.md'), SKILL_MD);

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
          deletable: true,
        },
      ],
    });
    await app.plugins.register(toolsPlugin, {});
    await app.plugins.register(skillsPlugin, { skillsUri: 'data:/skills' });
    await app.plugins.idle();
    svc = app.bind({ services }).services.get(skills)!;
    await svc.rescan();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  const onDisk = (): string => readFileSync(join(base, 'skills', 'zz-demo', 'SKILL.md'), 'utf-8');

  it('已存在的自定义键被新值覆盖，未提到的键保留', async () => {
    const ok = await svc.updateSkill('zz-demo', { frontmatter: { compatibility: 'new', extra: 'x' } });
    expect(ok).toBe(true);
    const text = onDisk();
    expect(text).toContain('compatibility: new');
    expect(text).not.toContain('compatibility: old');
    expect(text).toContain('extra: x');
    expect(text).toContain('description: 演示技能'); // 未提到的键不丢
    expect(svc.getSkill('zz-demo')?.description).toBe('演示技能');
  });

  it('frontmatter 里改 name 无效：名字被钉回目录对应的原名', async () => {
    const ok = await svc.updateSkill('zz-demo', { frontmatter: { name: 'zz-hijack' } });
    expect(ok).toBe(true);
    expect(onDisk()).toContain('name: zz-demo');
    expect(svc.getSkill('zz-demo')).toBeDefined();
    expect(svc.getSkill('zz-hijack')).toBeUndefined();
  });
});
