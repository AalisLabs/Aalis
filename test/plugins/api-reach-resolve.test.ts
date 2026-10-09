import { describe, expect, it } from 'vitest';
import {
  ACCESS_TIERS,
  type AccessTier,
  isReachCredential,
  judgeReach,
  REACH_CREDENTIAL,
  type ReachInput,
  type ReachRequest,
} from '../../packages/api-reach/src/index.js';
import type { RoomClass, SessionConfig } from '../../packages/api-session-manager/src/index.js';
import { codeOf, DEFAULT_PLACE, PAPERS, PATHS, PROJECT, reachOf, SESSION_TMP } from '../fixtures/reach.js';

// ════════════════════════════════════════════════════════════
// 触及：先按「主体 × 房间类别」定上限，再按档位收窄、按污点把送出会话的动作改成问，子任务再与父会话实时的触及取较小值。
// 只有 owner 在受众只有 owner 的会话里有本地效果；读是全机减拒读清单，与档位无关；写、执行、联网按档位。
// 判定的短码见 fixtures/reach.ts 的 codeOf。四列依次是只读、修改确认、工作区、全权。
// ════════════════════════════════════════════════════════════

const A = 'allow';
const AL = 'allow:landing';
const T = 'ask:tier';
const W = 'ask:write-path';
const H = 'ask:host-exec';
const N = 'ask:network';
const L = 'ask:landing';
const O = 'ask:outbound';
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

const TAINTED = ['群「<群名>」'];

/** 每一行在四档下各判一次，与表里的四列逐列比对 */
function expectRows(rows: Row[], input: Partial<ReachInput>) {
  const got = rows.map(([label, request]) => [
    label,
    ...ACCESS_TIERS.map(tier => codeOf(judgeReach(reachOf({ ...input, tier }), request))),
  ]);
  expect(got).toEqual(rows.map(([label, , ...want]) => [label, ...want]));
}

