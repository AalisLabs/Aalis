import { App, type PluginModule } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { installConfigHotReload, syncPluginDefaults } from '../../packages/runtime/src/config-sync.js';

// ════════════════════════════════════════════════════════════
// 配置同步政策 + 热重载编排（宿主层）
// defaultConfig 回填、按 configSchema 裁剪未知字段、watch → diff → bounce。
// core 只持有配置快照机制,政策与编排全在 runtime 的 config-sync。
// ════════════════════════════════════════════════════════════

function makeApp(pluginsConfig: Record<string, Record<string, unknown>>) {
  return new App({ config: { name: 'T', logLevel: 'error', plugins: pluginsConfig } });
}

const p1Module: PluginModule = {
  name: 'p1',
  defaultConfig: { known: 0 },
  configSchema: { known: { type: 'number', label: 'K' } },
  apply() {},
};

describe('syncPluginDefaults 政策', () => {
  it('默认（trimUnknownFields=true）：按 schema 裁剪未知字段', async () => {
    const app = makeApp({ p1: { known: 1, unknown: 'x' } });
    await app.plugin(p1Module);
    syncPluginDefaults(app);
    expect(app.ctx.config.getPluginConfig('p1')).toEqual({ known: 1 });
    await app.stop();
  });

  it('trimUnknownFields=false：保留 schema 外字段', async () => {
    const app = makeApp({ p1: { known: 1, unknown: 'x' } });
    await app.plugin(p1Module);
    syncPluginDefaults(app, { trimUnknownFields: false });
    expect(app.ctx.config.getPluginConfig('p1')).toEqual({ known: 1, unknown: 'x' });
    await app.stop();
  });

  it('defaultConfig 回填缺失字段（深合并,已有值不覆盖）', async () => {
    const app = makeApp({ p2: { b: 2 } });
    const mod: PluginModule = { name: 'p2', defaultConfig: { a: 1, b: 0 }, apply() {} };
    await app.plugin(mod);
    syncPluginDefaults(app);
    expect(app.ctx.config.getPluginConfig('p2')).toEqual({ a: 1, b: 2 });
    await app.stop();
  });
});

describe('配置热重载编排（watch → 同政策裁剪 → bounce）', () => {
  it('watch 推送的快照在热重载时按 trimUnknownFields 裁剪 schema 外字段', async () => {
    let pushSnapshot: ((next: Record<string, unknown>) => void) | undefined;
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { p1: { known: 1 } } },
      configProvider: {
        save: () => {},
        watch: cb => {
          pushSnapshot = cb as (next: Record<string, unknown>) => void;
          return () => {};
        },
      },
    });
    await app.plugin(p1Module);
    await app.start();
    installConfigHotReload(app);

    // 模拟外部把 schema 外字段写进配置文件
    pushSnapshot?.({ name: 'T', logLevel: 'error', plugins: { p1: { known: 2, sneaky: true } } });
    // 热重载是异步链（watch 回调 → handleConfigChanged → bounce）
    await new Promise(r => setTimeout(r, 20));

    // 政策默认裁剪：sneaky 不应留在内存态
    expect(app.ctx.config.getPluginConfig('p1')).toEqual({ known: 2 });
    await app.stop();
  });
});
