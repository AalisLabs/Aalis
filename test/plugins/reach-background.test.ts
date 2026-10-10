import { existsSync, mkdirSync, utimesSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Logger } from '../../packages/core/src/index.js';
import { ownerTurn, type ReachDirs, reachDirs, removeDirs, sessionTmpIn, startReach } from '../fixtures/reach-host.js';

// ════════════════════════════════════════════════════════════
// 触及插件删本会话临时区在后台跑：启动时的清扫不拖住激活，删会话不等删临时区；出错记 warn，收尾时等它们落定。
// 删除经 node:fs/promises 的 rm，用例按路径把它挡住，看挡住期间别的照常往前走。
// ════════════════════════════════════════════════════════════

/** 被挡住的 rm：路径 → 放行（按原样删）或以给的错误失败 */
const { gates } = vi.hoisted(() => ({
  gates: new Map<string, { promise: Promise<void>; open: () => void; fail: (err: Error) => void }>(),
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rm: typeof actual.rm = (path, options) => {
    const gate = gates.get(String(path));
    return gate ? gate.promise.then(() => actual.rm(path, options)) : actual.rm(path, options);
  };
  return { ...actual, default: { ...actual, rm }, rm };
});

/** 挡住对这个路径的 rm */
function block(path: string) {
  let open!: () => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  gates.set(path, { promise, open, fail });
  return { open, fail };
}

let dirs: ReachDirs;
let savedHome: string | undefined;
const apps: App[] = [];
const warns: string[] = [];
const logger: Logger = {
  debug() {},
  info() {},
  warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
  error() {},
  child: () => logger,
};

beforeEach(() => {
  dirs = reachDirs();
  savedHome = process.env.HOME;
  process.env.HOME = dirs.user;
  warns.length = 0;
});

afterEach(async () => {
  for (const gate of gates.values()) gate.open();
  gates.clear();
  for (const app of apps.splice(0)) await app.stop();
  process.env.HOME = savedHome;
  removeDirs(dirs);
});

async function start() {
  const started = await startReach(dirs, { logger });
  apps.push(started.app);
  return { ...started, sm: started.host.sessionManager.use, svc: started.host.reach.use };
}

describe('本会话临时区的删除在后台跑', () => {
  it('启动时的清扫不拖住激活：清扫删到一半时插件已经可用，收尾时等它删完', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const stale = sessionTmpIn(dirs.home, 'session-gone');
    mkdirSync(stale, { recursive: true });
    utimesSync(stale, old, old);
    const gate = block(stale);

    const { app, svc, sm } = await start();
    const webui = (await sm.createSession({ name: 'w' }, { createdFrom: 'webui' })).id;
    expect((await svc.forCall(ownerTurn(webui))).exec).toBe('sandbox');
    expect(existsSync(stale), '清扫还挡在删除上').toBe(true);

    gate.open();
    await app.stop();
    expect(existsSync(stale)).toBe(false);
  });

  it('删会话不等删临时区；删不掉时记 warn，写明会话与目录', async () => {
    const { sm, svc } = await start();
    const id = (await sm.createSession({ name: 'w' }, { createdFrom: 'webui' })).id;
    await svc.forCall(ownerTurn(id));
    const tmp = sessionTmpIn(dirs.home, id);
    const gate = block(tmp);

    await sm.deleteSession(id);
    expect(sm.getSession(id)).toBeUndefined();
    expect(warns).toEqual([]);

    gate.fail(Object.assign(new Error('<删不掉>'), { code: 'EACCES' }));
    await vi.waitFor(() => expect(warns).toHaveLength(1));
    expect(warns[0]).toContain(id);
    expect(warns[0]).toContain(tmp);
    expect(warns[0]).toContain('<删不掉>');
  });

  it('同一个 id 的会话删了又建：签发凭据等前一份临时区删完再建，新建的不被删掉', async () => {
    const { sm, svc } = await start();
    const id = 'cli-default';
    await sm.ensureSession(id, {}, { createdFrom: 'cli' });
    await svc.forCall(ownerTurn(id));
    const tmp = sessionTmpIn(dirs.home, id);
    const gate = block(tmp);

    await sm.deleteSession(id);
    await sm.ensureSession(id, {}, { createdFrom: 'cli' });
    const issuing = svc.forCall(ownerTurn(id));
    // 不等前一份删完的话，这段时间里早就签发完了
    const early = await Promise.race([
      issuing.then(() => 'issued'),
      new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 300)),
    ]);
    expect(early, '前一份还没删完').toBe('waiting');

    gate.open();
    await issuing;
    expect(existsSync(tmp)).toBe(true);
  });
});
