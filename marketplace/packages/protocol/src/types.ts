/**
 * Aalis Marketplace 协议常量与类型
 *
 * 协议核心思想：
 *   - 分发物仍是标准 npm tarball（开发者可继续用 `npm pack` 产出）；
 *   - 真正约束权限/信任的元信息在 *Manifest* 里，独立于 package.json；
 *   - tarball 完整性靠 sha256，发布者身份靠 Ed25519 签名；
 *   - 客户端可配置多个 registry（多源），由客户端按 priority + 去重策略决定如何选包。
 */

/** 当前协议版本，主版本号变化即破坏性变更。 */
export const MARKETPLACE_PROTOCOL_VERSION = '1' as const;

// ---- Permissions / Capabilities ----------------------------------------------------

/**
 * 权限申明 —— 用于安装前的"危险面"摘要。
 * 客户端会把这些项展示给用户，并通过 plugin-authority.confirmDangerous 走二次确认。
 */
export type PluginPermission =
  | 'network'        // 主动发起网络请求
  | 'filesystem'     // 通过 storage 之外的途径访问磁盘（一般禁止）
  | 'shell'          // 执行 shell 命令
  | 'child-process'  // fork/spawn 子进程
  | 'native'         // 使用 native addon
  | 'env'            // 读取进程环境变量
  | 'storage'        // 访问 storage（受 storage 自身边界保护）
  | 'llm'            // 调用 LLM 服务
  | 'webui'          // 注册 WebUI 页面/路由
  | 'gateway'        // 操作消息网关（发送消息等）
  | 'scheduler'      // 注册调度任务
  | 'tools'          // 注册工具（可被 agent 调用）
  | 'memory';        // 读写记忆

// ---- Manifest ----------------------------------------------------------------------

export interface ManifestAuthor {
  /** 自然人或组织名 */
  name: string;
  email?: string;
  url?: string;
}

export interface ManifestTarball {
  /** 服务端给出的相对路径或绝对 URL，客户端会与 registry endpoint 拼接。 */
  url: string;
  /** 大小（字节），用于客户端校验 + 进度展示。 */
  size: number;
  /** 算法固定 sha256，hex 编码。 */
  sha256: string;
}

export interface ManifestSignature {
  algorithm: 'ed25519';
  /** 发布者公钥 ID（registry 侧分配）。 */
  publisherKeyId: string;
  /** 对 *规范化* 过的 manifest（不含 signature 字段）做签名后的 base64。 */
  value: string;
}

/** 仓库描述（npm package.json 的 repository 子集）。 */
export interface ManifestRepository {
  type?: string;
  url: string;
  directory?: string;
}

/** 审核状态：客户端可按策略过滤未审核包。 */
export type AuditStatus = 'pending' | 'approved' | 'blocked';

/**
 * 单个版本的完整 manifest。
 * 客户端在安装前会拉取并验证它。
 */
export interface PluginManifest {
  /** 协议版本，等于 {@link MARKETPLACE_PROTOCOL_VERSION}。 */
  protocol: string;
  /** npm 包名。不限制必须以 @aalis/ 开头。 */
  name: string;
  /** 语义化版本。 */
  version: string;
  displayName?: string;
  description?: string;
  homepage?: string;
  /** 仓库信息（npm 标准字段镜像）。仅用于 UI 头像解析、跳转。 */
  repository?: ManifestRepository;
  license?: string;
  author?: ManifestAuthor;
  /** 兼容的 Aalis core 版本范围（semver range）。 */
  engines?: { aalis?: string; node?: string };
  /** 该插件 provides 的服务名（用于依赖图展示）。 */
  provides?: string[];
  /** 该插件 inject 的服务名。 */
  inject?: string[];
  /** 必须申明的权限集合，安装前会在 UI 上展示。 */
  permissions: PluginPermission[];
  /** 仅声明性，便于客户端做能力筛选。 */
  capabilities?: string[];
  /** 关键字 / 标签。 */
  keywords?: string[];
  /** tarball 信息。 */
  tarball: ManifestTarball;
  /** 服务端审核状态。 */
  audit: AuditStatus;
  /** 发布时间（ISO 字符串）。 */
  publishedAt: string;
  /** 弃用信息：非 null 表示该版本被弃用。 */
  deprecated?: string | null;
  /** Ed25519 签名。计算签名时 *本字段不参与序列化*。 */
  signature?: ManifestSignature;
}

// ---- Index / Search ----------------------------------------------------------------

/** 列表项，搜索/列表 API 返回。 */
export interface PluginIndexEntry {
  name: string;
  latest: string;
  versions: string[];
  displayName?: string;
  description?: string;
  author?: ManifestAuthor;
  homepage?: string;
  repository?: ManifestRepository;
  keywords?: string[];
  audit: AuditStatus;
  permissions: PluginPermission[];
  /** 并列出 manifest 中的服务提供/依赖，便于市场列表页做依赖推荐。 */
  provides?: string[];
  inject?: string[];
  publishedAt: string;
}

export interface PluginListResponse {
  protocol: string;
  total: number;
  items: PluginIndexEntry[];
  /** 服务端可选返回的 root 公钥列表，客户端可与本地配置交叉校验。 */
  publishers?: PublisherInfo[];
}

export interface PluginDetailResponse {
  protocol: string;
  name: string;
  latest: string;
  /** 按版本号倒序的所有 manifest（不含 tarball 二进制）。 */
  versions: PluginManifest[];
}

// ---- Publisher ----------------------------------------------------------------------

export interface PublisherInfo {
  id: string;
  name: string;
  /** Ed25519 公钥，base64。 */
  publicKey: string;
  /** 官方发布者标志（仅供 UI 展示）。 */
  official?: boolean;
  createdAt: string;
}

// ---- 路由常量 ---------------------------------------------------------------------

export const ROUTES = {
  list: '/v1/plugins',
  detail: (name: string) => `/v1/plugins/${encodeURIComponent(name)}`,
  manifest: (name: string, version: string) =>
    `/v1/plugins/${encodeURIComponent(name)}/${encodeURIComponent(version)}/manifest`,
  tarball: (name: string, version: string) =>
    `/v1/plugins/${encodeURIComponent(name)}/${encodeURIComponent(version)}/tarball`,
  publishers: '/v1/publishers',
} as const;
