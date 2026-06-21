import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context, PluginManagerService, PluginStatusEntry } from '@aalis/core';
import type { PackageManagerService } from '@aalis/plugin-package-manager';
import type express from 'express';
import type { RouteGate } from '../gate.js';

// 纯 npm 路线：npm registry 的 keyword 检索即天然索引，无自建服务器、无静态索引。
// 分发走 package-manager 的 npm pack。
// 注：npm 的 search API 并非所有镜像都支持（淘宝等国内源不支持），故 registry
// 基址可配置（marketplaceRegistry），默认官方源；国内用户可配代理/支持 search 的镜像。
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
// 市场收录四类：功能插件 aalis-plugin / 工具库 aalis-util / 契约 aalis-api / 前端 aalis-interface。
// npm search 的 keywords: 逗号分隔 = 任一命中（核心/工具链不带任何类型词，自然不进市场）。
const AALIS_KEYWORDS = ['aalis-plugin', 'aalis-util', 'aalis-api', 'aalis-interface'];
const SEARCH_TIMEOUT_MS = 8000;
// 合法 npm 包名（可选 scope）+ 可选 @version 后缀（支持指定版本安装）
const PKG_NAME_RE = /^(@[a-z0-9\-_.]+\/)?[a-z0-9\-_.]+(@[a-z0-9.-]+)?$/i;

interface MarketplacePackage {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** 该插件名是否已在本地激活/注册 */
  installed: boolean;
  /** @aalis/ scope = 官方插件；其余为社区（npm 自带信号，零额外维护） */
  official: boolean;
  /** 组件类别（按包名分类，供前端分页/筛选）：功能插件 / api 契约 / 前端 */
  category: PackageCategory;
  /** 关键词标签（已剔除 aalis-plugin/util/api/interface 约定词） */
  keywords?: string[];
  /** 月下载量（npm search 自带，可信度信号） */
  downloads?: number;
  /** 最近更新时间（ISO，新鲜度信号） */
  updated?: string;
  /** npm 综合评分（仅供排序；npm 已不再提供可信的 quality/popularity/maintenance 细分，故不展示） */
  score?: number;
  /** npm 标记的不安全包（红色警示） */
  insecure?: boolean;
  license?: string;
  links?: { npm?: string; homepage?: string; repository?: string };
}

interface NpmSearchResponse {
  objects?: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      keywords?: string[];
      date?: string;
      license?: string;
      links?: { npm?: string; homepage?: string; repository?: string };
      publisher?: { username?: string };
    };
    score?: { final?: number };
    downloads?: { monthly?: number; weekly?: number };
    flags?: { insecure?: number };
    updated?: string;
  }>;
}

/** 插件能力清单（来自 npm 包 package.json 的 aalis.service，装前披露用） */
interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  service?: { required?: string[]; optional?: string[]; provides?: string[] };
}

/** 市场组件类别。'plugin'=可装卸功能；'api'=契约/SDK（只读）；'interface'=前端界面（可换）；'util'=工具库（被插件 import） */
type PackageCategory = 'plugin' | 'api' | 'interface' | 'util';

/**
 * 按**类型关键词**分类（npm search 直接返回 keywords，与加载约定的类型词 1:1，可靠）。
 * 市场搜索已保证结果只含 aalis-plugin/util/api/interface 之一，无需再靠包名猜测。纯函数，便于单测。
 */
export function classifyPackage(keywords: string[]): PackageCategory {
  if (keywords.includes('aalis-interface')) return 'interface';
  if (keywords.includes('aalis-api')) return 'api';
  if (keywords.includes('aalis-util')) return 'util';
  return 'plugin'; // 进了市场却非上述三类 → 必是功能插件（aalis-plugin）
}

/**
 * 补全「已安装」判定。getStatus() 只含**已加载的运行时插件**——api 契约 / 前端 / 核心
 * 带 aalis.{types,client,...} marker 不作为插件加载、不进 getStatus，但可能已 npm 装在
 * node_modules。否则它们在市场永远显示「未安装」、给出重复安装按钮。这里对结果包名用
 * `canResolve`（项目根能否 resolve 到其 package.json）补判已装。纯函数，便于单测。
 */
