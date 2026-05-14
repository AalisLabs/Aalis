import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { Context } from '@aalis/core';
import type express from 'express';

/** 单张图最大体积（避免代理被滥用成大文件中转）。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 上游连接 + 完整下载总超时。 */
const FETCH_TIMEOUT_MS = 15_000;

/** 判断 IP 是否落在私网 / 回环 / 链路本地 / 元数据地址段，用于 SSRF 防护。 */
function isPrivateAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 0) return true; // 解析失败按危险处理
  if (fam === 4) {
    const parts = addr.split('.').map(Number);
    if (parts.some(p => Number.isNaN(p))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped IPv6：剥壳后按 v4 再判一次
    return isPrivateAddress(lower.slice('::ffff:'.length));
  }
  return false;
}

async function assertSafeHost(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('拒绝代理私网/回环地址');
    return;
  }
  // 黑名单常见名称
  const lc = hostname.toLowerCase();
  if (lc === 'localhost' || lc.endsWith('.localhost') || lc.endsWith('.local')) {
    throw new Error('拒绝代理本地主机名');
  }
  // DNS 解析全部 A/AAAA，若任意一个是私网 → 拒绝
  const records = await dns.lookup(hostname, { all: true });
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw new Error(`拒绝代理：解析得到私网地址 ${r.address}`);
    }
  }
}

/**
 * 图片代理：浏览器直连第三方图片常因 hotlink 防护 / referer / CORS / mixed content 失败；
 * 由服务端代为 fetch 后回吐字节流，前端始终从 `/api/proxy/image?url=...` 读取。
 *
 * 仅做透明代理：不缓存到磁盘，不重写 EXIF，纯流式转发。auth 中间件已在外层挂载，
 * 未登录请求拿不到 cookie 自然过不来；这里只关心 SSRF 与体积/超时。
 */
export function registerProxyRoutes(expressApp: express.Express, ctx: Context): void {
  expressApp.get('/api/proxy/image', async (req, res) => {
    const raw = req.query.url;
    if (typeof raw !== 'string' || !raw) {
      res.status(400).json({ error: '缺少 url 参数' });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      res.status(400).json({ error: '非法 URL' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ error: '仅支持 http/https' });
      return;
    }

    try {
      await assertSafeHost(parsed.hostname);
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : 'SSRF 防护拒绝' });
      return;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    try {
      const upstream = await fetch(parsed.toString(), {
        signal: ac.signal,
        // 不带 cookie / 不发用户 referer，避免泄露认证态
        redirect: 'follow',
        headers: {
          // 部分站点会按 UA 鉴别，给个常见 desktop UA
          'user-agent': 'Mozilla/5.0 (Aalis WebUI Image Proxy)',
          accept: 'image/*,*/*;q=0.8',
        },
      });
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: `上游返回 ${upstream.status}` });
        return;
      }
      const ctype = upstream.headers.get('content-type') ?? 'application/octet-stream';
      if (!ctype.startsWith('image/')) {
        res.status(415).json({ error: `非图片 Content-Type: ${ctype}` });
        return;
      }
      const lenHeader = upstream.headers.get('content-length');
      if (lenHeader) {
        const len = Number(lenHeader);
        if (Number.isFinite(len) && len > MAX_IMAGE_BYTES) {
          res.status(413).json({ error: `图片过大 (${len} > ${MAX_IMAGE_BYTES})` });
          return;
        }
      }

      res.setHeader('content-type', ctype);
      res.setHeader('cache-control', 'private, max-age=86400');
      // 防止浏览器把响应当 HTML 渲染
      res.setHeader('x-content-type-options', 'nosniff');

      if (!upstream.body) {
        res.status(502).json({ error: '上游无响应体' });
        return;
      }

      // 手动累计字节，超限即中断
      const reader = upstream.body.getReader();
      let received = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > MAX_IMAGE_BYTES) {
            ac.abort();
            if (!res.headersSent) res.status(413);
            res.end();
            return;
          }
          if (!res.write(Buffer.from(value))) {
            // 背压：等 drain
            await new Promise<void>(resolve => res.once('drain', () => resolve()));
          }
        }
      }
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`图片代理失败 url=${raw} err=${msg}`);
      if (!res.headersSent) res.status(502).json({ error: `代理失败: ${msg}` });
      else res.end();
    } finally {
      clearTimeout(timer);
    }
  });
}
