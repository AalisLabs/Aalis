import { version as nodeVersion, platform } from 'node:process';
import { commands } from '@aalis/api-commands';
import {
  type CheckCategory,
  type CheckLevel,
  type CheckResult,
  type CheckSpec,
  type DoctorReport,
  type DoctorService,
  doctor,
} from '@aalis/api-doctor';
import { type WebuiPage, webuiServer } from '@aalis/api-webui';
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
} from '@aalis/core';

const PLUGIN_NAME = '@aalis/plugin-doctor';

const uses = {
  provide,
  logger,
  events,
  plugins: optional(pluginsService),
  commands: optional(commands),
  webui: optional(webuiServer),
};
type Caps = BoundOf<typeof uses>;

// ===== Registry =====

class DoctorRegistry implements DoctorService {
  private last: DoctorReport | undefined;
  private readonly specs = new Map<string, CheckSpec>();

  constructor(private readonly caps: Pick<Caps, 'logger' | 'events'>) {}

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

    // 通知 WebUI 同步刷新（webui-server 监听并广播到所有连接的客户端）
    this.caps.events.emit('doctor:updated', { generatedAt: this.last.generatedAt, summary }).catch(() => {});

    return this.last;
  }
}

// ===== WebUI 页面 =====

const webuiPages: WebuiPage[] = [
  {
    key: 'doctor',
    label: '系统诊断',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    order: 90,
    content: [
      {
        type: 'actions',
        label: '运行诊断',
        items: [{ label: '立即运行', method: 'runChecks' }],
      },
      {
        type: 'info',
        label: '上次运行时间',
        source: 'getLastRunAt',
      },
      {
        type: 'table',
        label: '最近一次诊断结果',
        source: 'getReport',
        columns: [
          { key: 'level', label: '级别' },
          { key: 'category', label: '类别' },
          { key: 'id', label: '检查项' },
          { key: 'message', label: '说明' },
          { key: 'detail', label: '详情' },
        ],
      },
    ],
  },
];

// ===== 插件入口 =====

export default definePlugin({
  name: PLUGIN_NAME,
  displayName: '系统诊断',
  subsystem: 'platform',
  provides: [doctor],
  uses,
  apply({ provide, logger, events, plugins, commands, webui }) {
    const registry = new DoctorRegistry({ logger, events });
    provide(doctor, registry);

    // 注册 builtin 检查项（与第三方插件走同一条注册路径，自然出现在 listChecks 里）
    registerBuiltinChecks(registry, plugins);

    for (const page of webuiPages) webui.registerPage(page);

    // 页面动作直接闭包本次激活的 registry：页面属于本插件，不该去查「当前胜出的 doctor」
    webui.registerAction('runChecks', () => registry.runChecks());
    webui.registerAction('getReport', async () => registry.getLastReport()?.checks ?? []);
    webui.registerAction('getLastRunAt', async () => {
      const last = registry.getLastReport();
      if (!last) return { value: '尚未运行' };
      const s = last.summary;
      return { value: `${formatLocalTime(last.generatedAt)} — ok=${s.ok} warn=${s.warn} error=${s.error}` };
    });

    // 注册 /doctor 命令 —— chat 与 CLI 通用入口
    commands.command('doctor', '运行系统诊断（环境 / 文件系统 / 插件状态）').action(async () => {
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
// 若未来 PluginManager 自带 self-check，可一并迁走。
function registerBuiltinChecks(reg: DoctorRegistry, plugins: ServiceRef<PluginManagerService>): void {
  reg.registerCheck({
    id: 'env.node',
    category: 'env',
    pluginName: PLUGIN_NAME,
    run() {
      const major = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
      return {
        id: 'env.node',
        category: 'env',
        level: major >= 22 ? 'ok' : 'error',
        message: `Node ${nodeVersion}`,
        detail: major >= 22 ? undefined : '推荐 Node ≥ 22',
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
      const pending = status.filter(s => s.state === 'pending');
      const active = status.filter(s => s.state === 'active');
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
          message: errored.length === 0 ? '无错误状态插件' : `${errored.length} 个插件 apply() 失败`,
          detail: errored.length > 0 ? errored.map(p => `${p.instanceId}: ${p.error}`).join('\n') : undefined,
        },
        {
          id: 'plugins.pending',
          category: 'plugins',
          level: pending.length === 0 ? 'ok' : 'warn',
          message: pending.length === 0 ? '无未就绪插件' : `${pending.length} 个插件 required deps 未满足`,
          detail: pending.length > 0 ? pending.map(p => p.instanceId).join(', ') : undefined,
        },
      ];
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
