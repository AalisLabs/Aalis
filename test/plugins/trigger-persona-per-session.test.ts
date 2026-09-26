import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { type SessionManagerService, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { HUB_PLUGINS } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 名字表按会话取人设：会话配置（session-manager 的 resolveConfig）里的 persona 指定角色卡时，点名识别用那张卡的
// 名字与昵称，别的会话照旧用主卡，两边不串。真 storage-local + 真 persona（两张卡）+ 真 trigger-policy；
// session-manager 用替身（按会话给 persona）。Laya 发给侧车的 selfNames 按会话取见 trigger-laya.test.ts。
// ════════════════════════════════════════════════════════════

const root = (name: string, path: string) => ({
  name,
  path,
  label: name,
  kind: name,
  browsable: true,
  readable: true,
  writable: true,
  deletable: true,
});

/** 会话甲改用卡 bob，会话乙沿用主卡 */
const SESSION_BOB = 'onebot:10000:group:20001';
const SESSION_MAIN = 'onebot:10000:group:20002';

const groupMsg = (sessionId: string, content: string): IncomingMessage => ({
  content,
  platform: 'onebot',
  sessionType: 'group',
  sessionId,
  groupId: sessionId.split(':')[3],
  userId: '30001',
});

async function runTriggerPhase(chain: Hooks, message: IncomingMessage) {
  let reached = false;
  await chain.run('inbound:trigger', { message, metadata: {}, agent: undefined }, async () => {
    reached = true;
  });
  return { reached, triggerType: message.triggerType };
}

let base: string | undefined;
let app: App | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
  if (base) rmSync(base, { recursive: true, force: true });
  base = undefined;
});

async function boot() {
  base = mkdtempSync(join(tmpdir(), 'aalis-trigger-persona-session-'));
  const personasDir = join(base, 'data', 'personas');
  mkdirSync(join(base, 'workspace'), { recursive: true });
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(join(personasDir, 'main.yaml'), 'name: 主卡名\nnick_name: [主卡昵称]\ndescription: d\nprompt: p\n');
  writeFileSync(join(personasDir, 'bob.yaml'), 'name: 副卡名\nnick_name: [副卡昵称]\ndescription: d\nprompt: p\n');

  app = new App({ name: 'T', logLevel: 'error' });
  await app.pluginAll([
    ...HUB_PLUGINS.map(definition => ({ definition })),
    {
      definition: storageLocal,
      config: { roots: [root('workspace', join(base, 'workspace')), root('data', join(base, 'data'))] },
    },
    {
      definition: personaPlugin,
      config: { persona: 'main', personasDir: 'data/personas', timeInjection: false },
    },
  ]);
  await app.plugins.idle();
  const host = app.bind({ provide, hooks, services });
  host.provide(gateway, {} as never); // 满足 trigger-policy 的 required 依赖；相位判定本身不经过 gateway
  const resolved: Array<[sessionId: string, platform: string | undefined]> = [];
  host.provide(sessionManager, {
    resolveConfig(sessionId: string, platform?: string) {
      resolved.push([sessionId, platform]);
      return sessionId === SESSION_BOB ? { persona: 'bob' } : {};
    },
  } as unknown as SessionManagerService);
  // 计数到不了阈值：没点名的消息一律吞掉，点名的记 immediate 放行
  await app.plugins.register(triggerPolicyPlugin, { intervalMode: 'fixed', fixedInterval: 100 });
  await app.plugins.idle();
  await app.start();
  for (const def of [personaPlugin, triggerPolicyPlugin]) {
    const state = app.plugins.getPlugin(def.name)?.state;
    if (state !== 'active') throw new Error(`${def.name} 未激活（state=${state}）`);
  }
  const svc = host.services.get(persona) as PersonaService;
  // 前提：两张卡都已载入，否则下面测的是回落主卡（用提示词核：它早就按会话取卡）
  if (!svc.getSystemPrompt({ persona: 'bob' }).includes('副卡名')) throw new Error('卡 bob 未载入');
  return { host, resolved };
}

describe('名字表按会话取人设（trigger-policy + 真 persona）', () => {
  it('会话改用别的卡：那张卡的名字、昵称算点名，主卡的不算；别的会话照旧用主卡，两边不串', async () => {
    const { host, resolved } = await boot();
    const send = (sid: string, content: string) => runTriggerPhase(host.hooks, groupMsg(sid, content));

    expect(await send(SESSION_BOB, '副卡名 在吗')).toEqual({ reached: true, triggerType: 'immediate' });
    expect(await send(SESSION_BOB, '副卡昵称 在吗')).toEqual({ reached: true, triggerType: 'immediate' });
    expect((await send(SESSION_BOB, '主卡名 在吗')).reached, '改用副卡的会话里叫主卡名不算点名').toBe(false);

    expect(await send(SESSION_MAIN, '主卡名 在吗')).toEqual({ reached: true, triggerType: 'immediate' });
    expect(await send(SESSION_MAIN, '主卡昵称 在吗')).toEqual({ reached: true, triggerType: 'immediate' });
    expect((await send(SESSION_MAIN, '副卡名 在吗')).reached, '用主卡的会话里叫副卡名不算点名').toBe(false);

    expect(resolved, '与 agent 同一取法：按会话 ID 与平台解析').toContainEqual([SESSION_BOB, 'onebot']);
    expect(resolved).toContainEqual([SESSION_MAIN, 'onebot']);
  });
});
