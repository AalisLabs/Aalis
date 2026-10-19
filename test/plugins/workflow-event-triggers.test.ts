import { describe, expect, it } from 'vitest';
import type { WorkflowDef } from '../../packages/api-workflow/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { TriggerManager } from '../../packages/plugin-workflow/src/triggers.js';
import { ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// event 触发器不订阅不可作触发源的事件：注册时记一条 warn，不碰事件总线；别的事件照常订阅。哪些事件不可作触发源由
// test/architecture/event-trigger-sources.test.ts 守。直接驱动 TriggerManager，事件总线只记下订阅了什么。
// ════════════════════════════════════════════════════════════

function manager() {
  const subscribed: string[] = [];
  const warnings: string[] = [];
  const logger = { warn: (msg: string) => warnings.push(msg) } as unknown as Logger;
  const events = {
    on: (event: string) => {
      subscribed.push(event);
      return () => {};
    },
  };
  const triggers = new TriggerManager({ cronEngine: ref(), events: events as never, logger }, () => {}, {
    onceLedgerReadable: () => true,
    onceFiredAt: () => undefined,
    markOnceFired() {},
  });
  return { triggers, subscribed, warnings };
}

const onEvent = (event: string): WorkflowDef => ({
  id: 'zz-wf',
  trigger: { type: 'event', event },
  nodes: [{ id: 'a', type: 'tool', tool: 'zz_count' }],
});

describe('event 触发器订阅的事件', () => {
  it('不可作触发源的事件：不订阅，记 warn', () => {
    const { triggers, subscribed, warnings } = manager();
    triggers.register(onEvent('inbound:message'));
    expect(subscribed).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('别的事件照常订阅', () => {
    const { triggers, subscribed, warnings } = manager();
    triggers.register(onEvent('scheduler:job:done'));
    expect(subscribed).toEqual(['scheduler:job:done']);
    expect(warnings).toEqual([]);
  });
});
