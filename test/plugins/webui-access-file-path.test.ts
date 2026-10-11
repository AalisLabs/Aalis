import { request } from 'node:http';
import type { Socket } from 'node:net';
import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 启动日志承诺给出 access.txt 的绝对路径（纯 CLI 用户唯一的找法）。
// 原先写文件与解析绝对路径是两个互不相干的 void 异步流：谁先到看调度，而
// resolveLocalPath 走 realpath，文件还没落盘就抛 ENOENT 被空 catch 吞掉，
// 于是「绝对路径」原样重复一遍 URI。首启必然命中，二次启动因文件已在反而正常。
// 这里用「没写过就抛 ENOENT」的假 storage 复现那个前置条件。
// ════════════════════════════════════════════════════════════

const ABS = '/tmp/aalis-test-root/webui/access.txt';
const ACCESS_URI = 'data:/webui/access.txt';
const TOKEN_URI = 'data:/webui/token';

/**
 * existing：事先就有的文件与内容。held：写这些文件时等对应的 Promise 兑现才落定，别的写入过 5ms 落定。
 * writing 是此刻还没落定的写入
 */
function makeFakeStorage(
  opts: { failWrite?: boolean; existing?: Record<string, string>; held?: Record<string, Promise<void>> } = {},
): StorageService & { written: Set<string>; writing: Set<string> } {
  const written = new Set<string>();
  const writing = new Set<string>();
  const roots: StorageRootInfo[] = [
    {
      name: 'data',
      label: 'Data',
      kind: 'data',
      browsable: false,
      readable: true,
      writable: true,
      deletable: true,
    } as unknown as StorageRootInfo,
  ];
  const svc = {
    written,
    writing,
    listRoots: () => roots,
    async writeFile(uri: string) {
      // 真实 storage 写盘要跨若干次事件循环才落地。这里必须同样推迟：写入若在调用时
      // 同步完成，就复现不出「解析绝对路径时文件还不存在」这个前提，测试会恒绿。
      writing.add(uri);
      try {
        await (opts.held?.[uri] ?? new Promise(r => setTimeout(r, 5)));
        if (opts.failWrite) throw new Error('EACCES: permission denied');
        written.add(uri);
      } finally {
        writing.delete(uri);
      }
    },
    async readFile(uri: string) {
      if (opts.existing?.[uri] !== undefined) return opts.existing[uri];
      if (!written.has(uri)) throw new Error(`ENOENT: ${uri}`);
      return '';
    },
    async resolveLocalPath(uri: string, access: 'read' | 'write' | 'delete' = 'read') {
      // 忠实于 storage-local：'read'/'delete' 走 resolveExisting（realpath，文件不存在即抛
      // ENOENT，这正是竞态前提）；'write' 走 resolveForWrite，不要求文件已存在、不会抛。
      // 假实现若不分流，把调用改成 'write' 这类变异就察觉不到。
      if (access !== 'write' && !written.has(uri)) {
        throw new Error(`ENOENT: no such file, realpath '${uri}'`);
      }
      return ABS;
    },
    async list() {
      return { entries: [] };
    },
    async stat() {
      throw new Error('未实现');
    },
    async delete() {
      throw new Error('未实现');
    },
    async mkdir() {
      /* noop */
    },
  } as unknown as StorageService & { written: Set<string>; writing: Set<string> };
  return svc;
}

function makeCapturingLogger(lines: string[]): Logger {
  const push =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(`${level} ${args.map(a => String(a)).join(' ')}`);
    };
  const l: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => l,
  } as unknown as Logger;
  return l;
}

const apps: App[] = [];

afterEach(async () => {
  // 逐个 try/finally：任一 stop 抛错也不能让后面的实例漏掉（数组已 splice，漏了就永久泄漏）
  for (const a of apps.splice(0)) {
    try {
      await a.stop();
    } catch {
      /* 停不掉也要继续停下一个 */
    }
  }
});