describe('上限：主体 × 房间类别', () => {
  const cases: Array<[ReachInput['principal'], RoomClass, boolean]> = [
    ['owner', 'owner-only', true],
    ['owner', 'room', false],
    ['owner', 'internal', false],
    ['other', 'owner-only', false],
    ['other', 'room', false],
    ['other', 'internal', false],
  ];

  it.each(cases)('%s × %s：有本地效果为 %s', (principal, roomClass, local) => {
    for (const tier of ACCESS_TIERS) {
      const reach = reachOf({ principal, roomClass, tier });
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

  it('命令在哪执行：只读与工作区在沙箱里，修改确认与全权在宿主上；带出场所的主目录与白纸', () => {
    const exec = ACCESS_TIERS.map(tier => reachOf({ tier, ...PROJECT }).exec);
    expect(exec).toEqual(['sandbox', 'host', 'sandbox', 'host']);
    expect(reachOf(PROJECT)).toMatchObject({ home: '/u/code/proj', paper: `${PAPERS}/p-proj` });
    expect(reachOf()).toMatchObject({ home: DEFAULT_PLACE.home, paper: DEFAULT_PLACE.paper });
  });
});

describe('读：全机减拒读清单，与档位无关', () => {
  const allowed = [
    '/u/code/proj/src/a.ts',
    `${PAPERS}/p-proj/out.md`,
    '/u/elsewhere/x',
    `${PAPERS}/p-other/x`, // owner 别的工作区的白纸
    `${PAPERS}/p-window/x`, // 别人场所的白纸：文件工具读得到，计污点是别处的事
    `${PATHS.stage.public}/x`,
    `${PATHS.self.skills}/s/SKILL.md`,
    `${PATHS.self.workflows}/daily.yaml`,
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
    `${DEFAULT_PLACE.home}/.env`, // 舞台在家目录的拒读里重新放行，.env 照样拒
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
        ['项目工作区的白纸', write(`${PAPERS}/p-proj/out.md`), W, T, A, A],
        ['附加可写目录', write('/u/extra/x'), W, T, A, A],
        ['本会话树建的 worktree', write('/u/code/proj-wt-a/x'), W, T, A, A],
        ['仓库的 git 目录', write('/u/code/proj/.git/objects/ab/cd'), W, T, A, A],
        ['本会话临时区', write(`${SESSION_TMP}/x`), A, T, A, A],
        ['技能目录', write(`${PATHS.self.skills}/s/SKILL.md`), W, T, A, A],
        ['拒读不限制写', write('/u/code/proj/.env'), W, T, A, A],
        ['仓库的其他 worktree', write('/u/code/proj-wt-b/x'), W, T, W, A],
        ['范围外', write('/u/elsewhere/x'), W, T, W, A],
        ['owner 别的工作区的白纸', write(`${PAPERS}/p-other/x`), W, T, W, A],
        ['别人场所的白纸', write(`${PAPERS}/p-window/x`), W, T, W, A],
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
        ['宿主控制面：编排定义', write(`${PATHS.self.workflows}/daily.yaml`), C, C, C, C],
        ['宿主控制面：公开区', write(`${PATHS.stage.public}/x`), C, C, C, C],
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
      { place: { home: '/u/code/proj-wt', paper: `${PAPERS}/p-proj` }, gitDirs: ['/u/code/proj.git'] },
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

  it('默认工作区：主目录就是白纸，项目目录在范围外', () => {
    expectRows(
      [
        ['默认工作区的白纸', write(`${DEFAULT_PLACE.home}/a.md`), W, T, A, A],
        ['项目目录', write('/u/code/proj/src/a.ts'), W, T, W, A],
        ['本会话临时区', write(`${SESSION_TMP}/x`), A, T, A, A],
        ['技能目录', write(`${PATHS.self.skills}/s/SKILL.md`), W, T, A, A],
      ],
      {},
    );
  });
});

describe('执行、联网与编排定义', () => {
  it('干净的会话', () => {
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

describe('受污染：全权以外的档位把送出会话的动作改成问，其余照常', () => {
  it('送出会话的动作', () => {
    expectRows(
      [
        ['任意网址', URL, O, O, O, A],
        ['命令联网', COMMAND_NET, O, O, O, A],
        ['写技能目录', write(`${PATHS.self.skills}/s/SKILL.md`), O, O, O, A],
        ['写编排定义', WORKFLOW, O, O, O, A],
        ['固定服务商', PROVIDER, N, A, A, A],
        ['写白纸', write(`${PAPERS}/p-proj/out.md`), W, T, A, A],
        ['写项目', write('/u/code/proj/src/a.ts'), W, T, A, A],
        ['沙箱内执行', SANDBOX_EXEC, A, T, A, A],
        ['读别人场所的白纸', read(`${PAPERS}/p-window/x`), A, A, A, A],
      ],
      { ...PROJECT, tainted: TAINTED },
    );
  });

  it('带出读进过谁的内容；干净时不带', () => {
    expect(reachOf({ tainted: TAINTED })).toMatchObject({ tainted: TAINTED });
    expect(reachOf({ tainted: [] })).not.toHaveProperty('tainted');
  });
});

describe('越界策略为拒：只读与工作区档要问的一律直接拒，修改确认档照常问', () => {
  it('干净的会话', () => {
    expectRows(
      [
        ['范围外写', write('/u/elsewhere/x'), 'refuse:write-path', T, 'refuse:write-path', A],
        ['落点', write('/u/.gitconfig'), 'refuse:landing', L, 'refuse:landing', AL],
        ['宿主执行', HOST_EXEC, 'refuse:host-exec', T, 'refuse:host-exec', A],
        ['联网', URL, 'refuse:network', A, A, A],
      ],
      { ...PROJECT, onBoundary: 'deny' },
    );
  });

  it('受污染后的送出会话', () => {
    expectRows([['任意网址', URL, 'refuse:outbound', O, 'refuse:outbound', A]], {
      ...PROJECT,
      onBoundary: 'deny',
      tainted: TAINTED,
    });
  });
});

describe('子任务不超过父会话：随父会话实时的触及', () => {
  const subtask = (parent: ReturnType<typeof reachOf>, input: Partial<ReachInput> = {}) =>
    reachOf({ ...PROJECT, sessionTmp: `${PATHS.tmp}/sessions/Y2hpbGQ`, ...input, principal: { subtaskOf: parent } });

  it('父会话是 owner 的干净会话：子任务与它一样，写自己的临时区', () => {
    const child = subtask(reachOf(PROJECT));
    expect(child).toMatchObject({ exec: 'sandbox', tier: 'workspace' });
    expect(codeOf(judgeReach(child, write('/u/code/proj/src/a.ts')))).toBe(A);
    expect(codeOf(judgeReach(child, write(`${PATHS.tmp}/sessions/Y2hpbGQ/x`)))).toBe(A);
    expect(codeOf(judgeReach(child, URL))).toBe(A);
  });

  it('父会话受污染后子任务随之，来源合在一起', () => {
    const child = subtask(reachOf({ ...PROJECT, tainted: TAINTED }), { tainted: ['工具 recent_messages'] });
    expect(codeOf(judgeReach(child, URL))).toBe(O);
    expect(child).toMatchObject({ tainted: ['工具 recent_messages', ...TAINTED] });
  });

  it('父会话降档后子任务随之', () => {
    const child = subtask(reachOf({ ...PROJECT, tier: 'readonly' }));
    expect(child).toMatchObject({ tier: 'readonly', exec: 'sandbox' });
    expect(codeOf(judgeReach(child, write('/u/code/proj/src/a.ts')))).toBe(W);
  });

  it('父会话的越界策略为拒时子任务同样直接拒', () => {
    const child = subtask(reachOf({ ...PROJECT, onBoundary: 'deny' }));
    expect(codeOf(judgeReach(child, write('/u/elsewhere/x')))).toBe('refuse:write-path');
  });

  it('父会话没有本地效果（别人发起的那一轮），子任务也没有', () => {
    expect(subtask(reachOf({ principal: 'other' }))).toEqual({ exec: 'none' });
    expect(subtask(reachOf({ roomClass: 'room' }))).toEqual({ exec: 'none' });
  });
});

describe('会话设置的两个键', () => {
  it('档位与越界策略经 declaration merging 进 SessionConfig（由 test-types 门禁做类型检查）', () => {
    const tiers: AccessTier[] = ['readonly', 'confirm', 'workspace', 'full'];
    const config: SessionConfig = { accessTier: 'full', accessOnBoundary: 'deny' };
    // @ts-expect-error 档位只有四档
    const wrongTier: SessionConfig = { accessTier: 'admin' };
    // @ts-expect-error 越界策略只有问与拒
    const wrongPolicy: SessionConfig = { accessOnBoundary: 'allow' };
    expect([...ACCESS_TIERS]).toEqual(tiers);
    expect([config, wrongTier, wrongPolicy]).toHaveLength(3);
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
