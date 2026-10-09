import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 报错与生成的文件里写的文档站地址都指向真有的页面：报错写修法时指向文档站上的完整地址（作者指南「报错与故障说明」），
// 页面改名、挪节会让这些地址悄悄失效。带锚点的要指向页面里显式写的 <a id="…">，改标题的字不会让它失效。
// 地址写成字面量，或写成「站点根常量」接路径（如 `${DOCS}/guide/first-run`）
// ════════════════════════════════════════════════════════════

const ROOT = join(__dirname, '../..');
const DOCS = join(ROOT, 'docs');
const SITE = /https:\/\/aalis\.acenyan\.com((?:\/[\w-]+)*)(#[\w-]+)?/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** 一份源码里的文档站地址：站点里的路径加锚点，如 `/guide/first-run#upgrade-node` */
function siteLinks(text: string): string[] {
  const links = [...text.matchAll(SITE)].map(m => m[1] + (m[2] ?? ''));
  for (const [, root] of text.matchAll(/const (\w+) = 'https:\/\/aalis\.acenyan\.com';/g)) {
    for (const m of text.matchAll(new RegExp(`\\$\\{${root}\\}((?:/[\\w-]+)*)(#[\\w-]+)?`, 'g'))) {
      links.push(m[1] + (m[2] ?? ''));
    }
  }
  return links;
}

/** 文档站开着 cleanUrls：`/guide/first-run` 是 docs/guide/first-run.md，站点根是 docs/index.md */
function brokenReason(link: string): string | undefined {
  const [path, anchor] = link.split('#');
  const page = join(DOCS, `${path.replace(/^\//, '') || 'index'}.md`);
  if (!existsSync(page)) return `没有 ${relative(ROOT, page)}`;
  if (anchor && !readFileSync(page, 'utf-8').includes(`<a id="${anchor}"></a>`)) {
    return `${relative(ROOT, page)} 里没有 <a id="${anchor}"></a>`;
  }
  return undefined;
}

describe('源码里的文档站地址', () => {
  const found = readdirSync(join(ROOT, 'packages'))
    .map(pkg => join(ROOT, 'packages', pkg, 'src'))
    .filter(existsSync)
    .flatMap(sourceFiles)
    .flatMap(file => siteLinks(readFileSync(file, 'utf-8')).map(link => ({ file: relative(ROOT, file), link })));

  it('扫到了报错与脚手架里的地址', () => {
    expect(found.map(f => f.link)).toEqual(
      expect.arrayContaining(['/guide/troubleshooting', '/guide/first-run', '/guide/first-run#upgrade-node']),
    );
  });

  it('都指向 docs/ 里有的页面与显式锚点', () => {
    const broken = found.flatMap(({ file, link }) => {
      const reason = brokenReason(link);
      return reason ? [`${file}: ${link}（${reason}）`] : [];
    });
    expect(broken).toEqual([]);
  });
});
