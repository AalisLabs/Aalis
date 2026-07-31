import { describe, expect, it } from 'vitest';
import { classifyDepSpec, compareVersions, isRegistryDep, isUpgrade } from '../../packages/util-dep-spec/src/index.js';

// ════════════════════════════════════════════════════════════
// 这两组判据此前有三份实现（package-manager 的更新闸 / webui-server 的来源徽章 /
// webui-client 的勾选框），互不一致，实测出过两类线上错：
//   ① `resolved !== version` 字符串不等 → registry 的 latest 低于本地时渲染成「可更新」，
//      勾选提交后 npm 真的降级并重启（实测把 is-odd 从 3.0.1 换成 3.0.0）。
//   ② `user/repo` GitHub 简写在前端判 registry、在闸判非 registry → 出勾选框，提交后
//      整批被拒，且理由「不在根依赖中」是错的。
// 现在只剩这一份，两组用例分别钉住这两个失效面。
// ════════════════════════════════════════════════════════════

describe('classifyDepSpec（依赖声明 → 来源分档）', () => {
  it('semver 范围与 dist-tag → registry（唯一可经市场更新的一档）', () => {
    for (const spec of ['^0.9.1', '~1.2.0', '1.x', '*', 'latest', '>=0.2.0 <1.0.0', '0.9.0']) {
      expect(classifyDepSpec(spec), `${spec} 应判为 registry`).toBe('registry');
    }
  });

  it('workspace: → workspace（monorepo 实况：本仓库 @aalis/core 即 workspace:*）', () => {
    expect(classifyDepSpec('workspace:*')).toBe('workspace');
    expect(classifyDepSpec('workspace:^')).toBe('workspace');
    expect(classifyDepSpec('workspace:>=0.9.0 <1.0.0')).toBe('workspace');
  });

  it('file: / link: / portal: → link', () => {
    for (const spec of ['file:../local-plugin', 'link:../x', 'portal:../y']) {
      expect(classifyDepSpec(spec), `${spec} 应判为 link`).toBe('link');
    }
  });

  it('git / URL / user-repo 简写 → git', () => {
    for (const spec of [
      'git+ssh://git@github.com/u/r.git',
      'git+https://github.com/u/r.git',
      'github:u/r',
      'gitlab:u/r',
      'bitbucket:u/r',
      'https://x.com/a.tgz',
      // npm 的裸简写。曾被判成 registry，于是 fork 钉分支的依赖出了「可更新」勾选框，
      // 提交后被服务端闸整批否决——两份实现分岔的实测后果。
      'acme/aalis-plugin-foo',
      'user/repo',
    ]) {
      expect(classifyDepSpec(spec), `${spec} 应判为 git`).toBe('git');
    }
  });

  it('npm: 别名单独成档——它确实来自 registry，但更新会拆掉别名', () => {
    expect(classifyDepSpec('npm:other-pkg@^1')).toBe('alias');
    expect(classifyDepSpec('npm:@scope/other@1.2.3')).toBe('alias');
  });

  it('不在根 dependencies / 空声明 → transitive（市场不该动它）', () => {
    expect(classifyDepSpec(undefined)).toBe('transitive');
    expect(classifyDepSpec('')).toBe('transitive');
  });

  it('isRegistryDep 恒等于「分档为 registry」——闸与展示不可能分岔', () => {
    for (const spec of [
      '^0.9.0',
      'latest',
      'workspace:*',
      'file:../x',
      'github:u/r',
      'user/repo',
      'npm:other@^1',
      '',
      undefined,
    ]) {
      expect(isRegistryDep(spec), String(spec)).toBe(classifyDepSpec(spec) === 'registry');
    }
  });
});

describe('compareVersions / isUpgrade（版本序，堵降级）', () => {
  it('主版本段按数值比，不按字符串比', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1); // 字符串比会得出 '9' > '1'
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('prerelease 低于同号正式版，且段内按 semver §11 排序', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.9', '1.0.0-alpha.10')).toBe(-1); // 数字段按数值
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1); // 数字段 < 非数字段
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1); // 短的先耗尽者小
  });

  it('build 元数据不参与比较（semver §10）', () => {
    expect(compareVersions('1.0.0+build1', '1.0.0+build2')).toBe(0);
  });

  it('非精确版本号 → undefined，不给「看起来能比」的假答案', () => {
    expect(compareVersions('^1.0.0', '1.0.0')).toBeUndefined();
    expect(compareVersions('latest', '1.0.0')).toBeUndefined();
    expect(compareVersions(undefined, '1.0.0')).toBeUndefined();
    expect(compareVersions('1.0', '1.0.0')).toBeUndefined();
  });

  it('isUpgrade 只在严格新于时为真——同版本与降级都为假', () => {
    expect(isUpgrade('1.0.0', '1.1.0')).toBe(true);
    expect(isUpgrade('1.0.0', '1.0.0')).toBe(false);
    // 实测过的线上情形：dist-tags.latest 被回滚 tag 到旧版，字符串不等会放行并真的降级
    expect(isUpgrade('3.0.1', '3.0.0')).toBe(false);
    expect(isUpgrade('1.0.0', '1.0.0-rc.1')).toBe(false);
    expect(isUpgrade('1.0.0-rc.1', '1.0.0')).toBe(true);
  });

  it('版本号读不到 → false（宁可不给更新按钮，也不给错的）', () => {
    expect(isUpgrade(undefined, '1.0.0')).toBe(false);
    expect(isUpgrade('1.0.0', undefined)).toBe(false);
    expect(isUpgrade('workspace:*', '1.0.0')).toBe(false);
  });
});
