import { afterEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { commands } from '../../packages/api-commands/src/index.js';
import { type StorageRootInfo, storage } from '../../packages/api-storage/src/index.js';
import { type App, definePlugin, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import { defineConfig } from '../../packages/schema-config/src/index.js';
import { ALL, fieldsPlugin, ONEBOT_TYPES, OTHER_SCHEMA, SCHEMA, startSettings } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// /session、/session.set、/session.reset 由会话设置插件登记。门槛取「项的门槛」与「写在哪一层的门槛」两者中较高的：项的门槛是
// 能力 setting:<实例 id>/<键>，默认来自声明的 minLevel（没写即只有 owner），经权限服务的 authorize 裁决，owner 在「操作门槛」
// 里改过的按改过的；层的门槛固定：本会话不另设，群与私聊的场所 2 级，工作区场所与平台类型档、平台档、全局只有 owner，
// 经 meetsLevel 裁决。所有会话一律判，权限服务不在时一律拒绝。写本会话层的那一段就是管理面的 setAs。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const WINDOW = 'onebot:group:20001';
const PRIVATE = 'onebot:10000:private:30002';
const OWNER = { platform: 'onebot', userId: '30001' };
const L1 = { platform: 'onebot', userId: '30002' };
const L2 = { platform: 'onebot', userId: '30003' };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const DATA_ROOT: StorageRootInfo = {
  name: 'data',
  label: 'data',
  kind: 'data',
  browsable: true,
  readable: true,
  writable: true,
  deletable: true,
};

/** 权限插件的等级表落盘用：读到的一律是「没有这个文件」 */
const storagePlugin = definePlugin({
  name: 'zz-storage',
  provides: [storage],
  uses: { provide },
  apply: ({ provide }) => {
    provide.use(storage, {
      listRoots: () => [DATA_ROOT],
      readFile: async () => {
        throw new Error('不存在');
      },
      writeFile: async () => undefined,
    } as never);
  },
});

/** 外来类型而没有 fromText 的项：指令里写不进去 */
const RAW_SCHEMA = defineConfig({
  raw: {
    type: 'llm-ref',
    label: '<外来>',
    validate: () => undefined,
    session: { appliesTo: ALL, prominence: 'advanced', unset: '<没设>', minLevel: 1 },
  },
});

async function setup({
  doc = {},
  withAuthority = true,
  save,
}: {
  doc?: Parameters<typeof startSettings>[0]['doc'];
  withAuthority?: boolean;
  save?: () => Promise<void>;
} = {}) {
  const agent = fieldsPlugin('zz-agent', SCHEMA);
  const other = fieldsPlugin('zz-other', OTHER_SCHEMA);
  const raw = fieldsPlugin('zz-raw', RAW_SCHEMA);
  const plugins: PluginDefinition[] = [
    gatewayPlugin,
    commandsPlugin,
    ...(withAuthority ? [storagePlugin, authorityPlugin] : []),
  ];
  const started = await startSettings({
    doc: { owners: [OWNER], ...doc },
    adapters: [{ platform: 'onebot', sessionTypes: ONEBOT_TYPES }],
    models: [['zz-llm', 'm1']],
    plugins,
    fields: [agent.definition, other.definition, raw.definition],
    save: save && (async () => save()),
  });
  apps.push(started.app);
  const { app, inbound } = started;
  const host = app.bind({ commands, authority });
  if (withAuthority) {
    host.authority.use.setUserLevel(L1, 1);
    host.authority.use.setUserLevel(L2, 2);
  } else {
    // 指令本身照常执行：这里测的是缺了权限服务时会话设置怎么答
    host.commands.use.setExecutionGuard(async () => null);
  }
  await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001', userId: L1.userId });
  await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', userId: L1.userId });
  /** 以 who 的身份在 sessionId 里执行一条指令，回复取渲染后的文字 */
  const run = async (who: { platform: string; userId: string }, sessionId: string, line: string) => {
    const [name, ...args] = line.split(' ');
    return String(
      await host.commands.use.execute(name, {
        sessionId,
        platform: who.platform,
        userId: who.userId,
        args,
        raw: `/${line}`,
      }),
    );
  };
  const value = (key: string, sessionId = GROUP, reader = agent.reader()) =>
    (reader.get(sessionId, { platform: 'onebot' }) as Record<string, unknown>)[key];
  return { ...started, run, value, agent, other, raw, authority: host.authority.use };
}

describe('本会话层', () => {
  it('1 级成员：在群里与私聊里写本会话的模型、深度思考与人设通过，写工具分组被拒；回执不含「重启不丢」', async () => {
    const { run, value } = await setup();
    for (const session of [GROUP, PRIVATE]) {
      const reply = await run(L1, session, 'session.set llm zz-llm/m1');
      expect(reply).toContain('下一轮起生效');
      expect(reply).not.toContain('重启不丢');
      expect(value('llm', session)).toEqual({ provider: 'zz-llm', model: 'm1' });
      await run(L1, session, 'session.set persona <人设>');
      expect(value('persona', session)).toBe('<人设>');
      await run(L1, session, 'session.set groups system');
      expect(value('groups', session)).toEqual([]);
    }
  });

  it('同名的项要写实例前缀；项写错时回执列出你能改的项', async () => {
    const { run, value, other } = await setup();
    const ambiguous = await run(OWNER, GROUP, 'session.set scope session');
    expect(ambiguous).toContain('zz-agent/scope');
    expect(ambiguous).toContain('zz-other/scope');
    await run(OWNER, GROUP, 'session.set zz-other/scope current');
    expect(value('scope', GROUP, other.reader() as never)).toBe('current');
    const unknown = await run(L1, GROUP, 'session.set <没有> x');
    expect(unknown).toContain('persona');
    expect(unknown).not.toContain('groups');
  });

  it('只能设到场所的项写本会话：回 update 给的原因', async () => {
    const { run, value } = await setup();
    const reply = await run(OWNER, GROUP, 'session.set paperName <白纸>');
    expect(reply).toContain('场所');
    expect(value('paperName')).toBe('');
  });

  it('文字读法：开关、数字、列表、选项值；select 只收选项值、回执写选项标签；外来类型没有 fromText 时写不进去', async () => {
    const { run, value, raw } = await setup();
    await run(OWNER, GROUP, 'session.set plain on');
    expect(value('plain')).toBe(true);
    await run(OWNER, GROUP, 'session.set plain 0');
    expect(value('plain')).toBe(false);
    await run(OWNER, GROUP, 'session.set iterations 12');
    expect(value('iterations')).toBe(12);
    await run(OWNER, GROUP, 'session.set groups system，web、code');
    expect(value('groups')).toEqual(['system', 'web', 'code']);
    const label = await run(OWNER, GROUP, 'session.set mode off');
    expect(label).toContain('关');
    expect(value('mode')).toBe('off');
    const byLabel = await run(OWNER, GROUP, 'session.set mode 开');
    expect(byLabel).toContain('card');
    expect(value('mode')).toBe('off');
    await run(OWNER, GROUP, 'session.set raw x');
    expect(value('raw', GROUP, raw.reader() as never)).toBeUndefined();
  });

  it('setAs 与指令同一份：按给的身份判，1 级身份写工具分组被拒，项不存在时列出这个身份能改的项', async () => {
    const { admin, value } = await setup();
    expect(await admin.setAs(L1, GROUP, 'persona', '<人设>')).toMatchObject({ ok: true });
    expect(value('persona')).toBe('<人设>');
    expect(await admin.setAs(L1, GROUP, 'groups', 'system')).toMatchObject({ ok: false });
    expect(value('groups')).toEqual([]);
    const unknown = await admin.setAs(L1, GROUP, '<没有>', 'x');
    expect(unknown.ok).toBe(false);
    expect(JSON.stringify(unknown.text)).toContain('persona');
  });
});

describe('各层的门槛', () => {
  it('窗口场所：1 级被拒、2 级通过；工作区场所 2 级被拒；平台类型档、平台档与全局只有 owner；--at 不收 type', async () => {
    const { run, admin, doc, sm } = await setup();
    await run(L1, GROUP, 'session.set --at place llm zz-llm/m1');
    const place = () =>
      admin.rows({ layer: { scope: 'place', key: WINDOW } }).find(r => r.key === 'llm' && r.plugin === 'zz-agent');
    expect(place()?.value).toBeUndefined();
    await run(L2, GROUP, 'session.set --at place llm zz-llm/m1');
    expect(place()?.value).toEqual({ provider: 'zz-llm', model: 'm1' });

    const { id: webui } = await sm.createSession({}, { createdFrom: 'webui' });
    await run(L2, webui, 'session.set --at place persona <工作区>');
    expect(
      admin.rows({ layer: { scope: 'place', key: 'workspace:default' } }).find(r => r.key === 'persona')?.value,
    ).toBeUndefined();

    for (const at of ['platformType', 'platform', 'global']) {
      await run(L2, GROUP, `session.set --at ${at} persona <${at}>`);
    }
    expect(doc.get('sessionConfig')).toBeUndefined();
    expect(doc.getPluginConfig('zz-agent').persona).toBeUndefined();
    for (const at of ['platformType', 'platform', 'global']) {
      expect(await run(OWNER, GROUP, `session.set --at ${at} persona <${at}>`)).toContain('下一轮起生效');
    }
    expect(await run(OWNER, GROUP, 'session.set --at type persona <type>')).toContain('只能是');
    expect(doc.get('sessionConfig')).toEqual({
      platforms: { onebot: { 'zz-agent': { persona: '<platform>' } } },
      platformTypes: { onebot: { group: { 'zz-agent': { persona: '<platformType>' } } } },
    });
    expect(doc.getPluginConfig('zz-agent').persona).toBe('<global>');
  });

  it('项的门槛按「操作门槛」里改过的判；层的门槛改不了；setting:* 硬禁连 owner 也拒；只有 owner 时拒绝文字不写 Infinity', async () => {
    const { run, value, doc } = await setup({ doc: { authorityOverrides: { 'setting:zz-agent/groups': 0 } } });
    await run(L1, GROUP, 'session.set groups system');
    expect(value('groups')).toEqual(['system']);
    await run(L1, GROUP, 'session.set --at platformType groups system');
    expect(doc.get('sessionConfig')).toBeUndefined();
    const refused = await run(L1, GROUP, 'session.set iterations 3');
    expect(refused).not.toContain('Infinity');
    expect(refused).toContain('owner');

    doc.set('deniedCapabilities', ['setting:*']);
    await run(OWNER, GROUP, 'session.set persona <人设>');
    expect(value('persona')).toBe('default');
  });

  it('权限服务不在：一律拒绝，回执说要装上权限插件', async () => {
    const { run, value } = await setup({ withAuthority: false });
    const reply = await run(OWNER, GROUP, 'session.set persona <人设>');
    expect(reply).toContain('权限插件');
    expect(value('persona')).toBe('default');
  });
});

describe('会话与层的情形', () => {
  it('会话管理没收录的会话先建档再写本会话层；--at place 回「还没收录」', async () => {
    const { run, sm, value } = await setup();
    await run(OWNER, 'zz-unrecorded', 'session.set persona <人设>');
    expect(sm.getSession('zz-unrecorded')).toBeDefined();
    expect(value('persona', 'zz-unrecorded')).toBe('<人设>');
    expect(await run(OWNER, 'zz-unrecorded', 'session.set --at place persona <人设>')).toContain('还没收录');
  });

  it('WebUI 会话里 --at platformType 回「不属于任何平台类型档」', async () => {
    const { run, sm } = await setup();
    const { id } = await sm.createSession({}, { createdFrom: 'webui' });
    const owner = { platform: 'webui', userId: 'console' };
    expect(await run(owner, id, 'session.set --at platformType persona <人设>')).toContain('不属于任何平台类型档');
  });

  it('/session.reset：给了项清那一项；不给项清掉本会话里你能改的全部项；平台类型档以上不给项被拒', async () => {
    const { run, value, doc } = await setup();
    await run(OWNER, GROUP, 'session.set groups system');
    await run(L1, GROUP, 'session.set persona <人设>');
    await run(L1, GROUP, 'session.reset');
    expect(value('persona')).toBe('default');
    expect(value('groups'), '1 级成员清不掉工具分组').toEqual(['system']);
    await run(OWNER, GROUP, 'session.reset groups');
    expect(value('groups')).toEqual([]);

    await run(OWNER, GROUP, 'session.set --at platformType persona <平台类型档>');
    const refused = await run(OWNER, GROUP, 'session.reset --at platformType');
    expect(refused).toContain('persona');
    expect(doc.get('sessionConfig')?.platformTypes).toEqual({
      onebot: { group: { 'zz-agent': { persona: '<平台类型档>' } } },
    });
    await run(OWNER, GROUP, 'session.reset --at platformType persona');
    expect(doc.get('sessionConfig')).toEqual({});
  });

  it('写宿主文档落盘失败：回执写 saveFailureText 那一句', async () => {
    const { run, doc } = await setup({
      save: async () => {
        throw new Error('<写不进去>');
      },
    });
    const reply = await run(OWNER, GROUP, 'session.set --at global persona <人设>');
    expect(reply).toContain('<写不进去>');
    expect(reply).toContain('已在运行态生效');
    expect(doc.getPluginConfig('zz-agent').persona).toBe('<人设>');
  });
});

describe('/session', () => {
  it('只列你能改的项：1 级成员看到模型、深度思考、人设与语言，看不到工具分组；owner 看到全部', async () => {
    const { run } = await setup();
    const member = await run(L1, GROUP, 'session');
    for (const key of ['llm', 'think', 'persona', 'language']) expect(member).toContain(key);
    for (const key of ['groups', 'iterations', 'paperName']) expect(member).not.toContain(key);
    expect(member).toContain('只列出你能改的项');
    const owner = await run(OWNER, GROUP, 'session');
    for (const key of ['llm', 'groups', 'iterations', 'scope']) expect(owner).toContain(key);
    expect(owner).not.toContain('只列出你能改的项');
  });
});
