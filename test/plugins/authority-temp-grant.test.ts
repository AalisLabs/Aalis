import { describe, expect, it } from 'vitest';
import type { AccessRequest } from '../../packages/api-authority/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { ConfigManager, Logger } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';

// ════════════════════════════════════════════════════════════
// 会话临时授予（tempGrants）在**未授权救援闸**上的身份判据
//
// `isPreApproved` 是守卫「授权未通过」分支唯一的救援口。它下面那段 tempGrants 循环
// 曾只匹配 sessionId + userId + capability，漏了两条：
//
//   1. **不匹配 platform** —— 而 grant 记录里本来就存了 platform。同一个 userId 在
//      另一个平台（onebot 的 '123' vs telegram 的 '123'）会命中别人的授予。
//   2. **降权不撤销旧授予** —— 拿到授予后被封禁到负等级的用户，`authorize` 明确返回
//      「权限不足」，`isPreApproved` 却仍靠旧授予放行。「封了但没封住」，窗口最长 1 小时。
//
// 第 2 条修在 `setUserLevel` 侧（降权即撤销），**不是**在救援口上加「复查当前授权」：
// `isPreApproved` 恰恰是在 authorize 拒绝之后才被调用的，在那里复查会把整条会话授予
// 路径变成死代码。撤销本就是管理动作的一部分。下面第一条「前置」用例守的正是这个——
// 若哪天有人改成复查，它会立刻红。
//
// 上游的 9fb53a92 修的是同一函数**上半截**的 restrictedPolicy 白名单（加了 ownerOnly
// 判据），下半截没动——半截修复。
// ════════════════════════════════════════════════════════════

type Cfg = Record<string, unknown>;
function mkConfig(cfg: Cfg = {}): ConfigManager {
  const store: Cfg = { ...cfg };
  return {
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => {
      store[k] = v;
    },
  } as unknown as ConfigManager;
}
function mkLogger(): Logger {
  const l = { child: () => l, debug() {}, info() {}, warn() {}, error() {} };
  return l as unknown as Logger;
}
const storage = {
  readFile: async () => {
    throw new Error('no file');
  },
  writeFile: async () => {},
} as unknown as StorageService;

const req = (over: Partial<AccessRequest> = {}): AccessRequest =>
  ({
    name: 'shell.exec',
    type: 'tool',
    capability: 'tool:shell.exec',
    sessionId: 's1',
    platform: 'onebot',
    userId: 'alice',
    visibility: 'restricted',
    ...over,
  }) as AccessRequest;

/** 造一个实例，并让 alice 在 s1 会话里拿到一次 session 级授予。 */
async function withGrant() {
  const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
  m.setUserLevel({ platform: 'onebot', userId: 'alice' }, 2);
  m.setConfirmHandler('*', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }));
  const ok = await m.requestAccess(req());
  expect(ok, '前置条件不成立：授予没建起来，后面的断言测不到东西').toBe(true);
  return m;
}

