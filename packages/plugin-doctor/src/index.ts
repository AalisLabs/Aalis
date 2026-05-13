import { existsSync } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { version as nodeVersion, platform } from 'node:process';
import type { Context, PluginManagerService } from '@aalis/core';
import type { CommandService } from '@aalis/plugin-commands-api';
import { useCommandService } from '@aalis/plugin-commands-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';

// ===== 元数据 =====

export const name = '@aalis/plugin-doctor';
export const displayName = '系统诊断';
export const subsystem = 'platform';
export const provides = ['doctor'];
export const inject = {
  optional: ['plugins', 'commands'],
};

// ===== 类型 =====

export type CheckLevel = 'ok' | 'warn' | 'error';
export type CheckCategory = 'env' | 'filesystem' | 'plugins' | 'config' | 'service' | 'other';

export interface CheckResult {
  id: string;
  category: CheckCategory;
  level: CheckLevel;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  generatedAt: string;
  summary: { ok: number; warn: number; error: number };
  checks: CheckResult[];
}

/** 检查项定义：插件通过 `registerCheck` 注册到 DoctorService */
export interface CheckSpec {
  /** 唯一 id，如 'memory.connectivity'；重复注册以最后一次为准 */
  id: string;
  /** 检查分类，影响表格分组与默认排序 */
  category: CheckCategory;
  /** 可选标签：仅用于日志/调试显示 */
  label?: string;
  /** 来源插件名，自动由 DoctorService 注入；外部传入也可 */
  pluginName?: string;
  /** 执行函数：返回 1~N 条结果（一个 spec 可输出多条相关 check） */
  run(ctx: Context): Promise<CheckResult | CheckResult[]> | CheckResult | CheckResult[];
}

export interface DoctorService {
  /** 同步运行所有检查，返回报告 */
  runChecks(): Promise<DoctorReport>;
  /** 取上一次报告（未运行过返回 undefined） */
  getLastReport(): DoctorReport | undefined;
  /**
   * 注册检查项。返回 dispose 函数；同 id 重复注册以最后一次为准。
   * 其他插件应在 apply() 中调用以贡献自我诊断。
   */
  registerCheck(spec: CheckSpec): () => void;
  /** 列出当前所有已注册的检查项（id + category + pluginName） */
  listChecks(): Array<{ id: string; category: CheckCategory; pluginName?: string }>;
}

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    doctor: 'diagnose';
  }
  interface AalisEvents {
    /** 一次诊断完成后发射，供 WebUI 等订阅者即时刷新 */
    'doctor:updated': [info: { generatedAt: string; summary: { ok: number; warn: number; error: number } }];
  }
}

// ===== Registry =====

class DoctorRegistry implements DoctorService {
  private last: DoctorReport | undefined;
  private readonly specs = new Map<string, CheckSpec>();

  constructor(private readonly ctx: Context) {}

  getLastReport(): DoctorReport | undefined {
    return this.last;
  }

  registerCheck(spec: CheckSpec): () => void {
    if (this.specs.has(spec.id)) {
      this.ctx.logger.debug(`doctor: 检查项 ${spec.id} 被覆盖注册`);
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
        const r = await spec.run(this.ctx);
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
    this.ctx.emit('doctor:updated', { generatedAt: this.last.generatedAt, summary }).catch(() => {});

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

// ===== Actions（供 WebUI 调用） =====

export const actions = {
  async runChecks(ctx: Context): Promise<DoctorReport | undefined> {
    return ctx.getService<DoctorService>('doctor')?.runChecks();
  },
  async getReport(ctx: Context): Promise<CheckResult[]> {
    return ctx.getService<DoctorService>('doctor')?.getLastReport()?.checks ?? [];
  },
  async getLastRunAt(ctx: Context): Promise<{ value: string }> {
    const last = ctx.getService<DoctorService>('doctor')?.getLastReport();
    if (!last) return { value: '尚未运行' };
    const s = last.summary;
    return { value: `${formatLocalTime(last.generatedAt)} — ok=${s.ok} warn=${s.warn} error=${s.error}` };
  },
};

// ===== apply =====

export function apply(ctx: Context, _config: Record<string, unknown>): void {
  const registry = new DoctorRegistry(ctx);
  ctx.provide('doctor', registry, { capabilities: ['diagnose'] });

  // 注册 builtin 检查项（与第三方插件走同一条注册路径，自然出现在 listChecks 里）
  registerBuiltinChecks(registry);

  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  // 注册 /doctor 命令 —— chat 与 CLI 通用入口
  useCommandService(ctx)
    .command('doctor', '运行系统诊断（环境 / 文件系统 / 插件状态）')
    .action(async () => {
      const report = await registry.runChecks();
      return formatReport(report);
    });
}

// ===== Builtin checks（同样走 registerCheck，所有 check 一视同仁） =====

function registerBuiltinChecks(reg: DoctorRegistry): void {
  reg.registerCheck({
    id: 'env.node',
    category: 'env',
    pluginName: '@aalis/plugin-doctor',
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
    pluginName: '@aalis/plugin-doctor',
    run() {
      return { id: 'env.platform', category: 'env', level: 'ok', message: `平台 ${platform}` };
    },
  });

  reg.registerCheck({
    id: 'fs.data',
    category: 'filesystem',
    pluginName: '@aalis/plugin-doctor',
    async run() {
      const dataDir = resolve(process.cwd(), 'data');
      return checkWritable('fs.data', dataDir, '数据目录');
    },
  });

  reg.registerCheck({
    id: 'plugins.status',
    category: 'plugins',
    pluginName: '@aalis/plugin-doctor',
    run(ctx) {
      const pm = ctx.getService<PluginManagerService>('plugins');
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

  reg.registerCheck({
    id: 'commands.overrides',
    category: 'config',
    pluginName: '@aalis/plugin-doctor',
    run(ctx) {
      const cmds = ctx.getService<CommandService>('commands');
      if (!cmds) {
        return { id: 'commands.overrides', category: 'config', level: 'warn', message: 'commands 服务不可用' };
      }
      const overrides = cmds.getOverrides();
      const known = new Set(cmds.getAll().map(c => c.name));
      const orphan = Object.keys(overrides).filter(k => !known.has(k));
      return {
        id: 'commands.overrides',
        category: 'config',
        level: orphan.length === 0 ? 'ok' : 'warn',
        message:
          orphan.length === 0
            ? `已注册指令 ${known.size} 个；覆盖配置 ${Object.keys(overrides).length} 条全部命中`
            : `commandOverrides 含 ${orphan.length} 条孤立键（无对应指令）`,
        detail: orphan.length > 0 ? orphan.join(', ') : undefined,
      };
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

async function checkWritable(id: string, dir: string, label: string): Promise<CheckResult> {
  try {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const probe = resolve(dir, `.doctor-${Date.now()}`);
    await writeFile(probe, 'ok');
    await stat(probe);
    await unlink(probe);
    return { id, category: 'filesystem', level: 'ok', message: `${label} ${dir} 可写` };
  } catch (err) {
    return {
      id,
      category: 'filesystem',
      level: 'error',
      message: `${label} ${dir} 不可写`,
      detail: String(err),
    };
  }
}
