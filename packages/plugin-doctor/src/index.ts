import { version as nodeVersion, platform } from 'node:process';
import { commands } from '@aalis/api-commands';
import {
  type CheckCategory,
  type CheckLevel,
  type CheckResult,
  type CheckSpec,
  type DoctorReport,
  type DoctorService,
  describeUnmet,
  doctor,
  unmetDependencies,
} from '@aalis/api-doctor';
import { type HostConfig, hostConfig } from '@aalis/api-host-config';
import { type NoticeHandle, webuiServer } from '@aalis/api-webui';
import {
  type BoundOf,
  definePlugin,
  events,
  logger,
  optional,
  type PluginManagerService,
  pluginsService,
  provide,
  type ServiceRef,
  type Services,
  services,
} from '@aalis/core';

const PLUGIN_NAME = '@aalis/plugin-doctor';

const uses = {
  provide,
  logger,
  events,
  services,
  plugins: optional(pluginsService),
  commands: optional(commands),
  webui: optional(webuiServer),
  hostConfig: optional(hostConfig),
};
type Caps = BoundOf<typeof uses>;

// ===== Registry =====

class DoctorRegistry implements DoctorService {
  private last: DoctorReport | undefined;
  private readonly specs = new Map<string, CheckSpec>();

  /** reported：每次运行完，诊断页按新报告刷新并发出或撤回提示 */
  constructor(
    private readonly caps: Pick<Caps, 'logger' | 'events'>,
    private readonly reported: (report: DoctorReport) => void,
  ) {}

  getLastReport(): DoctorReport | undefined {
    return this.last;
  }

  registerCheck(spec: CheckSpec): () => void {
    if (this.specs.has(spec.id)) {
      this.caps.logger.debug(`doctor: 检查项 ${spec.id} 被覆盖注册`);
    }
    this.specs.set(spec.id, spec);
    return () => {
      const cur = this.specs.get(spec.id);
      if (cur === spec) this.specs.delete(spec.id);
    };
  }

  listChecks(): Array<{ id: string; category: CheckCategory; pluginName?: string }> {
    return [...this.specs.values()].map(s => ({ id: s.id, category: s.category, pluginName: s.pluginName }));
  }

