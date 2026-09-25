import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../../packages');
const CORE_PEER = '>=0.18.0 <1.0.0';
/** 本批随 core 0.18 发布、带 core peer 的包：28 api + 59 插件 + runtime + schema-config + schema-log。 */
const CORE_PEER_COUNT = 90;

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function dirs(): string[] {
  return readdirSync(PACKAGES).filter(dir => existsSync(join(PACKAGES, dir, 'package.json')));
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as Manifest;
}

function readIndex(dir: string): string | undefined {
  const fp = join(PACKAGES, dir, 'src', 'index.ts');
  return existsSync(fp) ? readFileSync(fp, 'utf8') : undefined;
}

function parseFloor(spec: string): [number, number, number] | undefined {
  const m = spec.match(/(?:workspace:)?>=(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function gte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

describe('CHANGELOG 未发布节的发布声明', () => {
  it('本批发布的 90 个带 @aalis/core peer 的包区间都是 >=0.18.0 <1.0.0', () => {
    const hits: Array<{ dir: string; spec: string }> = [];
    for (const dir of dirs()) {
      const spec = readManifest(dir).peerDependencies?.['@aalis/core'];
      if (spec === undefined) continue;
      hits.push({ dir, spec });
    }
    expect(
      hits
        .filter(h => h.spec === CORE_PEER)
        .map(h => h.dir)
        .sort(),
      'raised core peer 包数应对齐 90（28 api + 59 插件 + runtime + schema-config + schema-log）',
    ).toHaveLength(CORE_PEER_COUNT);
    const outliers = hits.filter(h => h.spec !== CORE_PEER).map(h => `${h.dir} = ${h.spec}`);
    // schema-message 的 core peer 只为类型声明，不抬；五个包本批没有改动、不重发，保持已发布的 >=0.17.0
    expect(outliers.sort(), '仅 schema-message（type-only）与本批未改动的五个包不在新区间').toEqual([
      'api-code-sandbox = >=0.17.0 <1.0.0',
      'plugin-code-sandbox-os = >=0.17.0 <1.0.0',
      'plugin-maimai = >=0.17.0 <1.0.0',
      'plugin-process-local = >=0.17.0 <1.0.0',
      'plugin-tool-code-runner = >=0.17.0 <1.0.0',
      'schema-message = >=0.2.0 <1.0.0',
    ]);
  });

  it('契约包 src/index.ts 不再导出 useXxxService helper', () => {
    const bad: string[] = [];
    for (const dir of dirs().filter(d => d.startsWith('api-'))) {
      const src = readIndex(dir);
      if (src === undefined) continue;
      if (
        /export\s+(?:async\s+)?function\s+use\w+Service\b/.test(src) ||
        /export\s+const\s+use\w+Service\b/.test(src)
      ) {
        bad.push(dir);
      }
    }
    expect(bad).toEqual([]);
  });

  it('第一方插件 src/index.ts 是 default definePlugin，没有具名 inject / provides / apply', () => {
    const bad: string[] = [];
    for (const dir of dirs().filter(d => d.startsWith('plugin-'))) {
      const src = readIndex(dir);
      if (src === undefined) continue;
      if (/^export const inject\b/m.test(src)) bad.push(`${dir}: export const inject`);
      if (/^export const provides\b/m.test(src)) bad.push(`${dir}: export const provides`);
      if (/^export (?:async )?function apply\b/m.test(src)) bad.push(`${dir}: export function apply`);
      if (!/\bexport\s+default\s+definePlugin\b/.test(src)) bad.push(`${dir}: 缺 export default definePlugin`);
    }
    expect(bad).toEqual([]);
  });

  it('plugin-todo-list 把 api-memory / api-webui 放在 dependencies', () => {
    const deps = readManifest('plugin-todo-list').dependencies ?? {};
    expect(deps['@aalis/api-memory']).toBeTruthy();
    expect(deps['@aalis/api-webui']).toBeTruthy();
  });

  it('dependencies 里的 @aalis/schema-config 下限 >=0.12.0', () => {
    const floor: [number, number, number] = [0, 12, 0];
    const bad: string[] = [];
    let n = 0;
    for (const dir of dirs()) {
      const spec = readManifest(dir).dependencies?.['@aalis/schema-config'];
      if (spec === undefined) continue;
      n += 1;
      const parsed = parseFloor(spec);
      if (!parsed || !gte(parsed, floor)) bad.push(`${dir} = ${spec}`);
    }
    expect(n, '应扫到 schema-config 消费方').toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it('@aalis/schema-config 导出 removeExtraFields', () => {
    const src = readIndex('schema-config');
    expect(src, 'packages/schema-config/src/index.ts 须存在').toBeTruthy();
    expect(/export function removeExtraFields/.test(src ?? ''), src).toBe(true);
  });
});
