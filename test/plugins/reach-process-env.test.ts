import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Logger } from '../../packages/core/src/index.js';
import {
  ownerTurn,
  projectSession,
  type ReachDirs,
  reachDirs,
  removeDirs,
  sessionTmpIn,
  startReach,
} from '../fixtures/reach-host.js';

// ════════════════════════════════════════════════════════════
// 子进程环境只从凭据来：在场所的主目录下用 owner 的 login shell 取完整环境（同一个主目录取到一次就一直用），取不到时用守护
// 进程的、1 分钟后再取；宿主执行用完整的，沙箱内同样是完整的登录环境，不按名字或值猜凭据，只去掉 AALIS_* 与 SSH_AUTH_SOCK，
// 注入沙箱要的几项（git 的命令行配置接在原有的后面编号）。login shell 用一个假 shell：它记下每次被调用时所在的目录、模拟 rc 文件的
// 输出与导出（全是占位值），再照常执行取环境的命令。
// ════════════════════════════════════════════════════════════

/** rc 文件导出、沙箱里不带的变量：本实例自己的与 ssh-agent 的 socket（占位值） */
const RC_DROPPED = {
  AALIS_DATA: '/zz/aalis-home',
  SSH_AUTH_SOCK: '/zz/agent.sock',
};
/** rc 文件导出的其余变量，沙箱里照样带上：名字或值像凭据的也一样（占位值） */
const RC_KEPT = {
  ZZ_FROM_RC: '1',
  GITHUB_TOKEN: 'zz-placeholder',
  DB_PASS: 'zz-placeholder',
  MYSQL_PWD: 'zz-placeholder',
  TOKENIZERS_PARALLELISM: 'false',
  GOOGLE_APPLICATION_CREDENTIALS: '/zz/credentials.json',
  DATABASE_URL: 'postgres://zz-user:zz-placeholder@db.invalid/app',
  GIT_AUTHOR_NAME: 'zz-author',
  TERM_SESSION_ID: 'zz-term',
};

let dirs: ReachDirs;
let log: string;
const saved: Record<string, string | undefined> = {};
const apps: App[] = [];

/**
 * 写假 shell：failWhile 指的文件存在时只打印一行就失败退出，hangWhile 指的文件存在时把进程号写进旁边的 .pid 文件后卡住
 * （rc 文件等输入、连网）；extra 是 rc 文件另外导出的变量
 */
function fakeShell(opts: { failWhile?: string; hangWhile?: string; extra?: Record<string, string> } = {}): string {
  const shell = join(dirs.base, 'bin', 'zz-shell');
  mkdirSync(join(dirs.base, 'bin'), { recursive: true });
  const exports = Object.entries({ ...RC_DROPPED, ...RC_KEPT, ...opts.extra })
    .map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'`)
    .join('\n');
  writeFileSync(
    shell,
    [
      '#!/bin/sh',
      `pwd -P >> '${log}'`,
      'echo zz-rc-noise',
      opts.failWhile ? `[ -e '${opts.failWhile}' ] && exit 1` : '',
      opts.hangWhile ? `[ -e '${opts.hangWhile}' ] && { echo $$ > '${opts.hangWhile}.pid'; exec sleep 30; }` : '',
      exports,
      `export PATH='${join(dirs.base, 'node', 'bin')}':"$PATH"`,
      'for last; do :; done',
      'exec /bin/sh -c "$last"',
      '',
    ].join('\n'),
  );
  chmodSync(shell, 0o755);
  return shell;
}

