import { describe, expect, it } from 'vitest';
import {
  judgeReach,
  matchesRule,
  type PathRule,
  type Reach,
  type SandboxPolicy,
  sandboxPolicyOf,
} from '../../packages/api-reach/src/index.js';
import { DEFAULT_PLACE, PAPERS, PATHS, PROJECT, reachOf, SESSION_TMP } from '../fixtures/reach.js';

// ════════════════════════════════════════════════════════════
// 沙箱策略只由触及生成，与工具边界同一份清单。各段的先后（后面的压过前面的）：
// - 读：默认可读 → readDeny（规则自带例外）拒 → readAllowWithin 放回 → provenanceDeny 拒；
// - 写：默认拒 → write 放 → writeDeny（落点）拒 → writeExceptions（锚定在可写根下的 node_modules、批准过的路径）放回
//   → controlDeny（宿主控制面）拒 → provenanceDeny 拒。
// 下面的 canRead、canWrite 照这个先后对一个路径求值，生成器（Seatbelt、bwrap）必须给出同样的结果。
// ════════════════════════════════════════════════════════════

const hit = (rules: readonly PathRule[], path: string) => rules.some(rule => matchesRule(rule, path, 'linux'));
const under = (roots: readonly string[], path: string) =>
  hit(
    roots.map(root => ({ path: root })),
    path,
  );

function canRead(policy: SandboxPolicy, path: string): boolean {
  let ok = !hit(policy.readDeny, path);
  if (under(policy.readAllowWithin, path)) ok = true;
  return ok && !under(policy.provenanceDeny, path);
}

function canWrite(policy: SandboxPolicy, path: string): boolean {
  let ok = under(policy.write, path);
  if (hit(policy.writeDeny, path)) ok = false;
  if (hit(policy.writeExceptions, path)) ok = true;
  if (hit(policy.controlDeny, path)) ok = false;
  return ok && !under(policy.provenanceDeny, path);
}

const WINDOW_PAPER = `${PAPERS}/p-window`;
const LEDGER_FILE = `${PAPERS}/p-proj/from-group.md`;
const OTHERS = [WINDOW_PAPER, LEDGER_FILE];

describe('只在沙箱里执行的触及才有沙箱策略', () => {
  it('没有本地效果、修改确认与全权都不生成', () => {
    for (const reach of [reachOf({ principal: 'other' }), reachOf({ tier: 'confirm' }), reachOf({ tier: 'full' })]) {
      expect(() => sandboxPolicyOf(reach)).toThrow(/沙箱/);
    }
  });
});

