import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { flowControl } from '../../packages/api-flow-control/src/index.js';
import { gateway, INBOUND_PHASE } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, LogHub, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { callTool, StepModel, stepModelPlugin } from '../fixtures/step-llm.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 到达序号：网关在所有入站相位之前给每条入站消息打一个这次运行内递增的序号（被指令相位吞掉的同样有），只给日志关联用。
// 规则版的判定行、流控与网关的吞噬行、agent 每条输入的开轮、待插入、插入、排队、放掉行与回合结束行都带 #序号，全部不记正文
// 与昵称。序号接在各行的动作之后（agent 的输入行是「→ 开轮 #序号 session=… turn=…」，回合结束行是「输入 #序号 #序号」）。
// 真的网关、规则版触发、流控与 agent；模型是能阻塞某一次调用的替身；日志从 LogHub 收。
// ════════════════════════════════════════════════════════════

const SELF = '10000';
const ROOM = `onebot:${SELF}:group:20001`;
const AT = `<at self id="${SELF}">Aalis</at> `;
const NICKNAME = '<昵称甲>';
const PROBE = 'zz_arrival_probe';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const groupMsg = (content: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  content,
  platform: 'onebot',
  sessionType: 'group',
  sessionId: ROOM,
  groupId: '20001',
  userId: '30001',
  nickname: NICKNAME,
  ...extra,
});

async function boot(
  decide: (request: ChatModelRequest, n: number) => ChatResponse = (_r, n) => ({ content: `回${n}` }),
) {
  const logs: string[] = [];
  const logHub = new LogHub();
  logHub.onEntry(entry => void logs.push(`[${entry.scope}] ${entry.message}`));
  const { app } = hostedApp({ logLevel: 'debug' }, { logHub });
  apps.push(app);
  await registerHubs(app);
  app.bind({ provide }).provide.use(storage, memoryStorage(new Map()));
  const model = new StepModel(decide);
  await app.plugin(stepModelPlugin(model));
  for (const plugin of [toolsPlugin, memoryInMemoryPlugin, gatewayPlugin, flowControlPlugin, triggerPolicyPlugin]) {
    await app.plugin(plugin, {});
  }
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  for (const plugin of [gatewayPlugin, flowControlPlugin, triggerPolicyPlugin, agentPlugin]) {
    expect(app.plugins.getPlugin(plugin.name)?.state, plugin.name).toBe('active');
  }
  const host = app.bind({ gateway, hooks, agent, flowControl, tools });
  /** 指令相位第一个看到的：每条入站的正文与到达序号；正文是 /zz 的在这里吞掉 */
  const arrivals = new Map<string, number | undefined>();
  host.hooks.use.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
    arrivals.set(data.message.content, data.message.arrival);
    if (data.message.content === '/zz') return;
    await next();
  });
  return { logs, model, host, arrivals };
}

describe('到达序号', () => {
  it('网关在所有相位之前打号；判定行、吞噬行、agent 的开轮、待插入、插入、排队、放掉行与回合结束行带 #序号，不含正文与昵称', async () => {
    const s = await boot((_r, n) => (n === 1 ? callTool(PROBE) : { content: `回${n}` }));
    const entered = deferred();
    const release = deferred();
    s.host.tools.use.register({
      definition: {
        type: 'function',
        function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => {
        entered.resolve();
        await release.promise;
        return 'ok';
      },
    });
    const ingress = (message: IncomingMessage) => s.host.gateway.use.ingressMessage(message);
    const opened = ingress(groupMsg(`${AT}<开轮>`));
    await entered.promise;
    // 工具里时到的：点名的真人消息待插入、之后插进这一轮，带来源的注入排在这一轮之后
    const later = [
      ingress(groupMsg(`${AT}<插入>`)),
      ingress({ content: '<注入>', platform: 'onebot', sessionId: ROOM, source: 'zz-notice' }),
    ];
    await vi.waitFor(() => expect(s.arrivals.size).toBe(3));
    await new Promise(resolve => setImmediate(resolve));
    release.resolve();
    await Promise.all([opened, ...later]);
    await ingress(groupMsg('/zz'));
    await ingress(groupMsg('<没点名>'));
    s.host.flowControl.use.setMuted(ROOM, 60, 'onebot');
    await ingress(groupMsg(`${AT}<禁言期>`));

    const n = (content: string) => s.arrivals.get(content);
    const numbers = [`${AT}<开轮>`, `${AT}<插入>`, '<注入>', '/zz', '<没点名>', `${AT}<禁言期>`].map(n);
    expect(numbers.every(value => typeof value === 'number')).toBe(true);
    expect(numbers, '按到达先后递增').toEqual([...numbers].sort((a, b) => (a as number) - (b as number)));
    const [open, inserted, injected, command, quiet, muted] = numbers;
    const has = (pattern: RegExp) => s.logs.some(line => pattern.test(line));

    expect(has(new RegExp(`\\[trigger\\] 判定 #${open} `))).toBe(true);
    expect(has(new RegExp(`\\[trigger\\] 判定 #${quiet} `))).toBe(true);
    expect(has(new RegExp(`消息被 swallow #${command}，`)), '被指令相位吞掉的同样有序号').toBe(true);
    expect(has(new RegExp(`\\[flow\\] 禁言中 → 吞噬 #${muted} `))).toBe(true);
    expect(has(new RegExp(`→ 开轮 #${open} session=${ROOM} turn=`))).toBe(true);
    expect(has(new RegExp(`→ 待插入 #${inserted} session=${ROOM}$`))).toBe(true);
    expect(has(new RegExp(`→ 插入 #${inserted} session=${ROOM} turn=`))).toBe(true);
    expect(has(new RegExp(`→ 排队 #${inserted} `)), '插进去的不记成排队').toBe(false);
    expect(has(new RegExp(`→ 排队 #${injected} session=${ROOM}$`))).toBe(true);
    expect(has(new RegExp(`→ 开轮 #${injected} session=${ROOM} turn=`))).toBe(true);
    expect(
      has(new RegExp(`回合结束 turn=\\S+ session=${ROOM} 结局=replied 用时=\\d+ms 输入 #${open} #${inserted}$`)),
    ).toBe(true);

    const numbered = s.logs.filter(line => /#\d+/.test(line));
    for (const secret of ['<开轮>', '<插入>', '<注入>', '<没点名>', '<禁言期>', NICKNAME]) {
      expect(
        numbered.filter(line => line.includes(secret)),
        `带序号的行不含 ${secret}`,
      ).toEqual([]);
    }
  });

  it('agent 的放掉行带序号：连同排队项的停止放掉的输入写「放掉」', async () => {
    const s = await boot();
    const held = s.model.hold(1);
    const opened = s.host.gateway.use.ingressMessage(groupMsg(`${AT}<开轮>`));
    await held.entered;
    const dropped = s.host.gateway.use.ingressMessage(groupMsg(`${AT}<放掉>`));
    await vi.waitFor(() => expect(s.arrivals.size).toBe(2));
    await new Promise(resolve => setImmediate(resolve));
    s.host.agent.use.abort(ROOM, { queued: true, reason: '<原因>' });
    await Promise.all([opened, dropped]);
    const drop = s.arrivals.get(`${AT}<放掉>`);
    expect(s.logs.some(line => line.includes(`→ 放掉 #${drop} session=${ROOM}`))).toBe(true);
    expect(s.logs.some(line => /回合结束 .*结局=aborted 原因=<原因> /.test(line))).toBe(true);
  });
});
