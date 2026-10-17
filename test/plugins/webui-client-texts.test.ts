import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_TEXTS_FILE } from '../../packages/api-webui/src/index.js';
import { t } from '../../packages/plugin-webui-client/src/texts.js';

// ════════════════════════════════════════════════════════════
// 默认前端构建时把随它打包的字典（外壳的与库的）写进 dist 下的 CLIENT_TEXTS_FILE，webui-server 挂载时登记进服务进程的目录。
// 核的是构建产物（先跑 pnpm -r build）：文件里的字典恰好是外壳的加上打进包里的库的（库的按产物里 defineTexts 交的 ns
// 字面量认；外壳的 ns 取自 package.json，产物里是变量），外壳的原文与译文与源码里的字典相同。认库的字典靠的是压缩后的写法
// ns:"…",language:"（属性按源码的先后、双引号、ns 是字面量），升级或更换构建工具时要看一眼这条用例还认不认得出
// ════════════════════════════════════════════════════════════

const DIST = join(import.meta.dirname, '../../packages/plugin-webui-client/dist');

describe('前端随包带的字典', () => {
  it('dist 里的字典文件列出打进包里的全部字典，外壳的与源码相同', () => {
    const entries = JSON.parse(readFileSync(join(DIST, CLIENT_TEXTS_FILE), 'utf-8')) as Array<Record<string, unknown>>;
    const assets = join(DIST, 'assets');
    const libraries = readdirSync(assets)
      .filter(name => name.endsWith('.js'))
      .flatMap(name => [...readFileSync(join(assets, name), 'utf-8').matchAll(/\bns:"([^"]+)",language:"/g)])
      .map(match => match[1]);
    expect(libraries).toContain('@aalis/api-webui');
    expect(entries.map(entry => entry.ns).sort()).toEqual([t.ns, ...libraries].sort());
    expect(entries.find(entry => entry.ns === t.ns)).toEqual({
      v: 1,
      ns: t.ns,
      language: t.language,
      source: t.source,
      locales: t.locales,
    });
  });
});
