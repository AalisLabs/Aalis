import { afterEach, describe, expect, it } from 'vitest';
import { type CheckSpec, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import {
  type AalisConfig,
  ConfigSaveRefusedError,
  type HostConfig,
  hostConfig,
} from '../../packages/api-host-config/src/index.js';
import {
  type App,
  config,
  definePlugin,
  type Logger,
  type PluginDefinition,
  provide,
} from '../../packages/core/src/index.js';
import { createConfigStore } from '../../packages/runtime/src/config-store.js';
import { installConfigHotReload, withPluginConfigSync } from '../../packages/runtime/src/config-sync.js';
import { createPluginDiscovery, type PluginLoader } from '../../packages/runtime/src/plugin-discovery.js';
import { type ConfigSchema, parseConfig } from '../../packages/schema-config/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// @aalis/runtime — 密钥存储与配置文档
//
// 文档里密钥字段只放引用，值在密钥存储（secrets.yaml）。插件拿到的 host-config：applyPluginConfig 一步完成
// 拆密钥、运行态、文档与落盘（先密钥后文档）；setPluginConfig 不收密钥字段上的明文。登记与热重载解析引用；
// 悬空引用让插件激活失败、点名键名。配置同步把文档里的明文移进密钥存储。孤儿键只在宿主经自己的写入换掉或删掉
// 最后一处引用后、文档落盘之后删除。provider 是替身，记录每次落盘的快照与顺序。
// ════════════════════════════════════════════════════════════

const SCHEMA = {
  apiKey: { type: 'string', label: 'Key', secret: true },
  model: { type: 'string', label: 'Model', default: 'm1' },
  conns: {
    type: 'array',
    label: 'C',
    items: { url: { type: 'string', label: 'U' }, token: { type: 'string', label: 'T', secret: true } },
  },
} satisfies ConfigSchema;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function recorder() {
  const lines: string[] = [];
  const logger: Logger = {
    debug() {},
    info: (...a: unknown[]) => void lines.push(`info ${a.map(String).join(' ')}`),
    warn: (...a: unknown[]) => void lines.push(`warn ${a.map(String).join(' ')}`),
    error: (...a: unknown[]) => void lines.push(`error ${a.map(String).join(' ')}`),
    child: () => logger,
  };
  return { logger, lines };
}

/** 插件照真实写法经 parseConfig 读配置：记下每次激活拿到的值与失败 */
function probe(name: string, opts: { reusable?: boolean } = {}) {
  const seen: Record<string, unknown>[] = [];
  const definition = definePlugin({
    name,
    reusable: opts.reusable,
    configSchema: SCHEMA,
    uses: { config },
    apply({ config: raw }) {
      seen.push(parseConfig(SCHEMA, raw) as Record<string, unknown>);
    },
  });
  return { definition, seen };
}

function world(doc: Partial<AalisConfig>, secrets: Record<string, unknown> = {}) {
  const order: string[] = [];
  const savedConfigs: AalisConfig[] = [];
  const savedSecrets: Record<string, unknown>[] = [];
  const failConfigSave = { on: false };
  // 密钥文件下一次（或接下来几次）保存失败：模拟盘上有尚未生效的外部修改而拒写
  const failSecretsSave = { times: 0 };
  const emit: { config?: (next: AalisConfig) => void; secrets?: (next: Record<string, unknown>) => void } = {};
  const { logger, lines } = recorder();
  const { app, store } = hostedApp(doc, {
    logger,
    provider: {
      save: snapshot => {
        if (failConfigSave.on) throw new Error('写盘失败');
        order.push('config');
        savedConfigs.push(structuredClone(snapshot));
      },
      watch: cb => {
        emit.config = cb;
        return () => {};
      },
    },
    secrets: {
      values: structuredClone(secrets),
      provider: {
        save: values => {
          if (failSecretsSave.times > 0) {
            failSecretsSave.times--;
            throw new ConfigSaveRefusedError('密钥文件有尚未生效的外部修改，为免覆盖已拒绝本次保存');
          }
          order.push('secrets');
          savedSecrets.push(structuredClone(values));
        },
        watch: cb => {
          emit.secrets = cb;
          return () => {};
        },
      },
    },
  });
  apps.push(app);
  const host = (): HostConfig => app.bind({ hostConfig }).hostConfig.require();
  return { app, store, host, order, savedConfigs, savedSecrets, failConfigSave, failSecretsSave, emit, lines };
}

describe('applyPluginConfig', () => {
  it('密钥字段上的明文：值进密钥存储、文档换成引用、运行态拿到原值；先写密钥再写文档，文档快照里没有原值', async () => {
    const w = world({ plugins: { p: { model: 'm1' } } });
    const p = probe('p');
    await registerFromDoc(w.app, w.store, p.definition);
    await w.app.plugins.idle();

    const result = await w.host().applyPluginConfig('p', { model: 'm2', apiKey: 'sk-PLACEHOLDER-1' });
    await w.app.plugins.idle();
    expect(result).toEqual({ status: 'applied', reloaded: true });
    expect(w.store.getPluginConfig('p')).toEqual({ model: 'm2', apiKey: { $secret: 'p.apiKey' } });
    expect(p.seen.at(-1)).toEqual({ model: 'm2', apiKey: 'sk-PLACEHOLDER-1' });
    expect(w.order).toEqual(['secrets', 'config']);
    expect(w.savedSecrets.at(-1)).toEqual({ 'p.apiKey': 'sk-PLACEHOLDER-1' });
    expect(JSON.stringify(w.savedConfigs)).not.toContain('sk-PLACEHOLDER-1');
    expect(w.lines.join('\n')).not.toContain('sk-PLACEHOLDER-1');
  });

  it('原样交回引用：解析结果与运行态相同，不重建插件，照常落盘', async () => {
    const w = world({ plugins: { p: { model: 'm1', apiKey: { $secret: 'k' } } } }, { k: 'sk-PLACEHOLDER' });
    const p = probe('p');
    await registerFromDoc(w.app, w.store, p.definition);
    await w.app.plugins.idle();
    expect(p.seen).toEqual([{ model: 'm1', apiKey: 'sk-PLACEHOLDER' }]);

    const result = await w.host().applyPluginConfig('p', { model: 'm1', apiKey: { $secret: 'k' } });
    expect(result).toEqual({ status: 'applied', reloaded: false });
    expect(p.seen).toHaveLength(1);
    expect(w.order).toEqual(['config']);
  });

  it('替换被共用的键：写进那个键，共用它的实例按新值重载', async () => {
    const shared = { apiKey: { $secret: 'shared' } };
    const w = world({ plugins: { a: { ...shared }, b: { ...shared } } }, { shared: 'old-PLACEHOLDER' });
    const a = probe('a');
    const b = probe('b');
    await registerFromDoc(w.app, w.store, a.definition);
    await registerFromDoc(w.app, w.store, b.definition);
    await w.app.plugins.idle();

    await w.host().applyPluginConfig('a', { apiKey: 'new-PLACEHOLDER' });
    await w.app.plugins.idle();
    expect(w.store.getPluginConfig('a')).toEqual(shared);
    expect(b.seen.at(-1)?.apiKey).toBe('new-PLACEHOLDER');
    expect(w.app.plugins.getPlugin('b')?.config).toMatchObject({ apiKey: 'new-PLACEHOLDER' });
  });

  it('新建后缀实例：按同模块定义登记、拿到解析后的值；core 不受理时撤回文档与密钥，返回 refused', async () => {
    const w = world({ plugins: { p: {} } });
    const p = probe('p', { reusable: true });
    await registerFromDoc(w.app, w.store, p.definition);
    await w.app.plugins.idle();

    const created = await w.host().applyPluginConfig('p:b', { apiKey: 'sk-PLACEHOLDER-B' });
    await w.app.plugins.idle();
    expect(created.status).toBe('applied');
    expect(w.app.plugins.getPlugin('p:b')?.state).toBe('active');
    expect(p.seen.at(-1)).toMatchObject({ apiKey: 'sk-PLACEHOLDER-B' });
    expect(w.store.getPluginConfig('p:b')).toEqual({ apiKey: { $secret: 'p:b.apiKey' } });

    const register = w.app.plugins.register.bind(w.app.plugins);
    w.app.plugins.register = async () => false;
    const refused = await w.host().applyPluginConfig('p:c', { apiKey: 'sk-PLACEHOLDER-C' });
    w.app.plugins.register = register;
    expect(refused).toEqual({ status: 'refused' });
    expect(Object.hasOwn(w.store.getAll().plugins, 'p:c')).toBe(false);
    expect(w.store.resolvePluginConfig('x', SCHEMA, { apiKey: { $secret: 'p:c.apiKey' } }).dangling).toHaveLength(1);
  });

  it('与运行态只差键序（表单按 schema 顺序重建分组）：不算改动，不重建插件', async () => {
    const w = world({ plugins: { p: { model: 'm1', apiKey: { $secret: 'k' } } } }, { k: 'v' });
    const p = probe('p');
    await registerFromDoc(w.app, w.store, p.definition);
    await w.app.plugins.idle();
    const result = await w.host().applyPluginConfig('p', { apiKey: { $secret: 'k' }, model: 'm1' });
    expect(result).toMatchObject({ reloaded: false });
    expect(p.seen).toHaveLength(1);
  });

  it('本次提交新引入的悬空引用拒收（运行态与文档都不动）；提交前就悬空、原样带回的放行', async () => {
    const w = world({ plugins: { p: { conns: [{ url: 'a', token: { $secret: 'was-dangling' } }] } } });
    await registerFromDoc(w.app, w.store, probe('p').definition);
    await w.app.plugins.idle();
    await expect(
      w.host().applyPluginConfig('p', {
        apiKey: { $secret: 'nowhere' },
        conns: [{ url: 'a', token: { $secret: 'was-dangling' } }],
      }),
    ).rejects.toThrow('apiKey（键 nowhere）');
    expect(w.store.getPluginConfig('p')).toEqual({ conns: [{ url: 'a', token: { $secret: 'was-dangling' } }] });
    const kept = await w.host().applyPluginConfig('p', {
      model: 'm2',
      conns: [{ url: 'a', token: { $secret: 'was-dangling' } }],
    });
    expect(kept.status).toBe('applied');
  });

  it('未登记、也没有可用定义的实例抛错（PUT 不经这里新建主实例）', async () => {
    const w = world({});
    await expect(w.host().applyPluginConfig('nobody', {})).rejects.toThrow('nobody 不存在');
  });

  it('落盘失败：改动已在运行态与文档里生效，saveError 带回失败', async () => {
    const w = world({ plugins: { p: {} } });
    const p = probe('p');
    await registerFromDoc(w.app, w.store, p.definition);
    await w.app.plugins.idle();
    w.failConfigSave.on = true;
    const result = await w.host().applyPluginConfig('p', { model: 'm9' });
    expect(result.status).toBe('applied');
    expect((result as { saveError?: Error }).saveError?.message).toBe('写盘失败');
    expect(w.store.getPluginConfig('p')).toEqual({ model: 'm9' });
  });
});

describe('插件拿到的 setPluginConfig 只收文档形态', () => {
  it('密钥字段上的明文（例如把 caps.config 写回）抛错并点名字段；引用与非密钥字段照写；查不到 schema 的照写', async () => {
    const w = world({ plugins: { p: {} } });
    await registerFromDoc(w.app, w.store, probe('p').definition);
    const host = w.host();
    expect(() => host.setPluginConfig('p', { apiKey: 'sk-PLACEHOLDER', conns: [{ token: 't' }] })).toThrow(
      'p 的 apiKey、conns.token 是密钥字段',
    );
    expect(w.store.getPluginConfig('p')).toEqual({});
    host.setPluginConfig('p', { apiKey: { $secret: 'k' }, model: 'm3', conns: [{ token: '' }] });
    expect(w.store.getPluginConfig('p')).toMatchObject({ model: 'm3' });
    host.setPluginConfig('unknown-plugin', { apiKey: 'whatever' });
    expect(w.store.getPluginConfig('unknown-plugin')).toEqual({ apiKey: 'whatever' });
  });
});

describe('孤儿键', () => {
  it('宿主经自己的写入换掉的键在文档落盘之后删除；仍被别处引用的、手加进存储还没人引用的不动', async () => {
    const w = world(
      {
        plugins: {
          p: { conns: [{ url: 'a', token: { $secret: 'old' } }] },
          q: { apiKey: { $secret: 'kept' } },
        },
      },
      { old: 'o', kept: 'k', handAdded: 'h' },
    );
    await registerFromDoc(w.app, w.store, probe('p').definition);
    await registerFromDoc(w.app, w.store, probe('q').definition);
    await w.app.plugins.idle();

    await w.host().applyPluginConfig('p', { conns: [{ url: 'a', token: 'new' }] });
    expect(w.savedSecrets.at(-1)).toEqual({ kept: 'k', handAdded: 'h', 'p.conns.token': 'new' });
    expect(w.order).toEqual(['secrets', 'config', 'secrets']);
  });

  it('文档没写成时不删（盘上旧文档可能还引用着），下一次成功落盘时再删；删实例同样', async () => {
    const w = world({ plugins: { p: { apiKey: { $secret: 'gone' } } } }, { gone: 'g' });
    const host = w.host();
    host.removePluginConfig('p');
    w.failConfigSave.on = true;
    await expect(host.save()).rejects.toThrow('写盘失败');
    expect(w.savedSecrets).toEqual([]);
    w.failConfigSave.on = false;
    await host.save();
    expect(w.savedSecrets).toEqual([{}]);
  });

  it('删孤儿键时写密钥失败：保存照常兑现（主配置已写成），键放回去，下次保存再删', async () => {
    const w = world({ plugins: { p: { apiKey: { $secret: 'gone' } } } }, { gone: 'g' });
    const host = w.host();
    host.removePluginConfig('p');
    w.failSecretsSave.times = 1;
    await expect(host.save()).resolves.toBeUndefined();
    expect(w.savedConfigs).toHaveLength(1);
    expect(w.savedSecrets).toEqual([]);
    expect(w.store.resolvePluginConfig('x', SCHEMA, { apiKey: { $secret: 'gone' } }).dangling).toEqual([]);
    await host.save();
    expect(w.savedSecrets).toEqual([{}]);
  });

  it('宿主新建、后来又没人引用的键同样删掉（密钥写成、主配置被拒后按文件对账回到旧引用）', async () => {
    const w = world({ plugins: { p: { conns: [{ url: 'a', token: { $secret: 'old' } }] } } }, { old: 'o' });
    await registerFromDoc(w.app, w.store, probe('p').definition);
    await w.app.plugins.idle();
    w.store.watch(() => {});
    w.failConfigSave.on = true;
    const result = await w.host().applyPluginConfig('p', { conns: [{ url: 'a', token: 'typed' }] });
    expect((result as { saveError?: Error }).saveError?.message).toBe('写盘失败');
    expect(w.savedSecrets.at(-1)).toEqual({ old: 'o', 'p.conns.token': 'typed' });
    // 修好之后按文件对账：文档回到引用 old
    w.emit.config?.({
      name: 'T',
      logLevel: 'error',
      plugins: { p: { conns: [{ url: 'a', token: { $secret: 'old' } }] } },
    });
    w.failConfigSave.on = false;
    await w.host().save();
    expect(w.savedSecrets.at(-1)).toEqual({ old: 'o' });
  });

  it('手改配置文件去掉引用（经 watch 整份替换）不触发删除', async () => {
    const w = world({ plugins: { p: { apiKey: { $secret: 'k' } } } }, { k: 'v' });
    w.store.watch(() => {});
    w.emit.config?.({ name: 'T', logLevel: 'error', plugins: { p: {} } });
    await w.host().save();
    expect(w.savedSecrets).toEqual([]);
  });
});

describe('登记、同步与热重载', () => {
  function loaderOf(definitions: PluginDefinition[]): PluginLoader {
    return {
      discover: async () => definitions.map(d => ({ name: d.name, source: d.name })),
      load: async d => definitions.find(def => def.name === d.name) ?? null,
    };
  }

  it('悬空引用：登记时记 error 点名键，插件激活失败、消息点名键名（有 default 也不回落）', async () => {
    const w = world({ plugins: { p: { apiKey: { $secret: 'missing-key' } } } });
    const p = probe('p');
    const discovery = createPluginDiscovery(w.app, loaderOf([p.definition]), w.store);
    await discovery.loadAll();
    expect(w.lines.some(l => l.startsWith('error') && l.includes('missing-key'))).toBe(true);
    const entry = w.app.plugins.getPlugin('p');
    expect(entry?.state).toBe('error');
    expect(entry?.error).toContain('missing-key');
  });

  it('诊断里报出悬空引用（不走 parseConfig 的插件拿到引用对象不会激活失败）；都解析得到时报 ok', async () => {
    const w = world(
      { plugins: { p: { apiKey: { $secret: 'missing-key' } }, q: { apiKey: { $secret: 'k' } } } },
      { k: 'v' },
    );
    await registerFromDoc(w.app, w.store, probe('p').definition);
    await registerFromDoc(w.app, w.store, probe('q').definition);
    const checks: CheckSpec[] = [];
    w.app.bind({ provide }).provide(doctor, {
      registerCheck: (spec: CheckSpec) => {
        checks.push(spec);
        return () => {};
      },
    } as unknown as DoctorService);
    await new Promise(resolve => setTimeout(resolve, 0));
    const check = checks.find(c => c.id === 'config.secrets');
    expect(await check?.run()).toEqual([
      {
        id: 'config.secrets.p',
        category: 'config',
        level: 'error',
        message:
          'p 引用的密钥不在 secrets.yaml 里：apiKey（键 missing-key）；用 parseConfig 读配置的插件会激活失败，在 WebUI 重新填写或在 secrets.yaml 里补上这些键',
      },
    ]);
    await w.host().applyPluginConfig('p', { apiKey: 'fixed-PLACEHOLDER' });
    expect(await check?.run()).toMatchObject({ id: 'config.secrets', level: 'ok' });
  });

  it('配置同步把文档里的明文移进密钥存储：插件拿到原值，落盘的文档只有引用，日志只写路径与键', async () => {
    const w = world({
      plugins: { p: { apiKey: 'sk-PLACEHOLDER-HAND', conns: [{ url: 'u', token: 'tok-PLACEHOLDER' }] } },
    });
    const p = probe('p');
    const prepared = withPluginConfigSync(loaderOf([p.definition]), w.app, w.store);
    try {
      await createPluginDiscovery(w.app, prepared.loader, w.store).loadAll();
    } finally {
      prepared.finishInitialLoad();
    }
    await w.app.plugins.idle();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(p.seen).toEqual([
      { apiKey: 'sk-PLACEHOLDER-HAND', model: 'm1', conns: [{ url: 'u', token: 'tok-PLACEHOLDER' }] },
    ]);
    expect(w.savedConfigs.at(-1)?.plugins.p).toEqual({
      apiKey: { $secret: 'p.apiKey' },
      model: 'm1',
      conns: [{ url: 'u', token: { $secret: 'p.conns.token' } }],
    });
    expect(w.order).toEqual(['secrets', 'config']);
    const moved = w.lines.filter(l => l.includes('移进 secrets.yaml'));
    expect(moved).toEqual([
      'info 配置同步：已把 p 的 apiKey 移进 secrets.yaml（键 p.apiKey）',
      'info 配置同步：已把 p 的 conns.token 移进 secrets.yaml（键 p.conns.token）',
    ]);
    expect(w.lines.join('\n')).not.toContain('PLACEHOLDER');
  });

  it('密钥文件重新读入时，已提交、还没写成的值并进新内容，文档里的引用不会落空', async () => {
    const w = world({ plugins: { p: {} } }, { other: 'x' });
    await registerFromDoc(w.app, w.store, probe('p').definition);
    await w.app.plugins.idle();
    w.store.watch(() => {});
    w.failSecretsSave.times = 1;
    const result = await w.host().applyPluginConfig('p', { apiKey: 'typed-PLACEHOLDER' });
    expect((result as { saveError?: unknown }).saveError).toBeDefined();
    expect(w.savedConfigs).toEqual([]);
    // 用户修好密钥文件：重新读入盘上内容（没有新键）
    w.emit.secrets?.({ other: 'x', added: 'y' });
    expect(w.store.resolvePluginConfig('p', SCHEMA).config).toEqual({ apiKey: 'typed-PLACEHOLDER' });
    await w.host().save();
    expect(w.savedSecrets.at(-1)).toEqual({ other: 'x', added: 'y', 'p.apiKey': 'typed-PLACEHOLDER' });
    expect(w.savedConfigs.at(-1)?.plugins.p).toEqual({ apiKey: { $secret: 'p.apiKey' } });
  });

  it('配置会落盘、密钥存储却不能保存时拒绝组装', () => {
    expect(() => createConfigStore({}, { save: () => {} }, { values: {} })).toThrow('密钥存储却不能保存');
    expect(() => createConfigStore({}, undefined, { values: {} })).not.toThrow();
  });

  it('secrets.yaml 外部变更：只重载解析结果变了的实例', async () => {
    const w = world(
      // 文档里已有默认值：热重载的同步不回填，只看密钥的变化
      { plugins: { a: { apiKey: { $secret: 'ka' }, model: 'm1' }, b: { apiKey: { $secret: 'kb' }, model: 'm1' } } },
      { ka: 'a1', kb: 'b1' },
    );
    const a = probe('a');
    const b = probe('b');
    const discovery = createPluginDiscovery(w.app, loaderOf([a.definition, b.definition]), w.store);
    await discovery.loadAll();
    installConfigHotReload(w.app, w.store, discovery);
    w.emit.secrets?.({ ka: 'a2', kb: 'b1' });
    await new Promise(resolve => setTimeout(resolve, 10));
    await w.app.plugins.idle();
    expect(a.seen.map(c => c.apiKey)).toEqual(['a1', 'a2']);
    expect(b.seen.map(c => c.apiKey)).toEqual(['b1']);
  });
});
