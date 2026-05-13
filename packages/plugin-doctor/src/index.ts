import { existsSync } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { version as nodeVersion, platform } from 'node:process';
import type { Context, PluginManagerService } from '@aalis/core';
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

export interface CheckResult {
  id: string;
  category: 'env' | 'filesystem' | 'plugins';
  level: CheckLevel;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  generatedAt: string;
  summary: { ok: number; warn: number; error: number };
  checks: CheckResult[];
}

export interface DoctorService {
  /** 同步运行所有检查，返回报告 */
  runChecks(): Promise<DoctorReport>;
  /** 取上一次报告（未运行过返回 undefined） */
  getLastReport(): DoctorReport | undefined;
}

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    doctor: 'diagnose';
  }
}

// ===== Registry =====

/** 把状态封到 class 实例里，避免模块级单例污染 */
class DoctorRegistry implements DoctorService {
  private last: DoctorReport | undefined;

  constructor(private readonly ctx: Context) {}

  getLastReport(): DoctorReport | undefined {
    return this.last;
  }

  async runChecks(): Promise<DoctorReport> {
    const checks: CheckResult[] = [];

    // env
    const major = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
    checks.push({
      id: 'env.node',
      category: 'env',
      level: major >= 22 ? 'ok' : 'error',
      message: `Node ${nodeVersion}`,
      detail: major >= 22 ? undefined : '推荐 Node ≥ 22',
    });
    checks.push({
      id: 'env.platform',
      category: 'env',
      level: 'ok',
      message: `平台 ${platform}`,
    });

    // filesystem
    const dataDir = resolve(process.cwd(), 'data');
    checks.push(await checkWritable('fs.data', dataDir, '数据目录'));

    // plugins
    const pm = this.ctx.getService<PluginManagerService>('plugins');
    if (pm) {
      const status = pm.getStatus();
      const errored = status.filter(s => s.state === 'error');
      const pending = status.filter(s => s.state === 'pending');
      const active = status.filter(s => s.state === 'active');
      checks.push({
        id: 'plugins.active',
        category: 'plugins',
        level: 'ok',
        message: `已激活插件 ${active.length} 个 / 共 ${status.length} 个`,
      });
      checks.push({
        id: 'plugins.errored',
        category: 'plugins',
        level: errored.length === 0 ? 'ok' : 'error',
        message: errored.length === 0 ? '无错误状态插件' : `${errored.length} 个插件 apply() 失败`,
        detail: errored.length > 0 ? errored.map(p => `${p.instanceId}: ${p.error}`).join('\n') : undefined,
      });
      checks.push({
        id: 'plugins.pending',
        category: 'plugins',
        level: pending.length === 0 ? 'ok' : 'warn',
        message: pending.length === 0 ? '无未就绪插件' : `${pending.length} 个插件 required deps 未满足`,
        detail: pending.length > 0 ? pending.map(p => p.instanceId).join(', ') : undefined,
      });
    } else {
      checks.push({
        id: 'plugins.service',
        category: 'plugins',
        level: 'warn',
        message: 'PluginManagerService 不可用，跳过插件检查',
      });
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
};

// ===== apply =====

export function apply(ctx: Context, _config: Record<string, unknown>): void {
  const registry = new DoctorRegistry(ctx);
  ctx.provide('doctor', registry, { capabilities: ['diagnose'] });

  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  // 注册 /doctor 命令 —— chat 与 CLI 通用入口
  useCommandService(ctx).command('doctor', '运行系统诊断（环境 / 文件系统 / 插件状态）', async () => {
    const report = await registry.runChecks();
    return formatReport(report);
  });
}

// ===== helpers =====

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    const tag = c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗';
    lines.push(`[${tag}] ${c.category}/${c.id} — ${c.message}`);
    if (c.detail) lines.push(`    ${c.detail}`);
  }
  lines.push(`\n汇总: ok=${report.summary.ok} warn=${report.summary.warn} error=${report.summary.error}`);
  return lines.join('\n');
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
