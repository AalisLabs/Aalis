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

/** 插件能力清单（来自 npm 包 package.json 的 aalis.service + 依赖，装前披露用） */
interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  service?: { required?: string[]; optional?: string[]; provides?: string[] };
  /** 该版本声明的依赖名（dependencies+peer，已剔版本）；供装前依赖树的根种子。 */
  dependencies?: string[];
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

/** 直接 import 依赖者：哪些本地包的依赖名单里含 target（不含自身）。排序输出。纯函数，便于单测。 */
export function findPackageDependents(target: string, depMap: ReadonlyMap<string, string[]>): string[] {
  const out: string[] = [];
  for (const [name, deps] of depMap) {
    if (name !== target && deps.includes(target)) out.push(name);
  }
  return out.sort();
}

/** 依赖链路树节点。present=false：该包本地不存在（upstream 里即「缺失/将引入」，链路在此中断）。 */
interface DepChainNode {
  name: string;
  present: boolean;
  /** 服务标注（仅已加载插件有；util/api/未装为 undefined）。由端点据 getStatus 补，纯函数不填。 */
  services?: { provides: string[]; requires: string[] };
  children: DepChainNode[];
}

/**
 * 构建 target 的 import 依赖链路树（纯函数，只看 import 边，不碰服务）。
 * direction='upstream'：children=该节点的依赖（它需要谁）；缺失依赖标 present=false 且停止下钻（中断）。
 * direction='downstream'：children=依赖该节点的包（谁需要它），复用 findPackageDependents；不因 target 自身未装而中断。
 * isRelevant 滤掉无关第三方库（如 express），默认只跟 depMap 内的包；调用方可放宽到 @aalis scope。
 * 环检测（路径内重复即停）+ 深度上限。
 */
