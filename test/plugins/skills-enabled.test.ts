import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import type {} from '../../packages/api-webui/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import { logger } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import skillsPlugin, { skills } from '../../packages/plugin-skills/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerFromDoc } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { recordRoom } from '../fixtures/rooms.js';
import { ONEBOT_TYPES, startSettings } from '../fixtures/session-settings.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 启用的技能是技能插件自己的按会话字段 enabledSkills：作者默认 ['*']（全部技能），空列表一个都不启用，能按平台档、平台类型档、
// 场所与会话设，只有 owner 能改；不再读人设卡。list_skills、load_skill、技能发现那一行与按触发词自动激活都按调用所在的会话
// 取生效值；会话设置不在时取插件配置里的值。可选项来源 skills 列出 '*'（全部技能）与各技能。
// ════════════════════════════════════════════════════════════

const SKILLS = '@aalis/plugin-skills';
const GROUP = 'onebot:10000:group:20001';
const GROUP_PLACE = 'onebot:group:20001';

const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(enabledSkills?: string[], options: { settings?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'zz-skills-enabled-'));
  dirs.push(base);
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(base, 'skills', name), { recursive: true });
    writeFileSync(
      join(base, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} 技能\ntriggers:\n  - 天气\n---\n正文\n`,
    );
  }
  const doc: Partial<AalisConfig> = {
    plugins: {
      '@aalis/plugin-storage-local': {
        roots: [{ name: 'store', path: base, label: 'store', kind: 'custom', browsable: true, readable: true }],
      },
      [SKILLS]: { skillsUri: 'store:/skills', ...(enabledSkills ? { enabledSkills } : {}) },
    },
  };
  const started = await startSettings({
    doc,
    adapters: [{ platform: 'onebot', sessionTypes: ONEBOT_TYPES }],
    settings: options.settings,
  });
  const { app, store, host } = started;
  apps.push(app);
  provideHostPaths(app, base);
  const handlers = new Map<string, RegisteredTool['handler']>();
  host.provide.use(tools, {
    register(tool: RegisteredTool) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await registerFromDoc(app, store, storageLocal);
  await registerFromDoc(app, store, skillsPlugin);
  await app.plugins.idle();
  const service = host.services.use.get(skills);
  if (!service) throw new Error('plugin-skills 未激活');
  await service.rescan();
  const call = async (name: string, args: Record<string, unknown>, sessionId: string, platform: string) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} 没有登记`);
    return JSON.parse(String(await handler(args, toolContext({ sessionId, platform }))));
  };
  /** 这个会话里 list_skills 列出的技能名 */
  const listed = async (sessionId: string, platform: string) =>
    (await call('list_skills', {}, sessionId, platform)).skills.map((s: { name: string }) => s.name);
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
  return { ...started, call, listed, discovery, say, caps };
}

describe('启用的技能字段', () => {
  it('写在技能插件的 configSchema 上：多选、可自填、可选项来源 skills、作者默认全部、各种会话都适用、只有 owner 能改', () => {
    const field = (skillsPlugin.configSchema as unknown as Record<string, Record<string, unknown>>).enabledSkills;
    expect(field).toMatchObject({
      type: 'multiselect',
      dynamicOptions: 'skills',
      allowCustom: true,
      default: ['*'],
      session: { prominence: 'advanced' },
    });
    const session = field.session as { appliesTo?: unknown; minLevel?: number; unset?: unknown };
    expect([session.appliesTo, session.minLevel, session.unset]).toEqual([undefined, undefined, undefined]);
  });

  it('可选项来源 skills：先是「全部技能」，再是各技能，说明取技能的 description', async () => {
    const { caps } = await setup();
    const source = caps.contributions.use.collect('webui:options').find(({ spec }) => spec.id === 'skills');
    if (!source) throw new Error('没有来源 skills');
    expect(toSource(await source.spec.list())).toEqual([
      { value: '*', label: '全部技能' },
      { value: 'alpha', label: 'alpha', description: 'alpha 技能' },
      { value: 'beta', label: 'beta', description: 'beta 技能' },
    ]);
  });
});

describe('按会话过滤技能', () => {
  it("作者默认 ['*']：全部技能都列出、都能加载", async () => {
    const { sm, listed, call } = await setup();
    const web = await sm.createSession({}, { createdFrom: 'webui' });
    expect(await listed(web.id, 'webui')).toEqual(['alpha', 'beta']);
    expect((await call('load_skill', { name: 'beta' }, web.id, 'webui')).ok).toBe(true);
  });

  it('空列表：一个都不启用，list_skills 为空、load_skill 拒绝，没有技能发现那一行，触发词不激活', async () => {
    const { sm, listed, call, discovery, say } = await setup([]);
    const web = await sm.createSession({}, { createdFrom: 'webui' });
    expect(await listed(web.id, 'webui')).toEqual([]);
    expect((await call('load_skill', { name: 'alpha' }, web.id, 'webui')).error).toBe(
      'skill "alpha" 不在这个会话启用的技能里',
    );
    expect(await discovery(web.id, 'webui')).toBeUndefined();
    expect(await say(web.id, 'webui', '今天天气怎么样')).toEqual([]);
  });

  it('按群设能生效：群的场所只启用 alpha，群里只列 alpha、加载不了 beta、触发词只激活 alpha；别的会话照常全部', async () => {
    const { sm, admin, host, listed, call, discovery, say } = await setup();
    await recordRoom(host.events.use, GROUP, '群');
    await admin.update(
      { layer: { scope: 'place', key: GROUP_PLACE } },
      { plugin: SKILLS, key: 'enabledSkills', value: ['alpha'] },
    );
    const web = await sm.createSession({}, { createdFrom: 'webui' });

    expect(await listed(GROUP, 'onebot')).toEqual(['alpha']);
    expect((await call('load_skill', { name: 'beta' }, GROUP, 'onebot')).error).toBe(
      'skill "beta" 不在这个会话启用的技能里',
    );
    expect(await discovery(GROUP, 'onebot')).toBeDefined();
    expect(await say(GROUP, 'onebot', '今天天气怎么样')).toEqual(['alpha']);
    expect(await listed(web.id, 'webui')).toEqual(['alpha', 'beta']);
  });

  it('会话设置不在时取插件配置里的值', async () => {
    const { listed } = await setup(['beta'], { settings: false });
    expect(await listed('<任意会话>', 'webui')).toEqual(['beta']);
  });
});
