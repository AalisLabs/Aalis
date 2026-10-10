import { isDeepStrictEqual } from 'node:util';
import type { CommandService } from '@aalis/api-commands';
import { describeUnmet, unmetDependencies } from '@aalis/api-doctor';
import { type ApplyPluginConfigResult, type HostConfig, isConfigSaveRefused } from '@aalis/api-host-config';
import type { PluginSourceService } from '@aalis/api-plugin-source';
import type { ToolService } from '@aalis/api-tools';
import type { ErrorResponse } from '@aalis/api-webui';
import type { AppService, Logger, PluginManagerService, PluginState, ServiceSelection, Services } from '@aalis/core';
import { parseInstanceId } from '@aalis/core';
import {
  CORE_CONFIG_SCHEMA,
  type ConfigSchema,
  deepMergeDefaults,
  defaultsFrom,
  isSecretRef,
  mapSecretFields,
  parseConfig,
  removeExtraFields,
  validateConfig,
} from '@aalis/schema-config';
import type express from 'express';
import { blockedStatus } from '../attention.js';
import type { RouteGate } from '../gate.js';
import { route } from '../route.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 落盘被拒后运行态怎样与文件对齐：插件配置、新建的实例与服务偏好随配置文件热重载（文件里没有配置段的后缀实例会被卸载）；
 * 启停只在重启时按文件登记。被拒的可能是配置文件，也可能是密钥文件，拒写原因里点了名，这里不指具体哪个文件
 */
const RECONCILE = {
  reload: '修好该文件后会按文件内容重载',
  restart: '修好该文件后，重启时以文件内容为准',
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
  res: express.Response<ErrorResponse>,
  reconcile: keyof typeof RECONCILE,
  outcome?: string,
): Promise<boolean> {
  try {
    await doc.save();
    return true;
  } catch (err) {
    reportSaveFailure(res, err, reconcile, outcome);
    return false;
  }
}

/** 落盘失败的回执，口径见 {@link saveAfterApply}；applyPluginConfig 带回的 saveError 同样用它 */
function reportSaveFailure(
  res: express.Response<ErrorResponse>,
  err: unknown,
  reconcile: keyof typeof RECONCILE,
  outcome?: string,
): void {
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
}

/** 宿主配置里要重启才生效的键：runtime 与 core 只在启动时读它们。name 只是显示用的应用名称，保存即生效 */
const RESTART_KEYS: readonly string[] = ['logLevel', 'slowThresholdMs'];

/** 文档里每个密钥键被引用的处数：表单据此提示「替换会同时改到另外 N 处」 */
function countSecretRefs(value: unknown, into: Record<string, number> = {}): Record<string, number> {
  if (isSecretRef(value)) into[value.$secret] = (into[value.$secret] ?? 0) + 1;
  else if (Array.isArray(value)) for (const item of value) countSecretRefs(item, into);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) countSecretRefs(v, into);
  return into;
}

/**
 * 管理动作受理后等重算落定，再读实例状态写回执：动作撞上在飞的重算时只排队、立即返回，立即读到的还是 pending，
 * 之后的激活失败就漏报了。idle 不等转入后台的慢激活：重算对单个激活至多等到慢激活阈值。
 */
async function settledEntry(pm: PluginManagerService, instanceId: string) {
  await pm.idle();
  return pm.getPlugin(instanceId);
}

/**
 * 落定后既没激活也没失败的说明：慢激活转入后台仍在进行，或 required 依赖没满足（缺什么、在等谁，按 api-doctor 的共享判据
 * 沿链追到根，与插件列表同一说法；依赖都在、只是提供者正在关停换代时没有可说的）；其余状态由各路由自己说明
 */
function notYetActive(
  pm: PluginManagerService,
  services: Pick<Services, 'names'>,
  instanceId: string,
  state: PluginState | undefined,
): string | undefined {
  if (state === 'activating') return '仍在激活（超过慢激活阈值，已转入后台），结果以插件列表为准';
  if (state !== 'pending') return undefined;
  const unmet = unmetDependencies(pm.getStatus(), services.names()).get(instanceId);
  const why = unmet && describeUnmet(unmet);
  return why ? `尚未激活：${why}` : '尚未激活，结果以插件列表为准';
}

/**
 * 管理动作返回 false 时的回执。条目还在注册表里，说明是停机中或正在卸载拒绝了这次操作，回 409；
 * 只有条目确实不存在才回 404。两种情况都没有写配置文档。
 */
