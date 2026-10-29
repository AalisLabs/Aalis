import { platform } from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { type CheckLevel, doctor } from '../../packages/api-doctor/src/index.js';
import { type App, defineService, type Logger, provide } from '../../packages/core/src/index.js';
import doctorPlugin from '../../packages/plugin-doctor/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { defineTexts } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection, setHostLanguage } from '../fixtures/host-language.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 诊断页、内置检查项与「需要处理」的提示按全局层的语言：en 拿英文，zh-CN 与改动前逐字相同。真的 plugin-doctor、
// webui-server 与 plugin-i18n，全局语言写在宿主配置文档里；测试另登记一个检查项，按 levels 交出几条结果，造出错误与警告。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-doctor-i18n-token-placeholder';
const DOCTOR = '@aalis/plugin-doctor';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const t = defineTexts({
  ns: '@zz/doctor-i18n',
  language: 'zh-CN',
  source: { provider: '甲提供者' } as const,
  locales: { en: { provider: 'Provider A' } },
});
const zzService = defineService<object>('zz-svc');

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(servicePreferences: Record<string, string> = {}) {
  const port = await freePort();
  const { app } = hostedApp({ ...i18nSection(['en']), servicePreferences }, { logger: silent });
  apps.push(app);
  await app.plugin(i18nPlugin);
  await app.plugin(doctorPlugin);
  await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  const host = app.bind({ provide, doctor });
  /** 测试检查项这一次交出的结果的级别 */
  const levels: CheckLevel[] = [];
  host.doctor.use.registerCheck({
    id: 'zz.extra',
    category: 'other',
    run: () => levels.map((level, i) => ({ id: `zz.extra.${i}`, category: 'other' as const, level, message: 'zz' })),
  });
  const request = async (path: string, init: RequestInit = {}) =>
    (
      await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { cookie: `aalis_webui_token=${TOKEN}`, 'content-type': 'application/json' },
      })
    ).json();
  const at = `/api/pages/${encodeURIComponent(DOCTOR)}/doctor`;
  /** 点「立即运行」，回动作的回执 */
  const run = async (...next: CheckLevel[]) => {
    levels.splice(0, levels.length, ...next);
    return (await request(`${at}/actions/runDiagnostics`, { method: 'POST', body: '{}' })).message;
  };
  const rows = async (): Promise<Array<Record<string, unknown>>> => (await request(`${at}/data/checks`)).data;
  const summary = async () => (await request(`${at}/data/summary`)).data;
  const notices = async () =>
    (await request('/api/attention')).items
      .filter((item: { kind: string }) => item.kind === 'notice')
      .map((item: { title: string }) => item.title);
  const plugins = () => app.plugins.getStatus();
  return {
    host,
    run,
    rows,
    summary,
    notices,
    plugins,
    setLanguage: (l: string[]) => setHostLanguage(app, l),
  };
}

/** 本插件的内置检查项与测试检查项的一行：级别、类别、检查项与说明（别的插件登记的检查项不看） */
const OWN = /^(env|plugins|services|zz)\./;
const own = (rows: Array<Record<string, unknown>>) =>
  rows
    .filter(row => OWN.test(String(row.id)))
    .map(row => [(row.level as { text: string }).text, row.category, row.id, row.message]);

const ENGLISH = {
  unrun: [{ label: 'Time', value: 'Not run yet' }],
  summaryLabels: ['Time', 'Passed', 'Warnings', 'Errors'],
  ran: (ok: number) => `Diagnostics finished: ${ok} passed, 1 warning, 0 errors`,
  rows: (active: number, total: number) => [
    ['Passed', 'Environment', 'env.node', `Node ${process.version}`],
    ['Passed', 'Environment', 'env.platform', `Platform ${platform}`],
    ['Passed', 'Plugins', 'plugins.active', `${active} of ${total} plugins active`],
    ['Passed', 'Plugins', 'plugins.errored', 'No plugins in the error state'],
    ['Passed', 'Plugins', 'plugins.pending', 'No plugins missing services'],
    ['Passed', 'Plugins', 'plugins.slow', 'No plugins over the activation threshold'],
    ['Passed', 'Service', 'services.preferences', 'All service preferences are in effect'],
    ['Warning', 'Other', 'zz.extra.0', 'zz'],
  ],
  notices: ['Diagnostics found 2 errors and 1 warning', 'Diagnostics found 1 error', 'Diagnostics found 2 warnings'],
};

