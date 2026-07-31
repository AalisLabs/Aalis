import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context, PluginManagerService, PluginStatusEntry } from '@aalis/core';
import type { PackageManagerService } from '@aalis/plugin-package-manager';
import { classifyDepSpec, type DepOrigin, isRegistryDep, isUpgrade } from '@aalis/util-dep-spec';
import type express from 'express';
import type { LocalScanEntry } from '../client-discovery.js';
import type { RouteGate } from '../gate.js';

// 纯 npm 路线：npm registry 的 keyword 检索即天然索引，无自建服务器、无静态索引。
// 分发走 package-manager 的 npm pack。
// 注：npm 的 search API 并非所有镜像都支持（淘宝等国内源不支持），故 registry
// 基址可配置（marketplaceRegistry），默认官方源；国内用户可配代理/支持 search 的镜像。
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
// 市场收录四类：功能插件 aalis-plugin / 工具库 aalis-util / 契约 aalis-api / 前端 aalis-interface。
// npm search 的 keywords: 逗号分隔 = 任一命中（核心/工具链不带任何类型词，自然不进市场）。
const AALIS_KEYWORDS = ['aalis-plugin', 'aalis-util', 'aalis-api', 'aalis-schema', 'aalis-interface'];
const SEARCH_TIMEOUT_MS = 8000;
// 合法 npm 包名（可选 scope）+ 可选 @version 后缀（支持指定版本安装）。
//
// 名段与版本段的首字符**都**必须是字母数字。该值最终作为一个 argv 传给 npm，而 npm 会：
//   - 把以 `-` 开头的 token 当命令行标志（`--force`、`--ignore-scripts` 都是 npm 上真实存在的可发布包名）；
//   - 把 `.` / `..` / `./x` 当本地目录 spec —— **`foo@.` 与 `@a/b@..` 同样是目录 spec**，
//     只锚名段挡不住；实测这条能让 npm 转去打包宿主工作目录并执行其 prepack/prepare 生命周期脚本。
// 两段各自锚住首字符，即封死目录 spec 与标志注入两条面。
const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9\-_.]*\/)?[a-z0-9][a-z0-9\-_.]*(@[a-z0-9][a-z0-9.-]*)?$/i;

