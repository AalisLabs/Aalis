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

  // 合法字段 = schema 的键 ∪ defaultConfig 的键。schema 的类型词汇表达不了自由标量
  // 数组（array 的 items 必填、multiselect 需静态 options），这类字段只能落在
  // defaultConfig 里；只认 schema 会把插件自己声明过的字段连同用户设的值一起裁掉。
  it('保留只在 defaultConfig 声明的字段（schema 表达不了的类型）', async () => {
    const mod: PluginModule = {
      name: 'p3',
      // allowedHosts 是自由字符串数组，schema 无从表达，故只在 defaultConfig
      defaultConfig: { blockPrivate: true, allowedHosts: [] as string[] },
      configSchema: { blockPrivate: { type: 'boolean', label: '封锁内网' } },
      apply() {},
    };
    const app = makeApp({ p3: { blockPrivate: true, allowedHosts: ['example.com'], typo: 1 } });
    await app.plugin(mod);
    syncPluginDefaults(app);
    // 用户设的白名单必须留下；schema 与 defaultConfig 都没声明的 typo 才该裁
    expect(app.ctx.config.getPluginConfig('p3')).toEqual({ blockPrivate: true, allowedHosts: ['example.com'] });
    await app.stop();
  });

  it('插件自己写回配置的运行时字段不被裁掉（startupView=last 靠它记住上次）', async () => {
    const mod: PluginModule = {
      name: 'p4',
      defaultConfig: { startupView: 'last', lastView: 'chat' },
      configSchema: { startupView: { type: 'string', label: '启动视图' } },
      apply() {},
    };
    const app = makeApp({ p4: { startupView: 'last', lastView: 'logs' } });
    await app.plugin(mod);
    syncPluginDefaults(app);
    expect(app.ctx.config.getPluginConfig('p4').lastView).toBe('logs');
    await app.stop();
  });

  it('嵌套 fields 同样按并集裁剪', async () => {
    const mod: PluginModule = {
      name: 'p5',
      defaultConfig: { nested: { shown: 1, hidden: 2 } },
      configSchema: { nested: { label: 'N', fields: { shown: { type: 'number', label: 'S' } } } },
      apply() {},
    };
    const app = makeApp({ p5: { nested: { shown: 9, hidden: 8, typo: 7 } } });
    await app.plugin(mod);
    syncPluginDefaults(app);
    expect(app.ctx.config.getPluginConfig('p5')).toEqual({ nested: { shown: 9, hidden: 8 } });
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
