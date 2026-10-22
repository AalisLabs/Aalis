import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {} from '../../packages/api-agent/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { HUB_PLUGINS } from '../fixtures/hubs.js';
import { sessionValuesPlugin } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 人设插件的四项按会话设置（人设、额外提示、不用结构化输出、客户端渲染 JSON）：字段写在人设插件的 configSchema 上，人设
// 服务按调用方给的会话（{ sessionId, platform }）经读取器自己解析，不再由调用方传值。客户端渲染 JSON 有三档：按角色卡、开、关。
// 回复的结构化解析（agent:reply:before）同样按这一轮的会话取。会话的设置由会话设置的替身给。
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

/** 带结构化输出的卡，clientSide 为卡上的「客户端渲染 JSON」 */
const formatCard = (name: string, clientSide?: boolean): string =>
  [
    `name: ${name}`,
    'description: d',
    `prompt: ${name} 正文`,
    ...(clientSide === undefined ? [] : [`clientSideJsonRendering: ${clientSide}`]),
    'outputFormat:',
    '  message:',
    '    description: 回复',
    '    reply: true',
    '',
  ].join('\n');

let base: string | undefined;
let app: App | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
  if (base) rmSync(base, { recursive: true, force: true });
  base = undefined;
});

async function boot(sessions: Record<string, Record<string, unknown>>) {
  base = mkdtempSync(join(tmpdir(), 'aalis-persona-fields-'));
  const dir = join(base, 'self', 'personas');
  mkdirSync(join(base, 'workspace'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'default.yaml'), formatCard('主卡'));
  writeFileSync(join(dir, 'client.yaml'), formatCard('客户端卡', true));
  app = new App({ name: 'T', logLevel: 'error' });
  provideHostPaths(app, base);
  await app.pluginAll([
    ...HUB_PLUGINS.map(definition => ({ definition })),
    { definition: sessionValuesPlugin(sessions) },
    { definition: storageLocal, config: { roots: [root('workspace', join(base, 'workspace'))] } },
    { definition: personaPlugin, config: { timeInjection: false } },
  ]);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(personaPlugin.name)?.state).toBe('active');
  await app.start();
  const host = app.bind({ services, hooks });
  const svc = host.services.use.get(persona) as PersonaService;
  /** 跑一次回复的结构化解析，回 agent 拿到的正文 */
  const reply = async (sessionId: string, content: string) => {
    const data = { content, sessionId, platform: 'webui', attempt: 0 };
    await host.hooks.use.run('agent:reply:before', data);
    return data.content;
  };
  return { svc, reply };
}

describe('字段声明', () => {
  it('四项写在人设插件的 configSchema 上，可按会话覆盖', () => {
    const schema = personaPlugin.configSchema as unknown as Record<string, Record<string, unknown>>;
    expect(schema.persona).toMatchObject({
      type: 'select',
      dynamicOptions: 'persona',
      allowCustom: true,
      default: 'default',
      session: { prominence: 'common', order: 10, minLevel: 1 },
    });
    expect(schema.systemPromptExtra).toMatchObject({
      type: 'textarea',
      default: '',
      session: { prominence: 'common', order: 40 },
    });
    expect(schema.disableOutputFormat).toMatchObject({
      type: 'boolean',
      default: false,
      session: { prominence: 'advanced' },
    });
    expect(schema.clientSideJsonRendering).toMatchObject({
      type: 'select',
      default: 'card',
      session: { prominence: 'advanced' },
    });
    expect((schema.clientSideJsonRendering.options as Array<{ value: string }>).map(o => o.value)).toEqual([
      'card',
      'on',
      'off',
    ]);
    for (const key of ['systemPromptExtra', 'disableOutputFormat', 'clientSideJsonRendering']) {
      expect((schema[key].session as { minLevel?: number }).minLevel, `${key} 只有 owner 能改`).toBeUndefined();
    }
  });
});

describe('人设服务按会话解析', () => {
  it('人设、额外提示与不用结构化输出按调用方给的会话取，别的会话照旧', async () => {
    const { svc } = await boot({
      card: { persona: 'client' },
      extra: { systemPromptExtra: '  只用英文回答。  ' },
      plain: { disableOutputFormat: true },
    });
    expect(svc.getPersonaName({ sessionId: 'card' })).toBe('客户端卡');
    expect(svc.getPersonaName({ sessionId: 'other' })).toBe('主卡');
    expect(svc.getSystemPrompt({ sessionId: 'extra' })).toContain('主卡 正文\n\n只用英文回答。');
    expect(svc.getSystemPrompt({ sessionId: 'other' })).not.toContain('只用英文回答');
    expect(svc.getOutputFormat?.({ sessionId: 'plain' })).toBeUndefined();
    expect(svc.getSystemPrompt({ sessionId: 'plain' })).not.toContain('"message"');
    expect(svc.getOutputFormat?.({ sessionId: 'other' })?.replyField).toBe('message');
  });

  it('客户端渲染 JSON 三档：按角色卡、开、关', async () => {
    const { svc, reply } = await boot({
      cardOn: { persona: 'client' },
      cardOff: { persona: 'client', clientSideJsonRendering: 'off' },
      forcedOn: { clientSideJsonRendering: 'on' },
    });
    expect(svc.isClientSideJsonRendering?.({ sessionId: 'cardOn' }), '按角色卡：卡上开').toBe(true);
    expect(svc.isClientSideJsonRendering?.({ sessionId: 'plainCard' }), '按角色卡：卡上没写').toBe(false);
    expect(svc.isClientSideJsonRendering?.({ sessionId: 'cardOff' })).toBe(false);
    expect(svc.isClientSideJsonRendering?.({ sessionId: 'forcedOn' })).toBe(true);

    const json = '{"message":"你好"}';
    expect(await reply('forcedOn', json), '开：整串 JSON 留给客户端').toBe(json);
    expect(await reply('cardOff', json), '关：取出回复字段').toBe('你好');
    expect(await reply('plainCard', json)).toBe('你好');
  });
});
