// biome-ignore lint/style/noRestrictedImports: 安装集与用户家目录取真实路径；本会话临时区按 0700 建、随会话删
import { mkdir, realpath, rm } from 'node:fs/promises';
// biome-ignore lint/style/noRestrictedImports: 拒读清单与落点按操作系统用户的家目录生成
import { homedir } from 'node:os';
import { join } from 'node:path';
import { authority, type OriginTurn } from '@aalis/api-authority';
import { type HostPaths, hostPaths } from '@aalis/api-host-paths';
import { processService } from '@aalis/api-process';
import {
  type AccessTier,
  type BoundaryPolicy,
  protectedLists,
  type Reach,
  type ReachService,
  reach,
  resolveReach,
} from '@aalis/api-reach';
import { roomClass, rootSessionOf, sessionManager } from '@aalis/api-session-manager';
import { createStorageGateway, storage } from '@aalis/api-storage';
import { type BoundOf, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';
import { issueCredential } from './credential.js';
import { codeDirsOf, gitDirOf } from './host-dirs.js';
import { loginEnvs } from './process-env.js';
import { openProvenance } from './provenance.js';
import { SWEEP_EVERY_MS, sessionTmpOf, sweepSessionTmp } from './session-tmp.js';

// ════════════════════════════════════════════════════════════
// plugin-reach —— 触及服务（契约见 @aalis/api-reach）
//
// 按一次工具调用签发凭据：发起类别取权限服务的 originOf（只有 owner 本人与 owner 链的延续算 owner，子任务随发起它的那一轮
// 父会话），房间类别、档位与越界策略（根会话的生效设置）、绑定取会话管理里的记录，仓库的 git 目录按磁盘找，三张清单在激活时
// 按家目录布局与真实路径算好；交给 api-reach 的 resolveReach 定上限。绑定与 git 目录在签发时取好，其余每次判定时取当时的，
// 降档与受污染对已签发的凭据立即生效。另管本会话临时区、子进程环境、污点与白纸的来源账本。
// ════════════════════════════════════════════════════════════

/** 哪一层都没设时的档位与越界策略 */
const DEFAULT_TIER: AccessTier = 'workspace';
const DEFAULT_BOUNDARY: BoundaryPolicy = 'ask';

/** 发起这一轮的主体：owner 那一轮派出的子任务随父会话实时的触及 */
type Principal = 'owner' | 'other' | (() => Reach);

const uses = {
  provide,
  events,
  lifecycle,
  logger,
  /** 家目录布局：三张清单、白纸与本会话临时区都按它 */
  paths: hostPaths,
  /** 会话记录、绑定，档位与越界策略的生效值 */
  sessionManager,
  /** 污点与来源账本落在插件数据里 */
  storage,
  /** 发起类别与 owner 判定；缺席时谁都不是 owner，一律没有本地效果 */
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
  const sm = caps.sessionManager.require();
  const lookup = (id: string) => sm.getSession(id);
  const isOwner = (platform: string, userId: string) => caps.authority.current?.isOwner(platform, userId) ?? false;

  // 清单与路径比较一律用真实路径：安装集可能经符号链接给出，用户家目录同理
  const given = caps.paths.require();
  const app = await realpath(given.app);
  const userHome = await realpath(homedir());
  const paths: HostPaths = { ...given, app };
  const lists = protectedLists({ paths, userHome, platform: process.platform, codeDirs: await codeDirsOf(app) });
  const provenance = await openProvenance(createStorageGateway(caps.storage), logger);
  const loginEnv = loginEnvs({ process: caps.process, userHome, logger });
  /** 默认工作区的白纸：场所键 workspace:default 的白纸目录（白纸 id 是 `p:` 加场所键的 base64url，目录名把 `:` 换成 `-`） */
  const defaultPaper = join(paths.stage.paper, `p-${Buffer.from('workspace:default').toString('base64url')}`);

  /** 每个会话最近一次签发凭据的那一轮的主体：子任务的任务消息发出时，据它定那条消息之后的子任务回合随谁 */
  const lastPrincipal = new Map<string, 'owner' | 'other'>();
  /** 子会话：发来最近一条任务消息的那一轮父会话的主体 */
  const spawnedBy = new Map<string, 'owner' | 'other'>();

  /**
   * 一个会话的触及，返回每次调用都重算的函数：绑定与仓库的 git 目录（按磁盘找，异步）在这里取好；档位与越界策略（子会话不读
   * 自己的，按根会话的生效设置）、房间类别、污点与子任务的父会话在每次调用时取当时的
   */
  async function reachOf(sessionId: string, platform: string, principal: Principal): Promise<() => Reach> {
    const work = rootSessionOf(sm.getSession(sessionId), lookup)?.work;
    const gitDir = work && (await gitDirOf(work.root));
    return () => {
      const info = sm.getSession(sessionId);
      const config = sm.resolveConfig(rootSessionOf(info, lookup)?.id ?? sessionId, platform);
      return resolveReach({
        principal: typeof principal === 'function' ? { subtaskOf: principal() } : principal,
        roomClass: roomClass(info, lookup, isOwner),
        tier: config.accessTier ?? DEFAULT_TIER,
        onBoundary: config.accessOnBoundary ?? DEFAULT_BOUNDARY,
        tainted: provenance.taintOf(sessionId),
        place: { home: work?.root ?? defaultPaper, paper: defaultPaper },
        binding: work,
        gitDirs: gitDir ? [gitDir] : [],
        sessionTmp: sessionTmpOf(paths.tmp, sessionId),
        othersContent: [],
        localPorts: [],
        lists,
        paths,
      });
    };
  }

  async function principalOf(call: OriginTurn): Promise<Principal> {
    const origin = caps.authority.current?.originOf(call);
    if (origin === 'subtask') {
      const parentId = sm.getSession(call.sessionId)?.parentId;
      return parentId && spawnedBy.get(call.sessionId) === 'owner'
        ? reachOf(parentId, call.platform, 'owner')
        : 'other';
    }
    const principal = origin === 'owner' || origin === 'owner-chain' ? 'owner' : 'other';
    lastPrincipal.set(call.sessionId, principal);
    return principal;
  }

  const service: ReachService = {
    async forCall(call) {
      const credential = issueCredential(await reachOf(call.sessionId, call.platform, await principalOf(call)), {
        sessionId: call.sessionId,
        papers: paths.stage.paper,
        userHome,
        loginEnv,
        record: provenance.record,
      });
      if (credential.exec !== 'none')
        await mkdir(sessionTmpOf(paths.tmp, call.sessionId), { recursive: true, mode: 0o700 });
      return credential;
    },
    markTainted: provenance.markTainted,
    provenanceOf: provenance.provenanceOf,
  };

  // 子任务插件在父会话的一轮里发出任务消息（source 为 subtask）：那一轮的主体就是这条消息之后的子任务回合的主体
  events.on('inbound:message', (msg: IncomingMessage) => {
    if (msg.source !== 'subtask' || !msg.sessionId) return;
    const parentId = sm.getSession(msg.sessionId)?.parentId;
    spawnedBy.set(msg.sessionId, (parentId && lastPrincipal.get(parentId)) || 'other');
  });
  events.on('session:deleted', async sessionId => {
    lastPrincipal.delete(sessionId);
    spawnedBy.delete(sessionId);
    await rm(sessionTmpOf(paths.tmp, sessionId), { recursive: true, force: true });
  });

  const sweep = async () => {
    const removed = await sweepSessionTmp(paths.tmp, lookup, Date.now());
    if (removed.length > 0) logger.debug(`清掉 ${removed.length} 个会话的临时区`);
  };
  await sweep().catch(err => logger.warn('清扫本会话临时区失败:', err));
  const sweepTimer = setInterval(() => {
    sweep().catch(err => logger.warn('清扫本会话临时区失败:', err));
  }, SWEEP_EVERY_MS);
  sweepTimer.unref();

  lifecycle.onDispose(async () => {
    clearInterval(sweepTimer);
    await provenance.flushed();
  });

  caps.provide(reach, service);
}