function refuse(
  pm: PluginManagerService,
  res: express.Response<ErrorResponse>,
  instanceId: string,
  action: string,
): void {
  if (pm.getPlugin(instanceId)) {
    res.status(409).json({ error: `插件 ${instanceId} 当前不接受${action}（停机中或正在卸载），配置未更改` });
  } else {
    res.status(404).json({ error: `插件 ${instanceId} 不存在` });
  }
}

/** 插件管理 + 全局配置路由用到的能力 */
interface PluginRoutesCaps {
  app: Pick<ServiceSelection<AppService>, 'present' | 'use'>;
  plugins: Pick<ServiceSelection<PluginManagerService>, 'present' | 'use'>;
  /** 宿主的插件来源；打包宿主不提供，扫描路由随之报不可用 */
  source: Pick<ServiceSelection<PluginSourceService>, 'present' | 'use'>;
  /** 配置文档的读写与落盘（宿主提供；缺席时读写文档的路由返回 503） */
  hostConfig: Pick<ServiceSelection<HostConfig>, 'present' | 'use'>;
  tools: Pick<ServiceSelection<ToolService>, 'present' | 'use'>;
  commands: Pick<ServiceSelection<CommandService>, 'present' | 'use'>;
  /** 当前有提供者的服务名：列表与回执据它判缺与在等；列表另据它读各插件的本插件偏好与此刻的选择 */
  services: Pick<Services, 'names' | 'preferred' | 'inspect'>;
  /** 提供这个界面的插件实例：经这些路由停用不了它，列表给它标 self */
  self: string;
  /** 家目录（宿主路径的 home）：宿主配置一并给出；宿主不提供路径时没有 */
  home?: string;
  /** 本地已装包的版本，每取一次列表现查一遍（装卸与更新会改它） */
  versions(): (name: string) => string | undefined;
  /** 裁剪 schema 外字段时点名 warn，保存全局配置后重启失败时记 error；测试可不传 */
  logger?: Logger;
}