export function augmentInstalled(
  names: string[],
  base: Set<string>,
  canResolve: (name: string) => boolean,
): Set<string> {
  const out = new Set(base);
  for (const name of names) {
    if (out.has(name)) continue;
    if (canResolve(name)) out.add(name);
  }
  return out;
}

/**
 * 找出"卸载 target 会断其服务依赖"的活跃插件：target 提供的某服务 S，没有别的
 * 插件也提供，且有别的插件 requiredServices 含 S → 这些插件会被打断。纯函数，便于单测。
 */
export function findServiceDependents(
  targetName: string,
  status: ReadonlyArray<Pick<PluginStatusEntry, 'name' | 'provides' | 'requiredServices'>>,
): string[] {
  const target = status.find(p => p.name === targetName);
  const provided = target?.provides ?? [];
  if (provided.length === 0) return [];
  const dependents = new Set<string>();
  for (const svc of provided) {
    const otherProvider = status.some(p => p.name !== targetName && (p.provides ?? []).includes(svc));
    if (otherProvider) continue; // 还有别的提供者，删了不致命
    for (const p of status) {
      if (p.name !== targetName && (p.requiredServices ?? []).includes(svc)) dependents.add(p.name);
    }
  }
  return [...dependents];
}

/** npm search 响应 → 市场卡片列表（标注已装 + 官方 + 富信息）。纯函数，便于单测。 */
export function toMarketplacePackages(data: NpmSearchResponse, installed: Set<string>): MarketplacePackage[] {
  return (data.objects ?? []).map(o => ({
    name: o.package.name,
    version: o.package.version,
    description: o.package.description ?? '',
    author: o.package.publisher?.username,
    installed: installed.has(o.package.name),
    official: o.package.name.startsWith('@aalis/'),
    category: classifyPackage(o.package.keywords ?? []),
    keywords: (o.package.keywords ?? []).filter(k => !AALIS_KEYWORDS.includes(k)),
    downloads: o.downloads?.monthly,
    updated: o.updated ?? o.package.date,
    score: o.score?.final,
    insecure: o.flags?.insecure ? true : undefined,
    license: o.package.license,
    links: o.package.links,
  }));
}

/** npm packument → 装前能力清单（读 latest 版本的 aalis.service）。纯函数，便于单测。 */
export function toManifest(packument: {
  'dist-tags'?: { latest?: string };
  versions?: Record<string, { description?: string; aalis?: { service?: PluginManifest['service'] } }>;
}): PluginManifest | null {
  const latest = packument['dist-tags']?.latest;
  if (!latest) return null;
  const v = packument.versions?.[latest];
  return { name: '', version: latest, description: v?.description, service: v?.aalis?.service };
}

/** 构造 npm registry 检索 URL（keyword 约定 + 可选搜索词 + 可配 registry 基址）。纯函数，便于单测。 */
export function buildSearchUrl(q: string, registryBase: string = DEFAULT_REGISTRY): string {
  const kw = `keywords:${AALIS_KEYWORDS.join(',')}`;
  const text = q ? `${kw} ${q}` : kw;
  const base = registryBase.replace(/\/+$/, '') || DEFAULT_REGISTRY;
  return `${base}/-/v1/search?text=${encodeURIComponent(text)}&size=100`;
}

