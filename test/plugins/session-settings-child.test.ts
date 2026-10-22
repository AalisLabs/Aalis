import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../packages/core/src/index.js';
import { defineConfig } from '../../packages/schema-config/src/index.js';
import { registerFromDoc } from '../fixtures/app.js';
import { ALL, fieldsPlugin, ONEBOT_TYPES, SCHEMA, startSettings, traceOf } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 子会话建立时写下父会话此刻的生效值（childMetadata 并进建会话的 metadata）：适用于子会话、不是只能设到场所的每一项，按子会话
// 的种类解析，严格字段的坏值照原样写；没有值的取声明它的插件交的 actual；父会话自己那一层里没登记实例的条目原样带上。之后
// 父会话与上面各层再改都不影响这些项；之后才登记的字段按上面各层取。孙会话从它的父会话写。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const at = { platform: 'onebot' };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 只适用于子会话以外的项、带 actual 的模型 */
const AGENT = fieldsPlugin('zz-agent', SCHEMA, {
  llm: sessionId => ({ value: { provider: 'zz-llm', model: `actual-of-${sessionId}` }, label: '<模型名>' }),
});
const TOOLS_SCHEMA = defineConfig({
  groups: {
    type: 'multiselect',
    label: '工具分组',
    allowCustom: true,
    default: [],
    session: { appliesTo: ALL, prominence: 'common' },
  },
});

async function setup(options: Parameters<typeof startSettings>[0] = {}) {
  const started = await startSettings({ adapters: [{ platform: 'onebot', sessionTypes: ONEBOT_TYPES }], ...options });
  apps.push(started.app);
  await started.inbound({
    sessionId: GROUP,
    platform: 'onebot',
    sessionType: 'group',
    groupId: '20001',
    userId: '30002',
  });
  const { sm, admin } = started;
  const child = (parentId = GROUP) => sm.createSession({ parentId, metadata: admin.childMetadata(parentId, at) });
  return { ...started, child };
}

describe('建立时写下', () => {
  it('子会话自己那一层有父会话此刻每一项适用于子会话的生效值，来源本会话；只靠服务偏好取模型时写下 actual 给的具体模型', async () => {
    const { admin, child } = await setup({
      doc: {
        plugins: { 'zz-agent': { persona: '<全局人设>' } },
        sessionConfig: { platforms: { onebot: { 'zz-agent': { iterations: 12 } } } },
      },
      fields: [AGENT.definition],
    });
    await admin.update({ sessionId: GROUP }, { plugin: 'zz-agent', key: 'groups', value: ['<收窄>'] });
    const sub = await child();
    const { values, sources } = traceOf(admin, 'zz-agent', sub.id, at);
    expect(values).toMatchObject({
      llm: { provider: 'zz-llm', model: `actual-of-${GROUP}` },
      persona: '<全局人设>',
      groups: ['<收窄>'],
      iterations: 12,
      mode: 'card',
      scope: 'all',
    });
    for (const key of ['llm', 'persona', 'groups', 'iterations', 'mode', 'plain', 'scope'] as const) {
      expect(sources[key], key).toBe('session');
    }
    // 深度思考没设、不交 actual：不写，跟着子会话的模型走；只给房间的与只能设到场所的不写
    const written = (sub.metadata?.['session-settings'] as { values: Array<{ key: string }> }).values.map(e => e.key);
    expect(written).not.toContain('think');
    expect(written).not.toContain('language');
    expect(written).not.toContain('paperName');
  });

  it('严格字段的坏值照原样写', async () => {
    const { sm, child } = await setup({ fields: [AGENT.definition] });
    await sm.updateSession(GROUP, {
      metadata: { 'session-settings': { values: [{ plugin: 'zz-agent', key: 'scope', value: '<坏值>' }] } },
    });
    const sub = await child();
    expect(AGENT.reader().get(sub.id, at).scope).toBe('<坏值>');
  });

  it('之后父会话本会话层、场所、平台档、全局改了，子会话这些项不变；之后才登记的字段按上面各层取；孙会话从子会话写', async () => {
    const later = fieldsPlugin('zz-later', TOOLS_SCHEMA);
    const { app, store, admin, child } = await setup({
      doc: { sessionConfig: { platforms: { onebot: { 'zz-later': { groups: ['<平台档>'] } } } } },
      fields: [AGENT.definition],
    });
    await admin.update({ sessionId: GROUP }, { plugin: 'zz-agent', key: 'persona', value: '<父会话>' });
    const sub = await child();
    await admin.update({ sessionId: GROUP }, { plugin: 'zz-agent', key: 'persona', value: '<父会话改了>' });
    await admin.update(
      { layer: { scope: 'place', key: 'onebot:group:20001' } },
      {
        plugin: 'zz-agent',
        key: 'iterations',
        value: 2,
      },
    );
    await admin.update(
      { layer: { scope: 'platform', platform: 'onebot' } },
      { plugin: 'zz-agent', key: 'mode', value: 'off' },
    );
    await admin.update({ layer: { scope: 'global' } }, { plugin: 'zz-agent', key: 'plain', value: true });
    expect(AGENT.reader().get(sub.id, at)).toMatchObject({
      persona: '<父会话>',
      iterations: 30,
      mode: 'card',
      plain: false,
    });

    await registerFromDoc(app, store, later.definition);
    await app.plugins.idle();
    expect(traceOf(admin, 'zz-later', sub.id, at)).toMatchObject({
      values: { groups: ['<平台档>'] },
      sources: { groups: 'platform' },
    });

    await admin.update({ sessionId: sub.id }, { plugin: 'zz-agent', key: 'persona', value: '<子会话>' });
    const grandchild = await child(sub.id);
    expect(traceOf(admin, 'zz-agent', grandchild.id, at)).toMatchObject({
      values: { persona: '<子会话>' },
      sources: { persona: 'session' },
    });
  });
});

describe('没登记的实例', () => {
  it('父会话本会话层里没登记实例的条目原样带上：工具插件重载中建的子会话，解析得与父会话此刻相同', async () => {
    const tools = fieldsPlugin('zz-tools', TOOLS_SCHEMA);
    const { app, admin, child } = await setup({
      doc: { sessionConfig: { platforms: { onebot: { 'zz-tools': { groups: ['*'] } } } } },
      fields: [AGENT.definition, tools.definition],
    });
    // 平台档放宽、父会话自己那一层收窄
    await admin.update({ sessionId: GROUP }, { plugin: 'zz-tools', key: 'groups', value: [] });
    expect(tools.reader().get(GROUP, at).groups).toEqual([]);
    await app.plugins.disable('zz-tools');
    const sub = await child();
    await app.plugins.enable('zz-tools');
    expect(traceOf(admin, 'zz-tools', sub.id, at)).toMatchObject({
      values: { groups: [] },
      sources: { groups: 'session' },
    });
  });
});
