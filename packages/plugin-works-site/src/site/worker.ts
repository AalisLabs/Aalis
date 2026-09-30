import { publicPathProblem, WORK_ID_PATTERN, workHeaders } from '@aalis/api-publish';
import { canonicalBasePath } from './paths.js';

interface WorkerInput {
  nonce: string;
  mainOrigin: string;
  mainBasePath?: string;
  frameAncestors: readonly string[];
  works: Readonly<Record<string, readonly string[]>>;
}

const PLACEHOLDER = 'https://scope.invalid';
const NONCE = /^[A-Za-z0-9_-]{1,128}$/;

/** Return one self-contained Pages advanced-mode module. All policy headers come from api-publish. */
export function buildWorker(input: WorkerInput): string {
  if (!NONCE.test(input.nonce)) throw new TypeError('部署标记格式不对');
  let main: URL;
  try {
    main = new URL(input.mainOrigin);
  } catch {
    throw new TypeError('主站来源格式不对');
  }
  if (
    !['http:', 'https:'].includes(main.protocol) ||
    main.origin !== input.mainOrigin ||
    main.username ||
    main.password
  ) {
    throw new TypeError('主站来源格式不对');
  }
  const works: Record<string, string[]> = Object.create(null);
  const mainBasePath = canonicalBasePath(input.mainBasePath ?? '/');
  const headers: Record<string, Record<string, string>> = Object.create(null);
  for (const [id, paths] of Object.entries(input.works)) {
    if (!WORK_ID_PATTERN.test(id)) throw new TypeError('作品编号格式不对');
    const base = `/${id}/`;
    if (
      !paths.includes(base) ||
      paths.some(
        path =>
          path !== base &&
          (!path.startsWith(base) || !!publicPathProblem(path.slice(base.length)) || path === `${base}index.html`),
      )
    ) {
      throw new TypeError('作品清单路径格式不对');
    }
    works[id] = [...paths];
    headers[id] = workHeaders({ scope: { origin: PLACEHOLDER, basePath: base }, frameAncestors: input.frameAncestors });
  }
  const fallback = workHeaders({ scope: 'self', frameAncestors: input.frameAncestors });
  const manifest = { nonce: input.nonce, main: input.mainOrigin + mainBasePath, works, headers, fallback };
  return `const M = ${JSON.stringify(manifest)};\n${WORKER_TEMPLATE}`;
}

const WORKER_TEMPLATE = `
const SUBRESOURCE_ONLY = /\\.(?:css|js|mjs|json|png|jpe?g|gif|webp|mp4|woff2)$/i;
function headers(url, id) {
  const template = id ? M.headers[id] : M.fallback;
  const result = new Headers(template);
  if (id) result.set('Content-Security-Policy', template['Content-Security-Policy'].replaceAll('https://scope.invalid/' + id + '/', url.origin + '/' + id + '/'));
  result.set('X-Robots-Tag', 'noindex');
  return result;
}
function reply(status, url, body, id) {
  const h = headers(url, id);
  if (status === 200 && url.pathname === '/v/' + M.nonce + '.txt') h.set('Content-Type', 'text/plain; charset=utf-8');
  else if (body !== undefined) h.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { status, headers: h });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply(405, url);
    if (path === '/v/' + M.nonce + '.txt') return reply(200, url, request.method === 'HEAD' ? undefined : M.nonce);
    const match = /^\\/([a-z2-7]{10})\\//.exec(path);
    const id = match && match[1];
    if (!id || !Object.hasOwn(M.works, id) || !M.works[id].includes(path)) return reply(404, url);
    const dest = request.headers.get('Sec-Fetch-Dest');
    if (dest === 'document') {
      const h = headers(url, id);
      h.set('Location', M.main + 'w/' + id + '/');
      return new Response(null, { status: 302, headers: h });
    }
    if (dest === null && !SUBRESOURCE_ONLY.test(path)) {
      const notice = '<!doctype html><meta charset="utf-8"><p>请用较新的浏览器打开 ' + M.main + 'w/' + id + '/</p>';
      return reply(200, url, request.method === 'HEAD' ? undefined : notice, id);
    }
    const asset = await env.ASSETS.fetch(new Request(url.origin + path + url.search, { method: request.method, headers: request.headers, signal: request.signal }));
    if (![200, 206, 304].includes(asset.status)) return reply(404, url);
    const out = new Response(asset.body, asset);
    for (const [key, value] of headers(url, id)) {
      if (key === 'vary') out.headers.append(key, value);
      else out.headers.set(key, value);
    }
    return out;
  },
};`;
