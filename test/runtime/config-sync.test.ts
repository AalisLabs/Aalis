import { App, config, definePlugin, hostConfig, type PluginDefinition } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import {
  installConfigHotReload,
  syncPluginDefaults,
  withPluginConfigSync,
} from '../../packages/runtime/src/config-sync.js';
import { createPluginDiscovery, type PluginLoader } from '../../packages/runtime/src/plugin-discovery.js';
import { defaultsFrom } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// 配置同步政策 + 热重载编排（宿主层）
// defaultConfig 回填、按 configSchema 裁剪未知字段、watch → diff → bounce。
// core 只持有配置快照机制,政策与编排全在 runtime 的 config-sync。
// ════════════════════════════════════════════════════════════

function makeApp(pluginsConfig: Record<string, Record<string, unknown>>) {
  return new App({ config: { name: 'T', logLevel: 'error', plugins: pluginsConfig } });
}

/** 整份配置的读写面：宿主经描述符绑到根激活，与插件声明 hostConfig 拿到的是同一个管理器 */
const configOf = (app: App) => app.bind({ hostConfig }).hostConfig.require();

const p1Module = definePlugin({
  name: 'p1',
  configSchema: { known: { type: 'number', label: 'K', default: 0 } },
  apply() {},
});

describe('加载前配置同步', () => {
  function fixture(trimUnknownFields = true, reload = true) {
    const definitions: PluginDefinition[] = [];
    const seen: Record<string, unknown>[] = [];
    const saved: unknown[] = [];
    const loader: PluginLoader = {
      discover: async () => definitions.map(d => ({ name: d.name, source: d.name })),
      load: async d => definitions.find(def => def.name === d.name) ?? null,
    };
    if (reload) loader.reload = loader.load;
    const prepared = withPluginConfigSync(loader, () => app, { trimUnknownFields });
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: {} },
      configProvider: {
        save: snapshot => {
          saved.push(structuredClone(snapshot));
        },
      },
      pluginDefaults: d => defaultsFrom(d.configSchema),
    });
    const discovery = createPluginDiscovery(app, prepared.loader);
    function add(name: string) {
      definitions.push(
        definePlugin({
          name,
          reusable: true,
          configSchema: {
            known: { type: 'number', label: 'K', default: 1 },
            nested: { label: 'N', fields: { filled: { type: 'number', label: 'F', default: 7 } } },
          },
          uses: { config },
          apply({ config: value }) {
            seen.push(structuredClone(value));
          },
        }),
      );
      app.config.setPluginConfig(name, { known: 2, unknown: true, nested: { typo: 'x' } });
      app.config.setPluginConfig(`${name}:other`, { known: 3, unknown: true });
    }
    return { app, discovery, prepared, loader, add, seen, saved };
  }

  it('首次 apply、实例记录与持久化一致，主实例和后缀实例均只激活一次；首批只保存一次', async () => {
    const f = fixture();
    f.add('one');
    f.add('two');
    await f.discovery.loadAll();
    expect(f.saved).toHaveLength(0);
    f.prepared.finishInitialLoad();
    f.prepared.finishInitialLoad();
    expect(f.seen).toHaveLength(4);
    expect(f.seen).toEqual(
      expect.arrayContaining([
        { known: 2, nested: { filled: 7 } },
        { known: 3, nested: { filled: 7 } },
      ]),
    );
    for (const { instanceId } of f.app.plugins.getStatus()) {
      expect(f.app.plugins.getPlugin(instanceId)?.config).toEqual(f.app.config.getPluginConfig(instanceId));
    }
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]).toMatchObject({
      plugins: {
        one: { known: 2, nested: { filled: 7 } },
        'one:other': { known: 3, nested: { filled: 7 } },
      },
    });
    await f.app.stop();
  });

  it('trimUnknownFields=false 在首次 apply 保留额外字段，同时补齐嵌套默认值', async () => {
    const f = fixture(false);
    f.add('one');
    await f.discovery.loadAll();
    f.prepared.finishInitialLoad();
    expect(f.seen[0]).toEqual({ known: 2, unknown: true, nested: { typo: 'x', filled: 7 } });
    expect(f.seen[1]).toEqual({ known: 3, unknown: true, nested: { filled: 7 } });
    await f.app.stop();
  });

  it('某个定义导入失败不重复激活已加载实例，批次结束仍保存已完成的规范化', async () => {
    const f = fixture();
    f.add('one');
    f.add('broken');
    const load = f.loader.load;
    f.loader.load = async d => {
      if (d.name === 'broken') throw new Error('broken module');
      return load(d);
    };
    await f.discovery.loadAll();
    f.prepared.finishInitialLoad();
    expect(f.app.plugins.getPlugin('broken')).toBeUndefined();
    expect(f.seen).toHaveLength(2);
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]).toMatchObject({
      plugins: {
        one: { known: 2, nested: { filled: 7 } },
        broken: { known: 2, unknown: true, nested: { typo: 'x' } },
      },
    });
    await f.app.stop();
  });

  it('异步落盘失败被记录，不重试整批或撤销已激活实例', async () => {
    let writes = 0;
    const prepared = withPluginConfigSync(
      {
        discover: async () => [{ name: p1Module.name, source: 'memory' }],
        load: async () => p1Module,
      },
      () => app,
    );
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { p1: { known: 1, unknown: true } } },
      configProvider: {
        save: () => {
          writes++;
          return Promise.reject(new Error('read only'));
        },
      },
    });
    const warns = captureWarnsOf(app);
    await createPluginDiscovery(app, prepared.loader).loadAll();
    prepared.finishInitialLoad();
    prepared.finishInitialLoad();
    await Promise.resolve();
    expect(writes).toBe(1);
    expect(warns.filter(w => w.includes('配置同步落盘失败'))).toHaveLength(1);
    expect(app.plugins.getPlugin('p1')?.state).toBe('active');
    expect(app.plugins.getPlugin('p1')?.config).toEqual({ known: 1 });
    await app.stop();
  });

  it.each([true, false])('启动后 rescan 在首次 apply 前同步新定义和复用实例（reload=%s）', async reload => {
    const f = fixture(true, reload);
    await f.discovery.loadAll();
    f.prepared.finishInitialLoad();
    expect(f.saved).toHaveLength(0);
    f.add('later');
    await f.discovery.rescan();
    await f.app.plugins.idle();
    expect(f.seen).toEqual([
      { known: 2, nested: { filled: 7 } },
      { known: 3, nested: { filled: 7 } },
    ]);
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]).toMatchObject({ plugins: { later: { known: 2, nested: { filled: 7 } } } });
    await f.app.stop();
  });
});

