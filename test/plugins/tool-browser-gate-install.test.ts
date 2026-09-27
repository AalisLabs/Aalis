import { promises as dns } from 'node:dns';
import { createServer as createHttpServer } from 'node:http';
import { type AddressInfo, connect, Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, type AppOptions, LogHub, provide } from '../../packages/core/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';

// ════════════════════════════════════════════════════════════
// 浏览器的启动：
// - 网络闸先于浏览器起好；闸起不来（监听失败）就不启动浏览器，报闸的错误，下次调用重新尝试。
//   「请确保已安装 Chrome」的提示只跟在浏览器本身启动失败后面，闸的错误与 Chrome 装没装无关。
// - 并发的首次调用共用同一次启动；启动途中插件被停用时，这一代浏览器由启动方自己关掉（不等关闭落定），调用报错。
// - 浏览器崩溃后重启沿用同一道闸，不另起监听。
// - 只有起了闸（blockPrivate=true）时，browser_navigate 才给 ERR_SOCKS_CONNECTION_FAILED 附拦截说明。
// - 浏览器先断开时，闸里还在解析或连接的上游随之销毁。
// - 插件停用时，闸里已接通的连接随之断开，停用不等它们自己结束；闸的关闭不等浏览器关闭落定。
// - 闸只收规范写法的 IPv6 字面量；问候与请求限时收齐；与请求同包到达的数据接通后交给上游。
// - 闸按进程级网络策略的 allowedPorts 判定端口，allowedHosts 里的主机也不例外；回失败应答后随即关闭连接。
// puppeteer 换成替身（根目录不直接依赖 puppeteer，按插件自己的依赖路径 mock），不启动真浏览器；
// 闸是真的 SOCKS 服务，只监听 127.0.0.1，替身浏览器不经它发任何请求；直连闸的用例只连测试自己在 127.0.0.1 起的服务，
// 要解析的域名由 DNS 替身作答。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

const fake = vi.hoisted(() => {
  const instances: { closed: boolean }[] = [];
  const goto = vi.fn(async () => {});
  /** 替身浏览器 close() 的结果：默认立即落定，用例可换成挂住或失败 */
  const closeResult = vi.fn(async () => {});
  const launch = vi.fn(async () => {
    const state = { closed: false };
    instances.push(state);
    await new Promise(r => setTimeout(r, 200));
    const page = {
      setDefaultTimeout: () => {},
      goto,
      url: () => 'http://example.zz-test/',
      title: async () => 'zz',
      evaluate: async () => 'zz-body',
      close: async () => {},
    };
    return {
      get connected() {
        return !state.closed;
      },
      on: () => {},
      close: () => {
        state.closed = true;
        return closeResult();
      },
      newPage: async () => page,
    };
  });
  return { launch, goto, closeResult, instances };
});
vi.mock('../../packages/plugin-tool-browser/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', () => ({
  default: { launch: fake.launch },
  launch: fake.launch,
}));

/** 闸的监听：记下插件建的每个服务；failListen 为真时 listen 以错误告终，listenDelayMs 推迟监听 */
const gateNet = vi.hoisted(() => ({ failListen: false, listenDelayMs: 0, servers: [] as Server[] }));
vi.mock('node:net', async importOriginal => {
  const actual = await importOriginal<typeof import('node:net')>();
  const createServer = ((...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args);
    gateNet.servers.push(server);
    const listen = server.listen.bind(server) as (...a: unknown[]) => Server;
    server.listen = ((...a: unknown[]) => {
      if (gateNet.failListen) process.nextTick(() => server.emit('error', new Error('zz-listen 失败')));
      else setTimeout(() => listen(...a), gateNet.listenDelayMs);
      return server;
    }) as never;
    return server;
  }) as typeof actual.createServer;
  return { ...actual, createServer, default: { ...actual, createServer } };
});

afterEach(() => {
  vi.restoreAllMocks();
  fake.launch.mockClear();
  fake.instances.length = 0;
  gateNet.failListen = false;
  gateNet.listenDelayMs = 0;
  gateNet.servers.length = 0;
});

