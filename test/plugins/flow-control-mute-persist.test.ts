import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FlowControlService, flowControl } from '../../packages/api-flow-control/src/index.js';
import { gateway, INBOUND_PHASE } from '../../packages/api-gateway/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, events, services } from '../../packages/core/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 禁言表持久化跟随 storage 上线：storage 是 optional，不参与激活拓扑，按字母序整批登记时
// flow-control 先于 storage-local 激活。曾经只在 apply 里读一次：那一刻没有 storage，
// 读失败被当成空表，之后第一次 setMuted 整表写回，磁盘上只剩这一次写入的会话。
// 真 storage-local 多根（workspace 在前、data 在后），禁言表落在 data 根。
// ════════════════════════════════════════════════════════════

const MUTES = 'flow-control-mutes.json';

describe('flow-control 禁言表：storage 晚于本插件上线', () => {
  let base: string;
  let app: App;

  const storageLocal = () => ({
    definition: storageLocalPlugin,
    config: {
      roots: ['workspace', 'data'].map(name => ({
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
    JSON.parse(readFileSync(join(base, 'data', MUTES), 'utf-8'));

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-flow-mute-'));
    mkdirSync(join(base, 'data'), { recursive: true });
    mkdirSync(join(base, 'workspace'), { recursive: true });
  });

  afterEach(async () => {
    await app?.stop();
    rmSync(base, { recursive: true, force: true });
  });

  const svcOf = (): FlowControlService => {
    const svc = app.bind({ services }).services.get(flowControl);
    if (!svc) throw new Error('flow-control 服务未注册');
    return svc;
  };

  it('storage 先上线：apply 返回时禁言表已读回，激活后立即可判禁言', async () => {
    writeFileSync(
      join(base, 'data', MUTES),
      JSON.stringify({ 'zz-old': { platform: 'onebot', mutedUntil: Date.now() + 3600_000 } }),
    );

    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.pluginAll([storageLocal()]);
    await app.plugins.idle();
    await app.pluginAll([
      { definition: gatewayPlugin, config: {} },
      { definition: flowControlPlugin, config: {} },
    ]);
    await app.plugins.idle();
    expect(svcOf().isMuted('zz-old')).toBe(true);
  });

  it('拆卸时仍有写在排队：等写链落完再清表，磁盘保留全部会话', async () => {
    writeFileSync(
      join(base, 'data', MUTES),
      JSON.stringify({ 'zz-old': { platform: 'onebot', mutedUntil: Date.now() + 3600_000 } }),
    );

    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.pluginAll([storageLocal(), { definition: gatewayPlugin, config: {} }]);
    await app.plugin(flowControlPlugin, {});
    await app.plugins.idle();
    const svc = svcOf();
    // 让 data 根的第一次写变慢，第二次写就排在写链上
    const dataRoot = app
      .bind({ services })
      .services.all(storage)
      .map(view => view.instance)
      .find(instance => instance.listRoots().some(root => root.name === 'data'));
    if (!dataRoot) throw new Error('data 根未登记');
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

  it('按字母序整批登记（flow-control 先于 storage-local）：禁言能恢复，setMuted 后磁盘保留原有会话', async () => {
    const until = Date.now() + 3600_000;
    writeFileSync(join(base, 'data', MUTES), JSON.stringify({ 'zz-old': { platform: 'onebot', mutedUntil: until } }));

    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.pluginAll([
      { definition: flowControlPlugin, config: {} },
      { definition: gatewayPlugin, config: {} },
      storageLocal(),
    ]);
    await app.plugins.idle();
    const svc = svcOf();

    await expect.poll(() => svc.isMuted('zz-old'), { timeout: 2000 }).toBe(true);

    svc.setMuted('zz-new', 600, 'onebot');
    await expect.poll(() => Object.keys(readMutes()).sort(), { timeout: 2000 }).toEqual(['zz-new', 'zz-old']);
    expect(readMutes()['zz-old'].mutedUntil).toBe(until);
  });

  it('storage 上线后读回完成前就 setMuted：写盘等读回合并完，磁盘仍保留原有会话', async () => {
    const until = Date.now() + 3600_000;
    writeFileSync(join(base, 'data', MUTES), JSON.stringify({ 'zz-old': { platform: 'onebot', mutedUntil: until } }));

    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(gatewayPlugin, {});
    await app.plugin(flowControlPlugin, {});
    await app.plugins.idle();
    const svc = svcOf();

    await app.pluginAll([storageLocal()]);
    // 不等读回：storage 刚上线，follow 补读还在飞
    svc.setMuted('zz-new', 600, 'onebot');
    await expect.poll(() => svc.isMuted('zz-old'), { timeout: 2000 }).toBe(true);
    await expect.poll(() => Object.keys(readMutes()).sort(), { timeout: 2000 }).toEqual(['zz-new', 'zz-old']);
  });

  it('storage 上线后读回完成前的入站消息：等读回再判禁言，已禁言会话照样被吞', async () => {
    writeFileSync(
      join(base, 'data', MUTES),
      JSON.stringify({ 'zz-old': { platform: 'onebot', mutedUntil: Date.now() + 3600_000 } }),
    );

    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(gatewayPlugin, {});
    await app.plugin(flowControlPlugin, {});
    await app.plugins.idle();
    const host = app.bind({ events, gateway });
    let flowPassed: boolean | undefined;
    host.events.on('gateway:phase:done', d => {
      if (d.phase === INBOUND_PHASE.FLOW) flowPassed = d.reachedEnd;
    });

    await app.pluginAll([storageLocal()]);
    // 不等读回：storage 刚上线，follow 补读还在飞
    await host.gateway.require().ingressMessage({
      content: 'hi',
      sessionId: 'zz-old',
      platform: 'onebot',
      sessionType: 'group',
      groupId: 'g1',
      userId: 'u1',
    });
    expect(flowPassed, '禁言表读回前放行了已禁言会话的消息').toBe(false);
  });

  it('读回前内存里已有的禁言与磁盘合并：取较晚的到期时刻，不被磁盘整条替换', async () => {
    const soon = Date.now() + 60_000;
    writeFileSync(
      join(base, 'data', MUTES),
      JSON.stringify({
        'zz-a': { platform: 'onebot', mutedUntil: soon },
        'zz-b': { platform: 'onebot', mutedUntil: soon },
      }),
    );

    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(gatewayPlugin, {});
    await app.plugin(flowControlPlugin, {});
    await app.plugins.idle();
    const svc = svcOf();
    // storage 尚未上线：这次禁言只在内存里（写盘失败只记 warn）
    svc.setMuted('zz-a', 3600, 'onebot');
    const memoryUntil = svc.getStateSnapshot('zz-a')?.mutedUntil ?? 0;
    expect(memoryUntil).toBeGreaterThan(soon);

    await app.pluginAll([storageLocal()]);
    await app.plugins.idle();

    await expect.poll(() => svc.isMuted('zz-b'), { timeout: 2000 }).toBe(true);
    expect(svc.getStateSnapshot('zz-a')?.mutedUntil, '内存里较晚的禁言被磁盘上较早的值盖掉').toBe(memoryUntil);
  });
});
