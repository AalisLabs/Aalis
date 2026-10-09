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
import type { App } from '../../packages/core/src/index.js';
import { ownerTurn, type ReachDirs, reachDirs, removeDirs, sessionTmpIn, startReach } from '../fixtures/reach-host.js';

// ════════════════════════════════════════════════════════════
// 子进程环境只从凭据来：在场所的主目录下用 owner 的 login shell 取完整环境（同一个主目录取到一次就一直用），取不到时用守护
// 进程的、1 分钟后再取；宿主执行用完整的，沙箱内去掉 AALIS_*、凭据类变量、带密码的网址、SSH_AUTH_SOCK 与 git 的命令行配置，
// 注入沙箱要的几项。login shell 用一个假 shell：它记下每次被叫起的目录、模拟 rc 文件的输出与导出（全是占位值），再照常执行
// 取环境的命令。
// ════════════════════════════════════════════════════════════

/** rc 文件导出的变量：前一半是凭据（占位值），后一半是普通变量 */
const RC_SECRETS = {
  GITHUB_TOKEN: 'zz-placeholder',
  OPENAI_API_KEY: 'zz-placeholder',
  AWS_SECRET_ACCESS_KEY: 'zz-placeholder',
  AWS_ACCESS_KEY_ID: 'zz-placeholder',
  PGPASSWORD: 'zz-placeholder',
  GH_PAT: 'zz-placeholder',
  NPM_CONFIG__AUTH: 'zz-placeholder',
  SSHPASS: 'zz-placeholder',
  BW_SESSION: 'zz-placeholder',
  OP_SESSION_zz: 'zz-placeholder',
  SLACK_WEBHOOK_URL: 'https://hooks.zz.invalid/services/zz-placeholder',
  DATABASE_URL: 'postgres://zz-user:zz-placeholder@db.invalid/app',
  REGISTRY_URL: 'https://:zz-placeholder@registry.zz.invalid/',
  AALIS_HOME: '/zz/aalis-home',
  SSH_AUTH_SOCK: '/zz/agent.sock',
};
const RC_PLAIN = {
  ZZ_FROM_RC: '1',
  GIT_AUTHOR_NAME: 'zz-author',
  KEYTIMEOUT: '1',
  PUBLIC_URL: 'https://example.invalid/app',
  MIRROR_URL: 'https://zz-user@mirror.invalid/simple',
  TERM_SESSION_ID: 'zz-term',
  XDG_SESSION_TYPE: 'tty',
};

let dirs: ReachDirs;
let log: string;
const saved: Record<string, string | undefined> = {};
const apps: App[] = [];

/** 写假 shell：failWhile 指的文件存在时只打印一行就失败退出；extra 是 rc 文件另外导出的变量 */
function fakeShell(opts: { failWhile?: string; extra?: Record<string, string> } = {}): string {
  const shell = join(dirs.base, 'bin', 'zz-shell');
  mkdirSync(join(dirs.base, 'bin'), { recursive: true });
  const exports = Object.entries({ ...RC_SECRETS, ...RC_PLAIN, ...opts.extra })
    .map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'`)
    .join('\n');
  writeFileSync(
    shell,
    [
      '#!/bin/sh',
      `pwd -P >> '${log}'`,
      'echo zz-rc-noise',
      opts.failWhile ? `[ -e '${opts.failWhile}' ] && exit 1` : '',
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

async function start() {
  const started = await startReach(dirs);
  apps.push(started.app);
  const sm = started.host.sessionManager.require();
  const svc = started.host.reach.require();
  const webui = (await sm.createSession({ name: 'w' }, { createdFrom: 'webui' })).id;
  return { sm, svc, webui };
}

const shellCalls = () => readFileSync(log, 'utf8').trim().split('\n');

describe('取 login shell 的环境', () => {
  it('在场所的主目录下取（主目录还没建时在用户家目录下取），同一个主目录只取一次；宿主执行用完整的环境', async () => {
    process.env.SHELL = fakeShell();
    const { sm, svc, webui } = await start();
    const cred = await svc.forCall(ownerTurn(webui));
    const host = await cred.processEnv('host');
    expect(host).toMatchObject({ ...RC_SECRETS, ...RC_PLAIN, ZZ_DAEMON_ONLY: '1', HOME: dirs.user });
    await cred.processEnv('sandbox');
    await (await svc.forCall(ownerTurn(webui))).processEnv('host');
    expect(shellCalls(), '默认工作区的白纸首次写入时才建').toEqual([dirs.user]);

    const proj = join(dirs.base, 'code', 'proj');
    mkdirSync(proj, { recursive: true });
    const project = (await sm.createSession({ name: 'p' }, { createdFrom: 'webui', work: { root: proj } })).id;
    await (await svc.forCall(ownerTurn(project))).processEnv('host');
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
});

describe('沙箱内的环境', () => {
  it('去掉 AALIS_*、凭据类变量、带用户名与密码的网址与 SSH_AUTH_SOCK；HOME 与普通变量照旧', async () => {
    process.env.SHELL = fakeShell();
    const { svc, webui } = await start();
    const env = await (await svc.forCall(ownerTurn(webui))).processEnv('sandbox');
    expect(Object.keys(RC_SECRETS).filter(key => key in env)).toEqual([]);
    expect(env).toMatchObject({ ...RC_PLAIN, HOME: dirs.user });
  });

  it('注入 npm 的用户配置（去掉凭据行的副本）、本机 Node 的头文件、浏览器缓存目录、关掉 pnpm 的构建产物缓存，公开仓库拉取走 HTTPS', async () => {
    process.env.SHELL = fakeShell();
    const { svc, webui } = await start();
    const cred = await svc.forCall(ownerTurn(webui));
    const env = await cred.processEnv('sandbox');
    const tmp = sessionTmpIn(dirs.home, webui);
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

  it('login 环境里原有的 git 命令行配置整组不进沙箱（值里可能是凭据），注入的从 0 起连续编号', async () => {
    process.env.SHELL = fakeShell({
      extra: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic zz-placeholder',
        GIT_CONFIG_PARAMETERS: "'http.extraheader'='AUTHORIZATION: basic zz-placeholder'",
      },
    });
    const { svc, webui } = await start();
    const env = await (await svc.forCall(ownerTurn(webui))).processEnv('sandbox');
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
      `GIT_CONFIG_KEY_${i}`,
      `GIT_CONFIG_VALUE_${i}`,
    ]);
    expect(
      Object.keys(env)
        .filter(name => name.startsWith('GIT_CONFIG_'))
        .sort(),
    ).toEqual(['GIT_CONFIG_COUNT', ...pairs.flat()].sort());
    expect(pairs.every(([key, value]) => env[key!]?.startsWith('url.') && env[value!])).toBe(true);
    expect(Object.values(env).filter(value => value.includes('zz-placeholder'))).toEqual([]);
  });
});

describe('沙箱环境的 npm 配置副本', () => {
  it('临时区里的 npmrc 被换成符号链接时，换掉的是这一项本身，不写链接指向的文件', async () => {
    process.env.SHELL = fakeShell();
    const { svc, webui } = await start();
    const cred = await svc.forCall(ownerTurn(webui));
    const victim = join(dirs.base, 'victim.yaml');
    writeFileSync(victim, 'zz: keep\n');
    const npmrc = join(sessionTmpIn(dirs.home, webui), 'npmrc');
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
    const tmp = sessionTmpIn(dirs.home, webui);
    const elsewhere = join(dirs.base, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(tmp, { recursive: true });
    symlinkSync(elsewhere, tmp);
    await expect(cred.processEnv('sandbox')).rejects.toThrow('本会话临时区');
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
