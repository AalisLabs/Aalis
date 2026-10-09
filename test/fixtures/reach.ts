import {
  matchesRule,
  type PathRule,
  type ProtectedLists,
  protectedLists,
  type Reach,
  type ReachDecision,
  type ReachInput,
  resolveReach,
} from '../../packages/api-reach/src/index.js';
import { derivePaths } from '../../packages/runtime/src/home.js';

// 触及的纯函数只认字符串形式的真实路径，用例不碰磁盘：用户家目录 /u，实例家目录 /u/.aalis，安装集是源码形态的 /opt/aalis。

export const USER = '/u';
export const PATHS = derivePaths('/u/.aalis', '/opt/aalis');
/** 安装集以外、守护进程加载了代码的插件目录 */
export const CODE_DIR = '/opt/plugins/zz-ext';
export const LISTS = protectedLists({ paths: PATHS, userHome: USER, platform: 'linux', codeDirs: [CODE_DIR] });
export const SESSION_TMP = `${PATHS.tmp}/sessions/czE`;
export const PAPERS = PATHS.stage.paper;

/** 默认工作区：主目录就是它的白纸 */
export const DEFAULT_PLACE = { home: `${PAPERS}/p-default`, paper: `${PAPERS}/p-default` };

/** 项目工作区：主目录是绑定目录，白纸另一张；附加可写目录、本会话树建的 worktree 与仓库的 git 目录 */
export const PROJECT = {
  place: { home: '/u/code/proj', paper: `${PAPERS}/p-proj` },
  binding: { extraRoots: ['/u/extra'], worktrees: ['/u/code/proj-wt-a'] },
  gitDirs: ['/u/code/proj/.git'],
} satisfies Partial<ReachInput>;

/** owner 在受众只有 owner 的会话里、默认工作区、工作区档、干净；overrides 改其中几项 */
export function reachOf(overrides: Partial<ReachInput> = {}): Reach {
  return resolveReach({
    principal: 'owner',
    roomClass: 'owner-only',
    tier: 'workspace',
    onBoundary: 'ask',
    place: DEFAULT_PLACE,
    gitDirs: [],
    sessionTmp: SESSION_TMP,
    othersContent: [],
    localPorts: [],
    lists: LISTS,
    paths: PATHS,
    ...overrides,
  });
}

/** 判定写成一个短码，表驱动的用例按它比对：allow、allow:landing、ask:<原因>、refuse:<原因>（越界策略为拒）、deny:<规则> */
export function codeOf(decision: ReachDecision): string {
  if (decision.verdict === 'allow') return decision.landing ? 'allow:landing' : 'allow';
  if (decision.verdict === 'ask') return `ask:${reasonCode(decision.reason)}`;
  return decision.rule === 'boundary-policy' ? `refuse:${reasonCode(decision.reason)}` : `deny:${decision.rule}`;
}

function reasonCode(reason: { kind: string; target?: string }): string {
  return reason.kind === 'boundary' ? reason.target! : reason.kind;
}

/** 路径命中清单里的某一条 */
export function inList(rules: readonly PathRule[], path: string, lists: ProtectedLists = LISTS): boolean {
  return rules.some(rule => matchesRule(rule, path, lists.platform));
}
