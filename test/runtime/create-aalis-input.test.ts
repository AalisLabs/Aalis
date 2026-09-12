import { describe, expect, it } from 'vitest';
import { parseIndexSelection, positionalArgs, validateNpmName } from '../../packages/create-aalis/src/cli.js';
import {
  parseYesNo,
  renderIndexTs,
  validateNpmName as validatePluginName,
} from '../../packages/create-aalis-plugin/src/cli.js';

// ════════════════════════════════════════════════════════════
// create-aalis / create-aalis-plugin — 交互输入校验（纯函数）
// 覆盖用户报告的「打错也过闸」类问题：1,2 / 1, 2 / 1 2 等价；字母/越界/重复/单选多填都报错重问。
// ════════════════════════════════════════════════════════════

describe('parseIndexSelection（序号选择，兼容逗号/空格）', () => {
  it('逗号、逗号+空格、纯空格三种分隔等价', () => {
    expect(parseIndexSelection('1,2', 3, 'multi')).toEqual({ ok: true, indices: [1, 2] });
    expect(parseIndexSelection('1, 2', 3, 'multi')).toEqual({ ok: true, indices: [1, 2] });
    expect(parseIndexSelection('1 2', 3, 'multi')).toEqual({ ok: true, indices: [1, 2] });
    expect(parseIndexSelection('  1 ,  2 ', 3, 'multi')).toEqual({ ok: true, indices: [1, 2] });
  });

  it('空串 → ok 且空数组（空=默认/不选 的语义留给调用方）', () => {
    expect(parseIndexSelection('', 3, 'multi')).toEqual({ ok: true, indices: [] });
    expect(parseIndexSelection('   ', 3, 'multi')).toEqual({ ok: true, indices: [] });
  });

  it('含字母/符号 → 报错（不再静默吞，正是用户报的 bug）', () => {
    expect(parseIndexSelection('sidhu', 3, 'multi').ok).toBe(false);
    expect(parseIndexSelection('1,2sa', 3, 'multi').ok).toBe(false); // token "2sa" 非纯数字
    expect(parseIndexSelection('1.5', 3, 'multi').ok).toBe(false);
    expect(parseIndexSelection('1;2', 3, 'multi').ok).toBe(false); // 分号不是分隔符 → "1;2" 非纯数字
    expect(parseIndexSelection('-1', 3, 'multi').ok).toBe(false);
  });

  it('越界 → 报错并指出范围', () => {
    const r = parseIndexSelection('1,100', 3, 'multi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('1-3');
    expect(parseIndexSelection('0', 3, 'multi').ok).toBe(false);
  });

  it('重复序号 → 报错', () => {
    expect(parseIndexSelection('1,1', 3, 'multi').ok).toBe(false);
    expect(parseIndexSelection('2 2', 3, 'multi').ok).toBe(false);
  });

  it('exclusive 单选：恰好一个 ok；多填报错（旧实现是静默取首个）', () => {
    expect(parseIndexSelection('2', 3, 'exclusive')).toEqual({ ok: true, indices: [2] });
    expect(parseIndexSelection('1,2', 3, 'exclusive').ok).toBe(false);
  });
});

describe('validateNpmName（create-aalis 项目名 = 生成 package.json name）', () => {
  it('合法名通过', () => {
    for (const n of ['my-bot', 'my_bot', 'bot123', 'a', '@scope/my-plugin', '123', 'a.b-c_d']) {
      expect(validateNpmName(n), n).toEqual({ ok: true });
    }
  });

  it('大写 / 空格 / 空 → 报错（旧宽松正则会放行 MyBot）', () => {
    expect(validateNpmName('MyBot').ok).toBe(false); // 大写
    expect(validateNpmName('my bot').ok).toBe(false); // 空格
    expect(validateNpmName('').ok).toBe(false); // 空
  });

  it('以 . 或 _ 开头 / 非法 scope / 怪字符 → 报错', () => {
    expect(validateNpmName('.hidden').ok).toBe(false);
    expect(validateNpmName('_x').ok).toBe(false);
    expect(validateNpmName('@./../').ok).toBe(false);
    expect(validateNpmName('@scope/').ok).toBe(false);
    expect(validateNpmName('a~b').ok).toBe(false);
    expect(validateNpmName('a'.repeat(215)).ok).toBe(false); // >214
  });
});

describe('create-aalis-plugin: validateNpmName 与 create-aalis 行为一致', () => {
  it('同样规则（刻意双份零依赖实现，须同步）', () => {
    for (const n of ['my-plugin', 'MyPlugin', 'my plugin', '@scope/p', '@bad scope/p', '']) {
      expect(validatePluginName(n).ok, n).toBe(validateNpmName(n).ok);
    }
  });
});

describe('parseYesNo（create-aalis-plugin 的 askYesNo 核心；修「No 默认下打 y 无效」bug）', () => {
  it('空 → 默认值', () => {
    expect(parseYesNo('', true)).toBe(true);
    expect(parseYesNo('  ', false)).toBe(false);
  });

  it('默认为 false（如「注册斜杠命令？」）时，输入 y/yes 必须能开启（旧实现返回 false = 关，bug）', () => {
    expect(parseYesNo('y', false)).toBe(true);
    expect(parseYesNo('yes', false)).toBe(true);
    expect(parseYesNo('Y', false)).toBe(true);
  });

  it('默认为 true 时，输入 n/no 必须能关闭', () => {
    expect(parseYesNo('n', true)).toBe(false);
    expect(parseYesNo('no', true)).toBe(false);
  });

  it('无法识别 → null（调用方重问）', () => {
    expect(parseYesNo('maybe', true)).toBeNull();
    expect(parseYesNo('1abc', true)).toBeNull();
  });
});

// ── create-aalis：argv 位置参数（取值 flag 的值不得被当项目名）─────────────
describe('positionalArgs（flag 取值不当位置参数）', () => {
  it('`--tier full my-bot` 的位置参数只有 my-bot（旧实现拿 full 当项目名、丢弃 my-bot）', () => {
    expect(positionalArgs(['--tier', 'full', 'my-bot'])).toEqual(['my-bot']);
  });

  it('`--registry <url> my-bot` 不再把 url 当项目名（旧实现报「非法项目名」）', () => {
    expect(positionalArgs(['--registry', 'https://registry.example.com/', 'my-bot'])).toEqual(['my-bot']);
  });

  it('布尔 flag 不吞后面的 token', () => {
    expect(positionalArgs(['--yes', 'my-bot'])).toEqual(['my-bot']);
    expect(positionalArgs(['my-bot', '--force', '--no-install'])).toEqual(['my-bot']);
    expect(positionalArgs(['-y', 'my-bot', '--tier', 'minimal'])).toEqual(['my-bot']);
  });

  it('`--tier=full` 写法不影响位置参数；纯 flag 时无位置参数', () => {
    expect(positionalArgs(['--tier=full', 'my-bot'])).toEqual(['my-bot']);
    expect(positionalArgs(['--yes'])).toEqual([]);
  });
});

// ── create-aalis-plugin：生成的 src/index.ts 形状自检行 ────────────────────
describe('renderIndexTs 的 _shape 形状自检', () => {
  const answers = (webui: boolean) => ({
    packageName: 'aalis-plugin-demo',
    displayName: '演示',
    features: { tool: true, command: false, webui },
  });

  it('勾 WebUI 时 _shape 不含 webuiPages（该字段已从 PluginModule 移除，写进去生成的项目 TS2353 编译不过）', () => {
    const src = renderIndexTs(answers(true));
    expect(src).toContain('const _shape: PluginModule = { name, displayName, inject, apply, actions };');
    expect(src).not.toMatch(/_shape[^\n]*webuiPages/);
    // 页面本身仍生成，经 registerPage 注册（不是把注册也删了）
    expect(src).toContain('for (const page of webuiPages) webui.registerPage(page);');
  });

  it('不勾 WebUI 时 _shape 只有四个字段', () => {
    expect(renderIndexTs(answers(false))).toContain(
      'const _shape: PluginModule = { name, displayName, inject, apply };',
    );
  });
});