describe('syncPluginDefaults 政策', () => {
  it('默认（trimUnknownFields=true）：按 schema 裁剪未知字段', async () => {
    const app = makeApp({ p1: { known: 1, unknown: 'x' } });
    await app.plugin(p1Module);
    syncPluginDefaults(app);
    expect(configOf(app).getPluginConfig('p1')).toEqual({ known: 1 });
    await app.stop();
  });

  it('trimUnknownFields=false：保留 schema 外字段', async () => {
    const app = makeApp({ p1: { known: 1, unknown: 'x' } });
    await app.plugin(p1Module);
    syncPluginDefaults(app, { trimUnknownFields: false });
    expect(configOf(app).getPluginConfig('p1')).toEqual({ known: 1, unknown: 'x' });
    await app.stop();
  });

  // configSchema 是唯一声明来源：默认值从 field.default 派生（defaultsFrom），
  // 白名单就是 schema 的键集。以下覆盖用户点名的三条底线行为。
  it('schema 派生默认值回填缺失字段（深合并，已有值不覆盖）', async () => {
    const app = makeApp({ p2: { b: 2 } });
    const mod = definePlugin({
      name: 'p2',
      configSchema: {
        a: { type: 'number', label: 'A', default: 1 },
        b: { type: 'number', label: 'B', default: 0 },
      },
      apply() {},
    });
    await app.plugin(mod);
    syncPluginDefaults(app);
    expect(configOf(app).getPluginConfig('p2')).toEqual({ a: 1, b: 2 });
    await app.stop();
  });

  it('嵌套 SchemaGroup：缺失子键回填、schema 外子键裁掉', async () => {
    const mod = definePlugin({
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
    });
    const app = makeApp({ p5: { nested: { shown: 9, typo: 8 } } });
    await app.plugin(mod);
    syncPluginDefaults(app);
    // missing 从 schema 默认值深回填；typo 不在 schema 里被裁掉
    expect(configOf(app).getPluginConfig('p5')).toEqual({ nested: { shown: 9, missing: 7 } });
    await app.stop();
  });

  it('裁掉字段时 warn 点名（含嵌套前缀），不静默', async () => {
    const mod = definePlugin({
      name: 'p7',
      configSchema: {
        keep: { type: 'number', label: 'K', default: 1 },
        g: { label: 'G', fields: { in: { type: 'number', label: 'I', default: 2 } } },
      },
      apply() {},
    });
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
    const mod = definePlugin({
      name: 'p4',
      configSchema: {
        startupView: { type: 'string', label: '启动视图', default: 'last' },
        lastView: { type: 'string', label: '上次视图', default: 'chat' },
      },
      apply() {},
    });
    const app = makeApp({ p4: { startupView: 'last', lastView: 'logs' } });
    await app.plugin(mod);
    syncPluginDefaults(app);
    expect(configOf(app).getPluginConfig('p4').lastView).toBe('logs');
    await app.stop();
  });

  it('注册期注入：App 带 pluginDefaults 时 apply 直接收到派生默认值（首启即正确，不等落盘）', async () => {
    let seen: Record<string, unknown> | undefined;
    const mod = definePlugin({
      name: 'p6',
      configSchema: { flag: { type: 'boolean', label: 'F', default: true } },
      uses: { config },
      apply(caps) {
        seen = caps.config;
      },
    });
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
  it('watch 推送的快照裁剪 schema 外字段并 bounce：apply 重跑且内置 config 拿到新值', async () => {
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
    let applies = 0;
    let seen: Readonly<Record<string, unknown>> | undefined;
    const mod = definePlugin({
      name: 'p1',
      configSchema: { known: { type: 'number', label: 'K', default: 0 } },
      uses: { config },
      apply({ config: cfg }) {
        applies++;
        seen = cfg;
      },
    });
    await app.plugin(mod);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p1')?.state).toBe('active');
    expect(applies).toBe(1);
    expect(seen).toEqual({ known: 1 });

    await app.start();
    installConfigHotReload(app);

    // 模拟外部把 schema 外字段写进配置文件
    pushSnapshot?.({ name: 'T', logLevel: 'error', plugins: { p1: { known: 2, sneaky: true } } });
    // watch 回调同步进入 handleConfigChanged；bounce 在首个 await 前已抬 suspendDepth，idle 等到重建落定
    await app.plugins.idle();

    // 政策默认裁剪：sneaky 不应留在内存态（syncPluginDefaults 已写 ConfigManager）
    expect(configOf(app).getPluginConfig('p1')).toEqual({ known: 2 });
    // 只钉 ConfigManager 会假绿：去掉 updateConfig 后同步政策仍会 setPluginConfig。
    // apply 次数与内置 config（即这次激活的 entry.config）才证明插件被重建且拿到新值。
    expect(applies).toBe(2);
    expect(seen).toEqual({ known: 2 });
    expect(app.plugins.getPlugin('p1')?.config).toEqual({ known: 2 });
    expect(app.plugins.getPlugin('p1')?.state).toBe('active');
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
  const badMod = definePlugin({
    name: 'pv',
    configSchema: {
      port: { type: 'number', label: 'P', default: 8080 },
      mode: { type: 'select', label: 'M', default: 'a', options: [{ label: 'A', value: 'a' }] },
    },
    apply() {},
  });

  it('坏值 warn 点名（path + 期望），配置原样保留、插件不受影响', async () => {
    const app = makeApp({ pv: { port: 'abc' } });
    const warned = captureWarnsOf(app);
    await app.plugin(badMod);
    syncPluginDefaults(app);
    const hit = warned.find(w => w.includes('配置校验'));
    expect(hit).toContain('pv');
    expect(hit).toContain('port: 期望有限数值，得到 string');
    // 只告警不改值：坏值原样保留（校验器绝不参与取值链路）
    expect(configOf(app).getPluginConfig('pv').port).toBe('abc');
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
    const mod = definePlugin({
      name: 'pd',
      configSchema: { apiKey: { type: 'string', label: 'K', required: true } },
      apply() {},
    });
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
    const mod = definePlugin({
      name: 'pm',
      configSchema: { apiKey: { type: 'string', label: 'K', required: true } },
      apply() {},
    });
    const app = makeApp({ pm: {} });
    const warned = captureWarnsOf(app);
    await app.plugin(mod);
    syncPluginDefaults(app);
    expect(warned.find(w => w.includes('配置校验'))).toContain('apiKey: 必填字段缺失');
    await app.stop();
  });
});
