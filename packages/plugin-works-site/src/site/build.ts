import { PUBLIC_CONTENT_TYPES, type PublishedItem, publicPathProblem, WORK_ID_PATTERN } from '@aalis/api-publish';
import type { DeployFile } from '../cloudflare/client.js';
import { branchHeaderFile, galleryHeaderFile } from './headers.js';
import { encode, indexPage, notFoundPage, removedPage, SITE_CSS, wrapperPage } from './templates.js';
import { buildWorker } from './worker.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20_000;
const NONCE = /^[A-Za-z0-9_-]{1,128}$/;
const MAIN_TOMBSTONE =
  /^\/(?:w\/[a-z2-7]{10}\/index\.html|m\/[a-z2-7]{10}\.(?:png|jpe?g|gif|webp|mp4)|t\/[a-z2-7]{10}\.png)$/;
const PLACEHOLDER = encode('removed\n');

export interface Tombstone {
  /** `main` or opaque group key, matching the target build. */
  branch: string;
  path: string;
  until: number;
}

interface BuildBase {
  /** The exact selected snapshot: withdrawal callers pass current works minus withdrawn IDs. */
  items: readonly PublishedItem[];
  tombstones: readonly Tombstone[];
  nonce: string;
  now: number;
  readFile(id: string, path: string): Promise<Uint8Array>;
  readThumbnail(id: string): Promise<Uint8Array>;
}

interface GalleryBuildInput extends BuildBase {
  siteTitle: string;
  siteIntro: string;
  /** Group to validated work-site origin. */
  aliases: Readonly<Record<string, string>>;
}

interface BranchBuildInput extends BuildBase {
  group: string;
  mainOrigin: string;
  frameAncestors: readonly string[];
}

export interface SiteBuild {
  files: DeployFile[];
  headers: string;
  worker?: string;
}

function validate(input: BuildBase): void {
  if (!NONCE.test(input.nonce) || !Number.isFinite(input.now)) throw new TypeError('站点构建参数不合法');
  const ids = new Set<string>();
  for (const item of input.items) {
    if (!WORK_ID_PATTERN.test(item.id) || ids.has(item.id)) throw new TypeError('作品编号不合法或重复');
    ids.add(item.id);
    if (
      !Number.isFinite(item.publishedAt) ||
      !item.group ||
      item.files.length < 1 ||
      (item.kind !== 'html' && item.kind !== 'media')
    )
      throw new TypeError('作品清单不完整');
    const paths = new Set<string>();
    for (const file of item.files) {
      const ext = file.path.slice(file.path.lastIndexOf('.') + 1).toLowerCase();
      if (
        publicPathProblem(file.path) ||
        paths.has(file.path.toLowerCase()) ||
        PUBLIC_CONTENT_TYPES[ext] !== file.contentType ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_FILE_BYTES
      )
        throw new TypeError('作品文件不合公开规则');
      paths.add(file.path.toLowerCase());
    }
    if (item.kind === 'html' && !paths.has('index.html')) throw new TypeError('网页作品缺少入口');
    if (
      item.kind === 'media' &&
      (item.files.length !== 1 || !/\.(?:png|jpe?g|gif|webp|mp4)$/i.test(item.files[0].path))
    ) {
      throw new TypeError('媒体作品文件不合法');
    }
  }
  for (const tombstone of input.tombstones) {
    const branchMatch = /^\/([a-z2-7]{10})\/(.+)$/.exec(tombstone.path);
    const validPath =
      tombstone.branch === 'main'
        ? MAIN_TOMBSTONE.test(tombstone.path)
        : !!branchMatch && !publicPathProblem(branchMatch[2]);
    if (!tombstone.branch || !validPath || !Number.isFinite(tombstone.until))
      throw new TypeError('墓碑路径或期限不合法');
  }
}

function add(files: DeployFile[], path: string, bytes: Uint8Array, contentType: string): void {
  if (bytes.byteLength > MAX_FILE_BYTES || files.some(file => file.path === path) || files.length >= MAX_FILES) {
    throw new TypeError('站点文件过大、重复或过多');
  }
  files.push({ path, bytes, contentType });
}

function validatePlannedPaths(paths: readonly string[]): void {
  if (paths.length > MAX_FILES || new Set(paths).size !== paths.length) {
    throw new TypeError('站点文件重复或过多');
  }
}

