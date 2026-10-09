import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OriginTurn } from '../../packages/api-authority/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { reach } from '../../packages/api-reach/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { events, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import processLocalPlugin from '../../packages/plugin-process-local/src/index.js';
import reachPlugin from '../../packages/plugin-reach/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { hostedApp, registerFromDoc } from './app.js';
import { provideHostPaths } from './host-paths.js';
import { registerHubs } from './hubs.js';
import { fakeMemory } from './session-memory.js';

// 触及插件的测试件：一个 zz-slice2- 前缀的临时目录里放实例家目录、安装集与操作系统用户的家目录，起会话管理（内存替身的
// 会话表）、本地存储、本地进程、权限与触及插件。owner 是本机控制台与 onebot 的 <owner>。

export const OWNER_QQ = '99999';
export const OWNER_TURN = { platform: 'webui', userId: 'console' } as const;

/** 默认工作区的白纸：场所键 workspace:default 的白纸目录 */
export const defaultPaperOf = (home: string) =>
  join(home, 'stage', 'paper', `p-${Buffer.from('workspace:default').toString('base64url')}`);

/** 本会话临时区：tmp/sessions/<会话 id 的 base64url> */
export const sessionTmpIn = (home: string, sessionId: string) =>
  join(home, 'tmp', 'sessions', Buffer.from(sessionId).toString('base64url'));

/** 一轮 owner 在会话里亲手发来的回合 */
export const ownerTurn = (sessionId: string): OriginTurn => ({ sessionId, ...OWNER_TURN, inbound: {} });

export interface ReachDirs {
  /** 临时目录本身（真实路径） */
  base: string;
  /** 实例家目录 */
  home: string;
  /** 安装集（真实路径）；交给 host-paths 的是 appLink 时，它是链接指向的目录 */
  app: string;
  /** 操作系统用户的家目录 */
  user: string;
}

/** 建临时目录：家目录、安装集（带 node_modules）、用户家目录 */
export function reachDirs(): ReachDirs {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'zz-slice2-reach-')));
  const dirs = { base, home: join(base, 'home'), app: join(base, 'app'), user: join(base, 'user') };
  for (const dir of [dirs.home, join(dirs.app, 'node_modules'), dirs.user]) mkdirSync(dir, { recursive: true });
  return dirs;
}

export function removeDirs(dirs: ReachDirs): void {
  rmSync(dirs.base, { recursive: true, force: true });
}

/** 预置一份污点与来源记录（插件数据里的文件），要在起实例之前写 */
export function seedProvenance(dirs: ReachDirs, content: string): void {
  const dir = join(dirs.home, 'state', 'plugins', 'reach');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'provenance.json'), content);
}

/**
 * 起一个实例。`appPath` 是交给 host-paths 的安装集路径（缺省为 dirs.app）；`stored` 预置会话表。
 * 操作系统用户的家目录取 HOME：调用方先把 HOME 指到 dirs.user
 */
export async function startReach(
  dirs: ReachDirs,
  opts: { appPath?: string; stored?: Record<string, Record<string, unknown>> } = {},
) {
  const { app, store } = hostedApp({ owners: [{ platform: 'onebot', userId: OWNER_QQ }] });
  await registerHubs(app);
  provideHostPaths(app, dirs.home, opts.appPath ?? dirs.app);
  const host = app.bind({ provide, events, sessionManager, reach });
  host.provide(memory, fakeMemory(opts.stored) as never);
  await app.plugin(storageLocalPlugin);
  await app.plugin(processLocalPlugin);
  await app.plugin(sessionManagerPlugin);
  await registerFromDoc(app, store, authorityPlugin);
  await app.plugin(reachPlugin);
  await app.plugins.idle();
  return { app, host };
}