export function buildDependencyChain(
  target: string,
  depMap: ReadonlyMap<string, string[]>,
  direction: 'upstream' | 'downstream',
  opts: { maxDepth?: number; isRelevant?: (name: string) => boolean } = {},
): DepChainNode {
  const maxDepth = opts.maxDepth ?? 8;
  const isRelevant = opts.isRelevant ?? ((n: string) => depMap.has(n));
  const build = (name: string, depth: number, path: ReadonlySet<string>): DepChainNode => {
    const node: DepChainNode = { name, present: depMap.has(name), children: [] };
    if (depth >= maxDepth || path.has(name)) return node; // 深度 / 环 → 不下钻
    if (direction === 'upstream' && !node.present) return node; // upstream 缺失即中断（downstream 不受 target 自身存在影响）
    const nextPath = new Set(path).add(name);
    const edges =
      direction === 'upstream' ? (depMap.get(name) ?? []).filter(isRelevant) : findPackageDependents(name, depMap);
    for (const child of edges) node.children.push(build(child, depth + 1, nextPath));
    return node;
  };
  return build(target, 0, new Set());
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

/** npm packument → 装前能力清单（读 latest 版本的 aalis.service + 依赖名）。纯函数，便于单测。 */
export function toManifest(packument: {
  'dist-tags'?: { latest?: string };
  versions?: Record<
    string,
    {
      description?: string;
      aalis?: { service?: PluginManifest['service'] };
      dependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    }
  >;
}): PluginManifest | null {
  const latest = packument['dist-tags']?.latest;
  if (!latest) return null;
  const v = packument.versions?.[latest];
  const dependencies = [...new Set([...Object.keys(v?.dependencies ?? {}), ...Object.keys(v?.peerDependencies ?? {})])];
  return { name: '', version: latest, description: v?.description, service: v?.aalis?.service, dependencies };
}

/**
 * 构造单个类型关键词的 npm registry 检索 URL。纯函数，便于单测。
 * 注意：npm search 的 `keywords:a,b` 是 **AND**（须同时含），不是 OR——故四类关键词不能逗号合并成一条查询
 * （会要求一个包同时是 plugin+util+api+interface → 0 结果）。改为每类发一条、调用方合并，见 registerMarketplaceRoutes。
 */
export function buildSearchUrl(q: string, keyword: string, registryBase: string = DEFAULT_REGISTRY): string {
  const text = q ? `keywords:${keyword} ${q}` : `keywords:${keyword}`;
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
  /** 本地包扫描：`name → 依赖名[]`（含 monorepo 工作区包）。keys 补 require.resolve 在 pnpm 工作区的盲区；values 供依赖图。 */
  getLocalPackages: () => Map<string, string[]> = () => new Map(),
): void {
  // 市场列表：npm registry keyword 检索 + 标注已装。网络失败降级为空列表 + warning，
  // 不阻塞 WebUI（管理读档，与 /api/plugins 同级）。
  expressApp.get('/api/marketplace', gate(), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = getPluginMgr()?.getStatus() ?? [];
    // 已装判定独立于 getStatus（后者只含已加载运行时插件，漏掉带 marker 不加载的 api/前端/核心）。
    // 两路补判：① 本地物理存在（含 monorepo packages/ 工作区包——require.resolve 从仓库根解析不到）；
    // ② 项目根能 resolve（独立部署的扁平 node_modules / 第三方根依赖）。
    const localPkgs = getLocalPackages();
    const projectRequire = createRequire(pathToFileURL(resolve(process.cwd(), 'package.json')));
    const isPresent = (name: string): boolean => {
      if (localPkgs.has(name)) return true;
      try {
        projectRequire.resolve(`${name}/package.json`);
        return true;
      } catch {
        return false;
      }
    };
    // 四类关键词各发一条检索（npm 的 keywords 逗号是 AND 非 OR），并行后按包名合并去重 = OR。
    const fetchKw = async (kw: string): Promise<NpmSearchResponse> => {
      const r = await fetch(buildSearchUrl(q, kw, registryBase), { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`npm registry 返回 ${r.status}`);
      return (await r.json()) as NpmSearchResponse;
    };
    const settled = await Promise.allSettled(AALIS_KEYWORDS.map(fetchKw));
    const okResults = settled.filter((s): s is PromiseFulfilledResult<NpmSearchResponse> => s.status === 'fulfilled');
    if (okResults.length === 0) {
      const reason = settled.find(s => s.status === 'rejected') as PromiseRejectedResult | undefined;
      const msg = reason?.reason instanceof Error ? reason.reason.message : String(reason?.reason ?? '未知错误');
      ctx.logger.debug(`market: npm registry 检索失败: ${msg}`);
      res.json({ packages: [], warning: `无法连接 npm 仓库（${msg}），暂时只能管理本地已装插件` });
      return;
    }
    const byName = new Map<string, NonNullable<NpmSearchResponse['objects']>[number]>();
    for (const r of okResults) for (const o of r.value.objects ?? []) byName.set(o.package.name, o);
    const merged: NpmSearchResponse = { objects: [...byName.values()] };
    const installed = augmentInstalled([...byName.keys()], new Set(status.map(p => p.name)), isPresent);
    res.json({ packages: toMarketplacePackages(merged, installed) });
  });

  // 依赖图：本地 import 依赖图（name→deps 扫描）+ 运行时服务图（getStatus）合成，供装/卸/装前展示。
  // 两类边：import（链路树，可传递）+ service（每节点直接标注 + 根的提供者解析）。
  // 装前（target 本地不存在）：拉一次 packument 取其直接依赖作根种子，深层仍走本地图。
  expressApp.get('/api/marketplace/depgraph', gate(), async (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    if (!name || !PKG_NAME_RE.test(name)) {
      res.status(400).json({ error: 'name 必须是合法 npm 包名' });
      return;
    }
    const depMap = getLocalPackages();
    const status = getPluginMgr()?.getStatus() ?? [];
    const svcOf = new Map(
      status.map(p => [p.name, { provides: p.provides ?? [], requires: p.requiredServices ?? [] }]),
    );
    // target 本地没有（装前浏览）→ 拉 packument 取直接依赖 + 服务，注入工作图当根种子。
    let rootServices: { provides: string[]; requires: string[] } | undefined;
    let upstreamMap = depMap;
    if (!depMap.has(name)) {
      try {
        const base = registryBase.replace(/\/+$/, '') || DEFAULT_REGISTRY;
        const r = await fetch(`${base}/${name.replace('/', '%2F')}`, {
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        });
        if (r.ok) {
          const m = toManifest((await r.json()) as Parameters<typeof toManifest>[0]);
          if (m) {
            upstreamMap = new Map(depMap).set(name, m.dependencies ?? []);
            if (m.service) rootServices = { provides: m.service.provides ?? [], requires: m.service.required ?? [] };
          }
        }
      } catch {
        /* 拉不到就给空根，不阻断 */
      }
    }
    // upstream 放宽 isRelevant 到 @aalis scope：看得见缺失的生态依赖（中断），又不带 express 这类库噪声。
    const isRelevant = (n: string) => upstreamMap.has(n) || n.startsWith('@aalis/');
    const annotate = (node: DepChainNode): DepChainNode => ({
      ...node,
      services: svcOf.get(node.name) ?? (node.name === name ? rootServices : undefined),
      children: node.children.map(annotate),
    });
    const upstream = annotate(buildDependencyChain(name, upstreamMap, 'upstream', { isRelevant }));
    const downstream = annotate(buildDependencyChain(name, depMap, 'downstream'));
    // 根的服务需求 + 提供者解析（已装范围内；未装提供者无法解析——见 docs，留空）。
    const required = (svcOf.get(name)?.requires ?? rootServices?.requires ?? []).map(svc => ({
      service: svc,
      providedBy: status.find(p => p.name !== name && (p.provides ?? []).includes(svc))?.name ?? null,
    }));
    res.json({
      upstream,
      downstream,
      services: { required, provides: svcOf.get(name)?.provides ?? rootServices?.provides ?? [] },
      // 卸载会断服务的依赖者（与卸载路由 409 同口径），供卸载弹窗装前预警。
      serviceDependents: findServiceDependents(name, status),
    });
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
