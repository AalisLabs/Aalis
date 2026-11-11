import { chmodSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OriginTurn, originTurnOf } from '../../packages/api-authority/src/index.js';
import { isReachCredential, type ReachCredential, type ReachRequest } from '../../packages/api-reach/src/index.js';
import type { SessionInfo } from '../../packages/api-session-manager/src/index.js';
import type { App, Logger } from '../../packages/core/src/index.js';
import { sessionTmpOf, sweepSessionTmp } from '../../packages/plugin-reach/src/session-tmp.js';
import type { FromTurn, IncomingMessage } from '../../packages/schema-message/src/index.js';
import {
  OWNER_QQ,
  OWNER_TURN,
  ownerTurn,
  projectSession,
  type ReachDirs,
  reachDirs,
  removeDirs,
  sessionTmpIn,
  startReach,
} from '../fixtures/reach-host.js';
import { recordRoom } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 触及服务：按一次工具调用签发凭据。主体取权限服务的 principalOf，场所与绑定取会话管理里的记录，档位固定为工作区档、
// 越界要问，清单按真实路径生成；子任务的类别随发起它的那一轮，主体按这次调用的参与者，批过的按批的人；本会话临时区按需建、
// 随会话删、定期清扫。
// ════════════════════════════════════════════════════════════

const MEMBER = '30001';
const OWNER_DM = `onebot:10000:private:${OWNER_QQ}`;
const MEMBER_DM = `onebot:10000:private:${MEMBER}`;
const GROUP = 'onebot:10000:group:20001';

let dirs: ReachDirs;
let savedHome: string | undefined;
const apps: App[] = [];

beforeEach(() => {
  dirs = reachDirs();
  savedHome = process.env.HOME;
  process.env.HOME = dirs.user;
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  process.env.HOME = savedHome;
  removeDirs(dirs);
});

async function start(opts: Parameters<typeof startReach>[1] = {}) {
  const started = await startReach(dirs, opts);
  apps.push(started.app);
  const sm = started.host.sessionManager.use;
  const svc = started.host.reach.use;
  const webui = (await sm.createSession({ name: 'w' }, { createdFrom: 'webui' })).id;
  return { ...started, sm, svc, webui };
}

const write = (path: string): ReachRequest => ({ effect: 'write', path });
const read = (path: string): ReachRequest => ({ effect: 'read', path });

/** require 的结果写成短码：allow，或拒绝时回给模型的话 */
async function verdict(cred: ReachCredential, request: ReachRequest): Promise<string> {
  const v = await cred.require(request);
  return v.allowed ? 'allow' : v.message;
}

