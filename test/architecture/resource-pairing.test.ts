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
//
// 2026-09 扩两条「外部调用配对」：fetch 须带 abort、子进程须带 timeout。两条都对着
// 真实事故证明过非装饰（embedding-openai / asr-openai / maimai 的 fetch 无超时钉住整轮；
// whisper 子进程无 timeout 则 spawn 不武装 killTree、永不 settle）。
// 白名单按「规则 + 文件」而非仅文件：白掉一个文件的 fetch 不该让它对 setInterval 也盲。
// ════════════════════════════════════════════════════════════

const PACKAGES = join(__dirname, '../../packages');

/** 误报白名单：`规则id 包名/相对路径` → 理由。新增必须写理由。 */
const WHITELIST = new Map<string, string>([
  // fetch：浏览器端代码与库层透传
  ['fetch plugin-webui-server/auth.ts', '登录页模板串内的浏览器端 JS'],
  ['fetch plugin-webui-server/client-switch-page.ts', '页面模板串内的浏览器端 JS'],
  ['fetch plugin-webui-client/App.tsx', '浏览器 SPA'],
  ['fetch plugin-webui-client/api.ts', '浏览器 SPA'],
  ['fetch plugin-webui-client/components/SchemaForm.tsx', '浏览器 SPA'],
  ['fetch plugin-webui-client/components/UploadedFilesDrawer.tsx', '浏览器 SPA'],
  ['fetch util-network-guard/index.ts', 'safeFetch 是库层，透传调用方 init（含 signal），超时由调用方给'],
  ['fetch plugin-tool-code-runner/index.ts', '`fetch(` 出现在工具描述字符串里，不是调用'],
  // spawn：契约、实现方、以及寿命由外部决定的进程
  ['spawn api-process/index.ts', '契约声明，无实现'],
  ['spawn plugin-process-local/index.ts', 'ProcessService 实现方，timeout 的武装逻辑在此'],
  ['spawn runtime/providers.ts', '进程自重生与回滚安装：寿命由用户/外部决定，不设超时'],
  ['spawn plugin-webui-server/auth.ts', 'detached 拉起浏览器，fire-and-forget 不等其结束'],
]);

interface Rule {
  id: string;
  name: string;
  /** 命中即视为"获取了资源" */
  acquire: RegExp;
  /** 同文件出现任一即视为"有配对释放" */
  release: RegExp;
}

const RULES: Rule[] = [
  {
    id: 'interval',
    name: 'setInterval 需配对 clearInterval 或 onDispose',
    acquire: /\bsetInterval\s*\(/,
    release: /\bclearInterval\b|\bonDispose\b/,
  },
  {
    // 本仓惯例是 `import { watch as fsWatch }` 别名调用——正则必须双收，
    // 否则规则对真实 watcher 全盲（曾实测 0 命中的假绿灯）。
    id: 'watch',
    name: 'fs.watch/watchFile/fsWatch 需配对 close/unwatchFile 或 onDispose',
    acquire: /\bfs\.watch(File)?\s*\(|\bwatchFile\s*\(|\bfsWatch\s*\(/,
    release: /\.close\(\)|\bunwatchFile\b|\bonDispose\b/,
  },
  {
    // 调用方与工具执行面都没有外层超时：一个不带 signal 的 fetch 就能把整轮对话永久挂住。
    id: 'fetch',
    name: 'fetch 需配对 AbortSignal/AbortController/signal:',
    acquire: /\bfetch\s*\(/,
    release: /\bAbortSignal\b|\bAbortController\b|\bsignal\s*:/,
  },
  {
    // LocalProcessService.spawn 只在 opts.timeout > 0 时才武装 killTree；不传则子进程不退 wait() 永不 settle。
    id: 'spawn',
    name: 'execFile/spawn 需配对 timeout:',
    acquire: /\b(execFile|spawn)\s*\(/,
    release: /\btimeout\s*:/,
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
        const content = readFileSync(file, 'utf-8');
        for (const rule of RULES) {
          if (WHITELIST.has(`${rule.id} ${rel}`)) continue;
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
    const stale = [...WHITELIST.keys()].filter(key => {
      const rel = key.slice(key.indexOf(' ') + 1);
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

  it('白名单的规则 id 都真实存在（防拼错 id 让白名单失效）', () => {
    const ids = new Set(RULES.map(r => r.id));
    const bad = [...WHITELIST.keys()].filter(key => !ids.has(key.slice(0, key.indexOf(' '))));
    expect(bad).toEqual([]);
  });
});
