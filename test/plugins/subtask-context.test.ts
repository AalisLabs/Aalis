import { afterEach, describe, expect, it } from 'vitest';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import office from '../../packages/plugin-office/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { recordRoom } from '../fixtures/rooms.js';
import { startSubtaskHub } from '../fixtures/subtask.js';

// ════════════════════════════════════════════════════════════
// 子任务只写对任何并行子任务都成立的协作规则（只操作自己负责的范围、汇报做了什么），不写某个插件的事：
// 文档的 docId 与「子任务里不保存」写在 office 自己的工具说明里，create_subtask 的说明也不点名别的插件的工具。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:20001';
const CTX = { sessionId: ROOM, platform: 'onebot', userId: '30001' };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('子任务上下文与 create_subtask 的说明', () => {
  it('子会话的系统提示带协作规则，不写文档的 docId 与保存；create_subtask 的说明不点名别的插件的工具', async () => {
    const hub = await startSubtaskHub();
    apps.push(hub.app);
    await recordRoom(hub.host.events.use, ROOM, '群');
    const created = await hub.call('create_subtask', { task: '<任务>', name: '<任务名>' }, CTX);

    const messages: Message[] = [
      { role: 'system', content: '<人设>' },
      { role: 'user', content: '<任务>' },
    ];
    await hub.hooks.use.run('agent:llm:before', {
      messages,
      tools: [],
      acceptsImages: false,
      sessionId: created.subtaskId,
    });
    const system = String(messages[0].content);
    expect(system).toContain('--- 子任务上下文 ---');
    expect(system).toContain('只操作你负责的范围');
    expect(system).toContain('汇报你做了什么');
    expect(system).not.toContain('docId');
    expect(system).not.toContain('save');

    const description = hub.registered.get('create_subtask')?.definition.function.description ?? '';
    expect(description).toContain('create_subtask');
    expect(description).not.toContain('manage_todo_list');
    expect(description).not.toContain('docId');
    expect(description).not.toContain('save');
  });
});

describe('office 的工具说明写子任务怎么用文档', () => {
  async function descriptions(): Promise<Map<string, string>> {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    const host = app.bind({ provide });
    const out = new Map<string, string>();
    host.provide.use(tools, {
      register(tool: { definition: { function: { name: string; description: string } } }) {
        out.set(tool.definition.function.name, tool.definition.function.description);
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
    host.provide.use(storage, { listRoots: () => [] } as never);
    await app.plugins.register(office, {});
    await app.plugins.idle();
    return out;
  }

  it('建文档的工具写子任务直接用任务指令里给的 docId，保存的工具写子任务里不调用', async () => {
    const out = await descriptions();
    for (const name of ['doc_create', 'excel_create', 'ppt_create']) {
      expect(out.get(name), name).toContain('子任务直接用任务指令里给的 docId，不另建');
    }
    for (const name of ['doc_save', 'excel_save', 'ppt_save']) {
      expect(out.get(name), name).toContain('在子任务里不调用，由派发方在全部子任务完成后保存');
    }
  });
});
