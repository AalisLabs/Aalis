import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AalisConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import {
  App,
  type BoundOf,
  definePlugin,
  defineService,
  provide,
  type ServiceSelection,
} from '../../packages/core/src/index.js';
import { type ConfigProvider, createConfigStore, installHostConfig } from '../../packages/runtime/src/config-store.js';
import { installConfigHotReload } from '../../packages/runtime/src/config-sync.js';
import { createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// 本插件偏好与全局偏好放在同一份配置文档里：经 host-config 写、随文档落盘，启动时与热重载时应用到运行态。
// 本插件偏好只对那个插件生效；热重载按改动前后的文档对账，文件里删掉的偏好从运行态撤回
// ════════════════════════════════════════════════════════════

interface Who {
  who(): string;
}
const svc = defineService<Who>('zz-svc');

/** 两家提供者：zz-a 优先级高，没有偏好时两个消费者都选它 */
const providers = [
  ['zz-a', 10],
  ['zz-b', 0],
].map(([name, priority]) =>
  definePlugin({
    name: name as string,
    provides: [svc],
    uses: { provide },
    apply({ provide }) {
      provide.use(svc, { who: () => name as string }, { priority: priority as number });
    },
  }),
);

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 与 startAalis 同序：文档 → App → host-config（应用文档里的偏好）→ 提供者与两个消费者。文档读自 YAML 文件，
 * 或直接给出（带上接热重载的 provider）
 */
async function boot(source: { path: string } | { doc: Partial<AalisConfig>; provider: ConfigProvider }) {
  const { config, provider } =
    'path' in source
      ? createFsYamlConfigProvider(source.path)
      : { config: { name: 'T', logLevel: 'error', plugins: {}, ...source.doc }, provider: source.provider };
  const store = createConfigStore(config, provider);
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  installHostConfig(app, store);
  const selections: Record<string, ServiceSelection<Who>> = {};
  for (const definition of providers) await app.plugin(definition);
  for (const name of ['zz-picky', 'zz-plain']) {
    const uses = { svc };
    await app.plugin(
      definePlugin({
        name,
        uses,
        apply(caps: BoundOf<typeof uses>) {
          selections[name] = caps.svc;
        },
      }),
    );
  }
  await app.plugins.idle();
  /** 消费者此刻选中的那一家与依据 */
  const chosen = (name: string) => {
    const entry = selections[name].list().find(p => p.selected);
    return [entry?.id, entry?.basis];
  };
  return { app, store, doc: app.bind({ hostConfig }).hostConfig.use, chosen };
}

describe('本插件偏好的持久化', () => {
  it('经 host-config 写进配置文件，重启后只对那个插件生效；删掉之后重启回到排名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-plugin-prefs-'));
    dirs.push(dir);
    const path = join(dir, 'aalis.config.yaml');
    writeFileSync(path, 'name: T\nlogLevel: error\nplugins: {}\n');

    const first = await boot({ path });
    first.doc.setServicePreference('zz-svc', 'zz-b', { for: 'zz-picky' });
    expect(first.doc.getServicePreferences({ for: 'zz-picky' })).toEqual({ 'zz-svc': 'zz-b' });
    expect(first.doc.getServicePreferences()).toEqual({});
    await first.doc.save();
    await first.app.stop();

    const second = await boot({ path });
    expect(second.chosen('zz-picky')).toEqual(['zz-b', 'plugin']);
    expect(second.chosen('zz-plain')).toEqual(['zz-a', 'rank']);
    second.doc.removeServicePreference('zz-svc', { for: 'zz-picky' });
    expect(second.doc.getAll().pluginServicePreferences).toEqual({});
    await second.doc.save();
    await second.app.stop();

    const third = await boot({ path });
    expect(third.chosen('zz-picky')).toEqual(['zz-a', 'rank']);
  });

  it('热重载：文件里改了的全局与本插件偏好即时生效，删掉的撤回', async () => {
    let changed: ((next: AalisConfig) => void) | undefined;
    const provider: ConfigProvider = {
      save() {},
      watch(onChange) {
        changed = onChange;
        return () => {};
      },
    };
    const base = { name: 'T', logLevel: 'error', plugins: {} };
    const { app, store, chosen } = await boot({
      doc: { pluginServicePreferences: { 'zz-picky': { 'zz-svc': 'zz-b' } } },
      provider,
    });
    installConfigHotReload(app, store, { registerConfiguredInstances: async () => {} });
    expect(chosen('zz-picky')).toEqual(['zz-b', 'plugin']);

    changed?.({ ...base, servicePreferences: { 'zz-svc': 'zz-b' } });
    await vi.waitFor(() => expect(chosen('zz-plain')).toEqual(['zz-b', 'global']));
    expect(chosen('zz-picky')).toEqual(['zz-b', 'global']);

    changed?.({ ...base, pluginServicePreferences: { 'zz-plain': { 'zz-svc': 'zz-b' } } });
    await vi.waitFor(() => expect(chosen('zz-picky')).toEqual(['zz-a', 'rank']));
    expect(chosen('zz-plain')).toEqual(['zz-b', 'plugin']);
  });
});
