import { isDeepStrictEqual } from 'node:util';
import type { UserIdentity } from '@aalis/api-authority';
import type { CommandService } from '@aalis/api-commands';
import { type HostConfig, isConfigSaveRefused } from '@aalis/api-host-config';
import type { PluginSourceService } from '@aalis/api-plugin-source';
import type { ToolService } from '@aalis/api-tools';
import type { WebUIService, WebuiActionHandler, WebuiPage } from '@aalis/api-webui';
import type { AppService, Logger, PluginManagerService, PluginState, ServiceRef } from '@aalis/core';
import { parseInstanceId } from '@aalis/core';
import {
  CORE_CONFIG_SCHEMA,
  type ConfigSchema,
  deepMergeDefaults,
  defaultsFrom,
  parseConfig,
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
 * 启停与服务偏好只在重启时按文件登记
 */
const RECONCILE = {
  reload: '修好配置文件后会按文件内容重载',
  restart: '修好配置文件后，重启时以文件内容为准',
} as const;

/**
 * 管理动作改完运行态之后落盘；失败时回 `applied: true` 并返回 false：改动已在运行态生效、只是没写进文件，
 * 调用方别当成「没改成」去重试。宿主拒写（配置文件有尚未生效的外部修改）回 409，之后以文件为准对账；
 * 其它失败（权限、磁盘写满等）回 500，文件没变也不会触发重载，改动留在文档里，下一次成功保存时一并写入。
 * `outcome` 是动作之后插件没有落在预期状态的说明（如激活失败转 error、仍在激活、保持禁用）：落盘也失败时放在回执开头，
 * 两件事一并说明。
 */
export async function saveAfterApply(
  doc: Pick<HostConfig, 'save'>,
  res: express.Response,
  reconcile: keyof typeof RECONCILE,
  outcome?: string,
): Promise<boolean> {
  try {
    await doc.save();
    return true;
  } catch (err) {
    const lead = outcome ? `${outcome}；` : '';
    if (isConfigSaveRefused(err)) {
      res.status(409).json({
        error: `${lead}已在运行态生效，但未写入配置文件（${errorMessage(err)}）；${RECONCILE[reconcile]}`,
        applied: true,
      });
    } else {
      res.status(500).json({
        error: `${lead}已在运行态生效，但写入配置文件失败（${errorMessage(err)}）；改动保留在文档里，下次保存成功时一并写入`,
        applied: true,
      });
    }
    return false;
  }
}

/**
 * 管理动作受理后等重算落定，再读实例状态写回执：动作撞上在飞的重算时只排队、立即返回，立即读到的还是 pending，
 * 之后的激活失败就漏报了。idle 不等转入后台的慢激活：重算对单个激活至多等到慢激活阈值。
 */
async function settledEntry(pm: PluginManagerService, instanceId: string) {
  await pm.idle();
  return pm.getPlugin(instanceId);
}

/** 落定后既没激活也没失败的说明：慢激活转入后台仍在进行，或在等 required 依赖满足；其余状态由各路由自己说明 */
function notYetActive(state: PluginState | undefined): string | undefined {
  if (state === 'activating') return '仍在激活（超过慢激活阈值，已转入后台），结果以插件列表为准';
  if (state === 'pending') return '尚未激活，正在等待 required 依赖满足';
  return undefined;
}

/**
 * 管理动作返回 false 时的回执。条目还在注册表里，说明是停机中或正在卸载拒绝了这次操作，回 409；
 * 只有条目确实不存在才回 404。两种情况都没有写配置文档。
 */
function refuse(pm: PluginManagerService, res: express.Response, instanceId: string, action: string): void {
  if (pm.getPlugin(instanceId)) {
    res.status(409).json({ error: `插件 ${instanceId} 当前不接受${action}（停机中或正在卸载），配置未更改` });
  } else {
    res.status(404).json({ error: `插件 ${instanceId} 不存在` });
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
  /** 裁剪 schema 外字段时点名 warn，保存全局配置后重启失败时记 error；测试可不传 */
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

  /**
   * 把提交的插件配置合进基线（改配置时是配置文档里的原配置，建实例时是空对象），改配置与建实例同一套：
   * 提交里的顶层键整键替换基线的同名键（分组、数组整块替换），没提交的保持原值；值为 null 的顶层键视为删除，
   * 有默认值的回到默认值、没有的不写（前端清空数字、llm-ref 选「继承默认」时发 null，JSON 丢掉的键只是没提交）。
   * 之后按 schema 默认值深合并补齐缺的键，只写了半块的分组也补齐其余默认子键。基线的键在前、缺的默认键追加到末尾，
   * 写回时保留配置文件里原有的键序。
   * 宿主裁剪且有 schema 时再裁掉未知键并 warn（与宿主的配置同步同一政策，host-config 的 trimUnknownFields）：
   * 本次提交里的记 ignored，基线里原有、本次没提交的记 removed，由调用方回给请求方，不静默吞掉却回复成功
   */
  const mergeSubmittedConfig = (
    doc: HostConfig,
    instanceId: string,
    schema: ConfigSchema | undefined,
    base: Record<string, unknown>,
    submitted: Record<string, unknown>,
  ): { merged: Record<string, unknown>; ignored: string[]; removed: string[] } => {
    const defaults = defaultsFrom(schema);
    const replaced: Record<string, unknown> = { ...base, ...submitted };
    for (const [key, value] of Object.entries(submitted)) {
      if (value !== null) continue;
      if (Object.hasOwn(defaults, key)) replaced[key] = defaults[key];
      else delete replaced[key];
    }
    let merged = deepMergeDefaults(defaults, replaced);
    const ignored: string[] = [];
    const removed: string[] = [];
    if (doc.trimUnknownFields !== false && schema && Object.keys(schema).length > 0) {
      const shape = schema as Record<string, unknown>;
      for (const [key, value] of Object.entries(merged)) {
        removeExtraFields({ [key]: value }, shape, Object.hasOwn(submitted, key) ? ignored : removed);
      }
      merged = removeExtraFields(merged, shape);
      if (ignored.length + removed.length > 0) {
        caps.logger?.warn(`配置同步：${instanceId} 裁掉 schema 外字段 [${[...ignored, ...removed].join(', ')}]`);
      }
    }
    return { merged, ignored, removed };
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
      return {
        name: p.name,
        instanceId: p.instanceId,
        displayName: p.displayName,
        state: p.state,
        slow: p.slow,
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
        // 配置按原值给出：前端据它建编辑草稿、整份保存，secret 字段只在显示时遮蔽
        extends: entry?.definition?.extends,
        config: entry?.config ?? {},
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
    const defaultOf = (k: string) => (CORE_CONFIG_SCHEMA[k] as { default?: unknown } | undefined)?.default;
    // 文档里没写的核心键按 schema 默认值比较：内置前端把默认值回填进草稿后整份回传，不能据此判成改动（否则只改
    // 名字也会把默认值写进文件并触发重启）
    const currentOf = (k: string) => current[k] ?? defaultOf(k);
    const differs = (k: string) => !isDeepStrictEqual(updates[k], currentOf(k));
    // 核心键提交 null 表示清空（前端清空数字框时发 null）：回到默认值，并从文档里删掉这个键，不把默认值写死进文件
    const submittedOf = (k: string) => (updates[k] === null ? defaultOf(k) : updates[k]);
    const ignored = Object.keys(updates).filter(k => k !== '_schema' && !allowed.includes(k) && differs(k));
    const changed = allowed.filter(k => k in updates && !isDeepStrictEqual(submittedOf(k), currentOf(k)));
    // 与插件配置路径同一把尺子：类型不符、越界或不在选项里的值（如 logLevel 传 nope）不落盘。
    const picked = Object.fromEntries(changed.map(k => [k, submittedOf(k)]));
    const invalid = validateConfig(CORE_CONFIG_SCHEMA, picked).map(i => `${i.path}: ${i.message}`);
    if (invalid.length > 0) {
      res.status(400).json({ error: invalid.join('; ') });
      return;
    }
    // 写进文档的是按词汇换算后的值（加了引号的数字转成数字、写成数字的名称转成字符串）：runtime 启动时
    // 直接读这几个键，不经 parseConfig
    const values = parseConfig(CORE_CONFIG_SCHEMA, picked);
    const previous = Object.fromEntries(changed.map(k => [k, current[k]]));
    // 提交 null 的键置为 undefined，写文件时省略
    for (const key of changed) doc.set(key, updates[key] === null ? undefined : values[key]);
    // logLevel 与 slowThresholdMs 只在启动时读取，改了才重启；name 由 /api/status 每次实时读文档（appName），保存即生效。
    // 装有人设时聊天显示人设名，应用名称只在仪表盘上看得到
    const restartNeeded = changed.some(k => k === 'logLevel' || k === 'slowThresholdMs');
    const note = ignored.length > 0 ? `（已忽略不可修改的字段: ${ignored.join(', ')}）` : '';

    try {
      await doc.save();
    } catch (err) {
      // 拒写与写入失败都撤回文档里的改动，免得下一次任意保存把这次没存下的修改写进文件。
      // logLevel / slowThresholdMs 要重启才生效，name 由状态接口读文档：撤回后都回到修改前，运行态不留改动
      for (const key of changed) doc.set(key, previous[key]);
      res
        .status(isConfigSaveRefused(err) ? 409 : 500)
        .json({ error: `未写入配置文件（${errorMessage(err)}），本次修改已撤回` });
      return;
    }
    if (!restartNeeded) {
      res.json({ ok: true, message: `全局配置已更新并保存${note}`, ignored });
      return;
    }
    // 先发起重启再回复：宿主没注入重启策略时 restart() 同步抛错，据此回 restart:false，前端才不会进入等待重连
    // 却永远等不到。发起之后的停机是异步的（core 先广播 app:restarting，何时停机由重启策略决定，Node 宿主延迟
    // 500ms），这条回复来得及发出。已写进文件，重启失败不撤回：改动在下次启动时生效
    try {
      app.restart();
    } catch (err) {
      const reason = `全局配置已保存，但重启失败（${errorMessage(err)}），改动在下次启动时生效`;
      caps.logger?.error(reason);
      res.json({ ok: true, message: `${reason}${note}`, restart: false, ignored });
      return;
    }
    res.json({ ok: true, message: `全局配置已更新，正在重启应用以生效…${note}`, restart: true, ignored });
  });

  // 获取单个插件在配置文档里的配置
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
    if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
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

    // 合进原配置再交给 updateConfig：后者是**整体替换**语义（core 的 orchestration/plugin.ts 里
    // entry.config = newConfig 直接顶掉）。基线取配置文档里的原配置而非裸默认值：defaultsFrom 只收录声明了
    // default 的键，而 apiKey / accessToken 这类 secret 多数**没有** default（deepseek、embedding-openai、
    // llm-openai、serper、onebot 皆是），以裸默认值打底时请求里没带 apiKey，整体替换后用户的密钥就从内存态与
    // yaml 一起消失。叠上原配置后语义才是真正的部分更新：没提交的字段保持原样，要清空得显式提交。
    const entry = pm.getPlugin(pluginName);
    const schema = entry?.definition?.configSchema;
    let docConfig: Record<string, unknown>;
    let stored: Record<string, unknown>;
    let merged: Record<string, unknown>;
    let ignored: string[];
    let removed: string[];
    try {
      docConfig = doc.getPluginConfig(pluginName);
      stored = deepMergeDefaults(defaultsFrom(schema), docConfig);
      ({ merged, ignored, removed } = mergeSubmittedConfig(
        doc,
        pluginName,
        schema,
        docConfig,
        newConfig as Record<string, unknown>,
      ));
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
    // 正常中间态。
    // 存量按「去掉下标的路径 + 原因」计数，新配置里同类问题的条数超出存量才算新增：list / multiselect /
    // 数组删掉前面的元素后，存量坏元素的下标会前移，按原路径比会把它误判成新增
    const issueKey = (i: { path: string; message: string }) => `${i.path.replace(/\[\d+\]/g, '[]')}|${i.message}`;
    const preExisting = new Map<string, number>();
    for (const i of validateConfig(schema, stored)) {
      const key = issueKey(i);
      preExisting.set(key, (preExisting.get(key) ?? 0) + 1);
    }
    const issues = validateConfig(schema, merged).filter(i => {
      if (i.kind !== 'invalid') return false;
      const key = issueKey(i);
      const left = preExisting.get(key) ?? 0;
      preExisting.set(key, left - 1);
      return left <= 0;
    });
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
      // 按新配置重新激活失败、转为 error：照样写入配置（原样再存即重试激活），但按实际状态回报。
      // 禁用态只换上新配置、保持禁用，启用时按它激活
      const after = await settledEntry(pm, pluginName);
      const failure =
        after?.state === 'error'
          ? `插件 ${pluginName} 按新配置重新激活失败，已转为 error 态（${after.error ?? '详见日志'}）`
          : undefined;
      const aside = after?.state === 'disabled' ? '插件已禁用，启用时按新配置激活' : notYetActive(after?.state);
      if (!(await saveAfterApply(doc, res, 'reload', failure ?? aside))) return;
      if (failure !== undefined) {
        res.status(500).json({ error: `${failure}；配置已写入配置文件${note}` });
        return;
      }
      res.json({
        ok: true,
        message: `插件 ${pluginName} 配置已更新${note}${aside ? `；${aside}` : ''}`,
        ignored,
        removed,
      });
    } else {
      refuse(pm, res, pluginName, '配置更新');
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
      // 激活失败、转为 error：照样记为启用（重启时再激活），但按实际状态回报
      const after = await settledEntry(pm, pluginName);
      const failure =
        after?.state === 'error'
          ? `插件 ${pluginName} 激活失败，已转为 error 态（${after.error ?? '详见日志'}）`
          : undefined;
      const aside = notYetActive(after?.state);
      if (!(await saveAfterApply(doc, res, 'restart', failure ?? aside))) return;
      if (failure !== undefined) {
        res.status(500).json({ error: `${failure}；配置文件已记为启用` });
        return;
      }
      res.json({ ok: true, message: `插件 ${pluginName} 已启用${aside ? `；${aside}` : ''}` });
    } else {
      refuse(pm, res, pluginName, '启用');
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
      // 仍在初始化、不响应 abort 的插件，宽限到期转 error 而非 disabled：照样记为禁用（重启时不再激活），但按实际状态回报
      const stuck =
        pm.getPlugin(pluginName)?.state === 'error'
          ? `插件 ${pluginName} 未在宽限内停止，已转为 error 态，详见日志`
          : undefined;
      doc.setPluginEnabled(pluginName, false);
      if (!(await saveAfterApply(doc, res, 'restart', stuck))) return;
      if (stuck !== undefined) {
        res.status(500).json({ error: `${stuck}；配置文件已记为禁用` });
        return;
      }
      res.json({ ok: true, message: `插件 ${pluginName} 已禁用` });
    } else {
      refuse(pm, res, pluginName, '禁用');
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
    if (typeof config !== 'object' || Array.isArray(config)) {
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
    // 实例创建编排（配置文件编排属管理面,内核只出 register 机制）：
    // 查同名 module → reusable/查重校验 → 合并默认配置、裁剪与校验 → 写入 → register 激活。
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
    // 与改配置同一套合并与裁剪，基线是空对象。校验不分存量：新实例没有历史配置，类型不符的值一律拒绝，
    // missing 照样放行（半成品配置是配到一半的正常中间态）
    const schema = sourceModule.configSchema;
    const { merged: mergedConfig, ignored } = mergeSubmittedConfig(
      doc,
      instanceId,
      schema,
      {},
      config as Record<string, unknown>,
    );
    const issues = validateConfig(schema, mergedConfig).filter(i => i.kind === 'invalid');
    if (issues.length > 0) {
      res.status(400).json({
        error: `配置校验未通过：${issues.map(i => `${i.path}: ${i.message}`).join('；')}`,
        issues,
      });
      return;
    }
    const note = ignored.length > 0 ? `（已忽略未声明的配置字段: ${ignored.join(', ')}）` : '';
    let registered: boolean;
    try {
      doc.setPluginConfig(instanceId, mergedConfig);
      // 文档里残留的禁用标记（手改配置文件留下的）照旧生效：以禁用态登记
      registered = await pm.register(sourceModule, mergedConfig, instanceId, {
        disabled: doc.isPluginDisabled(instanceId),
      });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    if (!registered) {
      // 前面已查过重名与 reusable，走到这里的实际只有停机进行中：配置不落盘，免得下次启动按文件登记
      doc.removePluginConfig(instanceId);
      res.status(409).json({ error: `实例 ${instanceId} 未登记（停机中或被拒，见日志），配置未写入` });
      return;
    }
    // 激活失败、转为 error：实例与配置照样保留并落盘（改配置保存即重试激活），但按实际状态回报
    const after = await settledEntry(pm, instanceId);
    const failure =
      after?.state === 'error'
        ? `已创建实例 ${instanceId}，但激活失败，已转为 error 态（${after.error ?? '详见日志'}）`
        : undefined;
    const aside =
      after?.state === 'disabled'
        ? '配置文件的 disabledPlugins 里有它，已按禁用态登记，启用后激活'
        : notYetActive(after?.state);
    if (!(await saveAfterApply(doc, res, 'reload', failure ?? aside))) return;
    if (failure !== undefined) {
      res.status(500).json({ error: `${failure}；配置已写入配置文件${note}` });
      return;
    }
    res.json({ ok: true, instanceId, message: `已创建实例 ${instanceId}${note}${aside ? `；${aside}` : ''}`, ignored });
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
    // 实例删除编排：主实例保护 → 移除配置条目与禁用标记（同名重建时不再以禁用态登记）并落盘 → unload（内部含级联重算）。
    // 与其它管理路由「先生效后落盘」相反：后缀实例由配置段定义，热重载也按文件登记。先卸载后落盘时，卸载途中外部改动
    // 触发的热重载会按仍带配置段的文件把实例重新登记，落盘随后删掉配置段，留下文件里没有的在跑实例
    const { suffix } = parseInstanceId(instanceId);
    if (!suffix || !pm.getPlugin(instanceId)) {
      res.status(400).json({ error: `无法删除（实例不存在或不允许删除主实例）` });
      return;
    }
    const previous = Object.hasOwn(doc.getAll().plugins, instanceId) ? doc.getPluginConfig(instanceId) : undefined;
    const wasDisabled = doc.isPluginDisabled(instanceId);
    doc.removePluginConfig(instanceId);
    doc.setPluginEnabled(instanceId, true);
    try {
      await doc.save();
    } catch (err) {
      // 没写进文件就不卸载，并撤回文档里的改动，免得下一次任意保存把这次没删成的删除写进文件
      if (previous) doc.setPluginConfig(instanceId, previous);
      doc.setPluginEnabled(instanceId, !wasDisabled);
      res
        .status(isConfigSaveRefused(err) ? 409 : 500)
        .json({ error: `未删除实例 ${instanceId}：未写入配置文件（${errorMessage(err)}）` });
      return;
    }
    try {
      await pm.unload(instanceId);
    } catch (err) {
      res.status(500).json({
        error: `已从配置文件删除实例 ${instanceId}，但卸载失败（${errorMessage(err)}）；重启后不再登记`,
      });
      return;
    }
    res.json({ ok: true, message: `已删除实例 ${instanceId}` });
  });

  // 保存配置文档：与其它落盘路由同一口径，宿主拒写回 409、其它失败回 500。宿主不持久化时 save 不写盘，
  // 回执因此只说「已保存」，不说保存到磁盘
  expressApp.post('/api/config/save', gate(), async (_req, res) => {
    const doc = docOr503(res);
    if (!doc) return;
    try {
      await doc.save();
      res.json({ ok: true, message: '配置已保存' });
    } catch (err) {
      res.status(isConfigSaveRefused(err) ? 409 : 500).json({ error: errorMessage(err) });
    }
  });
}