async function startBrowserTools(
  blockPrivate = true,
  appOptions: AppOptions = {},
  allowedHosts: string[] = [],
): Promise<{ app: App; handlers: Record<string, Handler> }> {
  const app = new App({ name: 'T', logLevel: 'error', ...appOptions });
  const host = app.bind({ provide });
  const handlers: Record<string, Handler> = {};
  host.provide(tools, {
    register: (t: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide(webuiServer, { registerPage: () => () => {}, registerAction: () => () => {} } as never);
  // executablePath 非空：跳过「Chrome 未安装就自动下载」那一步
  await app.plugins.register(browserPlugin, { blockPrivate, allowedHosts, executablePath: '/zz-fake-chrome' });
  await app.plugins.idle();
  return { app, handlers };
}

async function navigate(handlers: Record<string, Handler>): Promise<{ error?: string; pageId?: string }> {
  return JSON.parse(
    (await handlers.browser_navigate({ url: 'http://example.zz-test/' }, { sessionId: 's' })) as string,
  );
}

/** 闸的端口：从首次 launch 的 --proxy-server 参数里取 */
function gatePort(): number {
  const args = (fake.launch.mock.calls[0] as unknown as [{ args: string[] }])[0].args.join(' ');
  return Number(/--proxy-server=socks5:\/\/127\.0\.0\.1:(\d+)/.exec(args)?.[1]);
}

/** CONNECT 请求：域名形式的目标（浏览器对 IP 字面量也这样交出） */
function connectRequest(host: string, port: number): Buffer {
  const name = Buffer.from(host, 'latin1');
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBytes]);
}

/**
 * 按浏览器的做法对闸走一遍 SOCKS5：问候（无认证）→ CONNECT，返回应答里的 REP（0 为接通）与这条连接。
 * allowHalfOpen 为真时，收到闸的 FIN 后本端不跟着关写端
 */
async function socksConnect(
  host: string,
  port: number,
  allowHalfOpen = false,
): Promise<{ rep: number; socket: Socket }> {
  const socket = connect({ host: '127.0.0.1', port: gatePort(), allowHalfOpen });
  await new Promise<void>(resolve => socket.once('connect', resolve));
  socket.write(Buffer.from([5, 1, 0]));
  await new Promise<void>(resolve => socket.once('data', () => resolve()));
  socket.write(connectRequest(host, port));
  const reply = await new Promise<Buffer>(resolve => socket.once('data', resolve));
  return { rep: reply[1], socket };
}

/** 闸这一侧还开着的连接数（连接完全关闭才减一，半开的也算） */
function openConnections(server: Server): Promise<number> {
  return new Promise((resolve, reject) => server.getConnections((err, n) => (err ? reject(err) : resolve(n))));
}

describe('网络闸起不来', () => {
  it('不启动浏览器，报闸的错误、不附安装 Chrome 的提示；下次调用重新起闸', async () => {
    const { app, handlers } = await startBrowserTools();
    try {
      gateNet.failListen = true;
      const first = await navigate(handlers);
      expect(first.error).toContain('浏览器网络闸启动失败');
      expect(first.error).toContain('zz-listen 失败');
      expect(first.error).not.toContain('请确保已安装 Chrome');
      expect(fake.launch).not.toHaveBeenCalled();

      gateNet.failListen = false;
      const second = await navigate(handlers);
      expect(second.error).toBeUndefined();
      expect(fake.launch).toHaveBeenCalledTimes(1);
      expect(fake.launch.mock.calls[0]).toEqual([
        expect.objectContaining({
          args: expect.arrayContaining([expect.stringMatching(/^--proxy-server=socks5:\/\/127\.0\.0\.1:\d+$/)]),
        }),
      ]);
    } finally {
      await app.stop();
    }
  });
});

describe('浏览器本身启动失败', () => {
  it('报启动失败并附安装 Chrome 的提示', async () => {
    const { app, handlers } = await startBrowserTools();
    try {
      fake.launch.mockRejectedValueOnce(new Error('zz-launch 失败'));
      const out = await navigate(handlers);
      expect(out.error).toContain('zz-launch 失败');
      expect(out.error).toContain('请确保已安装 Chrome');
    } finally {
      await app.stop();
    }
  });
});

describe('启动单飞与停用', () => {
  it('并发的首次调用只启动一个浏览器；停用后浏览器与闸都已关闭', async () => {
    const { app, handlers } = await startBrowserTools();
    const [a, b] = await Promise.all([navigate(handlers), navigate(handlers)]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(fake.launch).toHaveBeenCalledTimes(1);
    await app.stop();
    expect(fake.instances).toEqual([{ closed: true }]);
    expect(gateNet.servers.map(s => s.listening)).toEqual([false]);
  });

  it('启动途中停用：调用报错，这一代浏览器被关掉；停用后到达的调用不再起闸与浏览器', async () => {
    const { app, handlers } = await startBrowserTools();
    // 停用落在闸还没监听上的时候：收尾要等这次启动落定，才关得到随后才起好的闸
    gateNet.listenDelayMs = 100;
    const pending = navigate(handlers);
    await new Promise(r => setTimeout(r, 20));
    await app.stop();
    expect((await pending).error).toContain('浏览器工具已停用');
    expect(fake.instances).toEqual([{ closed: true }]);

    const late = await navigate(handlers);
    expect(late.error).toContain('浏览器工具已停用');
    expect(fake.launch).toHaveBeenCalledTimes(1);
    expect(gateNet.servers.map(s => s.listening)).toEqual([false]);
  });
});

describe('停用时浏览器关闭挂住或失败', () => {
  it('已交出的浏览器关闭挂住：闸照样关闭', async () => {
    const { app, handlers } = await startBrowserTools(true, { disposeTimeoutMs: 300 });
    expect((await navigate(handlers)).error).toBeUndefined();
    fake.closeResult.mockReturnValueOnce(new Promise<void>(() => {}));
    await app.stop();
    expect(fake.instances).toEqual([{ closed: true }]);
    expect(gateNet.servers.map(s => s.listening)).toEqual([false]);
  });

  it('启动途中停用、关闭这一代浏览器挂住：闸照样关闭，调用报「浏览器工具已停用」', async () => {
    const { app, handlers } = await startBrowserTools(true, { disposeTimeoutMs: 2_000 });
    fake.closeResult.mockReturnValueOnce(new Promise<void>(() => {}));
    const pending = navigate(handlers);
    await new Promise(r => setTimeout(r, 20));
    await app.stop();
    expect(fake.instances).toEqual([{ closed: true }]);
    expect(gateNet.servers.map(s => s.listening)).toEqual([false]);
    expect((await pending).error).toContain('浏览器工具已停用');
  });

  it('启动途中停用、关闭这一代浏览器失败：调用仍报「浏览器工具已停用」，关闭失败记 warn', async () => {
    const hub = new LogHub();
    const warns: string[] = [];
    hub.onEntry(entry => {
      if (entry.level === 'warn') warns.push(entry.message);
    });
    const { app, handlers } = await startBrowserTools(true, { logLevel: 'warn', logHub: hub });
    fake.closeResult.mockRejectedValueOnce(new Error('zz-close 失败'));
    const pending = navigate(handlers);
    await new Promise(r => setTimeout(r, 20));
    await app.stop();
    expect((await pending).error).toBe('浏览器工具已停用');
    expect(warns).toContainEqual(expect.stringContaining('停用时关闭新启动的浏览器失败: zz-close 失败'));
  });
});

describe('浏览器崩溃后重启', () => {
  it('沿用同一道闸：两次启动的代理端口相同，只建过一个服务，停用后它已关闭', async () => {
    const { app, handlers } = await startBrowserTools();
    expect((await navigate(handlers)).error).toBeUndefined();
    fake.instances[0].closed = true;
    expect((await navigate(handlers)).error).toBeUndefined();
    expect(fake.launch).toHaveBeenCalledTimes(2);
    const ports = (fake.launch.mock.calls as unknown as [{ args: string[] }][]).map(([opts]) =>
      opts.args.find(a => a.startsWith('--proxy-server=')),
    );
    expect(ports[0]).toMatch(/^--proxy-server=socks5:\/\/127\.0\.0\.1:\d+$/);
    expect(ports[1]).toBe(ports[0]);
    expect(gateNet.servers).toHaveLength(1);
    await app.stop();
    expect(gateNet.servers[0].listening).toBe(false);
  });
});

describe('browser_navigate 的拦截说明', () => {
  it('blockPrivate=false 时不起闸，ERR_SOCKS_CONNECTION_FAILED（如系统 SOCKS 代理连不上）原样返回', async () => {
    const { app, handlers } = await startBrowserTools(false);
    try {
      const msg = 'net::ERR_SOCKS_CONNECTION_FAILED at http://example.zz-test/';
      fake.goto.mockRejectedValueOnce(new Error(msg));
      expect((await navigate(handlers)).error).toBe(msg);
      expect(gateNet.servers).toHaveLength(0);
    } finally {
      await app.stop();
    }
  });
});

describe('网络闸：浏览器先断开时', () => {
  it('还在解析的上游随之销毁，迟到的解析结果不再连出去', async () => {
    let connections = 0;
    const target = createHttpServer();
    target.on('connection', socket => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    let answer!: (records: { address: string; family: number }[]) => void;
    const resolved = new Promise<{ address: string; family: number }[]>(resolve => {
      answer = resolve;
    });
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation((() => resolved) as never);
    setNetworkPolicy({ blockPrivate: false });
    const { app, handlers } = await startBrowserTools();
    try {
      expect((await navigate(handlers)).error).toBeUndefined();

      // 按浏览器的做法走一遍 SOCKS5：问候（无认证）→ CONNECT 域名形式的目标
      const client = connect({ host: '127.0.0.1', port: gatePort() });
      await new Promise<void>(resolve => client.once('connect', resolve));
      client.write(Buffer.from([5, 1, 0]));
      await new Promise<void>(resolve => client.once('data', () => resolve()));
      client.write(connectRequest('slow.zz-test', (target.address() as { port: number }).port));
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith('slow.zz-test', expect.anything()));

      client.destroy();
      await new Promise(r => setTimeout(r, 50));
      answer([{ address: '127.0.0.1', family: 4 }]);
      await new Promise(r => setTimeout(r, 200));
      expect(connections).toBe(0);
    } finally {
      setNetworkPolicy({});
      await app.stop();
      await new Promise<void>(resolve => target.close(() => resolve()));
    }
  });
});

describe('网络闸：插件停用时', () => {
  it('已接通的连接随之断开，停用不等它们自己结束', async () => {
    const target = createHttpServer();
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    setNetworkPolicy({ blockPrivate: false });
    const { app, handlers } = await startBrowserTools();
    let client: Socket | undefined;
    try {
      expect((await navigate(handlers)).error).toBeUndefined();

      // 走一遍 SOCKS5 连到测试服务，等到接通应答
      const { rep, socket } = await socksConnect('127.0.0.1', (target.address() as { port: number }).port);
      client = socket;
      expect(rep).toBe(0);

      const closed = new Promise<'closed'>(resolve => socket.once('close', () => resolve('closed')));
      const started = Date.now();
      await app.stop();
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await Promise.race([closed, new Promise(r => setTimeout(r, 500, 'open'))])).toBe('closed');
    } finally {
      setNetworkPolicy({});
      client?.destroy();
      await app.stop();
      await new Promise<void>(resolve => target.close(() => resolve()));
    }
  });
});

describe('网络闸：IP 字面量', () => {
  it('只收规范写法：非规范写法与带 zone id 的 IPv6 字面量回失败应答、不连出去，规范写法照常接通', async () => {
    let connections = 0;
    const target = createHttpServer();
    target.on('connection', () => connections++);
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const port = (target.address() as { port: number }).port;
    const hub = new LogHub();
    const debugs: string[] = [];
    hub.onEntry(entry => {
      if (entry.level === 'debug') debugs.push(entry.message);
    });
    // 策略放行私网：被拒只可能出自规范写法这一关。下面三种非规范写法都能连到 127.0.0.1（IPv4 映射）
    setNetworkPolicy({ blockPrivate: false });
    const { app, handlers } = await startBrowserTools(true, { logLevel: 'debug', logHub: hub });
    const sockets: Socket[] = [];
    try {
      expect((await navigate(handlers)).error).toBeUndefined();
      for (const host of ['0:0:0:0:0:ffff:127.0.0.1', '0::ffff:7f00:1', '::ffff:7f00:1%lo0']) {
        const { rep, socket } = await socksConnect(host, port);
        sockets.push(socket);
        expect(rep, host).toBe(1);
        expect(debugs, host).toContainEqual(expect.stringContaining(`IPv6 字面量不是规范写法: ${host}`));
      }
      expect(connections).toBe(0);

      const { rep, socket } = await socksConnect('::ffff:7f00:1', port);
      sockets.push(socket);
      expect(rep).toBe(0);
      await vi.waitFor(() => expect(connections).toBe(1));
    } finally {
      setNetworkPolicy({});
      for (const socket of sockets) socket.destroy();
      await app.stop();
      await new Promise<void>(resolve => target.close(() => resolve()));
    }
  });
});

describe('网络闸：进程级网络策略的 allowedPorts', () => {
  it('端口不在 allowedPorts 里时回失败应答、不连出去，allowedHosts 里的主机、IP 字面量与域名都一样；列表里的端口照常接通', async () => {
    const counts = new Map<number, number>();
    const targets = [createHttpServer(), createHttpServer()];
    for (const target of targets) {
      await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
      const port = (target.address() as AddressInfo).port;
      counts.set(port, 0);
      target.on('connection', () => counts.set(port, (counts.get(port) ?? 0) + 1));
    }
    const [allowed, denied] = targets.map(t => (t.address() as AddressInfo).port);
    vi.spyOn(dns, 'lookup').mockImplementation((async () => [{ address: '127.0.0.1', family: 4 }]) as never);
    const hub = new LogHub();
    const debugs: string[] = [];
    hub.onEntry(entry => {
      if (entry.level === 'debug') debugs.push(entry.message);
    });
    // 策略放行私网：被拒只可能出自端口这一关
    setNetworkPolicy({ blockPrivate: false, allowedPorts: [allowed] });
    const { app, handlers } = await startBrowserTools(true, { logLevel: 'debug', logHub: hub }, ['127.0.0.1']);
    const sockets: Socket[] = [];
    // 依次走 allowedHosts 直连、IP 字面量判定、域名经 pinnedLookup 三条路
    const hosts = ['127.0.0.1', '::ffff:7f00:1', 'target.zz-test'];
    try {
      expect((await navigate(handlers)).error).toBeUndefined();
      for (const host of hosts) {
        const { rep, socket } = await socksConnect(host, denied);
        sockets.push(socket);
        expect(rep, host).toBe(1);
        expect(debugs, host).toContainEqual(
          expect.stringContaining(`浏览器网络闸未接通 ${host}:${denied}: 拒绝访问端口 ${denied}`),
        );
      }
      for (const host of hosts) {
        const { rep, socket } = await socksConnect(host, allowed);
        sockets.push(socket);
        expect(rep, host).toBe(0);
      }
      await vi.waitFor(() => expect(counts.get(allowed)).toBe(3));
      expect(counts.get(denied)).toBe(0);
    } finally {
      setNetworkPolicy({});
      for (const socket of sockets) socket.destroy();
      await app.stop();
      for (const target of targets) await new Promise<void>(resolve => target.close(() => resolve()));
    }
  });
});

describe('网络闸：失败应答后关闭连接', () => {
  it('问候被拒与请求收齐后的失败应答，闸都随即关闭连接，不等对端关写端', async () => {
    const { app, handlers } = await startBrowserTools();
    const sockets: Socket[] = [];
    try {
      expect((await navigate(handlers)).error).toBeUndefined();
      const gate = gateNet.servers[0];

      // 请求收齐之后：默认策略拦回环，回失败应答；本端收到 FIN 后不关写端
      const { rep, socket } = await socksConnect('127.0.0.1', 80, true);
      sockets.push(socket);
      expect(rep).toBe(1);
      await vi.waitFor(async () => expect(await openConnections(gate)).toBe(0));

      // 请求收齐之前：问候只给用户名密码认证，闸回「无可接受的方法」
      const greeter = connect({ host: '127.0.0.1', port: gatePort(), allowHalfOpen: true });
      sockets.push(greeter);
      await new Promise<void>(resolve => greeter.once('connect', resolve));
      greeter.write(Buffer.from([5, 1, 2]));
      const reply = await new Promise<Buffer>(resolve => greeter.once('data', resolve));
      expect([...reply]).toEqual([5, 0xff]);
      await vi.waitFor(async () => expect(await openConnections(gate)).toBe(0));
    } finally {
      for (const socket of sockets) socket.destroy();
      await app.stop();
    }
  });
});

describe('网络闸：握手时限与同包数据', () => {
  /** 回显服务：收到什么就回什么，另记下收到的全部字节（直接用 Server 构造，不进闸的监听记录） */
  async function startEcho(): Promise<{ server: Server; port: number; received: () => string }> {
    const chunks: Buffer[] = [];
    const server = new Server(socket => {
      socket.on('data', chunk => chunks.push(chunk));
      socket.pipe(socket);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
      server,
      port: (server.address() as AddressInfo).port,
      received: () => Buffer.concat(chunks).toString(),
    };
  }

  it('问候与请求 10 秒内未收齐的连接被断开；请求收齐、接通后的连接不受这个时限约束', async () => {
    const echo = await startEcho();
    setNetworkPolicy({ blockPrivate: false });
    const { app, handlers } = await startBrowserTools();
    const sockets: Socket[] = [];
    const realSetTimeout = setTimeout;
    const realSleep = (ms: number) => new Promise(r => realSetTimeout(r, ms));
    try {
      expect((await navigate(handlers)).error).toBeUndefined();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      // 只问候、不发请求的连接：收到问候应答说明闸已开始计时
      const idle = connect({ host: '127.0.0.1', port: gatePort() });
      sockets.push(idle);
      await new Promise<void>(resolve => idle.once('connect', resolve));
      idle.write(Buffer.from([5, 1, 0]));
      await new Promise<void>(resolve => idle.once('data', () => resolve()));
      let idleClosed = false;
      idle.once('close', () => {
        idleClosed = true;
      });

      const { rep, socket: live } = await socksConnect('127.0.0.1', echo.port);
      sockets.push(live);
      expect(rep).toBe(0);

      vi.advanceTimersByTime(9_900);
      await realSleep(100);
      expect(idleClosed).toBe(false);
      vi.advanceTimersByTime(100);
      await vi.waitFor(() => expect(idleClosed).toBe(true));

      live.write('zz-ping');
      await vi.waitFor(() => expect(echo.received()).toBe('zz-ping'));
      expect(live.destroyed).toBe(false);
    } finally {
      vi.useRealTimers();
      setNetworkPolicy({});
      for (const socket of sockets) socket.destroy();
      await app.stop();
      await new Promise<void>(resolve => echo.server.close(() => resolve()));
    }
  });

  it('握手没收齐就断开的连接，闸随之清掉它的握手定时器', async () => {
    const { app, handlers } = await startBrowserTools();
    let client: Socket | undefined;
    try {
      expect((await navigate(handlers)).error).toBeUndefined();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const socket = connect({ host: '127.0.0.1', port: gatePort() });
      client = socket;
      await new Promise<void>(resolve => socket.once('connect', resolve));
      socket.write(Buffer.from([5, 1, 0]));
      await new Promise<void>(resolve => socket.once('data', () => resolve()));
      expect(vi.getTimerCount()).toBe(1);

      socket.destroy();
      await vi.waitFor(async () => expect(await openConnections(gateNet.servers[0])).toBe(0));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      client?.destroy();
      await app.stop();
    }
  });

  it('与 CONNECT 请求同包到达的数据在接通后交给上游', async () => {
    const echo = await startEcho();
    setNetworkPolicy({ blockPrivate: false });
    const { app, handlers } = await startBrowserTools();
    let client: Socket | undefined;
    try {
      expect((await navigate(handlers)).error).toBeUndefined();
      const socket = connect({ host: '127.0.0.1', port: gatePort() });
      client = socket;
      await new Promise<void>(resolve => socket.once('connect', resolve));
      // 问候、请求与首段数据一次写出
      socket.write(
        Buffer.concat([Buffer.from([5, 1, 0]), connectRequest('127.0.0.1', echo.port), Buffer.from('zz-early')]),
      );
      await vi.waitFor(() => expect(echo.received()).toBe('zz-early'));
    } finally {
      setNetworkPolicy({});
      client?.destroy();
      await app.stop();
      await new Promise<void>(resolve => echo.server.close(() => resolve()));
    }
  });
});
