import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import { App, type Logger, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { HUB_PLUGINS } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// configDir:/personas 的候选目录曾在激活时按 storage.listRoots() 拍一次快照。
// storage 是可选依赖、不参与拓扑：同一批 pluginAll 里 persona 排在 storage-local 前面
// 激活，那一刻一个根都没有，configDir 从此不在候选里——app:ready 的扫描与监听都漏掉它，
// 放在 configDir 根下的主卡永远找不到。现改为每次用时现取根列表。
// 真 storage-local 多根（workspace 排第一、data / configDir 在后）+ 真 yaml 解析。
// ════════════════════════════════════════════════════════════

function recordingLogger(sink: string[]): Logger {
  const push =
    () =>
    (message: string, ...args: unknown[]) =>
      sink.push([message, ...args.map(a => String(a))].join(' '));
  const logger: Logger = {
    debug: push(),
    info: push(),
    warn: push(),
    error: push(),
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

const root = (name: string, path: string) => ({
  name,
  path,
  label: name,
  kind: name,
  browsable: true,
  readable: true,
  writable: true,
  deletable: true,
});

describe('persona 的 configDir 候选目录（存储提供者后于 persona 激活）', () => {
  let base: string;
  let app: App;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-persona-cfgdir-'));
    for (const d of ['workspace', 'data', join('config', 'personas')]) mkdirSync(join(base, d), { recursive: true });
    // 主卡只放在 configDir 根下；personasDir（data:/personas）里没有它
    writeFileSync(join(base, 'config', 'personas', 'zzcard.yaml'), 'name: 配置目录卡\ndescription: d\nprompt: p\n');
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('同批登记、persona 先于 storage-local 激活：app:ready 后仍能从 configDir:/personas 载入主卡', async () => {
    const logs: string[] = [];
    app = new App({ name: 'T', logLevel: 'debug', logger: recordingLogger(logs) });
    await app.pluginAll([
      ...HUB_PLUGINS.map(definition => ({ definition })),
      { definition: personaPlugin, config: { persona: 'zzcard', personasDir: 'data/personas' } },
      {
        definition: storageLocal,
        config: {
          roots: [
            root('workspace', join(base, 'workspace')),
            root('data', join(base, 'data')),
            root('configDir', join(base, 'config')),
          ],
        },
      },
    ]);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(storageLocal.name)?.state, 'storage-local 未激活').toBe('active');
    expect(app.plugins.getPlugin(personaPlugin.name)?.state, 'persona 未激活').toBe('active');
    // 前提钉死：persona 激活时存储还没到位（否则测的不是这个时序）
    expect(logs.some(t => t.includes('未找到角色卡 "zzcard"'))).toBe(true);

    await app.start();
    const svc: PersonaService | undefined = app.bind({ services }).services.get(persona);
    if (!svc) throw new Error('persona 服务未就绪');
    expect(svc.getPersonaName()).toBe('配置目录卡');
    expect(await svc.listModels?.()).toContain('zzcard');
    // 监听同样按现取的根列表挂上：configDir 下的卡改动也能热重载
    expect(logs.some(t => t.includes('storage.watch configDir:/personas'))).toBe(true);
  });
});
