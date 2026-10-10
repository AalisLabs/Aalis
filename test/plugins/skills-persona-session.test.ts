import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import { logger } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import skillsPlugin, { skills } from '../../packages/plugin-skills/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { PERSONA, startSessionManager } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 角色卡的技能白名单按会话取：人设取会话生效设置里的（会话管理按层解析），再取那张卡的白名单。list_skills、load_skill、
// 技能发现那一行与按触发词自动激活都按调用所在的会话；没有会话管理时取主卡。
// ════════════════════════════════════════════════════════════

/** 替身人设服务：主卡不声明白名单（全开），<受限卡> 只允许 alpha，<无技能卡> 一个都不允许 */
const WHITELISTS: Record<string, string[]> = { '<受限卡>': ['alpha'], '<无技能卡>': [] };
const personaService = {
  getSystemPrompt: () => '',
  getPersonaName: () => '<主卡>',
  getPersonaSkills: options => (options?.persona ? WHITELISTS[options.persona] : undefined),
} satisfies PersonaService;

let base: string;
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  rmSync(base, { recursive: true, force: true });
});

async function setup() {
  base = mkdtempSync(join(tmpdir(), 'zz-skills-persona-'));
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(base, 'skills', name), { recursive: true });
    writeFileSync(
      join(base, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} 技能\ntriggers:\n  - 天气\n---\n正文\n`,
    );
  }
  const { app, host, sm } = await startSessionManager({
    layers: { defaults: { persona: '<受限卡>' }, platforms: { cli: { persona: '<无技能卡>' } } },
    settings: [PERSONA],
  });
  apps.push(app);
  provideHostPaths(app, base);
  host.provide.use(persona, personaService);
  const handlers = new Map<string, RegisteredTool['handler']>();
  host.provide.use(tools, {
    register(tool: RegisteredTool) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugin(storageLocal, {
    roots: [{ name: 'store', path: base, label: 'store', kind: 'custom', browsable: true, readable: true }],
  });
  await app.plugin(skillsPlugin, { skillsUri: 'store:/skills' });
  await app.plugins.idle();
  const service = host.services.use.get(skills);
  if (!service) throw new Error('plugin-skills 未激活');
  await service.rescan();
  const call = async (name: string, args: Record<string, unknown>, sessionId: string, platform: string) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} 没有登记`);
    return JSON.parse(String(await handler(args, { sessionId, platform })));
  };
  const caps = app.bind({ contributions, logger, hooks });
  /** 这个会话这一轮组装出的技能发现那一行 */
  const discovery = async (sessionId: string, platform: string) => {
    const messages: Message[] = [
      { role: 'system', content: '<人设>' },
      { role: 'user', content: '<提问>' },
    ];
    await assemblePromptContributions(caps, { messages, sessionId, platform });
    return messages.find(m => String(m.metadata?.injector ?? '').endsWith('/skills-discovery'));
  };
  /** 这个会话收到一条消息：触发词命中的技能自动激活，返回这个会话已激活的技能 */
  const say = async (sessionId: string, platform: string, content: string) => {
    await caps.hooks.use.run('agent:input:before', {
      message: { sessionId, platform, content },
      metadata: {},
    } as never);
    return service.getLoadedSkills(sessionId);
  };
  return { sm, call, discovery, say };
}

describe('plugin-skills: 角色卡的技能白名单按会话取', () => {
  it('全局默认层的人设是带白名单的卡：这个会话里 list_skills 只列白名单里的，load_skill 拒绝白名单之外的', async () => {
    const { sm, call } = await setup();
    const session = await sm.createSession({}, { createdFrom: 'webui' });

    const listed = await call('list_skills', {}, session.id, 'webui');
    expect(listed.skills.map((s: { name: string }) => s.name)).toEqual(['alpha']);
    expect((await call('load_skill', { name: 'beta' }, session.id, 'webui')).error).toContain('白名单');
    expect((await call('load_skill', { name: 'alpha' }, session.id, 'webui')).ok).toBe(true);
  });

  it('技能发现那一行与触发词自动激活按会话：会话的人设一个技能都不允许时都没有，别的会话照常', async () => {
    const { sm, discovery, say } = await setup();
    const terminal = await sm.createSession({}, { createdFrom: 'cli' });
    const web = await sm.createSession({}, { createdFrom: 'webui' });

    expect(await discovery(terminal.id, 'cli')).toBeUndefined();
    expect(await discovery(web.id, 'webui')).toBeDefined();
    expect(await say(terminal.id, 'cli', '今天天气怎么样')).toEqual([]);
    expect(await say(web.id, 'webui', '今天天气怎么样')).toEqual(['alpha']);
  });
});
