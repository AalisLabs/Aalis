const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const RESERVED_ROOTS = new Set(['w', 'm', 't', 'assets', 'v']);

/** Canonical public directory; never interpret encoded separators or URL syntax. */
export function canonicalBasePath(value: string): string {
  if (value === '/') return '/';
  const parts = value.startsWith('/') ? value.slice(1).replace(/\/$/, '').split('/') : [];
  if (
    !parts.length ||
    parts.some(part => !SEGMENT.test(part) || part === '.' || part === '..') ||
    RESERVED_ROOTS.has(parts[0].toLowerCase()) ||
    /[%?#\\\s\p{Cc}]/u.test(value)
  )
    throw new TypeError('发布目录不合法');
  return `/${parts.join('/')}/`;
}

/** Relative path under a validated site base; returned path always starts with /. */
export function sitePath(basePath: string, relative: string): string {
  const base = canonicalBasePath(basePath);
  if (!relative || relative.startsWith('/')) throw new TypeError('站点相对路径不合法');
  return `${base}${relative}`;
}
