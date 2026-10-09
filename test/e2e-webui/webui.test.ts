import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { type AddressInfo, connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementHandle, Frame, HTTPResponse, Page, Viewport } from 'puppeteer';
import { describe, expect, it, vi } from 'vitest';
import { approvals } from '../../packages/api-approval/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { backgroundTasks, tools } from '../../packages/api-tools/src/index.js';
import { type FrameClient, type PageHandle, type TableRow, webuiServer } from '../../packages/api-webui/src/index.js';
import { config, definePlugin, type PluginDefinition } from '../../packages/core/src/index.js';
import { generate } from '../../packages/create-aalis-plugin/src/cli.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import schedulerPlugin from '../../packages/plugin-scheduler/src/index.js';
import subtaskPlugin from '../../packages/plugin-subtask/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { settingsPlugin } from '../fixtures/session-settings.js';
import {
  aria,
  attentionRows,
  framePackage,
  onViewport,
  openWebui,
  sessionIdOf,
  TOKEN,
  text,
  toastSays,
  useWebuiE2E,
  VIEWPORTS,
  webuiStack,
} from '../fixtures/webui-e2e.js';
import { waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 端到端：构建前端，起最少插件组合的运行时（create-aalis 的 minimal 档，加内存记忆、假模型与 webui-server，
// 不装计划、检查点、摘要），在真的 Chromium 里按桌面与手机两种宽度走主流程；按宽度变的排版（房间表、声明式页面与
// 会话面板的容器查询）只有真的排版才验得了，也在这里核。声明式页面用一个探针插件登记，另装迁移过来的计划任务与工作流看
// 真实插件的页面。插件前端用脚手架生成的插件，加一个在临时目录里搭的测试插件（会话面板，与隔离的各项核查）。
// 浏览器经一个可以切断的中转连到 webui-server，断线重连靠它模拟。假模型按这一轮的
// 最后一条消息回话，流式回复逐块慢慢出；需要批准的是一个声明了命令展示的探针工具，可转后台的是另一个测试插件登记的命令工具
// （会写输出、响应中止），子会话由子任务插件派生。页面里的请求只到这个中转与本机起的「外站」，外站一律不连。
// ════════════════════════════════════════════════════════════

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/** 流式回复每 4 个字一块，块与块之间隔这么久 */
const CHUNK_MS = 60;
const EXTERNAL_IMAGE = 'https://img.example.invalid/cat.png';
const DEPLOY = 'zz_deploy';
const COMMAND = 'deploy --prod';
const DEPLOYED = '部署完成';
/** 经工作流页「新建或覆盖」填进去的定义 */
const WORKFLOW = `id: zz-daily
name: 每日整理
trigger:
  type: manual
nodes:
  - id: pause
    type: wait
    seconds: 1`;

/** 可转后台的测试工具（见 backgroundProbe）转到后台后、它的结束通知来了以后、等完子任务以后，她各回的一句 */
const MOVED = '已经转到后台了。';
const NOTICED = '后台的命令跑完了。';
const SUBTASKS_DONE = '子任务都收住了。';
/** 派子任务的那句话 */
const SPLIT = '分头整理';
/** 要四十多秒才流完的回复：子任务回它时一直在跑，够在中途停掉 */
const ENDLESS = '还在慢慢整理，'.repeat(400);
/**
 * 「分头整理」派出的三个子任务：名字、任务与子会话里的回复。整理目录的很快回完、带用量，另两个一直在跑；她只等前两个，
 * 第三个留给「全部停止」
 */
const SUBTASKS: Array<{ name: string; task: string; reply: ChatResponse }> = [
  {
    name: '目录',
    task: '整理目录',
    reply: { content: '目录整理好了。', usage: { promptTokens: 1200, completionTokens: 340, totalTokens: 1540 } },
  },
  { name: '第一节', task: '慢慢整理第一节', reply: { content: ENDLESS } },
  { name: '第二节', task: '慢慢整理第二节', reply: { content: ENDLESS } },
];
/** 模型拿到的后台任务工具：有可转后台的工具时才有 */
const BACKGROUND_TOOLS = ['background_list', 'background_output', 'background_wait', 'background_stop'];

/**
 * 假模型：不带工具定义的是会话标题之类的辅助调用，回一个固定标题。最后一条是工具结果时：转到后台的回一句已转后台，派完子任务
 * 就等前两个、等完了收尾，探针工具按批没批准收尾；后台任务的结束通知回一句。用户说「部署」叫探针工具，「跑 <命令>」叫可转
 * 后台的测试工具（「后台跑」带上 runInBackground），说「分头整理」派三个子任务；子会话按任务回话；其余按 replies 里出现在
 * 用户消息中的那句回话
 */
function script(replies: Record<string, string>) {
  let calls = 0;
  const call = (name: string, args: Record<string, unknown>) => ({
    id: `call-${++calls}`,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  return (request: ChatModelRequest): ChatResponse => {
    if (!request.tools) return { content: '测试会话' };
    const { messages } = request;
    // 子任务插件给父会话附在末尾的子任务提醒不算
    const last = messages.findLast(message => message.metadata?.injector !== 'subtask/parent-status');
    const text = typeof last?.content === 'string' ? last.content : '';
    if (last?.role === 'tool') {
      if (text.includes('"taskId"')) return { content: MOVED };
      if (text.includes('"subtaskId"')) {
        const created = messages
          .slice(messages.findLastIndex(message => message.role === 'assistant') + 1)
          .filter(message => message.role === 'tool')
          .map(message => JSON.parse(message.content as string) as { subtaskId: string; name: string });
        const waited = created.filter(each => each.name !== SUBTASKS[2].name).map(each => each.subtaskId);
        return { content: null, toolCalls: [call('wait_subtasks', { subtask_ids: waited })] };
      }
      if (text.includes('"allCompleted"')) return { content: SUBTASKS_DONE };
      return { content: text.includes(DEPLOYED) ? '部署好了。' : '好的，不部署了。' };
    }
    if (text.startsWith('[宿主通知]')) return { content: NOTICED };
    if (text.includes('部署')) return { content: null, toolCalls: [call(DEPLOY, { command: COMMAND })] };
    const job = /(后台)?跑 ([\w-]+)/.exec(text);
    if (job) {
      return {
        content: null,
        toolCalls: [call(JOB, { command: job[2], ...(job[1] ? { runInBackground: true } : {}) })],
      };
    }
    if (text.includes(SPLIT)) {
      return { content: null, toolCalls: SUBTASKS.map(({ name, task }) => call('create_subtask', { name, task })) };
    }
    const subtask = SUBTASKS.find(each => text.includes(each.task));
    if (subtask) return subtask.reply;
    const reply = Object.entries(replies).find(([said]) => text.includes(said))?.[1];
    if (reply === undefined) throw new Error(`假模型没有准备对「${text}」的回复`);
    return { content: reply };
  };
}

/** 看板里名字很长的一行，带一段中间没有断行机会的文件名：窄时写字的列折行，不把后面的状态列挤出视野 */
const LONG_NAME = '把这个季度的周报整理进 weekly_summary_final_2026_q3_reviewed_by_everyone.md 再发给负责人确认';

/** 带原因的失败状态：窄时折行，不撑出横向滚动，也不把同一行的第一列挤成一字一行 */
const LONG_FAILURE = '失败：远端代理返回 500 Internal Server Error，请稍后再试';

/** 慢慢流出来的长回复：每块 4 个字，整段要十几秒才出完，够从面板里停掉它 */
const SLOW_REPLY = '这是一段很长的回复，'.repeat(24);

/** 看板的行与登记拿到的句柄：用例改了行、经句柄推 invalidate，看打开着的页面跟着变；每次激活重置 */
const board: { rows: TableRow[]; page?: PageHandle } = { rows: [] };

/**
 * 页面探针：一个位置为插件详情的看板（带详情与行动作的表格）、一个键值加关系图的统计页，以及一个适用于全部会话的便签面板
 */
const PAGES_PROBE = 'zz-e2e-pages';
const probePages = definePlugin({
  name: PAGES_PROBE,
  uses: { webui: webuiServer },
  apply({ webui }) {
    board.rows = [
      { id: 'a', name: '整理周报', owner: '小明', state: { text: '进行中', state: 'running' }, note: '周一前' },
      { id: 'b', name: '部署文档', owner: '小红', state: { text: '待办' }, note: '' },
      { id: 'c', name: LONG_NAME, owner: '小刚', state: { text: '待办' }, note: '' },
    ];
    board.page = webui.definePage({
      key: 'board',
      title: '看板',
      icon: 'kanban',
      actions: {
        mark: { label: '标记', effect: 'write', row: true, handler: ({ rowKey }) => `已标记 ${rowKey}` },
        drop: { label: '删除', effect: 'destructive', row: true, handler: () => undefined },
      },
      content: [
        { type: 'info', id: 'summary', data: () => [{ label: '条目数', value: board.rows.length }] },
        {
          type: 'table',
          id: 'items',
          rowKey: 'id',
          columns: [
            { key: 'name', label: '名称', primary: true },
            { key: 'owner', label: '负责人' },
            { key: 'state', label: '状态', kind: 'status', primary: true },
            { key: 'note', label: '备注' },
          ],
          rowActions: [{ action: 'mark' }, { action: 'drop' }],
          detail: [{ type: 'info', id: 'item', data: ({ rowKey }) => [{ label: '编号', value: rowKey }] }],
          data: () => board.rows,
        },
      ],
    });
    webui.definePage({
      key: 'stats',
      title: '统计',
      content: [
        { type: 'info', id: 'numbers', data: () => [{ label: '总数', value: 2 }] },
        {
          type: 'graph',
          id: 'links',
          nodeKinds: [
            { kind: 'person', label: '人物', tone: 1 },
            { kind: 'thing', label: '实体', tone: 3 },
          ],
          edgeKinds: [{ kind: 'knows', label: '认识', tone: 2 }],
          data: () => ({
            nodes: [
              { id: 'a', label: '小明', kind: 'person' },
              { id: 'b', label: '小红', kind: 'person' },
            ],
            edges: [{ source: 'a', target: 'b', kind: 'knows' }],
          }),
          detail: [{ type: 'info', id: 'person', data: ({ rowKey }) => [{ label: '编号', value: rowKey }] }],
        },
        {
          type: 'table',
          id: 'log',
          label: '日志',
          rowKey: 'id',
          columns: [
            { key: 'message', label: '说明', kind: 'long-text', primary: true },
            { key: 'state', label: '状态', kind: 'status', primary: true },
          ],
          data: () => [
            { id: '1', message: `${LONG_NAME}；${LONG_NAME}`, state: { text: '进行中', state: 'running' } },
            { id: '2', message: '整理周报', state: { text: LONG_FAILURE, state: 'error' } },
          ],
        },
        {
          type: 'table',
          id: 'counts',
          label: '次数',
          rowKey: 'id',
          columns: [
            { key: 'name', label: '名称', primary: true },
            { key: 'count', label: '次数', primary: true },
          ],
          data: () => [
            { id: '1', name: '整理', count: 1200 },
            { id: '2', name: '归档', count: 3.5 },
          ],
        },
      ],
    });
    webui.definePage({
      key: 'notes',
      title: '便签',
      placement: 'session',
      content: [
        {
          type: 'table',
          id: 'notes',
          rowKey: 'id',
          columns: [
            { key: 'text', label: '内容', primary: true },
            { key: 'at', label: '时间', kind: 'time' },
          ],
          data: ({ ctx }) => [{ id: '1', text: `会话 ${ctx.sessionId}`, at: Date.now() }],
        },
      ],
    });
  },
});

/** 没配好起不来的插件：服务地址没填时激活失败，填了就好 */
const NEEDS_CONFIG = 'zz-e2e-needs-config';
const needsConfig = definePlugin({
  name: NEEDS_CONFIG,
  displayName: '要配置的探针',
  configSchema: { endpoint: { type: 'string', label: '服务地址', required: true } },
  uses: { config },
  apply({ config: value }) {
    if (!value.endpoint) throw new Error('缺少服务地址');
  },
});

/** 发一条提示的插件：跳到它的「作品审核」页 */
const NOTICE_PROBE = 'zz-e2e-notice';
const noticeProbe = definePlugin({
  name: NOTICE_PROBE,
  displayName: '提示的探针',
  uses: { webui: webuiServer },
  apply({ webui }) {
    webui.definePage({ key: 'queue', title: '作品审核', content: [{ type: 'markdown', id: 'note', data: () => '' }] });
    webui.notify({
      id: 'pending',
      level: 'action',
      title: '2 件作品待裁决',
      detail: '最早的一件已等 3 天',
      open: { page: 'queue' },
    });
  },
});

/** 可多开的插件：主实例之外另起实例 */
const MULTI = 'zz-e2e-multi';
const multi = definePlugin({ name: MULTI, displayName: '多开的探针', reusable: true, apply() {} });

/** 可转后台的测试工具：按命令先写 JOB_BURST 行输出，之后每 JOB_TICK_MS 一行，直到用例让它正常结束或被中止；让出时限 1 秒 */
const JOB = 'zz_job';
const JOB_BURST = 80;
const JOB_TICK_MS = 250;
/** 在跑的测试工具调用，按命令：调用它就正常结束（退出码 0） */
const jobs = new Map<string, () => void>();
const backgroundProbe = definePlugin({
  name: 'zz-e2e-background',
  uses: { tools },
  apply({ tools }) {
    tools.register({
      display: { kind: 'command', fields: { command: 'command' }, result: { exitCode: 'exitCode' } },
      background: { yieldSeconds: 1 },
      definition: {
        type: 'function',
        function: {
          name: JOB,
          description: '跑一个命令',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
      handler: (args, ctx) =>
        new Promise(resolve => {
          const command = String(args.command);
          let lines = 0;
          const write = () => ctx.output?.(`${command} 第 ${++lines} 行\n`);
          for (let n = 0; n < JOB_BURST; n++) write();
          const timer = setInterval(write, JOB_TICK_MS);
          const end = (exitCode: number) => {
            clearInterval(timer);
            jobs.delete(command);
            resolve(JSON.stringify({ exitCode }));
          };
          jobs.set(command, () => end(0));
          ctx.signal?.addEventListener('abort', () => end(143), { once: true });
        }),
    });
  },
});

/** 脚手架生成的插件：包名、显示名，页面键取包名 */
const SCAFFOLD = 'zz-e2e-scaffold';
const SCAFFOLD_NAME = '示例条目';

/** 用脚手架在临时目录里生成一个页面用自带前端的插件，加载它的定义 */
async function scaffolded(): Promise<PluginDefinition> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-e2e-scaffold-')));
  cleanups.push(async () => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, SCAFFOLD);
  await generate(
    dir,
    {
      packageName: SCAFFOLD,
      displayName: SCAFFOLD_NAME,
      features: { tool: false, command: false, webui: 'frame', sessionSetting: false },
    },
    // 只用生成的源码与网页，依赖的版本不进这条用例
    { '@aalis/core': '0.1.0', '@aalis/api-webui': '0.1.0' },
  );
  return ((await import(join(dir, 'src/index.ts'))) as { default: PluginDefinition }).default;
}

/**
 * 插件前端的测试插件：探针页（连上后把连接挂在 window.frame 上）与一个 destructive 动作、引用样式基线的控件页（同一个
 * 探针脚本，另有两个被插件自己整个重置掉的按钮）、不用助手的页、会话面板
 * （申请读会话与停回合，写出挂在哪个会话上、记下会话的增量），另有一个仿冒宿主的页（挂着一张图，中转扣住它的请求，
 * 页面的 load 就不会来）。插件包搭在临时目录里，页面的 module 指向包里
 */
const FRAMES = 'zz-e2e-frames';
const FRAMES_NAME = '框架探针';
const FRAME_FILES: Record<string, string> = {
  'probe.html':
    '<!doctype html><meta charset="utf-8"><title>探针</title><script type="module" src="probe.js"></script><p id="ready"></p>',
  'probe.js': `import { connect } from '/frames/_base/frame.js';
window.frame = await connect();
document.querySelector('#ready').textContent = '已连上';
`,
  'controls.html': `<!doctype html><meta charset="utf-8"><title>控件</title>
<link rel="stylesheet" href="/frames/_base/frame.css"><style>.icon { all: unset; cursor: pointer }</style>
<script type="module" src="probe.js"></script><h1>条目</h1><p id="ready"></p><input aria-label="名称"> <button>添加</button>
<ul><li>甲 <button class="icon" aria-label="移除甲">×</button></li><li>乙 <button class="icon" aria-label="移除乙">×</button></li></ul>`,
  'raw.html': '<!doctype html><meta charset="utf-8"><title>不用助手</title><p>不用助手的页面</p>',
  'away.html': '<!doctype html><meta charset="utf-8"><title>登录已过期</title><p>请输入 token</p><img src="never.png">',
  'roster.html': `<!doctype html><meta charset="utf-8"><title>子会话</title>
<link rel="stylesheet" href="/frames/_base/frame.css"><script type="module" src="roster.js"></script><p id="session"></p>`,
  'roster.js': `import { connect } from '/frames/_base/frame.js';
window.changes = [];
window.frame = await connect();
window.frame.onSessionsChanged(change => window.changes.push(change));
document.querySelector('#session').textContent = window.frame.sessionId;
`,
};

/** 测试插件在框架里的样子：经 evaluate 取连接与记下的增量 */
type FrameWindow = Window & { frame: FrameClient; changes: Array<{ upserts: Array<{ id: string }> }> };

function framesPlugin(): PluginDefinition {
  const module = framePackage(FRAMES, FRAME_FILES, cleanups);
  return definePlugin({
    name: FRAMES,
    displayName: FRAMES_NAME,
    uses: { webui: webuiServer },
    apply({ webui }) {
      webui.definePage({
        key: 'probe',
        title: '探针',
        frame: { module, entry: 'probe.html' },
        actions: {
          drop: {
            label: '丢弃',
            effect: 'destructive',
            input: { item: { type: 'string', label: '条目', required: true } },
            handler: ({ input }) => `已丢弃 ${input.item}`,
          },
        },
      });
      webui.definePage({ key: 'controls', title: '控件', frame: { module, entry: 'controls.html' } });
      webui.definePage({ key: 'raw', title: '不用助手', frame: { module, entry: 'raw.html' } });
      webui.definePage({
        key: 'roster',
        title: '子会话',
        placement: 'session',
        frame: { module, entry: 'roster.html', host: ['sessions:read', 'turn:abort'] },
      });
    },
  });
}

/** 本机起的「外站」：按路径数收到的请求，一律回空的 200 */
async function externalSite() {
  const hits = new Map<string, number>();
  const server = createHttpServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    res.writeHead(200).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: (path: string) => hits.get(path) ?? 0,
  };
}

/** 插件前端的框架：等握手完成（宿主给 iframe 标上 data-ready），回它的框架句柄 */
async function frameIn(page: Page, scope = ''): Promise<Frame> {
  const frame = await (await page.waitForSelector(`${scope} iframe[data-ready]`))?.contentFrame();
  if (!frame) throw new Error('框架不在');
  return frame;
}

const e2e = useWebuiE2E();
const { cleanups } = e2e;

/**
 * 浏览器与 webui-server 之间的中转：cut() 切断现有的全部连接，之后的新连接照常转发；heard(text) 看浏览器发给服务端的
 * 字节里有没有出现过 text；hold(text) 之后，发出带 text 的请求的那条连接不再往服务端转，这个请求一直等不到回应；
 * misroute(host) 之后，WebSocket 升级请求的 Host 换成 host（像没转发原始 Host 的反向代理），给 undefined 恢复
 */
async function relay(target: number) {
  const sockets = new Set<Socket>();
  const held: string[] = [];
  let sent = '';
  let upgradeHost: string | undefined;
  const server = createServer(inbound => {
    const outbound = connect(target, '127.0.0.1');
    for (const socket of [inbound, outbound]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // 切断时另一端会报连接被重置，这是预期的
      socket.on('error', () => {});
    }
    let holding = false;
    inbound.on('data', (chunk: Buffer) => {
      const text = chunk.toString('latin1');
      sent += text;
      holding ||= held.some(marker => text.includes(marker));
      if (holding) return;
      if (upgradeHost !== undefined && /\r\nupgrade: websocket/i.test(text)) {
        outbound.write(Buffer.from(text.replace(/\r\nhost: [^\r]*/i, `\r\nHost: ${upgradeHost}`), 'latin1'));
      } else outbound.write(chunk);
    });
    inbound.on('end', () => outbound.end());
    outbound.pipe(inbound);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const cut = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    port: (server.address() as AddressInfo).port,
    cut,
    heard: (text: string) => sent.includes(text),
    hold: (text: string) => void held.push(text),
    misroute: (host: string | undefined) => {
      upgradeHost = host;
    },
    close: () =>
      new Promise<void>(resolve => {
        cut();
        server.close(() => resolve());
      }),
  };
}

/**
 * 起运行时（共用的 minimal 档组合，模型是按 script 回话的假模型），再加一个需要批准的探针工具；extra 是另加的插件。
 * requests 是假模型收到的请求
 */
async function startStack(
  replies: Record<string, string> = {},
  extra: PluginDefinition[] = [],
  rooms?: Record<string, string>,
) {
  const requests: ChatModelRequest[] = [];
  const { app, port } = await webuiStack({
    clientDir: e2e.clientDir,
    model: createMockLLMPlugin({ responses: script(replies), latencyMs: CHUNK_MS, recorder: requests }),
    extra,
    cleanups,
    rooms,
  });
  const runs: string[] = [];
  app.bind({ tools }).tools.register({
    confirm: 'session',
    display: { kind: 'command', fields: { command: 'command' } },
    definition: {
      type: 'function',
      function: {
        name: DEPLOY,
        description: '部署',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    },
    handler: async args => {
      runs.push(String(args.command));
      return DEPLOYED;
    },
  });
  await app.start();
  await waitListening(port);
  const proxy = await relay(port);
  cleanups.push(proxy.close);
  return {
    origin: `http://127.0.0.1:${proxy.port}`,
    cut: proxy.cut,
    heard: proxy.heard,
    hold: proxy.hold,
    misroute: proxy.misroute,
    runs,
    requests,
    app,
  };
}

type Stack = Awaited<ReturnType<typeof startStack>>;

/** 按 token 登录、在这个运行时上打开 path（见 openWebui） */
const openPage = (stack: Stack, viewport: Viewport, path?: string) =>
  openWebui(e2e.browser, stack.origin, viewport, cleanups, path);
/** 会话头部的「后台 N」 */
const BACKGROUND_METER = 'main [title="打开「后台」标签"]';
const toolLine = (page: Page) => page.$eval('.tool-line', element => element.textContent);

/** 位置为插件详情的页面的地址 */
const pagePath = (instance: string, pageKey: string) =>
  `/p/${encodeURIComponent(instance)}/${encodeURIComponent(pageKey)}`;

/** 图标栏里各项的名字（桌面） */
const railNames = (page: Page) =>
  page.$$eval('.shell-rail a', links => links.map(link => link.getAttribute('aria-label')));

/** 插件区左栏里一个实例的链接 */
const pluginLink = (instance: string) => `nav[aria-label="插件"] a[href="/plugins/${encodeURIComponent(instance)}"]`;

/** 显示着的列 */
const shownColumns = (page: Page, scope: string) =>
  page.$$eval(`${scope} .table th[data-column]`, cells =>
    cells.filter(cell => getComputedStyle(cell).display !== 'none').map(cell => cell.getAttribute('data-column')),
  );

/** 带输入的动作弹出的表单里，按标签找到输入框填进去 */
async function fill(page: Page, dialog: string, fields: Record<string, string>) {
  for (const [label, value] of Object.entries(fields)) {
    await page.locator(`${aria(dialog, 'dialog')} ${aria(label, 'textbox')}`).fill(value);
  }
}

describe.each(Object.entries(VIEWPORTS))('%s', (width, viewport) => {
  const phone = width === 'phone';
  const { newSession, send, openBackground, openPanel } = onViewport(phone);

  /** 会话列表里这个会话的一行（手机上是第一层） */
  const sessionRow = (page: Page, sessionId: string) =>
    page.$eval(
      `nav[aria-label="会话"] a[href="/s/${encodeURIComponent(sessionId)}"]`,
      link => link.closest('li')?.textContent,
    );

  it('打开、发消息、流式回复；外站图片只显示成链接；HTML 带 CSP', async () => {
    const stack = await startStack({
      你好: `收到，这是一段慢慢流出来的回复，用来看流式显示。![外站图片](${EXTERNAL_IMAGE})`,
    });
    const { page, problems, response } = await openPage(stack, viewport);
    expect(response.headers()['content-security-policy']).toBe(CSP);

    await newSession(page);
    // 发送前装好观察，每次变动都看一次：正在输出时正文至少长出过两个不同的前半段
    await page.evaluate(() => {
      const partials = new Set<string>();
      (window as unknown as { partials: Set<string> }).partials = partials;
      new MutationObserver(() => {
        const shown = document.querySelector('[aria-label="对话"]')?.textContent ?? '';
        if (document.querySelector('[aria-label="正在输出"]') && !shown.includes('流式显示')) partials.add(shown);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await send(page, '你好');
    await sessionIdOf(page);
    const timeline = await page.waitForSelector(aria('对话', 'region'));
    await page.waitForFunction(() => (window as unknown as { partials: Set<string> }).partials.size >= 2);
    await page.waitForSelector('::-p-aria(正在输出)', { hidden: true });
    expect(await timeline?.evaluate(element => element.textContent ?? '')).toContain('用来看流式显示');

    const link = await page.waitForSelector(`.message[data-from="agent"] a[href="${EXTERNAL_IMAGE}"]`);
    expect(await link?.evaluate(element => [element.textContent, element.getAttribute('rel')])).toEqual([
      '外站图片',
      'noopener noreferrer',
    ]);
    expect(await page.$$('img[src*="example.invalid"]')).toHaveLength(0);
    expect(problems).toEqual([]);
  }, 60_000);

  it('指令的回复是一条通知：/help clear 逐行显示，标题、用法各占一行，取值缩在选项下面', async () => {
    const stack = await startStack();
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '/help clear');
    const reply = await page.waitForSelector(`.notice-body ${text('仅全局清理')}`);
    const lines = (await reply?.evaluate(element => (element as HTMLElement).innerText))?.split('\n');
    expect(lines?.slice(0, 3)).toEqual([
      '/clear — 清空当前会话记忆；用 --type 选择消息、摘要、向量、图片等清理类型',
      '',
      '用法：/clear [选项]',
    ]);
    expect(lines).toContain('- --type, -t <type>：清理类型，可重复或用逗号分隔');
    expect(lines).toContain('  - all：全部类型');
    expect(problems).toEqual([]);
  }, 60_000);

  it('代码块的复制按钮与语言名在代码上方一条细的标题行里，桌面与触屏一样常显、不压住第一行代码；触屏上按钮的点按范围不小于 44', async () => {
    const stack = await startStack({
      代码: '```sh\nnpm run build --workspace packages/plugin-webui-client --if-present\nnpm test\n```',
    });
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '代码');
    const block = await page.waitForSelector('.message[data-from="agent"] .markdown-code');
    await page.waitForSelector('::-p-aria(正在输出)', { hidden: true });
    /**
     * 标题行的字与高、复制按钮的可见性与上下边、第一行代码的上下边；点按范围按真的命中算：以按钮中心为心、reach 见方的
     * 四边往里 1 像素取点，命中的都要是按钮（被祖先裁掉的点不算），写出没命中的边
     */
    const measured = await block?.evaluate(
      (element, reach) => {
        const head = element.querySelector('.markdown-code-head') as HTMLElement;
        const button = head.querySelector('button') as HTMLElement;
        const pre = element.querySelector('pre') as HTMLElement;
        button.scrollIntoView({ block: 'center' });
        const style = getComputedStyle(pre);
        const top = pre.getBoundingClientRect().top + Number.parseFloat(style.paddingTop);
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const half = reach / 2;
        const sides: Array<[string, number, number]> = [
          ['上', x, Math.ceil(y - half) + 1],
          ['下', x, Math.floor(y + half) - 1],
          ['左', Math.ceil(x - half) + 1, y],
          ['右', Math.floor(x + half) - 1, y],
        ];
        return {
          language: head.textContent,
          head: head.getBoundingClientRect().height,
          visible: getComputedStyle(button).visibility === 'visible',
          label: button.getAttribute('aria-label'),
          clear: box.bottom <= top,
          missed: sides
            .filter(([, px, py]) => !button.contains(document.elementFromPoint(px, py)))
            .map(([side]) => side),
        };
      },
      phone ? 44 : 28,
    );
    expect(measured).toMatchObject({
      language: 'sh',
      head: 28,
      visible: true,
      label: '复制代码',
      clear: true,
      missed: [],
    });
    expect(problems).toEqual([]);
  }, 60_000);

  it('审批：批准；卡片不抢焦点，结算后收成一句，刷新后仍在', async () => {
    const stack = await startStack({ 你好: '先说一句。' });
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '你好');
    await sessionIdOf(page);
    await page.waitForSelector(text('先说一句。'));

    await send(page, '部署一下');
    const card = await page.waitForSelector(aria('审批', 'region'));
    expect(await card?.evaluate(element => element.textContent)).toContain(COMMAND);
    expect(await card?.evaluate(element => element.contains(document.activeElement))).toBe(false);
    if (!phone) {
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('消息');
    }
    expect(await toolLine(page)).toContain('等你批准');

    await page.locator(aria('批准', 'button')).click();
    await page.waitForSelector(text('部署好了。'));
    expect(await page.$$(aria('审批', 'region'))).toHaveLength(0);
    expect(await toolLine(page)).toMatch(/已批准 · \d{2}:\d{2}/);
    expect(stack.runs).toEqual([COMMAND]);

    await page.reload();
    await page.waitForSelector(text('部署好了。'));
    expect(await toolLine(page)).toMatch(/已批准 · \d{2}:\d{2}/);
    const said = await page.$$eval('.message[data-from="user"]', elements =>
      elements.map(element => element.textContent),
    );
    expect(said).toEqual(['你好', '部署一下']);
    await page.waitForSelector(text('先说一句。'));
    expect(problems).toEqual([]);
  }, 60_000);

  it('审批：拒绝，工具不执行，模型照常收尾', async () => {
    const stack = await startStack();
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '部署一下');
    await page.waitForSelector(aria('审批', 'region'));
    await page.locator(aria('拒绝', 'button')).click();
    await page.waitForSelector(text('好的，不部署了。'));
    expect(await toolLine(page)).toMatch(/已拒绝 · \d{2}:\d{2}/);
    expect(stack.runs).toEqual([]);
    expect(problems).toEqual([]);
  }, 60_000);

  it('切会话：从列表点开另一个会话，时间线跟着换', async () => {
    const stack = await startStack({ 第一个: '第一个的回复', 第二个: '第二个的回复' });
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '第一个会话');
    const first = await sessionIdOf(page);
    await page.waitForSelector(text('第一个的回复'));

    if (phone) await page.locator(aria('返回', 'button')).click();
    else await page.locator(aria('新会话', 'button')).click();
    await newSession(page);
    await send(page, '第二个会话');
    await page.waitForSelector(text('第二个的回复'));
    expect(await sessionIdOf(page)).not.toBe(first);

    if (phone) await page.locator(aria('返回', 'button')).click();
    await page.locator(`a[href="/s/${encodeURIComponent(first)}"]`).click();
    await page.waitForSelector(text('第一个的回复'));
    expect(await sessionIdOf(page)).toBe(first);
    const timeline = await page.waitForSelector(aria('对话', 'region'));
    expect(await timeline?.evaluate(element => element.textContent)).not.toContain('第二个');
    expect(problems).toEqual([]);
  }, 60_000);

  it('断线重连：重订打开着的会话、立即重报在场，等着的审批仍然可以批', async () => {
    const stack = await startStack();
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '部署一下');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(aria('审批', 'region'));

    const sent: string[] = [];
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameSent', ({ response }) => void sent.push(response.payloadData));
    stack.cut();
    await page.waitForSelector(text('连接断开，正在重连…'));
    await page.waitForSelector(text('已恢复'));

    const frames = sent.map(frame => JSON.parse(frame) as { method?: string; params?: unknown });
    expect(frames).toContainEqual(expect.objectContaining({ method: 'session/subscribe', params: { sessionId } }));
    expect(frames).toContainEqual(expect.objectContaining({ method: 'presence/update', params: { active: true } }));

    await page.locator(aria('批准', 'button')).click();
    await page.waitForSelector(text('部署好了。'));
    expect(stack.runs).toEqual([COMMAND]);
    expect(problems).toEqual([]);
  }, 60_000);

  it('房间表：窄时（容器窄于 36em）只留名称与状态，宽时各列都在', async () => {
    const stack = await startStack({}, [], { 'onebot:10000:group:20001': '读书会' });
    const { page, problems } = await openPage(stack, viewport);
    await page.goto(`${stack.origin}/rooms?platform=onebot`);
    await page.waitForSelector(`td[data-column="name"] ${text('读书会')}`);
    const { width, columns } = await page.$eval('.table', table => ({
      width: table.clientWidth / Number.parseFloat(getComputedStyle(table).fontSize),
      columns: [...table.querySelectorAll('th[data-column]')]
        .filter(cell => getComputedStyle(cell).display !== 'none')
        .map(cell => cell.getAttribute('data-column')),
    }));
    if (phone) expect(width).toBeLessThanOrEqual(36);
    expect(columns).toEqual(width <= 36 ? ['name', 'status'] : ['name', 'type', 'status', 'active', 'replied']);
    expect(problems).toEqual([]);
  }, 60_000);

  it('最少插件组合：「需要处理」为空，首页摘要不出现、标签页标题只有应用名，运行状况没有角标；没有计划标签、回滚、压缩与压缩线，用量拆分表的行名照样出现、没有「用量统计」页，没有页面时图标栏只有宿主项（手机上第一层没有固定的页面，入口是运行状况、插件、设置）、右侧面板没有「+」，也没有空着的区域与框架；没有可转后台的工具与派生子会话的插件，模型拿到的工具里没有后台任务工具，没有「后台」标签，头部、左栏与运行状况都没有后台工作，会话行没有子任务展开', async () => {
    const stack = await startStack({ 你好: '好的。' });
    const { page, problems } = await openPage(stack, viewport);
    await page.waitForNetworkIdle({ idleTime: 300 });
    // 应用名是宿主配置的 name；列表为空也就没有 MCP 的提示
    await page.waitForFunction(() => document.title === 'T');
    expect(await page.$$(aria('需要处理', 'region'))).toHaveLength(0);
    const attention = await fetch(`${stack.origin}/api/attention`, {
      headers: { Cookie: `aalis_webui_token=${TOKEN}` },
    });
    expect(await attention.json()).toEqual({ items: [] });
    const pages = await fetch(`${stack.origin}/api/pages`, { headers: { Cookie: `aalis_webui_token=${TOKEN}` } });
    const { pages: list } = (await pages.json()) as { pages: Array<{ title: string }> };
    expect(list.map(entry => entry.title)).not.toContain('用量统计');
    if (phone) {
      expect(await page.$$(aria('固定的页面', 'list'))).toHaveLength(0);
      expect(await page.$$eval('[aria-label="入口"] a', links => links.map(link => link.textContent))).toEqual([
        '运行状况',
        '插件',
        '设置',
      ]);
    } else {
      expect(await railNames(page)).toEqual(['会话', '运行状况', '插件', '设置']);
      expect(await page.$$('.shell-rail .badge')).toHaveLength(0);
    }
    await newSession(page);
    await send(page, '你好');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(text('好的。'));
    const meter = await page.waitForSelector('[aria-label^="上下文已用"]');

    // 回滚按钮平时藏着、悬停才出现，按属性找，不按读屏树找
    expect(await page.$$('[aria-label="回滚这一轮"]')).toHaveLength(0);
    await page.locator(`main ${aria('更多', 'button')}`).click();
    const items = await page.$$eval('[role="menuitem"]', elements => elements.map(element => element.textContent));
    expect(items).toEqual([...(phone ? ['全部展开', '会话面板'] : []), '改名', '归档', '删除']);
    await page.keyboard.press('Escape');
    expect(await page.$$(`main ${aria('更多', 'button')}[data-dot]`)).toHaveLength(0);
    expect(await page.$$(BACKGROUND_METER)).toHaveLength(0);
    expect(
      await meter?.evaluate(element => [element.getAttribute('title'), element.hasAttribute('data-tone')]),
    ).toEqual([expect.stringMatching(/^上下文已用 \d+%$/), false]);

    // 分项的行名由对话代理产出、随用量条目给出
    const usageRows = () =>
      page.$$eval('[aria-label="上下文用量"] th[scope="row"]', cells => cells.map(cell => cell.textContent));
    if (phone) {
      await meter?.click();
      await page.waitForSelector(aria('上下文用量', 'table'));
      expect(await usageRows()).toEqual(expect.arrayContaining(['已用', '历史消息', '为回复预留']));
      expect(await page.$$(text('自动压缩'))).toHaveLength(0);
      await page.locator(aria('关闭', 'button')).click();
      await page.locator(`main ${aria('更多', 'button')}`).click();
      await page.locator(aria('会话面板', 'menuitem')).click();
      await page.waitForFunction(id => location.pathname === `/s/${encodeURIComponent(id)}/settings`, {}, sessionId);
    }
    const tabs = await page.$$eval('[role="tab"]', elements => elements.map(element => element.textContent));
    expect(tabs).toEqual(phone ? ['设置'] : ['设置', '用量']);
    expect(await page.$$('.setting-row')).not.toHaveLength(0);
    await page.waitForNetworkIdle({ idleTime: 300 });
    expect(await page.$$(aria('打开标签', 'button'))).toHaveLength(0);
    if (!phone) {
      await page.locator(aria('用量', 'tab')).click();
      await page.waitForSelector(aria('上下文用量', 'table'));
      expect(await usageRows()).toEqual(expect.arrayContaining(['已用', '历史消息', '为回复预留']));
      expect(await page.$$(text('自动压缩'))).toHaveLength(0);
    }
    // 没有插件前端页面时页面上没有框架
    expect(await page.$$('iframe')).toHaveLength(0);

    const offered = stack.requests.flatMap(request => request.tools ?? []).map(tool => tool.function.name);
    expect(offered).toContain(DEPLOY);
    expect(offered.filter(name => BACKGROUND_TOOLS.includes(name))).toEqual([]);
    const other = await openPage(stack, viewport);
    expect(await sessionRow(other.page, sessionId)).not.toMatch(/后台/);
    const rowButtons = await other.page.$$eval('nav[aria-label="会话"] .list-item-row button', buttons =>
      buttons.map(button => button.getAttribute('aria-label')),
    );
    expect(rowButtons).toEqual(['更多']);
    await other.page.goto(`${stack.origin}/health`);
    await other.page.waitForSelector(`main ${aria('平台连接', 'list')}`);
    await other.page.waitForNetworkIdle({ idleTime: 300 });
    expect(await other.page.$$(`main ${aria('正在运行', 'region')}`)).toHaveLength(0);
    expect(problems).toEqual([]);
    expect(other.problems).toEqual([]);
  }, 60_000);

  it('插件区（最少插件组合）：从图标栏底部（手机上第一层）进去；树里正好是装着的实例；没有页面的插件没有页面块；WebUI 服务端停用、卸载不可点，接口同样拒绝停用，重载照常', async () => {
    const stack = await startStack();
    const { page, problems } = await openPage(stack, viewport);
    if (phone) {
      const entries = await page.waitForSelector(aria('入口', 'list'));
      expect(await entries?.$$eval('a', links => links.map(link => link.textContent))).toEqual([
        '运行状况',
        '插件',
        '设置',
      ]);
      await page.locator(`[aria-label="入口"] ${aria('插件', 'link')}`).click();
    } else {
      expect(await railNames(page)).toEqual(['会话', '运行状况', '插件', '设置']);
      await page.locator(`.shell-rail ${aria('插件', 'link')}`).click();
    }
    await page.waitForFunction(() => location.pathname === '/plugins');
    await page.waitForSelector(pluginLink('@aalis/plugin-webui-server'));
    const listed = await page.$$eval('nav[aria-label="插件"] a', links =>
      links
        .map(link => new URL((link as HTMLAnchorElement).href).pathname)
        .filter(path => path.startsWith('/plugins/'))
        .map(path => decodeURIComponent(path.slice('/plugins/'.length))),
    );
    expect(listed.sort()).toEqual(
      stack.app.plugins
        .getStatus()
        .map(plugin => plugin.instanceId)
        .sort(),
    );

    await page.locator(pluginLink('@aalis/plugin-webui-server')).click();
    await page.waitForSelector(text('这个界面由它提供，不能从界面停用或卸载。'));
    const disabled = (name: string) =>
      page.$eval(`main ${aria(name, 'button')}`, button => (button as HTMLButtonElement).disabled);
    for (const name of ['停用', '卸载']) expect(await disabled(name), name).toBe(true);
    expect(await disabled('重载')).toBe(false);
    expect(await page.$$(`main ${aria('页面', 'heading')}`)).toHaveLength(0);
    const refused = await fetch(
      `${stack.origin}/api/plugins/${encodeURIComponent('@aalis/plugin-webui-server')}/disable`,
      {
        method: 'POST',
        headers: { Cookie: `aalis_webui_token=${TOKEN}` },
      },
    );
    expect(refused.status).toBe(409);
    expect(stack.app.plugins.getPlugin('@aalis/plugin-webui-server')?.state).toBe('active');
    expect(problems).toEqual([]);
  }, 60_000);

  it('设置（最少插件组合）：目录是会话默认、权限、外观、系统；会话默认的层只有全局默认与 webui 平台档，行正是登记着的设置项，假模型不声明档位、「深度思考」写明当前模型不能调；外观只有内置 8 个主题，会话面板标签里没有插件标签；权限从目录与地址都能进、刷新后仍在', async () => {
    const stack = await startStack();
    const { page, problems } = await openPage(stack, viewport);
    const directory = 'nav[aria-label="设置"]';
    if (phone) {
      await page.locator(`[aria-label="入口"] ${aria('设置', 'link')}`).click();
      await page.waitForFunction(() => location.pathname === '/settings');
    } else {
      await page.locator(`.shell-rail ${aria('设置', 'link')}`).click();
      await page.waitForFunction(() => location.pathname === '/settings/session-defaults');
    }
    await page.waitForSelector(`${directory} ${aria('系统', 'link')}`);
    expect(await page.$$eval(`${directory} a`, links => links.map(link => link.textContent))).toEqual([
      '会话默认',
      '权限',
      '外观',
      '系统',
    ]);
    /** 从目录进一节：手机上先回到目录这一层 */
    const open = async (name: string) => {
      if (phone && (await page.evaluate(() => location.pathname !== '/settings'))) {
        await page.locator(`main ${aria('返回', 'button')}`).click();
        await page.waitForFunction(() => location.pathname === '/settings');
      }
      await page.locator(`${directory} ${aria(name, 'link')}`).click();
      await page.waitForSelector(`main ${aria(name, 'heading')}`);
    };

    await open('会话默认');
    // 层选择器：桌面上在按钮下方左对齐弹出，手机上从底部弹出、占满宽，每项不矮于点按范围
    const picker = await page.waitForSelector(`main ${aria('层', 'combobox')}`);
    await picker?.click();
    const list = await page.waitForSelector(aria('层', 'listbox'));
    expect(await list?.$$eval('[role="option"]', options => options.map(option => option.textContent))).toEqual([
      '全局默认',
      '平台档：webui',
    ]);
    const placed = await page.$eval(
      '.select-popup',
      (popup, trigger) => {
        const box = popup.getBoundingClientRect();
        const at = (trigger as Element).getBoundingClientRect();
        const option = (popup.querySelector('[role="option"]') as Element).getBoundingClientRect();
        return {
          sheet: Math.round(box.bottom) === innerHeight && box.left === 0 && Math.round(box.width) === innerWidth,
          below: Math.round(box.left) === Math.round(at.left) && box.top >= at.bottom,
          option: option.height,
        };
      },
      picker,
    );
    expect(placed).toMatchObject(phone ? { sheet: true, option: 48 } : { sheet: false, below: true, option: 32 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.select-popup', { hidden: true });
    await page.waitForSelector('main .setting-row');
    await page.locator(`main ${aria('高级', 'button')}`).click();
    const rows = await page.$$eval('main .setting-row', fieldsets => fieldsets.map(f => f.getAttribute('aria-label')));
    const registered = stack.app
      .bind({ sessionManager })
      .sessionManager.require()
      .listSettings()
      .map(setting => setting.field.label);
    expect([...rows].sort()).toEqual([...registered].sort());
    await page.waitForSelector(`main .setting-row[aria-label="深度思考"] ${text('当前模型不能调')}`);

    await open('外观');
    await page.waitForSelector(`main ${aria('主题文件', 'list')}`);
    expect(await page.$$(`main ${aria('主题文件', 'list')} li`)).toHaveLength(8);
    expect(
      await page.$$eval(`main ${aria('会话面板标签', 'list')} li`, items =>
        items.map(item => item.firstElementChild?.textContent),
      ),
    ).toEqual(['计划', '设置', '用量', '后台']);

    await open('权限');
    const address = await page.evaluate(() => location.pathname);
    expect(address).toBe(`/settings/p/${encodeURIComponent('@aalis/plugin-authority')}/authority`);
    await page.reload();
    await page.waitForSelector(`main ${aria('权限', 'heading')}`);
    // 手机上这一层只有这一节，目录在上一层
    if (!phone) await page.waitForSelector(`${directory} ${aria('权限', 'link')}`);
    expect(problems).toEqual([]);
  }, 60_000);

  it('运行状况（最少插件组合）：从图标栏底部（手机上第一层）进去；「需要处理」写明没有，平台连接只有 WebUI 一行且在线；日志的「审批」预设筛出审批结算的那一行，筛选写进地址，刷新后筛选与那一行都在', async () => {
    const SERVER = '@aalis/plugin-session-server';
    const stack = await startStack();
    const { page, problems } = await openPage(stack, viewport);
    await page.locator(`${phone ? '[aria-label="入口"]' : '.shell-rail'} ${aria('运行状况', 'link')}`).click();
    await page.waitForFunction(() => location.pathname === '/health');
    await page.waitForSelector(`main ${text('没有需要处理的事')}`);
    const platforms = await page.waitForSelector(`main ${aria('平台连接', 'list')}`);
    expect(
      await platforms?.$$eval('li', rows =>
        rows.map(row => [
          row.querySelector('.list-item-title')?.textContent,
          row.querySelector('.list-item-meta')?.textContent,
        ]),
      ),
    ).toEqual([['WebUI', '在线']]);

    await page.locator(`main ${aria('日志', 'tab')}`).click();
    await page.waitForFunction(() => location.pathname === '/health/logs');
    await page.locator(`main ${aria('审批', 'link')}`).click();
    await page.waitForFunction(id => location.search === `?plugin=${encodeURIComponent(id)}`, {}, SERVER);
    // 自主回合发起的审批发起时就按拒绝结算，会话服务记一行
    const { id: sessionId } = await stack.app
      .bind({ sessionManager })
      .sessionManager.require()
      .createSession({ name: '审批探针' });
    await stack.app
      .bind({ approvals })
      .approvals.require()
      .request({
        sessionId,
        origin: { kind: 'autonomous', platform: 'webui', userId: 'console' },
        tool: DEPLOY,
        args: { command: COMMAND },
        rule: 'e2e',
      });
    const settled = `main ${aria('日志', 'list')} ${text(`审批结算：会话 ${sessionId}，工具 ${DEPLOY}，拒绝`)}`;
    await page.waitForSelector(settled);
    const scopes = () =>
      page.$$eval(`main ${aria('日志', 'list')} .log-scope`, cells => cells.map(cell => cell.textContent));
    for (const scope of await scopes()) expect(scope?.startsWith(`aalis:${SERVER}`), scope ?? '').toBe(true);

    await page.reload();
    await page.waitForSelector(settled);
    expect(await page.$eval(`main ${aria('插件', 'combobox')}`, element => element.textContent)).toBe('会话服务');
    for (const scope of await scopes()) expect(scope?.startsWith(`aalis:${SERVER}`), scope ?? '').toBe(true);
    expect(problems).toEqual([]);
  }, 60_000);

  it('停掉会话服务：会话区写「会话服务未启用」并链到它的插件详情，在那里重新启用后会话区回来', async () => {
    const SERVER = '@aalis/plugin-session-server';
    const stack = await startStack();
    const { page, problems } = await openPage(stack, viewport, `/plugins/${encodeURIComponent(SERVER)}`);
    await page.locator(`main ${aria('停用', 'button')}`).click();
    await page.waitForSelector(`main ${aria('启用', 'button')}`);
    expect(stack.app.plugins.getPlugin(SERVER)?.state).toBe('disabled');

    if (phone) {
      await page.locator(`main ${aria('返回', 'button')}`).click();
      await page.waitForFunction(() => location.pathname === '/plugins');
      await page.locator(`nav[aria-label="插件"] ${aria('返回', 'button')}`).click();
    } else {
      await page.locator(`.shell-rail ${aria('会话', 'link')}`).click();
    }
    await page.waitForFunction(() => location.pathname === '/');
    // 手机第一层写在会话列表里，桌面上只写在主区
    const area = phone ? 'nav[aria-label="会话"]' : 'main';
    await page.waitForSelector(`${area} ${text('会话服务未启用')}`);
    if (!phone) expect(await page.$$(text('会话服务未启用'))).toHaveLength(1);
    await page.locator(`${area} ${aria('去处理', 'link')}`).click();
    await page.waitForFunction(id => location.pathname === `/plugins/${encodeURIComponent(id)}`, {}, SERVER);
    await page.locator(`main ${aria('启用', 'button')}`).click();
    await page.waitForSelector(`main ${aria('停用', 'button')}`);
    expect(stack.app.plugins.getPlugin(SERVER)?.state).toBe('active');

    if (phone) {
      await page.locator(`main ${aria('返回', 'button')}`).click();
      await page.locator(`nav[aria-label="插件"] ${aria('返回', 'button')}`).click();
    } else {
      await page.locator(`.shell-rail ${aria('会话', 'link')}`).click();
    }
    await page.waitForSelector(`nav[aria-label="会话"] ${text('还没有会话')}`);
    expect(await page.$$(text('会话服务未启用'))).toHaveLength(0);
    expect(problems).toEqual([]);
  }, 60_000);

  it('需要处理：待配置的插件与插件的提示在首页摘要（手机上在第一层顶部）里，标签页标题、运行状况的角标（手机上是第一层入口的数）带上数目；「去配置」进插件详情的配置区，改好配置后少一条；提示也在发出它的插件详情里，运行状况列出同样的几条', async () => {
    const stack = await startStack({}, [noticeProbe]);
    await stack.app.plugin(needsConfig, {});
    await stack.app.plugins.idle();
    const { page, problems } = await openPage(stack, viewport);
    const summary = `${phone ? 'nav[aria-label="会话"]' : 'main'} ${aria('需要处理', 'region')}`;
    await page.waitForSelector(`${summary} ${text('打开作品审核')}`);
    expect(await page.$eval(`${summary} h2`, heading => heading.textContent)).toBe('需要处理 · 2');
    expect(await attentionRows(page, summary)).toEqual([
      ['要配置的探针', '待配置：endpoint', '去配置'],
      ['2 件作品待裁决', '提示的探针 · 最早的一件已等 3 天', '打开作品审核'],
    ]);
    await page.waitForFunction(() => document.title === '(2) T');
    const entry = `${phone ? '[aria-label="入口"]' : '.shell-rail'} a[href="/health"]`;
    expect(await page.$eval(`${entry} .badge`, badge => badge.textContent)).toBe('2');
    if (!phone) {
      expect(await page.$eval(entry, link => link.getAttribute('aria-label'))).toBe('运行状况，2 项需要处理');
    }

    await page.locator(`${summary} ${aria('去配置', 'link')}`).click();
    await page.waitForFunction(
      name => location.pathname === `/plugins/${name}` && location.hash === '#config',
      {},
      NEEDS_CONFIG,
    );
    await stack.app.plugins.updateConfig(NEEDS_CONFIG, { endpoint: 'http://upstream.invalid' });
    await page.waitForFunction(() => document.title === '(1) T');

    await page.goto(`${stack.origin}/plugins/${NOTICE_PROBE}`);
    const block = `main ${aria('需要处理', 'region')}`;
    await page.waitForSelector(`${block} ${text('打开作品审核')}`);
    expect(await attentionRows(page, block)).toEqual([['2 件作品待裁决', '最早的一件已等 3 天', '打开作品审核']]);
    await page.locator(`${block} ${aria('打开作品审核', 'link')}`).click();
    await page.waitForFunction(path => location.pathname === path, {}, pagePath(NOTICE_PROBE, 'queue'));

    await page.goto(`${stack.origin}/health`);
    await page.waitForSelector(`${block} ${text('打开作品审核')}`);
    expect(await attentionRows(page, block)).toEqual([
      ['2 件作品待裁决', '提示的探针 · 最早的一件已等 3 天', '打开作品审核'],
    ]);
    if (!phone) expect(await page.$eval(`${entry} .badge`, badge => badge.textContent)).toBe('1');
    expect(problems).toEqual([]);
  }, 60_000);

  it('缺必填配置起不来的插件：树上标着待配置，详情写没填的键；照样能改配置（改了以后行尾出现撤销，正在填的输入框不挪位置、不变窄），保存即重新激活，转为运行中', async () => {
    const stack = await startStack();
    await stack.app.plugin(needsConfig, {});
    await stack.app.plugins.idle();
    expect(stack.app.plugins.getPlugin(NEEDS_CONFIG)?.state).toBe('error');
    const { page, problems } = await openPage(stack, viewport, '/plugins');
    const row = await page.waitForSelector(pluginLink(NEEDS_CONFIG));
    expect(await row?.evaluate(link => link.textContent)).toBe('需要处理要配置的探针待配置');
    await row?.click();
    await page.waitForSelector(`.plugin-summary ${text('endpoint')}`);
    const field = await page.waitForSelector(`main ${aria('服务地址', 'textbox')}`);
    const box = () =>
      field?.evaluate(element => {
        const { top, left, right } = element.getBoundingClientRect();
        return { top, left, right };
      });
    const before = await box();
    await field?.type('http://upstream.invalid');
    await page.waitForSelector(`.config-bar ${text('1 项未保存')}`);
    await page.waitForSelector(`main ${aria('撤销服务地址', 'button')}`);
    expect(await box()).toEqual(before);
    await page.locator(`main ${aria('保存并重载', 'button')}`).click();
    await page.waitForSelector(`.plugin-summary ${text('运行中')}`);
    expect(stack.app.plugins.getPlugin(NEEDS_CONFIG)?.state).toBe('active');
    await page.waitForSelector(`.config-bar ${text('插件 zz-e2e-needs-config 配置已更新')}`);
    if (!phone) {
      await page.waitForFunction(
        selector => document.querySelector(selector)?.textContent === '要配置的探针',
        {},
        pluginLink(NEEDS_CONFIG),
      );
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('声明式页面按宽度变形：宽时各列都在、行上第一个动作是文字按钮、详情在右边；窄时只留 primary 列、长的字折行而不把后面的列挤出视野、动作都在「更多」、详情代替列表', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, viewport, pagePath(PAGES_PROBE, 'board'));
    await page.waitForSelector(`td[data-column="name"] ${text('整理周报')}`);
    expect(await shownColumns(page, 'main')).toEqual(phone ? ['name', 'state'] : ['name', 'owner', 'state', 'note']);
    expect(await page.$$(aria('标记', 'button'))).toHaveLength(phone ? 0 : 3);
    /** 表格在自己的框里放得下，不用横向滚动才看得到后面的列 */
    const fits = (scope: string) =>
      page.$eval(`${scope} .table-scroll`, element => element.scrollWidth <= element.clientWidth);
    expect(await fits('main')).toBe(true);

    await page.locator(`tr:first-child ${aria('更多', 'button')}`).click();
    const items = await page.$$eval('[role="menuitem"]', elements => elements.map(element => element.textContent));
    expect(items).toEqual(phone ? ['标记', '删除'] : ['删除']);
    await page.keyboard.press('Escape');

    await page.locator(aria('整理周报', 'link')).click();
    await page.waitForSelector(`${aria('整理周报', 'region')} ${text('编号')}`);
    const listShown = () => page.$eval('.page-master-list', element => getComputedStyle(element).display !== 'none');
    expect(await listShown()).toBe(!phone);
    // 窄时详情代替这一屏：同一屏的其他组件收起；宽时列表变窄，按表格的窄宽度规则只留主要列
    const shownBlocks = await page.$$eval(
      'main .page-screen > .page-block',
      blocks =>
        blocks.filter(block => !block.closest('.page-detail') && getComputedStyle(block).display !== 'none').length,
    );
    expect(shownBlocks).toBe(phone ? 1 : 2);
    if (phone) {
      await page.locator(aria('返回列表', 'button')).click();
      await page.waitForSelector(aria('整理周报', 'region'), { hidden: true });
      expect(await listShown()).toBe(true);
    } else {
      expect(await page.$$(aria('返回列表', 'button'))).toHaveLength(0);
      const [list, detail] = await page.$$eval('.page-master-list, .page-detail', elements =>
        elements.map(element => element.getBoundingClientRect().toJSON() as DOMRect),
      );
      expect(detail.left).toBeGreaterThanOrEqual(list.right);
      expect(await shownColumns(page, '.page-master-list')).toEqual(['name', 'state']);
      expect(await fits('.page-master-list')).toBe(true);
      await page.locator(aria('关闭详情', 'button')).click();
      await page.waitForSelector(aria('整理周报', 'region'), { hidden: true });
    }
    expect(new URL(page.url()).search).toBe('');
    expect(problems).toEqual([]);
  }, 60_000);

  it('关系图：缩放按钮里的图标与标题栏的一样大；图例只列图里有的类别；点选节点看详情，不留浏览器的默认焦点框', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, viewport, pagePath(PAGES_PROBE, 'stats'));
    await page.waitForSelector(`.page-graph ${text('小明')}`);
    const sizes = await page.$$eval('main header [aria-label="刷新"] .lucide, .page-graph-zoom .lucide', icons =>
      icons.map(icon => icon.getBoundingClientRect().width),
    );
    expect(sizes).toHaveLength(4);
    expect(new Set(sizes).size).toBe(1);
    expect(await page.$$eval('.page-graph-legend li', items => items.map(item => item.textContent))).toEqual([
      '人物',
      '认识',
    ]);

    await page.locator(aria('小明', 'button')).click();
    await page.waitForSelector(`${aria('小明', 'region')} ${text('编号')}`);
    // 触屏上点按不移焦点；桌面上点中的节点得到焦点，但不该画出焦点框
    if (!phone)
      expect(
        await page.evaluate(() => [
          document.activeElement?.getAttribute('aria-pressed'),
          getComputedStyle(document.activeElement as Element).outlineStyle,
        ]),
      ).toEqual(['true', 'none']);
    expect(problems).toEqual([]);
  }, 60_000);

  it('长文本与状态单元格：长文本收起时只占一行、点开后显示全文，短的状态不折开、长的窄时折行；表格在自己的框里放得下', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, viewport, pagePath(PAGES_PROBE, 'stats'));
    const log = `${aria('日志', 'table')}`;
    await page.waitForSelector(`${log} .page-long-text`);
    /** 一个元素占几行：按它的高度与行高算 */
    const lines = (selector: string) =>
      page.$eval(selector, element =>
        Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight)),
      );
    const fits = () =>
      page.$eval(`${log}`, table => {
        const scroll = table.closest('.table-scroll') as HTMLElement;
        return scroll.scrollWidth <= scroll.clientWidth;
      });
    expect(await lines(`${log} .page-long-text > span`)).toBe(1);
    expect(await lines(`${log} .status-text`)).toBe(1);
    expect(await fits()).toBe(true);
    const failed = `${log} tbody tr:nth-child(2)`;
    expect(
      await page.$eval(`${failed} td[data-column="message"]`, cell => cell.getBoundingClientRect().width),
    ).toBeGreaterThan(80);
    if (phone) expect(await lines(`${failed} .status-text`)).toBeGreaterThan(1);
    await page.locator(`${log} .page-long-text`).click();
    await page.waitForSelector(`${log} .page-long-text[aria-expanded="true"]`);
    // 点开后按格子的宽度折行，全文都不再被截
    expect(await lines(`${log} .page-long-text > span`)).toBeGreaterThan(1);
    expect(await page.$eval(`${log} .page-long-text > span`, span => span.scrollHeight <= span.clientHeight)).toBe(
      true,
    );
    expect(await fits()).toBe(true);
    expect(problems).toEqual([]);
  }, 60_000);

  it('数字列：表头的文字与数字右对齐（没排序时藏着的排序图标不占在文字右边）', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, viewport, pagePath(PAGES_PROBE, 'stats'));
    const counts = aria('次数', 'table');
    await page.waitForSelector(`${counts} td[data-column="count"]`);
    const rights = await page.$eval(counts, table => {
      const textRight = (node: Node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect().right;
      };
      const label = [...(table.querySelector('th[data-column="count"] button') as Element).childNodes].find(
        node => node.nodeType === Node.TEXT_NODE,
      ) as Node;
      return [textRight(label), textRight(table.querySelector('td[data-column="count"]') as Element)];
    });
    expect(Math.abs(rights[0] - rights[1])).toBeLessThanOrEqual(1);
    expect(problems).toEqual([]);
  }, 60_000);

  it('计划任务：「新建」是带输入的动作，保存后经 page.invalidate 出现在表里；「编辑」按这一行预填；「删除」先确认', async () => {
    const stack = await startStack({}, [cronEnginePlugin, schedulerPlugin]);
    const { page, problems } = await openPage(stack, viewport, pagePath(schedulerPlugin.name, 'scheduler'));
    await page.waitForSelector(text('还没有计划任务'));

    await page.locator(`main ${aria('新建', 'button')}`).click();
    await fill(page, '新建', {
      名称: '早报',
      'Cron 表达式': '0 8 * * *',
      '目标会话 ID': 'internal',
      消息内容: '整理今天的新闻',
    });
    await page.locator(`${aria('新建', 'dialog')} ${aria('新建', 'button')}`).click();
    await toastSays(page, '已保存任务 早报');
    await page.waitForSelector(`td[data-column="name"] ${text('早报')}`);
    await page.waitForSelector(aria('新建', 'dialog'), { hidden: true });

    await page.locator(`tbody tr ${aria('更多', 'button')}`).click();
    await page.locator(aria('编辑', 'menuitem')).click();
    const field = (label: string) =>
      page.$eval(`${aria('编辑', 'dialog')} ${aria(label, 'textbox')}`, element => (element as HTMLInputElement).value);
    expect([await field('Cron 表达式'), await field('目标会话 ID'), await field('消息内容')]).toEqual([
      '0 8 * * *',
      'internal',
      '整理今天的新闻',
    ]);
    await page.locator(`${aria('编辑', 'dialog')} ${aria('取消', 'button')}`).click();
    await page.waitForSelector(aria('编辑', 'dialog'), { hidden: true });

    await page.locator(`tbody tr ${aria('更多', 'button')}`).click();
    await page.locator(aria('删除', 'menuitem')).click();
    const confirm = await page.waitForSelector(aria('删除？', 'dialog'));
    expect(await confirm?.evaluate(element => element.textContent)).toContain('删除这个计划任务？');
    await page.locator(`${aria('删除？', 'dialog')} ${aria('删除', 'button')}`).click();
    await toastSays(page, '已删除 早报');
    await page.waitForSelector(text('还没有计划任务'));
    expect(problems).toEqual([]);
  }, 60_000);

  it('工作流：「新建或覆盖」保存后出现在表里，选中一行看 YAML 详情', async () => {
    const stack = await startStack({}, [cronEnginePlugin, workflowPlugin]);
    const { page, problems } = await openPage(stack, viewport, pagePath(workflowPlugin.name, 'workflows'));
    await page.waitForSelector(text('还没有工作流'));

    await page.locator(aria('新建或覆盖', 'button')).click();
    await fill(page, '新建或覆盖', { 'YAML 定义': WORKFLOW });
    await page.locator(`${aria('新建或覆盖', 'dialog')} ${aria('新建或覆盖', 'button')}`).click();
    await toastSays(page, '已保存工作流 zz-daily');
    await page.waitForSelector(aria('新建或覆盖', 'dialog'), { hidden: true });

    await page.locator(aria('每日整理', 'link')).click();
    await page.waitForSelector(`${aria('每日整理', 'region')} ${text('id: zz-daily')}`);
    if (phone) {
      expect(await page.$$(aria('定义', 'table'))).toHaveLength(0);
      await page.locator(aria('返回列表', 'button')).click();
      await page.waitForSelector(aria('每日整理', 'region'), { hidden: true });
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('固定与取消：从标题栏固定后出现在图标栏（手机上在第一层的「固定的页面」里），再按一次取消；所属插件停用时显示占位，重新启用后回到原页', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, viewport, pagePath(PAGES_PROBE, 'board'));
    await page.waitForSelector(aria('看板', 'heading'));
    const pin = aria('固定到图标栏', 'button');
    const pressed = (value: string) =>
      page.waitForFunction(
        value => document.querySelector('[aria-label="固定到图标栏"]')?.getAttribute('aria-pressed') === value,
        {},
        value,
      );
    /** 固定着的页面：桌面看图标栏；手机回第一层看「固定的页面」，再回到看板 */
    async function pinned(): Promise<Array<string | null>> {
      if (!phone) return (await railNames(page)).slice(1, -3);
      await page.locator(aria('返回', 'button')).click();
      await page.waitForFunction(() => location.pathname === '/');
      await page.waitForNetworkIdle({ idleTime: 300 });
      const names = await page.$$eval('[aria-label="固定的页面"] a', links => links.map(link => link.textContent));
      await page.goto(`${stack.origin}${pagePath(PAGES_PROBE, 'board')}`);
      await page.waitForSelector(aria('看板', 'heading'));
      return names;
    }

    await page.locator(pin).click();
    await pressed('true');
    expect(await pinned()).toEqual(['看板']);
    if (!phone) {
      expect(await page.$eval('.shell-rail a[aria-label="看板"]', link => link.getAttribute('aria-current'))).toBe(
        'page',
      );
    }

    await stack.app.plugins.disable(PAGES_PROBE);
    await page.waitForSelector(text('这个页面所属的插件已停用'));
    expect(await page.$eval(`main ${aria('去插件详情', 'link')}`, link => link.getAttribute('href'))).toBe(
      `/plugins/${PAGES_PROBE}`,
    );
    if (!phone) await page.waitForFunction(() => document.querySelectorAll('.shell-rail a').length === 4);
    await stack.app.plugins.enable(PAGES_PROBE);
    await page.waitForSelector(`td[data-column="name"] ${text('整理周报')}`);
    expect(await pinned()).toEqual(['看板']);

    await page.locator(pin).click();
    await pressed('false');
    expect(await pinned()).toEqual([]);
    expect(problems).toEqual([]);
  }, 60_000);

  it('会话面板：「+」打开便签，追加在宿主标签后面，换一个浏览器仍在；数据源拿到当前会话；面板宽度下表格只留 primary 列，刷新在标签栏里；关闭按钮只关当前标签，关了的标签（宿主的也一样）进「+」，再打开回到原位', async () => {
    const stack = await startStack({ 你好: '好的。' }, [probePages]);
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '你好');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(text('好的。'));
    await page.waitForSelector('[aria-label^="上下文已用"]');
    const notes = `aside ${text(`会话 ${sessionId}`)}`;
    const tabNames = () => page.$$eval('aside [role="tab"]', tabs => tabs.map(tab => tab.textContent));
    const closeButtons = () =>
      page.$$eval('aside [aria-label^="关闭「"]', buttons => buttons.map(button => button.getAttribute('aria-label')));
    /** 手机上关掉标签回到会话：等地址回到会话再进会话面板 */
    async function reenter() {
      await page.waitForFunction(id => location.pathname === `/s/${encodeURIComponent(id)}`, {}, sessionId);
      await openPanel(page);
    }
    /** 从「+」打开一项 */
    async function reopen(name: string) {
      await page.locator(aria('打开标签', 'button')).click();
      await page.locator(aria(name, 'menuitem')).click();
    }
    const opened = phone ? ['设置', '便签'] : ['设置', '用量', '便签'];

    await openPanel(page);
    await reopen('便签');
    await page.waitForSelector(notes);
    expect(new URL(page.url()).pathname).toBe(`/s/${encodeURIComponent(sessionId)}/p/${PAGES_PROBE}/notes`);
    expect(await tabNames()).toEqual(opened);
    expect(await closeButtons()).toEqual(['关闭「便签」']);
    expect(await shownColumns(page, 'aside')).toEqual(['text']);
    expect(await page.$$(`aside .tabs-bar ${aria('刷新', 'button')}`)).toHaveLength(1);

    await page.reload();
    await page.waitForSelector(notes);
    // 标签记录跟着 owner 存在服务端：换一个浏览器打开这个会话的面板，便签的标签照样在
    const other = await openPage(stack, viewport, `/s/${encodeURIComponent(sessionId)}/settings`);
    await other.page.waitForSelector(aria('便签', 'tab'));
    expect(other.problems).toEqual([]);

    await page.locator(`aside ${aria('关闭「便签」', 'button')}`).click();
    await reenter();
    await page.waitForSelector(aria('便签', 'tab'), { hidden: true });
    await reopen('便签');
    await page.waitForSelector(notes);
    expect(await tabNames()).toEqual(opened);

    await page.locator(aria('设置', 'tab')).click();
    await page.keyboard.press('Delete');
    await reenter();
    await page.waitForSelector(aria('设置', 'tab'), { hidden: true });
    await page.locator(aria('打开标签', 'button')).click();
    expect(await page.$$eval('[role="menuitem"]', items => items.map(item => item.textContent))).toEqual(['设置']);
    await page.locator(aria('设置', 'menuitem')).click();
    await page.waitForSelector('.setting-row');
    expect(await tabNames()).toEqual(opened);
    expect(problems).toEqual([]);
  }, 60_000);

  it('会话面板里的页面所属插件停用：面板里留着「已停用」，占位链到插件详情；插件回来后回到原页', async () => {
    const stack = await startStack({ 你好: '好的。' }, [probePages]);
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '你好');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(text('好的。'));
    await openPanel(page);
    await page.locator(aria('打开标签', 'button')).click();
    await page.locator(aria('便签', 'menuitem')).click();
    await page.waitForSelector(`aside ${text(`会话 ${sessionId}`)}`);

    await stack.app.plugins.disable(PAGES_PROBE);
    await page.waitForSelector(`aside ${text('这个页面所属的插件已停用')}`);
    expect(await page.$eval(`aside ${aria('已停用', 'tab')}`, tab => tab.getAttribute('aria-selected'))).toBe('true');
    expect(await page.$eval(`aside ${aria('去插件详情', 'link')}`, link => link.getAttribute('href'))).toBe(
      `/plugins/${PAGES_PROBE}`,
    );
    await stack.app.plugins.enable(PAGES_PROBE);
    await page.waitForSelector(`aside ${text(`会话 ${sessionId}`)}`);
    expect(await page.$$(`aside ${aria('已停用', 'tab')}`)).toHaveLength(0);
    expect(problems).toEqual([]);
  }, 60_000);

  it('插件前端（脚手架生成）：框架里列出数据源的条目，写明出处；主题令牌进了框架，切换深浅跟着变；删除经宿主确认框，确认后插件通知重取，框架里少了这一条', async () => {
    const stack = await startStack({}, [await scaffolded()]);
    const { page, problems } = await openPage(stack, viewport, pagePath(SCAFFOLD, SCAFFOLD));
    await page.waitForSelector(`.frame-source ${text(`来自 ${SCAFFOLD_NAME}`)}`);
    const frame = await frameIn(page);
    const items = () => frame.$$eval('li span', spans => spans.map(span => span.textContent));
    await frame.waitForFunction(() => document.querySelectorAll('li').length === 3);
    expect(await items()).toEqual(['示例条目一', '示例条目二', '示例条目三']);
    // 框架占满它的区域，自己不横向滚动
    expect(
      await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);

    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.waitForFunction(scheme => document.documentElement.dataset.theme === `calm-${scheme}`, {}, scheme);
      const background = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
      await frame.waitForFunction(
        (scheme, background) =>
          document.documentElement.dataset.theme === scheme &&
          getComputedStyle(document.body).backgroundColor === background,
        {},
        scheme,
        background,
      );
    }

    await frame.locator('li:first-child button').click();
    const dialog = await page.waitForSelector(aria('删除？', 'dialog'));
    expect(await dialog?.evaluate(element => element.textContent)).toMatch(/从列表里删掉这一条？.*条目.*示例条目一/);
    // 宿主对话框打开后 500 毫秒内不接受确认
    await new Promise(resolve => setTimeout(resolve, 600));
    await page.locator(`${aria('删除？', 'dialog')} ${aria('删除', 'button')}`).click();
    await toastSays(page, '已删除 示例条目一');
    await frame.waitForFunction(() => document.querySelectorAll('li').length === 2);
    expect(await items()).toEqual(['示例条目二', '示例条目三']);
    expect(problems).toEqual([]);
  }, 60_000);

  it('会话面板的插件前端：关掉宿主的「后台」标签（关的是整个标签，子会话与工具调用两组一起），从「+」打开申请了读会话与停回合的面板替代它；拿到当前会话，换会话后重新挂载拿到新的；列出会话、收到会话的增量，停掉在跑的回合', async () => {
    const stack = await startStack({ 你好: '好的。', 第二个: '第二个的回复', 慢慢说: SLOW_REPLY }, [
      framesPlugin(),
      backgroundProbe,
    ]);
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '你好');
    const first = await sessionIdOf(page);
    await page.waitForSelector(text('好的。'));
    // 宿主的「后台」标签两组都有：一个子会话，一个转到后台的工具调用
    await stack.app.bind({ sessionManager }).sessionManager.require().createChildSession(first, { name: '整理一节' });
    await send(page, '后台跑 delta');
    await page.waitForSelector(text(MOVED));
    await page.waitForSelector('[aria-label^="上下文已用"]');
    const tabNames = () => page.$$eval('aside [role="tab"]', tabs => tabs.map(tab => tab.textContent));
    /** 面板里的子会话框架写出的会话 */
    async function roster(sessionId: string): Promise<Frame> {
      const frame = await frameIn(page, 'aside');
      await frame.waitForFunction(id => document.querySelector('#session')?.textContent === id, {}, sessionId);
      return frame;
    }

    await openPanel(page);
    await page.locator(aria('后台', 'tab')).click();
    const groups = [`aside ${aria('子会话 · 1', 'region')}`, `aside ${aria('工具调用 · 1', 'region')}`];
    await page.waitForSelector(`${groups[0]} ${text('整理一节')}`);
    await page.waitForSelector(`${groups[1]} ${aria('delta', 'button')}`);
    await page.locator(`aside ${aria('关闭「后台」', 'button')}`).click();
    await openPanel(page);
    await page.waitForSelector(aria('后台', 'tab'), { hidden: true });
    for (const group of groups) expect(await page.$$(group)).toHaveLength(0);
    await page.locator(aria('打开标签', 'button')).click();
    expect(await page.$$eval('[role="menuitem"]', items => items.map(item => item.textContent))).toEqual([
      '后台',
      '子会话',
    ]);
    await page.locator(aria('子会话', 'menuitem')).click();
    let frame = await roster(first);
    expect(await tabNames()).toEqual(phone ? ['设置', '子会话'] : ['设置', '用量', '子会话']);
    await page.waitForSelector(`aside .frame-source ${text(`来自 ${FRAMES_NAME}`)}`);
    const listed = await frame.evaluate(() => (window as unknown as FrameWindow).frame.listSessions());
    expect(listed.sessions.map(session => session.id)).toEqual([first]);
    expect(listed).not.toHaveProperty('groups');
    if (!phone) {
      // 面板宽度下框架占满面板，自己不横向滚动
      const [panel, area] = await page.$$eval('aside .frame-page, aside iframe', elements =>
        elements.map(element => element.getBoundingClientRect().width),
      );
      expect(area).toBe(panel);
      expect(panel).toBeLessThan(400);
      expect(
        await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
    }

    // 换到另一个会话：面板标签照样开着，框架重新挂载，拿到新的会话
    if (phone) {
      await page.locator(aria('返回', 'button')).click();
      await page.locator(aria('返回', 'button')).click();
    } else {
      await page.locator(aria('新会话', 'button')).click();
    }
    await newSession(page);
    await send(page, '第二个会话');
    await page.waitForSelector(text('第二个的回复'));
    const second = await sessionIdOf(page);
    await openPanel(page);
    await page.locator(aria('子会话', 'tab')).click();
    frame = await roster(second);

    // 在第二个会话里说一段慢慢流出来的话，从面板停掉它：会话停下来的状态变化推进了框架，时间线上这一轮写「已停止」
    if (phone) await page.locator(aria('返回', 'button')).click();
    await send(page, '慢慢说');
    await page.waitForSelector('::-p-aria(正在输出)');
    await openPanel(page);
    if (phone) await page.locator(aria('子会话', 'tab')).click();
    frame = await roster(second);
    await frame.evaluate(id => (window as unknown as FrameWindow).frame.abortTurn({ sessionId: id }), second);
    await frame.waitForFunction(
      id =>
        (window as unknown as FrameWindow).changes.some(change => change.upserts.some(session => session.id === id)),
      {},
      second,
    );
    if (phone) await page.locator(aria('返回', 'button')).click();
    await page.waitForSelector('.turn-outcome[data-outcome="aborted"]');
    expect(await page.$$(text(SLOW_REPLY))).toHaveLength(0);
    expect(problems).toEqual([]);
  }, 90_000);

  it('后台任务：前台等满让出时限转到后台；工具卡保持活的，头部、左栏、「后台」标签与运行状况的「正在运行」都列出它；日志跟随输出，往上翻看时不被拽走；正常结束后收到结束通知、她回复，标签里移进「已结束」；结束通知在时间线里是一行状态，点开是这个任务的日志，刷新后一样', async () => {
    const stack = await startStack({}, [backgroundProbe]);
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '跑 build');
    const sessionId = await sessionIdOf(page);
    // 让出时限之前在前台：工具卡写运行中，还没有后台任务的那一行
    await page.waitForSelector(`.tool-call:not(:has(.task-foot)) .tool-line-status ${text('运行中')}`);
    await page.waitForSelector(text(MOVED));
    const offered = stack.requests.find(request => request.tools)?.tools?.map(tool => tool.function.name);
    expect(offered).toEqual(expect.arrayContaining(BACKGROUND_TOOLS));

    // 工具卡保持活的：转动、走着的耗时、实时更新的最后一行
    const card = '.tool-call:has(.task-foot)';
    await page.waitForSelector(`${card} .tool-line-status .status-text[data-state="running"]`);
    const shown = () =>
      page.$eval(card, element => [
        element.querySelector('.tool-line-status')?.textContent,
        element.querySelector('.task-last')?.textContent,
      ]);
    const [took, line] = await shown();
    expect(line).toMatch(/^build 第 \d+ 行$/);
    await page.waitForFunction(
      (card, took, line) => {
        const element = document.querySelector(card);
        return (
          element?.querySelector('.tool-line-status')?.textContent !== took &&
          element?.querySelector('.task-last')?.textContent !== line
        );
      },
      {},
      card,
      took,
      line,
    );
    if (phone) expect(await page.$$(`main ${aria('更多', 'button')}[data-dot]`)).toHaveLength(1);
    else expect(await page.$eval(BACKGROUND_METER, element => element.textContent)).toBe('后台 1');

    // 左栏（手机上是第一层）写「后台 1」；运行状况的「正在运行」列出这个会话与它在跑的命令
    const other = await openPage(stack, viewport);
    expect(await sessionRow(other.page, sessionId)).toContain('后台 1');
    await other.page.goto(`${stack.origin}/health`);
    const running = `main ${aria('正在运行', 'list')}`;
    await other.page.waitForSelector(`${running} ${aria('build', 'button')}`);
    expect(await other.page.$eval(running, element => element.textContent)).toContain('测试会话');

    await openBackground(page, 1);
    await page.waitForFunction(id => location.pathname === `/s/${encodeURIComponent(id)}/background`, {}, sessionId);
    const calls = `aside ${aria('工具调用 · 1', 'region')}`;
    await page.locator(`${calls} ${aria('在跑的工具调用', 'list')} ${aria('输出「build」', 'button')}`).click();

    // 日志：输出超出滚动区时贴着底部，新来的行接在后面、出现在视野里；往上翻看时新来的行不把看着的那段挪走
    const log = `${phone ? 'dialog' : 'aside'} .task-log-scroll`;
    await page.waitForFunction(
      (log, line) => document.querySelector(log)?.textContent?.includes(line),
      {},
      log,
      `build 第 ${JOB_BURST} 行`,
    );
    const view = () =>
      page.$eval(log, scroller => {
        const box = scroller.getBoundingClientRect();
        const text = (scroller.firstElementChild as HTMLElement).getBoundingClientRect();
        return {
          last: scroller.textContent?.trimEnd().split('\n').at(-1),
          overflow: scroller.scrollHeight > scroller.clientHeight,
          top: text.top - box.top,
          bottom: box.bottom - text.bottom,
        };
      });
    const pinned = await view();
    expect(pinned).toMatchObject({ overflow: true, bottom: 0 });
    const newer = (last: string | undefined) =>
      page.waitForFunction(
        (log, last) => document.querySelector(log)?.textContent?.trimEnd().split('\n').at(-1) !== last,
        {},
        log,
        last,
      );
    await newer(pinned.last);
    expect(await view()).toMatchObject({ bottom: 0 });
    await page.$eval(log, scroller => scroller.scrollBy(0, -200));
    const reading = await view();
    expect(reading.bottom).toBeLessThan(-150);
    await newer(reading.last);
    expect((await view()).top).toBe(reading.top);
    await page.locator(aria(phone ? '关闭' : '回到列表', 'button')).click();

    // 正常结束：结束通知开一轮、她回复；标签里移进「已结束」，头部与运行状况不再列出
    jobs.get('build')?.();
    await page.locator(`${calls} ${aria('已结束 · 1', 'button')}`).click();
    await page.waitForSelector(`${calls} ${aria('已结束的工具调用', 'list')} ${text('完成')}`);
    expect(await page.$$(`${calls} ${aria('在跑的工具调用', 'list')}`)).toHaveLength(0);
    await other.page.waitForSelector(running, { hidden: true });
    if (phone) await page.locator(aria('返回', 'button')).click();
    await page.waitForSelector(text(NOTICED));
    expect(await page.$eval(card, element => element.querySelector('.tool-line-status')?.textContent)).toMatch(
      /完成 · \d+\.\d 秒$/,
    );
    expect(await page.$$(BACKGROUND_METER)).toHaveLength(0);
    expect(await page.$$(`main ${aria('更多', 'button')}[data-dot]`)).toHaveLength(0);

    // 结束通知：一行写工具名、结局与用时，写给模型的那句话不显示；点开是这个任务的日志；刷新后一样
    const ended = 'main .turn > button.tool-line';
    const endedLine = await page.$eval(ended, element => element.textContent);
    expect(endedLine).toMatch(new RegExp(`^后台任务 ${JOB}完成 · \\d+\\.\\d 秒$`));
    expect(await page.$$(text('background_output'))).toHaveLength(0);
    await page.locator(ended).click();
    await page.waitForFunction(log => document.querySelector(log)?.textContent?.includes('build 第 1 行'), {}, log);
    await page.locator(aria(phone ? '关闭' : '回到列表', 'button')).click();
    await page.reload();
    await page.waitForSelector(text(NOTICED));
    expect(await page.$eval(ended, element => element.textContent)).toBe(endedLine);
    await page.locator(ended).click();
    await page.waitForFunction(log => document.querySelector(log)?.textContent?.includes('build 第 1 行'), {}, log);
    await page.locator(aria(phone ? '关闭' : '回到列表', 'button')).click();
    expect(await page.$$(text('background_output'))).toHaveLength(0);
    expect(problems).toEqual([]);
    expect(other.problems).toEqual([]);
  }, 90_000);

  it('后台任务：带 runInBackground 的立即转到后台；在「后台」标签与运行状况各停一个，停后标「已停止」，没有结束通知', async () => {
    const stack = await startStack({}, [backgroundProbe]);
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '后台跑 alpha');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(text(MOVED));
    // 立即转：起它的那一轮不等让出时限（1 秒）就收了尾
    const sessions = stack.app.bind({ sessionManager }).sessionManager.require();
    const tasks = stack.app.bind({ backgroundTasks }).backgroundTasks.require();
    await expect.poll(() => sessions.getSession(sessionId)?.lastTurn).toBeDefined();
    const [alpha] = tasks.list({ sessionId });
    expect(sessions.getSession(sessionId)?.lastTurn?.endedAt).toBeLessThan(alpha.startedAt + 1000);
    await send(page, '后台跑 beta');
    await page.waitForFunction(() => document.querySelectorAll('.task-foot').length === 2);

    await openBackground(page, 2);
    const calls = `aside ${aria('工具调用 · 2', 'region')}`;
    await page.locator(`${calls} ${aria('停止「alpha」', 'button')}`).click();
    await page.locator(`${calls} ${aria('已结束 · 1', 'button')}`).click();
    await page.waitForSelector(`${calls} ${aria('已结束的工具调用', 'list')} ${aria('alpha', 'button')}`);

    const health = await openPage(stack, viewport, '/health');
    const running = `main ${aria('正在运行', 'list')}`;
    await health.page.waitForSelector(`${running} ${aria('beta', 'button')}`);
    expect(await health.page.$$(`${running} ${aria('alpha', 'button')}`)).toHaveLength(0);
    await health.page.locator(`${running} ${aria('停止「beta」', 'button')}`).click();
    await health.page.waitForSelector(running, { hidden: true });

    const ended = `${calls} ${aria('已结束的工具调用', 'list')}`;
    await page.waitForSelector(`${ended} ${aria('beta', 'button')}`);
    expect(await page.$$eval(`${ended} .task-meta .status-text`, cells => cells.map(cell => cell.textContent))).toEqual(
      [expect.stringMatching(/^已停止 · /), expect.stringMatching(/^已停止 · /)],
    );
    expect(await page.$$(aria('全部停止', 'button'))).toHaveLength(0);
    expect(tasks.list({ sessionId }).map(task => task.status)).toEqual(['stopped', 'stopped']);
    if (phone) await page.locator(aria('返回', 'button')).click();
    expect(await page.$$eval('.tool-call .tool-line-status', cells => cells.map(cell => cell.textContent))).toEqual([
      expect.stringMatching(/^已停止 · /),
      expect.stringMatching(/^已停止 · /),
    ]);
    // 被停止的不通知：等一会儿，模型没有收到结束通知，时间线上也没有新的一轮
    await new Promise(resolve => setTimeout(resolve, 600));
    const notified = stack.requests.some(request =>
      request.messages.some(message => typeof message.content === 'string' && message.content.startsWith('[宿主通知]')),
    );
    expect(notified).toBe(false);
    expect(await page.$$('.message[data-from="agent"]')).toHaveLength(2);
    expect(problems).toEqual([]);
    expect(health.problems).toEqual([]);
  }, 90_000);

  it('子会话：「后台」标签按会话树列出子会话，带状态、耗时与 token；停掉父会话在等的那个，父会话的等待随即返回，「全部停止」停掉余下的；子会话页的路径逐层退回；父会话用量的累计含子会话', async () => {
    const stack = await startStack({}, [subtaskPlugin]);
    const sessions = stack.app.bind({ sessionManager }).sessionManager.require();
    const { id: parentId } = await sessions.createSession(
      { config: { enabledToolGroups: ['subtask'] } },
      { createdFrom: 'webui' },
    );
    const { page, problems } = await openPage(stack, viewport, `/s/${encodeURIComponent(parentId)}`);
    await send(page, SPLIT);
    // 整理目录的很快回完，另两个一直在跑
    await openBackground(page, 2);
    const children = `aside ${aria('子会话 · 3', 'region')}`;
    /** 一个子会话那一行的字：标题与第二行 */
    const row = (name: string) =>
      page.$$eval(
        `${children} .list-item-link`,
        (links, name) => links.find(link => link.querySelector('.list-item-title')?.textContent === name)?.textContent,
        name,
      );
    await page.waitForSelector(`${children} ${aria('子会话', 'list')} ${text('第二节')}`);
    expect(await row('第一节')).toMatch(/^第一节运行中\d+\.\d 秒$/);
    await page.locator(`${children} ${aria('已结束 · 1', 'button')}`).click();
    expect(await row('目录')).toMatch(/^目录完成\d+\.\d 秒1\.5k token$/);

    // 停掉父会话在等的第一节：等待随即返回、报已停止，她收尾；第二节还在跑
    await page.locator(`${children} ${aria('停止「第一节」', 'button')}`).click();
    await page.waitForSelector(`${children} ${aria('已结束 · 2', 'button')}`);
    expect(await row('第一节')).toMatch(/^第一节已停止\d+\.\d 秒$/);
    const waited = () =>
      stack.requests
        .flatMap(request => request.messages)
        .find(message => message.role === 'tool' && String(message.content).includes('"allCompleted"'))?.content;
    await expect.poll(waited).toBeDefined();
    expect(JSON.parse(String(waited()))).toMatchObject({
      timedOut: false,
      subtasks: [
        { name: '目录', status: 'completed' },
        { name: '第一节', status: 'stopped' },
      ],
    });
    await page.locator(`aside ${aria('全部停止', 'button')}`).click();
    await page.waitForSelector(`${children} ${aria('已结束 · 3', 'button')}`);
    expect(await row('第二节')).toMatch(/^第二节已停止\d+\.\d 秒$/);
    expect(await page.$$(aria('全部停止', 'button'))).toHaveLength(0);
    if (phone) await page.locator(aria('返回', 'button')).click();
    await page.waitForSelector(text(SUBTASKS_DONE));
    expect(await page.$$(BACKGROUND_METER)).toHaveLength(0);

    // 用量：累计的输入与输出是会话树上的数，写明含子会话
    if (phone) {
      await page.locator('[aria-label^="上下文已用"]').click();
      await page.waitForSelector(`dialog ${aria('上下文用量', 'table')}`);
    } else {
      await page.locator(aria('用量', 'tab')).click();
    }
    expect(await page.$eval('.usage-total', element => element.textContent)).toBe(
      '累计输入 1.2k，输出 340（含子会话）',
    );

    // 子会话页的路径：各级父会话写在标题前，点哪一级回到哪一级；手机上的返回回到父会话
    const [outline] = sessions.getChildren(parentId).filter(child => child.name === '目录');
    const appendix = await sessions.createChildSession(outline.id, { name: '附录' });
    const trail = () =>
      page.$eval('main .session-trail', element => [...element.children].map(child => child.textContent));
    await page.goto(`${stack.origin}/s/${encodeURIComponent(appendix.id)}`);
    await page.waitForSelector('main .session-trail');
    expect(await trail()).toEqual(['测试会话', '', '目录', '', '附录']);
    await page.locator(`main .session-trail ${aria('目录', 'link')}`).click();
    await page.waitForFunction(id => location.pathname === `/s/${encodeURIComponent(id)}`, {}, outline.id);
    expect(await trail()).toEqual(['测试会话', '', '目录']);
    await page.locator(phone ? aria('返回', 'button') : `main .session-trail ${aria('测试会话', 'link')}`).click();
    await page.waitForFunction(id => location.pathname === `/s/${encodeURIComponent(id)}`, {}, parentId);
    await page.waitForSelector(text(SUBTASKS_DONE));
    expect(problems).toEqual([]);
  }, 90_000);

  it('归档一个有后台任务在跑的会话：任务不停，运行状况照样列出、写明已归档，并能停', async () => {
    const stack = await startStack({}, [backgroundProbe]);
    const { page, problems } = await openPage(stack, viewport);
    await newSession(page);
    await send(page, '后台跑 gamma');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(text(MOVED));
    await page.locator(`main ${aria('更多', 'button')}`).click();
    await page.locator(aria('归档', 'menuitem')).click();
    await toastSays(page, '已归档「测试会话」');
    const tasks = stack.app.bind({ backgroundTasks }).backgroundTasks.require();
    expect(tasks.list({ sessionId }).map(task => task.status)).toEqual(['running']);

    const health = await openPage(stack, viewport, '/health');
    const running = `main ${aria('正在运行', 'list')}`;
    await health.page.waitForSelector(`${running} ${aria('gamma', 'button')}`);
    expect(await health.page.$eval(`${running} .list-item-meta`, element => element.textContent)).toBe('已归档');
    await health.page.locator(`${running} ${aria('全部停止「测试会话」', 'button')}`).click();
    await health.page.waitForSelector(running, { hidden: true });
    expect(tasks.list({ sessionId }).map(task => task.status)).toEqual(['stopped']);
    expect(problems).toEqual([]);
    expect(health.problems).toEqual([]);
  }, 60_000);
});

