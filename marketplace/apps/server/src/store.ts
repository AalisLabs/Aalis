/**
 * 文件存储后端：把 store 目录视为唯一可信源。
 *
 * 目录结构：
 *   store/
 *   ├── publishers.json       # 发布者公钥白名单
 *   ├── plugins/
 *   │   └── <name-encoded>/
 *   │       └── <version-encoded>/
 *   │           ├── manifest.json
 *   │           └── *.tgz
 */
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';

import type {
  PluginIndexEntry,
  PluginManifest,
  PublisherInfo,
} from '@aalis-marketplace/protocol';

const PUBLISHERS_FILE = 'publishers.json';

export class StoreFs {
  constructor(public readonly root: string) {}

  // ---- publishers ----------------------------------------------------------

  async listPublishers(): Promise<PublisherInfo[]> {
    const file = resolve(this.root, PUBLISHERS_FILE);
    if (!existsSync(file)) return [];
    return JSON.parse(await readFile(file, 'utf8')) as PublisherInfo[];
  }

  async upsertPublisher(p: PublisherInfo): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const list = await this.listPublishers();
    const idx = list.findIndex(x => x.id === p.id);
    if (idx >= 0) list[idx] = p;
    else list.push(p);
    await writeFile(
      resolve(this.root, PUBLISHERS_FILE),
      JSON.stringify(list, null, 2) + '\n',
      'utf8',
    );
  }

  // ---- plugins -------------------------------------------------------------

  pluginDir(name: string, version?: string): string {
    const base = resolve(this.root, 'plugins', encodeURIComponent(name));
    return version ? join(base, encodeURIComponent(version)) : base;
  }

  async readManifest(name: string, version: string): Promise<PluginManifest | null> {
    const file = resolve(this.pluginDir(name, version), 'manifest.json');
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, 'utf8')) as PluginManifest;
  }

  async writeManifest(manifest: PluginManifest): Promise<void> {
    const dir = this.pluginDir(manifest.name, manifest.version);
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8',
    );
  }

  async writeTarball(
    name: string,
    version: string,
    tarball: Buffer,
  ): Promise<string> {
    const dir = this.pluginDir(name, version);
    await mkdir(dir, { recursive: true });
    // 标准化文件名：name@version.tgz（name 中的 / 被替换为 -）
    const fn = `${name.replace(/[\/@]/g, '-')}-${version}.tgz`;
    const tmp = resolve(dir, `.${fn}.tmp`);
    await writeFile(tmp, tarball);
    const final = resolve(dir, fn);
    await rename(tmp, final);
    return final;
  }

  async readTarball(name: string, version: string): Promise<Buffer | null> {
    const dir = this.pluginDir(name, version);
    if (!existsSync(dir)) return null;
    const entries = await readdir(dir);
    const tgz = entries.find(e => e.endsWith('.tgz'));
    if (!tgz) return null;
    return readFile(resolve(dir, tgz));
  }

  /** 列出某插件所有版本（按存在的 manifest.json 推断）。 */
  async listVersions(name: string): Promise<string[]> {
    const dir = this.pluginDir(name);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const versions: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const decoded = decodeURIComponent(e.name);
      versions.push(decoded);
    }
    versions.sort(compareVersionsDesc);
    return versions;
  }

  /** 列出所有插件名。 */
  async listPlugins(): Promise<string[]> {
    const dir = resolve(this.root, 'plugins');
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => decodeURIComponent(e.name));
  }

  /** 构建索引：每个插件取最新版的 manifest 摘要。 */
  async buildIndex(): Promise<PluginIndexEntry[]> {
    const names = await this.listPlugins();
    const items: PluginIndexEntry[] = [];
    for (const name of names) {
      const versions = await this.listVersions(name);
      if (!versions.length) continue;
      const latest = versions[0];
      const m = await this.readManifest(name, latest);
      if (!m) continue;
      items.push({
        name: m.name,
        latest: m.version,
        versions,
        displayName: m.displayName,
        description: m.description,
        author: m.author,
        homepage: m.homepage,
        repository: m.repository,
        keywords: m.keywords,
        audit: m.audit,
        permissions: m.permissions,
        provides: m.provides,
        inject: m.inject,
        bundled: m.bundled,
        publishedAt: m.publishedAt,
      });
    }
    return items;
  }
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map(s => Number(s) || 0);
  const pb = b.split(/[.\-+]/).map(s => Number(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return db - da;
  }
  return b.localeCompare(a);
}