function addTombstones(files: DeployFile[], tombstones: readonly Tombstone[], branch: string, now: number): void {
  for (const tombstone of tombstones) {
    if (tombstone.branch !== branch || tombstone.until <= now) continue;
    add(
      files,
      tombstone.path,
      tombstone.path.endsWith('/index.html') ? encode(removedPage()) : PLACEHOLDER,
      tombstone.path.endsWith('/index.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    );
  }
}

export async function buildGallery(input: GalleryBuildInput): Promise<SiteBuild> {
  validate(input);
  for (const origin of Object.values(input.aliases)) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
        throw new TypeError('作品站来源不合法');
      }
    } catch {
      throw new TypeError('作品站来源不合法');
    }
  }
  const htmlItems = input.items.filter(item => item.kind === 'html');
  for (const item of htmlItems) if (!input.aliases[item.group]) throw new TypeError('网页作品缺少别名');
  const frameOrigins = [...new Set(htmlItems.map(item => input.aliases[item.group]))];
  const headers = galleryHeaderFile(frameOrigins); // validate CSP before any asset read
  validatePlannedPaths([
    '/index.html',
    '/404.html',
    '/assets/site.css',
    `/v/${input.nonce}.txt`,
    ...input.items.flatMap(item => [
      `/w/${item.id}/index.html`,
      ...(item.kind === 'media' ? [`/m/${item.id}.${item.files[0].path.split('.').at(-1)?.toLowerCase()}`] : []),
      ...(item.hasThumbnail ? [`/t/${item.id}.png`] : []),
    ]),
    ...input.tombstones.filter(t => t.branch === 'main' && t.until > input.now).map(t => t.path),
  ]);
  const files: DeployFile[] = [];
  add(
    files,
    '/index.html',
    encode(indexPage(input.siteTitle, input.siteIntro, input.items)),
    'text/html; charset=utf-8',
  );
  add(files, '/404.html', encode(notFoundPage()), 'text/html; charset=utf-8');
  add(files, '/assets/site.css', encode(SITE_CSS), 'text/css; charset=utf-8');
  add(files, `/v/${input.nonce}.txt`, encode(input.nonce), 'text/plain; charset=utf-8');
  for (const item of input.items) {
    add(
      files,
      `/w/${item.id}/index.html`,
      encode(wrapperPage(item, input.aliases[item.group])),
      'text/html; charset=utf-8',
    );
    if (item.kind === 'media') {
      const file = item.files[0];
      const ext = file.path.slice(file.path.lastIndexOf('.') + 1).toLowerCase();
      const bytes = await input.readFile(item.id, file.path);
      if (bytes.byteLength !== file.size) throw new TypeError('媒体文件大小与清单不符');
      add(files, `/m/${item.id}.${ext}`, bytes, file.contentType);
    }
    if (item.hasThumbnail) add(files, `/t/${item.id}.png`, await input.readThumbnail(item.id), 'image/png');
  }
  addTombstones(files, input.tombstones, 'main', input.now);
  return { files, headers };
}

export async function buildBranch(input: BranchBuildInput): Promise<SiteBuild | undefined> {
  validate(input);
  const items = input.items.filter(item => item.group === input.group && item.kind === 'html');
  const tombstones = input.tombstones.filter(t => t.branch === input.group && t.until > input.now);
  if (items.length === 0 && tombstones.length === 0) return undefined;
  const headers = branchHeaderFile(input.frameAncestors);
  const works: Record<string, string[]> = Object.create(null);
  for (const item of items)
    works[item.id] = item.files.map(file => (file.path === 'index.html' ? `/${item.id}/` : `/${item.id}/${file.path}`));
  const worker = buildWorker({
    nonce: input.nonce,
    mainOrigin: input.mainOrigin,
    frameAncestors: input.frameAncestors,
    works,
  });
  validatePlannedPaths([
    `/v/${input.nonce}.txt`,
    ...items.flatMap(item => item.files.map(file => `/${item.id}/${file.path}`)),
    ...tombstones.map(t => t.path),
  ]);
  const files: DeployFile[] = [];
  add(files, `/v/${input.nonce}.txt`, encode(input.nonce), 'text/plain; charset=utf-8');
  for (const item of items)
    for (const file of item.files) {
      const bytes = await input.readFile(item.id, file.path);
      if (bytes.byteLength !== file.size) throw new TypeError('作品文件大小与清单不符');
      add(files, `/${item.id}/${file.path}`, bytes, file.contentType);
    }
  addTombstones(files, input.tombstones, input.group, input.now);
  return { files, headers, worker };
}
