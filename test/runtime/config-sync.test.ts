import { App, type PluginModule } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { installConfigHotReload, syncPluginDefaults } from '../../packages/runtime/src/config-sync.js';
import { defaultsFrom } from '../../packages/schema-config/src/index.js';

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
  configSchema: { known: { type: 'number', label: 'K', default: 0 } },
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

  // configSchema 是唯一声明来源：默认值从 field.default 派生（defaultsFrom），
  // 白名单就是 schema 的键集。以下覆盖用户点名的三条底线行为。
  it('schema 派生默认值回填缺失字段（深合并，已有值不覆盖）', async () => {
    const app = makeApp({ p2: { b: 2 } });
    const mod: PluginModule = {
      name: 'p2',
      configSchema: {
        a: { type: 'number', label: 'A', default: 1 },
        b: { type: 'number', label: 'B', default: 0 },
      },
      apply() {},
    };
    await app.plugin(mod);
    syncPluginDefaults(app);
    expect(app.ctx.config.getPluginConfig('p2')).toEqual({ a: 1, b: 2 });
    await app.stop();
  });

  it('嵌套 SchemaGroup：缺失子键回填、schema 外子键裁掉', async () => {
    const mod: PluginModule = {
      name: 'p5',
      configSchema: {
        nested: {
          label: 'N',
          fields: {
            shown: { type: 'number', label: 'S', default: 1 },
            missing: { type: 'number', label: 'M', default: 7 },
          },
        },
      },
      apply() {},
    };
    const app = makeApp({ p5: { nested: { shown: 9, typo: 8 } } });
    await app.plugin(mod);
    syncPluginDefaults(app);
    // missing 从 schema 默认值深回填；typo 不在 schema 里被裁掉
    expect(app.ctx.config.getPluginConfig('p5')).toEqual({ nested: { shown: 9, missing: 7 } });
    await app.stop();
  });

  it('裁掉字段时 warn 点名（含嵌套前缀），不静默', async () => {
    const mod: PluginModule = {
      name: 'p7',
      configSchema: {
        keep: { type: 'number', label: 'K', default: 1 },
        g: { label: 'G', fields: { in: { type: 'number', label: 'I', default: 2 } } },
      },
      apply() {},
    };
    const app = makeApp({ p7: { keep: 1, junk: 'x', g: { in: 2, deepJunk: 'y' } } });
    const warned: string[] = [];
    const origWarn = app.logger.warn.bind(app.logger);
    app.logger.warn = (msg: string, ...rest: unknown[]) => {
      warned.push(String(msg));
      origWarn(msg, ...rest);
    };
    await app.plugin(mod);
    syncPluginDefaults(app);
    const hit = warned.find(w => w.includes('裁掉 schema 外字段'));
    // 静默裁剪会让「字段被吃掉」与「用户没配」不可分辨——必须点名
    expect(hit).toContain('junk');
    expect(hit).toContain('g.deepJunk');
    await app.stop();
  });

  it('运行时写回的字段只要在 schema 里声明过就不会被裁（lastView 型）', async () => {
    const mod: PluginModule = {
      name: 'p4',
      configSchema: {
        startupView: { type: 'string', label: '启动视图', default: 'last' },
        lastView: { type: 'string', label: '上次视图', default: 'chat' },
      },
      apply() {},
    };
    const app = makeApp({ p4: { startupView: 'last', lastView: 'logs' } });
    await app.plugin(mod);
    syncPluginDefaults(app);
    expect(app.ctx.config.getPluginConfig('p4').lastView).toBe('logs');
    await app.stop();
  });

  it('注册期注入：App 带 pluginDefaults 时 apply 直接收到派生默认值（首启即正确，不等落盘）', async () => {
    let seen: Record<string, unknown> | undefined;
    const mod: PluginModule = {
      name: 'p6',
      configSchema: { flag: { type: 'boolean', label: 'F', default: true } },
      apply(_ctx, config) {
        seen = config;
      },
    };
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: {} },
      pluginDefaults: m => defaultsFrom(m.configSchema),
    });
    await app.plugin(mod);
    expect(seen).toEqual({ flag: true });
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

function captureWarnsOf(app: App): string[] {
  const warned: string[] = [];
  const origWarn = app.logger.warn.bind(app.logger);
  app.logger.warn = (msg: string, ...rest: unknown[]) => {
    warned.push(String(msg));
    origWarn(msg, ...rest);
  };
  return warned;
}

describe('配置结构校验（validateConfig 接线：只告警不拒载）', () => {
  const badMod: PluginModule = {
    name: 'pv',
    configSchema: {
      port: { type: 'number', label: 'P', default: 8080 },
      mode: { type: 'select', label: 'M', default: 'a', options: [{ label: 'A', value: 'a' }] },
    },
    apply() {},
  };

  it('坏值 warn 点名（path + 期望），配置原样保留、插件不受影响', async () => {
    const app = makeApp({ pv: { port: 'abc' } });
    const warned = captureWarnsOf(app);
    await app.plugin(badMod);
    syncPluginDefaults(app);
    const hit = warned.find(w => w.includes('配置校验'));
    expect(hit).toContain('pv');
    expect(hit).toContain('port: 期望有限数值，得到 string');
    // 只告警不改值：坏值原样保留（校验器绝不参与取值链路）
    expect(app.ctx.config.getPluginConfig('pv').port).toBe('abc');
    expect(app.plugins.getStatus().find(s => s.instanceId === 'pv')?.state).toBe('active');
    await app.stop();
  });

  it('合法配置零告警（默认值合并后校验，缺省字段不误报）', async () => {
    const app = makeApp({ pv: {} });
    const warned = captureWarnsOf(app);
    await app.plugin(badMod);
    syncPluginDefaults(app);
    expect(warned.find(w => w.includes('配置校验'))).toBeUndefined();
    await app.stop();
  });

  it('禁用插件跳过校验（休眠配置的必填缺失不是噪音源）', async () => {
    const mod: PluginModule = {
      name: 'pd',
      configSchema: { apiKey: { type: 'string', label: 'K', required: true } },
      apply() {},
    };
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { pd: {} }, disabledPlugins: ['pd'] },
    });
    const warned = captureWarnsOf(app);
    await app.plugin(mod);
    syncPluginDefaults(app);
    expect(warned.find(w => w.includes('配置校验'))).toBeUndefined();
    await app.stop();
  });
  it('required 无 default 的缺失也告警（missing 与 invalid 都出声）', async () => {
    const mod: PluginModule = {
      name: 'pm',
      configSchema: { apiKey: { type: 'string', label: 'K', required: true } },
      apply() {},
    };
    const app = makeApp({ pm: {} });
    const warned = captureWarnsOf(app);
    await app.plugin(mod);
    syncPluginDefaults(app);
    expect(warned.find(w => w.includes('配置校验'))).toContain('apiKey: 必填字段缺失');
    await app.stop();
  });
});
