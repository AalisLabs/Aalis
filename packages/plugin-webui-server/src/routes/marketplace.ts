import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context, PluginManagerService, PluginStatusEntry } from '@aalis/core';
import type { PackageManagerService } from '@aalis/plugin-package-manager';
import type express from 'express';
import type { RouteGate } from '../gate.js';

// 纯 npm 路线：npm registry 的 keyword 检索即天然索引（约定 keyword aalis-plugin），
// 无自建服务器、无静态索引。分发走 package-manager 的 npm pack。
// 注：npm 的 search API 并非所有镜像都支持（淘宝等国内源不支持），故 registry
// 基址可配置（marketplaceRegistry），默认官方源；国内用户可配代理/支持 search 的镜像。
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const AALIS_KEYWORD = 'aalis-plugin';
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
  /** 已装且非核心/契约/WebUI 基础设施 → 允许从市场卸载（由路由层据 getStatus 计算） */
  removable?: boolean;
  /** 关键词标签（已剔除 aalis-plugin 约定词） */
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

/**
 * 核心 / 契约 / WebUI 基础设施包：禁止从市场卸载（删了会连锁崩或把当前 WebUI
 * 自己干掉）。`*-api` 契约包被大量插件依赖；webui-server/client 是你正用的控制台；
 * package-manager 是卸载引擎本身；core===true 是 manifest 标记的核心插件。纯函数，便于单测。
 */
const PROTECTED_EXACT = new Set([
  '@aalis/core',
  '@aalis/plugin-package-manager',
  '@aalis/plugin-webui-server',
  '@aalis/plugin-webui-client',
]);
export function isProtectedPackage(name: string, entry?: { core?: boolean }): boolean {
  if (PROTECTED_EXACT.has(name)) return true;
  const short = name.replace(/^@[^/]+\//, '');
  if (/-api$/.test(short)) return true; // 契约/类型包
  return entry?.core === true;
}

/** 市场组件类别。'plugin'=可装卸功能；'api'=契约/SDK（只读）；'client'=前端（可换） */
type PackageCategory = 'plugin' | 'api' | 'client';

/**
 * 按**包名**分类（npm search 只返回 name，拿不到 package.json 的 aalis marker）。
 * 注意 `*-client` 不可一刀切——`plugin-mcp-client` 是功能插件，只有 `webui-client*`
 * 才是前端。第三方前端建议名含 `webui-client` 以被正确归类（否则归入功能插件，
 * 仍能装/被 aalis.client marker 发现挂载，只是分类不准）。纯函数，便于单测。
 */
export function classifyPackage(name: string): PackageCategory {
  const short = name.replace(/^@[^/]+\//, '');
  if (/-api$/.test(short)) return 'api';
  if (/webui-client/.test(short)) return 'client';
  return 'plugin';
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
    category: classifyPackage(o.package.name),
    keywords: (o.package.keywords ?? []).filter(k => k !== AALIS_KEYWORD),
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
  const text = q ? `keywords:${AALIS_KEYWORD} ${q}` : `keywords:${AALIS_KEYWORD}`;
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
): void {
  // 市场列表：npm registry keyword 检索 + 标注已装/可卸。网络失败降级为空列表 + warning，
  // 不阻塞 WebUI（管理读档，与 /api/plugins 同级）。
  expressApp.get('/api/marketplace', gate('webui:marketplace:read', 'restricted'), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = getPluginMgr()?.getStatus() ?? [];
    const statusByName = new Map(status.map(p => [p.name, p]));
    // 已装判定独立于 getStatus（后者漏掉 api/前端/核心——它们带 marker 不作为插件加载）：
    // 对检索结果按「项目根能否 resolve 到其 package.json」补判，覆盖 npm 扁平/pnpm/monorepo。
    const projectRequire = createRequire(pathToFileURL(resolve(process.cwd(), 'package.json')));
    const canResolve = (name: string): boolean => {
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
        canResolve,
      );
      const packages = toMarketplacePackages(data, installed).map(p => ({
        ...p,
        removable: p.installed && !isProtectedPackage(p.name, statusByName.get(p.name)),
      }));
      res.json({ packages });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.debug(`market: npm registry 检索失败: ${msg}`);
      res.json({ packages: [], warning: `无法连接 npm 仓库（${msg}），暂时只能管理本地已装插件` });
    }
  });

  // 装前能力披露：fetch npm packument 读 aalis.service（该插件需要/提供哪些服务）。
  // 安装前展示给 owner 知情同意。scoped 包名含 /，用 query 传。
  expressApp.get('/api/marketplace/manifest', gate('webui:marketplace:read', 'restricted'), async (req, res) => {
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
  expressApp.post('/api/marketplace/install', gate('webui:plugins:manage', 'restricted'), async (req, res) => {
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

  // 卸载：owner 级。护栏——禁卸核心/契约/WebUI 基础设施；禁卸"删了会断别人服务依赖"的包。
  // 真正删目录 + 清残留配置由 package-manager.uninstall 负责。
  expressApp.post('/api/marketplace/uninstall', gate('webui:plugins:manage', 'restricted'), async (req, res) => {
    const name = req.body?.name;
    if (!name || typeof name !== 'string' || !PKG_NAME_RE.test(name)) {
      res.status(400).json({ error: 'name 字段必须是合法 npm 包名' });
      return;
    }
    const status = getPluginMgr()?.getStatus() ?? [];
    const entry = status.find(p => p.name === name);
    if (isProtectedPackage(name, entry)) {
      res.status(400).json({ error: `「${name}」是核心 / 契约 / WebUI 基础设施，禁止从市场卸载` });
      return;
    }
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
