// 前端切换「逃生页」——由 webui-server 直出的极简恢复页，独立于任何「可被切换的前端」。
//
// 背景：前端切换统一走「服务偏好」下拉框，而该下拉框住在前端里。一旦切到不含该 UI 的极简
// 前端（如第三方裸前端），就没有切回去的入口（只能改 aalis.config.yaml + 重启）。本页由
// webui-server 直接托管在 `/__clients`，无论当前活跃前端多裸都可达，是「永不卡死」的恢复入口。
//
// 零新增后端逻辑：纯静态 HTML + 同源 fetch 复用既有接口（同源 cookie 自动鉴权）——
//   · 列表：GET  /api/services                       （取 webui-client 服务的 providers + preferred）
//   · 切换：POST /api/services/webui-client/prefer    （owner 闸，body {contextId}）
// 全局 auth 中间件已要求登录方可到达本路由（未认证 GET 直接回登录页），故本页无需自加 gate；
// 切换动作仍受既有 owner 闸约束。抽成纯函数仅为便于单测——route 只 res.type('html').send(它)。

/** 渲染前端切换恢复页的完整 HTML 文档（无运行时入参，数据由页面自身 fetch）。 */
export function renderClientSwitchPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>切换前端 · Aalis</title>
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
  <h1>切换前端</h1>
  <p class="hint">这是 Aalis 的前端恢复入口，由 webui-server 直接提供、独立于当前前端——即使当前前端没有切换界面，你也能在这里切回去。</p>
  <label for="client">可用前端（webui-client）</label>
  <select id="client"><option>加载中…</option></select>
  <button id="go" type="button">切换并刷新</button>
  <div id="msg"></div>
  <p class="hint">切回原来的前端：在上面选中它，再点「切换并刷新」。</p>
<script>
(function () {
  var SVC = 'webui-client';
  var PREFER = '/api/services/' + SVC + '/prefer';
  var sel = document.getElementById('client');
  var btn = document.getElementById('go');
  var msg = document.getElementById('msg');
  function setMsg(t, err) { msg.textContent = t; msg.className = err ? 'err' : 'ok'; }
  function load() {
    fetch('/api/services', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('读取服务列表失败（HTTP ' + r.status + '）');
        return r.json();
      })
      .then(function (data) {
        var svc = data && data.services && data.services[SVC];
        var providers = (svc && svc.providers) || [];
        if (!providers.length) {
          setMsg('未发现任何前端（webui-client provider）。请先安装一个 aalis.client 包。', true);
          btn.disabled = true;
          sel.innerHTML = '';
          return;
        }
        var active = (svc && svc.preferred) || providers[0].contextId;
        sel.innerHTML = '';
        providers.forEach(function (p) {
          var o = document.createElement('option');
          o.value = p.contextId;
          o.textContent = (p.displayName || p.label || p.contextId) + (p.contextId === active ? '（当前）' : '');
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
    setMsg('切换中…', false);
    fetch(PREFER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId: contextId })
    })
      .then(function (r) {
        if (r.ok) { setMsg('已切换，正在跳转…', false); location.href = '/'; return; }
        return r.json().catch(function () { return {}; }).then(function (j) {
          var detail = (j && j.error) || ('HTTP ' + r.status);
          var hint = (r.status === 401 || r.status === 403) ? '（需要 owner 权限：请用一键登录链接打开 WebUI 后再试）' : '';
          setMsg('切换失败：' + detail + hint, true);
          btn.disabled = false;
        });
      })
      .catch(function (e) { setMsg('切换请求出错：' + String((e && e.message) || e), true); btn.disabled = false; });
  });
  load();
})();
</script>
</body>
</html>`;
}
