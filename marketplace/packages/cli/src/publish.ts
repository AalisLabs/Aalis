/**
 * 发布流程：
 *   1. 在指定插件目录跑 `npm pack` → 拿到 tarball；
 *   2. 计算 sha256 + size；
 *   3. 读 package.json 推导 manifest 字段（permissions 必须显式给）；
 *   4. 用本地私钥签名；
 *   5. POST 到 mock server 的 admin API（或直接落到本地 store 目录）。
 */
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve as pathResolve, basename } from 'node:path';
import { promisify } from 'node:util';

import {
  MARKETPLACE_PROTOCOL_VERSION,
  type PluginManifest,
  type PluginPermission,
  ROUTES,
  sha256Hex,
  signManifest,
} from '@aalis-marketplace/protocol';

const execFileAsync = promisify(execFile);

interface PluginPkgJson {
  name: string;
  version: string;
  description?: string;
  homepage?: string;
  /**
   * npm 标准字段。类似 `https://github.com/foo/bar` 或
   * `{ type: 'git', url: 'git+https://github.com/foo/bar.git' }`。
   */
  repository?: string | { type?: string; url: string; directory?: string };
  license?: string;
  keywords?: string[];
  author?: string | { name: string; email?: string; url?: string };
  engines?: { node?: string };
  aalis?: {
    /** 插件 displayName */
    displayName?: string;
    /** 提供的服务 */
    provides?: string[];
    /** 注入的服务 */
    inject?: string[];
    /** 必须显式声明的权限 */
    permissions: PluginPermission[];
    capabilities?: string[];
    /** 兼容的 core 版本范围 */
    coreRange?: string;
    /** 是否为随包分发的官方核心插件 */
    bundled?: boolean;
  };
}

export interface PublishOptions {
  /** 插件源码目录（包含 package.json） */
  pluginDir: string;
  /** 输出 store 目录（直接落盘）；与 endpoint 互斥 */
  storeDir?: string;
  /** mock server 端点；与 storeDir 互斥 */
  endpoint?: string;
  /** 私钥 PEM 路径 */
  privateKeyPath: string;
  /** 发布者 keyId */
  publisherKeyId: string;
  /** admin token（推送到 server 时使用） */
  adminToken?: string;
}

export async function publishPlugin(options: PublishOptions): Promise<PluginManifest> {
  const pluginDir = pathResolve(options.pluginDir);
  const pkgPath = pathResolve(pluginDir, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`未找到 package.json: ${pkgPath}`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PluginPkgJson;
  if (!pkg.aalis || !Array.isArray(pkg.aalis.permissions)) {
    throw new Error('package.json 缺少 aalis.permissions（必须显式声明权限集合）');
  }

  const tmpDir = pathResolve(pluginDir, '.aalis-pack');
  await mkdir(tmpDir, { recursive: true });
  console.log(`[publish] npm pack ${pkg.name}@${pkg.version}`);
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--silent', '--pack-destination', tmpDir],
    { cwd: pluginDir },
  );
  const tgzName = stdout.trim().split(/\r?\n/).pop()!;
  const tgzPath = pathResolve(tmpDir, tgzName);
  const tgzBuf = await readFile(tgzPath);
  const sha = sha256Hex(tgzBuf);
  const size = tgzBuf.byteLength;

  const author =
    typeof pkg.author === 'string'
      ? { name: pkg.author }
      : pkg.author;

  // npm 的 repository 字段可以是字符串或对象，统一归一
  const repository =
    typeof pkg.repository === 'string'
      ? { url: pkg.repository }
      : pkg.repository;

  const manifestUnsigned: PluginManifest = {
    protocol: MARKETPLACE_PROTOCOL_VERSION,
    name: pkg.name,
    version: pkg.version,
    displayName: pkg.aalis.displayName,
    description: pkg.description,
    homepage: pkg.homepage,
    repository,
    license: pkg.license,
    author,
    engines: {
      aalis: pkg.aalis.coreRange,
      node: pkg.engines?.node,
    },
    provides: pkg.aalis.provides,
    inject: pkg.aalis.inject,
    permissions: pkg.aalis.permissions,
    capabilities: pkg.aalis.capabilities,
    keywords: pkg.keywords,
    tarball: {
      url: ROUTES.tarball(pkg.name, pkg.version),
      size,
      sha256: sha,
    },
    audit: 'pending',
    bundled: pkg.aalis.bundled === true ? true : undefined,
    publishedAt: new Date().toISOString(),
  };

  const privateKeyPem = readFileSync(options.privateKeyPath, 'utf8');
  const manifest = signManifest(manifestUnsigned, privateKeyPem, options.publisherKeyId);

  if (options.storeDir) {
    await dropToStore(options.storeDir, manifest, tgzPath);
  } else if (options.endpoint) {
    await pushToServer(options.endpoint, manifest, tgzBuf, options.adminToken);
  } else {
    throw new Error('必须指定 --store 或 --endpoint');
  }

  console.log(`[publish] 完成 ${pkg.name}@${pkg.version}  sha256=${sha}`);
  return manifest;
}

async function dropToStore(
  storeDir: string,
  manifest: PluginManifest,
  tgzPath: string,
) {
  const versionDir = pathResolve(
    storeDir,
    'plugins',
    encodeURIComponent(manifest.name),
    encodeURIComponent(manifest.version),
  );
  await mkdir(versionDir, { recursive: true });
  await writeFile(
    pathResolve(versionDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
  const target = pathResolve(versionDir, basename(tgzPath));
  await rename(tgzPath, target);
}

async function pushToServer(
  endpoint: string,
  manifest: PluginManifest,
  tgz: Buffer,
  adminToken?: string,
) {
  const base = endpoint.replace(/\/$/, '');
  const url = `${base}/admin/publish`;
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
  if (adminToken) headers['authorization'] = `Bearer ${adminToken}`;
  headers['x-manifest'] = Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
  // Convert Node Buffer to ArrayBuffer for fetch BodyInit compatibility
  const body = tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.byteLength);
  const res = await fetch(url, { method: 'POST', headers, body: body as ArrayBuffer });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`推送 ${url} 失败: ${res.status} ${text}`);
  }
}

// 兼容老的常量字段引用
void ROUTES;
void createReadStream;