describe('会话临时授予不得成为救援闸上的绕过口', () => {
  it('前置：拿到授予后本人可过（不然后面全是空转）', async () => {
    const m = await withGrant();
    expect(m.isPreApproved(req())).toBe(true);
  });

  it('被封禁到负等级后，已有授予不再放行（封禁必须立即生效）', async () => {
    const m = await withGrant();
    m.setUserLevel({ platform: 'onebot', userId: 'alice' }, -5);
    expect(
      m.authorize({ platform: 'onebot', userId: 'alice' }, { capability: 'tool:shell.exec', visibility: 'restricted' }),
    ).not.toBeNull();
    expect(m.isPreApproved(req()), '被封禁的用户靠旧授予仍能过救援闸——封禁在 TTL 内对该能力形同虚设').toBe(false);
  });

  it('同 userId 但不同 platform 不得命中他人的授予', async () => {
    const m = await withGrant();
    expect(
      m.isPreApproved(req({ platform: 'telegram' })),
      'grant 里存了 platform 却不参与匹配——跨平台同名 id 会白嫖到别人的授予',
    ).toBe(false);
  });

  it('removeUser 造成降权时撤销（level 2 → 记录删掉即回落 0）', async () => {
    const m = await withGrant();
    m.removeUser('onebot', 'alice');
    expect(m.isPreApproved(req()), 'removeUser 把 level 2 抹成 0 是降权，授予应随之失效').toBe(false);
  });

  it('removeUser 不构成降权时不撤销（原等级为负 = 删记录其实是升权）', async () => {
    // 关键是「同一个用户 + 删记录不降权」：alice 被封到 -5（这一步已撤销旧授予），
    // 随后重新拿一份授予；此时 removeUser 把 -5 抹掉 → 回落 0，是**升权**，不该撤销。
    //
    // 这条用例的前一版用的是无记录的另一个用户 bob —— 那测不到东西：无条件撤销撤的是
    // bob 的授予，与 alice 无关，于是「无条件撤销」这个错写法照样全绿（实测确认）。
    // 判据必须落在**被撤销的那个身份**上，否则用例只是看着相关。
    const m = await withGrant();
    m.setUserLevel({ platform: 'onebot', userId: 'alice' }, -5);
    m.setConfirmHandler('*', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }));
    await m.requestAccess(req());
    expect(m.isPreApproved(req()), '前置：封禁态下重新授予应生效（救援口的既有语义）').toBe(true);

    m.removeUser('onebot', 'alice'); // -5 → 0，升权
    expect(m.isPreApproved(req()), '升权操作却撤销了授予——用户被迫无谓地重新确认一次').toBe(true);
  });

  it('消费端也按 platform 匹配——不得扣掉另一平台同名用户的次数', async () => {
    // `consumeTempGrant` 是私有的，只能从可观察效果去测：给两个平台的同名用户各发一份
    // maxUses=1 的授予，让 A 平台用掉自己那份，然后看 B 平台那份还在不在。
    // 判据必须成对：只在**匹配端**加 platform 而消费端不加，会出现「命中的是 A 的授予、
    // 扣次数的是 B 的」——B 的授予凭空少一次，且下次真用时已被删。
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserLevel({ platform: 'onebot', userId: 'dup' }, 2);
    m.setUserLevel({ platform: 'telegram', userId: 'dup' }, 2);
    m.setConfirmHandler('*', async () => ({ allowed: true, grant: { scope: 'session', maxUses: 1 } }));

    const onA = req({ platform: 'onebot', userId: 'dup' });
    const onB = req({ platform: 'telegram', userId: 'dup' });
    // **插入顺序是关键**：tempGrants 是 Map，按插入序遍历。若先插 A 再让 A 消费，
    // 「无 platform 判据」的错误实现也会先遍历到 A、恰好扣对，变异存活（实测过）。
    // 必须让**别人的授予排在前面**，错误实现才会扣错人。
    expect(await m.requestAccess(onB), '前置：B 的授予（先插入）').toBe(true);
    expect(await m.requestAccess(onA), '前置：A 的授予（后插入）').toBe(true);
    expect(m.listTemporaryGrants().length, '前置：两份授予并存').toBe(2);

    // A 再次请求 → 匹配端只会命中 A 自己那份；消费端若不看 platform，
    // 遍历到的第一条是 B 的 → 扣掉 B 的次数（maxUses=1 → 直接删掉 B 的授予）。
    await m.requestAccess(onA);
    const left = m.listTemporaryGrants();
    expect(left.length, 'A 用掉一份后应只剩一份').toBe(1);
    expect(left[0].platform, '剩下的必须是 B 的——若剩 onebot 说明扣的是 B 的次数').toBe('telegram');
  });

  it('同 platform+userId 但不同会话仍然不得命中（既有判据，防回归）', async () => {
    const m = await withGrant();
    expect(m.isPreApproved(req({ sessionId: 's2' }))).toBe(false);
  });
});
