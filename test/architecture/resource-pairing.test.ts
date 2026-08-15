import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 资源配对绊线：把「拿到资源立刻登记清理」的纪律从文档变成机器检查。
//
// 背景：门面注册（on/provide/…）的清理是自动的；作者自管资源（定时器、
// watcher）的释放登记靠纪律——这是唯一无法被注册表看见的泄漏类别
// （账本只能点名"注册过的"，从未登记的资源任何枚举都列不出）。
// 本绊线是文件级启发式：出现获取词而无配对词即红。误报进白名单并写明理由。
//
// 词汇表刻意窄（宁漏勿噪）：只收"泄漏之王"级的模式。扩词前先确认
// 配对词能唯一辨识，别把 `.close()` 这类到处都是的词当证据。
// ════════════════════════════════════════════════════════════

const PACKAGES = join(__dirname, '../../packages');

/** 误报白名单：`包名/相对路径` → 理由。新增必须写理由。 */
const WHITELIST = new Map<string, string>([]);

interface Rule {
  name: string;
  /** 命中即视为"获取了资源" */
  acquire: RegExp;
  /** 同文件出现任一即视为"有配对释放" */
  release: RegExp;
}

const RULES: Rule[] = [
  {
    name: 'setInterval 需配对 clearInterval 或 onDispose',
    acquire: /\bsetInterval\s*\(/,
    release: /\bclearInterval\b|\bonDispose\b/,
  },
  {
    // 本仓惯例是 `import { watch as fsWatch }` 别名调用——正则必须双收，
    // 否则规则对真实 watcher 全盲（曾实测 0 命中的假绿灯）。
    name: 'fs.watch/watchFile/fsWatch 需配对 close/unwatchFile 或 onDispose',
    acquire: /\bfs\.watch(File)?\s*\(|\bwatchFile\s*\(|\bfsWatch\s*\(/,
    release: /\.close\(\)|\bunwatchFile\b|\bonDispose\b/,
  },
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

describe('自管资源配对绊线（作者纪律的机器化）', () => {
  it('packages/*/src 下的资源获取都有同文件配对释放（或在白名单说明理由）', () => {
    const violations: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      const src = join(PACKAGES, pkg, 'src');
      let entries: string[];
      try {
        entries = [...walk(src)];
      } catch {
        continue; // 无 src 目录的包
      }
      for (const file of entries) {
        const rel = `${pkg}/${file.slice(src.length + 1)}`;
        if (WHITELIST.has(rel)) continue;
        const content = readFileSync(file, 'utf-8');
        for (const rule of RULES) {
          if (rule.acquire.test(content) && !rule.release.test(content)) {
            violations.push(`${rel} —— ${rule.name}`);
          }
        }
      }
    }
    expect(
      violations,
      `发现未配对的自管资源（拿到资源必须同文件登记释放，见 docs/guide/third-party-plugin.md 生命周期节；` +
        `确属误报则加入本文件 WHITELIST 并写理由）:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('白名单条目都还有对应文件（防僵尸白名单）', () => {
    const stale = [...WHITELIST.keys()].filter(rel => {
      const [pkg, ...rest] = rel.split('/');
      try {
        readFileSync(join(PACKAGES, pkg, 'src', ...rest));
        return false;
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });
});
