import { describe, expect, it } from 'vitest';
import {
  ACCESS_TIERS,
  isReachCredential,
  judgeReach,
  REACH_CREDENTIAL,
  type ReachInput,
  type ReachRequest,
} from '../../packages/api-reach/src/index.js';
import { codeOf, DEFAULT_PLACE, PATHS, PROJECT, reachOf, SESSION_TMP } from '../fixtures/reach.js';

// ════════════════════════════════════════════════════════════
// 触及：先按主体定上限，再按档位收窄。
// 主体是 owner 的一轮有本地效果，不看会话；读是全机减拒读清单，与档位无关；写、执行、联网按档位。
// 判定的短码见 fixtures/reach.ts 的 codeOf。四列依次是只读、修改确认、工作区、全权。
// ════════════════════════════════════════════════════════════

const A = 'allow';
const AL = 'allow:landing';
const T = 'ask:tier';
const W = 'ask:write-path';
const H = 'ask:host-exec';
const N = 'ask:network';
const L = 'ask:landing';
const C = 'deny:control-plane';
const R = 'deny:deny-read';
const NONE = 'deny:no-local-effect';

type Row = [label: string, request: ReachRequest, readonly: string, confirm: string, workspace: string, full: string];

const write = (path: string): ReachRequest => ({ effect: 'write', path });
const read = (path: string): ReachRequest => ({ effect: 'read', path });
const URL: ReachRequest = { effect: 'network', via: 'url' };
const COMMAND_NET: ReachRequest = { effect: 'network', via: 'command' };
const PROVIDER: ReachRequest = { effect: 'network', via: 'provider' };
const SANDBOX_EXEC: ReachRequest = { effect: 'exec', host: false };
const HOST_EXEC: ReachRequest = { effect: 'exec', host: true };
const WORKFLOW: ReachRequest = { effect: 'write', workflow: 'daily' };

/** 每一行在四档下各判一次，与表里的四列逐列比对 */
function expectRows(rows: Row[], input: Partial<ReachInput>) {
  const got = rows.map(([label, request]) => [
    label,
    ...ACCESS_TIERS.map(tier => codeOf(judgeReach(reachOf({ ...input, tier }), request))),
  ]);
  expect(got).toEqual(rows.map(([label, , ...want]) => [label, ...want]));
}

describe('上限：只按主体', () => {
  const cases: Array<[ReachInput['principal'], boolean]> = [
    ['owner', true],
    ['other', false],
  ];

  it.each(cases)('%s：有本地效果为 %s', (principal, local) => {
    for (const tier of ACCESS_TIERS) {
      const reach = reachOf({ principal, tier });
      expect(reach.exec !== 'none').toBe(local);
      if (local) continue;
      // 没有本地效果：读写执行一律拒；联网交给资格轴，这里放行
      expect(
        [
          read(`${DEFAULT_PLACE.home}/a.md`),
          write(`${DEFAULT_PLACE.home}/a.md`),
          SANDBOX_EXEC,
          HOST_EXEC,
          WORKFLOW,
        ].map(request => codeOf(judgeReach(reach, request))),
      ).toEqual([NONE, NONE, NONE, NONE, NONE]);
      expect([URL, COMMAND_NET, PROVIDER].map(request => codeOf(judgeReach(reach, request)))).toEqual([A, A, A]);
      expect(reach).toEqual({ exec: 'none' });
    }
  });

  it('命令在哪执行：只读与工作区在沙箱里，修改确认与全权在宿主上；带出场所的主目录', () => {
    const exec = ACCESS_TIERS.map(tier => reachOf({ tier, ...PROJECT }).exec);
    expect(exec).toEqual(['sandbox', 'host', 'sandbox', 'host']);
    expect(reachOf(PROJECT)).toMatchObject({ home: '/u/code/proj' });
    expect(reachOf()).toMatchObject({ home: PATHS.workspace });
    expect(Object.keys(reachOf(PROJECT)).sort()).toEqual(
      ['exec', 'tier', 'onBoundary', 'home', 'sessionTmp', 'workRoots', 'writable', 'localPorts', 'lists'].sort(),
    );
  });
});

