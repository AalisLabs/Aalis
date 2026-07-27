import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import * as subtaskModule from '../../packages/plugin-subtask/src/index.js';
import * as browserModule from '../../packages/plugin-tool-browser/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';

// ════════════════════════════════════════════════════════════
// 工具能力策略守卫
//
// `resolveCapabilityPolicy` 的兜底是 public——**不声明 = 任何 level-0 用户可驱动**。
// 这个默认已经咬过多次（okx 实盘下单、/clear 清空会话），根因都是"注册时忘了声明"。
//
// 这里不做全量普查（那会把每个新增只读工具都拖进来），只钉住**已知会改变外部状态
// 或跨会话生效**的那批：它们一旦退回 public，就是可被不受信任调用方驱动的真实风险。
//
// 判定读的是**生效策略**（注册时已由 resolveCapabilityPolicy 展开 risk/visibility），
// 不是源码文本——防护机制是异构的（内联声明 / 注册期包装集），只有生效值可信。
// ════════════════════════════════════════════════════════════

interface RegisteredTool {
  name: string;
  visibility?: string;
}

async function registeredTools(modules: Array<[unknown, Record<string, unknown>]>): Promise<RegisteredTool[]> {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(toolsModule as never, {});
  for (const [mod, cfg] of modules) await app.ctx.useModule(mod as never, cfg);
  await app.plugins.idle();
  const svc = app.ctx.getService<{ getAll(): RegisteredTool[] }>('tools');
  const all = svc?.getAll() ?? [];
  await app.stop();
  return all;
}

describe('高危工具不得退回 public', () => {
  it('subtask 的派发/销毁类工具须非 public（每个子任务是一条独立 LLM 链，可被用来放大 API 开销）', async () => {
    const all = await registeredTools([[subtaskModule, {}]]);
    for (const name of ['create_subtask', 'send_to_subtask', 'delete_subtask']) {
      const t = all.find(x => x.name === name);
      expect(t, `${name} 未注册`).toBeDefined();
      expect(t?.visibility, `${name} 退回 public：level-0 用户可连续创建子任务烧 API 预算`).not.toBe('public');
    }
  });

  it('subtask 的只读查询工具保持 public（不该被这条守卫误伤）', async () => {
    const all = await registeredTools([[subtaskModule, {}]]);
    for (const name of ['check_subtask', 'wait_subtasks']) {
      expect(all.find(x => x.name === name)?.visibility ?? 'public').toBe('public');
    }
  });

  it('browser 的写类工具须非 public（页面池进程级共享，取页时不校验会话归属）', async () => {
    const all = await registeredTools([[browserModule, {}]]);
    for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'browser_close_page']) {
      const t = all.find(x => x.name === name);
      expect(t, `${name} 未注册`).toBeDefined();
      expect(t?.visibility, `${name} 退回 public：可操作他人（含 owner）已登录的页面`).not.toBe('public');
    }
  });

  it('browser 的只读读取工具保持 public', async () => {
    const all = await registeredTools([[browserModule, {}]]);
    for (const name of ['browser_get_text', 'browser_get_links']) {
      expect(all.find(x => x.name === name)?.visibility ?? 'public').toBe('public');
    }
  });
});
