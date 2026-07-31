import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../../packages');

// ════════════════════════════════════════════════════════════
// 包间依赖版本范围的形态约束
//
// 守的是一条**可证明的不变量**：包间 dependencies 一律写
// `workspace:>=<下界> <1.0.0`。上界统一为 <1.0.0 后，任意有限个这样的区间必然
// 相交于 [max(下界), 1.0.0)，于是 npm/pnpm **必然**解出唯一版本——同一个契约包
// 在用户机器上只会有一份。
//
// 这不是洁癖，是两类真实事故的唯一防线：
//
// 1. **caret 跨 minor 即断**（f5525ba6 实测）：`workspace:^` 发布成 `^0.x.y`，而
//    caret 在 0.x 下语义是 `>=0.x.y <0.(x+1).0`。实测后果是 agent-api 拖来
//    llm-api 0.5.0（npm 上已是 0.9.0），且与另一路装来的新版**同时存在两份**，
//    两份 declare module 撞成 TS2717 又被 skipLibCheck 静默吞掉。
// 2. **helper 与服务版本错配**：契约包的运行时 helper（如 useToolService）与服务
//    实现必须同版本。若解出两份，旧 helper 调新服务时多余实参被 JS **静默丢弃**
//    ——不抛错、不告警。实测后果：register 的 pluginName 变 undefined →
//    unregisterByPlugin 永不匹配 → 插件卸载后幽灵工具残留在注册表里，LLM 仍能
//    调到已卸载插件的工具。
//
// 单条违例就把「必然唯一」退化成「碰巧唯一」，故此处零容忍。
// devDependencies 不受约束——它不发布给消费者，`workspace:*` 无害。
// ════════════════════════════════════════════════════════════

/** `workspace:>=0.5.1 <1.0.0` —— 下界精确三段版本号，上界统一 <1.0.0。 */
const RANGE_RE = /^workspace:>=\d+\.\d+\.\d+ <1\.0\.0$/;

interface Edge {
  from: string;
  to: string;
  spec: string;
}

function interPackageDeps(): Edge[] {
  const edges: Edge[] = [];
  for (const dir of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf-8')) as { dependencies?: Record<string, string> };
    for (const [to, spec] of Object.entries(pkg.dependencies ?? {})) {
      if (to.startsWith('@aalis/')) edges.push({ from: dir, to, spec });
    }
  }
  return edges;
}

describe('包间依赖版本范围（单一版本不变量）', () => {
  const edges = interPackageDeps();

  it('存在足够多的包间依赖边——判据本身没有因为扫描口径变化而失效', () => {
    // 空数组会让下面的断言全部空转通过，先钉住量级
    expect(edges.length).toBeGreaterThan(100);
  });

  it('每条包间 dependencies 都是 `workspace:>=x.y.z <1.0.0`', () => {
    const bad = edges.filter(e => !RANGE_RE.test(e.spec)).map(e => `${e.from} → ${e.to} = ${e.spec}`);
    expect(
      bad,
      '包间 dependencies 必须写 `workspace:>=<当前版本> <1.0.0`。\n' +
        '禁 `workspace:^`：发布成 ^0.x.y，caret 在 0.x 下跨 minor 即断，会装到滞后版本甚至同时装进两份。\n' +
        '禁 `workspace:*`：发布成精确版本，同样锁死。\n' +
        '两者都会打破「同一契约包只有一份」这条不变量——后果见本文件顶部注释。',
    ).toEqual([]);
  });

  it('peerDependencies 的上界同样统一（core 被所有插件 peer 依赖，是最关键的一条）', () => {
    const bad: string[] = [];
    for (const dir of readdirSync(PACKAGES)) {
      const manifest = join(PACKAGES, dir, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf-8')) as { peerDependencies?: Record<string, string> };
      for (const [to, spec] of Object.entries(pkg.peerDependencies ?? {})) {
        if (!to.startsWith('@aalis/')) continue;
        // peer 不带 workspace: 前缀（它要发布给消费者解析），但上界规则相同
        if (!/^>=\d+\.\d+\.\d+ <1\.0\.0$/.test(spec)) bad.push(`${dir} → ${to} = ${spec}`);
      }
    }
    expect(bad, 'peerDependencies 必须写 `>=x.y.z <1.0.0`（禁 caret，理由同上）').toEqual([]);
  });
});