  async runChecks(): Promise<DoctorReport> {
    const checks: CheckResult[] = [];

    for (const spec of this.specs.values()) {
      try {
        const r = await spec.run();
        const list = Array.isArray(r) ? r : [r];
        for (const c of list) checks.push(c);
      } catch (err) {
        checks.push({
          id: spec.id,
          category: spec.category,
          level: 'error',
          message: `检查项 ${spec.id} 抛出异常`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = checks.reduce(
      (acc, c) => {
        acc[c.level]++;
        return acc;
      },
      { ok: 0, warn: 0, error: 0 } as DoctorReport['summary'],
    );

    this.last = {
      generatedAt: new Date().toISOString(),
      summary,
      checks,
    };

    // 通知订阅者报告换了
    this.caps.events.emit('doctor:updated', { generatedAt: this.last.generatedAt, summary }).catch(() => {});
    this.reported(this.last);

    return this.last;
  }
}

// ===== WebUI 页面 =====

const LEVELS: Record<CheckLevel, { text: string; state?: 'attention' | 'error' }> = {
  ok: { text: '通过' },
  warn: { text: '警告', state: 'attention' },
  error: { text: '错误', state: 'error' },
};

// ===== 插件入口 =====

export default definePlugin({
  name: PLUGIN_NAME,
  displayName: '系统诊断',
  subsystem: 'platform',
  provides: [doctor],
  uses,
  apply({ provide, logger, events, services, plugins, commands, webui, hostConfig }) {
    // 诊断页只读本次激活的 registry：页面属于本插件，不该去查「当前胜出的 doctor」
    const page = webui.definePage({
      key: 'doctor',
      title: '系统诊断',
      icon: 'activity',
      actions: {
        runDiagnostics: {
          label: '立即运行',
          effect: 'read',
          async handler() {
            const { ok, warn, error } = (await registry.runChecks()).summary;
            return `诊断完成：${ok} 项通过、${warn} 项警告、${error} 项错误`;
          },
        },
      },
      content: [
        { type: 'actions', actions: ['runDiagnostics'] },
        {
          type: 'info',
          id: 'summary',
          label: '上次运行',
          data() {
            const last = registry.getLastReport();
            if (!last) return [{ label: '时间', value: '尚未运行' }];
            return [
              { label: '时间', value: last.generatedAt, kind: 'time' },
              { label: '通过', value: last.summary.ok },
              { label: '警告', value: last.summary.warn },
              { label: '错误', value: last.summary.error },
            ];
          },
        },
        {
          type: 'table',
          id: 'checks',
          label: '诊断结果',
          rowKey: 'key',
          empty: '还没有运行过诊断',
          columns: [
            { key: 'level', label: '级别', kind: 'status', primary: true },
            { key: 'category', label: '类别' },
            { key: 'id', label: '检查项', kind: 'code' },
            { key: 'message', label: '说明', primary: true },
            { key: 'detail', label: '详情', kind: 'long-text' },
          ],
          // 检查项的 id 可能重复（一个检查项回多条结果），行按报告里的次序标识
          data: () =>
            (registry.getLastReport()?.checks ?? []).map((check, i) => ({
              key: String(i),
              level: LEVELS[check.level],
              category: check.category,
              id: check.id,
              message: check.message,
              detail: check.detail,
            })),
        },
      ],
    });

    let notice: NoticeHandle | undefined;
    const registry = new DoctorRegistry({ logger, events }, report => {
      page.invalidate();
      const { error, warn } = report.summary;
      if (error + warn === 0) {
        notice?.clear();
        notice = undefined;
        return;
      }
      // 「诊断有 2 项错误、1 项警告」：只写不为零的
      const counts = [error && `${error} 项错误`, warn && `${warn} 项警告`].filter(Boolean);
      notice = webui.notify({
        id: 'checks',
        level: error > 0 ? 'error' : 'action',
        title: `诊断有 ${counts.join('、')}`,
        open: { page: 'doctor' },
      });
    });
    provide(doctor, registry);

    // 注册 builtin 检查项（与第三方插件走同一条注册路径，自然出现在 listChecks 里）
    registerBuiltinChecks(registry, plugins, services, hostConfig);

    // 注册 /doctor 命令 —— chat 与 CLI 通用入口。受限（等级 2）：报告带存储根的宿主路径、
    // 插件报错原文（其中可能有内网地址与端口），不该让群里人人都能看到
    commands
      .command('doctor', '运行系统诊断（环境 / 文件系统 / 插件状态）', { visibility: 'restricted' })
      .action(async () => {
        const report = await registry.runChecks();
        return formatReport(report);
      });
  },
});

// ===== Builtin checks（同样走 registerCheck，所有 check 一视同仁）=====
//
// 此处只保留「与领域无关、纯 doctor 自身职能」的检查项。原本的 fs.data 已迁出到
// plugin-storage-local，经 doctor 契约自行注册——避免 doctor 反向硬依赖业务插件。
//
// `plugins.status` 留在这里：它读 PluginManager（核心服务），不属于任何业务插件领域；
// 若未来 PluginManager 自带 self-check，可一并迁走。`services.preferences` 同理，读的是宿主配置与服务容器。
function registerBuiltinChecks(
  reg: DoctorRegistry,
  plugins: ServiceRef<PluginManagerService>,
  services: Services,
  host: ServiceRef<HostConfig>,
): void {
  reg.registerCheck({
    id: 'env.node',
    category: 'env',
    pluginName: PLUGIN_NAME,
    run() {
      const [major, minor] = nodeVersion.slice(1).split('.').map(Number);
      const supported = major > 24 || (major === 24 && minor >= 15);
      return {
        id: 'env.node',
        category: 'env',
        level: supported ? 'ok' : 'error',
        message: `Node ${nodeVersion}`,
        detail: supported
          ? undefined
          : '需要 Node 24.15.0 起；升级方法见 https://aalis.acenyan.com/guide/first-run#upgrade-node',
      };
    },
  });

  reg.registerCheck({
    id: 'env.platform',
    category: 'env',
    pluginName: PLUGIN_NAME,
    run() {
      return { id: 'env.platform', category: 'env', level: 'ok', message: `平台 ${platform}` };
    },
  });

  reg.registerCheck({
    id: 'plugins.status',
    category: 'plugins',
    pluginName: PLUGIN_NAME,
    run() {
      const pm = plugins.current;
      if (!pm) {
        return {
          id: 'plugins.service',
          category: 'plugins',
          level: 'warn',
          message: 'PluginManagerService 不可用，跳过插件检查',
        };
      }
      const status = pm.getStatus();
      const errored = status.filter(s => s.state === 'error');
      const active = status.filter(s => s.state === 'active');
      // 激活超过 core 慢操作阈值、已转入后台的（依赖它服务的插件在它完成前保持 pending）
      const slow = status.filter(s => s.state === 'activating' && s.slow);
      // 缺与在等：与 runtime 启动告警、WebUI 同一判据（api-doctor），缺的沿链追到根；只在等提供者启动的不算未就绪
      const unmet = [...unmetDependencies(status, services.names())];
      const lacking = unmet.filter(([, u]) => u.lacking.length > 0);
      const waiting = unmet.filter(([, u]) => u.lacking.length === 0 && u.waiting.length > 0);
      const lines = (entries: typeof unmet) => entries.map(([id, u]) => `${id}: ${describeUnmet(u)}`).join('\n');
      return [
        {
          id: 'plugins.active',
          category: 'plugins',
          level: 'ok',
          message: `已激活插件 ${active.length} 个 / 共 ${status.length} 个`,
        },
        {
          id: 'plugins.errored',
          category: 'plugins',
          level: errored.length === 0 ? 'ok' : 'error',
          message:
            errored.length === 0 ? '无错误状态插件' : `${errored.length} 个插件处于 error（激活失败或未在宽限内停止）`,
          detail: errored.length > 0 ? errored.map(p => `${p.instanceId}: ${p.error}`).join('\n') : undefined,
        },
        {
          id: 'plugins.pending',
          category: 'plugins',
          level: lacking.length === 0 ? 'ok' : 'warn',
          message: lacking.length === 0 ? '无未就绪插件' : `${lacking.length} 个插件缺服务，未就绪`,
          detail: lacking.length > 0 ? lines(lacking) : undefined,
        },
        ...(waiting.length > 0
          ? [
              {
                id: 'plugins.waiting',
                category: 'plugins' as const,
                level: 'ok' as const,
                message: `${waiting.length} 个插件在等别的插件启动`,
                detail: lines(waiting),
              },
            ]
          : []),
        {
          id: 'plugins.slow',
          category: 'plugins',
          level: slow.length === 0 ? 'ok' : 'warn',
          message: slow.length === 0 ? '无激活超时的插件' : `${slow.length} 个插件激活超过阈值，仍在后台进行`,
          detail:
            slow.length > 0
              ? [
                  ...slow.map(p => p.instanceId),
                  '等它完成即可；长时间不完成时看它的日志（多为在等网络或外部服务），停用再启用可重试',
                ].join('\n')
              : undefined,
        },
      ];
    },
  });

  // 配置文档里的服务偏好指向的提供者此刻不在这个服务里：偏好没有生效，服务落到了别的提供者上（模型删了、插件停用了）。
  // 每个这样的服务一条，写明实际在用哪个；服务容器的解析序是偏好 > 优先级 > 注册顺序，偏好不在时排第一的就是在用的
  reg.registerCheck({
    id: 'services.preferences',
    category: 'service',
    pluginName: PLUGIN_NAME,
    run() {
      const results: CheckResult[] = [];
      for (const [name, preferred] of Object.entries(host.current?.getServicePreferences() ?? {})) {
        const entries = services.inspect(name);
        if (entries.some(entry => entry.contextId === preferred)) continue;
        const [inUse] = entries;
        results.push({
          id: `services.preferences.${name}`,
          category: 'service',
          level: 'warn',
          message: `服务 ${name} 的偏好 ${preferred} 不在提供者里，没有生效`,
          detail: [
            inUse
              ? `实际在用：${inUse.label ? `${inUse.label}（${inUse.contextId}）` : inUse.contextId}`
              : '这个服务现在没有提供者',
            `改选偏好：配置文件的 servicePreferences.${name}，或 WebUI 设置「系统」的服务偏好；要用原来的，启用提供 ${preferred} 的插件`,
          ].join('\n'),
        });
      }
      return results.length > 0
        ? results
        : { id: 'services.preferences', category: 'service', level: 'ok', message: '没有未生效的服务偏好' };
    },
  });
}

// ===== helpers =====

export function formatReport(report: DoctorReport): string {
  // 聊天栏排版：按 level 分组，加换行，避免一坨平铺
  const byLevel = { error: [] as CheckResult[], warn: [] as CheckResult[], ok: [] as CheckResult[] };
  for (const c of report.checks) byLevel[c.level].push(c);

  const s = report.summary;
  const lines: string[] = [];
  lines.push(`**系统诊断 — ${formatLocalTime(report.generatedAt)}**`);
  lines.push(`汇总: ✓ ${s.ok}　! ${s.warn}　✗ ${s.error}`);
  lines.push('');

  const sections: Array<[CheckLevel, string]> = [
    ['error', '✗ 错误'],
    ['warn', '! 警告'],
    ['ok', '✓ 通过'],
  ];

  for (const [level, title] of sections) {
    const items = byLevel[level];
    if (items.length === 0) continue;
    lines.push(`__${title}__`);
    for (const c of items) {
      lines.push(`- \`${c.category}/${c.id}\` — ${c.message}`);
      if (c.detail) {
        for (const dl of c.detail.split('\n')) lines.push(`    ${dl}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
