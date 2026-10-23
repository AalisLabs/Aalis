import { afterEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { type StorageRootInfo, storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { recordRoom } from '../fixtures/rooms.js';
import { fieldsPlugin, SCHEMA, startSettings } from '../fixtures/session-settings.js';
import { startSubtaskHub } from '../fixtures/subtask.js';
import { type RequestDraft, toolRequest } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// set_subtask_setting：父会话改直接子会话（不含孙会话）本会话层的一项，写法与门槛同在那个子会话里用 /session.set（会话设置
// 管理面的 setAs，同一份实现），身份按这一轮发起的人（actor，没有时取物理身份）。声明 sensitive 加 'session' 确认：模型给
// 自己派的子会话放权等于自授，要 owner 批准；owner 配了免确认时以 owner 身份做的不弹，群友发起的回合发不起审批。回执取原文
// 作工具结果，写完子会话下一轮起生效。
// ════════════════════════════════════════════════════════════

const OWNER = { platform: 'onebot', userId: '99999' };
const L1 = { platform: 'onebot', userId: '30002' };
const ROOM = 'onebot:10000:group:20001';
const MINE = 'session-mine';

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

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('set_subtask_setting 的处理器', () => {
  async function setup({ withAuthority = true, withoutSettings = false } = {}) {
    const hub = await startSubtaskHub({
      doc: { owners: [OWNER] },
      plugins: withAuthority ? [storagePlugin, authorityPlugin] : [],
      withoutSettings,
    });
    apps.push(hub.app);
    if (withAuthority) hub.app.bind({ authority }).authority.use.setUserLevel(L1, 1);
    await recordRoom(hub.host.events.use, ROOM, '群');
    const child = withoutSettings
      ? await hub.sm.createChildSession(ROOM, { name: '<子任务>' })
      : await hub.sm.getSession((await hub.call('create_subtask', { task: '<任务>' }, { sessionId: ROOM })).subtaskId)!;
    const set = (args: Record<string, unknown>, actor = OWNER) =>
      hub.raw('set_subtask_setting', args, {
        sessionId: ROOM,
        platform: 'onebot',
        userId: actor.userId,
        participants: [actor],
      });
    return { hub, child, set };
  }

  it('登记在子任务组，声明 sensitive 加 session 确认', async () => {
    const { hub } = await setup();
    expect(hub.registered.get('set_subtask_setting')).toMatchObject({
      groups: ['subtask'],
      risk: 'sensitive',
      confirm: 'session',
    });
  });

  it('按发起的人判项的门槛：owner 能写工具分组，1 级的人被拒、值不变；回执是原文，下一轮读到写下的值', async () => {
    const { hub, child, set } = await setup();
    const denied = await set({ subtask_id: child.id, key: 'groups', value: 'system' }, L1);
    expect(denied).not.toContain('已改');
    expect(hub.agentFields.reader().get(child.id).groups).toEqual([]);

    const done = await set({ subtask_id: child.id, key: 'groups', value: 'system, web' });
    expect(done).toContain('已改');
    expect(() => JSON.parse(done)).toThrow();
    expect(hub.agentFields.reader().get(child.id).groups).toEqual(['system', 'web']);

    expect(await set({ subtask_id: child.id, key: 'persona', value: '<人设>' }, L1)).toContain('已改');
    expect(hub.agentFields.reader().get(child.id).persona).toBe('<人设>');
  });

  it('没有 actor 时按物理身份判', async () => {
    const { hub, child } = await setup();
    const out = await hub.raw(
      'set_subtask_setting',
      { subtask_id: child.id, key: 'groups', value: 'system' },
      { sessionId: ROOM, platform: L1.platform, userId: L1.userId },
    );
    expect(out).not.toContain('已改');
    expect(hub.agentFields.reader().get(child.id).groups).toEqual([]);
  });

  it('项写错时回执列出这个人在子会话里能改的项', async () => {
    const { child, set } = await setup();
    const out = await set({ subtask_id: child.id, key: '<没有这一项>', value: 'x' }, L1);
    expect(out).toContain('persona');
    expect(out).not.toContain('groups');
  });

  it('只放行直接子会话：孙会话、别的会话的子会话与根会话按不存在回，不写', async () => {
    const { hub, child, set } = await setup();
    const grandchild = await hub.sm.createChildSession(child.id, { name: '<孙会话>' });
    const other = await hub.sm.createSession({ name: '<别的会话>' });
    const othersChild = await hub.sm.createChildSession(other.id, { name: '<别的子会话>' });
    for (const id of [grandchild.id, othersChild.id, ROOM, '<不存在>']) {
      expect(await set({ subtask_id: id, key: 'persona', value: '<人设>' }), id).toContain('子任务不存在');
    }
    expect(hub.agentFields.reader().get(grandchild.id).persona).toBe('default');
  });

  it('权限服务不在：拒绝', async () => {
    const { hub, child, set } = await setup({ withAuthority: false });
    expect(await set({ subtask_id: child.id, key: 'persona', value: '<人设>' })).toContain('要装上权限插件');
    expect(hub.agentFields.reader().get(child.id).persona).toBe('default');
  });

  it('会话设置不在：回错误', async () => {
    const { child, set } = await setup({ withoutSettings: true });
    expect(await set({ subtask_id: child.id, key: 'persona', value: '<人设>' })).toContain('会话设置');
  });
});

describe('set_subtask_setting 经工具注册表与权限守卫', () => {
  /** 真的工具注册表与权限插件；没有审批服务，要确认的调用一律拒 */
  async function setup(doc: Record<string, unknown> = {}) {
    const agentFields = fieldsPlugin('zz-agent', SCHEMA);
    const started = await startSettings({
      doc: { owners: [OWNER], ...doc },
      plugins: [toolsPlugin, storagePlugin, authorityPlugin, subtask],
      fields: [agentFields.definition],
    });
    apps.push(started.app);
    const host = started.app.bind({ tools, authority });
    host.authority.use.setUserLevel(L1, 1);
    await recordRoom(started.host.events.use, ROOM, '群');
    await started.sm.ensureSession(MINE, { name: '<我的>' }, { createdFrom: 'webui' });
    const mineChild = await started.sm.createChildSession(MINE, { name: '<子任务>' });
    const roomChild = await started.sm.createChildSession(ROOM, { name: '<子任务>' });
    const run = async (ctx: RequestDraft, child: string) =>
      (
        await host.tools.use.execute(
          'set_subtask_setting',
          { subtask_id: child, key: 'persona', value: '<人设>' },
          toolRequest({ enabledGroups: ['subtask'], ...ctx }),
        )
      ).content;
    const persona = (child: string) => agentFields.reader().get(child).persona;
    return { mineChild, roomChild, run, persona };
  }

  const OFF = { confirmOverrides: { 'tool:set_subtask_setting': 'off' } };

  it('owner 在自己会话里发起：要审批（这里没有审批服务，被拒、不写）', async () => {
    const { mineChild, run, persona } = await setup();
    const out = await run({ sessionId: MINE, platform: 'onebot', userId: OWNER.userId, inbound: {} }, mineChild.id);
    expect(out).toContain('需要批准');
    expect(persona(mineChild.id)).toBe('default');
  });

  it('owner 配了免确认：owner 发起的照常写，不弹', async () => {
    const { mineChild, run, persona } = await setup(OFF);
    const out = await run({ sessionId: MINE, platform: 'onebot', userId: OWNER.userId, inbound: {} }, mineChild.id);
    expect(out).toContain('已改');
    expect(persona(mineChild.id)).toBe('<人设>');
  });

  it('群友发起的回合：配了免确认也被拒（免确认只对 owner）', async () => {
    const { roomChild, run, persona } = await setup(OFF);
    const out = await run({ sessionId: ROOM, ...L1, inbound: {} }, roomChild.id);
    expect(out).not.toContain('已改');
    expect(persona(roomChild.id)).toBe('default');
  });

  it('没点名的插话回合（没有授权身份）被等级挡下', async () => {
    const { roomChild, run, persona } = await setup(OFF);
    const out = await run({ sessionId: ROOM, platform: 'onebot', inbound: {} }, roomChild.id);
    expect(out).toContain('权限不足');
    expect(persona(roomChild.id)).toBe('default');
  });
});
