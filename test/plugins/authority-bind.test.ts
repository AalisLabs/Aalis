import type { ConfigManager, Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/index.js';

// ════════════════════════════════════════════════════════════
// authority — 跨平台身份绑定（2026-06-13 调研决议）
//
// 语义：运行时零合并（被绑身份解析到主账户单一真源，denies 取自身∪账户
// 并集防洗白）+ 绑定时刻一次性合并（等级 max、grants/denies 并集写入账户）。
// 平台身份原记录原样留底，解绑即还原。
// ════════════════════════════════════════════════════════════

type StorageParam = ConstructorParameters<typeof AuthorityManager>[2];

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

function makeManager(cfg: Record<string, unknown> = {}, storage: Partial<StorageParam> = {}): AuthorityManager {
  const data: Record<string, unknown> = { defaultAuthority: 1, ownerAuthority: 5, ...cfg };
  const config = { get: (k: string) => data[k] } as unknown as ConfigManager;
  return new AuthorityManager(config, makeLogger(), storage as StorageParam);
}

const QQ = { platform: 'onebot', userId: '12345' };

/** 建账户 + 发码 + 消费的快捷流 */
function bindQQ(m: AuthorityManager, account = 'alice'): string {
  const { code } = m.createBindCode('webui', account);
  m.consumeBindCode(code, QQ);
  return code;
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
    const m = makeManager({ defaultAuthority: 1 });
    m.setAuthority('webui', 'alice', 2);
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
  it('等级取 max、grants/denies 并集写入账户', () => {
    const m = makeManager({ defaultAuthority: 1 });
    m.setAuthority('webui', 'alice', 1);
    m.setUserCapabilities('webui', 'alice', { grants: ['tool:a'] });
    m.setAuthority('onebot', '12345', 3);
    m.setUserCapabilities('onebot', '12345', { grants: ['tool:b'], denies: ['tool:evil'] });
    bindQQ(m);
    const alice = m.listUsers().find(u => u.userId === 'alice');
    expect(alice?.authority).toBe(3); // max(1, 3)
    expect(alice?.grants?.sort()).toEqual(['tool:a', 'tool:b']);
    expect(alice?.denies).toEqual(['tool:evil']);
    // 平台身份原记录留底未动
    expect(m.listUsers().find(u => u.userId === '12345')?.grants).toEqual(['tool:b']);
  });

  it('平台身份无记录时账户不变', () => {
    const m = makeManager({ defaultAuthority: 1 });
    m.setAuthority('webui', 'alice', 2);
    bindQQ(m);
    expect(m.listUsers().find(u => u.userId === 'alice')?.authority).toBe(2);
  });
});

describe('运行时解析（零合并单一真源）', () => {
  it('被绑身份的等级实时跟随账户（改账户立即生效）', () => {
    const m = makeManager({ defaultAuthority: 1 });
    m.setAuthority('webui', 'alice', 2);
    bindQQ(m);
    expect(m.getAuthority('onebot', '12345')).toBe(2);
    m.setAuthority('webui', 'alice', 4);
    expect(m.getAuthority('onebot', '12345')).toBe(4);
  });

  it('grants 以账户为唯一真源；自身 denies 绑定后仍生效（防洗白）', () => {
    const m = makeManager({ defaultAuthority: 1 });
    m.setUserCapabilities('onebot', '12345', { denies: ['tool:banned'] });
    m.setAuthority('webui', 'alice', 1);
    bindQQ(m);
    // 绑后给账户 grant —— 被绑身份立即享有
    m.setUserCapabilities('webui', 'alice', { grants: ['tool:x'], denies: ['tool:banned'] });
    expect(m.authorize(QQ, { capabilities: ['tool:x'], declaredAuthority: 4 })).toBeNull();
    // 被绑身份自身的 deny（绑时已并入账户，且自身记录仍参与并集）继续拒绝
    expect(m.authorize(QQ, { capabilities: ['tool:banned'], declaredAuthority: 0 })).toMatch(/已被禁止/);
  });
});

describe('解绑还原', () => {
  it('解绑后回到平台身份自身记录（留底生效）', () => {
    const m = makeManager({ defaultAuthority: 1 });
    m.setAuthority('onebot', '12345', 3);
    m.setAuthority('webui', 'alice', 5);
    bindQQ(m);
    expect(m.getAuthority('onebot', '12345')).toBe(5);
    expect(m.unlinkIdentity('onebot', '12345')).toBe(true);
    expect(m.getAuthority('onebot', '12345')).toBe(3); // 还原
    expect(m.listUsers().find(u => u.userId === 'alice')?.links).toBeUndefined();
    expect(m.unlinkIdentity('onebot', '12345')).toBe(false);
  });
});

describe('持久化与级联', () => {
  it('links 经 save/init 往返存活，linkIndex 重建后解析仍生效', async () => {
    let written = '';
    const m = makeManager({ defaultAuthority: 1 }, {
      writeFile: async (_uri: string, payload: string | Uint8Array) => {
        written = payload as string;
      },
    } as Partial<StorageParam>);
    m.setAuthority('webui', 'alice', 4);
    bindQQ(m);
    m.save();
    await new Promise(r => setTimeout(r, 0));
    const m2 = makeManager({ defaultAuthority: 1 }, { readFile: async () => written } as Partial<StorageParam>);
    await m2.init();
    expect(m2.getAuthority('onebot', '12345')).toBe(4);
    expect(m2.listUsers().find(u => u.userId === '12345')?.linkedTo).toBe('webui:alice');
  });

  it('删除账户记录后被绑身份自动还原', () => {
    const m = makeManager({ defaultAuthority: 1 });
    m.setAuthority('onebot', '12345', 3);
    m.setAuthority('webui', 'alice', 5);
    bindQQ(m);
    m.removeUser('webui', 'alice');
    expect(m.getAuthority('onebot', '12345')).toBe(3);
  });
});