describe('读：全机减拒读清单，与档位无关', () => {
  const allowed = [
    '/u/code/proj/src/a.ts',
    '/u/elsewhere/x',
    `${PATHS.workspace}/x`, // 默认工作区：项目会话也读得到
    `${PATHS.self}/skills/s/SKILL.md`,
    `${PATHS.self}/workflow/daily.yaml`,
    `${SESSION_TMP}/x`,
    `${PATHS.logs}/latest.log`,
    PATHS.config,
    '/opt/aalis/node_modules/x/index.js',
    '/u/code/proj/.env.example',
  ];
  const denied = [
    `${PATHS.state}/db`,
    PATHS.secrets,
    `${PATHS.run}/aalis.sock`,
    `${PATHS.cache}/x`,
    `${PATHS.tmp}/sessions/b3Q/x`, // 别的会话的临时区
    '/u/.aalis-dev/aalis.config.yaml', // 其他实例的家目录
    '/u/.ssh/id_ed25519',
    '/u/.aws/credentials',
    '/u/.config/google-chrome/Default/Cookies',
    '/u/code/proj/.env',
    '/u/code/proj/.env.local',
    `${DEFAULT_PLACE.home}/.env`, // 默认工作区在家目录的拒读里重新放行，.env 照样拒
  ];

  it.each(ACCESS_TIERS)('%s', tier => {
    const reach = reachOf({ tier, ...PROJECT });
    expect(allowed.filter(path => codeOf(judgeReach(reach, read(path))) !== A)).toEqual([]);
    expect(denied.filter(path => codeOf(judgeReach(reach, read(path))) !== R)).toEqual([]);
  });
});

describe('写：按档位', () => {
  it('项目工作区', () => {
    expectRows(
      [
        ['绑定目录（场所的主目录）', write('/u/code/proj/src/a.ts'), W, T, A, A],
        ['附加可写目录', write('/u/extra/x'), W, T, A, A],
        ['本会话树建的 worktree', write('/u/code/proj-wt-a/x'), W, T, A, A],
        ['仓库的 git 目录', write('/u/code/proj/.git/objects/ab/cd'), W, T, A, A],
        ['本会话临时区', write(`${SESSION_TMP}/x`), A, T, A, A],
        ['self 下的技能：落点', write(`${PATHS.self}/skills/s/SKILL.md`), L, L, L, AL],
        ['拒读不限制写', write('/u/code/proj/.env'), W, T, A, A],
        ['仓库的其他 worktree', write('/u/code/proj-wt-b/x'), W, T, W, A],
        ['范围外', write('/u/elsewhere/x'), W, T, W, A],
        ['默认工作区', write(`${PATHS.workspace}/x`), W, T, W, A],
        ['别的会话的临时区', write(`${PATHS.tmp}/sessions/b3Q/x`), W, T, W, A],
        ['其他实例的家目录', write('/u/.aalis-dev/state/x'), W, T, W, A],
        ['落点：git 钩子', write('/u/code/proj/.git/hooks/pre-commit'), L, L, L, AL],
        ['落点：git 配置', write('/u/code/proj/.git/config'), L, L, L, AL],
        ['落点：~/.gitconfig', write('/u/.gitconfig'), L, L, L, AL],
        ['落点：项目指令', write('/u/code/proj/AGENTS.md'), L, L, L, AL],
        ['宿主控制面：插件状态', write(`${PATHS.state}/x`), C, C, C, C],
        ['宿主控制面：主配置', write(PATHS.config), C, C, C, C],
        ['宿主控制面：secrets.yaml', write(PATHS.secrets), C, C, C, C],
        ['宿主控制面：日志', write(`${PATHS.logs}/latest.log`), C, C, C, C],
        ['self 下的编排定义：落点', write(`${PATHS.self}/workflow/daily.yaml`), L, L, L, AL],
        ['宿主控制面：家目录里布局以外的', write(`${PATHS.home}/zz-other/x`), C, C, C, C],
        ['宿主控制面：安装集的依赖', write('/opt/aalis/node_modules/x/index.js'), C, C, C, C],
        ['宿主控制面：安装集的构建产物', write('/opt/aalis/packages/core/dist/index.js'), C, C, C, C],
        ['宿主控制面：安装集外的插件目录', write('/opt/plugins/zz-ext/index.js'), C, C, C, C],
      ],
      PROJECT,
    );
  });

  it('伪装裸仓库要的 HEAD 是落点，仓库的 git 目录里的除外', () => {
    expectRows(
      [
        ['git 目录以外的 HEAD', write('/u/code/proj/fake/HEAD'), L, L, L, AL],
        ['.git 里的 HEAD', write('/u/code/proj/.git/HEAD'), W, T, A, A],
        ['worktree 的 HEAD', write('/u/code/proj/.git/worktrees/wt/HEAD'), W, T, A, A],
      ],
      PROJECT,
    );
  });

  it('git 目录不叫 .git（裸仓库加 worktree）：按这份触及的 git 目录补上落点，它里面的 HEAD 不算', () => {
    expectRows(
      [
        ['钩子', write('/u/code/proj.git/hooks/pre-commit'), L, L, L, AL],
        ['配置', write('/u/code/proj.git/config'), L, L, L, AL],
        ['commondir', write('/u/code/proj.git/commondir'), L, L, L, AL],
        ['worktree 的配置', write('/u/code/proj.git/worktrees/wt/config.worktree'), L, L, L, AL],
        ['worktree 的管理目录', write('/u/code/proj.git/worktrees/wt'), L, L, L, AL],
        ['子模块', write('/u/code/proj.git/modules/sub/config'), L, L, L, AL],
        ['git 目录本身', write('/u/code/proj.git'), L, L, L, AL],
        ['HEAD', write('/u/code/proj.git/HEAD'), W, T, A, A],
        ['worktree 的 HEAD', write('/u/code/proj.git/worktrees/wt/HEAD'), W, T, A, A],
        ['对象', write('/u/code/proj.git/objects/ab/cd'), W, T, A, A],
        ['git 目录以外的 HEAD', write('/u/code/elsewhere/HEAD'), L, L, L, AL],
      ],
      { place: { home: '/u/code/proj-wt' }, gitDirs: ['/u/code/proj.git'] },
    );
  });

  it('git 目录与工作树分开放（--separate-git-dir）', () => {
    expectRows(
      [
        ['配置', write('/u/gitdirs/sep/config'), L, L, L, AL],
        ['钩子', write('/u/gitdirs/sep/hooks/post-checkout'), L, L, L, AL],
        ['HEAD', write('/u/gitdirs/sep/HEAD'), W, T, A, A],
      ],
      { ...PROJECT, gitDirs: ['/u/gitdirs/sep'] },
    );
  });

  it('默认工作区：主目录是默认工作区目录，项目目录在范围外', () => {
    expectRows(
      [
        ['默认工作区目录', write(`${DEFAULT_PLACE.home}/a.md`), W, T, A, A],
        ['项目目录', write('/u/code/proj/src/a.ts'), W, T, W, A],
        ['本会话临时区', write(`${SESSION_TMP}/x`), A, T, A, A],
        ['self 下的人设：落点', write(`${PATHS.self}/persona/default.yaml`), L, L, L, AL],
      ],
      {},
    );
  });
});

