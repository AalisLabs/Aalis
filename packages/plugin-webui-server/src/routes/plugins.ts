import { isDeepStrictEqual } from 'node:util';
import type { UserIdentity } from '@aalis/api-authority';
import type { CommandService } from '@aalis/api-commands';
import { type HostConfig, isConfigSaveRefused } from '@aalis/api-host-config';
import type { PluginSourceService } from '@aalis/api-plugin-source';
import type { ToolService } from '@aalis/api-tools';
import type { WebUIService, WebuiActionHandler, WebuiPage } from '@aalis/api-webui';
import type { AppService, Logger, PluginManagerService, ServiceRef } from '@aalis/core';
import { parseInstanceId } from '@aalis/core';
import {
  CORE_CONFIG_SCHEMA,
  cloneConfigObject,
  defaultsFrom,
  removeExtraFields,
  validateConfig,
} from '@aalis/schema-config';
import type express from 'express';
import type { RouteGate } from '../gate.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 落盘被拒后运行态怎样与文件对齐：插件配置与新建的实例随配置文件热重载（文件里没有配置段的后缀实例会被卸载）；
 * 启停、实例删除与服务偏好只在重启时按文件登记
 */
const RECONCILE = {
  reload: '修好配置文件后会按文件内容重载',
  restart: '修好配置文件后，重启时以文件内容为准',
} as const;

/**
 * 管理动作改完运行态之后落盘；失败时回 `applied: true` 并返回 false：改动已在运行态生效、只是没写进文件，
 * 调用方别当成「没改成」去重试。宿主拒写（配置文件有尚未生效的外部修改）回 409，之后以文件为准对账；
 * 其它失败（权限、磁盘写满等）回 500，文件没变也不会触发重载，改动留在文档里，下一次成功保存时一并写入。
 */
export async function saveAfterApply(
  doc: Pick<HostConfig, 'save'>,
  res: express.Response,
  reconcile: keyof typeof RECONCILE,
): Promise<boolean> {
  try {
    await doc.save();
    return true;
  } catch (err) {
    if (isConfigSaveRefused(err)) {
      res.status(409).json({
        error: `已在运行态生效，但未写入配置文件（${errorMessage(err)}）；${RECONCILE[reconcile]}`,
        applied: true,
      });
    } else {
      res.status(500).json({
        error: `已在运行态生效，但写入配置文件失败（${errorMessage(err)}）；改动保留在文档里，下次保存成功时一并写入`,
        applied: true,
      });
    }
    return false;
  }
}

/** 插件管理 + 全局配置路由用到的能力 */
interface PluginRoutesCaps {
  app: ServiceRef<AppService>;
  plugins: ServiceRef<PluginManagerService>;
  /** 宿主的插件来源；打包宿主不提供，扫描路由随之报不可用 */
  source: Pick<ServiceRef<PluginSourceService>, 'current'>;
  /** 配置文档的读写与落盘（宿主提供；缺席时读写文档的路由返回 503） */
  hostConfig: Pick<ServiceRef<HostConfig>, 'current'>;
  tools: Pick<ServiceRef<ToolService>, 'current'>;
  commands: Pick<ServiceRef<CommandService>, 'current'>;
  /**
   * 取当前 webui-server 提供者（页面登记表的读取面）。本插件自己提供这个服务，
   * 写死引用就绕过了解析——第三方若以更高优先级接管 webui-server，页面列表该跟着走。
   */
  webui(): WebUIService | undefined;
  /** 裁剪 schema 外字段时点名 warn；测试可不传 */
  logger?: Logger;
}

