// ============================================================
// 按磁盘取的几样：安装集的形态与守护进程的入口、安装集以外守护进程加载了代码的目录、清单里各个根的真实路径、
// 绑定所在仓库的 git 目录
// ============================================================

// biome-ignore lint/style/noRestrictedImports: 安装集、入口、链接装进来的包与清单的根取真实路径、从绑定目录往上读 .git，这些路径不在存储根里
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { matchesRule, type ProtectedLists } from '@aalis/api-reach';
import type { Logger } from '@aalis/core';

/** 文件或目录不存在 */
export function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** 目录里的条目；目录不存在、不是目录（断掉的链接、同名的文件）时为空 */
const entriesOf = (dir: string) =>
  readdir(dir).catch(err => {
    if (isMissing(err) || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw err;
  });

/** 安装集的形态：下有 packages/ 目录的是源码形态，其余是 npm 形态（create-aalis 生成的项目） */
export async function formOf(app: string): Promise<'source' | 'npm'> {
  const packages = await stat(join(app, 'packages')).catch(err => {
    if (isMissing(err)) return undefined;
    throw err;
  });
  return packages?.isDirectory() ? 'source' : 'npm';
}

/** 守护进程的入口文件：启动脚本（process.argv[1]）的真实路径；没有或取不到时为 undefined */
export async function entryOf(): Promise<string | undefined> {
  const script = process.argv[1];
  return script ? realpath(script).catch(() => undefined) : undefined;
}

/**
 * 清单里以具体路径为根的规则，各个根的真实路径（交给 api-reach 的 withRealRoots）：不存在的不记；取不了的（没有权限、
 * 链接成环）记 warn，这一条只按写法拦
 */
export async function realRootsOf(lists: ProtectedLists, logger: Pick<Logger, 'warn'>): Promise<Map<string, string>> {
  const roots = new Set(
    [...lists.control, ...lists.landing, ...lists.denyRead].flatMap(rule => ('path' in rule ? [rule.path] : [])),
  );
  const real = new Map<string, string>();
  for (const root of roots) {
    const resolved = await realpath(root).catch(err => {
      if (!isMissing(err) && (err as NodeJS.ErrnoException).code !== 'ENOTDIR')
        logger.warn(`取不到 ${root} 的真实路径，受保护清单里它只按写法拦:`, err);
      return undefined;
    });
    if (resolved) real.set(root, resolved);
  }
  return real;
}

/**
 * 安装集以外、守护进程加载了代码的目录，归宿主控制面（安装集里的已由清单按安装集的目录覆盖）：
 * - 安装集 node_modules 顶层（含 `@scope/` 下）解析到安装集以外的包，整个目录；
 * - 源码形态下 packages/ 里链接到安装集以外的包，与安装集里的包一样只算构建产物与依赖。
 * 断掉的链接不是加载了的代码，跳过
 */
export async function codeDirsOf(app: string): Promise<string[]> {
  const outsideApp = async (entry: string) => {
    const real = await realpath(entry).catch(() => undefined);
    return real && !matchesRule({ path: app }, real, process.platform) ? real : undefined;
  };
  const top = join(app, 'node_modules');
  const modules: string[] = [];
  for (const name of await entriesOf(top)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) modules.push(...(await entriesOf(join(top, name))).map(sub => join(top, name, sub)));
    else modules.push(join(top, name));
  }
  const outside = new Set<string>();
  for (const entry of modules) {
    const real = await outsideApp(entry);
    if (real) outside.add(real);
  }
  for (const name of await entriesOf(join(app, 'packages'))) {
    const real = await outsideApp(join(app, 'packages', name));
    if (real) for (const sub of ['dist', 'node_modules']) outside.add(join(real, sub));
  }
  return [...outside];
}

/**
 * 目录所在仓库的 git 目录（common dir，真实路径）：从目录往上找 `.git`。文件形式的 `.git`（worktree、子模块）按里面的
 * gitdir 与 commondir 找到共用的那个。找到的不像 git 目录（没有 HEAD 与 objects）的不算，免得一个 `.git` 把任意目录
 * 指成可写。不在仓库里时为 undefined
 */
export async function gitDirOf(dir: string): Promise<string | undefined> {
  for (let at = dir; ; at = dirname(at)) {
    const dotGit = join(at, '.git');
    // 读不到（不存在或没有权限）按没有处理：少一个可写目录，不多一个。链接到目录的 .git 按它指向的目录算，不再往上找
    const entry = await lstat(dotGit).catch(() => undefined);
    if (entry?.isDirectory() || entry?.isSymbolicLink()) return asGitDir(dotGit);
    if (entry?.isFile()) {
      const content = await readFile(dotGit, 'utf8').catch(() => undefined);
      const gitdir = content && /^gitdir:\s*(.+?)\s*$/m.exec(content)?.[1];
      if (!gitdir) return undefined;
      const own = resolve(at, gitdir);
      return asGitDir(
        await readFile(join(own, 'commondir'), 'utf8').then(
          text => resolve(own, text.trim()),
          () => own,
        ),
      );
    }
    if (dirname(at) === at) return undefined;
  }
}

async function asGitDir(dir: string): Promise<string | undefined> {
  const real = await realpath(dir).catch(() => undefined);
  if (!real) return undefined;
  const [head, objects] = await Promise.all([
    stat(join(real, 'HEAD')).catch(() => undefined),
    stat(join(real, 'objects')).catch(() => undefined),
  ]);
  return head?.isFile() && objects?.isDirectory() ? real : undefined;
}