describe('工作区档', () => {
  const policy = sandboxPolicyOf(reachOf({ ...PROJECT, othersContent: OTHERS, localPorts: [27017, 8080] }));

  it('写：可写范围放行，落点拒，项目里的 node_modules 例外只在锚定的根下，宿主控制面排在最后', () => {
    const cases: Array<[string, boolean]> = [
      ['/u/code/proj/src/a.ts', true],
      [`${PAPERS}/p-proj/out.md`, true],
      ['/u/extra/x', true],
      ['/u/code/proj-wt-a/x', true],
      ['/u/code/proj/.git/objects/ab/cd', true],
      [`${SESSION_TMP}/x`, true],
      [`${PATHS.self.skills}/s/SKILL.md`, true],
      ['/u/code/proj-wt-b/x', false],
      ['/u/elsewhere/x', false],
      ['/u/code/proj/.git/hooks/pre-commit', false],
      ['/u/code/proj/.vscode/settings.json', false],
      ['/u/code/proj/.git/commondir', false],
      ['/u/code/proj/.git/worktrees/wt/HEAD', true],
      // 装着落点的目录本身拒写：在别处摆好整棵子树再改名到位行不通
      ['/u/code/proj/.vscode', false],
      ['/u/code/proj/.git/modules/sub', false],
      ['/u/code/proj/.git/worktrees/wt', false],
      ['/u/code/proj/node_modules/pkg/.vscode/settings.json', true],
      ['/u/code/proj/packages/a/node_modules/pkg/.husky/x', true],
      ['/u/extra/node_modules/pkg/.vscode/settings.json', true],
      [`${SESSION_TMP}/node_modules/pkg/.vscode/settings.json`, false], // 临时区不是锚定的根
      [`${PATHS.self.skills}/s/node_modules/pkg/.vscode/settings.json`, false], // 技能目录也不是
      [`${PATHS.state}/db`, false],
    ];
    expect(cases.map(([path]) => [path, canWrite(policy, path)])).toEqual(cases);
  });

  it('绑定目录就是运行中的安装集时，宿主控制面压过 node_modules 例外', () => {
    const running = sandboxPolicyOf(reachOf({ place: { home: '/opt/aalis', paper: `${PAPERS}/p-aalis` } }));
    expect(canWrite(running, '/opt/aalis/packages/core/src/index.ts')).toBe(true);
    expect(canWrite(running, '/opt/aalis/node_modules/x/.vscode/settings.json')).toBe(false);
    expect(canWrite(running, '/opt/aalis/packages/core/dist/index.js')).toBe(false);
  });

  it('git 目录不叫 .git 时按这份触及的 git 目录拒写落点，它里面的 HEAD 照常可写', () => {
    const bare = sandboxPolicyOf(
      reachOf({ place: { home: '/u/code/proj-wt', paper: `${PAPERS}/p-proj` }, gitDirs: ['/u/code/proj.git'] }),
    );
    expect(canWrite(bare, '/u/code/proj.git/hooks/pre-commit')).toBe(false);
    expect(canWrite(bare, '/u/code/proj.git/config')).toBe(false);
    expect(canWrite(bare, '/u/code/proj.git/worktrees/wt/HEAD')).toBe(true);
    expect(canWrite(bare, '/u/code/proj.git/objects/ab/cd')).toBe(true);
  });

  it('读：拒读清单，本会话临时区放回；干净回合拒读别人的内容', () => {
    const cases: Array<[string, boolean]> = [
      ['/u/code/proj/src/a.ts', true],
      [`${PATHS.logs}/latest.log`, true],
      [PATHS.config, true],
      [`${SESSION_TMP}/x`, true],
      [PATHS.secrets, false],
      [`${PATHS.tmp}/sessions/b3Q/x`, false],
      ['/u/.ssh/id_ed25519', false],
      ['/u/code/proj/.env', false],
      [`${WINDOW_PAPER}/a.md`, false],
      [LEDGER_FILE, false],
      [`${PAPERS}/p-proj/out.md`, true],
    ];
    expect(cases.map(([path]) => [path, canRead(policy, path)])).toEqual(cases);
  });

  it('来源账本里的文件在可写的白纸里，干净回合照样改不了', () => {
    expect(canWrite(policy, LEDGER_FILE)).toBe(false);
  });

  it('开网，按配置拒连本机端口；unix socket 只在可写范围与本会话临时区', () => {
    expect(policy.network).toBe('on');
    expect(policy.localPorts).toEqual([27017, 8080]);
    expect([...policy.unixSockets].sort()).toEqual(
      ['/u/code/proj', `${PAPERS}/p-proj`, '/u/extra', '/u/code/proj-wt-a', SESSION_TMP].sort(),
    );
  });
});

describe('受污染：全权以外断网，写入照常（技能目录除外，它属于送出会话）', () => {
  const policy = sandboxPolicyOf(reachOf({ ...PROJECT, othersContent: OTHERS, tainted: ['群「<群名>」'] }));

  it('断网，provenanceDeny 为空', () => {
    expect(policy.network).toBe('off');
    expect(policy.provenanceDeny).toEqual([]);
    expect(canRead(policy, `${WINDOW_PAPER}/a.md`)).toBe(true);
    expect(canWrite(policy, LEDGER_FILE)).toBe(true);
  });

  it('写入照常，技能目录不再可写', () => {
    expect(canWrite(policy, '/u/code/proj/src/a.ts')).toBe(true);
    expect(canWrite(policy, `${PAPERS}/p-proj/out.md`)).toBe(true);
    expect(canWrite(policy, `${PATHS.self.skills}/s/SKILL.md`)).toBe(false);
  });

  it('技能目录本身登记成项目工作区时同样写不了，工具边界上是送出会话要问', () => {
    const reach = reachOf({
      place: { home: PATHS.self.skills, paper: `${PAPERS}/p-skills` },
      tainted: ['群「<群名>」'],
    });
    const skill = `${PATHS.self.skills}/s/SKILL.md`;
    const policy = sandboxPolicyOf(reach);
    expect(canWrite(policy, skill)).toBe(false);
    expect(canWrite(policy, `${PATHS.self.skills}/s/node_modules/x/index.js`)).toBe(false);
    expect(judgeReach(reach, { effect: 'write', path: skill })).toEqual({
      verdict: 'ask',
      reason: { kind: 'outbound' },
    });
    // 批准过写这个技能（工具边界上是送出会话）：放回技能目录里的这一处，其下的落点照样拒写
    const approved = sandboxPolicyOf(reach, { writePaths: [`${PATHS.self.skills}/s`] });
    expect(canWrite(approved, skill)).toBe(true);
    expect(canWrite(approved, `${PATHS.self.skills}/s/.git/hooks/pre-commit`)).toBe(false);
    expect(canWrite(approved, `${PATHS.self.skills}/t/SKILL.md`)).toBe(false);
  });

  it('批准一个装着技能目录的范围外目录，技能目录不随之放回', () => {
    const policy = sandboxPolicyOf(reachOf({ ...PROJECT, tainted: ['群「<群名>」'] }), { writePaths: ['/u'] });
    expect(canWrite(policy, '/u/notes/a.md')).toBe(true);
    expect(canWrite(policy, `${PATHS.self.skills}/s/SKILL.md`)).toBe(false);
  });

  it('批准过这一条命令联网时开网', () => {
    expect(sandboxPolicyOf(reachOf({ ...PROJECT, tainted: ['群「<群名>」'] }), { network: true }).network).toBe('on');
  });
});

