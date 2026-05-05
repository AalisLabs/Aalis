/**
 * Seed the local marketplace store with real plugins copied from this repo.
 *
 * 自动扫描 packages/plugin-* 下的所有插件并发布到本地 store。
 * 过滤规则：
 *   - 跳过 aalis.core / aalis.client 的包；
 *   - 跳过 keywords 不含 'aalis-plugin' 的包（如 plugin-sdk）；
 *   - SKIP_DIRS 中显式排除的。
 * 元数据从 package.json 的 description / keywords / aalis.* 读取，缺失则用合理默认值。
 *
 * Run from marketplace/:
 *   pnpm tsx scripts/seed.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PluginPermission } from '../packages/protocol/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(ROOT, '..');
const STORE_DIR = resolve(ROOT, 'apps/server/store');
const KEYS_DIR = resolve(ROOT, 'keys');
const TMP_DIR = resolve(ROOT, '.seed-real-plugins');

/** 显式跳过（除了 aalis.core/client/essential 已自动跳过外的额外排除项） */
const SKIP_DIRS = new Set<string>([
  // 'plugin-xxx',
]);

interface SeedPlugin {
  dir: string;
  pkgName: string;
  displayName: string;
  description: string;
  permissions: PluginPermission[];
  provides?: string[];
  inject?: string[];
  capabilities?: string[];
  keywords: string[];
  audit: 'approved' | 'pending' | 'blocked';
}

const { publishPlugin } = await import('../packages/cli/dist/index.js');

const keyFiles = existsSync(KEYS_DIR)
  ? readdirSync(KEYS_DIR).filter(file => file.endsWith('.private.pem'))
  : [];
if (!keyFiles.length) {
  console.error('[seed] 未在 keys/ 目录找到私钥，请先执行 pnpm keygen');
  process.exit(1);
}

const privateKeyFile = resolve(KEYS_DIR, keyFiles[0]);
const keyId = keyFiles[0].replace(/\.private\.pem$/, '');
const publicKeyB64File = resolve(KEYS_DIR, `${keyId}.public.b64`);
const publicKey = existsSync(publicKeyB64File)
  ? readFileSync(publicKeyB64File, 'utf8').trim()
  : '';

console.log(`[seed] keyId = ${keyId}`);

await rm(resolve(STORE_DIR, 'plugins'), { recursive: true, force: true });
await rm(TMP_DIR, { recursive: true, force: true });
await mkdir(STORE_DIR, { recursive: true });
await mkdir(TMP_DIR, { recursive: true });

await writeFile(
  resolve(STORE_DIR, 'publishers.json'),
  JSON.stringify([
    {
      id: keyId,
      name: 'Aalis Official',
      publicKey,
      official: true,
      createdAt: new Date().toISOString(),
    },
  ], null, 2) + '\n',
  'utf8',
);

const packagePathByName = buildPackageMap();
const SEED_PLUGINS = discoverSeedPlugins();
console.log(`[seed] 自动扫描到 ${SEED_PLUGINS.length} 个可发布插件`);

for (const seed of SEED_PLUGINS) {
  const sourceDir = resolve(REPO_ROOT, 'packages', seed.dir);
  const targetDir = resolve(TMP_DIR, seed.dir);

  await cp(sourceDir, targetDir, {
    recursive: true,
    filter: src => !src.includes('/node_modules/') && !src.includes('/.aalis-pack/'),
  });

  const pkgFile = resolve(targetDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgFile, 'utf8')) as Record<string, unknown>;
  pkg.description = seed.description;
  pkg.keywords = seed.keywords;
  pkg.license ??= 'MIT';
  pkg.author ??= { name: 'Aalis Contributors' };
  pkg.homepage ??= 'https://github.com/NyanAce/Aalis';
  pkg.repository ??= {
    type: 'git',
    url: 'https://github.com/NyanAce/Aalis.git',
    directory: `packages/${seed.dir}`,
  };
  pkg.engines = { ...(pkg.engines as Record<string, string> | undefined), node: '>=20' };
  pkg.dependencies = rewriteWorkspaceDeps(pkg.dependencies as Record<string, string> | undefined, packagePathByName);
  pkg.peerDependencies = rewriteWorkspaceDeps(pkg.peerDependencies as Record<string, string> | undefined, packagePathByName);
  pkg.aalis = {
    ...(pkg.aalis as Record<string, unknown> | undefined),
    displayName: seed.displayName,
    permissions: seed.permissions,
    provides: seed.provides,
    inject: seed.inject,
    capabilities: seed.capabilities,
    coreRange: '>=0.1.0',
  };
  await writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  const manifest = await publishPlugin({
    pluginDir: targetDir,
    storeDir: STORE_DIR,
    privateKeyPath: privateKeyFile,
    publisherKeyId: keyId,
  });

  const manifestFile = resolve(
    STORE_DIR,
    'plugins',
    encodeURIComponent(manifest.name),
    encodeURIComponent(manifest.version),
    'manifest.json',
  );
  const stored = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
  stored.audit = seed.audit;
  await writeFile(manifestFile, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  console.log(`[seed] ${manifest.name}@${manifest.version} audit -> ${seed.audit}`);
}

