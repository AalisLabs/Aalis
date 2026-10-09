import axe from 'axe-core';
import type { Page, Viewport } from 'puppeteer';
import { describe, expect, it } from 'vitest';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { definePlugin, type PluginDefinition } from '../../packages/core/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import {
  aria,
  framePackage,
  onViewport,
  openWebui,
  sessionIdOf,
  text,
  useWebuiE2E,
  VIEWPORTS,
  webuiStack,
} from '../fixtures/webui-e2e.js';
import { waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 无障碍：axe-core 经 DevTools 协议注入页面（不受页面的 CSP 管），深色主题下按桌面与手机两种宽度走主要页面——首页、
// 会话页（审批卡等着）与「后台」标签、房间表、插件区与插件详情、设置各节、运行状况、一个声明式页面（用户档案）与一个
// 插件前端页面的宿主外围（框架里是插件自己的页面，不查）；浅色只在桌面走首页与会话页。没有「严重」「关键」两级的问题
// ════════════════════════════════════════════════════════════

/** 要批准的工具与可转后台的工具 */
const DEPLOY = 'zz_deploy';
const JOB = 'zz_job';
const MOVED = '转到后台了。';
const ROOM = 'onebot:10000:group:20001';
const FRAMES = 'zz-a11y-frames';

/** 假模型：辅助调用回标题；「后台跑」叫可转后台的工具并带 runInBackground，「部署」叫要批准的工具 */
function script(request: ChatModelRequest): ChatResponse {
  if (!request.tools) return { content: '无障碍检查' };
  const last = request.messages.at(-1);
  if (last?.role === 'tool') return { content: String(last.content).includes('"taskId"') ? MOVED : '好的。' };
  const said = String(last?.content ?? '');
  const call = (name: string, args: Record<string, unknown>) => ({
    content: null,
    toolCalls: [{ id: `call-${name}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
  });
  if (said.includes('后台跑')) return call(JOB, { command: 'build', runInBackground: true });
  if (said.includes('部署')) return call(DEPLOY, { command: 'deploy --prod' });
  return { content: '你好。' };
}

/** 两个工具：部署要 owner 批准；任务一直跑到被中止 */
const probeTools = definePlugin({
  name: 'zz-a11y-tools',
  uses: { tools },
  apply({ tools }) {
    const parameters = { type: 'object' as const, properties: { command: { type: 'string' } } };
    tools.register({
      confirm: 'session',
      display: { kind: 'command', fields: { command: 'command' } },
      definition: { type: 'function', function: { name: DEPLOY, description: '部署', parameters } },
      handler: async () => '已部署',
    });
    tools.register({
      display: { kind: 'command', fields: { command: 'command' } },
      background: { yieldSeconds: 1 },
      definition: { type: 'function', function: { name: JOB, description: '跑一个命令', parameters } },
      handler: (_args, ctx) =>
        new Promise(resolve => {
          ctx.output?.('第 1 行\n');
          ctx.signal?.addEventListener('abort', () => resolve(JSON.stringify({ exitCode: 143 })), { once: true });
        }),
    });
  },
});

const e2e = useWebuiE2E();
const { cleanups } = e2e;

/** 插件前端页面的测试插件：包搭在临时目录里，页面只有一段字 */
function framesPlugin(): PluginDefinition {
  const module = framePackage(
    FRAMES,
    {
      'page.html':
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>便签</title><p>插件自己的页面</p></html>',
    },
    cleanups,
  );
  return definePlugin({
    name: FRAMES,
    displayName: '便签',
    uses: { webui: webuiServer },
    apply({ webui }) {
      webui.definePage({ key: 'notes', title: '便签', frame: { module, entry: 'page.html' } });
    },
  });
}

/** 起运行时：minimal 档加两个工具、用户档案与插件前端；一个房间、一份档案 */
async function start() {
  const { app, port } = await webuiStack({
    clientDir: e2e.clientDir,
    model: createMockLLMPlugin({ responses: script, latencyMs: 10 }),
    extra: [probeTools, userProfile, framesPlugin()],
    cleanups,
    rooms: { [ROOM]: '读书会' },
  });
  await app.start();
  await waitListening(port);
  const host = app.bind({ memory });
  await host.memory.require().saveMetadata('user:profile', 'onebot:10001', {
    facts: [{ id: 'f1', text: '喜欢读科幻小说', temporality: 'permanent', observedAt: 1, updatedAt: 1 }],
    updatedAt: 1,
  });
  return `http://127.0.0.1:${port}`;
}

type AxeWindow = Window & { axe: typeof axe };

/** 查这一页：「严重」「关键」两级的问题逐条写成「页面：规则（级别）说明：元素」 */
async function scan(page: Page, where: string): Promise<string[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(axe.source);
  const { violations } = await page.evaluate(() =>
    (window as unknown as AxeWindow).axe.run(document, { resultTypes: ['violations'], iframes: false }),
  );
  return violations
    .filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      violation =>
        `${where}：${violation.id}（${violation.impact}）${violation.help}：${violation.nodes
          .map(node => node.target.join(' '))
          .join('、')}`,
    );
}

/** 开一个会话：先把一个命令转到后台，再叫要批准的工具，审批卡等着 */
async function sessionWaitingApproval(page: Page, phone: boolean): Promise<string> {
  const { newSession, send } = onViewport(phone);
  await newSession(page);
  await send(page, '后台跑 build');
  const sessionId = await sessionIdOf(page);
  await page.waitForSelector(text(MOVED));
  await send(page, '部署一下');
  await page.waitForSelector(aria('审批', 'region'));
  return sessionId;
}

async function opened(viewport: Viewport, scheme: 'dark' | 'light') {
  const origin = await start();
  const { page, problems } = await openWebui(e2e.browser, origin, viewport, cleanups);
  // 关掉过渡：按钮换形态时文字颜色立即变、背景色渐变，扫描落在过渡里会把半途的颜色量成对比度不足
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: scheme },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  await page.waitForFunction(scheme => document.documentElement.dataset.theme === `calm-${scheme}`, {}, scheme);
  return { origin, page, problems };
}

describe.each(Object.entries(VIEWPORTS))('%s，深色', (width, viewport) => {
  const phone = width === 'phone';

  it('主要页面没有严重、关键两级的问题', async () => {
    const { origin, page, problems } = await opened(viewport, 'dark');
    // 手机上首页是第一层：会话列表与入口，输入框在下一层
    await page.waitForSelector(phone ? aria('新会话', 'button') : aria('消息', 'textbox'));
    const found = await scan(page, '首页');

    const sessionId = await sessionWaitingApproval(page, phone);
    found.push(...(await scan(page, '会话页')));
    const go = async (path: string, ready: string, where: string) => {
      await page.goto(`${origin}${path}`);
      await page.waitForSelector(ready);
      found.push(...(await scan(page, where)));
    };
    await go(
      `/s/${encodeURIComponent(sessionId)}/background`,
      `aside ${aria('工具调用 · 1', 'region')}`,
      '「后台」标签',
    );
    await go('/rooms?platform=onebot', `td[data-column="name"] ${text('读书会')}`, '房间表');
    await go('/plugins', 'nav[aria-label="插件"] a[href="/market"]', '插件区');
    await go(`/plugins/${encodeURIComponent(userProfile.name)}`, 'main .plugin-detail', '插件详情');
    // 设置的各节：取目录里列的（桌面上 /settings 落到第一节、目录在左栏，手机上 /settings 就是目录）
    await page.goto(`${origin}/settings`);
    await page.waitForSelector('nav[aria-label="设置"] a');
    const sections = await page.$$eval('nav[aria-label="设置"] a', links =>
      links.map(link => link.getAttribute('href') ?? ''),
    );
    expect(sections).toContain('/settings/system');
    for (const section of sections) await go(section, 'main .page-screen', `设置 ${section}`);
    await go('/health', `main ${aria('需要处理', 'region')}`, '运行状况');
    await go(
      `/p/${encodeURIComponent(userProfile.name)}/profiles`,
      `main ${text('onebot:10001')}`,
      '声明式页面（用户档案）',
    );
    await go(`/p/${FRAMES}/notes`, 'main iframe', '插件前端的宿主外围');

    expect(found).toEqual([]);
    expect(problems).toEqual([]);
  }, 120_000);
});

describe('desktop，浅色', () => {
  it('首页与会话页没有严重、关键两级的问题', async () => {
    const { page, problems } = await opened(VIEWPORTS.desktop, 'light');
    await page.waitForSelector(aria('消息', 'textbox'));
    const found = await scan(page, '首页');
    await sessionWaitingApproval(page, false);
    found.push(...(await scan(page, '会话页')));
    expect(found).toEqual([]);
    expect(problems).toEqual([]);
  }, 90_000);
});
