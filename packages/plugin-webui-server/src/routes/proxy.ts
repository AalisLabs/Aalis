import type { Logger } from '@aalis/core';
import { textOf, toSource } from '@aalis/schema-i18n';
import { FILE_HEAD_BYTES } from '@aalis/util-file-signature';
import { safeFetch } from '@aalis/util-network-guard';
import type express from 'express';
import type { RouteGate } from '../gate.js';
import { clientGone, route } from '../route.js';
import { t } from '../texts.js';
import { browserMediaOf } from './media.js';

/** 单张图最大体积（避免代理被滥用成大文件中转）。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 上游连接 + 完整下载总超时。 */
const FETCH_TIMEOUT_MS = 15_000;

/** 背压等待所需的最小响应面（express 的 Response / 任意 Writable 天然满足）。 */
interface DrainTarget {
  destroyed: boolean;
  once(event: 'drain' | 'close' | 'error', cb: () => void): void;
  off(event: 'drain' | 'close' | 'error', cb: () => void): void;
}

/**
 * 等到响应重新可写：返回 true 可继续写；等待期间连接断开（'close'/'error'，或进入等待
 * 时就已 destroyed）返回 false，调用方应中止转发并收掉上游。
 */
export function waitWritable(res: DrainTarget): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    function cleanup(): void {
      res.off('drain', onDrain);
      res.off('close', onStop);
      res.off('error', onStop);
    }
    const onDrain = (): void => {
      cleanup();
      resolve(true);
    };
    const onStop = (): void => {
      cleanup();
      resolve(false);
    };
    res.once('drain', onDrain);
    res.once('close', onStop);
    res.once('error', onStop);
  });
}

/**
 * 图片代理：浏览器直连第三方图片常因 hotlink 防护 / referer / CORS / mixed content 失败；
 * 由服务端代为 fetch 后回吐字节流，前端始终从 `/api/proxy/image?url=...` 读取。
 *
 * 不缓存到磁盘，不重写 EXIF，流式转发。auth 中间件已在外层挂载，未登录请求拿不到 cookie 自然过不来；这里管 SSRF、
 * 体积与超时，以及只转发图片：先读够文件头，与 /api/media 按同一份格式认图，类型取判定结果，上游写的 Content-Type
 * 不看（写错的真图照常显示，标成图片的 SVG 与网页不转发）。
 */
export function registerProxyRoutes(expressApp: express.Express, logger: Logger, gate: RouteGate): void {
  route(expressApp, 'GET /api/proxy/image', gate(), async (req, res) => {
    const raw = req.query.url;
    if (typeof raw !== 'string' || !raw) {
      res.status(400).json({ error: t('urlRequired') });
      return;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    // 客户端断开时连上游、读文件头与转发都随之停下
    const gone = clientGone(res);

    try {
      // safeFetch 内含协议/host/逐跳重定向校验（SSRF）；非法 URL/内网/重定向越界等统一落到下方 catch。
      const upstream = await safeFetch(raw, {
        signal: AbortSignal.any([ac.signal, gone]),
        // 不带 cookie / 不发用户 referer，避免泄露认证态；按 UA 鉴别的站点给个常见 desktop UA
        headers: {
          'user-agent': 'Mozilla/5.0 (Aalis WebUI Image Proxy)',
          accept: 'image/*,*/*;q=0.8',
        },
      });
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: t('upstreamStatus', { status: upstream.status }) });
        return;
      }
      const lenHeader = upstream.headers.get('content-length');
      if (lenHeader) {
        const len = Number(lenHeader);
        if (Number.isFinite(len) && len > MAX_IMAGE_BYTES) {
          res.status(413).json({ error: t('imageTooLarge', { size: len, max: MAX_IMAGE_BYTES }) });
          return;
        }
      }

      if (!upstream.body) {
        res.status(502).json({ error: t('noUpstreamBody') });
        return;
      }

      // 先读够文件头认图；手动累计字节，超限即中断
      const reader = upstream.body.getReader();
      const head: Buffer[] = [];
      let received = 0;
      let done = false;
      while (!done && received < FILE_HEAD_BYTES) {
        const chunk = await reader.read();
        done = chunk.done;
        if (chunk.value) {
          head.push(Buffer.from(chunk.value));
          received += chunk.value.byteLength;
        }
      }
      let pending: Buffer | undefined = Buffer.concat(head);
      const format = browserMediaOf(pending);
      if (format?.kind !== 'image') {
        ac.abort();
        await reader.cancel().catch(() => {});
        res.status(415).json({ error: t('notImage') });
        return;
      }

      res.setHeader('content-type', format.mime);
      res.setHeader('cache-control', 'private, max-age=86400');
      // 防止浏览器把响应当 HTML 渲染
      res.setHeader('x-content-type-options', 'nosniff');
      // 顶层导航打开本代理 URL 时按沙箱渲染（禁脚本）；sandbox 指令仅作用于文档级加载，<img> 子资源渲染不受影响。
      res.setHeader('content-security-policy', 'sandbox');

      // 已读的文件头先写出，后面的照旧流式转发
      while (pending) {
        if (received > MAX_IMAGE_BYTES) {
          ac.abort();
          if (!res.headersSent) res.status(413);
          res.end();
          return;
        }
        if (!res.write(pending)) {
          // 背压：等 drain。客户端中途断开时 'drain' 永不到达（socket 已毁），只等它会
          // 让这条请求的 async 帧、上游 body reader 与 socket 引用永久悬挂（连 finally 的
          // clearTimeout 都到不了），故与 close/error 竞速：连接没了就收上游、退出。
          if (!(await waitWritable(res))) {
            ac.abort();
            await reader.cancel().catch(() => {});
            return;
          }
        }
        pending = undefined;
        if (!done) {
          const chunk = await reader.read();
          done = chunk.done;
          if (chunk.value) {
            pending = Buffer.from(chunk.value);
            received += chunk.value.byteLength;
          }
        }
      }
      res.end();
    } catch (err) {
      // 客户端已断开：没有谁等这条应答，不是代理失败，不记告警
      if (gone.aborted) return;
      const reason = textOf(err);
      logger.warn(`图片代理失败 url=${raw} err=${toSource(reason)}`);
      if (!res.headersSent) res.status(502).json({ error: t('proxyFailed', { error: reason }) });
      else res.end();
    } finally {
      clearTimeout(timer);
    }
  });
}
