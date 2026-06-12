import type { AppService, Context, PluginManagerService } from '@aalis/core';
import { CORE_CONFIG_SCHEMA } from '@aalis/core';
import type { AuthorityService, UserIdentity } from '@aalis/plugin-authority-api';
import type { CommandService } from '@aalis/plugin-commands-api';
import type { PackageManagerService } from '@aalis/plugin-package-manager';
import type { ToolService } from '@aalis/plugin-tools-api';
import type { WebUIService, WebuiPage } from '@aalis/plugin-webui-api';
import type express from 'express';

/** 注册插件管理 + 全局配置相关 REST 路由 */
export function registerPluginRoutes(
  expressApp: express.Express,
  ctx: Context,
  getApp: () => AppService | undefined,
  getPluginMgr: () => PluginManagerService | undefined,
): void {
  // 获取插件列表及状态
  expressApp.get('/api/plugins', (_req, res) => {
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.json({ plugins: [] });
      return;
    }
    // 反向索引：pluginName -> tools / commands。
    // 方便 UI 搜索框命中工具名/指令名时定位到注册插件。
    const toolsByPlugin = new Map<string, string[]>();
    const tools = ctx.getService<ToolService>('tools')?.getAll() ?? [];
    for (const t of tools) {
      const list = toolsByPlugin.get(t.pluginName) ?? [];
      list.push(t.name);
      toolsByPlugin.set(t.pluginName, list);
    }
    const commandsByPlugin = new Map<string, string[]>();
    const cmds = ctx.getService<CommandService>('commands')?.getAll() ?? [];
    for (const c of cmds) {
      const owner = c.pluginName ?? 'unknown';
      const list = commandsByPlugin.get(owner) ?? [];
      list.push(c.name);
      commandsByPlugin.set(owner, list);
    }
    const plugins = pm.getStatus().map(p => ({
      name: p.name,
      instanceId: p.instanceId,
      displayName: p.displayName,
      state: p.state,
      provides: p.provides ?? [],
      tools: toolsByPlugin.get(p.name) ?? [],
      commands: commandsByPlugin.get(p.name) ?? [],
      core: p.core ?? false,
      reusable: p.reusable ?? false,
      config: p.config,
      configSchema: p.configSchema,
      defaultConfig: p.defaultConfig,
      error: p.error,
    }));
    res.json({ plugins });
  });

  // 获取可用的 WebUI 页面（由活跃插件通过 useWebuiService.registerPage 注册）
  expressApp.get('/api/pages', (_req, res) => {
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.json([]);
      return;
    }

    const webuiSvc = ctx.getService<WebUIService>('webui-server');
    if (!webuiSvc) {
      res.json([]);
      return;
    }

    const displayNameByPlugin = new Map<string, string | undefined>();
    for (const p of pm.getStatus()) displayNameByPlugin.set(p.name, p.displayName);

    const pages: (WebuiPage & { plugin: string; pluginDisplayName?: string })[] = [];
    for (const page of webuiSvc.getPages()) {
      pages.push({ ...page, plugin: page.pluginName, pluginDisplayName: displayNameByPlugin.get(page.pluginName) });
    }
    pages.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    res.json(pages);
  });

  // 通用声明式页面操作：调用插件的 actions
  expressApp.post('/api/page-action/:plugin/:method', async (req, res) => {
    const { plugin: pluginName, method } = req.params;
    const args: Record<string, unknown> = req.body ?? {};

    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }

    const entry = pm.getPlugin(pluginName);
    if (!entry || entry.state !== 'active') {
      res.status(404).json({ error: `插件 ${pluginName} 不存在或未激活` });
      return;
    }

    const handler = entry.module.actions?.[method];
    if (typeof handler !== 'function') {
      res.status(404).json({ error: `处理器 ${method} 不存在` });
      return;
    }

    if (!entry.context) {
      res.status(500).json({ error: `插件 ${pluginName} 上下文不可用` });
      return;
    }

    // ===== 权限闸门 + 调用者身份 =====
    // WebUI 暂无登录，调用者固定解析为 webui:console（owner 级）；登录功能落地后
    // 改为从会话解析真实用户，本闸门即按账户等级生效。
    // 未声明 actionsMeta 的 action 默认要求 owner 等级（默认拒绝），插件需显式
    // 声明才能降低门槛。capability `action:<plugin>:<method>` 走 authorize 统一闸
    // （支持 per-user grant/deny）。authority 服务缺席时放行（与 tools/commands
    // 守卫缺席时一致）。
    const caller: UserIdentity = { platform: 'webui', userId: 'console' };
    const authority = ctx.getService<AuthorityService>('authority');
    if (authority) {
      const required = entry.module.actionsMeta?.[method]?.authority ?? ctx.config.get('ownerAuthority') ?? 5;
      const denied = authority.authorize(caller, {
        capabilities: [`action:${pluginName}:${method}`],
        declaredAuthority: required,
      });
      if (denied) {
        res.status(403).json({ error: `操作 ${pluginName}/${method} 被拒: ${denied}` });
        return;
      }
    }

    try {
      const result = await handler(entry.context, args, caller);
      res.json({ ok: true, data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 获取当前全局配置
  expressApp.get('/api/config', (_req, res) => {
    const allConfig = ctx.config.getAll();
    res.json({ ...allConfig, _schema: CORE_CONFIG_SCHEMA });
  });

  // 更新全局配置字段
  expressApp.put('/api/config', (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: '请求体必须是对象' });
      return;
    }

    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }

    // 只允许更新安全的顶级字段
    const allowed = ['name', 'logLevel'] as const;
    for (const key of allowed) {
      if (key in updates) {
        ctx.config.set(key, updates[key]);
      }
    }

    // 检查是否有需要重启才能生效的字段
    const restartNeeded = ['name', 'persona', 'logLevel'].some(k => k in updates);

    try {
      app.saveConfig();
      if (restartNeeded) {
        res.json({ ok: true, message: '全局配置已更新，正在重启应用以生效…', restart: true });
        app.restart();
      } else {
        res.json({ ok: true, message: '全局配置已更新并保存' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 获取单个插件的原始配置（未脱敏，给编辑器用）
  expressApp.get('/api/plugins/:name/config', (req, res) => {
    const pluginName = req.params.name;
    const pluginConfig = ctx.config.getPluginConfig(pluginName);
    res.json({ name: pluginName, config: pluginConfig });
  });

  // 更新插件配置
  expressApp.put('/api/plugins/:name/config', async (req, res) => {
    const pluginName = req.params.name;
    const newConfig = req.body?.config;
    if (!newConfig || typeof newConfig !== 'object') {
      res.status(400).json({ error: 'config 字段必须是对象' });
      return;
    }

    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }

    const success = await pm.updatePluginConfig(pluginName, newConfig as Record<string, unknown>);
    if (success) {
      app.saveConfig();
      res.json({ ok: true, message: `插件 ${pluginName} 配置已更新` });
    } else {
      res.status(404).json({ error: `插件 ${pluginName} 不存在` });
    }
  });

  // 启用插件
  expressApp.post('/api/plugins/:name/enable', async (req, res) => {
    const pluginName = req.params.name;
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const success = await pm.enablePlugin(pluginName);
    if (success) {
      app.saveConfig();
      res.json({ ok: true, message: `插件 ${pluginName} 已启用` });
    } else {
      res.status(404).json({ error: `插件 ${pluginName} 不存在` });
    }
  });

  // 禁用插件
  expressApp.post('/api/plugins/:name/disable', async (req, res) => {
    const pluginName = req.params.name;
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const success = await pm.disablePlugin(pluginName);
    if (success) {
      app.saveConfig();
      res.json({ ok: true, message: `插件 ${pluginName} 已禁用` });
    } else {
      res.status(400).json({ error: `核心插件不能被禁用` });
    }
  });

  // 重新扫描 packages/ 并加载新插件
  expressApp.post('/api/plugins/scan', async (_req, res) => {
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    try {
      const loaded = await app.rescanPlugins();
      res.json({ ok: true, loaded, message: loaded.length > 0 ? `新加载 ${loaded.length} 个插件` : '无新插件' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 安装插件（从 npm 下载到 packages/ 并加载）
  expressApp.post('/api/plugins/install', async (req, res) => {
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const npmPkg = req.body?.name;
    if (!npmPkg || typeof npmPkg !== 'string') {
      res.status(400).json({ error: 'name 字段必须是 npm 包名字符串' });
      return;
    }
    if (!/^(@[a-z0-9\-_.]+\/)?[a-z0-9\-_.]+$/i.test(npmPkg)) {
      res.status(400).json({ error: '非法包名' });
      return;
    }
    try {
      const pkgMgr = ctx.getService<PackageManagerService>('package-manager');
      if (!pkgMgr) {
        res.status(503).json({ error: 'package-manager 服务未启用，无法安装插件' });
        return;
      }
      const result = await pkgMgr.install(npmPkg);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 卸载插件
  expressApp.post('/api/plugins/:name/uninstall', async (req, res) => {
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const pluginName = req.params.name;
    try {
      const pkgMgr = ctx.getService<PackageManagerService>('package-manager');
      if (!pkgMgr) {
        res.status(503).json({ error: 'package-manager 服务未启用，无法卸载插件' });
        return;
      }
      const result = await pkgMgr.uninstall(pluginName);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 创建插件多实例
  expressApp.post('/api/plugins/:name/instances', async (req, res) => {
    const moduleName = req.params.name;
    const suffix = req.body?.suffix;
    const config = req.body?.config ?? {};
    if (!suffix || typeof suffix !== 'string') {
      res.status(400).json({ error: 'suffix 必须是非空字符串' });
      return;
    }
    if (!/^[\w-]+$/.test(suffix)) {
      res.status(400).json({ error: 'suffix 只能包含字母、数字、下划线和连字符' });
      return;
    }
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const instanceId = await pm.createInstance(moduleName, suffix, config as Record<string, unknown>);
    if (instanceId) {
      app.saveConfig();
      res.json({ ok: true, instanceId, message: `已创建实例 ${instanceId}` });
    } else {
      res.status(400).json({ error: `无法创建实例（模块不存在、未声明 reusable 或实例已存在）` });
    }
  });

  // 删除插件多实例
  expressApp.delete('/api/plugins/:instanceId/instance', async (req, res) => {
    const instanceId = req.params.instanceId;
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const ok = await pm.removeInstance(instanceId);
    if (ok) {
      app.saveConfig();
      res.json({ ok: true, message: `已删除实例 ${instanceId}` });
    } else {
      res.status(400).json({ error: `无法删除（实例不存在或不允许删除主实例）` });
    }
  });

  // 保存配置到磁盘
  expressApp.post('/api/config/save', (_req, res) => {
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    try {
      app.saveConfig();
      res.json({ ok: true, message: '配置已保存到磁盘' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });
}