interface MarketplacePackage {
  name: string;
  /** npm 上的最新版（检索结果自带）。注意：**不是**本地已装版本，那是 resolved。 */
  version: string;
  description: string;
  author?: string;
  /** 该插件名是否已在本地激活/注册 */
  installed: boolean;
  /** 本地已装版本。未装 / 版本读不到则缺省。**判「可更新」看 updatable，不要自己比版本。** */
  resolved?: string;
  /** 根 package.json 里的原始声明（`^0.9.1` / `workspace:*` / `file:../x`）。未装或非直接依赖为 undefined。 */
  request?: string;
  /** 本地这份从哪来（展示用的来源徽章）。未装则缺省。 */
  origin?: PkgOrigin;
  /**
   * 此刻能否经市场更新 = 来源是 registry + version 严格新于 resolved。
   *
   * **服务端算，前端直接用。** 前端曾自己拿 `resolved !== version` 再叠一个 origin 判断，
   * 三份判据（这里 / package-manager 的闸 / 前端）互不一致，实测出过两类错：字符串不等把
   * 「latest 低于本地」渲染成可更新并真的降级；GitHub 简写依赖出了勾选框却被服务端闸整批否决。
   */
  updatable: boolean;
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

/**
 * 市场组件类别。'plugin'=可装卸功能；'api'=服务契约（只读）；'schema'=数据格式规范（只读）；
 * 'interface'=前端界面（可换）；'util'=工具库（被插件 import）
 *
 * 'api' 与 'schema' 的界线：`-api` 必然 declare 一个 `ServiceTypeMap` 成员（有服务可
 * `ctx.getService`）；`schema-*` 只定义跨服务流动的数据形状（`Message` / `ConfigSchema`），
 * 无对应服务、不可能有第二实现。
 */
type PackageCategory = 'plugin' | 'api' | 'schema' | 'interface' | 'util';

/**
 * 按**类型关键词**分类（npm search 直接返回 keywords，与加载约定的类型词 1:1，可靠）。
 * 市场搜索已保证结果只含 aalis-plugin/util/api/schema/interface 之一，无需再靠包名猜测。纯函数，便于单测。
 */
export function classifyPackage(keywords: string[]): PackageCategory {
  if (keywords.includes('aalis-interface')) return 'interface';
  if (keywords.includes('aalis-api')) return 'api';
  if (keywords.includes('aalis-schema')) return 'schema';
  if (keywords.includes('aalis-util')) return 'util';
  return 'plugin'; // 进了市场却非上述四类 → 必是功能插件（aalis-plugin）
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

/**
 * 本地这份包从哪来。
 *
 * 判据是**根 package.json 的依赖声明**，不是解析出来的文件路径——路径只说明代码躺在哪，
 * 说明不了它归谁管。典型反例：传递依赖（父包拉进来的）和直装包一样躺在 node_modules 里，
 * 路径完全相同，但前者的版本由父包的范围决定，市场独立升它只会和父包打架。
 *
 * 分档实现住在 `@aalis/util-dep-spec`：更新闸（package-manager）与这里的展示必须用同一份，
 * 否则会出现「前端给了勾选框、提交后被闸整批否决」。曾实测发生过，见该模块顶部注释。
 */
export type PkgOrigin = DepOrigin;

/** 本地已装包的实况。未装则 undefined。 */
export interface LocalPkgInfo {
  version?: string;
  request?: string;
  origin: PkgOrigin;
  keywords?: string[];
  description?: string;
}

/**
 * 汇总三路信号判定本地实况。纯函数，便于单测——这处判断依赖部署形态，易错，必须能被测住。
 *
 * @param request 根 package.json 里该包的依赖声明；不在其中则 undefined
 * @param meta    从项目根 resolve 到并读出的 package.json；resolve 不到则 undefined
 * @param inScan  该包是否出现在本地目录扫描结果里（扫 monorepo packages/ 与 node_modules/@aalis）
 */
export function resolveLocalInfo(
  request: string | undefined,
  meta: { version?: string; keywords?: string[]; description?: string } | undefined,
  scanned: { version?: string; keywords?: string[]; description?: string } | undefined,
): LocalPkgInfo | undefined {
  if (meta) {
    return {
      version: meta.version,
      request,
      origin: classifyDepSpec(request),
      keywords: meta.keywords,
      description: meta.description,
    };
  }
  // resolve 不到（不在 node_modules）却被扫描扫出来 → 只能来自 monorepo 的 packages/ 源码目录。
  // 此处不可沿用 classifyDepSpec(undefined)=transitive：那是「在 node_modules 里但非直接依赖」
  // 的语义，而这里的包压根不在 node_modules。实测本仓库 @aalis/plugin-commands 等全走这条分支。
  //
  // 元数据取自扫描时读到的那份 package.json：pnpm 工作区下根 node_modules 只链根依赖
  // （本仓库根 dependencies 仅 core 与 runtime），packages/ 下的包一律 resolve 不到，故这条
  // 分支是工作区形态的**常态**而非边角。两处都不能省：
  //   - 不带 version，前端的 `resolved ?? version` 兜底就把 npm latest 当成已装版本显示
  //     （实测 93 张卡片里 91 张显示的是远端版本号）；
  //   - 不带 keywords，**离线降级列表整批看不见工作区包**——toLocalPackages 按 keywords 筛
  //     aalis 组件，而国内多数镜像不支持 search API，降级是常态路径。
  if (scanned) {
    return {
      version: scanned.version,
      request,
      origin: 'workspace',
      keywords: scanned.keywords,
      description: scanned.description,
    };
  }
  return undefined;
}

/**
 * 读根 package.json 的 dependencies —— 来源判据与系统组件名单的唯一真相源。
 * **每次调用重读**：安装/卸载/更新都会改写它，缓存会让页面显示陈旧来源。
 */
function readRootDependencies(): Record<string, string> {
  try {
    const root = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    return root.dependencies ?? {};
  } catch {
    return {};
  }
}

/** 系统组件卡片：本地实况为准，`latest` 由按精确包名的 registry 查询补齐（拿不到则 undefined）。 */
export interface SystemComponent {
  name: string;
  /** 本地已装版本 */
  version?: string;
  /** registry 上的最新版；与 version 不等即可更新。离线/查不到时 undefined。 */
  latest?: string;
  /** 根 package.json 里的依赖声明；不在根依赖里（传递依赖/工作区包）则 undefined。 */
  request?: string;
  /**
   * 来源分档（展示徽章用）。**必须独立下发，不能让前端从 updatable 反推**：
   * updatable 里折进了版本序，于是「已是最新版的 registry 组件」和「离线查不到 latest 的组件」
   * 都会 updatable=false，反推就把它们错标成「依赖引入」。
   */
  origin: DepOrigin;
  description?: string;
  /** 分类：内核 / 宿主 / 服务契约 / 数据规范 / 工具库 */
  kind: 'core' | 'runtime' | 'api' | 'schema' | 'util';
  /**
   * 是否可经市场更新。**只有根 `dependencies` 里以 semver 范围声明的才可以**。
   *
   * 传递依赖（被某个插件带进来的 `-api` / `schema` / `util`）不可更新：`npm install <name>@<ver>`
   * 对它们的语义是「加进根 dependencies」，而父包声明的范围若不含新版就会**嵌套装第二份**——
   * 于是同一个契约包出现两份，两份 `declare module` 撞成 TS2717 且被 `skipLibCheck` 静默吞掉，
   * 而插件运行时加载的仍是自己 node_modules 里的旧版，更新对它零效果。
   * 这与市场页用 `origin === 'registry'` 挡住传递依赖是同一道闸。
   */
  updatable: boolean;
}

/**
 * 按 keywords 判定系统组件分类；非系统组件返回 undefined。
 *
 * `aalis-core` / `aalis-runtime` **故意不进 `AALIS_KEYWORDS`**——那个常量是 npm 检索轴，
 * 而关键词是开放命名空间：任何人都能发一个带 `aalis-core` 关键词的包，在市场里拿到一张
 * 「内核」卡片。本函数的输入只来自**本地已装包**的 keywords（不可伪造），关键词在这里
 * 只作分类标注；版本查询按精确包名而非关键词搜索，故不存在冒名空间。纯函数，便于单测。
 */
export function classifySystemComponent(keywords: readonly string[] | undefined): SystemComponent['kind'] | undefined {
  const kw = keywords ?? [];
  if (kw.includes('aalis-core')) return 'core';
  if (kw.includes('aalis-runtime')) return 'runtime';
  if (kw.includes('aalis-api')) return 'api';
  if (kw.includes('aalis-schema')) return 'schema';
  if (kw.includes('aalis-util')) return 'util';
  return undefined;
}

/** 组件排序：内核与宿主置顶（更新它们必须全量重启），其余按类型再按名。 */
const SYSTEM_KIND_ORDER: Record<SystemComponent['kind'], number> = { core: 0, runtime: 1, api: 2, schema: 3, util: 4 };
export function sortSystemComponents(list: SystemComponent[]): SystemComponent[] {
  return [...list].sort(
    (a, b) => SYSTEM_KIND_ORDER[a.kind] - SYSTEM_KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
}

/** npm search 响应 → 市场卡片列表（标注已装 + 官方 + 富信息）。纯函数，便于单测。 */
export function toMarketplacePackages(
  data: NpmSearchResponse,
  installed: Set<string>,
  /** 本地实况查询。缺省则卡片无 resolved，前端退化为「已安装但版本未知」。 */
  localOf: (name: string) => LocalPkgInfo | undefined = () => undefined,
): MarketplacePackage[] {
  return (data.objects ?? []).map(o => {
    const local = localOf(o.package.name);
    return {
      name: o.package.name,
      version: o.package.version,
      resolved: local?.version,
      request: local?.request,
      origin: local?.origin,
      // 与 package-manager 的更新闸同一份实现（@aalis/util-dep-spec），定义上不可能分岔。
      updatable: isRegistryDep(local?.request) && isUpgrade(local?.version, o.package.version),
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
    };
  });
}

/**
 * npm 检索不可达时的降级卡片：只用本地实况拼。
 * 国内多数镜像不支持 search API，这是常态而非边角情形——降级必须仍能管理已装插件，
 * 而不是给一句 warning 配一张空列表。分类走本地 keywords，与在线路径同一判据。纯函数，便于单测。
 */
export function toLocalPackages(local: ReadonlyMap<string, LocalPkgInfo>): MarketplacePackage[] {
  return [...local.entries()]
    .filter(([, info]) => (info.keywords ?? []).some(k => AALIS_KEYWORDS.includes(k)))
    .map(([name, info]) => ({
      name,
      // 离线拿不到 npm latest，用本地版本占位。
      version: info.version ?? '',
      resolved: info.version,
      request: info.request,
      origin: info.origin,
      // 离线路径下没有「远端更新版」这个信息，一律不可更新——不是判据放宽，是事实缺失。
      updatable: false,
      description: info.description ?? '',
      installed: true,
      official: name.startsWith('@aalis/'),
      category: classifyPackage(info.keywords ?? []),
      keywords: (info.keywords ?? []).filter(k => !AALIS_KEYWORDS.includes(k)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
  getLocalPackages: () => Map<string, LocalScanEntry> = () => new Map(),
): void {
  // 市场列表：npm registry keyword 检索 + 标注已装。网络失败降级为空列表 + warning，
  // 不阻塞 WebUI（管理读档，与 /api/plugins 同级）。
  expressApp.get('/api/marketplace', gate(), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = getPluginMgr()?.getStatus() ?? [];
    // 已装判定独立于 getStatus（后者只含已加载运行时插件，漏掉带 marker 不加载的 api/前端/核心）。
    // 同一次解析顺带取出本地版本：卡片上的 version 是 npm latest，只有拿到本地 resolved
    // 才能判「可更新」（版本序由服务端算进 updatable 下发，前端不自算）。
    const localPkgs = getLocalPackages();
    const projectRequire = createRequire(pathToFileURL(resolve(process.cwd(), 'package.json')));
    const rootDeps = readRootDependencies();
    /** 读本地 package.json。用 resolve+readFileSync 而非 require()：require 有模块缓存，更新后会返回旧版本号。 */
    const readPkgJson = (name: string) => {
      try {
        return JSON.parse(readFileSync(projectRequire.resolve(`${name}/package.json`), 'utf-8')) as {
          version?: string;
          keywords?: string[];
          description?: string;
        };
      } catch {
        return undefined;
      }
    };
    const readLocal = (name: string): LocalPkgInfo | undefined =>
      resolveLocalInfo(rootDeps[name], readPkgJson(name), localPkgs.get(name));
    /** 每个包名只读一次盘，已装判定与版本展示共用。 */
    const localCache = new Map<string, LocalPkgInfo>();
    const localOf = (name: string): LocalPkgInfo | undefined => {
      if (localCache.has(name)) return localCache.get(name);
      const info = readLocal(name);
      if (info) localCache.set(name, info);
      return info;
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
      // 降级：只列本地已装。名单取自本地扫描 + 运行时已加载插件（后者覆盖扫描目录之外的部署）。
      const names = new Set([...localPkgs.keys(), ...status.map(p => p.name)]);
      for (const n of names) localOf(n);
      res.json({
        packages: toLocalPackages(localCache),
        warning: `无法连接 npm 仓库（${msg}），暂时只能管理本地已装插件`,
      });
      return;
    }
    const byName = new Map<string, NonNullable<NpmSearchResponse['objects']>[number]>();
    for (const r of okResults) for (const o of r.value.objects ?? []) byName.set(o.package.name, o);
    const merged: NpmSearchResponse = { objects: [...byName.values()] };
    const installed = augmentInstalled(
      [...byName.keys()],
      new Set(status.map(p => p.name)),
      n => localOf(n) !== undefined,
    );
    res.json({ packages: toMarketplacePackages(merged, installed, localOf) });
  });

  // 系统组件：内核 / 宿主 / 契约 / 规范 / 工具库。**列表只来自本地实况**（已装包 + 根依赖表），
  // 不走 npm 关键词检索——关键词是开放命名空间，任何人都能发一个带 aalis-core 关键词的包，
  // 在市场里拿到一张「内核」卡片。版本查询按精确包名，故不存在冒名空间。
  // 这一页只提供更新，无安装无卸载：它们要么随脚手架就位，要么是插件的依赖被自动带入。
  expressApp.get('/api/system-components', gate(), async (_req, res) => {
    const localPkgs = getLocalPackages();
    const projectRequire = createRequire(pathToFileURL(resolve(process.cwd(), 'package.json')));
    const rootDeps = readRootDependencies();
    /** 候选名单：本地扫描到的 + 根依赖里声明的。两路并集才覆盖两种部署形态。 */
    const candidates = new Set([...localPkgs.keys(), ...Object.keys(rootDeps)]);

    const components: SystemComponent[] = [];
    for (const name of candidates) {
      let meta: { version?: string; keywords?: string[]; description?: string } | undefined;
      try {
        // readFileSync 而非 require()：require 有模块缓存，更新后会返回旧版本号。
        meta = JSON.parse(readFileSync(projectRequire.resolve(`${name}/package.json`), 'utf-8'));
      } catch {
        continue; // resolve 不到（工作区源码目录里的包）——无版本可比，不进本页
      }
      const kind = classifySystemComponent(meta?.keywords);
      if (!kind) continue;
      components.push({
        name,
        version: meta?.version,
        request: rootDeps[name],
        origin: classifyDepSpec(rootDeps[name]),
        description: meta?.description,
        kind,
        // 与市场页、与 package-manager 的闸同一份实现。latest 尚未查到，故版本序在下面补判。
        updatable: isRegistryDep(rootDeps[name]),
      });
    }

    // 按精确包名并发查 latest；任何一条失败只让该行缺 latest（显示"—"），不拖垮整页。
    const base = registryBase.replace(/\/+$/, '') || DEFAULT_REGISTRY;
    await Promise.all(
      components.map(async c => {
        try {
          const r = await fetch(`${base}/${c.name.replace('/', '%2F')}`, {
            signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          });
          if (!r.ok) return;
          const p = (await r.json()) as { 'dist-tags'?: { latest?: string } };
          c.latest = p['dist-tags']?.latest;
        } catch {
          /* 离线/镜像不支持：该行不显示可更新，不报错 */
        } finally {
          // 版本序补判：来源合格还不够，latest 必须**严格新于**本地。dist-tags.latest 可以
          // 低于本地已装版本（发布事故后回滚 tag，或用户装过预发布版），漏了这一判就会把
          // 降级渲染成更新。查不到 latest 同样落 false。
          c.updatable = c.updatable && isUpgrade(c.version, c.latest);
        }
      }),
    );
    res.json({ components: sortSystemComponents(components) });
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
    // 图算法只认 name→依赖名[]，不该知道版本；在此把扫描结果投影成它要的形状。
    const depMap = new Map([...getLocalPackages()].map(([n, e]) => [n, e.deps] as const));
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

  // 批量更新：owner 级。**整批提交**，不是每张卡片各调一次——
  // peer 冲突只有对整张版本映射一次预检才能发现，且重启次数恒为 1（与改了多少包无关）。
  expressApp.post('/api/marketplace/update', gate(), async (req, res) => {
    const raw = req.body?.targets;
    if (!Array.isArray(raw) || raw.length === 0) {
      res.status(400).json({ error: 'targets 必须是非空数组' });
      return;
    }
    // 形状校验只做「是不是两个字符串」；包名/版本/总量的校验都在 package-manager 的
    // buildUpdateSpecs 里统一做——那里是所有调用方（含直接拿服务的插件）的必经之路，
    // 而总量的真实约束是 argv 字节数（见该处 SPEC_ARGV_BUDGET），不是包个数。
    const targets = raw.map((t: unknown) => ({
      name: typeof (t as { name?: unknown })?.name === 'string' ? (t as { name: string }).name : '',
      version: typeof (t as { version?: unknown })?.version === 'string' ? (t as { version: string }).version : '',
    }));
    const pkgMgr = ctx.getService<PackageManagerService>('package-manager');
    if (!pkgMgr) {
      res.status(503).json({ error: 'package-manager 服务未启用，无法更新' });
      return;
    }
    try {
      const result = await pkgMgr.update(targets);
      // 成功时进程即将重启：先把响应刷出去，否则客户端只会看到连接被切断。
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
