import type { Context } from '@aalis/core';
import { safeFetch } from '@aalis/util-network-guard';
import type express from 'express';
import type { RouteGate } from '../gate.js';

/** 单张图最大体积（避免代理被滥用成大文件中转）。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 上游连接 + 完整下载总超时。 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * 图片代理：浏览器直连第三方图片常因 hotlink 防护 / referer / CORS / mixed content 失败；
 * 由服务端代为 fetch 后回吐字节流，前端始终从 `/api/proxy/image?url=...` 读取。
 *
 * 仅做透明代理：不缓存到磁盘，不重写 EXIF，纯流式转发。auth 中间件已在外层挂载，
 * 未登录请求拿不到 cookie 自然过不来；这里只关心 SSRF 与体积/超时。
 */
export function registerProxyRoutes(expressApp: express.Express, ctx: Context, gate: RouteGate): void {
  expressApp.get('/api/proxy/image', gate(), async (req, res) => {
    const raw = req.query.url;
    if (typeof raw !== 'string' || !raw) {
      res.status(400).json({ error: '缺少 url 参数' });
      return;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    try {
      // safeFetch 内含协议/host/逐跳重定向校验（SSRF）；非法 URL/内网/重定向越界等统一落到下方 catch。
      const upstream = await safeFetch(raw, {
        signal: ac.signal,
        // 不带 cookie / 不发用户 referer，避免泄露认证态；按 UA 鉴别的站点给个常见 desktop UA
        headers: {
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
      // 顶层导航打开本代理 URL 时按沙箱渲染（禁脚本），杜绝 image/svg+xml 反射型 XSS；
      // sandbox 指令仅作用于文档级加载，<img> 子资源渲染不受影响，图片正常显示。
      res.setHeader('content-security-policy', 'sandbox');

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