describe('上限：主体是 owner 的一轮有本地效果，不论在哪个会话', () => {
  /** onebot 上这个人在这个会话里亲手发来的一轮 */
  const handTurn = (sessionId: string, userId: string): OriginTurn => ({
    sessionId,
    platform: 'onebot',
    userId,
    participants: [{ platform: 'onebot', userId }],
    inbound: {},
  });

  it('owner 亲手发起的在 WebUI、她的 IM 私聊、群、往别人的私聊插话与内部会话里都有；群成员、别人私聊里的对方、自主回合与没有回合的调用没有', async () => {
    const { host, svc, sm, webui } = await start();
    for (const id of [OWNER_DM, MEMBER_DM, GROUP]) await recordRoom(host.events.use, id);
    await sm.ensureSession('workflow::daily');
    const exec = async (turn: OriginTurn) => (await svc.forCall(turn)).exec;
    expect(await exec(ownerTurn(webui))).toBe('sandbox');
    expect(await exec(handTurn(OWNER_DM, OWNER_QQ))).toBe('sandbox');
    expect(await exec(handTurn(GROUP, OWNER_QQ)), '群里').toBe('sandbox');
    expect(await exec(ownerTurn(MEMBER_DM)), 'owner 从 WebUI 往别人的私聊插话').toBe('sandbox');
    expect(await exec(ownerTurn('workflow::daily')), '内部会话').toBe('sandbox');
    expect(await exec(handTurn(GROUP, MEMBER)), '群成员').toBe('none');
    expect(await exec(handTurn(MEMBER_DM, MEMBER)), '别人私聊里的对方').toBe('none');
    expect(
      await exec({ sessionId: webui, platform: 'webui', participants: [OWNER_TURN], inbound: { source: 'scheduler' } }),
      'owner 建的定时任务',
    ).toBe('none');
    expect(
      await exec({
        sessionId: GROUP,
        platform: 'onebot',
        participants: [{ platform: 'onebot', userId: '' }],
        inbound: { source: 'idle-trigger' },
      }),
      '空闲开话题',
    ).toBe('none');
    expect(await exec({ sessionId: webui, platform: 'mcp', participants: [OWNER_TURN] }), '没有回合的调用').toBe(
      'none',
    );
  });

  it('owner 在群里亲手发起：主目录是默认工作区目录', async () => {
    const { host, paths, svc } = await start();
    await recordRoom(host.events.use, GROUP);
    expect(await svc.forCall(handTurn(GROUP, OWNER_QQ))).toMatchObject({ exec: 'sandbox', home: paths.workspace });
  });

  it('群里没点名、被频率触发挑中的话按说话的人算：owner 的有，群成员的没有', async () => {
    const { host, svc } = await start();
    await recordRoom(host.events.use, GROUP);
    const picked = (userId: string) =>
      originTurnOf([{ content: '<闲聊>', sessionId: GROUP, platform: 'onebot', userId, triggerType: 'interval' }]);
    expect((await svc.forCall(picked(OWNER_QQ))).exec).toBe('sandbox');
    expect((await svc.forCall(picked(MEMBER))).exec).toBe('none');
  });

  it('续做随发起它的那一轮：owner 那一轮的续做在群里也有，群成员那一轮的没有', async () => {
    const { host, svc } = await start();
    await recordRoom(host.events.use, GROUP);
    const resume = (userId: string) => {
      const identity = { platform: 'onebot', userId };
      return originTurnOf([
        {
          content: '<结束通知>',
          sessionId: GROUP,
          platform: 'onebot',
          source: 'bg:bg_1',
          fromTurn: { platform: 'onebot', userId, participants: [identity] },
        },
      ]);
    };
    expect((await svc.forCall(resume(OWNER_QQ))).exec).toBe('sandbox');
    expect((await svc.forCall(resume(MEMBER))).exec).toBe('none');
  });

  it('没有本地效果的凭据：读写执行一律拒，不带主目录，没有子进程环境与沙箱策略', async () => {
    const { host, svc } = await start();
    await recordRoom(host.events.use, GROUP);
    const cred = await svc.forCall(handTurn(GROUP, MEMBER));
    expect(isReachCredential(cred)).toBe(true);
    expect(Object.isFrozen(cred)).toBe(true);
    // 品牌不可枚举：展开或 Object.assign 复制出来、改了方法再转交的对象不是凭据
    expect(isReachCredential({ ...cred, allows: () => true })).toBe(false);
    expect(isReachCredential(Object.assign({}, cred))).toBe(false);
    expect(cred).not.toHaveProperty('home');
    expect(await verdict(cred, read(join(dirs.user, 'notes.md')))).toBe(
      `读 ${join(dirs.user, 'notes.md')}：这一轮不只有 owner 的话，没有本地效果`,
    );
    expect(cred.allows('read', join(dirs.user, 'notes.md'))).toBe(false);
    expect((await cred.require({ effect: 'network', via: 'url' })).allowed, '联网交给资格轴').toBe(true);
    await expect(cred.processEnv('sandbox')).rejects.toThrow('没有本地效果');
    expect(() => cred.sandboxPolicy()).toThrow();
  });
});

