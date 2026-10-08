import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { UserIdentity } from '@aalis/api-authority';
import type { ProcessService } from '@aalis/api-process';
import { BUILTIN_THEMES, type BuiltinThemeId, DEFAULT_THEMES, type ErrorResponse } from '@aalis/api-webui';
import type express from 'express';
import { route } from './route.js';

const TOKEN_COOKIE = 'aalis_webui_token';

/** 同一来源地址在一个窗口内登录失败满这么多次，到窗口结束前它的登录一律回 429（正确的 token 也不收） */
const LOGIN_MAX_FAILURES = 10;
/** 登录失败的计数窗口，从这个地址的第一次失败算起；窗口结束自动解除，计数归零 */
const LOGIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
/** 失败计数表最多记这么多个地址：满了再记新地址时丢掉最早的那条，内存有界，也不因此变成全局锁定 */
export const LOGIN_FAILURE_ADDRESSES_MAX = 10_000;

/**
 * token 的定时安全比较：两边先取 SHA-256 摘要再逐字节比，比较耗时与 token 的内容和长度都无关，
 * 逐字节试探与按长度试探都得不到信号。
 */
function tokenEquals(given: string, expected: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** 不改状态的请求方法：不校验来源 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 请求的来源能不能收，WebSocket 升级与改状态的请求（非 GET）共用。浏览器发起的握手与 POST 一律带 Origin，只收与本服务同源的：
 * Origin 的主机与端口等于请求的 Host。同一主机别的端口上的网页与本服务同站，SameSite cookie 会随它的请求发出，
 * 靠这一关拦下。没有 Origin 的是浏览器之外的客户端（脚本、命令行），不会被别的网页借用户的浏览器发起，交给 token。
 * Host 按 Origin 的协议解析后再比，两边的默认端口都去掉（代理转来的 Host 可能写成 `x:443`）。
 * 经反向代理访问时，代理要把原始的 Host 转给本服务。
 */
export function originAllowed(req: Pick<IncomingMessage, 'headers'>): boolean {
  const { origin, host } = req.headers;
  if (origin === undefined) return true;
  if (host === undefined || !URL.canParse(origin)) return false;
  const { protocol, host: originHost } = new URL(origin);
  const target = `${protocol}//${host}`;
  return URL.canParse(target) && new URL(target).host === originHost;
}

/**
 * 这次导航是不是别的网页发起的：Sec-Fetch-Site 为 cross-site 或 same-site。粘贴链接、书签与启动时自动打开的
 * 一键登录链接是 none，本服务自己页面里的跳转是 same-origin；不带这个头的（浏览器之外的客户端、旧浏览器）不算
 */
function navigatedFromOtherSite(req: Pick<IncomingMessage, 'headers'>): boolean {
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site' || site === 'same-site';
}

function parseCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    if (k === name) {
      try {
        return decodeURIComponent(pair.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function buildSetCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

function buildClearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** 登录页的脚本：文档级 CSP 只许同源脚本，不内联，由这个地址给出（不需登录） */
const LOGIN_SCRIPT_PATH = '/api/auth/login.js';

/** 提交 POST /api/auth/login，成功后刷新到 / */
const LOGIN_SCRIPT = `const f=document.getElementById('f'),t=document.getElementById('t'),b=document.getElementById('b'),e=document.getElementById('e');
f.addEventListener('submit',async ev=>{
  ev.preventDefault();e.textContent='';b.disabled=true;
  try{
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t.value.trim()})});
    if(r.ok){location.replace('/');}else{const j=await r.json().catch(()=>({}));e.textContent=j.error||'token 不正确';b.disabled=false;t.select();}
  }catch(err){e.textContent='网络错误';b.disabled=false;}
});
`;

/** 一个内置主题的颜色令牌，写成 CSS 自定义属性的声明 */
const themeTokens = (id: BuiltinThemeId) =>
  Object.entries(BUILTIN_THEMES[id].colors)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');

/**
 * 登录页的样式：颜色取默认主题的令牌，深浅跟随系统（界面在登录之后才读得到本浏览器选的主题）。与界面同一套写法：
 * 不用卡片、不加阴影，圆角用小档
 */
const LOGIN_STYLE = `:root{color-scheme:light dark;${themeTokens(DEFAULT_THEMES.dark)}}
@media (prefers-color-scheme: light){:root{${themeTokens(DEFAULT_THEMES.light)}}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1rem;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:0.875rem;line-height:1.375rem;background:var(--color-bg);color:var(--color-text)}
form{width:min(22.5rem,100%);display:flex;flex-direction:column;gap:0.75rem}
h1{margin:0;font-size:1rem;line-height:1.5rem;font-weight:600}
p{margin:0;color:var(--color-text-2)}
p.note{color:var(--color-warning-text)}
input{width:100%;height:2.25rem;padding:0 0.75rem;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:1rem;color:var(--color-text);background:transparent;border:1px solid var(--color-border-control);border-radius:4px}
input:focus-visible,button:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px}
button{height:2.25rem;font:inherit;font-weight:500;color:var(--color-on-accent);background:var(--color-accent);border:0;border-radius:4px;cursor:pointer}
button:hover{background:var(--color-accent-hover)}
button:disabled{opacity:0.6;cursor:wait}
.err{min-height:1.375rem;color:var(--color-danger-text)}`;

/** 登录页：只引用同源的登录脚本，不引入别的资源 */
function loginPageHtml(reason?: string): string {
  const note = reason ? `<p class="note">${escapeHtml(reason)}</p>` : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>Aalis WebUI 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${LOGIN_STYLE}
</style></head>
<body><form id="f">
<h1>Aalis WebUI</h1>
<p>请输入启动日志或家目录里 state/webui/access.txt 中显示的访问 token。</p>
${note}
<input id="t" type="password" autocomplete="off" placeholder="访问 token" autofocus required>
<button type="submit" id="b">登录</button>
<div class="err" id="e"></div>
</form>
<script src="${LOGIN_SCRIPT_PATH}"></script></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface AuthSystem {
  /**
   * 挂上认证，要在 JSON 解析之后、其余路由之前：改状态的请求先核来源，再是登录页的脚本、`?token=` 一键登录、登录、
   * 登录状态与注销，其余未登录的请求一律拦下（API 回 401，GET 页面回登录页）
   */
  install(expressApp: express.Express): void;
  /** 校验 WebSocket 升级请求是否已认证（cookie 读取） */
  verifyWsClient(req: IncomingMessage): boolean;
  /** 解析调用者身份：单 token 模式 → `webui:console`（owner 级，单人语义）；未认证 → undefined。 */
  identify(req: Pick<IncomingMessage, 'headers'>): UserIdentity | undefined;
}

/**
 * 创建单 token 认证系统（单 owner）。
 *
 * - token 由调用方经 getToken 提供，每次校验现取：persist 模式下 storage 晚上线时，调用方会把
 *   启动时的临时 token 换成读回的持久化 token（见 index.ts 的 token 解析）
 * - HttpOnly + SameSite=Strict cookie；`?token=` 一键登录；同源 POST /api/auth/login 提交
 * - 改状态的请求（非 GET、HEAD、OPTIONS）按 {@link originAllowed} 校验来源，与 WebSocket 升级同一个判定：SameSite 按站判、
 *   不分端口，同一主机别的端口上的网页发一个简单 POST 就会带上 cookie
 * - `?token=` 与登录接口按来源地址限速：失败计数见 LOGIN_MAX_FAILURES、LOGIN_FAILURE_WINDOW_MS，成功清零。
 *   别的网页借 owner 的浏览器发起的登录（跨源的 POST、别的站点打开的 `?token=`）不比对也不计数，免得别人替 owner 把
 *   地址锁住。带 cookie 的请求不计数：各种模式的 token 都够长（随机生成的 24 字节，固定的至少 32 个字符），
 *   按 cookie 逐个猜猜不中；对 cookie 也锁定的话，共用一个来源地址（同一个反向代理）的已登录页面会被别人一起锁住
 * - 身份恒为 `webui:console`（owner 级，单人模式语义）
 */
export function createAuthSystem(getToken: () => string): AuthSystem {
  const cookieMaxAge = 30 * 24 * 3600; // 30d；进程重启 token 轮换后无效

  // 登录失败按来源地址计数。本机回环也计数：经同机反向代理来的请求全是回环地址，豁免回环等于不限速；
  // owner 自己输错满额也只等到窗口结束，已登录的页面不受影响。
  // 时间取单调时钟，键的插入顺序就是窗口结束的先后，过期的从表头剪掉；表满时也从表头丢，最多 LOGIN_FAILURE_ADDRESSES_MAX 条。
  const failures = new Map<string, { count: number; resetAt: number }>();

  /** 这个地址还要等多少毫秒才能再登录，不受限时为 0；先剪掉窗口已过的计数 */
  function lockedFor(address: string): number {
    const now = performance.now();
    for (const [key, entry] of failures) {
      if (entry.resetAt > now) break;
      failures.delete(key);
    }
    const entry = failures.get(address);
    return entry && entry.count >= LOGIN_MAX_FAILURES ? entry.resetAt - now : 0;
  }

  /** 记一次失败；须紧跟在 lockedFor 之后调用，表里留着的计数都还在窗口内 */
  function recordFailure(address: string): void {
    const entry = failures.get(address);
    if (entry) {
      entry.count++;
      return;
    }
    if (failures.size >= LOGIN_FAILURE_ADDRESSES_MAX) failures.delete(failures.keys().next().value as string);
    failures.set(address, { count: 1, resetAt: performance.now() + LOGIN_FAILURE_WINDOW_MS });
  }

  /** 给被限速的登录写好 429 与 Retry-After，返回给人看的说明 */
  function rejectLocked(res: express.Response, waitMs: number): string {
    res.status(429);
    res.setHeader('Retry-After', String(Math.ceil(waitMs / 1000)));
    return `登录失败次数过多，请 ${Math.ceil(waitMs / 60_000)} 分钟后再试。`;
  }

  function tokenAuthed(req: Pick<IncomingMessage, 'headers'>): boolean {
    const cookieToken = parseCookieValue(req.headers.cookie, TOKEN_COOKIE);
    return !!cookieToken && tokenEquals(cookieToken, getToken());
  }

  function identify(req: Pick<IncomingMessage, 'headers'>): UserIdentity | undefined {
    return tokenAuthed(req) ? { platform: 'webui', userId: 'console' } : undefined;
  }

  const addressOf = (req: express.Request) => req.socket.remoteAddress ?? '';

  function install(expressApp: express.Express): void {
    // 改状态的请求先看来源：别的网页借 owner 的浏览器发来的（带着 cookie）一律拒，登录与注销也一样
    expressApp.use((req, res, next) => {
      if (SAFE_METHODS.has(req.method) || originAllowed(req)) return next();
      res
        .status(403)
        .json({ error: '请求来源与本服务不同源（经反向代理访问时，代理要转发原始的 Host）' } satisfies ErrorResponse);
    });

    // 登录页的脚本不需登录
    route(expressApp, 'GET /api/auth/login.js', (_req, res) => {
      res.type('application/javascript').send(LOGIN_SCRIPT);
    });

    // ?token= 命中 → 设置 cookie → 302 到同一路径，只去掉 token，其余查询串（如日志的筛选）照留。别的站点打开的不认 token，
    // 按没带 token 往下走
    expressApp.use((req, res, next) => {
      const qToken = typeof req.query?.token === 'string' ? req.query.token : undefined;
      if (req.method !== 'GET' || !qToken || navigatedFromOtherSite(req)) return next();
      const address = addressOf(req);
      const waitMs = lockedFor(address);
      if (waitMs > 0) {
        const note = rejectLocked(res, waitMs);
        res.type('html').send(loginPageHtml(note));
        return;
      }
      const token = getToken();
      if (tokenEquals(qToken, token)) {
        failures.delete(address);
        res.setHeader('Set-Cookie', buildSetCookie(TOKEN_COOKIE, token, cookieMaxAge));
        const rest = new URLSearchParams(req.originalUrl.slice(req.originalUrl.indexOf('?') + 1));
        rest.delete('token');
        const search = rest.toString();
        res.redirect(302, search ? `${req.path}?${search}` : req.path);
        return;
      }
      recordFailure(address);
      res.status(401).type('html').send(loginPageHtml('URL 中的 token 不正确，请手动输入。'));
    });

    // 登录：{ token }。跨源的已在上面拒掉，不计数
    route(expressApp, 'POST /api/auth/login', (req, res) => {
      const address = addressOf(req);
      const waitMs = lockedFor(address);
      if (waitMs > 0) {
        res.json({ error: rejectLocked(res, waitMs) });
        return;
      }
      const body = (req.body as { token?: unknown } | undefined) ?? {};
      const token = getToken();
      if (typeof body.token === 'string' && tokenEquals(body.token, token)) {
        failures.delete(address);
        res.setHeader('Set-Cookie', buildSetCookie(TOKEN_COOKIE, token, cookieMaxAge));
        res.json({ ok: true, identity: { platform: 'webui', userId: 'console' } });
      } else {
        recordFailure(address);
        res.status(401).json({ error: 'token 不正确' });
      }
    });

    // 登录状态（含当前身份，供前端顶栏展示）
    route(expressApp, 'GET /api/auth/status', (req, res) => {
      const identity = identify(req);
      res.json({ authed: !!identity, identity });
    });

    // 注销：清 token cookie
    route(expressApp, 'POST /api/auth/logout', (_req, res) => {
      res.setHeader('Set-Cookie', buildClearCookie(TOKEN_COOKIE));
      res.json({ ok: true });
    });

    // 已登录的放行；没登录的 API 一律 401，GET 回内联登录页（覆盖 SPA shell，不暴露任何静态资源）
    expressApp.use((req, res, next) => {
      if (tokenAuthed(req)) return next();
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: 'unauthenticated' } satisfies ErrorResponse);
        return;
      }
      if (req.method === 'GET') {
        res.status(401).type('html').send(loginPageHtml());
        return;
      }
      res.status(401).end();
    });
  }

  function verifyWsClient(req: IncomingMessage): boolean {
    return tokenAuthed(req);
  }

  return { install, verifyWsClient, identify };
}

/**
 * 跨平台打开默认浏览器到指定 URL（无外部依赖）
 * 失败静默；此为便利功能，不影响服务启动。
 */
export function openBrowser(url: string, proc: ProcessService): void {
  try {
    const spawnDetached = (cmd: string, args: string[]) => {
      const handle = proc.spawn(cmd, args, { detached: true, stdio: 'ignore' });
      // **必须 await wait()**：`child.on('error')` 只在 wait() 内注册，而 `stdio:'ignore'`
      // 让 stdin 为 null、那条 handler 也挂不上——于是 handle 上零 error 监听。
      // spawn 失败（headless Linux/Docker 无 xdg-open 是常态）是**异步 emit**，
      // 外层 try/catch 接不住，直达 uncaughtException → runtime 的 process.exit(1)，
      // 把整个 bot 打死。而这只是个「顺手开浏览器」的便利功能。
      void handle.wait().catch(() => {
        /* 打不开浏览器不影响服务；这里只是给 handle 挂上 error 监听 */
      });
      handle.unref();
    };
    if (process.platform === 'darwin') {
      spawnDetached('open', [url]);
    } else if (process.platform === 'win32') {
      spawnDetached('cmd', ['/c', 'start', '""', url]);
    } else {
      spawnDetached('xdg-open', [url]);
    }
  } catch {
    /* ignore */
  }
}
