import { existsSync } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv, version as nodeVersion, platform } from 'node:process';
import type { Context, PluginManagerService } from '@aalis/core';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';

// ===== 元数据 =====

export const name = '@aalis/plugin-doctor';
export const displayName = '系统诊断';
export const subsystem = 'platform';
export const provides = ['doctor'];
export const inject = {
  optional: ['app', 'plugins'],
};

// ===== 类型 =====

export type CheckLevel = 'ok' | 'warn' | 'error';

export interface CheckResult {
  /** 检查项 id，用于稳定排序与 webui 渲染 */
  id: string;
  /** 检查项归属分类 */
  category: 'env' | 'config' | 'filesystem' | 'plugins';
  level: CheckLevel;
  /** 一行短消息 */
  message: string;
  /** 可选详细信息 / 建议 */
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
}

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    doctor: 'diagnose';
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

let lastReport: DoctorReport | null = null;

export const actions = {
  async runChecks(ctx: Context): Promise<DoctorReport> {
    const svc = ctx.getService<DoctorService>('doctor');
    if (!svc) return emptyReport();
    lastReport = await svc.runChecks();
    return lastReport;
  },
  async getReport(_ctx: Context): Promise<CheckResult[]> {
    return lastReport ? lastReport.checks : [];
  },
};

function emptyReport(): DoctorReport {
  return {
    generatedAt: new Date().toISOString(),
    summary: { ok: 0, warn: 0, error: 0 },
    checks: [],
  };
}

// ===== apply =====

export function apply(ctx: Context, _config: Record<string, unknown>): void {
  // 注册 WebUI 页面
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  const service: DoctorService = {
    async runChecks(): Promise<DoctorReport> {
      const checks: CheckResult[] = [];

      // ----- env 检查 -----
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

      // ----- filesystem 检查 -----
      const cwd = process.cwd();
      const dataDir = resolve(cwd, 'data');
      checks.push(await checkWritable('fs.data', dataDir, '数据目录'));

      // ----- 配置 / 插件键拼写 -----
      const all = ctx.config.getAll();
      const declaredKeys = Object.keys(all.plugins ?? {});
      const pm = ctx.getService<PluginManagerService>('plugins');
      const knownNames = new Set<string>();
      if (pm) {
        for (const p of pm.getStatus()) {
          knownNames.add(p.name);
          knownNames.add(p.instanceId);
        }
      }
      const unknownKeys = declaredKeys.filter(k => {
        if (knownNames.has(k)) return false;
        const moduleName = k.includes(':') ? k.slice(0, k.lastIndexOf(':')) : k;
        return !knownNames.has(moduleName);
      });
      checks.push({
        id: 'config.plugin-keys',
        category: 'config',
        level: unknownKeys.length === 0 ? 'ok' : 'warn',
        message:
          unknownKeys.length === 0
            ? `配置中 ${declaredKeys.length} 个插件键全部可识别`
            : `配置中有 ${unknownKeys.length} 个未识别的插件键`,
        detail: unknownKeys.length > 0 ? unknownKeys.join(', ') : undefined,
      });

      // ----- 插件状态 -----
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

      lastReport = {
        generatedAt: new Date().toISOString(),
        summary,
        checks,
      };
      return lastReport;
    },
  };

  ctx.provide('doctor', service, { capabilities: ['diagnose'] });

  // 提供 argv 触发：如果进程参数含 'doctor'，立即跑一次并打印（非阻塞）。
  // 真正的 CLI 入口在 src/index.ts；这里只在已经 boot 的场景下作为冗余兜底。
  if (argv.includes('doctor')) {
    void service.runChecks().then(report => printReport(report, ctx));
  }
}

// ===== helpers =====

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

function printReport(report: DoctorReport, ctx: Context): void {
  const logger = ctx.logger.child('doctor');
  for (const c of report.checks) {
    const tag = c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗';
    logger.info(`[${tag}] ${c.category}/${c.id} — ${c.message}`);
    if (c.detail) logger.info(`    ${c.detail}`);
  }
  logger.info(`汇总: ok=${report.summary.ok} warn=${report.summary.warn} error=${report.summary.error}`);
}