/** 注册插件管理 + 全局配置相关 REST 路由 */
export function registerPluginRoutes(expressApp: express.Express, caps: PluginRoutesCaps, gate: RouteGate): void {
  /** 配置文档由宿主提供；没有时读写文档的路由一律 503，与扫描、市场路由的缺席口径一致 */
  const docOr503 = (res: express.Response<ErrorResponse>): HostConfig | undefined => {
    const doc = caps.hostConfig.present ? caps.hostConfig.use : undefined;
    if (!doc) res.status(503).json({ error: '宿主未提供配置文档（host-config），无法读写配置' });
    return doc;
  };

  /** 提供这个界面的插件经界面停掉就回不来了：拒绝停用它 */
  const refuseSelf = (res: express.Response<ErrorResponse>, name: string): boolean => {
    if (name !== caps.self) return false;
    res.status(409).json({ error: `插件 ${name} 提供这个界面，不能从界面停用` });
    return true;
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
  route(expressApp, 'GET /api/plugins', gate(), (_req, res) => {
    const app = caps.app.present ? caps.app.use : undefined;
    const pm = caps.plugins.present ? caps.plugins.use : undefined;
    if (!app || !pm) {
      res.json({ plugins: [], secretRefCounts: {} });
      return;
    }
    // 反向索引：instanceId -> tools / commands。生产登记的 pluginName 就是 contextId（= instanceId）；
    // 按 definition.name 索引会让 name:suffix 误挂主实例的工具
    const toolsByPlugin = new Map<string, string[]>();
    for (const t of caps.tools.present ? caps.tools.use.getAll() : []) {
      toolsByPlugin.set(t.pluginName, [...(toolsByPlugin.get(t.pluginName) ?? []), t.name]);
    }
    const commandsByPlugin = new Map<string, string[]>();
    for (const c of caps.commands.present ? caps.commands.use.getAll() : []) {
      const owner = c.pluginName ?? 'unknown';
      commandsByPlugin.set(owner, [...(commandsByPlugin.get(owner) ?? []), c.name]);
    }
    const doc = caps.hostConfig.present ? caps.hostConfig.use : undefined;
    const sections = doc?.getAll().plugins ?? {};
    const versionOf = caps.versions();
    const plugins = blockedStatus({ plugins: pm, services: caps.services, doc }).map(p => {
      const entry = pm.getPlugin(p.instanceId);
      const schema = entry?.definition?.configSchema;
      const declared = [...(p.requiredServices ?? []), ...(p.optionalServices ?? [])];
      return {
        name: p.name,
        instanceId: p.instanceId,
        displayName: p.displayName,
        // 展示元数据：子系统按插件声明原样给，归哪组、组名与顺序由界面定；版本取已装的包
        subsystem: entry?.definition?.subsystem,
        version: versionOf(p.name),
        state: p.state,
        slow: p.slow,
        lingering: p.lingering,
        self: p.instanceId === caps.self || undefined,
        provides: p.provides ?? [],
        requiredServices: p.requiredServices ?? [],
        optionalServices: p.optionalServices ?? [],
        servicePreferences: Object.fromEntries(
          declared.flatMap(name => {
            const preferred = caps.services.preferred(name, { for: p.instanceId });
            return preferred === undefined ? [] : [[name, preferred]];
          }),
        ),
        serviceSelections: Object.fromEntries(
          declared.flatMap(name => {
            const [selected] = caps.services.inspect(name, { for: p.instanceId });
            return selected ? [[name, { contextId: selected.contextId, basis: selected.basis }]] : [];
          }),
        ),
        lacking: p.lacking,
        waiting: p.waiting,
        unconfigured: p.unconfigured,
        tools: toolsByPlugin.get(p.instanceId) ?? [],
        commands: commandsByPlugin.get(p.instanceId) ?? [],
        reusable: p.reusable ?? false,
        // extends / config / configSchema / defaultConfig 非内核状态摘要字段
        // （getStatus 只含内核事实）：从配置文档与 entry.definition 补齐给前端。
        // 配置给文档形态：密钥字段上是引用，不是原值；前端据它建编辑草稿，引用原样发回即保持原值。
        // 宿主不提供配置文档时给运行态，去掉密钥字段（运行态里是原值）
        extends: entry?.definition?.extends,
        configSection: Object.hasOwn(sections, p.instanceId),
        config: doc ? doc.getPluginConfig(p.instanceId) : mapSecretFields(schema, entry?.config ?? {}, () => undefined),
        configSchema: schema,
        defaultConfig: defaultsFrom(schema),
        error: p.error,
      };
    });
    res.json({ plugins, secretRefCounts: doc ? countSecretRefs(doc.getAll().plugins) : {} });
  });

  // 宿主配置：文档里写了的核心键、它们的 schema、要重启才生效的键与家目录
  route(expressApp, 'GET /api/config', gate(), (_req, res) => {
    const doc = docOr503(res);
    if (!doc) return;
    const all = doc.getAll() as Record<string, unknown>;
    const config = Object.fromEntries(
      Object.keys(CORE_CONFIG_SCHEMA)
        .filter(key => all[key] !== undefined)
        .map(key => [key, all[key]]),
    );
    res.json({ config, schema: CORE_CONFIG_SCHEMA, restartKeys: [...RESTART_KEYS], home: caps.home });
  });

  // 改宿主配置的核心键：只保存，要重启才生效的键改了时回执写明，由界面出「重启以生效」，重启走 POST /api/restart
  route(expressApp, 'PUT /api/config', gate(), async (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: '请求体必须是对象' });
      return;
    }
    const doc = docOr503(res);
    if (!doc) return;

    // 只收 CORE_CONFIG_SCHEMA 的键：别的顶层键（插件配置、禁用名单等）各有自己的路由，写在这里的一律拒收
    const allowed = Object.keys(CORE_CONFIG_SCHEMA);
    const foreign = Object.keys(updates).filter(k => !allowed.includes(k));
    if (foreign.length > 0) {
      res.status(400).json({ error: `只能改核心键（${allowed.join('、')}），不收：${foreign.join('、')}` });
      return;
    }
    const current = doc.getAll() as Record<string, unknown>;
    const defaultOf = (k: string) => (CORE_CONFIG_SCHEMA[k] as { default?: unknown } | undefined)?.default;
    // 文档里没写的核心键按 schema 默认值比较：回传的默认值不算改动，不写进文件
    const currentOf = (k: string) => current[k] ?? defaultOf(k);
    // 核心键提交 null 表示清空（恢复默认）：回到默认值，并从文档里删掉这个键，不把默认值写死进文件
    const submittedOf = (k: string) => (updates[k] === null ? defaultOf(k) : updates[k]);
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
    const restartNeeded = changed.some(k => RESTART_KEYS.includes(k));

    try {
      await doc.save();
    } catch (err) {
      // 拒写与写入失败都撤回文档里的改动，免得下一次任意保存把这次没存下的修改写进文件
      for (const key of changed) doc.set(key, previous[key]);
      res
        .status(isConfigSaveRefused(err) ? 409 : 500)
        .json({ error: `未写入配置文件（${errorMessage(err)}），本次修改已撤回` });
      return;
    }
    res.json({
      ok: true,
      message: restartNeeded ? '全局配置已保存，重启后生效' : '全局配置已更新并保存',
      restartNeeded,
    });
  });

  // 重启应用。发起之后的停机是异步的（core 先广播 app:restarting，何时停机由重启策略决定），这条回复来得及发出；
  // 宿主没注入重启策略时 restart() 同步抛错，回 500，界面据此不去等待重连
  route(expressApp, 'POST /api/restart', gate(), (_req, res) => {
    const app = caps.app.present ? caps.app.use : undefined;
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    try {
      app.restart();
    } catch (err) {
      const reason = `重启失败（${errorMessage(err)}），改动在下次启动时生效`;
      caps.logger?.error(reason);
      res.status(500).json({ error: reason });
      return;
    }
    res.json({ ok: true, message: '正在重启应用' });
  });

  // 更新插件配置
  route(expressApp, 'PUT /api/plugins/:name/config', gate(), async (req, res) => {
    const pluginName = req.params.name;
    const newConfig = req.body?.config;
    if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
      res.status(400).json({ error: 'config 字段必须是对象' });
      return;
    }

    const pm = caps.plugins.present ? caps.plugins.use : undefined;
    if (!pm) {
      res.status(500).json({ error: '插件管理服务不可用' });
      return;
    }
    const doc = docOr503(res);
    if (!doc) return;

    // 合进原配置再交给宿主的 applyPluginConfig：配置是**整体替换**语义（core 的 orchestration/plugin.ts 里
    // entry.config = newConfig 直接顶掉）。基线取配置文档里的原配置而非裸默认值：defaultsFrom 只收录声明了
    // default 的键，而 apiKey / accessToken 这类 secret 多数**没有** default，以裸默认值打底时请求里没带 apiKey，
    // 整体替换后用户的密钥就从内存态与 yaml 一起消失。叠上原配置后语义才是真正的部分更新：没提交的字段保持原样，
    // 要清空得显式提交。
    // 原配置是文档形态，密钥字段上是引用；前端原样发回引用即保持原值，发明文即替换（由宿主拆进密钥存储）。
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
    // 没登记的实例不经这里新建（宿主的 applyPluginConfig 会按同模块定义登记它），建实例走 POST instances
    if (!entry) {
      res.status(404).json({ error: `插件 ${pluginName} 不存在` });
      return;
    }
    const note =
      (ignored.length > 0 ? `（已忽略未声明的配置字段: ${ignored.join(', ')}）` : '') +
      (removed.length > 0 ? `（已从配置文件移除未声明的字段: ${removed.join(', ')}）` : '');

    // 保存前校验，拦新不追旧：只拒绝本次编辑**新引入**的 invalid（配错了）。
    // 存量问题放行——否则带着历史脏值（或 schema 表达不了的多态字段，如字符串与数组两种写法都收的
    // 字段）的插件会在 WebUI 永久存不了任何字段；启动侧 config-sync
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

    // 运行态、文档、密钥与落盘由宿主一步完成：解析出的配置与运行态相同、实例在 active 时不重建插件
    // （updateConfig 即 bounce，会连带重启依赖它所提供服务的下游），照常写回文档并落盘：上一次保存可能写文件失败（500），
    // 原样重试要能补写；自写回不会触发 watch 重载。error 态插件靠原样保存来重试激活
    let result: ApplyPluginConfigResult;
    try {
      result = await doc.applyPluginConfig(pluginName, merged);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    if (result.status === 'refused') {
      refuse(pm, res, pluginName, '配置更新');
      return;
    }
    // 运行态与文档都没变：回「无改动」。只有运行态没变（例如文档里补了配置段）照常按已更新回报，插件没有重建
    if (!result.reloaded && isDeepStrictEqual(merged, docConfig)) {
      if (result.saveError !== undefined) {
        reportSaveFailure(res, result.saveError, 'reload');
        return;
      }
      res.json({ ok: true, message: `插件 ${pluginName} 配置无改动，已写回配置文件${note}`, ignored, removed });
      return;
    }
    // 按新配置重新激活失败、转为 error：照样写入配置（原样再存即重试激活），回执按实际状态说明。
    // 禁用态只换上新配置、保持禁用，启用时按它激活
    const after = await settledEntry(pm, pluginName);
    const failure =
      after?.state === 'error'
        ? `插件 ${pluginName} 按新配置重新激活失败，已转为 error 态（${after.error ?? '详见日志'}）`
        : undefined;
    const aside =
      after?.state === 'disabled'
        ? '插件已禁用，启用时按新配置激活'
        : notYetActive(pm, caps.services, pluginName, after?.state);
    if (result.saveError !== undefined) {
      reportSaveFailure(res, result.saveError, 'reload', failure ?? aside);
      return;
    }
    // 写进了配置文件就回 2xx，激活失败也一样：表单据状态码区分「没写成」（留着改）与「写成了」（收起、刷新）。
    // 写成之后草稿已经过时，例如清除的密钥键已随这次保存从 secrets.yaml 删掉，再「撤销」只会引用不存在的键
    res.json({
      ok: true,
      message:
        failure !== undefined
          ? `${failure}；配置已写入配置文件${note}`
          : `插件 ${pluginName} 配置已更新${note}${aside ? `；${aside}` : ''}`,
      ignored,
      removed,
    });
  });

  // 启用插件
  route(expressApp, 'POST /api/plugins/:name/enable', gate(), async (req, res) => {
    const pluginName = req.params.name;
    const pm = caps.plugins.present ? caps.plugins.use : undefined;
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
      // 激活失败、转为 error：照样记为启用（重启时再激活），回执按实际状态说明。写进了配置文件就回 2xx，口径同改配置
      const after = await settledEntry(pm, pluginName);
      const failure =
        after?.state === 'error'
          ? `插件 ${pluginName} 激活失败，已转为 error 态（${after.error ?? '详见日志'}）`
          : undefined;
      const aside = notYetActive(pm, caps.services, pluginName, after?.state);
      if (!(await saveAfterApply(doc, res, 'restart', failure ?? aside))) return;
      res.json({
        ok: true,
        message:
          failure !== undefined
            ? `${failure}；配置文件已记为启用`
            : `插件 ${pluginName} 已启用${aside ? `；${aside}` : ''}`,
      });
    } else {
      refuse(pm, res, pluginName, '启用');
    }
  });

  // 禁用插件
  route(expressApp, 'POST /api/plugins/:name/disable', gate(), async (req, res) => {
    const pluginName = req.params.name;
    if (refuseSelf(res, pluginName)) return;
    const pm = caps.plugins.present ? caps.plugins.use : undefined;
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
      // 已禁用，但旧实例（如不响应 abort 的初始化）超过宽限仍没停下：回执说明这一点。写进了配置文件就回 2xx，口径同改配置
      const stuck = pm.getStatus().find(entry => entry.instanceId === pluginName)?.lingering
        ? `插件 ${pluginName} 已禁用，但超过宽限仍未停下，详见日志`
        : undefined;
      doc.setPluginEnabled(pluginName, false);
      if (!(await saveAfterApply(doc, res, 'restart', stuck))) return;
      res.json({
        ok: true,
        message: stuck !== undefined ? `${stuck}；配置文件已记为禁用` : `插件 ${pluginName} 已禁用`,
      });
    } else {
      refuse(pm, res, pluginName, '禁用');
    }
  });

  // 重载：拆掉当前激活再按原配置重新激活，不写配置文件；失败的插件重载即重试
  route(expressApp, 'POST /api/plugins/:name/reload', gate(), async (req, res) => {
    const pluginName = req.params.name;
    const pm = caps.plugins.present ? caps.plugins.use : undefined;
    if (!pm) {
      res.status(500).json({ error: '插件管理服务不可用' });
      return;
    }
    if (pm.getPlugin(pluginName)?.state === 'disabled') {
      res.status(409).json({ error: `插件 ${pluginName} 已停用，启用后才能重载` });
      return;
    }
    let success: boolean;
    try {
      success = await pm.bounce(pluginName);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    if (!success) {
      refuse(pm, res, pluginName, '重载');
      return;
    }
    const after = await settledEntry(pm, pluginName);
    const aside = notYetActive(pm, caps.services, pluginName, after?.state);
    res.json({
      ok: true,
      message:
        after?.state === 'error'
          ? `插件 ${pluginName} 重新激活失败，已转为 error 态（${after.error ?? '详见日志'}）`
          : `插件 ${pluginName} 已重载${aside ? `；${aside}` : ''}`,
    });
  });

  // 经宿主 plugin-source 重新扫描并加载新插件
  route(expressApp, 'POST /api/plugins/scan', gate(), async (_req, res) => {
    if (!caps.source.present) {
      res.status(503).json({ error: '宿主未提供插件来源，无法扫描' });
      return;
    }
    const source = caps.source.use;
    try {
      const loaded = await source.rescan();
      res.json({ ok: true, loaded, message: loaded.length > 0 ? `新加载 ${loaded.length} 个插件` : '无新插件' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 创建插件多实例
  route(expressApp, 'POST /api/plugins/:name/instances', gate(), async (req, res) => {
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
    const pm = caps.plugins.present ? caps.plugins.use : undefined;
    if (!pm) {
      res.status(500).json({ error: '插件管理服务不可用' });
      return;
    }
    const doc = docOr503(res);
    if (!doc) return;
    // 实例创建编排（配置文件编排属管理面,内核只出 register 机制）：
    // 查同名 module → reusable/查重校验 → 合并默认配置、裁剪与校验 → 写入 → register 激活。
    // 模块定义主实例优先、否则取任一在册实例的，与宿主登记新实例时取定义的规则一致：合并、裁剪与校验所用的 schema
    // 就是登记时的那一份
    const sourceModule =
      pm.getPlugin(moduleName)?.definition ??
      pm
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
    // 宿主先写文档再登记（文档里残留的禁用标记照旧生效，以禁用态登记），没登记上时撤回文档与密钥
    let result: ApplyPluginConfigResult;
    try {
      result = await doc.applyPluginConfig(instanceId, mergedConfig);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    if (result.status === 'refused') {
      // 前面已查过重名与 reusable，走到这里的实际只有停机进行中：配置不落盘，免得下次启动按文件登记
      res.status(409).json({ error: `实例 ${instanceId} 未登记（停机中或被拒，见日志），配置未写入` });
      return;
    }
    // 激活失败、转为 error：实例与配置照样保留并落盘（改配置保存即重试激活），回执按实际状态说明。
    // 写进了配置文件就回 2xx，口径同改配置：实例已登记，表单该收起，留着再点「创建」只会得到「已存在」
    const after = await settledEntry(pm, instanceId);
    const failure =
      after?.state === 'error'
        ? `已创建实例 ${instanceId}，但激活失败，已转为 error 态（${after.error ?? '详见日志'}）`
        : undefined;
    const aside =
      after?.state === 'disabled'
        ? '配置文件的 disabledPlugins 里有它，已按禁用态登记，启用后激活'
        : notYetActive(pm, caps.services, instanceId, after?.state);
    if (result.saveError !== undefined) {
      reportSaveFailure(res, result.saveError, 'reload', failure ?? aside);
      return;
    }
    res.json({
      ok: true,
      instanceId,
      message:
        failure !== undefined
          ? `${failure}；配置已写入配置文件${note}`
          : `已创建实例 ${instanceId}${note}${aside ? `；${aside}` : ''}`,
      ignored,
    });
  });

  // 删除插件多实例
  route(expressApp, 'DELETE /api/plugins/:instanceId/instance', gate(), async (req, res) => {
    const instanceId = req.params.instanceId;
    const pm = caps.plugins.present ? caps.plugins.use : undefined;
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
    let unloaded: boolean;
    try {
      unloaded = await pm.unload(instanceId);
    } catch (err) {
      res.status(500).json({
        error: `已从配置文件删除实例 ${instanceId}，但卸载失败（${errorMessage(err)}）；重启后不再登记`,
      });
      return;
    }
    // 返回 false 而条目还在：停机中拒绝了卸载，配置段已删、实例仍在跑到停机为止。条目已不在的是别处先卸掉了，照常回已删除
    if (!unloaded && pm.getPlugin(instanceId)) {
      res.json({ ok: true, message: `已从配置文件删除实例 ${instanceId}；停机中，未卸载运行中的实例` });
      return;
    }
    res.json({ ok: true, message: `已删除实例 ${instanceId}` });
  });
}
