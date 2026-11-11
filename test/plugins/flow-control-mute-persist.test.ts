import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FlowControlService, flowControl } from '../../packages/api-flow-control/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, lifecycle, optional, provide, services } from '../../packages/core/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-storage.js';

// ════════════════════════════════════════════════════════════
// 禁言表持久化：storage 是 required，激活时读回整表，禁言改动整表写回；storage 下线时本插件随之停下，重新上线后重新读回。
// 真 storage-local 多根（用户根 workspace 在前、内部根 data 在后，映射到数据目录的 state/），禁言表落在 data 根。
// ════════════════════════════════════════════════════════════

const MUTES = 'flow-control-mutes.json';

describe('flow-control 禁言表持久化', () => {
  let base: string;
  let app: App;

  const storageLocal = () => ({
    definition: storageLocalPlugin,
    config: {
      roots: ['workspace'].map(name => ({
        name,
        path: join(base, name),
        label: name,
        kind: name,
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      })),
    },
  });

  const readMutes = (): Record<string, { mutedUntil: number }> =>
    JSON.parse(readFileSync(join(base, 'state', MUTES), 'utf-8'));

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-flow-mute-'));
    mkdirSync(join(base, 'state'), { recursive: true });
    mkdirSync(join(base, 'workspace'), { recursive: true });
  });

  afterEach(async () => {
    await app?.stop();
    rmSync(base, { recursive: true, force: true });
  });

  const svcOf = (): FlowControlService => {
    const svc = app.bind({ services }).services.use.get(flowControl);
    if (!svc) throw new Error('flow-control 服务未注册');
    return svc;
  };

  /** 登记了 data 根的 storage 实例：用例替换它的 writeFile 来控制写盘的快慢 */
  const dataRootOf = () => {
    const root = app
      .bind({ services })
      .services.use.all(storage)
      .map(view => view.instance)
      .find(instance => instance.listRoots().some(r => r.name === 'data'));
    if (!root) throw new Error('data 根未登记');
    return root;
  };

  const URI = `data:/${MUTES}`;
  /** 内存 storage，禁言表初始为空表：hold 写时阻塞，entered 通知写已到达 */
  const provider = () => {
    const mem = memoryStorage({ [URI]: '{}' });
    const hold = { write: undefined as Promise<void> | undefined };
    const entered = { write: () => {} };
    const service = {
      ...mem.service,
      async writeFile(uri: string, data: string | Buffer) {
        if (hold.write) {
          entered.write();
          await hold.write;
        }
        return mem.service.writeFile(uri, data);
      },
    };
    return { service, files: mem.files, hold, entered };
  };
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>(r => (open = r));
    return { promise, open };
  };

  it('storage 先上线：apply 返回时禁言表已读回，激活后立即可判禁言', async () => {
    writeFileSync(
      join(base, 'state', MUTES),
      JSON.stringify({ 'zz-old': { platform: 'onebot', mutedUntil: Date.now() + 3600_000 } }),
    );

    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.pluginAll([storageLocal()]);
    await app.plugins.idle();
    await app.pluginAll([
      { definition: gatewayPlugin, config: {} },
      { definition: flowControlPlugin, config: {} },
    ]);
    await app.plugins.idle();
    expect(svcOf().isMuted('zz-old')).toBe(true);
  });

  it('storage 下线：本插件随之停下、不再提供服务；重新上线后重新激活，从文件读回禁言', async () => {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.pluginAll([storageLocal(), { definition: gatewayPlugin, config: {} }]);
    await app.plugin(flowControlPlugin, {});
    await app.plugins.idle();
    svcOf().setMuted('zz-a', 600, 'onebot');

    await app.plugins.disable('@aalis/plugin-storage-local');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('@aalis/plugin-flow-control')?.state).toBe('pending');
    expect(app.bind({ services }).services.use.get(flowControl), 'storage 下线后流控仍在提供服务').toBeUndefined();

    await app.plugins.enable('@aalis/plugin-storage-local');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('@aalis/plugin-flow-control')?.state).toBe('active');
    expect(svcOf().isMuted('zz-a'), '重新激活后没有从文件读回禁言').toBe(true);
  });

  it('拆卸时仍有写在排队：等写链落完，磁盘保留全部会话', async () => {
    writeFileSync(
      join(base, 'state', MUTES),
      JSON.stringify({ 'zz-old': { platform: 'onebot', mutedUntil: Date.now() + 3600_000 } }),
    );

    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.pluginAll([storageLocal(), { definition: gatewayPlugin, config: {} }]);
    await app.plugin(flowControlPlugin, {});
    await app.plugins.idle();
    const svc = svcOf();
    // 让 data 根的第一次写变慢，第二次写就排在写链上
    const dataRoot = dataRootOf();
    const write = dataRoot.writeFile.bind(dataRoot);
    let delayed = false;
    dataRoot.writeFile = async (...args: Parameters<typeof write>) => {
      if (!delayed) {
        delayed = true;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return write(...args);
    };

    svc.setMuted('zz-a', 600, 'onebot');
    svc.setMuted('zz-b', 600, 'onebot');
    await app.plugins.unload('@aalis/plugin-flow-control');
    expect(Object.keys(readMutes()).sort()).toEqual(['zz-a', 'zz-b', 'zz-old']);
  });

  // 宿主（根激活）用着 flow-control 时，根的收尾排在它关闭之前：flow-control 收尾完之后、撤回之前的空档里，先登记的插件照
  // 自然次序收尾，经 services 现查到它调 setMuted，这笔写排在收尾的等待之后。清理也要等它落完（storage 等本插件关完才收尾）
  it('收尾之后、撤回之前才排上的写：清理等它落完，停机返回时已写进 storage', async () => {
    const p = provider();
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(
      definePlugin({
        name: 'zz-late-caller',
        uses: { services, lifecycle },
        apply({ services, lifecycle }) {
          lifecycle.use.onDrain(() => {
            services.use.get(flowControl)?.setMuted('zz-late', 600, 'onebot');
          });
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'zz-storage',
        provides: [storage],
        uses: { provide },
        apply({ provide }) {
          provide.use(storage, p.service as never);
        },
      }),
    );
    await app.pluginAll([
      { definition: gatewayPlugin, config: {} },
      { definition: flowControlPlugin, config: {} },
    ]);
    await app.plugins.idle();
    app.bind({ fc: flowControl });

    const g = gate();
    p.hold.write = g.promise;
    const entered = new Promise<void>(r => (p.entered.write = r));
    let stopped = false;
    const stopping = app.stop().then(() => {
      stopped = true;
    });
    await entered;
    for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
    expect(stopped, '这笔写还没落定，停机就返回了').toBe(false);
    g.open();
    await stopping;
    expect(Object.keys(JSON.parse(p.files.get(URI) ?? '{}'))).toEqual(['zz-late']);
  });

  // storage 的提供者经 optional 依赖又用到 flow-control（如 optional 用 storage 与 flow-control 的平台适配器）时两者成环：
  // 关停只放行被 optional 边挡着的收尾，flow-control 经 required 边照样整个关完 storage 才收尾
  it('storage 提供者与 flow-control 经 optional 依赖成环：停机前排着的禁言照样写进 storage', async () => {
    const p = provider();
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(flowControlPlugin, {});
    await app.plugin(
      definePlugin({
        name: 'zz-storage-cycle',
        provides: [storage],
        uses: { provide, flow: optional(flowControl) },
        apply(caps) {
          caps.provide.use(storage, p.service as never);
        },
      }),
    );
    await app.plugins.idle();
    const svc = svcOf();
    const write = gate();
    const entered = gate();
    p.hold.write = write.promise;
    p.entered.write = entered.open;
    svc.setMuted('zz-a', 600, 'onebot');
    await entered.promise; // 第一笔写在飞，第二笔排在写链上
    svc.setMuted('zz-b', 600, 'onebot');

    const stopping = app.stop();
    // 关停只在 Promise 上推进（core 的定时器只作时限）：让出一轮宏任务，微任务清空时它已推进到等这笔写盘的那一步
    await new Promise(resolve => setImmediate(resolve));
    write.open();
    await stopping;
    expect(Object.keys(JSON.parse(p.files.get(URI) ?? '{}')).sort()).toEqual(['zz-a', 'zz-b']);
  });

  it('按字母序整批登记（flow-control 先于 storage-local）：禁言能恢复，setMuted 后磁盘保留原有会话', async () => {
    const until = Date.now() + 3600_000;
    writeFileSync(join(base, 'state', MUTES), JSON.stringify({ 'zz-old': { platform: 'onebot', mutedUntil: until } }));

    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.pluginAll([
      { definition: flowControlPlugin, config: {} },
      { definition: gatewayPlugin, config: {} },
      storageLocal(),
    ]);
    await app.plugins.idle();
    const svc = svcOf();

    expect(svc.isMuted('zz-old')).toBe(true);

    svc.setMuted('zz-new', 600, 'onebot');
    await expect.poll(() => Object.keys(readMutes()).sort(), { timeout: 2000 }).toEqual(['zz-new', 'zz-old']);
    expect(readMutes()['zz-old'].mutedUntil).toBe(until);
  });

  // ════════════════════════════════════════════════════════════
  // 禁言表读不懂（不是「文件不存在」的读失败、坏 JSON、结构不对）曾被当成空表，
  // 下一次 setMuted 整表写回，原有禁言全丢——被禁言的群重启后静默解禁。
  // 契约：只有文件不存在算全新；其它失败本次运行拒写，原文件一字不动。
  // ════════════════════════════════════════════════════════════
  describe('禁言表读失败不回写', () => {
    /** 被拒的写不会有任何可等的信号：给一次本地落盘足够的时间再读 */
    const settle = () => new Promise(r => setTimeout(r, 150));
    const mutesPath = () => join(base, 'state', MUTES);
    const bootStorageFirst = async () => {
      app = new App({ name: 'T', logLevel: 'error' });
      await registerHubs(app);
      provideHostPaths(app, base);
      await app.pluginAll([
        storageLocal(),
        { definition: gatewayPlugin, config: {} },
        { definition: flowControlPlugin, config: {} },
      ]);
      await app.plugins.idle();
    };

    it.each([
      ['截断 JSON', '{"zz-old":{"platform":"onebot","mutedUntil":9999999999999'],
      ['null', 'null'],
      ['数组', '[]'],
    ])('%s：setMuted 不覆盖原文件', async (_label, seeded) => {
      writeFileSync(mutesPath(), seeded);
      await bootStorageFirst();

      svcOf().setMuted('zz-new', 600, 'onebot');
      await settle();

      expect(readFileSync(mutesPath(), 'utf-8')).toBe(seeded);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      '文件读不出（EACCES）：setMuted 不覆盖原文件',
      async () => {
        const seeded = JSON.stringify({ 'zz-old': { platform: 'onebot', mutedUntil: Date.now() + 3600_000 } });
        writeFileSync(mutesPath(), seeded);
        chmodSync(mutesPath(), 0o000);
        try {
          await bootStorageFirst();
          svcOf().setMuted('zz-new', 600, 'onebot');
          await settle();
        } finally {
          chmodSync(mutesPath(), 0o644);
        }
        expect(readFileSync(mutesPath(), 'utf-8')).toBe(seeded);
      },
    );

    it('读失败后 storage 重载、重读成功：恢复落盘', async () => {
      const broken = '{"zz-old":';
      writeFileSync(mutesPath(), broken);
      await bootStorageFirst();

      svcOf().setMuted('zz-a', 600, 'onebot');
      await settle();
      expect(readFileSync(mutesPath(), 'utf-8')).toBe(broken);

      // 修好文件后 storage 重载：本插件随之重新激活、重读，失败标记按这次读取重新判定
      writeFileSync(
        mutesPath(),
        JSON.stringify({ 'zz-old': { platform: 'onebot', mutedUntil: Date.now() + 3600_000 } }),
      );
      await app.plugins.disable('@aalis/plugin-storage-local');
      await app.plugins.enable('@aalis/plugin-storage-local');
      await app.plugins.idle();

      svcOf().setMuted('zz-b', 600, 'onebot');
      await expect
        .poll(() => {
          try {
            return Object.keys(readMutes());
          } catch {
            return [];
          }
        })
        .toContain('zz-b');
    });

    it('文件不存在：按全新照常落盘', async () => {
      await bootStorageFirst();
      svcOf().setMuted('zz-new', 600, 'onebot');
      await expect
        .poll(() => {
          try {
            return Object.keys(readMutes());
          } catch {
            return [];
          }
        })
        .toEqual(['zz-new']);
    });
  });
});
