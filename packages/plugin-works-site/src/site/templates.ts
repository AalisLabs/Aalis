import { type PublishedItem, WORK_IFRAME_SANDBOX } from '@aalis/api-publish';

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
const shell = (title: string, content: string, head = '') =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/site.css">${head}</head><body>${content}</body></html>`;

export const SITE_CSS = `body{max-width:58rem;margin:2rem auto;padding:0 1rem;font:1rem/1.6 system-ui,sans-serif;color:#222}img,video,iframe{max-width:100%}iframe{width:100%;height:70vh;border:1px solid #bbb}.card{display:block;margin:1rem 0;padding:1rem;border:1px solid #ddd}.card img{width:15rem;height:auto}small{color:#555}`;

export function indexPage(title: string, intro: string, items: readonly PublishedItem[]): string {
  const cards = [...items]
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .map(
      item =>
        `<a class="card" href="/w/${item.id}/">${item.hasThumbnail ? `<img src="/t/${item.id}.png" loading="lazy" alt="">` : ''}<h2>${escapeHtml(item.title)}</h2><small>${date(item.publishedAt)} · ${escapeHtml(item.credit)}</small></a>`,
    )
    .join('');
  return shell(title, `<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p>${cards}</main>`);
}

export function wrapperPage(item: PublishedItem, origin?: string): string {
  let content: string;
  let head = '';
  if (item.kind === 'html') {
    if (!origin) throw new TypeError('网页作品缺少别名');
    head = `<meta http-equiv="Content-Security-Policy" content="frame-src ${origin}">`;
    content = `<iframe src="${origin}/${item.id}/" sandbox="${WORK_IFRAME_SANDBOX}" referrerpolicy="no-referrer" loading="lazy" title="${escapeHtml(item.title)}"></iframe>`;
  } else {
    const path = item.files[0]?.path;
    if (!path) throw new TypeError('媒体作品没有文件');
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const src = `/m/${item.id}.${ext}`;
    content =
      ext === 'mp4'
        ? `<video controls playsinline preload="metadata"${item.hasThumbnail ? ` poster="/t/${item.id}.png"` : ''} src="${src}"></video>`
        : `<img src="${src}" alt="${escapeHtml(item.title)}">`;
  }
  return shell(
    item.title,
    `<main><h1>${escapeHtml(item.title)}</h1><small>${date(item.publishedAt)} · ${escapeHtml(item.credit)}</small><p>${escapeHtml(item.summary)}</p>${content}</main>`,
    head,
  );
}

export const removedPage = () =>
  '<!doctype html><html lang="zh"><meta charset="utf-8"><title>该作品已下架</title><h1>该作品已下架</h1></html>';
export const notFoundPage = () => shell('页面未找到', '<main><h1>页面未找到</h1></main>');
