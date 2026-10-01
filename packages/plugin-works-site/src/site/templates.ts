import { type PublishedItem, WORK_IFRAME_SANDBOX } from '@aalis/api-publish';
import { canonicalBasePath, sitePath } from './paths.js';

const encoder = new TextEncoder();
export const encode = (text: string): Uint8Array => encoder.encode(text);

/** Strip format controls before HTML escaping, including bidi overrides and zero-width controls. */
function escapeHtml(value: string): string {
  return value
    .replace(/\p{Cf}/gu, '')
    .replace(
      /[&<>"']/g,
      char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
    );
}

/** 固定写成「2026 年 10 月 1 日」，不随宿主进程的 locale 变 */
function date(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 站点信息：标题、简介，以及拼分享信息（og）绝对地址用的主站源；源缺省时不写 og:url 与 og:image */
export interface SiteInfo {
  title: string;
  intro: string;
  origin?: string;
}

function meta(property: string, content: string): string {
  return `<meta property="${property}" content="${escapeHtml(content)}">`;
}

/**
 * 页面外壳。htmlClass 为 site 的页面（首页、404、下架页）跟随系统深浅色；作品页不设，避免改变作品框外的底色。
 * 主站的 CSP 只许 style-src 'self'，所以样式一律经外链样式表，不写内联样式。
 */
function shell(p: {
  title: string;
  content: string;
  basePath: string;
  head?: string;
  bodyClass?: string;
  htmlClass?: string;
}): string {
  return `<!doctype html><html lang="zh-CN"${p.htmlClass ? ` class="${p.htmlClass}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(p.title)}</title><link rel="stylesheet" href="${sitePath(p.basePath, 'assets/site.css')}">${p.head ?? ''}</head><body${p.bodyClass ? ` class="${p.bodyClass}"` : ''}>${p.content}</body></html>`;
}

export const SITE_CSS = `*{box-sizing:border-box}
html.site{color-scheme:light dark;--paper:#f6f4ef;--ink:#1d1b18;--muted:#77726a;--line:#e4e0d7;--chip:#ece8df;--accent:#3b5bdb;--shadow:0 1px 2px rgb(40 30 10/6%),0 8px 24px -12px rgb(40 30 10/18%)}
@media (prefers-color-scheme:dark){html.site{--paper:#131312;--ink:#eeebe4;--muted:#9b968c;--line:#2c2b28;--chip:#262522;--accent:#8ea6ff;--shadow:0 1px 2px rgb(0 0 0/40%),0 10px 30px -14px rgb(0 0 0/70%)}}
body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif}
html.site body{background:var(--paper);color:var(--ink)}
html.site a{color:inherit;text-decoration:none}
.gallery{max-width:1180px;margin:0 auto;padding:56px 24px 72px}
.masthead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px 24px;flex-wrap:wrap;padding-bottom:28px;border-bottom:1px solid var(--line)}
.masthead h1{margin:0;font-size:clamp(30px,5vw,44px);line-height:1.15;letter-spacing:-.01em;font-weight:700}
.masthead p{margin:10px 0 0;color:var(--muted);max-width:36em}
.masthead .count{color:var(--muted);font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap}
.grid{list-style:none;margin:32px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:28px 24px}
.work{display:block;border-radius:14px}
.work:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.thumb{position:relative;aspect-ratio:16/10;border-radius:14px;overflow:hidden;background:var(--chip);box-shadow:var(--shadow);transition:transform .25s ease}
.thumb img{display:block;width:100%;height:100%;object-fit:cover}
.work:hover .thumb{transform:translateY(-3px)}
@media (prefers-reduced-motion:reduce){.thumb{transition:none}.work:hover .thumb{transform:none}}
.kind{position:absolute;left:10px;bottom:10px;font-size:12px;line-height:1;padding:6px 9px;border-radius:999px;background:rgb(20 18 15/62%);color:#fff;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.glyph{position:absolute;inset:0;display:grid;place-items:center;font-size:56px;font-weight:700}
.tone-0{background:linear-gradient(135deg,#dfe7ff,#b9c8ff);color:#2a3f99}
.tone-1{background:linear-gradient(135deg,#f3e1ff,#d9b8f5);color:#6a2c91}
.tone-2{background:linear-gradient(135deg,#ffe9d6,#ffc999);color:#9a4b12}
.tone-3{background:linear-gradient(135deg,#dcf3e8,#a9dfc4);color:#1d6b4b}
.tone-4{background:linear-gradient(135deg,#ffe0e4,#ffb8c2);color:#9b2638}
.tone-5{background:linear-gradient(135deg,#e3f1f8,#b3d9ec);color:#1f5d7a}
.work h2{margin:14px 2px 2px;font-size:17px;line-height:1.4;font-weight:600;overflow-wrap:anywhere}
.work .date{margin:0 2px;color:var(--muted);font-size:13px}
.work .sum{margin:6px 2px 0;color:var(--muted);font-size:14px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.empty{margin-top:48px;color:var(--muted)}
.notice{min-height:100vh;min-height:100dvh;display:grid;place-content:center;text-align:center;padding:24px}
.notice h1{margin:0 0 8px;font-size:24px}
.notice p{margin:0 0 20px;color:var(--muted)}
.notice a{display:inline-block;padding:8px 18px;border-radius:999px;border:1px solid var(--line)}
.notice a:hover{border-color:var(--muted)}
body.work-page{width:100%;height:100vh;height:100dvh;overflow:hidden}
.work-page main{width:100%;height:100%}
.work-page iframe{display:block;width:100%;height:100%;border:0}
.work-page.media-page{background:#111}
.media-page main{display:flex;align-items:center;justify-content:center}
.media-page img,.media-page video{display:block;max-width:100%;max-height:100%;object-fit:contain}
`;

function extOf(item: PublishedItem): string {
  const path = item.files[0]?.path ?? '';
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase();
}

function kindLabel(item: PublishedItem): string {
  if (item.kind === 'html') return '网页';
  const ext = extOf(item);
  return ext === 'mp4' ? '视频' : ext === 'gif' ? '动图' : '图片';
}

/** 没有缩略图时的封面：按作品编号挑一种底色，中间放标题的第一个字 */
function placeholder(item: PublishedItem): string {
  const tone = [...item.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;
  const glyph = [...item.title.replace(/[\p{Cf}\p{Cc}\s]/gu, '')][0] ?? '作';
  return `<div class="thumb tone-${tone}"><span class="glyph">${escapeHtml(glyph)}</span>`;
}

function card(item: PublishedItem, basePath: string): string {
  const thumb = item.hasThumbnail
    ? `<div class="thumb"><img src="${sitePath(basePath, `t/${item.id}.png`)}" loading="lazy" alt="">`
    : placeholder(item);
  const summary = item.summary.trim() ? `<p class="sum">${escapeHtml(item.summary)}</p>` : '';
  return `<li><a class="work" href="${sitePath(basePath, `w/${item.id}/`)}">${thumb}<span class="kind">${kindLabel(item)}</span></div><h2>${escapeHtml(item.title)}</h2><p class="date">${date(item.publishedAt)}</p>${summary}</a></li>`;
}

export function indexPage(site: SiteInfo, items: readonly PublishedItem[], basePath = '/'): string {
  const sorted = [...items].sort((a, b) => b.publishedAt - a.publishedAt);
  const cover = sorted.find(item => item.hasThumbnail);
  const head = [
    meta('og:type', 'website'),
    meta('og:title', site.title),
    site.intro
      ? `<meta name="description" content="${escapeHtml(site.intro)}">${meta('og:description', site.intro)}`
      : '',
    site.origin ? meta('og:url', `${site.origin}${canonicalBasePath(basePath)}`) : '',
    site.origin && cover ? meta('og:image', `${site.origin}${sitePath(basePath, `t/${cover.id}.png`)}`) : '',
  ].join('');
  const list = sorted.length
    ? `<ul class="grid">${sorted.map(item => card(item, basePath)).join('')}</ul>`
    : '<p class="empty">还没有作品。</p>';
  const intro = site.intro ? `<p>${escapeHtml(site.intro)}</p>` : '';
  return shell({
    title: site.title,
    head,
    basePath,
    htmlClass: 'site',
    content: `<main class="gallery"><header class="masthead"><div><h1>${escapeHtml(site.title)}</h1>${intro}</div><div class="count">共 ${sorted.length} 件</div></header>${list}</main>`,
  });
}

/**
 * 单件作品页：作品铺满视口，页面上不显示标题、日期、简介与署名（作品以自己的样子出现）。
 * 标题只进浏览器标题与无障碍标签；分享信息只带标题与缩略图，不带简介。
 */
export function wrapperPage(item: PublishedItem, origin?: string, basePath = '/', siteOrigin?: string): string {
  let content: string;
  const head = [
    meta('og:type', 'website'),
    meta('og:title', item.title),
    siteOrigin ? meta('og:url', `${siteOrigin}${sitePath(basePath, `w/${item.id}/`)}`) : '',
    siteOrigin && item.hasThumbnail ? meta('og:image', `${siteOrigin}${sitePath(basePath, `t/${item.id}.png`)}`) : '',
  ];
  if (item.kind === 'html') {
    if (!origin) throw new TypeError('网页作品缺少别名');
    head.push(`<meta http-equiv="Content-Security-Policy" content="frame-src ${origin}">`);
    content = `<iframe src="${origin}/${item.id}/" sandbox="${WORK_IFRAME_SANDBOX}" referrerpolicy="no-referrer" title="${escapeHtml(item.title)}"></iframe>`;
  } else {
    if (!item.files[0]?.path) throw new TypeError('媒体作品没有文件');
    const ext = extOf(item);
    const src = sitePath(basePath, `m/${item.id}.${ext}`);
    content =
      ext === 'mp4'
        ? `<video controls playsinline preload="metadata"${item.hasThumbnail ? ` poster="${sitePath(basePath, `t/${item.id}.png`)}"` : ''} src="${src}"></video>`
        : `<img src="${src}" alt="${escapeHtml(item.title)}">`;
  }
  return shell({
    title: item.title,
    content: `<main>${content}</main>`,
    head: head.join(''),
    basePath,
    bodyClass: item.kind === 'html' ? 'work-page' : 'work-page media-page',
  });
}

function noticePage(title: string, text: string, basePath: string): string {
  return shell({
    title,
    basePath,
    htmlClass: 'site',
    content: `<main class="notice"><div><h1>${title}</h1><p>${text}</p><a href="${canonicalBasePath(basePath)}">去作品集看看</a></div></main>`,
  });
}

/**
 * 下架页。basePath 是主站的发布目录：主站上的下架页套站点样式并带回作品集的链接；
 * 作品分支上的（作品框里显示）不给 basePath，只有一句话，不外链样式，也不给跳转（框里跳出去也到不了顶层）。
 */
export function removedPage(basePath?: string): string {
  if (basePath === undefined)
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>该作品已下架</title><p>该作品已下架</p></html>';
  return noticePage('该作品已下架', '这件作品已经从作品集里撤下。', basePath);
}

export const notFoundPage = (basePath = '/') => noticePage('页面未找到', '这个地址没有内容。', basePath);