const CHINESE = {
  unrun: [{ label: '时间', value: '尚未运行' }],
  summaryLabels: ['时间', '通过', '警告', '错误'],
  ran: (ok: number) => `诊断完成：${ok} 项通过、1 项警告、0 项错误`,
  rows: (active: number, total: number) => [
    ['通过', '环境', 'env.node', `Node ${process.version}`],
    ['通过', '环境', 'env.platform', `平台 ${platform}`],
    ['通过', '插件', 'plugins.active', `已激活插件 ${active} 个 / 共 ${total} 个`],
    ['通过', '插件', 'plugins.errored', '无错误状态插件'],
    ['通过', '插件', 'plugins.pending', '无缺服务的插件'],
    ['通过', '插件', 'plugins.slow', '无激活超时的插件'],
    ['通过', '服务', 'services.preferences', '没有未生效的服务偏好'],
    ['警告', '其他', 'zz.extra.0', 'zz'],
  ],
  notices: ['诊断有 2 项错误、1 项警告', '诊断有 1 项错误', '诊断有 2 项警告'],
};

describe('诊断页与内置检查项按全局层的语言', () => {
  it.each([
    ['en', ENGLISH],
    ['zh-CN', CHINESE],
  ])('%s：上次运行、动作回执、结果表（级别、类别与内置检查项的说明）', async (language, expected) => {
    const s = await setup();
    s.setLanguage([language]);
    const before = { unrun: await s.summary() };
    const ran = await s.run('warn');
    const status = s.plugins();
    const active = status.filter(p => p.state === 'active').length;
    const rows = await s.rows();
    expect({
      ...before,
      summaryLabels: (await s.summary()).map((row: { label: string }) => row.label),
      ran,
      rows: own(rows),
    }).toEqual({
      unrun: expected.unrun,
      summaryLabels: expected.summaryLabels,
      // 测试检查项那一条是警告，其余都通过
      ran: expected.ran(rows.length - 1),
      rows: expected.rows(active, status.length),
    });
  });

  it.each([
    ['en', ENGLISH.notices],
    ['zh-CN', CHINESE.notices],
  ])('%s：「需要处理」的提示标题按错误数与警告数（两项错误一项警告、只有错误、只有警告）', async (language, expected) => {
    const s = await setup();
    s.setLanguage([language]);
    const titles = [];
    for (const levels of [['error', 'error', 'warn'], ['error'], ['warn', 'warn']] as CheckLevel[][]) {
      await s.run(...levels);
      titles.push(...(await s.notices()));
    }
    expect(titles).toEqual(expected);
  });

  it.each([
    ['en', ['Actually in use: Provider A (zz-p)', 'Actually in use: zz-q']],
    ['zh-CN', ['实际在用：甲提供者（zz-p）', '实际在用：zz-q']],
  ])('%s：偏好落空、在用的提供者的标签是文字对象：详情写出它的名字；没有标签时只写 id', async (language, expected) => {
    const s = await setup({ 'zz-svc': 'zz-missing', 'zz-other': 'zz-missing' });
    s.setLanguage([language]);
    s.host.provide.use(zzService, {}, { entryId: 'zz-p', label: t('provider') });
    s.host.provide.use(defineService<object>('zz-other'), {}, { entryId: 'zz-q' });
    await s.run();
    const details = (await s.rows())
      .filter(row => String(row.id).startsWith('services.preferences.'))
      .map(row => String(row.detail).split('\n')[0]);
    expect(details).toEqual(expected);
  });
});
