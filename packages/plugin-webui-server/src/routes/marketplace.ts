import type { Context, PluginManagerService } from '@aalis/core';
import type { PackageManagerService } from '@aalis/plugin-package-manager';
import type express from 'express';
import type { RouteGate } from '../gate.js';

// 纯 npm 路线：npm registry 的 keyword 检索即天然索引（同 koishi 的 koishi-plugin
// 模式），无自建服务器、无静态索引。分发走 package-manager 的 npm pack。
// 注：npm 的 search API 并非所有镜像都支持（淘宝等国内源不支持），故 registry
// 基址可配置（marketplaceRegistry），默认官方源；国内用户可配代理/支持 search 的镜像。
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const AALIS_KEYWORD = 'aalis-plugin';
const SEARCH_TIMEOUT_MS = 8000;
const PKG_NAME_RE = /^(@[a-z0-9\-_.]+\/)?[a-z0-9\-_.]+$/i;

interface MarketplacePackage {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** 该插件名是否已在本地激活/注册 */
  installed: boolean;
}

interface NpmSearchResponse {
  objects?: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      publisher?: { username?: string };
    };
  }>;
}

/** npm search 响应 → 市场卡片列表（标注哪些已在本地激活）。纯函数，便于单测。 */
export function toMarketplacePackages(data: NpmSearchResponse, installed: Set<string>): MarketplacePackage[] {
  return (data.objects ?? []).map(o => ({
    name: o.package.name,
    version: o.package.version,
    description: o.package.description ?? '',
    author: o.package.publisher?.username,
    installed: installed.has(o.package.name),
  }));
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
  // 市场列表：npm registry keyword 检索 + 标注已装。网络失败降级为空列表 + warning，
  // 不阻塞 WebUI（管理读档，与 /api/plugins 同级）。
  expressApp.get('/api/marketplace', gate('webui:marketplace:read', 4), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const installed = new Set((getPluginMgr()?.getStatus() ?? []).map(p => p.name));
    try {
      const r = await fetch(buildSearchUrl(q, registryBase), { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`npm registry 返回 ${r.status}`);
      const data = (await r.json()) as NpmSearchResponse;
      res.json({ packages: toMarketplacePackages(data, installed) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.debug(`market: npm registry 检索失败: ${msg}`);
      res.json({ packages: [], warning: `无法连接 npm 仓库（${msg}），暂时只能管理本地已装插件` });
    }
  });

  // 安装：复用 package-manager 的 npm pack 流程；owner 级（安装第三方代码 = 高危）。
  expressApp.post('/api/marketplace/install', gate('webui:plugins:manage', 'owner'), async (req, res) => {
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
}
