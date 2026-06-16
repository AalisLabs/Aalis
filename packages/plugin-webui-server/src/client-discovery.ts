// 全动态前端发现（纯逻辑，注入 fs/path 便于单测）。
//
// 按 `aalis.client:true` 标记 + 存在 `dist/index.html` 收录前端候选——**不硬编码任何前端包名**，
// 与 runtime 加载器的 marker 驱动一致（忒修斯之船：任意第三方前端，带标记+dist 即被发现）。
// 覆盖三种拓扑：monorepo（扫 packages 同级目录）/ 独立项目（扫 node_modules/@aalis 作用域 + 根 deps）。

interface ClientCandidate {
  id: string;
  label: string;
  dir: string;
}

export interface DiscoveryEnv {
  existsSync: (p: string) => boolean;
  /** 读目录子项；不可读返回 [] */
  readdirSync: (p: string) => string[];
  /** 读 + parse JSON；失败返回 undefined */
  readJson: (p: string) => unknown;
  join: (...parts: string[]) => string;
  dirname: (p: string) => string;
  /** 把 deps 包名解析到其 package.json 路径；失败返回 undefined */
  resolvePkgJson: (id: string) => string | undefined;
}

interface PkgLike {
  name?: unknown;
  displayName?: unknown;
  description?: unknown;
  aalis?: { client?: unknown };
}

/**
 * 发现所有前端包：在 scanDirs 各目录下逐子目录、以及 depIds（项目根 deps）里，收录 package.json
 * 标了 `aalis.client:true` 且其 `dist/index.html` 存在的包。按包名去重，再按 id 排序（确定性输出）。
 * 默认活跃前端由调用方按 config 或「排序后第一个」决定——本函数不做偏好判断、不认任何具体名字。
 */
export function discoverClients(scanDirs: string[], depIds: string[], env: DiscoveryEnv): ClientCandidate[] {
  const out: ClientCandidate[] = [];
  const seen = new Set<string>();

  const consider = (pkgJsonPath: string | undefined): void => {
    if (!pkgJsonPath || !env.existsSync(pkgJsonPath)) return;
    const pkg = env.readJson(pkgJsonPath) as PkgLike | undefined;
    if (!pkg || pkg.aalis?.client !== true || typeof pkg.name !== 'string' || seen.has(pkg.name)) return;
    const dir = env.join(env.dirname(pkgJsonPath), 'dist');
    if (!env.existsSync(env.join(dir, 'index.html'))) return;
    seen.add(pkg.name);
    const label =
      (typeof pkg.displayName === 'string' && pkg.displayName) ||
      (typeof pkg.description === 'string' && pkg.description) ||
      pkg.name;
    out.push({ id: pkg.name, label, dir });
  };

  // ① 扫描目录：monorepo 的 packages 同级目录 / 独立项目的 node_modules/@aalis 作用域
  for (const base of scanDirs) {
    if (!env.existsSync(base)) continue;
    for (const entry of env.readdirSync(base)) consider(env.join(base, entry, 'package.json'));
  }
  // ② 第三方前端：项目根 deps 里按包名解析（覆盖独立项目把第三方 client 列为 dep 的情形）
  for (const id of depIds) consider(env.resolvePkgJson(id));

  return out.sort((a, b) => a.id.localeCompare(b.id));
}
