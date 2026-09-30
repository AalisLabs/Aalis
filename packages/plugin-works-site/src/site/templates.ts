import { type PublishedItem, WORK_IFRAME_SANDBOX } from '@aalis/api-publish';
import { sitePath } from './paths.js';

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

const date = (timestamp: number): string => escapeHtml(new Date(timestamp).toLocaleDateString());
const shell = (title: string, content: string, head = '', basePath = '/', bodyClass = '') =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${sitePath(basePath, 'assets/site.css')}">${head}</head><body${bodyClass ? ` class="${bodyClass}"` : ''}>${content}</body></html>`;

export const SITE_CSS = `*{box-sizing:border-box}body{font:1rem/1.6 system-ui,sans-serif;color:#222}body:not(.work-page){max-width:58rem;margin:2rem auto;padding:0 1rem}.card{display:block;margin:1rem 0;padding:1rem;border:1px solid #ddd}.card img{width:15rem;max-width:100%;height:auto}small{color:#555}body.work-page{margin:0;width:100%;height:100vh;height:100dvh;overflow:hidden}.work-page main{width:100%;height:100%}.work-page iframe{display:block;width:100%;height:100%;border:0}.work-page.media-page{background:#111}.media-page main{display:flex;align-items:center;justify-content:center}.media-page img,.media-page video{display:block;max-width:100%;max-height:100%;object-fit:contain}`;

export function indexPage(title: string, intro: string, items: readonly PublishedItem[], basePath = '/'): string {
  const cards = [...items]
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .map(
      item =>
        `<a class="card" href="${sitePath(basePath, `w/${item.id}/`)}">${item.hasThumbnail ? `<img src="${sitePath(basePath, `t/${item.id}.png`)}" loading="lazy" alt="">` : ''}<h2>${escapeHtml(item.title)}</h2><small>${date(item.publishedAt)}</small></a>`,
    )
    .join('');
  return shell(title, `<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p>${cards}</main>`, '', basePath);
}

export function wrapperPage(item: PublishedItem, origin?: string, basePath = '/'): string {
  let content: string;
  let head = '';
  if (item.kind === 'html') {
    if (!origin) throw new TypeError('网页作品缺少别名');
    head = `<meta http-equiv="Content-Security-Policy" content="frame-src ${origin}">`;
    content = `<iframe src="${origin}/${item.id}/" sandbox="${WORK_IFRAME_SANDBOX}" referrerpolicy="no-referrer" title="${escapeHtml(item.title)}"></iframe>`;
  } else {
    const path = item.files[0]?.path;
    if (!path) throw new TypeError('媒体作品没有文件');
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const src = sitePath(basePath, `m/${item.id}.${ext}`);
    content =
      ext === 'mp4'
        ? `<video controls playsinline preload="metadata"${item.hasThumbnail ? ` poster="${sitePath(basePath, `t/${item.id}.png`)}"` : ''} src="${src}"></video>`
        : `<img src="${src}" alt="${escapeHtml(item.title)}">`;
  }
  return shell(
    item.title,
    `<main>${content}</main>`,
    head,
    basePath,
    item.kind === 'html' ? 'work-page' : 'work-page media-page',
  );
}

export const removedPage = () =>
  '<!doctype html><html lang="zh"><meta charset="utf-8"><title>该作品已下架</title><h1>该作品已下架</h1></html>';
export const notFoundPage = (basePath = '/') => shell('页面未找到', '<main><h1>页面未找到</h1></main>', '', basePath);
