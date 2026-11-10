// ============================================================
// 子进程环境：owner 的 login shell 环境，沙箱内另去掉两样并注入沙箱要的几项
//
// 环境在场所的主目录下用 owner 的 login shell 取一次（项目的 .nvmrc、venv 这类按目录选的工具链与 owner 自己的终端一致），
// 缓存在内存，不落盘；取不到时用守护进程的环境，1 分钟后再取（一次超时不能让这个主目录一直用守护进程的环境）。
// 宿主执行与沙箱里的命令都拿到完整的登录环境，不按名字或值猜凭据：能进沙箱的只有主体是 owner 的一轮，密钥不靠出口过滤，
// 靠权限隔离。沙箱里只去掉本实例自己的变量与 ssh-agent 的 socket，git 的命令行配置接上沙箱要的几项，npm 的用户配置换成
// 去掉认证键的副本。
// ============================================================

// biome-ignore lint/style/noRestrictedImports: 读用户主目录的 .npmrc、在本会话临时区写去掉认证键的副本（不跟随链接）、按 PATH 找本机 Node 的头文件，这些路径不在存储根里
import { access, lstat, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
// biome-ignore lint/style/noRestrictedImports: 没有 SHELL 时取操作系统账户登记的 login shell
import { userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { ProcessService } from '@aalis/api-process';
import type { Logger, ServiceSelection } from '@aalis/core';
import { isMissing } from './host-dirs.js';

type Env = Record<string, string>;

/** 取环境的时限：rc 文件卡住（等输入、连网）时按取不到处理 */
const CAPTURE_TIMEOUT_MS = 10_000;
/** 取不到时这么久之后再取 */
const RETRY_AFTER_MS = 60_000;

/** AALIS_ 开头的是实例自己的命名空间（数据目录这类本实例的配置），不交给沙箱里的命令 */
const INSTANCE_VARS = /^AALIS_/;
/** ssh-agent 的 socket：ssh-agent 不对沙箱开放，经 SSH 的推送要宿主执行 */
const SSH_AGENT_SOCK = 'SSH_AUTH_SOCK';
/**
 * npm 定义的认证键：令牌、用户名与密码、客户端证书与私钥（文件或内联）。~/.npmrc 在拒读清单里，沙箱里的 npm 读的是去掉这些键
 * 的副本
 */
const NPMRC_SECRET = /(^|:)(_authToken|_auth|_password|username|password|(cert|key)(file)?)\s*=/i;
/** SSH 地址的拉取改走 HTTPS（沙箱里没有 SSH 凭据），推送仍是 SSH（沙箱里推不了，要宿主执行） */
const HTTPS_HOSTS = ['github.com', 'gitlab.com'];

/**
 * 按 owner 的 login shell 取环境的入口：同一个主目录取到一次就一直用，同时来的调用共用一次取。共用的一次取不随哪一次调用
 * 停下，接 signal（本插件这次激活的）：停用、停机时 login shell 随之停下，以中止原因拒绝，不按取不到告警
 */
export function loginEnvs(deps: {
  process: ServiceSelection<ProcessService>;
  userHome: string;
  logger: Logger;
  signal: AbortSignal;
}) {
  const cache = new Map<string, { env: Promise<Env>; retryAt: number }>();

  /** 取不到时为 undefined */
  async function capture(home: string): Promise<Env | undefined> {
    try {
      if (!deps.process.present) throw new Error('没有进程服务');
      const proc = deps.process.use;
      const shell = process.env.SHELL || userInfo().shell;
      if (!shell) throw new Error('不知道 owner 的 login shell（没有 SHELL，账户也没登记）');
      // 默认工作区目录由 runtime 初始化时建；主目录不在（如被删掉）时在用户主目录下取，与新开一个终端相同
      const cwd = await stat(home).then(
        s => (s.isDirectory() ? home : deps.userHome),
        () => deps.userHome,
      );
      const mark = `__AALIS_ENV_${crypto.randomUUID()}__`;
      const { stdout } = await proc.execFile(shell, ['-i', '-l', '-c', `printf '%s' '${mark}'; /usr/bin/env -0`], {
        cwd,
        timeout: CAPTURE_TIMEOUT_MS,
        input: '',
        signal: deps.signal,
      });
      const at = stdout.indexOf(mark);
      if (at < 0) throw new Error(`${shell} 的输出里没有环境`);
      return Object.fromEntries(
        stdout
          .slice(at + mark.length)
          .split('\0')
          .filter(line => line.includes('='))
          .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
    } catch (err) {
      deps.signal.throwIfAborted();
      deps.logger.warn(
        `没取到 owner 的 login shell 环境（主目录 ${home}），子进程用守护进程的环境，1 分钟后再取:`,
        err,
      );
      return undefined;
    }
  }

  return (home: string): Promise<Env> => {
    const cached = cache.get(home);
    if (cached && Date.now() < cached.retryAt) return cached.env;
    const entry = {
      retryAt: Number.POSITIVE_INFINITY,
      env: capture(home).then(env => {
        if (env) return env;
        entry.retryAt = Date.now() + RETRY_AFTER_MS;
        return { ...process.env } as Env;
      }),
    };
    cache.set(home, entry);
    return entry.env;
  };
}

/**
 * 沙箱里的命令拿到的环境：完整的登录环境去掉本实例的变量与 ssh-agent 的 socket，注入 npm 的用户配置（去掉认证键的副本，写在
 * 本会话临时区）、本机 Node 的头文件、浏览器的缓存目录，关掉 pnpm 的构建产物缓存（沙箱里构建出的产物不能被沙箱外的安装直接
 * 复用），SSH 地址的拉取走 HTTPS
 */
export async function sandboxEnv(login: Env, sessionTmp: string, userHome: string): Promise<Env> {
  const env = Object.fromEntries(
    Object.entries(login).filter(([name]) => !INSTANCE_VARS.test(name) && name !== SSH_AGENT_SOCK),
  );
  const npmrc = join(sessionTmp, 'npmrc');
  const owned = await readFile(join(userHome, '.npmrc'), 'utf8').catch(err => {
    if (isMissing(err)) return '';
    throw err;
  });
  // 临时区在沙箱里可写，沙箱里的命令能把 npmrc、甚至临时区本身换成符号链接，骗守护进程去改写别处：临时区本身要是目录，
  // 副本先以随机名独占创建（不跟随链接），再改名盖过去（换掉的是链接本身）
  if (!(await lstat(sessionTmp)).isDirectory()) {
    throw new Error(`本会话临时区 ${sessionTmp} 不是目录（可能被换成了符号链接），不往里写 npm 的用户配置`);
  }
  const staging = join(sessionTmp, `.npmrc-${crypto.randomUUID()}`);
  const kept = owned.split('\n').filter(line => !NPMRC_SECRET.test(line.trim()));
  await writeFile(staging, kept.join('\n'), { mode: 0o600, flag: 'wx' });
  await rename(staging, npmrc);
  const nodeDir = await nodeDirOf(env.PATH);
  const injected: Env = {
    npm_config_userconfig: npmrc,
    npm_config_side_effects_cache: 'false',
    PUPPETEER_CACHE_DIR: join(sessionTmp, 'puppeteer'),
    ...(nodeDir ? { npm_config_nodedir: nodeDir } : {}),
  };
  // npm 的环境变量不分大小写：同名的旧值去掉，免得两份打架
  for (const name of Object.keys(env)) {
    if (Object.keys(injected).some(key => key.toLowerCase() === name.toLowerCase())) delete env[name];
  }
  const git = HTTPS_HOSTS.flatMap(
    (host): Array<[string, string]> => [
      [`url.https://${host}/.insteadOf`, `git@${host}:`],
      [`url.https://${host}/.insteadOf`, `ssh://git@${host}/`],
      [`url.git@${host}:.pushInsteadOf`, `git@${host}:`],
      [`url.ssh://git@${host}/.pushInsteadOf`, `ssh://git@${host}/`],
    ],
  );
  // git 的命令行配置只有一组连续编号：沙箱要的几项接在登录环境原有的那组后面重新编号，原有的照留（计数不是数字时 git 本就
  // 读不了那组，从 0 编号）
  const base = /^\d+$/.test(env.GIT_CONFIG_COUNT ?? '') ? Number(env.GIT_CONFIG_COUNT) : 0;
  git.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${base + i}`] = key;
    env[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(base + git.length);
  return { ...env, ...injected };
}

/** 这份 PATH 上的 node 所在的安装（带头文件的才算）：源码编译原生模块时 node-gyp 用它，不必去下载头文件 */
async function nodeDirOf(path: string | undefined): Promise<string | undefined> {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    const bin = await realpath(join(dir, 'node')).catch(() => undefined);
    if (!bin) continue;
    const prefix = dirname(dirname(bin));
    return access(join(prefix, 'include', 'node', 'node.h')).then(
      () => prefix,
      () => undefined,
    );
  }
  return undefined;
}