beforeEach(() => {
  dirs = reachDirs();
  log = join(dirs.base, 'shell.log');
  for (const key of ['HOME', 'SHELL', 'ZZ_DAEMON_ONLY']) saved[key] = process.env[key];
  process.env.HOME = dirs.user;
  process.env.ZZ_DAEMON_ONLY = '1';
  // 本机的 Node：bin/node 与头文件
  mkdirSync(join(dirs.base, 'node', 'bin'), { recursive: true });
  mkdirSync(join(dirs.base, 'node', 'include', 'node'), { recursive: true });
  writeFileSync(join(dirs.base, 'node', 'bin', 'node'), '#!/bin/sh\n');
  chmodSync(join(dirs.base, 'node', 'bin', 'node'), 0o755);
  writeFileSync(join(dirs.base, 'node', 'include', 'node', 'node.h'), '');
  writeFileSync(
    join(dirs.user, '.npmrc'),
    [
      'registry=https://registry.npmmirror.com/',
      '//registry.npmjs.org/:_authToken=zz-placeholder',
      '_auth=zz-placeholder',
      '//npm.zz.invalid/:username=zz-user',
      '//npm.zz.invalid/:_password=zz-placeholder',
      'key="-----BEGIN PRIVATE KEY-----zz-placeholder"',
      'cert=zz-placeholder',
      '@zz:registry=https://npm.zz.invalid/',
      'cafile=/zz/ca.pem',
      '',
    ].join('\n'),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeDirs(dirs);
});

async function start(logger?: Logger) {
  const started = await startReach(dirs, logger ? { logger } : {});
  apps.push(started.app);
  const sm = started.host.sessionManager.use;
  const svc = started.host.reach.use;
  const webui = (await sm.createSession({ name: 'w' }, { createdFrom: 'webui' })).id;
  return { app: started.app, sm, svc, webui, paths: started.paths };
}

const shellCalls = () => readFileSync(log, 'utf8').trim().split('\n');

describe('取 login shell 的环境', () => {
  it('在场所的主目录下取（主目录不在时在用户主目录下取），同一个主目录只取一次；宿主执行用完整的环境', async () => {
    process.env.SHELL = fakeShell();
    const { paths, sm, svc, webui } = await start();
    // 默认工作区目录由 runtime 初始化时建；不在（如被删掉）时与新开一个终端相同
    rmSync(paths.workspace, { recursive: true, force: true });
    const cred = await svc.forCall(ownerTurn(webui));
    const host = await cred.processEnv('host');
    expect(host).toMatchObject({ ...RC_DROPPED, ...RC_KEPT, ZZ_DAEMON_ONLY: '1', HOME: dirs.user });
    await cred.processEnv('sandbox');
    await (await svc.forCall(ownerTurn(webui))).processEnv('host');
    expect(shellCalls(), '默认工作区目录不在').toEqual([dirs.user]);

    const proj = join(dirs.base, 'code', 'proj');
    mkdirSync(proj, { recursive: true });
    await (await svc.forCall(ownerTurn(await projectSession(sm, proj)))).processEnv('host');
    expect(shellCalls()).toEqual([dirs.user, proj]);
  });

  it('login shell 失败时用守护进程的环境，1 分钟后再取一次；取到的一直用', async () => {
    const broken = join(dirs.base, 'rc-broken');
    writeFileSync(broken, '');
    process.env.SHELL = fakeShell({ failWhile: broken });
    const { svc, webui } = await start();
    const hostEnv = async () => (await svc.forCall(ownerTurn(webui))).processEnv('host');
    const first = await hostEnv();
    expect(first.ZZ_DAEMON_ONLY).toBe('1');
    expect(first).not.toHaveProperty('ZZ_FROM_RC');

    rmSync(broken);
    expect(await hostEnv(), '1 分钟内沿用守护进程的环境').not.toHaveProperty('ZZ_FROM_RC');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    expect(await hostEnv()).toMatchObject({ ZZ_FROM_RC: '1' });

    writeFileSync(broken, '');
    vi.setSystemTime(Date.now() + 60 * 60_000);
    expect(await hostEnv(), '取到的一直用').toMatchObject({ ZZ_FROM_RC: '1' });
    expect(shellCalls()).toHaveLength(2);
  });

  it('取环境途中停用：login shell 随之停下，以中止原因拒绝，不按取不到告警', async () => {
    const hang = join(dirs.base, 'rc-hang');
    writeFileSync(hang, '');
    process.env.SHELL = fakeShell({ hangWhile: hang });
    const warns: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
      error() {},
      child: () => logger,
    };
    const { app, svc, webui } = await start(logger);
    const cred = await svc.forCall(ownerTurn(webui));
    const failure = cred.processEnv('host').then(
      () => undefined,
      (err: unknown) => err,
    );
    await expect.poll(() => readFileSync(`${hang}.pid`, 'utf8')).toMatch(/^\d+\n$/);
    const pid = Number(readFileSync(`${hang}.pid`, 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await app.plugins.disable('@aalis/plugin-reach');
    // 取环境的时限是 10 秒，这里只等 poll 的 5 秒：停下来的只能是中止
    await expect.poll(alive).toBe(false);
    expect(await failure).toMatchObject({ name: 'AbortError' });
    expect(warns.filter(line => line.includes('login shell'))).toEqual([]);
  });
});

describe('沙箱内的环境', () => {
  it('只去掉 AALIS_* 与 SSH_AUTH_SOCK；其余登录环境照样带上，不按名字或值猜凭据，HOME 是 owner 的', async () => {
    process.env.SHELL = fakeShell();
    const { svc, webui } = await start();
    const env = await (await svc.forCall(ownerTurn(webui))).processEnv('sandbox');
    expect(Object.keys(RC_DROPPED).filter(key => key in env)).toEqual([]);
    expect(env).toMatchObject({ ...RC_KEPT, HOME: dirs.user });
  });

  it('注入 npm 的用户配置（去掉认证键的副本）、本机 Node 的头文件、浏览器缓存目录、关掉 pnpm 的构建产物缓存，SSH 地址的拉取走 HTTPS', async () => {
    process.env.SHELL = fakeShell();
    const { svc, webui } = await start();
    const cred = await svc.forCall(ownerTurn(webui));
    const env = await cred.processEnv('sandbox');
    const tmp = sessionTmpIn(dirs.data, webui);
    expect(env.npm_config_userconfig).toBe(join(tmp, 'npmrc'));
    expect(readFileSync(join(tmp, 'npmrc'), 'utf8').trim().split('\n')).toEqual([
      'registry=https://registry.npmmirror.com/',
      '@zz:registry=https://npm.zz.invalid/',
      'cafile=/zz/ca.pem',
    ]);
    expect(env.npm_config_nodedir).toBe(join(dirs.base, 'node'));
    expect(env.PUPPETEER_CACHE_DIR).toBe(join(tmp, 'puppeteer'));
    expect(env.npm_config_side_effects_cache).toBe('false');
    const gitConfig = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
      env[`GIT_CONFIG_KEY_${i}`],
      env[`GIT_CONFIG_VALUE_${i}`],
    ]);
    expect(gitConfig).toEqual(
      expect.arrayContaining([
        ['url.https://github.com/.insteadOf', 'git@github.com:'],
        ['url.git@github.com:.pushInsteadOf', 'git@github.com:'],
      ]),
    );
    // 宿主执行用完整的环境，不带沙箱的注入
    const host = await cred.processEnv('host');
    expect(host.npm_config_userconfig).not.toBe(env.npm_config_userconfig);
    expect(Object.values(host)).not.toContain('url.https://github.com/.insteadOf');
  });

  it('login 环境里原有的 git 命令行配置照样带上，沙箱注入的几项接在它们后面编号', async () => {
    const extraheader = ['http.https://github.com/.extraheader', 'AUTHORIZATION: basic zz-placeholder'];
    const parameters = "'http.extraheader'='AUTHORIZATION: basic zz-placeholder'";
    process.env.SHELL = fakeShell({
      extra: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: extraheader[0],
        GIT_CONFIG_VALUE_0: extraheader[1],
        GIT_CONFIG_PARAMETERS: parameters,
      },
    });
    const { svc, webui } = await start();
    const env = await (await svc.forCall(ownerTurn(webui))).processEnv('sandbox');
    const [first, ...injected] = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
      env[`GIT_CONFIG_KEY_${i}`],
      env[`GIT_CONFIG_VALUE_${i}`],
    ]);
    expect(first).toEqual(extraheader);
    expect(injected).toContainEqual(['url.https://github.com/.insteadOf', 'git@github.com:']);
    expect(injected.every(([key, value]) => key?.startsWith('url.') && value)).toBe(true);
    expect(env.GIT_CONFIG_PARAMETERS).toBe(parameters);
  });

  it('login 环境里 git 命令行配置的计数不是数字时（git 读不了那组），注入的几项从 0 编号', async () => {
    process.env.SHELL = fakeShell({ extra: { GIT_CONFIG_COUNT: 'zz' } });
    const { svc, webui } = await start();
    const env = await (await svc.forCall(ownerTurn(webui))).processEnv('sandbox');
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
      env[`GIT_CONFIG_KEY_${i}`],
      env[`GIT_CONFIG_VALUE_${i}`],
    ]);
    expect(pairs[0]).toEqual(['url.https://github.com/.insteadOf', 'git@github.com:']);
    expect(pairs.every(([key, value]) => key?.startsWith('url.') && value)).toBe(true);
  });
});

