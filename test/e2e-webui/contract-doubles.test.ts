import { describe, expect, it } from 'vitest';
import { approvals } from '../../packages/api-approval/src/index.js';
import { checkpoint, type RollbackResult } from '../../packages/api-checkpoint/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { compression } from '../../packages/api-memory/src/index.js';
import { type TodoItem, todoList } from '../../packages/api-todo-list/src/index.js';
import { type BackgroundTask, backgroundTasks, tools } from '../../packages/api-tools/src/index.js';
import { definePlugin, type Events, events, provide, services } from '../../packages/core/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import {
  aria,
  onViewport,
  openWebui,
  sessionIdOf,
  text,
  toastSays,
  useWebuiE2E,
  VIEWPORTS,
  webuiStack,
} from '../fixtures/webui-e2e.js';
import { waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 契约中立的端到端：检查点、待办与压缩由一个测试插件提供（不装第一方的检查点、待办与摘要插件），审批由一个不是授权插件的
// 测试插件经 approvals.request 发起，后台任务登记由另一个测试插件提供、经服务偏好压过执行器自带的那一份。界面只认契约，
// 换成这些替身照样出现审批卡、压缩线、计划标签、「后台」标签与运行状况的「正在运行」、回滚与回滚确认。
// 桌面与手机两种宽度各走一遍。
// ════════════════════════════════════════════════════════════

/** 发起审批的测试工具：参数里的标题照原样进审批卡 */
const PUBLISH = 'zz_publish';
const TITLE = '季度周报';
/** 后台任务登记替身里在跑的那个任务的显示名与最后一行 */
const LONG_TASK = 'zz_long';
const LAST_LINE = '整理到第 3 节';
const PLAN: TodoItem[] = [{ id: 1, title: '核对替身的计划', status: 'in-progress' }];
const AUTO_COMPRESS = 0.8;

/** 假模型：没带工具定义的辅助调用回固定标题；「发布」叫发起审批的测试工具，工具返回之后照结果收尾 */
function script(request: ChatModelRequest): ChatResponse {
  if (!request.tools) return { content: '替身会话' };
  const last = request.messages.at(-1);
  if (last?.role === 'tool') return { content: last.content === '已发布' ? '发布好了。' : '没有发布。' };
  return {
    content: null,
    toolCalls: [
      { id: 'call-1', type: 'function', function: { name: PUBLISH, arguments: JSON.stringify({ title: TITLE }) } },
    ],
  };
}

/** 替身拿到的事件总线：激活之后才有 */
function busOf(bus: { current?: Pick<Events, 'emit'> }): Pick<Events, 'emit'> {
  if (!bus.current) throw new Error('替身还没激活');
  return bus.current;
}

/** 检查点、待办与压缩的替身：检查点说每一轮都执行过命令；计划由用例经 plan 写入，写入即发 todo:updated */
function doubles() {
  const plans = new Map<string, TodoItem[]>();
  const rewound: string[] = [];
  const bus: { current?: Pick<Events, 'emit'> } = {};
  const rollback = (turnId: string): RollbackResult => {
    rewound.push(turnId);
    return { ok: true, restored: ['workspace:/草稿.md'], deleted: [], errors: [], alsoChangedBy: [] };
  };
  const plugin = definePlugin({
    name: 'zz-e2e-doubles',
    provides: [checkpoint, todoList, compression],
    uses: { provide, events },
    apply({ provide, events }) {
      bus.current = events.use;
      provide.use(checkpoint, {
        beforeMutate: async () => {},
        execUsed: async () => true,
        rollback: async (_sessionId, turnId) => rollback(turnId),
        rollbackWithChat: async (_sessionId, turnId) => ({
          ...rollback(turnId),
          deletedMessages: 0,
          chatDeleted: true,
        }),
      });
      provide.use(todoList, {
        get: async sessionId => plans.get(sessionId) ?? [],
        async clear(sessionId) {
          plans.delete(sessionId);
          await events.use.emit('todo:updated', sessionId, []);
        },
      });
      provide.use(compression, {
        async compress(sessionId) {
          await events.use.emit('session:compressing', { sessionId, status: 'start' });
          await events.use.emit('session:compressing', { sessionId, status: 'done' });
        },
        compressAt: () => AUTO_COMPRESS,
      });
    },
  });
  return {
    plugin,
    rewound,
    async plan(sessionId: string, items: TodoItem[]) {
      plans.set(sessionId, items);
      await busOf(bus).emit('todo:updated', sessionId, items);
    },
  };
}

/** 发起审批的测试插件：工具本身不声明确认，执行时自己经 approvals.request 请 owner 批准 */
const requester = definePlugin({
  name: 'zz-e2e-requester',
  uses: { tools, approvals },
  apply({ tools, approvals }) {
    tools.use.register({
      definition: {
        type: 'function',
        function: {
          name: PUBLISH,
          description: '发布一份文档',
          parameters: { type: 'object', properties: { title: { type: 'string' } } },
        },
      },
      async handler(args, ctx) {
        const outcome = await approvals.use.request(
          {
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            callId: ctx.callId,
            origin: { kind: 'owner', platform: ctx.platform ?? '', userId: ctx.userId },
            tool: PUBLISH,
            args,
            rule: 'zz-e2e-requester',
          },
          ctx.signal,
        );
        return outcome.approved ? '已发布' : JSON.stringify({ error: outcome.message });
      },
    });
  },
});

/** 后台任务登记的替身：用例经 start 在一个会话里放一个在跑的任务，写入即发 background:changed */
function backgroundDouble() {
  const tasks: BackgroundTask[] = [];
  const bus: { current?: Pick<Events, 'emit'> } = {};
  const plugin = definePlugin({
    name: 'zz-e2e-background-tasks',
    provides: [backgroundTasks],
    uses: { provide, events },
    apply({ provide, events }) {
      bus.current = events.use;
      provide.use(backgroundTasks, {
        list: filter => tasks.filter(task => filter?.sessionId === undefined || task.sessionId === filter.sessionId),
        output: id =>
          tasks.some(task => task.id === id) ? { text: `${LAST_LINE}\n`, end: 7, truncated: false } : undefined,
        stop: async id => tasks.find(task => task.id === id),
      });
    },
  });
  return {
    plugin,
    async start(sessionId: string) {
      const task: BackgroundTask = {
        id: 'zz-task-1',
        sessionId,
        kind: 'tool-call',
        label: LONG_TASK,
        call: { tool: LONG_TASK, args: {}, turnId: 'zz-turn', callId: 'zz-call' },
        status: 'running',
        startedAt: Date.now(),
        lastLine: LAST_LINE,
        lastOutputAt: Date.now(),
      };
      tasks.push(task);
      await busOf(bus).emit('background:changed', { task });
    },
  };
}

const e2e = useWebuiE2E();
const { cleanups } = e2e;

/** 起运行时：共用的 minimal 档组合加三个测试插件，后台任务登记偏好替身那一份 */
async function startDoubles() {
  const contract = doubles();
  const background = backgroundDouble();
  const { app, port } = await webuiStack({
    clientDir: e2e.clientDir,
    model: createMockLLMPlugin({ responses: script, latencyMs: 20 }),
    extra: [contract.plugin, requester, background.plugin],
    cleanups,
  });
  app.bind({ services }).services.use.prefer(backgroundTasks, background.plugin.name);
  await app.start();
  await waitListening(port);
  return {
    origin: `http://127.0.0.1:${port}`,
    rewound: contract.rewound,
    plan: contract.plan,
    start: background.start,
  };
}

describe.each(Object.entries(VIEWPORTS))('%s', (width, viewport) => {
  const phone = width === 'phone';
  const { newSession, send, openBackground, openPanel } = onViewport(phone);

  it('测试替身的组合：审批卡、压缩线、计划标签、「后台」标签与运行状况的「正在运行」、回滚与回滚确认照样出现', async () => {
    const stack = await startDoubles();
    const { page, problems } = await openWebui(e2e.browser, stack.origin, viewport, cleanups);
    await newSession(page);
    await send(page, '发布一下');
    const sessionId = await sessionIdOf(page);

    // 审批卡：不是授权插件发起的审批照样推到界面，批准之后工具照常执行
    const card = await page.waitForSelector(aria('审批', 'region'));
    expect(await card?.evaluate(element => element.textContent)).toContain(TITLE);
    await page.locator(aria('批准', 'button')).click();
    await page.waitForSelector(text('发布好了。'));

    // 压缩线：用量条目取压缩服务按会话给的自动压缩线
    const meter = await page.waitForSelector('[aria-label^="上下文已用"]');
    expect(await meter?.evaluate(element => element.getAttribute('title'))).toContain(
      `，到 ${AUTO_COMPRESS * 100}% 自动压缩`,
    );

    // 回滚：检查点在场就有回滚入口（平时藏着，悬停在这一轮上才出现，触屏上常显），确认里写明这一轮执行过命令
    if (!phone) await page.hover('.turn:has(.turn-rewind)');
    await page.locator(aria('回滚这一轮', 'button')).click();
    await page.locator(aria('回滚文件改动', 'menuitem')).click();
    const confirm = aria('回滚这一轮的文件改动？', 'dialog');
    await page.waitForSelector(`${confirm} ${text('这一轮执行过命令，命令的效果不会撤回。')}`);
    await page.locator(`${confirm} ${aria('回滚', 'button')}`).click();
    await toastSays(page, '已回滚：恢复 1 个文件');
    expect(stack.rewound).toHaveLength(1);

    // 计划：待办替身发 todo:updated，计划标签出现
    await stack.plan(sessionId, PLAN);
    await openPanel(page);
    await page.locator(aria('计划', 'tab')).click();
    await page.waitForSelector(text(PLAN[0].title));

    // 「后台」：任务来自偏好的那份登记，头部（手机上是带着点的「更多」）与标签都列出它
    await stack.start(sessionId);
    await page.goto(`${stack.origin}/s/${encodeURIComponent(sessionId)}`);
    await openBackground(page, 1);
    const calls = `aside ${aria('工具调用 · 1', 'region')}`;
    await page.waitForSelector(`${calls} ${aria(`输出「${LONG_TASK}」`, 'button')}`);

    // 运行状况的「正在运行」列出这个会话与它在跑的任务
    await page.goto(`${stack.origin}/health`);
    await page.waitForSelector(`main ${aria('正在运行', 'list')} ${aria('在跑的后台任务', 'list')} ${text(LONG_TASK)}`);
    expect(problems).toEqual([]);
  }, 90_000);
});