describe('反向代理', () => {
  it('升级请求的 Host 没转发（来源校验回 403）、页面的请求照常：连接横条提示检查反向代理；转发好了重连上写「已恢复」', async () => {
    const stack = await startStack();
    const { page, problems } = await openPage(stack, VIEWPORTS.desktop);
    await page.waitForSelector(aria('消息', 'textbox'));
    stack.misroute('upstream.invalid');
    stack.cut();
    const bar = aria('连接状态', 'status');
    await page.waitForSelector(`${bar} ${text('检查代理是否转发了原始的 Host 请求头')}`, { timeout: 20_000 });
    stack.misroute(undefined);
    await page.waitForSelector(`${bar} ${text('已恢复')}`, { timeout: 20_000 });
    // 被拒的升级是浏览器自己的握手失败，不算页面里的问题
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('页面数据', () => {
  it('page.invalidate：插件改了数据推一次，打开着的页面跟着更新，不用手动刷新', async () => {
    const stack = await startStack({}, [probePages]);
    const { page, problems } = await openPage(stack, VIEWPORTS.desktop, pagePath(PAGES_PROBE, 'board'));
    await page.waitForSelector(`td[data-column="name"] ${text('整理周报')}`);
    board.rows = [...board.rows, { id: 'd', name: '新来的一项', owner: '小李', state: { text: '待办' }, note: '' }];
    board.page?.invalidate('items');
    await page.waitForSelector(`td[data-column="name"] ${text('新来的一项')}`);
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('页面在外壳里的位置', () => {
  const desktop = VIEWPORTS.desktop;

  it('固定：两台设备同时从标题栏固定不同页面，两项都在、互相推到；换一个浏览器仍在，顺序一致', async () => {
    const stack = await startStack({}, [probePages]);
    const first = await openPage(stack, desktop, pagePath(PAGES_PROBE, 'board'));
    const second = await openPage(stack, desktop, pagePath(PAGES_PROBE, 'stats'));
    await first.page.waitForSelector(aria('看板', 'heading'));
    await second.page.waitForSelector(text('总数'));
    expect(await railNames(first.page)).toEqual(['会话', '运行状况', '插件', '设置']);

    await Promise.all([
      first.page.locator(aria('固定到图标栏', 'button')).click(),
      second.page.locator(aria('固定到图标栏', 'button')).click(),
    ]);
    for (const { page } of [first, second]) {
      await page.waitForFunction(() => document.querySelectorAll('.shell-rail a').length === 6);
      expect((await railNames(page)).sort()).toEqual(['会话', '看板', '统计', '运行状况', '插件', '设置'].sort());
    }
    const order = await railNames(first.page);
    const third = await openPage(stack, desktop);
    await third.page.waitForFunction(() => document.querySelectorAll('.shell-rail a').length === 6);
    expect(await railNames(third.page)).toEqual(order);
    for (const { problems } of [first, second, third]) expect(problems).toEqual([]);
  }, 60_000);
});

describe('插件区', () => {
  it('详情的页面块列出全部页面与位置，插件前端另写申请的宿主数据能力；插件页面可以点开', async () => {
    const stack = await startStack({}, [framesPlugin()]);
    const { page, problems } = await openPage(stack, VIEWPORTS.desktop, `/plugins/${FRAMES}`);
    await page.waitForSelector(`main ${aria('页面', 'heading')}`);
    expect(await page.$$eval('.plugin-pages li', items => items.map(item => item.textContent))).toEqual([
      '控件插件页面，打开后可以固定到图标栏；插件前端，不申请宿主数据',
      '探针插件页面，打开后可以固定到图标栏；插件前端，不申请宿主数据',
      '不用助手插件页面，打开后可以固定到图标栏；插件前端，不申请宿主数据',
      '子会话会话面板，在会话右侧面板的「+」里打开；插件前端，申请宿主数据：读会话树与状态、停止会话的回合',
    ]);
    await page.locator(`.plugin-pages ${aria('探针', 'link')}`).click();
    await page.waitForFunction(path => location.pathname === path, {}, pagePath(FRAMES, 'probe'));
    await frameIn(page);
    expect(problems).toEqual([]);
  }, 60_000);

  it('手机上移除多开插件的其余实例：详情头部有「移除实例」，确认后回到主实例，实例卸掉', async () => {
    const stack = await startStack({}, [multi]);
    const backup = `${MULTI}:backup`;
    await stack.app.plugin(multi, {}, backup);
    await stack.app.plugins.idle();
    const { page, problems } = await openPage(stack, VIEWPORTS.phone, `/plugins/${encodeURIComponent(backup)}`);
    await page.locator(`main ${aria('移除实例', 'button')}`).click();
    await page.locator(`${aria('移除实例「backup」？', 'dialog')} ${aria('移除', 'button')}`).click();
    await page.waitForFunction(id => location.pathname === `/plugins/${encodeURIComponent(id)}`, {}, MULTI);
    expect(stack.app.plugins.getPlugin(backup)).toBeUndefined();
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('插件前端的隔离', () => {
  const desktop = VIEWPORTS.desktop;

  /** 打开测试插件的一页，等框架握手完成；记下页面的告警 */
  async function openFrame(stack: Stack, key = 'probe') {
    const opened = await openPage(stack, desktop, pagePath(FRAMES, key));
    const warnings: string[] = [];
    opened.page.on('console', message => {
      if (message.type() === 'warn') warnings.push(message.text());
    });
    return { ...opened, warnings, frame: key === 'raw' ? undefined : await frameIn(opened.page) };
  }

  const LEFT = '这个页面离开了宿主给它的地址，已停止显示';

  it('握手完成前框架不可见：不用助手的框架加载完了也看不见；握手完成后看得见', async () => {
    const stack = await startStack({}, [framesPlugin()]);
    const visibility = (page: Page) => page.$eval('iframe', element => getComputedStyle(element).visibility);
    const raw = await openFrame(stack, 'raw');
    const frame = await (await raw.page.waitForSelector('iframe'))?.contentFrame();
    await frame?.waitForFunction(() => document.readyState === 'complete');
    expect(await visibility(raw.page)).toBe('hidden');
    const probe = await openFrame(stack);
    expect(await visibility(probe.page)).toBe('visible');
    expect([...raw.problems, ...probe.problems]).toEqual([]);
  }, 60_000);

  it('框架碰不到宿主：读父页面的文档抛错，cookie 与浏览器存储都读不到；顶层直接打开框架地址同样拿不到', async () => {
    const stack = await startStack({}, [framesPlugin()]);
    const { page, frame, problems } = await openFrame(stack);
    const probe = () => {
      const attempt = (read: () => unknown) => {
        try {
          read();
          return '读到了';
        } catch (error) {
          return (error as Error).name;
        }
      };
      return {
        origin: window.origin,
        parent: attempt(() => window.parent.document.title),
        cookie: attempt(() => document.cookie),
        storage: attempt(() => localStorage.length),
      };
    };
    expect(await frame?.evaluate(probe)).toEqual({
      origin: 'null',
      parent: 'SecurityError',
      cookie: 'SecurityError',
      storage: 'SecurityError',
    });

    const src = await page.$eval('iframe', element => (element.getAttribute('src') ?? '').split('#')[0]);
    const top = await page.browserContext().newPage();
    await top.goto(`${stack.origin}${src}`);
    expect(await top.evaluate(probe)).toMatchObject({
      origin: 'null',
      cookie: 'SecurityError',
      storage: 'SecurityError',
    });
    expect(problems).toEqual([]);
  }, 60_000);

  it('框架里注入的内联脚本与 onerror 都不执行，嵌不了别的网页；外站的图片、样式与数据请求都放行', async () => {
    const site = await externalSite();
    const stack = await startStack({}, [framesPlugin()]);
    const { frame, problems } = await openFrame(stack);
    const result = await frame?.evaluate(async outside => {
      const violations: string[] = [];
      document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
      const add = (tag: string, attributes: Record<string, string>, text = '') => {
        const element = document.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
        element.textContent = text;
        document.body.append(element);
      };
      add('script', {}, 'window.zzInline = 1');
      add('img', { onerror: 'window.zzOnerror = 1', src: 'data:,' });
      add('img', { src: `${outside}/zz-image.png` });
      add('link', { rel: 'stylesheet', href: `${outside}/zz-style.css` });
      add('iframe', { src: `${outside}/zz-page.html` });
      add('object', { data: `${outside}/zz-object.html` });
      const fetched = await fetch(`${outside}/zz-data`, { mode: 'no-cors' }).then(
        () => '取到了',
        (error: Error) => error.name,
      );
      await new Promise(resolve => setTimeout(resolve, 300));
      return {
        inline: 'zzInline' in window,
        onerror: 'zzOnerror' in window,
        fetched,
        violations: [...new Set(violations)].sort(),
      };
    }, site.origin);
    expect(result).toEqual({
      inline: false,
      onerror: false,
      fetched: '取到了',
      violations: ['frame-src', 'object-src', 'script-src-attr', 'script-src-elem'],
    });
    expect(['/zz-image.png', '/zz-style.css', '/zz-data'].map(site.hits)).toEqual([1, 1, 1]);
    expect(['/zz-page.html', '/zz-object.html'].map(site.hits)).toEqual([0, 0]);
    expect([...problems].sort()).toEqual(
      [
        'CSP 拦下了 inline（script-src-elem）',
        'CSP 拦下了 inline（script-src-attr）',
        `CSP 拦下了 ${site.origin}（frame-src）`,
        `CSP 拦下了 ${site.origin}（object-src）`,
      ].sort(),
    );
  }, 60_000);

  it('宿主接口不认框架的请求：取数不带登录状态回 401，改状态的请求按来源回 403，管理连接握手被拒', async () => {
    const stack = await startStack({}, [framesPlugin()]);
    const { frame, problems } = await openFrame(stack);
    const disable = `/api/plugins/${encodeURIComponent(FRAMES)}/disable`;
    const result = await frame?.evaluate(async disable => {
      const read = await fetch('/api/pages?zz-frame-probe', { credentials: 'include', mode: 'no-cors' });
      await fetch(disable, { method: 'POST', credentials: 'include', mode: 'no-cors' });
      const admin = await new Promise(resolve => {
        const socket = new WebSocket(`ws://${location.host}/admin`);
        socket.onopen = () => resolve('连上了');
        socket.onerror = () => resolve('被拒');
      });
      return { read: read.type, admin };
    }, disable);
    expect(result).toEqual({ read: 'opaque', admin: '被拒' });
    expect(stack.heard('zz-frame-probe')).toBe(true);
    expect(stack.app.plugins.getPlugin(FRAMES)?.state).toBe('active');
    await vi.waitFor(() =>
      expect([...problems].sort()).toEqual(
        [`401 ${stack.origin}/api/pages?zz-frame-probe`, `403 ${stack.origin}${disable}`].sort(),
      ),
    );
  }, 60_000);

  it('外链的地址与确认框里的输入值按原文显示，不当标记；没声明的数据源由服务端回 404，框架收到 not-found', async () => {
    const stack = await startStack({}, [framesPlugin()]);
    const { page, frame, problems } = await openFrame(stack);
    const URL_WITH_MARKUP = 'https://example.invalid/?q=<b>粗</b>';
    const ITEM_WITH_MARKUP = '<img src=x onerror="window.zz=1"><b>粗</b>';

    const opening = frame?.evaluate(
      url =>
        (window as unknown as FrameWindow).frame.open({ url }).then(
          () => '打开了',
          (error: { code: string }) => error.code,
        ),
      URL_WITH_MARKUP,
    );
    const external = await page.waitForSelector(aria('打开外部链接？', 'dialog'));
    expect(await external?.evaluate(element => element.textContent)).toContain(new URL(URL_WITH_MARKUP).href);
    expect(await external?.$$('b, img')).toHaveLength(0);
    await page.locator(`${aria('打开外部链接？', 'dialog')} ${aria('取消', 'button')}`).click();
    expect(await opening).toBe('cancelled');

    const dropping = frame?.evaluate(
      item =>
        (window as unknown as FrameWindow).frame.action('drop', { item }).then(
          () => '做了',
          (error: { code: string }) => error.code,
        ),
      ITEM_WITH_MARKUP,
    );
    const confirm = await page.waitForSelector(aria('丢弃？', 'dialog'));
    expect(await confirm?.evaluate(element => element.textContent)).toContain(ITEM_WITH_MARKUP);
    expect(await confirm?.$$('b, img')).toHaveLength(0);
    await page.locator(`${aria('丢弃？', 'dialog')} ${aria('取消', 'button')}`).click();
    expect(await dropping).toBe('cancelled');
    expect(await page.evaluate(() => 'zz' in window)).toBe(false);

    expect(
      await frame?.evaluate(() =>
        (window as unknown as FrameWindow).frame.data('zz-missing').then(
          () => '取到了',
          (error: { code: string }) => error.code,
        ),
      ),
    ).toBe('not-found');
    await vi.waitFor(() => expect(problems).toEqual([`404 ${stack.origin}/api/pages/${FRAMES}/probe/data/zz-missing`]));
  }, 60_000);

  it('离开自己的地址：框架里注入 meta refresh 跳到挂着子资源的页面，宿主立即卸载、显示占位、记告警；跳到外站被宿主文档的 CSP 拦下，照样卸载；不用助手的框架改了地址，靠第二次 load 卸载', async () => {
    const site = await externalSite();
    const stack = await startStack({}, [framesPlugin()]);
    stack.hold('never.png');
    const probe = await openFrame(stack);
    const refresh = (url: string) =>
      probe.frame?.evaluate(url => {
        const meta = document.createElement('meta');
        meta.httpEquiv = 'refresh';
        meta.content = `0;url=${url}`;
        document.head.append(meta);
      }, url);
    await refresh('away.html');
    await probe.page.waitForSelector(text(LEFT));
    expect(await probe.page.$$('iframe')).toHaveLength(0);
    // 跳到的页面开始加载、它的图一直没有回应：宿主没等 load
    expect([stack.heard('away.html'), stack.heard('never.png')]).toEqual([true, true]);
    expect(probe.warnings).toEqual([`插件前端「探针」（${FRAMES}）：${LEFT}`]);

    await probe.page.locator(aria('重新加载', 'button')).click();
    probe.frame = await frameIn(probe.page);
    await refresh(`${site.origin}/away.html`);
    await probe.page.waitForSelector(text(LEFT));
    expect(site.hits('/away.html')).toBe(0);
    expect(probe.problems).toEqual([`CSP 拦下了 ${site.origin}（frame-src）`]);
    expect(probe.warnings).toHaveLength(2);

    const raw = await openFrame(stack, 'raw');
    const frame = await (await raw.page.waitForSelector('iframe'))?.contentFrame();
    await frame?.waitForFunction(() => document.readyState === 'complete');
    await frame?.evaluate(() => location.assign('raw.html?again'));
    await raw.page.waitForSelector(text(LEFT));
    expect(await raw.page.$$('iframe')).toHaveLength(0);
    expect(raw.warnings).toEqual([`插件前端「不用助手」（${FRAMES}）：${LEFT}`]);
    expect(raw.problems).toEqual([]);
  }, 60_000);

  it('插件停用后框架消失、显示占位；重新启用后回到原页，框架重新挂上', async () => {
    const stack = await startStack({}, [framesPlugin()]);
    const { page, problems } = await openFrame(stack);
    await stack.app.plugins.disable(FRAMES);
    await page.waitForSelector(text('这个页面所属的插件已停用'));
    expect(await page.$$('iframe')).toHaveLength(0);
    await stack.app.plugins.enable(FRAMES);
    const frame = await frameIn(page);
    await frame.waitForFunction(() => document.querySelector('#ready')?.textContent === '已连上');
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('顶部横线与两侧分隔', () => {
  const wide: Viewport = { width: 1440, height: 900 };
  const ALL = ['.shell-rail', '.shell-left', '.shell-main', '.shell-right'];
  const LEFT = '调整左栏宽度';
  const RIGHT = '调整右侧面板宽度';

  /** 发一条消息、等到回复与右侧面板的标签：外壳的四栏都在 */
  async function openSession(stack: Stack) {
    const opened = await openPage(stack, wide);
    const box = await opened.page.waitForSelector(aria('消息', 'textbox'));
    await box?.type('你好');
    await opened.page.keyboard.press('Enter');
    await sessionIdOf(opened.page);
    await opened.page.waitForSelector(text('好的。'));
    await opened.page.waitForSelector(aria('设置', 'tab'));
    return opened;
  }

  /** 各栏头部的下边缘与下边线：图标栏顶上一格、左栏、主区、右侧面板，收起的栏不在 */
  async function expectOneLine(page: Page, columns: string[]) {
    const edges = await page.evaluate(
      (all: string[]) =>
        all.flatMap(column => {
          const header = document.querySelector(`${column} .header-bar`);
          if (!header || header.getClientRects().length === 0) return [];
          return [
            { column, bottom: header.getBoundingClientRect().bottom, line: getComputedStyle(header).borderBottomWidth },
          ];
        }),
      ALL,
    );
    expect(edges.map(edge => edge.column)).toEqual(columns);
    expect(new Set(edges.map(edge => edge.bottom)).size, JSON.stringify(edges)).toBe(1);
    expect(edges.map(edge => edge.line)).toEqual(columns.map(() => '1px'));
  }

  const widthOf = (page: Page, selector: string) =>
    page.$eval(selector, element => element.getBoundingClientRect().width);
  /** 显示着的分隔条 */
  const separators = (page: Page) =>
    page.$$eval('[role="separator"][aria-label^="调整"]', elements =>
      elements
        .filter(element => element.getClientRects().length > 0)
        .map(element => element.getAttribute('aria-label')),
    );
  async function centerOf(page: Page, name: string) {
    const box = await (await page.waitForSelector(aria(name, 'separator')))?.boundingBox();
    if (!box) throw new Error(`${name}不在`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  async function dragBy(page: Page, name: string, dx: number) {
    const { x, y } = await centerOf(page, name);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 5 });
    await page.mouse.up();
  }

  it('各栏头部的下边缘同一高度，横线从图标栏贯穿到右侧面板：深浅两套主题、左栏或右侧面板收起时都一样；选中标签的下划线压在横线上', async () => {
    const stack = await startStack({ 你好: '好的。' });
    const { page, problems } = await openSession(stack);
    expect(
      await page.$eval('.shell-right [role="tab"][aria-selected="true"]', tab => {
        const bar = tab.closest('.header-bar') as Element;
        return bar.getBoundingClientRect().bottom - tab.getBoundingClientRect().bottom;
      }),
    ).toBe(1);
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.waitForFunction(scheme => document.documentElement.dataset.theme === `calm-${scheme}`, {}, scheme);
      await expectOneLine(page, ALL);

      await page.locator(`.shell-rail ${aria('会话', 'link')}`).click();
      await page.waitForSelector('.shell[data-left="collapsed"]');
      await expectOneLine(page, ['.shell-rail', '.shell-main', '.shell-right']);
      await page.locator(`.shell-rail ${aria('会话', 'link')}`).click();

      await page.locator(`main ${aria('会话面板', 'button')}`).click();
      await page.waitForSelector('.shell[data-right="collapsed"]');
      await expectOneLine(page, ['.shell-rail', '.shell-left', '.shell-main']);
      await page.locator(`main ${aria('会话面板', 'button')}`).click();
      await page.waitForSelector('.shell:not([data-right])');
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('分隔条：拖动调宽、双击复原、拖到下限以下松手即收起，刷新后保持；窗口变窄时两侧按比例收、不低于下限，主区留最小宽度；抽屉沿用记住的宽度，抽屉与手机上没有分隔条', async () => {
    const stack = await startStack({ 你好: '好的。' });
    const { page, problems } = await openSession(stack);
    expect(await separators(page)).toEqual([LEFT, RIGHT]);
    expect(await widthOf(page, '.shell-left')).toBe(264);
    expect(await widthOf(page, '.shell-right')).toBe(360);

    await dragBy(page, RIGHT, -100);
    expect(await widthOf(page, '.shell-right')).toBe(460);
    await page.reload();
    await page.waitForSelector(aria('设置', 'tab'));
    expect(await widthOf(page, '.shell-right')).toBe(460);

    const right = await centerOf(page, RIGHT);
    await page.mouse.click(right.x, right.y, { count: 2 });
    expect(await widthOf(page, '.shell-right')).toBe(360);

    await dragBy(page, LEFT, -200);
    await page.waitForSelector('.shell[data-left="collapsed"]');
    expect(await separators(page)).toEqual([RIGHT]);
    await page.reload();
    await page.waitForSelector(aria('设置', 'tab'));
    expect(await page.$eval('.shell', shell => shell.getAttribute('data-left'))).toBe('collapsed');
    await page.locator(`.shell-rail ${aria('会话', 'link')}`).click();
    await page.waitForSelector('.shell:not([data-left])');
    expect(await widthOf(page, '.shell-left')).toBe(264);

    // 两侧都到上限后窗口变窄到放不下：按比例收，主区留 30rem
    await page.focus(aria(LEFT, 'separator'));
    await page.keyboard.press('End');
    await page.focus(aria(RIGHT, 'separator'));
    await page.keyboard.press('End');
    await page.setViewport({ width: 1280, height: 900 });
    const columns = () => Promise.all(ALL.map(selector => widthOf(page, selector)));
    const [rail, left, main, panel] = await columns();
    expect(main).toBe(480);
    expect(left / panel).toBeCloseTo(400 / 600, 3);
    expect(rail + left + main + panel).toBeCloseTo(1280, 1);
    // 收窄着拖动：从记住的宽度算起，往外拖不变窄，往里拖变窄
    await dragBy(page, LEFT, 40);
    expect(await widthOf(page, '.shell-left')).toBeGreaterThanOrEqual(left);
    await dragBy(page, LEFT, -40);
    expect(await widthOf(page, '.shell-left')).toBeLessThan(left);
    // 左栏在下限、右侧面板在上限：左栏不低于下限，右侧面板让出
    await page.focus(aria(LEFT, 'separator'));
    await page.keyboard.press('Home');
    expect(await columns()).toEqual([52, 220, 480, 528]);

    // 64em–80em：右侧面板是抽屉，沿用记住的宽度，没有分隔条；手机上都没有
    await page.setViewport({ width: 1100, height: 900 });
    expect(await separators(page)).toEqual([LEFT]);
    await page.locator(`main ${aria('会话面板', 'button')}`).click();
    await page.waitForSelector('.shell[data-drawer="right"]');
    expect(await widthOf(page, '.shell-right')).toBe(600);
    expect(await separators(page)).toEqual([LEFT]);
    await page.keyboard.press('Escape');
    await page.setViewport(VIEWPORTS.phone);
    await page.waitForSelector(aria('消息', 'textbox'));
    expect(await page.$$('[role="separator"][aria-label^="调整"]')).not.toHaveLength(0);
    expect(await separators(page)).toEqual([]);
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('控件与文字的比例', () => {
  /** 平板：触屏，有图标栏，左栏与右侧面板是抽屉 */
  const tablet: Viewport = { width: 820, height: 1180, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

  /** 按钮看得见的高（画出底色的部分：底色只画到边框以内时不算边框）、字重与左内边距 */
  const looks = (scope: Page | Frame, selector: string) =>
    scope.$eval(selector, element => {
      const style = getComputedStyle(element);
      const clipped = style.backgroundClip === 'padding-box';
      return {
        height: clipped ? element.clientHeight : element.getBoundingClientRect().height,
        weight: style.fontWeight,
        padding: style.paddingLeft,
      };
    });

  /** 宿主的输入框与次要、主要按钮：从会话头的「更多」打开改名框量，量完关上 */
  async function hostControls(page: Page) {
    const dialog = aria('改名', 'dialog');
    await page.locator(`main ${aria('更多', 'button')}`).click();
    await page.locator(aria('改名', 'menuitem')).click();
    await page.waitForSelector(dialog);
    const input = await page.$eval(`${dialog} ${aria('会话名', 'textbox')}`, element => {
      return element.getBoundingClientRect().height;
    });
    const secondary = await looks(page, `${dialog} ${aria('取消', 'button')}`);
    const primary = await looks(page, `${dialog} ${aria('保存', 'button')}`);
    await page.locator(`${dialog} ${aria('取消', 'button')}`).click();
    await page.waitForSelector(dialog, { hidden: true });
    return { input, secondary, primary };
  }

  /** 脚手架生成的插件前端：临时加进去的一个输入框（页面里本来没有）的高，与第一条的「删除」 */
  async function frameControls(frame: Frame) {
    const input = await frame.evaluate(() => {
      const input = document.body.appendChild(document.createElement('input'));
      const height = input.getBoundingClientRect().height;
      input.remove();
      return height;
    });
    return { input, secondary: await looks(frame, 'li button') };
  }

  /**
   * 触屏上量一个文档，开着模态框时只量框里。看得见的可点元素的点按范围是框与绝对定位的 ::before 取大，复选框取它所在
   * 的 label；记下不到 44×44 的、::before 大过 44 见方与框之大者（没贴在元素上）的，以及在点按范围四边内侧各取一点、
   * 命中的不是元素自己或它的后代（被别的元素压住）的。另回 filled 选中的有底色的按钮看得见的高（量法同 looks）
   */
  const touchTargets = (scope: Page | Frame, filled: string) =>
    scope.evaluate((filled: string) => {
      const root = document.querySelector('dialog:modal') ?? document;
      const shown = (element: Element) =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      const named = (element: Element) =>
        `${element.tagName.toLowerCase()}「${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 16)}」`;
      const faults = [...root.querySelectorAll('button, a[href], input, select, textarea')]
        .filter(shown)
        .flatMap(element => {
          const target = element.matches('[type="checkbox"], [type="radio"]')
            ? (element.closest('label') ?? element)
            : element;
          target.scrollIntoView({ block: 'center', inline: 'center' });
          const box = target.getBoundingClientRect();
          const before = getComputedStyle(target, '::before');
          const reach = before.position === 'absolute' && before.content !== 'none';
          const width = Math.max(box.width, reach ? Number.parseFloat(before.width) : 0);
          const height = Math.max(box.height, reach ? Number.parseFloat(before.height) : 0);
          const size = `${Math.round(width)}×${Math.round(height)}`;
          if (Math.round(width) < 44 || Math.round(height) < 44) return [`${named(element)}${size}`];
          if (width > Math.max(box.width, 44) + 1 || height > Math.max(box.height, 44) + 1) {
            return [`${named(element)}的 ::before ${size}`];
          }
          // 四边往里 1 像素取整数坐标，不到 1 像素的重叠不计
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          const w = Math.max(box.width, 44) / 2;
          const h = Math.max(box.height, 44) / 2;
          const sides: Array<[string, number, number]> = [
            ['上', x, Math.ceil(y - h) + 1],
            ['下', x, Math.floor(y + h) - 1],
            ['左', Math.ceil(x - w) + 1, y],
            ['右', Math.floor(x + w) - 1, y],
          ];
          return sides.flatMap(([side, px, py]) => {
            const hit = document.elementFromPoint(px, py);
            if (hit && target.contains(hit)) return [];
            return [`${named(element)}的${side}侧被${hit ? named(hit) : '视口外'}压住`];
          });
        });
      const heights = [...root.querySelectorAll(filled)]
        .filter(shown)
        .map(element =>
          getComputedStyle(element).backgroundClip === 'padding-box'
            ? element.clientHeight
            : element.getBoundingClientRect().height,
        );
      return { faults, heights };
    }, filled);

  it('桌面：按钮、图标按钮、输入框与选择框都是 28 像素高，左栏头部、输入框区、审批卡与改名框里同一处同高，带开关的设置行不被开关撑高；有底色的按钮字重常规，文字按钮中等；插件前端的按钮、输入框与宿主的次要按钮、输入框一样', async () => {
    // 最少插件组合里没有开关型的会话设置项：另登记一个
    const toggle = settingsPlugin('zz-e2e-toggle', [
      {
        key: 'clientSideJsonRendering',
        field: { type: 'boolean', label: '<开关>' },
        appliesTo: ['owner'],
        prominence: 'common',
      },
    ]);
    const stack = await startStack({}, [await scaffolded(), toggle]);
    const { page, problems } = await openPage(stack, VIEWPORTS.desktop);
    const box = await page.waitForSelector(aria('消息', 'textbox'));
    await box?.type('部署一下');
    await page.keyboard.press('Enter');
    await page.waitForSelector(aria('审批', 'region'));
    await page.waitForSelector(aria('设置', 'tab'));
    const heights = (selector: string) =>
      page.$$eval(selector, elements => elements.map(element => element.getBoundingClientRect().height));
    expect(await heights('.session-list-header > :is(.button, .icon-button)')).toEqual([28, 28]);
    expect(await heights('.composer-bar > :is(.icon-button, .select, .button)')).toEqual([28, 28, 28]);
    const approve = await looks(page, aria('批准', 'button'));
    const reject = await looks(page, aria('拒绝', 'button'));
    expect([approve.height, approve.weight, reject.height, reject.weight]).toEqual([28, '400', 28, '500']);
    const host = await hostControls(page);
    expect([
      host.input,
      host.secondary.height,
      host.secondary.weight,
      host.primary.height,
      host.primary.weight,
    ]).toEqual([28, 28, '400', 28, '400']);

    // 带开关的一行与只有一行字的行同高：行高只由字与上下内边距定
    await page.locator(aria('设置', 'tab')).click();
    const toggled = await page.waitForSelector('.setting-row-main:has(.toggle)');
    expect(
      await toggled?.evaluate(row => {
        const style = getComputedStyle(row);
        const label = (row.querySelector('.setting-row-label') as Element).getBoundingClientRect().height;
        return [
          row.getBoundingClientRect().height,
          label + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
        ];
      }),
    ).toEqual([36, 36]);

    await page.goto(`${stack.origin}${pagePath(SCAFFOLD, SCAFFOLD)}`);
    const frame = await frameIn(page);
    await frame.waitForFunction(() => document.querySelectorAll('li').length === 3);
    expect(await frameControls(frame)).toEqual({ input: host.input, secondary: host.secondary });
    expect(problems).toEqual([]);
  }, 60_000);

  it('触屏：设置行行尾的「恢复继承」与名字竖直居中对齐，只有名字的一行与名字下面写着值的一行一样；插件配置行尾的「撤销」与标签对齐', async () => {
    const align = settingsPlugin('zz-e2e-align', [
      {
        key: 'clientSideJsonRendering',
        field: { type: 'boolean', label: '<开关>' },
        appliesTo: ['owner'],
        prominence: 'common',
      },
      {
        key: 'systemPromptExtra',
        field: { type: 'string', label: '<额外提示>' },
        appliesTo: ['owner'],
        prominence: 'common',
      },
    ]);
    const stack = await startStack({ 你好: '在的。' }, [align]);
    await stack.app.plugin(needsConfig, {});
    await stack.app.plugins.idle();
    const { page, problems } = await openPage(stack, VIEWPORTS.phone);
    /** 两个元素看得见的框的竖直中线相差多少像素 */
    const offset = (scope: string, label: string, button: string) =>
      page.$eval(
        scope,
        (element, label, button) => {
          const middle = (selector: string) => {
            const { top, bottom } = (element.querySelector(selector) as Element).getBoundingClientRect();
            return (top + bottom) / 2;
          };
          return Math.round(middle(button) - middle(label));
        },
        label,
        button,
      );

    await page.locator(aria('新会话', 'button')).click();
    await (await page.waitForSelector(aria('消息', 'textbox')))?.type('你好');
    await page.locator(aria('发送', 'button')).click();
    await page.waitForSelector(text('在的。'));
    await page.locator(`main ${aria('更多', 'button')}`).click();
    await page.locator(aria('会话面板', 'menuitem')).click();
    await page.locator(aria('<开关>', 'switch')).click();
    const single = '.setting-row[aria-label="<开关>"]';
    await page.waitForSelector(`${single} ${aria('恢复继承', 'button')}`);
    await page.locator(`.setting-row ${aria('<额外提示>', 'button')}`).click();
    await (await page.waitForSelector(`.setting-row ${aria('<额外提示>', 'textbox')}`))?.type('简短');
    await page.keyboard.press('Enter');
    const double = '.setting-row[aria-label="<额外提示>"]';
    await page.waitForSelector(`${double} ${aria('恢复继承', 'button')}`);
    expect([
      await offset(single, '.setting-row-label', '.button'),
      await offset(double, '.setting-row-label', '.button'),
    ]).toEqual([0, 0]);

    await page.goto(`${stack.origin}/plugins/${NEEDS_CONFIG}`);
    await (await page.waitForSelector(`main ${aria('服务地址', 'textbox')}`))?.type('http://upstream.invalid');
    await page.waitForSelector(`main ${aria('撤销服务地址', 'button')}`);
    expect(await offset('.field-row:has([aria-label="撤销服务地址"])', '.field-row-label label', '.button')).toBe(0);
    expect(problems).toEqual([]);
  }, 60_000);

  it('触屏：会话页（审批等着）、会话设置、房间表（选中一行）、计划任务、插件前端与它的两种确认框、平板的首页里，看得见的可点元素点按范围都不小于 44×44、贴在元素上、不被别的元素压住，有底色的按钮看得见的比点按范围矮；插件前端的按钮、输入框与宿主的次要按钮、输入框一样，插件自己整个重置掉的按钮不挡住页面别处', async () => {
    const stack = await startStack({}, [cronEnginePlugin, schedulerPlugin, await scaffolded(), framesPlugin()], {
      'onebot:10000:group:20001': '读书会',
    });
    const { page, problems } = await openPage(stack, VIEWPORTS.phone);
    const faults: Record<string, string[]> = {};
    const filled: number[] = [];
    async function audit(where: string, scope: Page | Frame = page, selector = '.button:not([data-variant="text"])') {
      const found = await touchTargets(scope, selector);
      faults[where] = found.faults;
      filled.push(...found.heights);
    }

    await page.locator(aria('新会话', 'button')).click();
    await (await page.waitForSelector(aria('消息', 'textbox')))?.type('部署一下');
    await page.locator(aria('发送', 'button')).click();
    await page.waitForSelector(aria('审批', 'region'));
    await audit('会话页');
    const host = await hostControls(page);
    await page.locator(`main ${aria('更多', 'button')}`).click();
    await page.locator(aria('会话面板', 'menuitem')).click();
    await page.waitForSelector('.setting-row');
    await audit('会话设置');

    await page.goto(`${stack.origin}/rooms?platform=onebot`);
    await page.waitForSelector(`td[data-column="name"] ${text('读书会')}`);
    await page.locator('tbody .table-check label').click();
    await page.waitForSelector('.table-batch');
    await audit('房间表');

    await page.goto(`${stack.origin}${pagePath(schedulerPlugin.name, 'scheduler')}`);
    await page.waitForSelector(text('还没有计划任务'));
    await audit('计划任务');

    await page.goto(`${stack.origin}${pagePath(SCAFFOLD, SCAFFOLD)}`);
    const frame = await frameIn(page);
    await frame.waitForFunction(() => document.querySelectorAll('li').length === 3);
    await audit('插件前端', frame, 'button');
    // 悬停着量：悬停换了底色，仍只画到边框以内
    await frame.hover('li button');
    expect(await frameControls(frame)).toEqual({ input: host.input, secondary: host.secondary });
    await frame.locator('li:first-child button').click();
    await page.waitForSelector(aria('删除？', 'dialog'));
    await audit('插件前端的确认框');
    await page.locator(`${aria('删除？', 'dialog')} ${aria('取消', 'button')}`).click();

    // 插件把按钮整个重置掉（all: unset）：页面别处点到的仍是各自的元素
    await page.goto(`${stack.origin}${pagePath(FRAMES, 'controls')}`);
    const controls = await frameIn(page);
    await controls.waitForFunction(() => document.querySelector('#ready')?.textContent === '已连上');
    expect(
      await controls.evaluate(() =>
        [...document.querySelectorAll('h1, p, input, button:not(.icon), li')].flatMap(element => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return hit === element ? [] : [`${element.tagName.toLowerCase()}被${hit?.getAttribute('aria-label')}挡住`];
        }),
      ),
    ).toEqual([]);
    const opening = controls.evaluate(() =>
      (window as unknown as FrameWindow).frame.open({ url: 'https://example.invalid/' }).then(
        () => '打开了',
        (error: { code: string }) => error.code,
      ),
    );
    await page.waitForSelector(aria('打开外部链接？', 'dialog'));
    await audit('插件前端的外链确认框');
    await page.locator(`${aria('打开外部链接？', 'dialog')} ${aria('取消', 'button')}`).click();
    expect(await opening).toBe('cancelled');

    const other = await openPage(stack, tablet);
    await other.page.waitForSelector(aria('消息', 'textbox'));
    await audit('平板', other.page);

    expect(faults).toEqual({
      会话页: [],
      会话设置: [],
      房间表: [],
      计划任务: [],
      插件前端: [],
      插件前端的确认框: [],
      插件前端的外链确认框: [],
      平板: [],
    });
    expect(filled.length).toBeGreaterThan(0);
    expect(filled.filter(height => height >= 44)).toEqual([]);
    expect([...problems, ...other.problems]).toEqual([]);
  }, 90_000);
});

describe('文档与主题', () => {
  it('在 /s/:id 上刷新能加载；缺失的静态资源回 404', async () => {
    const stack = await startStack({ 你好: '好的。' });
    const { page, problems } = await openPage(stack, VIEWPORTS.desktop);
    const box = await page.waitForSelector(aria('消息', 'textbox'));
    await box?.type('你好');
    await page.keyboard.press('Enter');
    const sessionId = await sessionIdOf(page);
    await page.waitForSelector(text('好的。'));

    const reload = (await page.reload()) as HTTPResponse;
    expect(reload.status()).toBe(200);
    expect(reload.headers()['content-security-policy']).toBe(CSP);
    await page.waitForSelector(text('好的。'));
    expect(await sessionIdOf(page)).toBe(sessionId);

    const missing = await page.evaluate(async () => {
      const res = await fetch('/assets/missing-0000.js');
      return { status: res.status, body: await res.text() };
    });
    expect(missing).toEqual({ status: 404, body: '' });
    await vi.waitFor(() => expect(problems).toEqual([`404 ${stack.origin}/assets/missing-0000.js`]));
  }, 60_000);

  it('导入主题：在外观里导入并选中后整页换上它的令牌，插件前端照样收到；刷新时第一帧就是它', async () => {
    const stack = await startStack({}, [await scaffolded()]);
    const { page, problems } = await openPage(stack, VIEWPORTS.desktop, '/settings/appearance');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    const dir = mkdtempSync(join(tmpdir(), 'aalis-e2e-theme-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, '夜读.json');
    writeFileSync(
      file,
      JSON.stringify({
        format: 'aalis-theme',
        version: 1,
        name: '夜读',
        kind: 'dark',
        colors: { '--color-bg': '#101418', '--color-text': '#eef2f6' },
      }),
    );
    const input = (await page.waitForSelector('main input[type="file"]')) as ElementHandle<HTMLInputElement>;
    await input.uploadFile(file);
    await page.waitForSelector(`main [role="status"] ${text('已导入「夜读」')}`);
    await page.locator(aria('深色用', 'combobox')).click();
    await page.locator(aria('夜读（导入）', 'option')).click();
    const background = 'rgb(16, 20, 24)';
    await page.waitForFunction(
      background => getComputedStyle(document.documentElement).backgroundColor === background,
      {},
      background,
    );

    await page.goto(`${stack.origin}${pagePath(SCAFFOLD, SCAFFOLD)}`);
    const frame = await frameIn(page);
    await frame.waitForFunction(
      background => getComputedStyle(document.body).backgroundColor === background,
      {},
      background,
    );

    await page.evaluateOnNewDocument(() => {
      requestAnimationFrame(() => {
        (window as unknown as { firstFrame: unknown }).firstFrame = [
          document.documentElement.dataset.theme,
          getComputedStyle(document.documentElement).backgroundColor,
        ];
      });
    });
    await page.reload();
    await page.waitForFunction(() => 'firstFrame' in window);
    expect(await page.evaluate(() => (window as unknown as { firstFrame: unknown }).firstFrame)).toEqual([
      'imported:dark:夜读',
      background,
    ]);
    expect(problems).toEqual([]);
  }, 60_000);

  it('跟随系统：系统切换深浅时页面跟着换主题；刷新时第一帧就是选定的主题', async () => {
    const stack = await startStack();
    const { page, problems } = await openPage(stack, VIEWPORTS.desktop);
    const shows = (theme: string, background: string) =>
      page.waitForFunction(
        (theme, background) =>
          document.documentElement.dataset.theme === theme &&
          getComputedStyle(document.documentElement).backgroundColor === background,
        {},
        theme,
        background,
      );

    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await shows('calm-dark', 'rgb(29, 29, 32)');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await shows('calm-light', 'rgb(251, 251, 250)');

    // 第一帧之前的 requestAnimationFrame 回调里记下当时的主题与底色
    await page.evaluateOnNewDocument(() => {
      requestAnimationFrame(() => {
        (window as unknown as { firstFrame: unknown }).firstFrame = [
          document.documentElement.dataset.theme,
          getComputedStyle(document.documentElement).backgroundColor,
        ];
      });
    });
    await page.reload();
    await page.waitForFunction(() => 'firstFrame' in window);
    expect(await page.evaluate(() => (window as unknown as { firstFrame: unknown }).firstFrame)).toEqual([
      'calm-light',
      'rgb(251, 251, 250)',
    ]);

    // 固定一个内置主题：首帧脚本在内置主题的规则之后执行，认得出它，不会当成不在了换回默认
    await page.evaluate(() => localStorage.setItem('aalis.appearance', '{"follow":false,"theme":"brand-dark"}'));
    await page.reload();
    await page.waitForFunction(() => 'firstFrame' in window);
    expect(await page.evaluate(() => (window as unknown as { firstFrame: unknown[] }).firstFrame[0])).toBe(
      'brand-dark',
    );
    expect(problems).toEqual([]);
  }, 60_000);
});