describe('沙箱环境的 npm 配置副本', () => {
  it('临时区里的 npmrc 被换成符号链接时，换掉的是这一项本身，不写链接指向的文件', async () => {
    process.env.SHELL = fakeShell();
    const { svc, webui } = await start();
    const cred = await svc.forCall(ownerTurn(webui));
    const victim = join(dirs.base, 'victim.yaml');
    writeFileSync(victim, 'zz: keep\n');
    const npmrc = join(sessionTmpIn(dirs.data, webui), 'npmrc');
    symlinkSync(victim, npmrc);
    await cred.processEnv('sandbox');
    expect(readFileSync(victim, 'utf8')).toBe('zz: keep\n');
    expect(lstatSync(npmrc).isFile()).toBe(true);
    expect(readFileSync(npmrc, 'utf8')).toContain('registry=https://registry.npmmirror.com/');
  });

  it('本会话临时区本身被换成符号链接时拒绝，不往链接指向的目录里写', async () => {
    process.env.SHELL = fakeShell();
    const { svc, webui } = await start();
    const cred = await svc.forCall(ownerTurn(webui));
    const tmp = sessionTmpIn(dirs.data, webui);
    const elsewhere = join(dirs.base, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(tmp, { recursive: true });
    symlinkSync(elsewhere, tmp);
    await expect(cred.processEnv('sandbox')).rejects.toThrow('本会话临时区');
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
