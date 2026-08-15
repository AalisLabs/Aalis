import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// manifest 双源对账：package.json 的 aalis.service 与代码里的具名导出
// provides / inject 必须一致——前者喂市场展示与依赖预检，后者是运行时
// 真相。手工双源无对账即会漂移（漂移=元数据说谎，下游按谎言行动），
// 违例此前完全静默。方案出自 docs/concepts/manifest-metadata.md：
// import 编译期 namespace 归一比对，禁用正则。
// ════════════════════════════════════════════════════════════

const PACKAGES = join(__dirname, '../../packages');

/** 归一：字符串或 { service } 形态统一为排序后的服务名数组。 */
function norm(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return (list as Array<string | { service: string }>).map(d => (typeof d === 'string' ? d : d.service)).sort();
}

describe('manifest 双源对账', () => {
  it('全部 aalis-plugin 包的 aalis.service 与代码 provides/inject 一致', async () => {
    const drifts: string[] = [];
    let audited = 0;
    for (const pkg of readdirSync(PACKAGES)) {
      const pkgJsonPath = join(PACKAGES, pkg, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      const meta = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
        keywords?: string[];
        aalis?: { service?: { provides?: string[]; required?: string[]; optional?: string[] } };
      };
      if (!meta.keywords?.includes('aalis-plugin')) continue;
      const entry = join(PACKAGES, pkg, 'src/index.ts');
      if (!existsSync(entry)) continue;
      audited++;
      let ns: { provides?: unknown; inject?: { required?: unknown; optional?: unknown } };
      try {
        ns = (await import(entry)) as never;
      } catch (err) {
        drifts.push(`${pkg}: 源码导入失败，对账无法进行：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const svc = meta.aalis?.service ?? {};
      const pairs: Array<[string, string[], string[]]> = [
        ['provides', norm(svc.provides), norm(ns.provides)],
        ['required', norm(svc.required), norm(ns.inject?.required)],
        ['optional', norm(svc.optional), norm(ns.inject?.optional)],
      ];
      for (const [field, manifest, code] of pairs) {
        if (JSON.stringify(manifest) !== JSON.stringify(code)) {
          drifts.push(`${pkg}.${field}: package.json=[${manifest.join(',')}] 代码=[${code.join(',')}]`);
        }
      }
    }
    expect(audited).toBeGreaterThan(30); // 防自僵：扫描面塌了要出声
    expect(
      drifts,
      `双源漂移：aalis.service（市场/预检读它）与代码 provides/inject（运行时真相）必须一致。\n` +
        `修法=以代码为准更新 package.json（或反之，若代码漏声明）：\n${drifts.join('\n')}`,
    ).toEqual([]);
  }, 120_000);
});
