import type { IncomingMessage } from 'node:http';
import type { Logger } from '@aalis/core';
import type { ProcessService } from '@aalis/plugin-process-api';
import type { RequestHandler } from 'express';

const COOKIE_NAME = 'aalis_webui_token';

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

/** 登录页：自包含 HTML，不引入外部资源；提交 POST /api/auth/login 后刷新到 / */
function loginPageHtml(reason?: string): string {
  const note = reason ? `<p class="note">${escapeHtml(reason)}</p>` : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>Aalis WebUI 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0d10;color:#e6e8eb}
.card{width:min(420px,90vw);padding:32px;background:#16191d;border:1px solid #262b32;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.4)}
h1{margin:0 0 8px;font-size:22px;font-weight:600}
p{margin:0 0 16px;color:#8b95a1;font-size:14px;line-height:1.5}
p.note{color:#ffb300}
input{width:100%;padding:10px 12px;font-size:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0d10;color:#e6e8eb;border:1px solid #2a3038;border-radius:6px;outline:none}
input:focus{border-color:#5b8def}
button{width:100%;margin-top:12px;padding:10px;font-size:14px;font-weight:500;background:#5b8def;color:#fff;border:0;border-radius:6px;cursor:pointer}
button:hover{background:#4a7de0}
button:disabled{opacity:.5;cursor:wait}
.err{margin-top:10px;color:#ff6b6b;font-size:13px;min-height:18px}
</style></head>
<body><form class="card" id="f">
<h1>Aalis WebUI</h1>
<p>请输入启动日志或 data/webui/access.txt 中显示的访问 token。</p>
${note}
<input id="t" type="password" autocomplete="off" placeholder="访问 token" autofocus required>
<button type="submit" id="b">登录</button>
<div class="err" id="e"></div>
</form>
<script>
const f=document.getElementById('f'),t=document.getElementById('t'),b=document.getElementById('b'),e=document.getElementById('e');
f.addEventListener('submit',async ev=>{
  ev.preventDefault();e.textContent='';b.disabled=true;
  try{
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t.value.trim()})});
    if(r.ok){location.replace('/');}else{const j=await r.json().catch(()=>({}));e.textContent=j.error||'token 不正确';b.disabled=false;t.select();}
  }catch(err){e.textContent='网络错误';b.disabled=false;}
});
</script></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface AuthSystem {
  /** Express 中间件：处理 ?token= 重定向、登录端点、未认证拦截、登录页 */
  middleware: RequestHandler;
  /** 校验 WebSocket 升级请求是否已认证（cookie 读取） */
  verifyWsClient(req: IncomingMessage): boolean;
}

/**
 * 创建 token 认证系统
 *
 * - token 由调用方传入（参见 index.ts resolveAuthToken，支持 ephemeral / persist / fixed 三种模式）
 * - HttpOnly + SameSite=Strict cookie
 * - 同源 POST /api/auth/login 提交，避免 querystring 泄露
 * - 用户首次进入若 URL 带 ?token= 则自动设置 cookie 并 302 到干净 URL
 */
export function createAuthSystem(token: string, _logger: Logger): AuthSystem {
  const cookieMaxAge = 30 * 24 * 3600; // 30d；进程重启 token 轮换后无效

  const middleware: RequestHandler = (req, res, next) => {
    const url = req.path;
    const qToken = typeof req.query?.token === 'string' ? (req.query.token as string) : undefined;

    // 1. ?token= 命中 → 设置 cookie → 302 到不带 query 的同路径
    if (req.method === 'GET' && qToken) {
      if (qToken === token) {
        res.setHeader('Set-Cookie', buildSetCookie(COOKIE_NAME, token, cookieMaxAge));
        res.redirect(302, url);
        return;
      }
      // ?token 错误：落到登录页（不向 next 透）
      res.status(401).type('html').send(loginPageHtml('URL 中的 token 不正确，请手动输入。'));
      return;
    }

    const cookieToken = parseCookieValue(req.headers.cookie, COOKIE_NAME);
    const authed = !!cookieToken && cookieToken === token;

    // 2. 登录端点
    if (url === '/api/auth/login' && req.method === 'POST') {
      const body = (req as { body?: { token?: string } }).body;
      if (typeof body?.token === 'string' && body.token === token) {
        res.setHeader('Set-Cookie', buildSetCookie(COOKIE_NAME, token, cookieMaxAge));
        res.json({ ok: true });
      } else {
        res.status(401).json({ ok: false, error: 'token 不正确' });
      }
      return;
    }

    // 3. 状态查询
    if (url === '/api/auth/status' && req.method === 'GET') {
      res.json({ authed });
      return;
    }

    // 4. 注销
    if (url === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', buildClearCookie(COOKIE_NAME));
      res.json({ ok: true });
      return;
    }

    // 5. 已认证 → 放行
    if (authed) {
      next();
      return;
    }

    // 6. 未认证：API 一律 401
    if (url.startsWith('/api/')) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    // 7. 未认证 GET：返回内联登录页（覆盖 SPA shell，不暴露任何静态资源）
    if (req.method === 'GET') {
      res.status(401).type('html').send(loginPageHtml());
      return;
    }

    res.status(401).end();
  };

  function verifyWsClient(req: IncomingMessage): boolean {
    const cookieToken = parseCookieValue(req.headers.cookie, COOKIE_NAME);
    return !!cookieToken && cookieToken === token;
  }

  return { middleware, verifyWsClient };
}

/**
 * 跨平台打开默认浏览器到指定 URL（无外部依赖）
 * 失败静默；此为便利功能，不影响服务启动。
 */
export function openBrowser(url: string, proc: ProcessService): void {
  try {
    const spawnDetached = (cmd: string, args: string[]) => {
      proc.spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
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