describe('执行、联网与编排定义', () => {
  it('项目工作区', () => {
    expectRows(
      [
        ['沙箱内执行', SANDBOX_EXEC, A, T, A, A],
        ['宿主执行', HOST_EXEC, H, T, H, A],
        ['任意网址', URL, N, A, A, A],
        ['命令联网', COMMAND_NET, N, A, A, A],
        ['固定服务商', PROVIDER, N, A, A, A],
        ['写编排定义', WORKFLOW, W, T, A, A],
      ],
      PROJECT,
    );
  });
});

describe('越界策略为拒：只读与工作区档要问的一律直接拒，修改确认档照常问', () => {
  it('项目工作区', () => {
    expectRows(
      [
        ['范围外写', write('/u/elsewhere/x'), 'refuse:write-path', T, 'refuse:write-path', A],
        ['落点', write('/u/.gitconfig'), 'refuse:landing', L, 'refuse:landing', AL],
        ['self', write(`${PATHS.self}/skills/s/SKILL.md`), 'refuse:landing', L, 'refuse:landing', AL],
        ['宿主执行', HOST_EXEC, 'refuse:host-exec', T, 'refuse:host-exec', A],
        ['联网', URL, 'refuse:network', A, A, A],
      ],
      { ...PROJECT, onBoundary: 'deny' },
    );
  });
});

describe('凭据的品牌', () => {
  it('只认带品牌符号的对象', () => {
    expect(isReachCredential({ exec: 'host', allows: () => true })).toBe(false);
    expect(isReachCredential({ [REACH_CREDENTIAL]: false })).toBe(false);
    expect(isReachCredential(null)).toBe(false);
    expect(isReachCredential('credential')).toBe(false);
    expect(isReachCredential({ [REACH_CREDENTIAL]: true })).toBe(true);
    // 品牌符号登记在全局符号表里：进程里装了两份本包时也认得
    expect(isReachCredential({ [Symbol.for('@aalis/api-reach/credential')]: true })).toBe(true);
  });
});