describe('场所、绑定与档位', () => {
  it('owner 的 IM 私聊与 WebUI 的会话在同一个工作区、同一档位时结果相同：主目录是默认工作区目录，可写', async () => {
    const { host, paths, svc, webui } = await start();
    await recordRoom(host.events.use, OWNER_DM);
    const fromWeb = await svc.forCall(ownerTurn(webui));
    const fromDm = await svc.forCall({
      sessionId: OWNER_DM,
      platform: 'onebot',
      userId: OWNER_QQ,
      participants: [{ platform: 'onebot', userId: OWNER_QQ }],
      inbound: {},
    });
    const requests: ReachRequest[] = [
      write(join(paths.workspace, 'a.md')),
      write(join(dirs.user, 'code', 'x.ts')),
      read(join(dirs.user, '.ssh', 'id_ed25519')),
      write(join(dirs.data, 'state', 'x')),
      write(join(dirs.data, 'self', 'skills', 's', 'SKILL.md')),
      write(join(dirs.user, '.gitconfig')),
      { effect: 'exec', host: false },
      { effect: 'exec', host: true },
      { effect: 'network', via: 'url' },
    ];
    const summary = async (cred: ReachCredential) => ({
      exec: cred.exec,
      home: cred.home,
      verdicts: await Promise.all(requests.map(r => verdict(cred, r))),
    });
    expect(await summary(fromDm)).toEqual(await summary(fromWeb));
    expect(fromWeb).toMatchObject({ exec: 'sandbox', home: paths.workspace });
    expect(Object.keys(fromWeb).sort()).toEqual(['allows', 'exec', 'home', 'processEnv', 'require', 'sandboxPolicy']);
    expect(await verdict(fromWeb, write(join(paths.workspace, 'a.md')))).toBe('allow');
    expect(fromWeb.allows('read', join(paths.workspace, 'a.md'))).toBe(true);
  });

  it('项目工作区里的 owner 会话：主目录是绑定目录；没有绑定目录的会话主目录是默认工作区目录', async () => {
    const { paths, sm, svc, webui } = await start();
    const root = join(dirs.base, 'code', 'proj');
    mkdirSync(root, { recursive: true });
    const project = await projectSession(sm, root);

    expect(await svc.forCall(ownerTurn(project))).toMatchObject({ home: root });
    expect(await svc.forCall(ownerTurn(webui))).toMatchObject({ home: paths.workspace });
  });

  it('项目会话绑定在 worktree 上：仓库的 git 目录可写、落点要问，仓库的其他 worktree 不可写', async () => {
    const { sm, svc } = await start();
    const main = join(dirs.base, 'code', 'main');
    const common = join(main, '.git');
    const wt = join(dirs.base, 'code', 'main-wt-a');
    for (const dir of [join(common, 'objects'), join(common, 'worktrees', 'a'), wt])
      mkdirSync(dir, { recursive: true });
    writeFileSync(join(common, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(common, 'worktrees', 'a', 'commondir'), '../..\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${join(common, 'worktrees', 'a')}\n`);
    const cred = await svc.forCall(ownerTurn(await projectSession(sm, wt, main)));
    expect(cred.allows('write', join(wt, 'src', 'a.ts'))).toBe(true);
    expect(cred.allows('write', join(common, 'objects', 'ab', 'cd'))).toBe(true);
    expect(cred.allows('write', join(common, 'worktrees', 'a', 'index'))).toBe(true);
    expect(await verdict(cred, write(join(common, 'hooks', 'pre-commit')))).toContain('自动执行');
    expect(cred.allows('write', join(main, 'src', 'a.ts')), '仓库的其他 worktree').toBe(false);
    expect(await verdict(cred, write(join(main, 'src', 'a.ts')))).toContain('可写范围');
  });

  it('.git 指向的地方不像 git 目录时不算仓库的 git 目录', async () => {
    const { sm, svc } = await start();
    const fake = join(dirs.user, '.aws');
    const proj = join(dirs.base, 'code', 'proj');
    mkdirSync(fake, { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, '.git'), `gitdir: ${fake}\n`);
    expect(
      (await svc.forCall(ownerTurn(await projectSession(sm, proj)))).allows('write', join(fake, 'credentials')),
    ).toBe(false);
  });

  it('.git 是符号链接时按它指向的 git 目录算，不往上找外层仓库；.git 文件读不到时按不在仓库里', async () => {
    const { sm, svc } = await start();
    const outer = join(dirs.base, 'code');
    const real = join(dirs.base, 'gitdirs', 'proj');
    const proj = join(outer, 'proj');
    for (const dir of [join(outer, '.git', 'objects'), join(real, 'objects'), proj])
      mkdirSync(dir, { recursive: true });
    writeFileSync(join(outer, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/main\n');
    symlinkSync(real, join(proj, '.git'));
    const cred = await svc.forCall(ownerTurn(await projectSession(sm, proj)));
    expect(cred.allows('write', join(real, 'objects', 'ab')), '链接指向的 git 目录').toBe(true);
    expect(cred.allows('write', join(outer, '.git', 'objects', 'ab')), '外层仓库').toBe(false);

    const locked = join(dirs.base, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, '.git'), `gitdir: ${real}\n`);
    chmodSync(join(locked, '.git'), 0);
    await expect(svc.forCall(ownerTurn(await projectSession(sm, locked)))).resolves.toMatchObject({
      exec: 'sandbox',
      home: locked,
    });
  });

  it('档位固定为工作区档、越界要问', async () => {
    const { svc, webui } = await start();
    const outside = write(join(dirs.user, 'elsewhere', 'x'));
    const cred = await svc.forCall(ownerTurn(webui));
    expect(cred.exec).toBe('sandbox');
    expect(await verdict(cred, outside)).toContain('要 owner 批准');
  });
});

describe('子任务随派它的那一轮', () => {
  /**
   * 父会话的一轮派出子任务：与子任务插件相同，发出 source 为 subtask、发言者记作父会话、带着派它的那一轮的任务消息；
   * 返回 agent 由这条消息拼出的子任务回合
   */
  const dispatch = async (
    host: Awaited<ReturnType<typeof start>>['host'],
    child: string,
    parent: string,
    from: Pick<IncomingMessage, 'fromTurn'>,
  ): Promise<OriginTurn> => {
    const message: IncomingMessage = {
      content: '<任务>',
      sessionId: child,
      platform: 'webui',
      userId: `parent:${parent}`,
      source: 'subtask',
      ...from,
    };
    await host.events.use.emit('inbound:message', message);
    return originTurnOf([message]);
  };
  /** owner 在 WebUI 亲手那一轮 */
  const OWNER_HAND: FromTurn = { platform: 'webui', userId: 'console', participants: [OWNER_TURN] };
  /** owner 建的定时任务那一轮 */
  const SCHEDULED: FromTurn = { platform: 'webui', participants: [OWNER_TURN], source: 'scheduler' };

  it('owner 亲手那一轮派的（那一轮没签发过凭据）：子任务与父会话一样，写自己的临时区；子任务里转后台的调用的续做随之', async () => {
    const { host, paths, sm, svc, webui } = await start();
    const child = (await sm.createChildSession(webui, {})).id;
    const turn = await dispatch(host, child, webui, { fromTurn: OWNER_HAND });

    const issued = await svc.forCall(turn);
    expect(issued).toMatchObject({ exec: 'sandbox', home: paths.workspace });
    expect(issued.allows('write', join(sessionTmpIn(dirs.data, child), 'x'))).toBe(true);
    const note = join(paths.workspace, 'a.md');
    expect(issued.allows('write', note)).toBe(true);

    const resumed: OriginTurn = {
      sessionId: child,
      platform: 'webui',
      userId: `parent:${webui}`,
      participants: [OWNER_TURN],
      inbound: {
        source: 'bg:bg_1',
        fromTurn: {
          platform: 'webui',
          userId: `parent:${webui}`,
          participants: [OWNER_TURN],
          source: 'subtask',
          fromTurn: OWNER_HAND,
        },
      },
    };
    expect((await svc.forCall(resumed)).exec).toBe('sandbox');
  });

  it('owner 的会话里 owner 那一轮签发过凭据，之后定时任务那一轮派的子任务没有本地效果；owner 那一轮再追问，那一轮的子任务回合随 owner', async () => {
    const { host, sm, svc, webui } = await start();
    await svc.forCall(ownerTurn(webui));
    const child = (await sm.createChildSession(webui, {})).id;
    const scheduled = await dispatch(host, child, webui, { fromTurn: SCHEDULED });
    expect((await svc.forCall(scheduled)).exec).toBe('none');

    const asked = await dispatch(host, child, webui, { fromTurn: OWNER_HAND });
    expect((await svc.forCall(asked)).exec).toBe('sandbox');
    expect((await svc.forCall(scheduled)).exec, '定时任务派的那一轮照旧').toBe('none');
  });

  it('群里 owner 那一轮签发过凭据，之后群成员那一轮派的子任务没有本地效果', async () => {
    const { host, sm, svc } = await start();
    await recordRoom(host.events.use, GROUP);
    const owner = await svc.forCall({
      sessionId: GROUP,
      platform: 'onebot',
      userId: OWNER_QQ,
      participants: [{ platform: 'onebot', userId: OWNER_QQ }],
      inbound: {},
    });
    expect(owner.exec, 'owner 那一轮自己有').toBe('sandbox');
    const child = (await sm.createChildSession(GROUP, {})).id;
    const member = { platform: 'onebot', userId: MEMBER };
    const turn = await dispatch(host, child, GROUP, {
      fromTurn: { platform: 'onebot', userId: MEMBER, participants: [member] },
    });
    expect((await svc.forCall(turn)).exec).toBe('none');
  });
});

describe('清单按真实路径', () => {
  it('安装集经符号链接给出时按它指向的目录；经链接装进来的安装集外的包也是宿主控制面', async () => {
    const ext = join(dirs.base, 'ext', 'zz-linked');
    mkdirSync(ext, { recursive: true });
    symlinkSync(ext, join(dirs.app, 'node_modules', 'zz-linked'));
    mkdirSync(join(dirs.app, 'node_modules', '@zz'), { recursive: true });
    mkdirSync(join(dirs.app, 'packages', 'inside'), { recursive: true });
    symlinkSync(join(dirs.app, 'packages', 'inside'), join(dirs.app, 'node_modules', '@zz', 'inside'));
    // 坏掉的作用域链接与同名的文件：跳过，不让插件启动失败
    symlinkSync(join(dirs.base, 'gone'), join(dirs.app, 'node_modules', '@zz-broken'));
    writeFileSync(join(dirs.app, 'node_modules', '@zz-file'), '');
    // 源码形态下 packages/ 里链接到安装集以外的包：与安装集里的包一样，构建产物与依赖归宿主控制面
    const linkedPkg = join(dirs.base, 'ext', 'zz-pkg');
    mkdirSync(linkedPkg, { recursive: true });
    symlinkSync(linkedPkg, join(dirs.app, 'packages', 'zz-pkg'));
    const appLink = join(dirs.base, 'app-link');
    symlinkSync(dirs.app, appLink);
    const { svc, webui } = await start({ appPath: appLink });
    const cred = await svc.forCall(ownerTurn(webui));
    for (const path of [
      join(dirs.app, 'node_modules', 'x', 'index.js'),
      join(dirs.app, 'packages', 'inside', 'dist', 'index.js'),
      join(ext, 'index.js'),
      join(linkedPkg, 'dist', 'index.js'),
      join(linkedPkg, 'node_modules', 'x', 'index.js'),
    ]) {
      expect(await verdict(cred, write(path)), path).toContain('宿主控制面');
    }
    for (const path of [join(dirs.app, 'packages', 'inside', 'src', 'index.ts'), join(linkedPkg, 'src', 'index.ts')]) {
      expect(await verdict(cred, write(path)), `源码不在内：${path}`).not.toContain('宿主控制面');
    }
  });

  /** owner 在 WebUI 会话里的一轮签发的凭据 */
  async function ownerCredential(started: Awaited<ReturnType<typeof start>>) {
    return started.svc.forCall(ownerTurn(started.webui));
  }

  /** 启动实例时守护进程的入口（插件激活时按 process.argv[1] 取） */
  async function startWithEntry(entry: string, opts: Parameters<typeof startReach>[1] = {}) {
    const saved = process.argv[1];
    process.argv[1] = entry;
    try {
      return await start(opts);
    } finally {
      process.argv[1] = saved;
    }
  }

  describe('以具体路径为根的规则，路径上有符号链接时按真实路径另加一份', () => {
    const dotfiles = () => join(dirs.base, 'dotfiles');
    /** 在 dotfiles 仓库里放好文件，再从 at 链接过去 */
    const linkFromDotfiles = (name: string, at: string, dir = false) => {
      const real = join(dotfiles(), name);
      mkdirSync(dir ? real : dotfiles(), { recursive: true });
      if (!dir) writeFileSync(real, '');
      symlinkSync(real, at);
      return real;
    };

    it('拒读：数据目录里的 secrets.yaml、链接出去的 ~/.ssh，读真实路径照样拒', async () => {
      const secrets = linkFromDotfiles('secrets.yaml', join(dirs.data, 'secrets.yaml'));
      const ssh = linkFromDotfiles('ssh', join(dirs.user, '.ssh'), true);
      const { svc, webui } = await start();
      const cred = await svc.forCall(ownerTurn(webui));
      for (const path of [secrets, join(ssh, 'id_ed25519')]) {
        expect(await verdict(cred, read(path)), path).toContain('拒读清单');
      }
    });

    it('宿主控制面：写 secrets.yaml 与主配置的真实路径照样拒', async () => {
      const secrets = linkFromDotfiles('secrets.yaml', join(dirs.data, 'secrets.yaml'));
      const config = linkFromDotfiles('aalis.config.yaml', join(dirs.data, 'aalis.config.yaml'));
      const cred = await ownerCredential(await start());
      for (const path of [secrets, config]) {
        expect(await verdict(cred, write(path)), path).toContain('宿主控制面');
      }
    });

    it('落点：工作区档在 dotfiles 仓库里写 ~/.zshrc 与 ~/.gitconfig 链接到的文件要问', async () => {
      const zshrc = linkFromDotfiles('zshrc', join(dirs.user, '.zshrc'));
      const gitconfig = linkFromDotfiles('gitconfig', join(dirs.user, '.gitconfig'));
      const { sm, svc } = await start();
      const cred = await svc.forCall(ownerTurn(await projectSession(sm, dotfiles())));
      expect(await verdict(cred, write(join(dotfiles(), 'README.md')))).toBe('allow');
      for (const path of [zshrc, gitconfig]) {
        expect(await verdict(cred, write(path)), path).toContain('自动执行');
      }
    });

    it('取不到真实路径（链接成环）的根记 warn，照常激活', async () => {
      symlinkSync('.zshrc', join(dirs.user, '.zshrc'));
      const warns: string[] = [];
      const logger: Logger = {
        debug() {},
        info() {},
        warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
        error() {},
        child: () => logger,
      };
      const { svc, webui } = await start({ logger });
      expect((await svc.forCall(ownerTurn(webui))).exec).toBe('sandbox');
      expect(warns.filter(w => w.includes(join(dirs.user, '.zshrc')))).toHaveLength(1);
    });
  });

  describe('守护进程的入口与安装集的 package.json', () => {
    it('npm 形态（create-aalis 生成的项目，数据目录在安装集里）：两个都是宿主控制面', async () => {
      const entry = join(dirs.app, 'index.mjs');
      writeFileSync(entry, '');
      writeFileSync(join(dirs.app, 'package.json'), '{}');
      dirs.data = join(dirs.app, 'data');
      mkdirSync(dirs.data);
      const cred = await ownerCredential(await startWithEntry(entry));
      for (const path of [entry, join(dirs.app, 'package.json')]) {
        expect(await verdict(cred, write(path)), path).toContain('宿主控制面');
      }
    });

    it('源码形态（安装集下有 packages/）照旧：入口与 package.json 是在改的源码', async () => {
      const entry = join(dirs.app, 'src', 'index.ts');
      mkdirSync(join(dirs.app, 'src'));
      mkdirSync(join(dirs.app, 'packages'));
      writeFileSync(entry, '');
      writeFileSync(join(dirs.app, 'package.json'), '{}');
      const cred = await ownerCredential(await startWithEntry(entry));
      for (const path of [entry, join(dirs.app, 'package.json')]) {
        expect(await verdict(cred, write(path)), path).not.toContain('宿主控制面');
      }
    });
  });
});

describe('本会话临时区', () => {
  const tmpOf = (id: string) => sessionTmpIn(dirs.data, id);

  it('目录名是会话 id 的十六进制：大小写不敏感的文件系统上，两个会话的临时区不会落到同一个目录', () => {
    const tmp = join(dirs.data, 'tmp');
    // 这两个 id 的 base64url 只差大小写
    expect(sessionTmpOf(tmp, 'tg:private:aaa').toLowerCase()).not.toBe(
      sessionTmpOf(tmp, 'tg:private:Gaa').toLowerCase(),
    );
  });

  it('有本地效果时建好（0700），没有本地效果不建；删会话时删', async () => {
    const { host, sm, svc, webui } = await start();
    await recordRoom(host.events.use, GROUP);
    await svc.forCall({
      sessionId: GROUP,
      platform: 'onebot',
      userId: MEMBER,
      participants: [{ platform: 'onebot', userId: MEMBER }],
      inbound: {},
    });
    expect(existsSync(tmpOf(GROUP))).toBe(false);

    await svc.forCall(ownerTurn(webui));
    expect(statSync(tmpOf(webui)).mode & 0o777).toBe(0o700);
    writeFileSync(join(tmpOf(webui), 'scratch.txt'), 'x');
    await sm.deleteSession(webui);
    // 删临时区在后台跑
    await vi.waitFor(() => expect(existsSync(tmpOf(webui))).toBe(false));
  });

  it('启动时清扫：7 天没改动、会话不在运行（含会话表里查不到）的删；在运行的与最近改过的留着', async () => {
    const record = (id: string, status: string) => ({
      id,
      name: id,
      children: [],
      status,
      config: {},
      createdAt: 0,
      updatedAt: 0,
      createdFrom: 'webui',
    });
    const stored = {
      'session-stale': record('session-stale', 'completed'),
      'session-running': record('session-running', 'active'),
      'session-fresh': record('session-fresh', 'completed'),
      'session-deep': record('session-deep', 'completed'),
    };
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const make = (id: string, recent?: string) => {
      const dir = tmpOf(id);
      mkdirSync(join(dir, 'sub'), { recursive: true });
      writeFileSync(join(dir, 'sub', 'a.txt'), 'x');
      for (const p of [join(dir, 'sub', 'a.txt'), join(dir, 'sub'), dir]) utimesSync(p, old, old);
      if (recent) writeFileSync(join(dir, recent), 'y');
    };
    make('session-gone');
    // 会话表里查不到但最近改过：会话表读不出（记忆后端暂时连不上）时表是空的，不能据此删
    make('session-unknown-fresh', 'new.txt');
    make('session-stale');
    make('session-running');
    make('session-fresh', 'new.txt');
    make('session-deep');
    writeFileSync(join(tmpOf('session-deep'), 'sub', 'b.txt'), 'z');
    utimesSync(join(tmpOf('session-deep'), 'sub'), old, old);
    utimesSync(tmpOf('session-deep'), old, old);
    // 不是会话 id 的编码（大写的十六进制解得出来，往回编码却对不上）：再旧也不动
    const strays = ['not hex!', Buffer.from('session-other').toString('hex').toUpperCase()];
    for (const name of strays) {
      mkdirSync(join(dirs.data, 'tmp', 'sessions', name), { recursive: true });
      utimesSync(join(dirs.data, 'tmp', 'sessions', name), old, old);
    }

    // 清扫在后台跑，收尾时等它执行完毕
    await (await start({ stored })).app.stop();
    expect(existsSync(tmpOf('session-gone')), '会话表里没有、7 天没改动').toBe(false);
    expect(existsSync(tmpOf('session-unknown-fresh')), '会话表里没有、最近改过').toBe(true);
    expect(existsSync(tmpOf('session-stale')), '7 天没改动').toBe(false);
    expect(existsSync(tmpOf('session-running')), '会话在运行').toBe(true);
    expect(existsSync(tmpOf('session-fresh')), '最近改过').toBe(true);
    expect(existsSync(tmpOf('session-deep')), '深层文件最近改过').toBe(true);
    for (const name of strays) {
      expect(existsSync(join(dirs.data, 'tmp', 'sessions', name)), `不是会话临时区的目录不动：${name}`).toBe(true);
    }
  });

  describe('清扫与并发', () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const stale = (id: string) => {
      mkdirSync(join(tmpOf(id), 'sub'), { recursive: true });
      writeFileSync(join(tmpOf(id), 'sub', 'a.txt'), 'x');
      for (const p of [join(tmpOf(id), 'sub', 'a.txt'), join(tmpOf(id), 'sub'), tmpOf(id)]) utimesSync(p, old, old);
    };
    const session = (status: string) => ({ status }) as SessionInfo;
    const warns: string[] = [];
    const logger = { warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')) };
    const sweep = (sessionOf: (id: string) => SessionInfo | undefined) =>
      sweepSessionTmp(join(dirs.data, 'tmp'), sessionOf, Date.now(), logger);
    beforeEach(() => {
      warns.length = 0;
    });

    it('遍历时临时区被别处删掉：跳过它，别的照常清扫', async () => {
      stale('session-vanish');
      stale('session-stale');
      const sessionOf = (id: string) => {
        if (id === 'session-vanish') rmSync(tmpOf(id), { recursive: true });
        return session('completed');
      };
      await expect(sweep(sessionOf)).resolves.toEqual(['session-stale']);
      expect(warns).toEqual([]);
    });

    it('遍历期间会话开了新回合：删之前再查一次，在运行的不删', async () => {
      stale('session-woke');
      let calls = 0;
      const sessionOf = () => session(calls++ === 0 ? 'completed' : 'active');
      await expect(sweep(sessionOf)).resolves.toEqual([]);
      expect(existsSync(tmpOf('session-woke'))).toBe(true);
    });

    it('删不掉的临时区记一条 warn，写明目录；不妨碍别的照常清扫', async () => {
      stale('session-locked');
      stale('session-stale');
      // 只读的子目录：里面的文件删不掉
      const locked = join(tmpOf('session-locked'), 'sub');
      chmodSync(locked, 0o555);
      try {
        await expect(sweep(() => session('completed'))).resolves.toEqual(['session-stale']);
      } finally {
        chmodSync(locked, 0o755);
      }
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(tmpOf('session-locked'));
      expect(warns[0]).toContain('EACCES');
    });
  });
});

describe('沙箱策略', () => {
  it('只读与工作区档有：可写根含场所的主目录与本会话临时区', async () => {
    const { paths, svc, webui } = await start();
    const policy = (await svc.forCall(ownerTurn(webui))).sandboxPolicy();
    expect(policy.write).toEqual(expect.arrayContaining([paths.workspace, sessionTmpIn(dirs.data, webui)]));
    expect(policy.network).toBe('on');
  });
});
