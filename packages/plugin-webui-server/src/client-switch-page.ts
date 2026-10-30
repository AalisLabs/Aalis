// 前端切换「逃生页」——由 webui-server 直出的极简恢复页，独立于任何「可被切换的前端」。
//
// 背景：前端切换统一走「服务偏好」下拉框，而该下拉框住在前端里。一旦切到不含该 UI 的极简
// 前端（如第三方裸前端），就没有切回去的入口（只能改 aalis.config.yaml + 重启）。本页由
// webui-server 直接托管在 `/__clients`，无论当前活跃前端多裸都可达，是「永不卡死」的恢复入口。
//
// 零新增后端逻辑：静态 HTML 加同源的脚本（`/__clients.js`），fetch 复用既有接口（同源 cookie 自动鉴权）——
//   · 列表：GET  /api/services                       （取 webui-client 服务的 providers + preferred）
//   · 切换：POST /api/services/webui-client/prefer    （owner 闸，body {contextId}）
// 全局 auth 中间件已要求登录方可到达本路由（未认证 GET 直接回登录页），故本页无需自加 gate；
// 切换动作仍受既有 owner 闸约束。抽成纯函数仅为便于单测——route 按全局层的语言渲染文字后交给它。
// 文字按全局层的语言：页面上的在服务端写进 HTML，脚本要的放进 texts 块，带参数的留着 {名} 占位，由脚本填（见 html.ts）。

import type { Localized } from '@aalis/schema-i18n';
import { escapeHtml, textsBlock } from './html.js';
import { t } from './texts.js';

/** 前端切换恢复页的脚本：文档级 CSP 只许同源脚本，由 `/__clients.js` 给出 */
export const CLIENT_SWITCH_SCRIPT = `(function () {
  var SVC = 'webui-client';
  var PREFER = '/api/services/' + SVC + '/prefer';
  var T = JSON.parse(document.getElementById('texts').textContent);
  var sel = document.getElementById('client');
  var btn = document.getElementById('go');
  var msg = document.getElementById('msg');
  function fill(text, values) {
    return text.replace(/\\{(\\w+)\\}/g, function (m, k) { return k in values ? String(values[k]) : m; });
  }
  function setMsg(t, err) { msg.textContent = t; msg.className = err ? 'err' : 'ok'; }
  function load() {
    fetch('/api/services', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error(fill(T.listFailed, { status: r.status }));
        return r.json();
      })
      .then(function (data) {
        var svc = data && data.services && data.services[SVC];
        var providers = (svc && svc.providers) || [];
        if (!providers.length) {
          setMsg(T.noClients, true);
          btn.disabled = true;
          sel.innerHTML = '';
          return;
        }
        var active = (svc && svc.preferred) || providers[0].contextId;
        sel.innerHTML = '';
        providers.forEach(function (p) {
          var o = document.createElement('option');
          var name = p.displayName || p.label || p.contextId;
          o.value = p.contextId;
          o.textContent = p.contextId === active ? fill(T.current, { name: name }) : name;
          if (p.contextId === active) o.selected = true;
          sel.appendChild(o);
        });
      })
      .catch(function (e) { setMsg(String((e && e.message) || e), true); });
  }
  btn.addEventListener('click', function () {
    var contextId = sel.value;
    if (!contextId) return;
    btn.disabled = true;
    setMsg(T.switching, false);
    fetch(PREFER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId: contextId })
    })
      .then(function (r) {
        if (r.ok) { setMsg(T.switched, false); location.href = '/'; return; }
        return r.json().catch(function () { return {}; }).then(function (j) {
          var detail = (j && j.error) || ('HTTP ' + r.status);
          var hint = (r.status === 401 || r.status === 403) ? T.ownerHint : '';
          setMsg(fill(T.failed, { detail: detail, hint: hint }), true);
          btn.disabled = false;
        });
      })
      .catch(function (e) { setMsg(fill(T.error, { error: String((e && e.message) || e) }), true); btn.disabled = false; });
  });
  load();
})();
`;

/** 恢复页的文字；带参数的以 {名} 占位交给脚本填。pageLanguage 是渲染时实际用的语言，写进 <html lang> */
export const CLIENT_SWITCH_TEXTS = {
  lang: t('pageLanguage'),
  title: t('switchTitle'),
  heading: t('switchHeading'),
  intro: t('switchIntro'),
  label: t('switchLabel'),
  loading: t('switchLoading'),
  button: t('switchButton'),
  back: t('switchBack'),
  script: {
    listFailed: t('switchListFailed', { status: '{status}' }),
    noClients: t('switchNoClients'),
    current: t('switchCurrent', { name: '{name}' }),
    switching: t('switching'),
    switched: t('switched'),
    ownerHint: t('switchOwnerHint'),
    failed: t('switchFailed', { detail: '{detail}', hint: '{hint}' }),
    error: t('switchError', { error: '{error}' }),
  },
};

/** 渲染前端切换恢复页的完整 HTML 文档：text 是渲染过的文字，数据由页面自身 fetch */
export function renderClientSwitchPage(text: Localized<typeof CLIENT_SWITCH_TEXTS>): string {
  return `<!doctype html>
<html lang="${escapeHtml(text.lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(text.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, -apple-system, sans-serif; max-width: 32rem; margin: 8vh auto; padding: 0 1.2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p.hint { color: #888; margin: .25rem 0 1.25rem; }
  label { display: block; font-weight: 600; margin-bottom: .4rem; }
  select, button { font: inherit; padding: .55rem .7rem; border-radius: .5rem; }
  select { width: 100%; box-sizing: border-box; }
  button { margin-top: 1rem; cursor: pointer; border: 1px solid currentColor; background: transparent; }
  button:disabled { opacity: .5; cursor: default; }
  #msg { margin-top: 1rem; min-height: 1.4em; }
  #msg.err { color: #c0392b; }
  #msg.ok { color: #2e7d32; }
  code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
  <h1>${escapeHtml(text.heading)}</h1>
  <p class="hint">${escapeHtml(text.intro)}</p>
  <label for="client">${escapeHtml(text.label)}</label>
  <select id="client"><option>${escapeHtml(text.loading)}</option></select>
  <button id="go" type="button">${escapeHtml(text.button)}</button>
  <div id="msg"></div>
  <p class="hint">${escapeHtml(text.back)}</p>
${textsBlock(text.script)}
<script src="/__clients.js"></script>
</body>
</html>`;
}