await rm(TMP_DIR, { recursive: true, force: true });
console.log(`\n[seed] 完成，真实插件已写入 ${STORE_DIR}`);

function discoverSeedPlugins(): SeedPlugin[] {
  const packagesDir = resolve(REPO_ROOT, 'packages');
  const plugins: SeedPlugin[] = [];
  for (const dir of readdirSync(packagesDir)) {
    if (!dir.startsWith('plugin-')) continue;
    if (SKIP_DIRS.has(dir)) {
      console.log(`[seed] 跳过 ${dir}: SKIP_DIRS`);
      continue;
    }
    const pkgFile = resolve(packagesDir, dir, 'package.json');
    if (!existsSync(pkgFile)) {
      console.log(`[seed] 跳过 ${dir}: package.json 不存在`);
      continue;
    }
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>;
    const aalis = (pkg.aalis as Record<string, unknown> | undefined) ?? {};
    if (aalis.core) {
      console.log(`[seed] 跳过 ${dir}: aalis.core (核心包)`);
      continue;
    }
    if (aalis.client) {
      console.log(`[seed] 跳过 ${dir}: aalis.client (前端包)`);
      continue;
    }
    const keywords = (pkg.keywords as string[] | undefined) ?? [];
    if (!keywords.includes('aalis-plugin')) {
      console.log(`[seed] 跳过 ${dir}: keywords 不含 'aalis-plugin'（非插件包）`);
      continue;
    }
    const name = pkg.name as string | undefined;
    if (!name) {
      console.log(`[seed] 跳过 ${dir}: package.json 缺少 name`);
      continue;
    }
    plugins.push({
      dir,
      pkgName: name,
      displayName: (aalis.displayName as string | undefined) ?? humanizeName(dir),
      description: (pkg.description as string | undefined) ?? `Aalis 插件 ${name}（自动生成描述，建议在 package.json 中补充）。`,
      permissions: (aalis.permissions as PluginPermission[] | undefined) ?? [],
      provides: aalis.provides as string[] | undefined,
      inject: aalis.inject as string[] | undefined,
      capabilities: aalis.capabilities as string[] | undefined,
      keywords: (pkg.keywords as string[] | undefined) ?? deriveKeywords(dir),
      audit: (aalis.audit as 'approved' | 'pending' | 'blocked' | undefined) ?? 'approved',
    });
  }
  plugins.sort((a, b) => a.dir.localeCompare(b.dir));
  return plugins;
}

function humanizeName(dir: string): string {
  return dir
    .replace(/^plugin-/, '')
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function deriveKeywords(dir: string): string[] {
  return Array.from(new Set(['aalis', ...dir.replace(/^plugin-/, '').split('-').filter(Boolean)]));
}

function buildPackageMap(): Map<string, string> {
  const map = new Map<string, string>();
  const packagesDir = resolve(REPO_ROOT, 'packages');
  for (const dir of readdirSync(packagesDir)) {
    const pkgFile = resolve(packagesDir, dir, 'package.json');
    if (!existsSync(pkgFile)) continue;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: string };
    if (pkg.name) map.set(pkg.name, resolve(packagesDir, dir));
  }
  return map;
}
function rewriteWorkspaceDeps(
  deps: Record<string, string> | undefined,
  packageMap: Map<string, string>,
): Record<string, string> | undefined {
  if (!deps) return deps;
  const next: Record<string, string> = {};
  for (const [name, spec] of Object.entries(deps)) {
    if (spec.startsWith('workspace:')) {
      const localPath = packageMap.get(name);
      next[name] = localPath ? `file:${localPath}` : spec;
    } else {
      next[name] = spec;
    }
  }
  return next;
}
