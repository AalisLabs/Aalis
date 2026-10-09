// ============================================================
// routes/frames.ts — 插件前端的文件托管
//
// GET /frames/:token/<路径> 给出插件前端 webui/ 里的文件，token 是页面登记时随机生成的（pages.ts），页面撤回或重新
// 登记后旧的回 404；GET /frames/_base/<路径> 给出 api-webui 随包带的公用文件（助手与样式基线）。注册在认证之前，
// 不看 cookie：token 只出现在要登录的 GET /api/pages 里，文件是随包发布的代码，不含数据。
// 托管用 express.static，前面另加扩展名白名单与 realpath 两道；不合的一律 404，不回目录、不发 3xx：重定向之后 CSP 只按
// 来源匹配、不看路径，「只放行这一页的目录」就失效了。只收 GET 与 HEAD。
// 响应头带框架 CSP，盖过全局的文档级 CSP。CSP 的来源取请求的 Host，写成带路径、不带协议的来源，http 访问与经 TLS 代理的
// https 访问都成立；Host 只收主机名或 IPv4 地址加可选端口，去掉默认端口。
// ============================================================

import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { FRAME_SANDBOX } from '@aalis/api-webui';
import express from 'express';
import { realWithin } from '../pages.js';

/** 公用文件的地址段 */
const BASE = '_base';
/** api-webui 随包带的公用文件所在的目录 */
const BASE_DIR = join(
  dirname(createRequire(import.meta.url).resolve('@aalis/api-webui/package.json')),
  'dist',
  'frame',
);
/** 托管的扩展名：网页、脚本、样式、图片与字体 */
const EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.woff2',
]);
/** 主机名或 IPv4 地址，加可选端口。IPv6 字面地址写不进 CSP 的来源，带分号、空白、斜杠的会改写 CSP，都不收 */
const HOST = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?$/;

/**
 * 框架 CSP：除脚本外按类型放开、不按来源限，样式、字体、图片、音视频与数据请求都能取外站的。只留两道：脚本只认这一页的
 * 目录与公用目录（不许内联与 eval，worker 经回退链同样只认它们），框架里不能再嵌别的网页（frame 与 object 都不给）。
 * 宿主接口靠不同源挡：框架是不透明来源，请求不带登录状态，改状态的请求与 WebSocket 握手按来源被拒
 */
function frameCsp(host: string, token: string): string {
  return [
    `sandbox ${FRAME_SANDBOX}`,
    `script-src ${host}/frames/${token}/ ${host}/frames/${BASE}/`,
    "frame-src 'none'",
    "object-src 'none'",
    `frame-ancestors ${host}`,
  ].join('; ');
}

/** 请求里的路径按 %xx 解开，与 express.static 的解法相同；解不开的回 undefined */
function decoded(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/** dirOf 按 token 取插件前端的 webui/ 目录（realpath），没有这个 token 时回 undefined */
export function registerFrameRoutes(expressApp: express.Express, dirOf: (token: string) => string | undefined): void {
  expressApp.use('/frames/:token', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.status(405).end();
      return;
    }
    const given = req.headers.host ?? '';
    if (!HOST.test(given)) {
      res.status(400).end();
      return;
    }
    // 代理转来的 Host 可能写成 x:443，经 TLS 终结的代理还可能写成 x:80，原样写进 CSP 会与页面的端口对不上
    const host = given.replace(/:(?:80|443)$/, '');
    const { token } = req.params;
    const dir = token === BASE ? BASE_DIR : dirOf(token);
    const path = decoded(req.path);
    if (!dir || !path || !EXTENSIONS.has(extname(path).toLowerCase()) || !realWithin(dir, path)) {
      res.status(404).end();
      return;
    }
    express.static(dir, {
      dotfiles: 'ignore',
      index: false,
      redirect: false,
      setHeaders: served => {
        served.setHeader('Content-Security-Policy', frameCsp(host, token));
        served.setHeader('X-Content-Type-Options', 'nosniff');
        // 框架能取外站的资源：不把框架地址带给外站
        served.setHeader('Referrer-Policy', 'no-referrer');
        // 框架文档是不透明来源，模块脚本连取自己目录下的文件也走 CORS
        served.setHeader('Access-Control-Allow-Origin', '*');
        served.setHeader('Cache-Control', 'no-cache');
      },
    })(req, res, () => res.status(404).end());
  });
  // token 段的 %xx 解不开时，路由在解参数这一步就抛错、走不到上面；默认的错误处理会回堆栈，这里一律回 404。
  // 紧跟在挂载之后，前面只有给每个响应加 CSP 的中间件，接到的错误只会来自这里
  expressApp.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(404).end();
  });
}