describe('webui-server 启动日志里的 access.txt 绝对路径', () => {
  it('首启（文件此前不存在）也给出真绝对路径，而不是把 URI 重复一遍', async () => {
    const lines: string[] = [];
    const app = new App({
      name: 'T',
      logLevel: 'debug',
      logger: makeCapturingLogger(lines),
    });
    apps.push(app);
    app.bind({ provide }).provide.use(storage, makeFakeStorage());
    await app.plugins.register(webuiServer, {
      port: 0,
      host: '127.0.0.1',
      autoOpen: false,
      tokenMode: 'ephemeral',
    });
    await app.plugins.idle();
    await app.start();

    // listen 回调里的日志是异步落的，轮询等它出现
    let line: string | undefined;
    for (let i = 0; i < 100 && !line; i++) {
      line = lines.find(l => l.includes('访问凭据已写入'));
      if (!line) await new Promise(r => setTimeout(r, 20));
    }

    expect(line, '应打出访问凭据行').toBeDefined();
    expect(line).toContain(`绝对路径: ${ABS}`);
    expect(line, '退化成重复 URI 就是竞态回归了').not.toContain('绝对路径: data:/webui/access.txt');
  });

  it('插件 dispose 时关闭已建立的 WebSocket 连接', async () => {
    // ws 的 close() 在 {server} 模式下只摘监听器、对 this.clients 一个都不动，
    // server.close() 也只停止 accept。不主动关的话，禁用/热重载后旧 socket 仍然活着，
    // 还能替一次已关闭的激活收发帧。
    //
    // 这里不引 ws 客户端（它是 webui-server 的私有依赖，test/ 下既解析不到也没有类型），
    // 直接用 node:http 做升级握手拿到裸 socket，再断言服务端发来了 close 帧（opcode 0x8）。
    // 预取空闲端口：webui-server 打日志用的是配置值，port:0 时拿不到真实端口。
    const port = await freePort();
    const token = 'test-fixed-token-placeholder-0000';
    const app = new App({
      name: 'T',
      logLevel: 'error',
      logger: makeCapturingLogger([]),
    });
    apps.push(app);
    app.bind({ provide }).provide.use(storage, makeFakeStorage());
    await app.plugins.register(webuiServer, {
      port,
      host: '127.0.0.1',
      autoOpen: false,
      tokenMode: 'fixed',
      fixedToken: token,
    });
    await app.plugins.idle();
    await app.start();

    const req = request({
      host: '127.0.0.1',
      port,
      path: '/admin',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        'Sec-WebSocket-Version': '13',
        // 升级请求的登录判定只认 cookie（auth.verifyWsClient）
        Cookie: `aalis_webui_token=${token}`,
      },
    });
    const socket = await new Promise<Socket>((resolve, reject) => {
      req.on('upgrade', (_res, sock) => resolve(sock as Socket));
      req.on('response', res => reject(new Error(`升级被拒: ${res.statusCode}`)));
      req.on('error', reject);
      setTimeout(() => reject(new Error('升级握手超时')), 5000).unref?.();
      req.end();
    });

    const gotCloseFrame = new Promise<boolean>(resolve => {
      socket.on('data', (buf: Buffer) => {
        // 帧首字节低 4 位是 opcode，0x8 = close
        if (buf.length > 0 && (buf[0] & 0x0f) === 0x8) resolve(true);
      });
      setTimeout(() => resolve(false), 4000).unref?.();
    });

    await app.stop();
    apps.length = 0; // 已 stop，afterEach 不必再停

    expect(await gotCloseFrame, '拆卸后旧连接必须被关掉，否则它还能驱动一次已关闭的激活').toBe(true);
    socket.destroy();
  });
  it('写入失败时不宣称「已写入」，而是指路手工登录', async () => {
    const lines: string[] = [];
    const app = new App({
      name: 'T',
      logLevel: 'debug',
      logger: makeCapturingLogger(lines),
    });
    apps.push(app);
    app.bind({ provide }).provide.use(storage, makeFakeStorage({ failWrite: true }));
    await app.plugins.register(webuiServer, {
      port: 0,
      host: '127.0.0.1',
      autoOpen: false,
      tokenMode: 'ephemeral',
    });
    await app.plugins.idle();
    await app.start();

    let failLine: string | undefined;
    for (let i = 0; i < 100 && !failLine; i++) {
      failLine = lines.find(l => l.includes('访问凭据未能写入'));
      if (!failLine) await new Promise(r => setTimeout(r, 20));
    }

    expect(failLine, '写失败要明确说没写成，并给出替代办法').toBeDefined();
    // 每次启动随机的 token 不落在别处：登录页手工粘贴无从粘起，得给能做到的修法
    expect(failLine).toContain('修好家目录 state/webui/ 的写权限后重启');
    expect(failLine).toContain('把 tokenMode 设为 fixed、在 fixedToken 里填一个至少 32 个字符的 token');
    expect(
      lines.some(l => l.includes('访问凭据已写入')),
      '写失败还说「已写入」会让人去找一个不存在的文件',
    ).toBe(false);
  });
});

// 停机、停用或重载返回之后，本实例自己发起的写盘（没有请求在等它）不能还在途：不然它落在已清理的家目录里（测试清理临时目录时
// 报 ENOTEMPTY），或在接手的实例写下 access.txt 之后才落地、把它盖成旧实例的 token
describe('停机等本实例自己发起的写盘落定', () => {
  /** 在途的写入停在这里，open() 之后再过 100ms 才落定：stop 不等它的话早已返回 */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>(resolve => {
      open = () => setTimeout(resolve, 100);
    });
    return { opened, open };
  }

  /** 起本插件并等到监听之后（access.txt 此时已开始写）；不给 initial 时本插件在没有存储的情况下起来，存储由用例之后再提供 */
  async function start(tokenMode: 'ephemeral' | 'persist', initial?: StorageService) {
    const app = new App({ name: 'T', logLevel: 'error', logger: makeCapturingLogger([]) });
    apps.push(app);
    if (initial) app.bind({ provide }).provide.use(storage, initial);
    const port = await freePort();
    await app.plugins.register(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode });
    await app.plugins.idle();
    await app.start();
    await waitListening(port);
    return app;
  }

  it('监听之后写 access.txt 途中停机：stop 返回时这次写入已落定', async () => {
    const write = gate();
    const fake = makeFakeStorage({ held: { [ACCESS_URI]: write.opened } });
    const app = await start('ephemeral', fake);
    expect([...fake.writing]).toEqual([ACCESS_URI]);
    const stopped = app.stop();
    write.open();
    await stopped;
    expect([...fake.writing]).toEqual([]);
    expect(fake.written).toContain(ACCESS_URI);
  });

  it('storage 晚于本插件上线、读回 token 后重写 access.txt 途中停机：stop 返回时读回引起的写入都已落定', async () => {
    const write = gate();
    const fake = makeFakeStorage({
      existing: { [TOKEN_URI]: 'zz-persisted-token-placeholder' },
      held: { [ACCESS_URI]: write.opened },
    });
    const app = await start('persist');
    // 读回的 token 与内存里的不同：按它重写 access.txt，再按凭据重写 token 文件
    app.bind({ provide }).provide.use(storage, fake);
    await vi.waitFor(() => expect([...fake.writing]).toEqual([ACCESS_URI]));
    const stopped = app.stop();
    write.open();
    await stopped;
    expect([...fake.writing]).toEqual([]);
    expect([...fake.written].sort()).toEqual([ACCESS_URI, TOKEN_URI]);
  });
});