describe('只读档', () => {
  const policy = sandboxPolicyOf(reachOf({ ...PROJECT, tier: 'readonly' }));

  it('断网，可写只有本会话临时区，没有 node_modules 例外', () => {
    expect(policy.network).toBe('off');
    expect(policy.write).toEqual([SESSION_TMP]);
    expect(policy.writeExceptions).toEqual([]);
    expect(policy.unixSockets).toEqual([SESSION_TMP]);
    expect(canWrite(policy, '/u/code/proj/src/a.ts')).toBe(false);
  });
});

describe('批准过的提权', () => {
  it('批准过的范围外写并进可写的根，其下的落点照样拒写', () => {
    const policy = sandboxPolicyOf(reachOf(PROJECT), { writePaths: ['/u/elsewhere/repo'] });
    expect(canWrite(policy, '/u/elsewhere/repo/a.txt')).toBe(true);
    expect(canWrite(policy, '/u/elsewhere/repo/.git/hooks/pre-commit')).toBe(false);
    expect(canWrite(policy, '/u/elsewhere/repo/.git/config')).toBe(false);
  });

  it('按落点批准的只放回那一个确切路径', () => {
    const policy = sandboxPolicyOf(reachOf(PROJECT), {
      landingPaths: ['/u/code/proj/.git/config', '/u/code/proj/.vscode'],
    });
    expect(canWrite(policy, '/u/code/proj/.git/config')).toBe(true);
    expect(canWrite(policy, '/u/code/proj/.vscode')).toBe(true);
    expect(canWrite(policy, '/u/code/proj/.vscode/tasks.json')).toBe(false);
    expect(canWrite(policy, '/u/code/proj/.git/hooks/pre-commit')).toBe(false);
  });

  it('宿主控制面与别人的内容批准了也不行', () => {
    const policy = sandboxPolicyOf(reachOf({ ...PROJECT, othersContent: OTHERS }), {
      writePaths: [`${PATHS.state}/db`, LEDGER_FILE],
      landingPaths: [`${PATHS.self.workflows}/daily.yaml`],
    });
    expect(canWrite(policy, `${PATHS.state}/db`)).toBe(false);
    expect(canWrite(policy, LEDGER_FILE)).toBe(false);
    expect(canWrite(policy, `${PATHS.self.workflows}/daily.yaml`)).toBe(false);
    expect(policy.network).toBe('on');
  });
});

describe('与工具边界同源', () => {
  // 落点在工具边界上是问、在沙箱里是拒，别人的内容在工具边界上读得到（计污点），这两类不在比对之列
  const paths = [
    '/u/code/proj/src/a.ts',
    `${PAPERS}/p-proj/out.md`,
    DEFAULT_PLACE.home,
    '/u/extra/x',
    '/u/code/proj-wt-a/x',
    '/u/code/proj/.git/objects/ab/cd',
    '/u/code/proj/.git/worktrees/wt/HEAD',
    `${SESSION_TMP}/x`,
    `${PATHS.self.skills}/s/SKILL.md`,
    '/u/code/proj-wt-b/x',
    '/u/elsewhere/x',
    `${PATHS.tmp}/sessions/b3Q/x`,
    `${PATHS.state}/db`,
    PATHS.config,
    PATHS.secrets,
    `${PATHS.logs}/latest.log`,
    `${PATHS.stage.public}/x`,
    '/u/.ssh/id_ed25519',
    '/u/code/proj/.env',
    '/opt/aalis/node_modules/x/index.js',
  ];
  const reaches: Array<[string, Reach]> = [
    ['工作区', reachOf(PROJECT)],
    ['工作区·受污染', reachOf({ ...PROJECT, tainted: ['群「<群名>」'] })],
    ['只读', reachOf({ ...PROJECT, tier: 'readonly' })],
  ];

  it.each(reaches)('%s', (_, reach) => {
    const policy = sandboxPolicyOf(reach);
    const allowed = (effect: 'read' | 'write', path: string) => judgeReach(reach, { effect, path }).verdict === 'allow';
    expect(paths.filter(path => allowed('write', path) !== canWrite(policy, path))).toEqual([]);
    expect(paths.filter(path => allowed('read', path) !== canRead(policy, path))).toEqual([]);
  });
});
