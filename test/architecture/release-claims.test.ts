import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../../packages');
const CORE_PEER_022 = '>=0.22.0 <1.0.0';
/**
 * 2026-11-13 一节：用到事件契约、就绪回调、watch、登记位次或 host-restart 的包与 core 0.21 不能混装，下限抬到 0.22：
 * 57 个原有的，加 api-events、plugin-events、api-host-restart 三个新包
 */
const CORE_PEER_022_COUNT = 60;
const CORE_PEER_021 = '>=0.21.0 <1.0.0';
/**
 * 2026-10-31 一节发布的包里带 core peer 的 107 个一律抬到 0.21（新版插件的显示名与页面标题是文字对象，core 0.21 起才收）；
 * 其中六个之后移出主仓、改做仓外的扩展插件，56 个在 2026-11-13 一节抬到 0.22，仓里剩 45 个
 */
const CORE_PEER_021_COUNT = 45;
/** 留在更早下限的：用不到之后各版 core 的新东西 */
const EARLIER = [
  'api-asr = >=0.20.0 <1.0.0',
  'api-code-sandbox = >=0.20.0 <1.0.0',
  'api-contributions = >=0.20.0 <1.0.0',
  'api-flow-control = >=0.20.0 <1.0.0',
  'api-host-logs = >=0.20.0 <1.0.0',
  'api-host-paths = >=0.20.0 <1.0.0',
  'api-plugin-source = >=0.20.0 <1.0.0',
  'api-user-relation = >=0.20.0 <1.0.0',
  'api-vectorstore = >=0.20.0 <1.0.0',
  'schema-log = >=0.18.0 <1.0.0',
];

interface Manifest {
  name?: string;
  private?: boolean;
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

describe('发布声明（2026-11-13 一节）', () => {
  it('带 @aalis/core peer 的包：60 个为 >=0.22.0 <1.0.0，45 个为 >=0.21.0 <1.0.0，其余 10 个留在更早的下限', () => {
    const hits: Array<{ dir: string; spec: string }> = [];
    for (const dir of dirs()) {
      const manifest = readManifest(dir);
      if (manifest.private) continue; // private 包不发布
      const spec = manifest.peerDependencies?.['@aalis/core'];
      if (spec === undefined) continue;
      hits.push({ dir, spec });
    }
    expect(hits.filter(h => h.spec === CORE_PEER_022)).toHaveLength(CORE_PEER_022_COUNT);
    expect(hits.filter(h => h.spec === CORE_PEER_021)).toHaveLength(CORE_PEER_021_COUNT);
    expect(
      hits.filter(h => h.spec !== CORE_PEER_022 && h.spec !== CORE_PEER_021).map(h => `${h.dir} = ${h.spec}`),
    ).toEqual(EARLIER);
  });

  it.each([
    // 提供者实现的登记签名带位次参数，契约从这一版起才有
    ['plugin-hooks', '@aalis/api-hooks', [0, 4, 0] as [number, number, number]],
    // 管理事件 server.closing 的类型从这一版起才有
    ['plugin-webui-server', '@aalis/api-webui', [0, 15, 0] as [number, number, number]],
  ])('%s 对 %s 的依赖下限跟上本批改形的契约', (dir, name, floor) => {
    const parsed = parseFloor(readManifest(dir).dependencies?.[name] ?? '');
    expect(parsed && gte(parsed, floor), `${dir} 的 ${name}`).toBe(true);
  });
});

describe('发布声明（2026-10-11 一节）', () => {
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

  it('plugin-todo-list 把 api-memory 放在 dependencies', () => {
    expect(readManifest('plugin-todo-list').dependencies?.['@aalis/api-memory']).toBeTruthy();
  });

  it.each([
    ['@aalis/schema-config', [0, 14, 0] as [number, number, number]],
    ['@aalis/api-llm', [0, 13, 0] as [number, number, number]],
  ])('dependencies 里的 %s 满足配置类型契约最低版本', (name, floor) => {
    const bad: string[] = [];
    let n = 0;
    for (const dir of dirs()) {
      const spec = readManifest(dir).dependencies?.[name];
      if (spec === undefined) continue;
      n += 1;
      const parsed = parseFloor(spec);
      if (!parsed || !gte(parsed, floor)) bad.push(`${dir} = ${spec}`);
    }
    expect(n, `应扫到 ${name} 消费方`).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it('@aalis/schema-config 导出 removeExtraFields', () => {
    const src = readIndex('schema-config');
    expect(src, 'packages/schema-config/src/index.ts 须存在').toBeTruthy();
    expect(/export function removeExtraFields/.test(src ?? ''), src).toBe(true);
  });
});