/** 注册插件市场 REST 路由 */
export function registerMarketplaceRoutes(
  expressApp: express.Express,
  ctx: Context,
  getPluginMgr: () => PluginManagerService | undefined,
  gate: RouteGate,
  registryBase: string = DEFAULT_REGISTRY,
  /** 本地物理存在的包名（含 monorepo 工作区包）；由调用方扫盘注入，补 require.resolve 在 pnpm 工作区的盲区。 */
  getLocalPackageNames: () => Set<string> = () => new Set(),
): void {
  // 市场列表：npm registry keyword 检索 + 标注已装。网络失败降级为空列表 + warning，
  // 不阻塞 WebUI（管理读档，与 /api/plugins 同级）。
  expressApp.get('/api/marketplace', gate(), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = getPluginMgr()?.getStatus() ?? [];
    // 已装判定独立于 getStatus（后者只含已加载运行时插件，漏掉带 marker 不加载的 api/前端/核心）。
    // 两路补判：① 本地物理存在（含 monorepo packages/ 工作区包——require.resolve 从仓库根解析不到）；
    // ② 项目根能 resolve（独立部署的扁平 node_modules / 第三方根依赖）。
    const localNames = getLocalPackageNames();
    const projectRequire = createRequire(pathToFileURL(resolve(process.cwd(), 'package.json')));
    const isPresent = (name: string): boolean => {
      if (localNames.has(name)) return true;
      try {
        projectRequire.resolve(`${name}/package.json`);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const r = await fetch(buildSearchUrl(q, registryBase), { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`npm registry 返回 ${r.status}`);
      const data = (await r.json()) as NpmSearchResponse;
      const installed = augmentInstalled(
        (data.objects ?? []).map(o => o.package.name),
        new Set(status.map(p => p.name)),
        isPresent,
      );
      const packages = toMarketplacePackages(data, installed);
      res.json({ packages });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.debug(`market: npm registry 检索失败: ${msg}`);
      res.json({ packages: [], warning: `无法连接 npm 仓库（${msg}），暂时只能管理本地已装插件` });
    }
  });

  // 装前能力披露：fetch npm packument 读 aalis.service（该插件需要/提供哪些服务）。
  // 安装前展示给 owner 知情同意。scoped 包名含 /，用 query 传。
  expressApp.get('/api/marketplace/manifest', gate(), async (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    if (!name || !PKG_NAME_RE.test(name)) {
      res.status(400).json({ error: 'name 必须是合法 npm 包名' });
      return;
    }
    try {
      const base = registryBase.replace(/\/+$/, '') || DEFAULT_REGISTRY;
      const r = await fetch(`${base}/${name.replace('/', '%2F')}`, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`npm registry 返回 ${r.status}`);
      const manifest = toManifest((await r.json()) as Parameters<typeof toManifest>[0]);
      if (!manifest) {
        res.json({ manifest: null, warning: '该包无可解析的版本信息' });
        return;
      }
      res.json({ manifest: { ...manifest, name } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.debug(`market: 拉取 ${name} manifest 失败: ${msg}`);
      res.json({ manifest: null, warning: `无法拉取插件清单（${msg}）` });
    }
  });

  // 安装：复用 package-manager 的 npm pack 流程；owner 级（安装第三方代码 = 高危）。
  expressApp.post('/api/marketplace/install', gate(), async (req, res) => {
    const npmPkg = req.body?.name;
    if (!npmPkg || typeof npmPkg !== 'string' || !PKG_NAME_RE.test(npmPkg)) {
      res.status(400).json({ error: 'name 字段必须是合法 npm 包名' });
      return;
    }
    const pkgMgr = ctx.getService<PackageManagerService>('package-manager');
    if (!pkgMgr) {
      res.status(503).json({ error: 'package-manager 服务未启用，无法安装插件' });
      return;
    }
    try {
      res.json(await pkgMgr.install(npmPkg));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 卸载：owner 级。唯一护栏——禁卸"删了会断别人服务依赖"的包（无替代提供者）。
  // 不再保护核心/契约/WebUI 基础设施：用户要切就让其切（基础设施自删的后果自负）。
  // 真正删目录 + 清残留配置由 package-manager.uninstall 负责。
  expressApp.post('/api/marketplace/uninstall', gate(), async (req, res) => {
    const name = req.body?.name;
    if (!name || typeof name !== 'string' || !PKG_NAME_RE.test(name)) {
      res.status(400).json({ error: 'name 字段必须是合法 npm 包名' });
      return;
    }
    const status = getPluginMgr()?.getStatus() ?? [];
    const dependents = findServiceDependents(name, status);
    if (dependents.length > 0) {
      res.status(409).json({
        error: `卸载会破坏依赖：${dependents.join('、')} 依赖此插件提供的服务且无其他提供者。请先卸载它们或安装替代提供者。`,
      });
      return;
    }
    const pkgMgr = ctx.getService<PackageManagerService>('package-manager');
    if (!pkgMgr) {
      res.status(503).json({ error: 'package-manager 服务未启用，无法卸载插件' });
      return;
    }
    try {
      res.json(await pkgMgr.uninstall(name));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
