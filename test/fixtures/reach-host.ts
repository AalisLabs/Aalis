import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OriginTurn } from '../../packages/api-authority/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { reach } from '../../packages/api-reach/src/index.js';
import { type SessionManagerService, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type Logger, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import processLocalPlugin from '../../packages/plugin-process-local/src/index.js';
import reachPlugin from '../../packages/plugin-reach/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { hostedApp, registerFromDoc } from './app.js';
import { provideHostPaths } from './host-paths.js';
import { registerHubs } from './hubs.js';
import { fakeMemory } from './session-memory.js';

// 触及插件的测试件：一个 zz-slice2- 前缀的临时目录里放实例数据目录、安装集与操作系统用户的主目录，启动会话管理（内存替身的
// 会话表）、本地存储、本地进程、权限与触及插件。owner 是本机控制台与 onebot 的 <owner>。

export const OWNER_QQ = '99999';
export const OWNER_TURN = { platform: 'webui', userId: 'console' } as const;

/** 在项目工作区里建一个 owner 的会话，返回会话 id：工作区的目录是 workspaceRoot（缺省为绑定目录），绑定在 root 上 */
export async function projectSession(sm: SessionManagerService, root: string, workspaceRoot = root): Promise<string> {
  const { workspace } = sm.addWorkspace(workspaceRoot);
  return (await sm.createSession({ name: root }, { createdFrom: 'webui', workspace: workspace.id, work: { root } })).id;
}

/** 本会话临时区：tmp/sessions/<会话 id 的 UTF-8 十六进制> */
export const sessionTmpIn = (dataDir: string, sessionId: string) =>
  join(dataDir, 'tmp', 'sessions', Buffer.from(sessionId).toString('hex'));

/** 一轮 owner 在会话里亲手发来的回合 */
export const ownerTurn = (sessionId: string): OriginTurn => ({
  sessionId,
  ...OWNER_TURN,
  participants: [OWNER_TURN],
  inbound: {},
});

export interface ReachDirs {
  /** 临时目录本身（真实路径） */
  base: string;
  /** 实例数据目录 */
  data: string;
  /** 安装集（真实路径）；交给 host-paths 的是 appLink 时，它是链接指向的目录 */
  app: string;
  /** 操作系统用户的主目录 */
  user: string;
}

/** 建临时目录：数据目录、安装集（带 node_modules）、用户主目录 */
export function reachDirs(): ReachDirs {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'zz-slice2-reach-')));
  const dirs = { base, data: join(base, 'data'), app: join(base, 'app'), user: join(base, 'user') };
  for (const dir of [dirs.data, join(dirs.app, 'node_modules'), dirs.user]) mkdirSync(dir, { recursive: true });
  return dirs;
}

export function removeDirs(dirs: ReachDirs): void {
  rmSync(dirs.base, { recursive: true, force: true });
}

/**
 * 启动一个实例。`appPath` 是交给 host-paths 的安装集路径（缺省为 dirs.app）；`stored` 预置会话表；`logger` 接住各插件的日志。
 * 操作系统用户的主目录取 HOME：调用方先把 HOME 指到 dirs.user。交回的 paths 是交给插件的数据目录布局
 */
export async function startReach(
  dirs: ReachDirs,
  opts: { appPath?: string; stored?: Record<string, Record<string, unknown>>; logger?: Logger } = {},
) {
  const { app, store } = hostedApp(
    { owners: [{ platform: 'onebot', userId: OWNER_QQ }] },
    opts.logger ? { logger: opts.logger } : {},
  );
  await registerHubs(app);
  const paths = provideHostPaths(app, dirs.data, opts.appPath ?? dirs.app);
  const host = app.bind({ provide, events, sessionManager, reach });
  host.provide.use(memory, fakeMemory(opts.stored) as never);
  await app.plugin(storageLocalPlugin);
  await app.plugin(processLocalPlugin);
  await app.plugin(sessionManagerPlugin);
  await registerFromDoc(app, store, authorityPlugin);
  await app.plugin(reachPlugin);
  await app.plugins.idle();
  return { app, host, paths };
}