/** 注册插件管理 + 全局配置相关 REST 路由 */
export function registerPluginRoutes(
  expressApp: express.Express,
  caps: PluginRoutesCaps,
  identify: (req: { headers: { cookie?: string } }) => UserIdentity | undefined,
  gate: RouteGate,
  getAction: (plugin: string, method: string) => WebuiActionHandler | undefined,
): void {
  const getApp = (): AppService | undefined => caps.app.current;
  const getPluginMgr = (): PluginManagerService | undefined => caps.plugins.current;
  /** 配置文档由宿主提供；没有时读写文档的路由一律 503，与扫描、市场路由的缺席口径一致 */
  const docOr503 = (res: express.Response): HostConfig | undefined => {
    const doc = caps.hostConfig.current;
    if (!doc) res.status(503).json({ error: '宿主未提供配置文档（host-config），无法读写配置' });
    return doc;
  };

  // 获取插件列表及状态
  expressApp.get('/api/plugins', gate(), (_req, res) => {
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.json({ plugins: [] });
      return;
    }
    // 反向索引：instanceId -> tools / commands（名字列表 + 聚合敏感能力）。
    // 生产登记的 pluginName 就是 contextId（= instanceId）；按 definition.name 索引
    // 会让 name:suffix 误挂主实例的工具。能力披露用聚合 capability。
    const toolsByPlugin = new Map<string, string[]>();
    const capsByPlugin = new Map<string, Set<string>>();
    const addCaps = (plugin: string, visibility?: string) => {
      if (visibility !== 'restricted') return;
      const set = capsByPlugin.get(plugin) ?? new Set<string>();
      set.add('visibility:restricted');
      capsByPlugin.set(plugin, set);
    };
    const tools = caps.tools.current?.getAll() ?? [];
    for (const t of tools) {
      const list = toolsByPlugin.get(t.pluginName) ?? [];
      list.push(t.name);
      toolsByPlugin.set(t.pluginName, list);
      addCaps(t.pluginName, t.visibility);
    }
    const commandsByPlugin = new Map<string, string[]>();
    const cmds = caps.commands.current?.getAll() ?? [];
    for (const c of cmds) {
      const owner = c.pluginName ?? 'unknown';
      const list = commandsByPlugin.get(owner) ?? [];
      list.push(c.name);
      commandsByPlugin.set(owner, list);
      addCaps(owner, c.visibility);
    }
    const plugins = pm.getStatus().map(p => {
      const entry = pm.getPlugin(p.instanceId);
      const schema = entry?.definition?.configSchema as Record<string, unknown> | undefined;
      // 列表给概览用：schema.secret 字段换成固定掩码。编辑器走 GET /api/plugins/:name/config，那条不脱敏。
      const config = maskSecretFields(cloneConfigObject((entry?.config ?? {}) as Record<string, unknown>), schema);
      return {
        name: p.name,
        instanceId: p.instanceId,
        displayName: p.displayName,
        state: p.state,
        provides: p.provides ?? [],
        // 完整能力声明含内置能力与 apply 别名；外部依赖闸与工具/指令可见性仍是各自独立的事实。
        uses: p.uses,
        requiredServices: p.requiredServices ?? [],
        optionalServices: p.optionalServices ?? [],
        capabilities: [...(capsByPlugin.get(p.instanceId) ?? [])],
        tools: toolsByPlugin.get(p.instanceId) ?? [],
        commands: commandsByPlugin.get(p.instanceId) ?? [],
        reusable: p.reusable ?? false,
        // extends / config / configSchema / defaultConfig 非内核状态摘要字段
        // （getStatus 只含内核事实）：从 entry.config / entry.definition 补齐给前端。
        extends: entry?.definition?.extends,
        config,
        configSchema: entry?.definition?.configSchema,
        defaultConfig: defaultsFrom(entry?.definition?.configSchema),
        error: p.error,
      };
    });
    res.json({ plugins });
  });

  // 获取可用的 WebUI 页面（由活跃插件经 webui-server 的绑定接口 registerPage 登记）
  expressApp.get('/api/pages', gate(), (_req, res) => {
    const app = getApp();
    const pm = getPluginMgr();
    if (!app || !pm) {
      res.json([]);
      return;
    }

    const webuiSvc = caps.webui();
    if (!webuiSvc) {
      res.json([]);
      return;
    }

    const displayNameByPlugin = new Map<string, string | undefined>();
    for (const p of pm.getStatus()) displayNameByPlugin.set(p.instanceId, p.displayName);

    const pages: (WebuiPage & { plugin: string; pluginDisplayName?: string })[] = [];
    for (const page of webuiSvc.getPages()) {
      pages.push({ ...page, plugin: page.pluginName, pluginDisplayName: displayNameByPlugin.get(page.pluginName) });
    }
    pages.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    res.json(pages);
  });

  // 通用声明式页面操作：调用插件经 webuiServer.registerAction 登记的处理函数
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

    const handler = getAction(pluginName, method);
    if (!handler) {
      res.status(404).json({ error: `处理器 ${method} 不存在` });
      return;
    }

    // ===== owner 闸 + 调用者身份（单 owner 终态）=====
    // 单 token ⟺ webui:console ⟺ owner；auth.middleware 已校 token，这里复核身份并把
    // caller 传给 action。各 action 自身对敏感操作再做 owner 自检（如 setUserTier）。
    // 多账户的 action: 能力委托（per-user grant/deny / actionsMeta 可见性）已剥离。
    const caller = identify(req);
    if (!caller) {
      res.status(403).json({ error: `操作 ${pluginName}/${method} 需要 owner 权限` });
      return;
    }

    try {
      res.json({ ok: true, data: await handler(args, caller) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 获取当前全局配置
  expressApp.get('/api/config', gate(), (_req, res) => {
    const doc = docOr503(res);
    if (!doc) return;
    res.json({ ...doc.getAll(), _schema: CORE_CONFIG_SCHEMA });
  });

  // 更新全局配置字段
  expressApp.put('/api/config', gate(), async (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: '请求体必须是对象' });
      return;
    }

    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const doc = docOr503(res);
    if (!doc) return;

    // 可改的只有 CORE_CONFIG_SCHEMA 的键。内置前端（buildDraftFromSchema）会把 GET 到的整份配置连同
    // _schema 原样回传，其中 plugins 等还可能是过期快照（插件配置页保存后不刷新全局 config），
    // 所以不能按键报错：其余键一律不应用，但把真有改动的点名回给调用方——不静默吞掉却回复「已保存」。
    const allowed = Object.keys(CORE_CONFIG_SCHEMA);
    const current = doc.getAll() as Record<string, unknown>;
    const differs = (k: string) => !isDeepStrictEqual(updates[k], current[k]);
    const ignored = Object.keys(updates).filter(k => k !== '_schema' && !allowed.includes(k) && differs(k));
    const changed = allowed.filter(k => k in updates && differs(k));
    // 与插件配置路径同一把尺子：类型不符的值（如 name 传数字）不落盘。select 的取值范围 validateConfig
    // 刻意不管（它看不见宿主属性 allowCustom），核心字段没有 allowCustom，在这里按 options 补校验。
    const picked = Object.fromEntries(changed.map(k => [k, updates[k]]));
    const invalid = validateConfig(CORE_CONFIG_SCHEMA, picked).map(i => `${i.path}: ${i.message}`);
    for (const k of changed) {
      const field = CORE_CONFIG_SCHEMA[k] as { type?: string; options?: Array<{ value: unknown }> };
      if (field.type === 'select' && field.options && !field.options.some(o => o.value === updates[k])) {
        invalid.push(`${k}: 取值不在可选范围`);
      }
    }
    if (invalid.length > 0) {
      res.status(400).json({ error: invalid.join('; ') });
      return;
    }
    const previous = Object.fromEntries(changed.map(k => [k, current[k]]));
    for (const key of changed) doc.set(key, updates[key]);
    // logLevel 只在启动时读取，改了才重启；name 由 /api/status 每次实时读文档，保存即生效
    const restartNeeded = changed.includes('logLevel');
    const note = ignored.length > 0 ? `（已忽略不可修改的字段: ${ignored.join(', ')}）` : '';

    try {
      await doc.save();
      if (restartNeeded) {
        res.json({ ok: true, message: `全局配置已更新，正在重启应用以生效…${note}`, restart: true, ignored });
        app.restart();
      } else {
        res.json({ ok: true, message: `全局配置已更新并保存${note}`, ignored });
      }
    } catch (err) {
      // 拒写与写入失败都撤回文档里的改动，免得下一次任意保存把这次没存下的修改写进文件。
      // logLevel 要重启才生效，name 由状态接口读文档：撤回后两者都回到修改前，运行态不留改动
      for (const key of changed) doc.set(key, previous[key]);
      res
        .status(isConfigSaveRefused(err) ? 409 : 500)
        .json({ error: `未写入配置文件（${errorMessage(err)}），本次修改已撤回` });
    }
  });

  // 获取单个插件的原始配置（未脱敏，给编辑器回写用）。
  // 列表 GET /api/plugins 已把 schema.secret 换成固定掩码；本接口必须是原文，否则保存会把掩码写回。
  expressApp.get('/api/plugins/:name/config', gate(), (req, res) => {
    const pluginName = req.params.name;
    const doc = docOr503(res);
    if (!doc) return;
    try {
      const pluginConfig = doc.getPluginConfig(pluginName);
      res.json({ name: pluginName, config: pluginConfig });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  // 更新插件配置
  expressApp.put('/api/plugins/:name/config', gate(), async (req, res) => {
    const pluginName = req.params.name;
    const newConfig = req.body?.config;
    if (!newConfig || typeof newConfig !== 'object') {
      res.status(400).json({ error: 'config 字段必须是对象' });
      return;
    }

    const pm = getPluginMgr();
    if (!pm) {
      res.status(500).json({ error: '插件管理服务不可用' });
      return;
    }
    const doc = docOr503(res);
    if (!doc) return;

    // 补默认值再交给 updateConfig：后者是**整体替换**语义（core 的 orchestration/plugin.ts 里
    // entry.config = newConfig 直接顶掉）。不补的话，PUT 一个部分对象就会把未列出的
    // 字段从内存态和 yaml 里一起抹掉。默认值从 configSchema 派生（唯一声明来源）。
    const entry = pm.getPlugin(pluginName);
    const schema = entry?.definition?.configSchema;
    const defaults = defaultsFrom(schema);
    // 基线取「默认值叠已存值」而非裸默认值：defaultsFrom 只收录声明了 default 的键，
    // 而 apiKey / accessToken 这类 secret 多数**没有** default（deepseek、embedding-openai、
    // llm-openai、serper、onebot 皆是）。用裸 defaults 打底时，请求里没带 apiKey 就等于
    // merged 里根本没有这个键，整体替换后用户的密钥从内存态与 yaml 一起消失。
    // 叠上已存值后语义才是真正的部分更新：没提交的字段保持原样，要清空得显式传空串。
    let docConfig: Record<string, unknown>;
    let stored: Record<string, unknown>;
    let merged: Record<string, unknown>;
    const ignored: string[] = [];
    const removed: string[] = [];
    try {
      docConfig = doc.getPluginConfig(pluginName);
      // 先铺文档里的原配置、缺的默认键追加到末尾：写回时保留配置文件里原有的键序
      stored = { ...docConfig };
      for (const [key, value] of Object.entries(defaults)) {
        if (!Object.hasOwn(stored, key)) stored[key] = value;
      }
      const submitted = newConfig as Record<string, unknown>;
      merged = { ...stored, ...submitted };
      // 与 runtime config-sync 同一政策：有 schema 就裁掉未知键并 warn，避免 WebUI 把
      // 手滑字段写进 stored，而 YAML watch 路径却会裁掉——两边政策必须一致。
      // 被裁的字段按来源回给调用方，不静默吞掉却回复「已更新」：本次提交里的记 ignored（与 PUT /api/config
      // 同一口径）；文档里原有、本次没提交的不是用户这次写的，随整份写回从配置文件删掉，记 removed
      if (schema && Object.keys(schema).length > 0) {
        const shape = schema as Record<string, unknown>;
        for (const [key, value] of Object.entries(merged)) {
          removeExtraFields({ [key]: value }, shape, Object.hasOwn(submitted, key) ? ignored : removed);
        }
        merged = removeExtraFields(merged, shape);
        if (ignored.length + removed.length > 0) {
          caps.logger?.warn(`配置同步：${pluginName} 裁掉 schema 外字段 [${[...ignored, ...removed].join(', ')}]`);
        }
      }
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    const note =
      (ignored.length > 0 ? `（已忽略未声明的配置字段: ${ignored.join(', ')}）` : '') +
      (removed.length > 0 ? `（已从配置文件移除未声明的字段: ${removed.join(', ')}）` : '');

    // 保存前校验，拦新不追旧：只拒绝本次编辑**新引入**的 invalid（配错了）。
    // 存量问题放行——否则带着历史脏值（或 schema 表达不了的多态字段，如 mcp-client
    // 的 args 数组形态）的插件会在 WebUI 永久存不了任何字段；启动侧 config-sync
    // 对它们已有告警。missing（没配全）也放行：半成品配置是启用插件配到一半的
    // 正常中间态。禁用插件的 PUT 走下方 updateConfig 失败分支，在那里区分
    // 「已禁用」（409，提示先启用）与「真不存在」（404）。
    const preExisting = new Set(validateConfig(schema, stored).map(i => `${i.path}|${i.message}`));
    const issues = validateConfig(schema, merged).filter(
      i => i.kind === 'invalid' && !preExisting.has(`${i.path}|${i.message}`),
    );
    if (issues.length > 0) {
      res.status(400).json({
        error: `配置校验未通过：${issues.map(i => `${i.path}: ${i.message}`).join('；')}`,
        issues,
      });
      return;
    }

    // 运行态与文档都已是这份配置：不重建插件（updateConfig 即 bounce，会连带重启依赖它所提供服务的下游）。
    // 仍照常落盘：上一次保存可能写文件失败（500），文档与运行态已是新配置而文件没变，原样重试要能补写；
    // 自写回不会触发 watch 重载。只认 active：error 态插件靠原样保存来重试激活，照旧走 updateConfig
    if (entry?.state === 'active' && isDeepStrictEqual(merged, entry.config) && isDeepStrictEqual(merged, docConfig)) {
      if (!(await saveAfterApply(doc, res, 'reload'))) return;
      res.json({ ok: true, message: `插件 ${pluginName} 配置无改动，已写回配置文件${note}`, ignored, removed });
      return;
    }

    let success: boolean;
    try {
      success = await pm.updateConfig(pluginName, merged);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    if (success) {
      // 管理动作只改运行态；跨重启保留要本路由写文档并落盘
      doc.setPluginConfig(pluginName, merged);
      if (!(await saveAfterApply(doc, res, 'reload'))) return;
      res.json({ ok: true, message: `插件 ${pluginName} 配置已更新${note}`, ignored, removed });
    } else if (pm.getPlugin(pluginName)?.state === 'disabled') {
      // 插件被禁用时这里也会走到，但「不存在」会把用户引向错误方向——区分「禁用」与「真不存在」并给出下一步。
      res.status(409).json({ error: `插件 ${pluginName} 已禁用，配置未写入——先启用插件再修改配置` });
    } else {
      res.status(404).json({ error: `插件 ${pluginName} 不存在` });
    }
  });

  // 启用插件
  expressApp.post('/api/plugins/:name/enable', gate(), async (req, res) => {
    const pluginName = req.params.name;
    const pm = getPluginMgr();
    if (!pm) {
      res.status(500).json({ error: '插件管理服务不可用' });
      return;
    }
    const doc = docOr503(res);
    if (!doc) return;
    let success: boolean;
    try {
      success = await pm.enable(pluginName);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    if (success) {
      doc.setPluginEnabled(pluginName, true);
      if (!(await saveAfterApply(doc, res, 'restart'))) return;
      res.json({ ok: true, message: `插件 ${pluginName} 已启用` });
    } else {
      res.status(404).json({ error: `插件 ${pluginName} 不存在` });
    }
  });

  // 禁用插件
  expressApp.post('/api/plugins/:name/disable', gate(), async (req, res) => {
    const pluginName = req.params.name;
    const pm = getPluginMgr();
    if (!pm) {
      res.status(500).json({ error: '插件管理服务不可用' });
      return;
    }
    const doc = docOr503(res);
    if (!doc) return;
    let success: boolean;
    try {
      success = await pm.disable(pluginName);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    if (success) {
      doc.setPluginEnabled(pluginName, false);
      if (!(await saveAfterApply(doc, res, 'restart'))) return;
      res.json({ ok: true, message: `插件 ${pluginName} 已禁用` });
    } else {
      res.status(404).json({ error: `插件 ${pluginName} 不在注册表或已处于终态，无法禁用` });
    }
  });

  // 经宿主 plugin-source 重新扫描并加载新插件
  expressApp.post('/api/plugins/scan', gate(), async (_req, res) => {
    const source = caps.source.current;
    if (!source) {
      res.status(503).json({ error: '宿主未提供插件来源，无法扫描' });
      return;
    }
    try {
      const loaded = await source.rescan();
      res.json({ ok: true, loaded, message: loaded.length > 0 ? `新加载 ${loaded.length} 个插件` : '无新插件' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 创建插件多实例
  expressApp.post('/api/plugins/:name/instances', gate(), async (req, res) => {
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
    const pm = getPluginMgr();
    if (!pm) {
      res.status(500).json({ error: '插件管理服务不可用' });
      return;
    }
    const doc = docOr503(res);
    if (!doc) return;
    // 实例创建编排（配置文件编排属管理面,内核只出 register 机制）：
    // 查同名 module → reusable/查重校验 → 合并默认配置写入 → register 激活。
    const sourceModule = pm
      .getStatus()
      .map(p => pm.getPlugin(p.instanceId)?.definition)
      .find(m => m?.name === moduleName);
    if (!sourceModule) {
      res.status(400).json({ error: `无法创建实例：模块 "${moduleName}" 未找到` });
      return;
    }
    if (!sourceModule.reusable) {
      res.status(400).json({ error: `无法创建实例：模块 "${moduleName}" 未声明 reusable` });
      return;
    }
    const instanceId = `${moduleName}:${suffix}`;
    if (pm.getPlugin(instanceId)) {
      res.status(400).json({ error: `无法创建实例："${instanceId}" 已存在` });
      return;
    }
    const mergedConfig = { ...defaultsFrom(sourceModule.configSchema), ...(config as Record<string, unknown>) };
    try {
      doc.setPluginConfig(instanceId, mergedConfig);
      // 文档里残留的禁用标记照旧生效：以禁用态登记
      await pm.register(sourceModule, mergedConfig, instanceId, { disabled: doc.isPluginDisabled(instanceId) });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    if (!(await saveAfterApply(doc, res, 'reload'))) return;
    res.json({ ok: true, instanceId, message: `已创建实例 ${instanceId}` });
  });

  // 删除插件多实例
  expressApp.delete('/api/plugins/:instanceId/instance', gate(), async (req, res) => {
    const instanceId = req.params.instanceId;
    const pm = getPluginMgr();
    if (!pm) {
      res.status(500).json({ error: '插件管理服务不可用' });
      return;
    }
    const doc = docOr503(res);
    if (!doc) return;
    // 实例删除编排：主实例保护 → unload（内部含级联重算）→ 移除配置条目。
    const { suffix } = parseInstanceId(instanceId);
    if (!suffix || !pm.getPlugin(instanceId)) {
      res.status(400).json({ error: `无法删除（实例不存在或不允许删除主实例）` });
      return;
    }
    try {
      await pm.unload(instanceId);
      doc.removePluginConfig(instanceId);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    if (!(await saveAfterApply(doc, res, 'restart'))) return;
    res.json({ ok: true, message: `已删除实例 ${instanceId}` });
  });

  // 保存配置到磁盘：与其它落盘路由同一口径，宿主拒写回 409、其它失败回 500
  expressApp.post('/api/config/save', gate(), async (_req, res) => {
    const doc = docOr503(res);
    if (!doc) return;
    try {
      await doc.save();
      res.json({ ok: true, message: '配置已保存到磁盘' });
    } catch (err) {
      res.status(isConfigSaveRefused(err) ? 409 : 500).json({ error: errorMessage(err) });
    }
  });
}

/** 列表 payload 用的固定掩码。与 PUT 响应「不回显密钥」同一政策：概览面看不到明文。 */
const SECRET_MASK = '••••••';

/**
 * 把 schema.secret === true 的字段换成固定掩码。入参须已是拷贝——就地改，避免写穿现场 config。
 * 分组递归；数组元素若是对象则按 items 再走一遍。缺席的键不补掩码。
 */
function maskSecretFields(
  config: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return config;
  for (const [key, raw] of Object.entries(schema)) {
    if (!raw || typeof raw !== 'object') continue;
    const def = raw as Record<string, unknown>;
    if (def.secret === true) {
      if (Object.hasOwn(config, key)) config[key] = SECRET_MASK;
      continue;
    }
    const nested = config[key];
    if (
      def.fields &&
      typeof def.fields === 'object' &&
      nested &&
      typeof nested === 'object' &&
      !Array.isArray(nested)
    ) {
      maskSecretFields(nested as Record<string, unknown>, def.fields as Record<string, unknown>);
      continue;
    }
    if (def.type === 'array' && Array.isArray(nested) && def.items && typeof def.items === 'object') {
      for (const item of nested) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          maskSecretFields(item as Record<string, unknown>, def.items as Record<string, unknown>);
        }
      }
    }
  }
  return config;
}
