import type { IncomingMessage } from 'node:http';
import type { Logger } from '@aalis/core';
import type { UserIdentity } from '@aalis/plugin-authority-api';
import type { ProcessService } from '@aalis/plugin-process-api';
import type { RequestHandler } from 'express';

const TOKEN_COOKIE = 'aalis_webui_token';
const SESSION_COOKIE = 'aalis_webui_session';

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

/**
 * 登录页：自包含 HTML，不引入外部资源。
 *
 * 存在账户时默认显示「账户登录」表单（用户名+密码），token 登录折叠为次选；
 * 无账户时只显示 token 表单。两种提交都打 POST /api/auth/login。
 */
function loginPageHtml(hasAccounts: boolean, reason?: string): string {
  const note = reason ? `<p class="note">${escapeHtml(reason)}</p>` : '';
  const accountForm = hasAccounts
    ? `<input id="u" type="text" autocomplete="username" placeholder="用户名" autofocus required>
<input id="p" type="password" autocomplete="current-password" placeholder="密码" required style="margin-top:8px">
<button type="submit" id="b">登录</button>
<details style="margin-top:14px"><summary>使用访问 token 登录</summary>
<input id="t" type="password" autocomplete="off" placeholder="访问 token" style="margin-top:8px">
<button type="button" id="tb" style="background:#2a3038">Token 登录</button>
</details>`
    : `<p>请输入启动日志或 data/webui/access.txt 中显示的访问 token。</p>
<input id="t" type="password" autocomplete="off" placeholder="访问 token" autofocus required>
<button type="submit" id="b">登录</button>`;
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
summary{color:#8b95a1;font-size:13px;cursor:pointer}
input{width:100%;padding:10px 12px;font-size:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0d10;color:#e6e8eb;border:1px solid #2a3038;border-radius:6px;outline:none}
input:focus{border-color:#5b8def}
button{width:100%;margin-top:12px;padding:10px;font-size:14px;font-weight:500;background:#5b8def;color:#fff;border:0;border-radius:6px;cursor:pointer}
button:hover{filter:brightness(1.08)}
button:disabled{opacity:.5;cursor:wait}
.err{margin-top:10px;color:#ff6b6b;font-size:13px;min-height:18px}
</style></head>
<body><form class="card" id="f">
<h1>Aalis WebUI</h1>
${note}
${accountForm}
<div class="err" id="e"></div>
</form>
<script>
const $=id=>document.getElementById(id);
const f=$('f'),e=$('e');
async function login(body,btn){
  e.textContent='';btn.disabled=true;
  try{
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(r.ok){location.replace('/');}else{const j=await r.json().catch(()=>({}));e.textContent=j.error||'登录失败';btn.disabled=false;}
  }catch(err){e.textContent='网络错误';btn.disabled=false;}
}
f.addEventListener('submit',ev=>{
  ev.preventDefault();
  const u=$('u'),t=$('t');
  if(u&&u.value.trim()){login({username:u.value.trim(),password:$('p').value},$('b'));}
  else if(t&&t.value.trim()){login({token:t.value.trim()},$('b'));}
});
const tb=$('tb');
if(tb)tb.addEventListener('click',()=>{const t=$('t');if(t.value.trim())login({token:t.value.trim()},tb);});
</script></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * 账户校验器 —— auth 系统对 authority 服务的最小依赖面。
 *
 * 以函数注入而非服务引用，调用方应惰性解析（authority 可能晚于 webui-server
 * 激活或被热替换）。
 */
export interface AccountVerifier {
  /** 校验账户密码（无账户/不匹配均 false） */
  verify(username: string, password: string): boolean | Promise<boolean>;
  /** 是否存在任何可登录账户（决定登录页是否显示账户表单） */
  hasAccounts(): boolean;
}

export interface AuthSystem {
  /** Express 中间件：处理 ?token= 重定向、登录端点、未认证拦截、登录页 */
  middleware: RequestHandler;
  /** 校验 WebSocket 升级请求是否已认证（cookie 读取） */
  verifyWsClient(req: IncomingMessage): boolean;
  /**
   * 解析请求的调用者身份：账户 session → `webui:<username>`；
   * 单 token 模式 → `webui:console`（owner 级，单人模式语义）；未认证 → undefined。
   */
  identify(req: Pick<IncomingMessage, 'headers'>): UserIdentity | undefined;
}

/** 账户登录失败的冷却记录（防在线爆破：同一用户名连续失败后短暂锁定） */
interface FailureRecord {
  count: number;
  lockedUntil: number;
}

const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

/**
 * 创建认证系统：账户 session + 单 token 双模式。
 *
 * - 账户登录（username/password）→ 服务端随机 session（内存表，重启失效），
 *   cookie `aalis_webui_session`，身份为 `webui:<username>`
 * - token 登录（向后兼容的单人模式）→ cookie `aalis_webui_token`，身份 `webui:console`
 * - 两者并存时 session 身份优先
 */
export function createAuthSystem(token: string, logger: Logger, accounts?: AccountVerifier): AuthSystem {
  const cookieMaxAge = 30 * 24 * 3600; // 30d；进程重启 token 轮换/session 表清空后无效
  const sessions = new Map<string, { username: string; expiresAt: number }>();
  const failures = new Map<string, FailureRecord>();

  function newSession(username: string): string {
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
    sessions.set(id, { username, expiresAt: Date.now() + cookieMaxAge * 1000 });
    return id;
  }

  function sessionUser(req: Pick<IncomingMessage, 'headers'>): string | undefined {
    const id = parseCookieValue(req.headers.cookie, SESSION_COOKIE);
    if (!id) return undefined;
    const s = sessions.get(id);
    if (!s) return undefined;
    if (s.expiresAt <= Date.now()) {
      sessions.delete(id);
      return undefined;
    }
    return s.username;
  }

  function tokenAuthed(req: Pick<IncomingMessage, 'headers'>): boolean {
    const cookieToken = parseCookieValue(req.headers.cookie, TOKEN_COOKIE);
    return !!cookieToken && cookieToken === token;
  }

  function identify(req: Pick<IncomingMessage, 'headers'>): UserIdentity | undefined {
    const username = sessionUser(req);
    if (username) return { platform: 'webui', userId: username };
    if (tokenAuthed(req)) return { platform: 'webui', userId: 'console' };
    return undefined;
  }

  function checkLocked(username: string): boolean {
    const rec = failures.get(username);
    return !!rec && rec.count >= MAX_FAILURES && rec.lockedUntil > Date.now();
  }

  function recordFailure(username: string): void {
    const rec = failures.get(username);
    if (rec && rec.lockedUntil > Date.now()) {
      rec.count += 1;
      rec.lockedUntil = Date.now() + LOCK_MS;
    } else {
      failures.set(username, { count: 1, lockedUntil: Date.now() + LOCK_MS });
    }
  }

  const middleware: RequestHandler = async (req, res, next) => {
    const url = req.path;
    const qToken = typeof req.query?.token === 'string' ? (req.query.token as string) : undefined;
    const hasAccounts = accounts?.hasAccounts() ?? false;

    // 1. ?token= 命中 → 设置 cookie → 302 到不带 query 的同路径
    if (req.method === 'GET' && qToken) {
      if (qToken === token) {
        res.setHeader('Set-Cookie', buildSetCookie(TOKEN_COOKIE, token, cookieMaxAge));
        res.redirect(302, url);
        return;
      }
      // ?token 错误：落到登录页（不向 next 透）
      res.status(401).type('html').send(loginPageHtml(hasAccounts, 'URL 中的 token 不正确，请手动输入。'));
      return;
    }

    // 2. 登录端点：{username, password}（账户）或 {token}（单人模式）
    if (url === '/api/auth/login' && req.method === 'POST') {
      const body = (req as { body?: { token?: string; username?: string; password?: string } }).body ?? {};
      if (typeof body.username === 'string' && typeof body.password === 'string') {
        const username = body.username.trim();
        if (checkLocked(username)) {
          res.status(429).json({ ok: false, error: '尝试次数过多，请稍后再试' });
          return;
        }
        if (username && (await accounts?.verify(username, body.password))) {
          failures.delete(username);
          res.setHeader('Set-Cookie', buildSetCookie(SESSION_COOKIE, newSession(username), cookieMaxAge));
          logger.info(`账户登录: webui:${username}`);
          res.json({ ok: true, identity: { platform: 'webui', userId: username } });
        } else {
          recordFailure(username);
          res.status(401).json({ ok: false, error: '用户名或密码不正确' });
        }
        return;
      }
      if (typeof body.token === 'string' && body.token === token) {
        res.setHeader('Set-Cookie', buildSetCookie(TOKEN_COOKIE, token, cookieMaxAge));
        res.json({ ok: true, identity: { platform: 'webui', userId: 'console' } });
      } else {
        res.status(401).json({ ok: false, error: 'token 不正确' });
      }
      return;
    }

    // 3. 状态查询（含当前身份，供前端顶栏展示）
    if (url === '/api/auth/status' && req.method === 'GET') {
      const identity = identify(req);
      res.json({ authed: !!identity, identity });
      return;
    }

    // 4. 注销：清 session 记录与两种 cookie
    if (url === '/api/auth/logout' && req.method === 'POST') {
      const sid = parseCookieValue(req.headers.cookie, SESSION_COOKIE);
      if (sid) sessions.delete(sid);
      res.setHeader('Set-Cookie', [buildClearCookie(SESSION_COOKIE), buildClearCookie(TOKEN_COOKIE)]);
      res.json({ ok: true });
      return;
    }

    // 5. 已认证 → 放行
    if (identify(req)) {
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
      res.status(401).type('html').send(loginPageHtml(hasAccounts));
      return;
    }

    res.status(401).end();
  };

  function verifyWsClient(req: IncomingMessage): boolean {
    return !!identify(req);
  }

  return { middleware, verifyWsClient, identify };
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
