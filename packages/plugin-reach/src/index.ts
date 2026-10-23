// biome-ignore lint/style/noRestrictedImports: 安装集与用户家目录取真实路径；本会话临时区按 0700 建、随会话删
import { mkdir, realpath, rm } from 'node:fs/promises';
// biome-ignore lint/style/noRestrictedImports: 拒读清单与落点按操作系统用户的家目录生成
import { homedir } from 'node:os';
import { join } from 'node:path';
import { authority } from '@aalis/api-authority';
import { type HostPaths, hostPaths } from '@aalis/api-host-paths';
import { processService } from '@aalis/api-process';
import {
  type AccessTier,
  type BoundaryPolicy,
  protectedLists,
  type Reach,
  type ReachPrincipal,
  type ReachService,
  reach,
  resolveReach,
  withRealRoots,
} from '@aalis/api-reach';
import { paperDirName, placePaperId, rootSessionOf, sessionManager } from '@aalis/api-session-manager';
import { type BoundOf, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { issueCredential } from './credential.js';
import { codeDirsOf, entryOf, formOf, gitDirOf, realRootsOf } from './host-dirs.js';
import { loginEnvs } from './process-env.js';
import { SWEEP_EVERY_MS, sessionTmpOf, sweepSessionTmp } from './session-tmp.js';

// ════════════════════════════════════════════════════════════
// plugin-reach —— 触及服务（契约见 @aalis/api-reach）
//
// 按一次工具调用签发凭据：主体取权限服务的 principalOf（类别为人亲手、这次调用的参与者都是 owner 的为 owner；续做与子任务的
// 类别随起它的那一轮，批过的调用参与者是批的人），不看会话的受众；场所与绑定取会话管理里的记录，档位与越界策略固定（工作区档、
// 越界要问），仓库的 git 目录按磁盘找，三张清单在激活时按家目录布局与真实路径算好；交给 api-reach 的 resolveReach 定上限。
// 绑定与 git 目录在签发时取好，场所每次判定时取当时的。另管本会话临时区与子进程环境。
// ════════════════════════════════════════════════════════════

/** 档位与越界策略：还不能按会话设，固定为工作区档、越界要问 */
const DEFAULT_TIER: AccessTier = 'workspace';
const DEFAULT_BOUNDARY: BoundaryPolicy = 'ask';

const uses = {
  provide,
  events,
  lifecycle,
  logger,
  /** 家目录布局：三张清单、白纸与本会话临时区都按它 */
  paths: hostPaths,
  /** 会话记录与绑定 */
  sessionManager,
  /** 这一轮的主体；缺席时谁都不是 owner，一律没有本地效果 */
  authority: optional(authority),
  /** 取 owner 的 login shell 环境；缺席时子进程用守护进程的环境 */
  process: optional(processService),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-reach',
  displayName: '触及',
  subsystem: 'authority',
  provides: [reach],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { events, lifecycle, logger } = caps;
  const sm = caps.sessionManager.use;
  const lookup = (id: string) => sm.getSession(id);

  // 清单与路径比较一律用真实路径：安装集可能经符号链接给出，用户家目录同理；清单里链接出去的根按真实路径补一份
  const given = caps.paths.use;
  const app = await realpath(given.app);
  const userHome = await realpath(homedir());
  // 业务句柄是转发句柄，展开得不到成员：在它之上只换掉 app，其余沿原型链读
  const paths: HostPaths = Object.assign(Object.create(given) as HostPaths, { app });
  const declared = protectedLists({
    paths,
    userHome,
    platform: process.platform,
    form: await formOf(app),
    codeDirs: await codeDirsOf(app),
    entry: await entryOf(),
  });
  const realRoots = await realRootsOf(declared, logger.use);
  const lists = withRealRoots(declared, root => realRoots.get(root));
  const loginEnv = loginEnvs({ process: caps.process, userHome, logger: logger.use });
  /**
   * 会话所在场所的白纸目录：白纸 id 由场所键算出，目录名与白纸插件同取 paperDirName。房间写的具名白纸只决定白纸任务用哪一块，
   * 不换这里
   */
  const paperOf = (sessionId: string) => join(paths.stage.paper, paperDirName(placePaperId(sm.placeOf(sessionId).key)));

  /** 删会话时在后台删着的临时区 */
  const deleting = new Map<string, Promise<void>>();

  /**
   * 一个会话的触及，返回每次调用都重算的函数：绑定与仓库的 git 目录（按磁盘找，异步）在这里取好；场所在每次调用时取当时的
   */
  async function reachOf(sessionId: string, principal: ReachPrincipal): Promise<() => Reach> {
    const work = rootSessionOf(sm.getSession(sessionId), lookup)?.work;
    const gitDir = work && (await gitDirOf(work.root));
    return () => {
      const paper = paperOf(sessionId);
      return resolveReach({
        principal,
        tier: DEFAULT_TIER,
        onBoundary: DEFAULT_BOUNDARY,
        // 主目录：项目工作区是绑定目录，其余是场所的白纸
        place: { home: work?.root ?? paper, paper },
        binding: work,
        gitDirs: gitDir ? [gitDir] : [],
        sessionTmp: sessionTmpOf(paths.tmp, sessionId),
        localPorts: [],
        lists,
        paths,
      });
    };
  }

  const service: ReachService = {
    async forCall(call) {
      // 这一轮的主体：权限服务不在时是 other
      const principal = caps.authority.present ? caps.authority.use.principalOf(call) : 'other';
      const credential = issueCredential(await reachOf(call.sessionId, principal), {
        userHome,
        loginEnv,
      });
      if (credential.exec !== 'none') {
        // 同一个 id 的会话删了又建：前一份还在删，先等它删完，免得删掉新建的
        await deleting.get(call.sessionId);
        await mkdir(sessionTmpOf(paths.tmp, call.sessionId), { recursive: true, mode: 0o700 });
      }
      return credential;
    },
  };

  // 删会话时在后台删它的临时区，不拖住删会话；删不掉记 warn
  events.use.on('session:deleted', sessionId => {
    const dir = sessionTmpOf(paths.tmp, sessionId);
    const done = rm(dir, { recursive: true, force: true })
      .catch(err => logger.use.warn(`删不掉会话 ${sessionId} 的临时区 ${dir}:`, err))
      .finally(() => {
        if (deleting.get(sessionId) === done) deleting.delete(sessionId);
      });
    deleting.set(sessionId, done);
  });

  // 清扫在后台排队跑，启动时的那一轮不拖住激活
  let sweeping = Promise.resolve();
  const sweep = () => {
    sweeping = sweeping
      .then(() => sweepSessionTmp(paths.tmp, lookup, Date.now(), logger.use))
      .then(removed => {
        if (removed.length > 0) logger.use.debug(`清掉 ${removed.length} 个会话的临时区`);
      })
      .catch(err => logger.use.warn('清扫本会话临时区失败:', err));
  };
  sweep();
  const sweepTimer = setInterval(sweep, SWEEP_EVERY_MS);
  sweepTimer.unref();

  lifecycle.use.onDispose(async () => {
    clearInterval(sweepTimer);
    await Promise.all([sweeping, ...deleting.values()]);
  });

  caps.provide.use(reach, service);
}
