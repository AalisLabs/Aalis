import type { ConfigManager, Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';

// ════════════════════════════════════════════════════════════
// authority — 跨平台身份绑定（纯能力委托模型）
//
// 语义：运行时零合并（被绑身份的 grant 解析到主账户单一真源，deny 取自身∪账户
// 并集防"绑定洗白封禁"）+ 绑定时刻一次性合并（grant/deny 并集写入账户）。
// 平台身份原记录原样留底，解绑即还原。无数字等级。
// ════════════════════════════════════════════════════════════

type StorageParam = ConstructorParameters<typeof AuthorityManager>[2];

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

function makeManager(cfg: Record<string, unknown> = {}, storage: Partial<StorageParam> = {}): AuthorityManager {
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigManager;
  return new AuthorityManager(config, makeLogger(), storage as StorageParam);
}

const QQ = { platform: 'onebot', userId: '12345' };
const WEBUI = (userId: string) => ({ platform: 'webui', userId });
// 被授予后即可过 restricted 能力闸，用 authorize 间接断言"有效 grant"
const can = (m: AuthorityManager, id: typeof QQ, cap: string) =>
  m.authorize(id, { capability: cap, visibility: 'restricted' }) === null;

/** 发码 + 消费的快捷流 */
function bindQQ(m: AuthorityManager, account = 'alice'): void {
  const { code } = m.createBindCode('webui', account);
  m.consumeBindCode(code, QQ);
}

describe('createBindCode', () => {
  it('仅 webui 主账户可发起', () => {
    const m = makeManager();
    expect(() => m.createBindCode('onebot', '12345')).toThrow(/WebUI 主账户/);
    const { code, expiresAt } = m.createBindCode('webui', 'alice');
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('同账户重新生成会作废旧码', () => {
    const m = makeManager();
    const old = m.createBindCode('webui', 'alice').code;
    m.createBindCode('webui', 'alice');
    expect(() => m.consumeBindCode(old, QQ)).toThrow(/无效或已过期/);
  });
});

describe('consumeBindCode', () => {
  it('成功绑定：账户记录 links、被绑身份 linkedTo', () => {
    const m = makeManager();
    m.setUserCapabilities(null, WEBUI('alice'), { grant: ['tool:x'] });
    const { code } = m.createBindCode('webui', 'alice');
    const account = m.consumeBindCode(code, QQ);
    expect(account).toEqual({ platform: 'webui', userId: 'alice' });
    const users = m.listUsers();
    expect(users.find(u => u.userId === 'alice')?.links).toEqual(['onebot:12345']);
    expect(users.find(u => u.userId === '12345')?.linkedTo).toBe('webui:alice');
  });

  it('拒绝 webui / cli 身份；无效码与二次消费抛错；已绑身份再绑抛错', () => {
    const m = makeManager();
    const { code } = m.createBindCode('webui', 'alice');
    expect(() => m.consumeBindCode(code, { platform: 'webui', userId: 'bob' })).toThrow(/外部平台/);
    expect(() => m.consumeBindCode(code, { platform: 'cli', userId: 'console' })).toThrow(/外部平台/);
    expect(() => m.consumeBindCode('WRONGCOD', QQ)).toThrow(/无效或已过期/);
    m.consumeBindCode(code, QQ);
    expect(() => m.consumeBindCode(code, QQ)).toThrow(/无效或已过期/); // 一次性
    const { code: code2 } = m.createBindCode('webui', 'bob');
    expect(() => m.consumeBindCode(code2, QQ)).toThrow(/已绑定到 webui:alice/);
  });
});

describe('绑定时刻一次性合并', () => {
  it('grant/deny 并集写入账户；平台身份原记录留底', () => {
    const m = makeManager();
    m.setUserCapabilities(null, WEBUI('alice'), { grant: ['tool:a'] });
    m.setUserCapabilities(null, QQ, { grant: ['tool:b'], deny: ['tool:evil'] });
    bindQQ(m);
    const alice = m.listUsers().find(u => u.userId === 'alice');
    expect(alice?.grant?.sort()).toEqual(['tool:a', 'tool:b']);
    expect(alice?.deny).toEqual(['tool:evil']);
    // 平台身份原记录留底未动
    expect(m.listUsers().find(u => u.userId === '12345')?.grant).toEqual(['tool:b']);
  });

  it('平台身份无记录时账户不变', () => {
    const m = makeManager();
    m.setUserCapabilities(null, WEBUI('alice'), { grant: ['tool:a'] });
    bindQQ(m);
    expect(m.listUsers().find(u => u.userId === 'alice')?.grant).toEqual(['tool:a']);
  });
});

describe('运行时解析（零合并单一真源）', () => {
  it('被绑身份的 grant 实时跟随账户（改账户立即生效）', () => {
    const m = makeManager();
    bindQQ(m);
    expect(can(m, QQ, 'tool:x')).toBe(false);
    m.setUserCapabilities(null, WEBUI('alice'), { grant: ['tool:x'] });
    expect(can(m, QQ, 'tool:x')).toBe(true); // 立即生效
  });

  it('grant 以账户为唯一真源；自身 deny 绑定后仍生效（防洗白）', () => {
    const m = makeManager();
    m.setUserCapabilities(null, QQ, { deny: ['tool:banned'] });
    bindQQ(m);
    // 绑后给账户 grant —— 被绑身份立即享有
    m.setUserCapabilities(null, WEBUI('alice'), { grant: ['tool:x', 'tool:banned'] });
    expect(can(m, QQ, 'tool:x')).toBe(true);
    // 被绑身份自身的 deny（自身记录仍参与并集）继续拒绝
    expect(can(m, QQ, 'tool:banned')).toBe(false);
  });
});

describe('解绑还原', () => {
  it('解绑后回到平台身份自身记录（留底生效）', () => {
    const m = makeManager();
    m.setUserCapabilities(null, QQ, { grant: ['tool:own'] }); // 平台身份自身留底
    bindQQ(m); // 绑定时账户一次性吸收 tool:own
    m.setUserCapabilities(null, WEBUI('alice'), { grant: ['tool:own', 'tool:acct'] }); // 账户后增 tool:acct（独有）
    expect(can(m, QQ, 'tool:acct')).toBe(true); // 绑定期间随账户可用
    expect(can(m, QQ, 'tool:own')).toBe(true);
    expect(m.unlinkIdentity('onebot', '12345')).toBe(true);
    expect(can(m, QQ, 'tool:own')).toBe(true); // 还原到自身留底
    expect(can(m, QQ, 'tool:acct')).toBe(false); // 账户独有的随解绑消失
    expect(m.listUsers().find(u => u.userId === 'alice')?.links).toBeUndefined();
    expect(m.unlinkIdentity('onebot', '12345')).toBe(false);
  });
});

describe('持久化与级联', () => {
  it('links 经 save/init 往返存活，linkIndex 重建后解析仍生效', async () => {
    let written = '';
    const m = makeManager({}, {
      writeFile: async (_uri: string, payload: string | Uint8Array) => {
        written = payload as string;
      },
    } as Partial<StorageParam>);
    m.setUserCapabilities(null, WEBUI('alice'), { grant: ['tool:acct'] });
    bindQQ(m);
    m.save();
    await new Promise(r => setTimeout(r, 0));
    const m2 = makeManager({}, { readFile: async () => written } as Partial<StorageParam>);
    await m2.init();
    expect(can(m2, QQ, 'tool:acct')).toBe(true); // 绑定 + grant 往返
    expect(m2.listUsers().find(u => u.userId === '12345')?.linkedTo).toBe('webui:alice');
  });

  it('删除账户记录后被绑身份自动还原', () => {
    const m = makeManager();
    m.setUserCapabilities(null, QQ, { grant: ['tool:own'] });
    bindQQ(m);
    m.setUserCapabilities(null, WEBUI('alice'), { grant: ['tool:own', 'tool:acct'] });
    m.removeUser('webui', 'alice');
    expect(can(m, QQ, 'tool:own')).toBe(true); // 回退自身留底
    expect(can(m, QQ, 'tool:acct')).toBe(false);
  });
});
