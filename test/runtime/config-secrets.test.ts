import { afterEach, describe, expect, it } from 'vitest';
import { type CheckSpec, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import {
  type AalisConfig,
  ConfigSaveRefusedError,
  type HostConfig,
  hostConfig,
  isConfigSaveRefused,
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
import { deferred } from '../helpers/deferred.js';

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
  // 密钥文件下一次（或接下来几次）保存失败：缺省模拟盘上有尚未生效的外部修改而拒写，refused 为 false 时是写入失败
  const failSecretsSave = { times: 0, refused: true };
  // 设上之后的下一次保存挂起到它兑现：快照在调用时拍下，兑现后才记为写成（模拟异步 provider）
  const hold: { config?: Promise<void>; secrets?: Promise<void> } = {};
  const emit: { config?: (next: AalisConfig) => void; secrets?: (next: Record<string, unknown>) => void } = {};
  const { logger, lines } = recorder();
  const { app, store } = hostedApp(doc, {
    logger,
    provider: {
      save: snapshot => {
        if (failConfigSave.on) throw new Error('写盘失败');
        const copy = structuredClone(snapshot);
        const done = () => {
          order.push('config');
          savedConfigs.push(copy);
        };
        const gate = hold.config;
        hold.config = undefined;
        if (gate) return gate.then(done);
        done();
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
            if (!failSecretsSave.refused) throw new Error('写盘失败');
            throw new ConfigSaveRefusedError('密钥文件有尚未生效的外部修改，为免覆盖已拒绝本次保存');
          }
          const copy = structuredClone(values);
          const done = () => {
            order.push('secrets');
            savedSecrets.push(copy);
          };
          const gate = hold.secrets;
          hold.secrets = undefined;
          if (gate) return gate.then(done);
          done();
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
  return { app, store, host, order, savedConfigs, savedSecrets, failConfigSave, failSecretsSave, hold, emit, lines };
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
    expect(w.lines).toContain('info 已把 p 的 apiKey 写进 secrets.yaml（键 p.apiKey）');
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

  it('共用这个键的实例处于禁用态：只换上新值、保持禁用，日志与热重载同一说法', async () => {
    const shared = { apiKey: { $secret: 'shared' } };
    const w = world(
      { plugins: { a: { ...shared }, b: { ...shared } }, disabledPlugins: ['b'] },
      { shared: 'old-PLACEHOLDER' },
    );
    const b = probe('b');
    await registerFromDoc(w.app, w.store, probe('a').definition);
    await registerFromDoc(w.app, w.store, b.definition);
    await w.app.plugins.idle();

    await w.host().applyPluginConfig('a', { apiKey: 'new-PLACEHOLDER' });
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('b')?.state).toBe('disabled');
    expect(w.app.plugins.getPlugin('b')?.config).toMatchObject({ apiKey: 'new-PLACEHOLDER' });
    expect(b.seen).toEqual([]);
    expect(w.lines.filter(l => l.includes('共用的密钥'))).toEqual([
      'info 插件 b 共用的密钥已更改；插件已禁用，启用时按新配置激活',
    ]);
  });

  it('落盘被拒：不记「已把……写进 secrets.yaml」，值这时只在内存里', async () => {
    const w = world({ plugins: { p: {} } });
    await registerFromDoc(w.app, w.store, probe('p').definition);
    await w.app.plugins.idle();
    w.failSecretsSave.times = 1;
    const result = await w.host().applyPluginConfig('p', { apiKey: 'typed-PLACEHOLDER' });
    expect(isConfigSaveRefused((result as { saveError?: unknown }).saveError)).toBe(true);
    expect(w.lines.filter(l => l.includes('写进 secrets.yaml'))).toEqual([]);
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

  it('配置里有 NaN（YAML 的 .nan）：原样提交与运行态比较算相同，不重建插件', async () => {
    const w = world({ plugins: { n: { ratio: Number.NaN } } });
    let applied = 0;
    const n = definePlugin({
      name: 'n',
      apply() {
        applied++;
      },
    });
    await registerFromDoc(w.app, w.store, n);
    await w.app.plugins.idle();
    const result = await w.host().applyPluginConfig('n', { ratio: Number.NaN });
    expect(result).toMatchObject({ reloaded: false });
    expect(applied).toBe(1);
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

  it('set 不能整块替换 plugins（会绕过上面的形态检查与孤儿键记账）；别的顶层字段照写', async () => {
    const w = world({ plugins: { p: { apiKey: { $secret: 'k' } } } }, { k: 'v' });
    await registerFromDoc(w.app, w.store, probe('p').definition);
    const host = w.host();
    expect(() => host.set('plugins', { p: { apiKey: 'sk-PLACEHOLDER' } })).toThrow('plugins 不能整块替换');
    expect(w.store.getPluginConfig('p')).toEqual({ apiKey: { $secret: 'k' } });
    host.set('name', 'renamed');
    expect(w.store.get('name')).toBe('renamed');
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

  it('写主配置途中文档又去掉了引用：刚写出的那份还引用着，键留到下一次落盘之后再删', async () => {
    const w = world({ plugins: { p: { apiKey: { $secret: 'k' } } } }, { k: 'v' });
    const gate = deferred();
    w.hold.config = gate.promise;
    const saving = w.store.persist();
    w.store.removePluginConfig('p');
    gate.resolve();
    await saving;
    expect(w.savedConfigs.at(-1)?.plugins.p, '盘上的主配置还引用着 k').toEqual({ apiKey: { $secret: 'k' } });
    expect(w.savedSecrets, '不能先删').toEqual([]);
    await w.store.persist();
    expect(w.savedSecrets).toEqual([{}]);
  });

  it('写主配置途中才被新引用的键：刚写出的那份还没引用它，留作候选；引用随后随文件回退，下一次落盘之后删', async () => {
    const w = world({ plugins: { p: { apiKey: { $secret: 'old' } } } }, { old: 'o' });
    w.store.watch(() => {});
    const gate = deferred();
    w.hold.config = gate.promise;
    const saving = w.store.persist();
    // 落盘途中另一次提交新建键 k 并引用它，它的主配置随后没写成
    w.store.commitSecrets(new Map([['k', 'k-PLACEHOLDER']]));
    w.store.setPluginConfig('q', { apiKey: { $secret: 'k' } });
    w.failConfigSave.on = true;
    await expect(w.store.persist()).rejects.toThrow('写盘失败');
    gate.resolve();
    await saving;
    // 修好之后按文件对账：文档回到没有 q 的那一份，k 没人引用了
    w.emit.config?.({ name: 'T', logLevel: 'error', plugins: { p: { apiKey: { $secret: 'old' } } } });
    w.failConfigSave.on = false;
    await w.store.persist();
    expect(w.savedSecrets.at(-1)).toEqual({ old: 'o' });
  });
});

describe('写密钥文件途中的提交', () => {
  it('写成后只清掉这次写出去的：途中提交的密钥下一次保存照样写出，主配置的引用不会落空', async () => {
    const w = world({ plugins: {} });
    const gate = deferred();
    w.hold.secrets = gate.promise;
    w.store.commitSecrets(new Map([['a', 'a-PLACEHOLDER']]));
    w.store.setPluginConfig('p', { apiKey: { $secret: 'a' } });
    const saving = w.store.persist();
    w.store.commitSecrets(new Map([['b', 'b-PLACEHOLDER']]));
    w.store.setPluginConfig('q', { apiKey: { $secret: 'b' } });
    gate.resolve();
    await saving;
    expect(w.savedSecrets).toEqual([{ a: 'a-PLACEHOLDER' }]);
    await w.store.persist();
    expect(w.savedSecrets.at(-1)).toEqual({ a: 'a-PLACEHOLDER', b: 'b-PLACEHOLDER' });
  });

  it('途中另一次保存被拒：这次写成不清掉拒写标记，之后的密钥文件变更照样按文件对账，被拒的密钥作废', async () => {
    const w = world({ plugins: {} });
    w.store.watch(() => {});
    const gate = deferred();
    w.hold.secrets = gate.promise;
    w.store.commitSecrets(new Map([['a', 'a-PLACEHOLDER']]));
    w.store.setPluginConfig('p', { apiKey: { $secret: 'a' } });
    const saving = w.store.persist();
    w.failSecretsSave.times = 1;
    w.store.commitSecrets(new Map([['b', 'b-PLACEHOLDER']]));
    w.store.setPluginConfig('q', { apiKey: { $secret: 'b' } });
    await expect(w.store.persist()).rejects.toSatisfy(isConfigSaveRefused);
    gate.resolve();
    await saving;
    w.emit.secrets?.({ a: 'a-PLACEHOLDER', added: 'y' });
    expect(
      w.store.resolvePluginConfig('x', SCHEMA, { apiKey: { $secret: 'b' } }).dangling,
      'b 没写成，作废',
    ).toHaveLength(1);
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

  it('配置同步落盘被拒或写失败：不记「已移进 secrets.yaml」，只记没落盘', async () => {
    // 首次加载批次：密钥文件拒写
    const w = world({ plugins: { p: { apiKey: 'sk-PLACEHOLDER-HAND' } } });
    w.failSecretsSave.times = 1;
    const prepared = withPluginConfigSync(loaderOf([probe('p').definition]), w.app, w.store);
    try {
      await createPluginDiscovery(w.app, prepared.loader, w.store).loadAll();
    } finally {
      prepared.finishInitialLoad();
    }
    await w.app.plugins.idle();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(w.savedConfigs).toEqual([]);
    expect(w.lines.filter(l => l.includes('移进 secrets.yaml'))).toEqual([]);
    expect(w.lines.filter(l => l.startsWith('warn 配置同步未落盘'))).toHaveLength(1);

    // 热重载：密钥文件写失败
    const h = world({ plugins: { p: {} } });
    const discovery = createPluginDiscovery(h.app, loaderOf([probe('p').definition]), h.store);
    await discovery.loadAll();
    installConfigHotReload(h.app, h.store, discovery);
    h.failSecretsSave.times = 1;
    h.failSecretsSave.refused = false;
    h.emit.config?.({ name: 'T', logLevel: 'error', plugins: { p: { apiKey: 'sk-PLACEHOLDER-NEW' } } });
    await new Promise(resolve => setTimeout(resolve, 10));
    await h.app.plugins.idle();
    expect(h.savedConfigs).toEqual([]);
    expect(h.lines.filter(l => l.includes('移进 secrets.yaml'))).toEqual([]);
    expect(h.lines.filter(l => l.startsWith('warn 配置同步落盘失败'))).toHaveLength(1);
  });

  it('首次加载之后热扫描新装的插件：同步把明文移进密钥存储，落盘写成之后记「已移进 secrets.yaml」', async () => {
    const w = world({ plugins: { p: {}, q: { apiKey: 'sk-PLACEHOLDER-LATE' } } });
    const definitions = [probe('p').definition];
    const prepared = withPluginConfigSync(loaderOf(definitions), w.app, w.store);
    const discovery = createPluginDiscovery(w.app, prepared.loader, w.store);
    try {
      await discovery.loadAll();
    } finally {
      prepared.finishInitialLoad();
    }
    await w.app.plugins.idle();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(w.lines.filter(l => l.includes('移进 secrets.yaml'))).toEqual([]);

    const q = probe('q');
    definitions.push(q.definition);
    expect(await discovery.rescan()).toEqual(['q']);
    await w.app.plugins.idle();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(q.seen).toEqual([{ apiKey: 'sk-PLACEHOLDER-LATE', model: 'm1' }]);
    expect(w.savedConfigs.at(-1)?.plugins.q).toEqual({ apiKey: { $secret: 'q.apiKey' }, model: 'm1' });
    expect(w.lines.filter(l => l.includes('移进 secrets.yaml'))).toEqual([
      'info 配置同步：已把 q 的 apiKey 移进 secrets.yaml（键 q.apiKey）',
    ]);
  });

  it('写密钥文件失败（不是拒写）后文件被外部改动：已提交、还没写成的值并进新内容，文档里的引用不会落空，下次保存写入', async () => {
    const w = world({ plugins: { p: {} } }, { other: 'x' });
    await registerFromDoc(w.app, w.store, probe('p').definition);
    await w.app.plugins.idle();
    w.store.watch(() => {});
    w.failSecretsSave.times = 1;
    w.failSecretsSave.refused = false;
    const result = await w.host().applyPluginConfig('p', { apiKey: 'typed-PLACEHOLDER' });
    expect((result as { saveError?: Error }).saveError?.message).toBe('写盘失败');
    expect(w.savedConfigs).toEqual([]);
    w.emit.secrets?.({ other: 'x', added: 'y' });
    expect(w.store.resolvePluginConfig('p', SCHEMA).config).toEqual({ apiKey: 'typed-PLACEHOLDER' });
    await w.host().save();
    expect(w.savedSecrets.at(-1)).toEqual({ other: 'x', added: 'y', 'p.apiKey': 'typed-PLACEHOLDER' });
    expect(w.savedConfigs.at(-1)?.plugins.p).toEqual({ apiKey: { $secret: 'p.apiKey' } });
  });

  it('密钥文件拒写之后修好：同主配置拒写，按文件对账——没写成的密钥作废、文档退回文件上那一份，插件按文件重载', async () => {
    const w = world({ plugins: { p: { apiKey: { $secret: 'k' } }, q: {} } }, { k: 'v1-PLACEHOLDER' });
    const p = probe('p');
    const q = probe('q');
    const discovery = createPluginDiscovery(w.app, loaderOf([p.definition, q.definition]), w.store);
    await discovery.loadAll();
    installConfigHotReload(w.app, w.store, discovery);
    w.failSecretsSave.times = 2;
    // 替换已有的键、新建一个键，两次都被拒：运行态已换上，文件都没动
    await w.host().applyPluginConfig('p', { apiKey: 'v3-PLACEHOLDER' });
    await w.host().applyPluginConfig('q', { apiKey: 'typed-PLACEHOLDER' });
    await w.app.plugins.idle();
    expect(p.seen.at(-1)?.apiKey).toBe('v3-PLACEHOLDER');
    expect(w.store.getPluginConfig('q')).toEqual({ apiKey: { $secret: 'q.apiKey' } });

    // 用户修好密钥文件，同一个键写了自己的值
    w.emit.secrets?.({ k: 'v2-PLACEHOLDER' });
    await new Promise(resolve => setTimeout(resolve, 10));
    await w.app.plugins.idle();
    expect(p.seen.at(-1)?.apiKey, '文件里的值生效').toBe('v2-PLACEHOLDER');
    expect(q.seen.at(-1)?.apiKey, '没写成的新键作废').toBeUndefined();
    expect(w.store.getPluginConfig('q'), '文档退回文件上那一份（热重载补上默认值），不留指向作废键的引用').toEqual({
      model: 'm1',
    });
    expect(w.lines.filter(l => l.startsWith('error'))).toEqual([]);

    // 之后的保存不覆盖文件里的值
    await w.host().save();
    expect(w.savedSecrets).toEqual([]);
    expect(w.store.resolvePluginConfig('p', SCHEMA).config).toEqual({ apiKey: 'v2-PLACEHOLDER', model: 'm1' });
  });

  it.each([
    [
      '写出（经宿主保存成功）',
      async (w: ReturnType<typeof world>) => {
        await w.host().applyPluginConfig('p', { model: 'm2' });
        expect(w.savedConfigs.at(-1)?.plugins.p).toEqual({ model: 'm2' });
      },
    ],
    [
      '读入（手改配置文件）',
      async (w: ReturnType<typeof world>) => {
        w.emit.config?.({ name: 'T', logLevel: 'error', plugins: { p: { model: 'm2' }, q: { model: 'm1' } } });
        await new Promise(resolve => setTimeout(resolve, 10));
      },
    ],
  ])('密钥文件拒写之后修好：文档退回的是配置文件上最后%s的那一份，不是启动时的', async (_label, touchFile) => {
    const w = world({ plugins: { p: { model: 'm1' }, q: { model: 'm1' } } });
    const p = probe('p');
    const discovery = createPluginDiscovery(w.app, loaderOf([p.definition, probe('q').definition]), w.store);
    await discovery.loadAll();
    installConfigHotReload(w.app, w.store, discovery);
    await touchFile(w);
    await w.app.plugins.idle();
    w.failSecretsSave.times = 1;
    await w.host().applyPluginConfig('q', { apiKey: 'typed-PLACEHOLDER' });
    w.emit.secrets?.({});
    await new Promise(resolve => setTimeout(resolve, 10));
    await w.app.plugins.idle();
    expect(w.store.getPluginConfig('p')).toEqual({ model: 'm2' });
    expect(w.store.getPluginConfig('q')).toEqual({ model: 'm1' });
    expect(p.seen.at(-1)?.model).toBe('m2');
  });

  it('配置不落盘的宿主：密钥文件拒写之后修好，只作废没写成的密钥，文档不动（没有文件上的那一份可退）', async () => {
    let emitSecrets: ((next: Record<string, unknown>) => void) | undefined;
    const store = createConfigStore({ name: 'T', logLevel: 'error', plugins: { p: {} } }, undefined, {
      values: {},
      provider: {
        save: () => {
          throw new ConfigSaveRefusedError('密钥文件有尚未生效的外部修改，为免覆盖已拒绝本次保存');
        },
        watch: cb => {
          emitSecrets = cb;
          return () => {};
        },
      },
    });
    store.watch(() => {});
    store.commitSecrets(new Map([['p.apiKey', 'typed-PLACEHOLDER']]));
    store.setPluginConfig('p', { apiKey: { $secret: 'p.apiKey' } });
    store.set('name', 'renamed');
    await expect(store.persist()).rejects.toSatisfy(isConfigSaveRefused);
    emitSecrets?.({ other: 'x' });
    expect(store.get('name')).toBe('renamed');
    expect(store.getPluginConfig('p')).toEqual({ apiKey: { $secret: 'p.apiKey' } });
    expect(store.resolvePluginConfig('p', SCHEMA).dangling, '没写成的密钥作废').toHaveLength(1);
  });

  it('密钥文件拒写之后又保存成功（文件被原样改回）：不再按文件对账，之后无关的外部改动不撤掉文档里没保存的改动', async () => {
    const w = world({ plugins: { p: {} } }, { other: 'x' });
    await registerFromDoc(w.app, w.store, probe('p').definition);
    await w.app.plugins.idle();
    w.store.watch(() => {});
    w.failSecretsSave.times = 1;
    await w.host().applyPluginConfig('p', { apiKey: 'typed-PLACEHOLDER' });
    await w.host().save();
    expect(w.savedSecrets.at(-1)).toEqual({ other: 'x', 'p.apiKey': 'typed-PLACEHOLDER' });
    w.host().set('name', 'renamed');
    w.emit.secrets?.({ other: 'x', 'p.apiKey': 'typed-PLACEHOLDER', added: 'y' });
    expect(w.store.get('name')).toBe('renamed');
    expect(w.store.getPluginConfig('p')).toEqual({ apiKey: { $secret: 'p.apiKey' } });
  });

  it('运行中把引用改成明文：写进原来那个键（同 WebUI 替换），旧值不留在 secrets.yaml', async () => {
    const w = world({ plugins: { p: { apiKey: { $secret: 'k' }, model: 'm1' } } }, { k: 'old-PLACEHOLDER' });
    const p = probe('p');
    const discovery = createPluginDiscovery(w.app, loaderOf([p.definition]), w.store);
    await discovery.loadAll();
    installConfigHotReload(w.app, w.store, discovery);

    w.emit.config?.({ name: 'T', logLevel: 'error', plugins: { p: { apiKey: 'new-PLACEHOLDER', model: 'm1' } } });
    await new Promise(resolve => setTimeout(resolve, 10));
    await w.app.plugins.idle();
    expect(w.store.getPluginConfig('p')).toEqual({ apiKey: { $secret: 'k' }, model: 'm1' });
    expect(w.savedSecrets.at(-1)).toEqual({ k: 'new-PLACEHOLDER' });
    expect(w.savedConfigs.at(-1)?.plugins.p).toEqual({ apiKey: { $secret: 'k' }, model: 'm1' });
    expect(p.seen.at(-1)?.apiKey).toBe('new-PLACEHOLDER');
    expect(w.lines).toContain('info 配置同步：已把 p 的 apiKey 移进 secrets.yaml（键 k）');
  });

  it('主实例已卸载、后缀实例还在册：文件里新加的后缀实例在同一轮热重载里补默认值、明文移进 secrets.yaml', async () => {
    const w = world({ plugins: { p: {}, 'p:b': {} } });
    const p = probe('p', { reusable: true });
    const discovery = createPluginDiscovery(w.app, loaderOf([p.definition]), w.store);
    await discovery.loadAll();
    await w.app.plugins.unload('p');
    installConfigHotReload(w.app, w.store, discovery);

    w.emit.config?.({ name: 'T', logLevel: 'error', plugins: { 'p:b': {}, 'p:c': { apiKey: 'sk-PLACEHOLDER-C' } } });
    await new Promise(resolve => setTimeout(resolve, 10));
    await w.app.plugins.idle();
    expect(w.store.getPluginConfig('p:c')).toEqual({ apiKey: { $secret: 'p:c.apiKey' }, model: 'm1' });
    expect(w.app.plugins.getPlugin('p:c')?.state).toBe('active');
    expect(p.seen.at(-1)).toMatchObject({ apiKey: 'sk-PLACEHOLDER-C', model: 'm1' });
  });

  it('配置里有 NaN（YAML 的 .nan）：与运行态比较算相同，无关的变更不重建插件', async () => {
    const w = world({ plugins: { n: { ratio: Number.NaN } } });
    let applied = 0;
    const n = definePlugin({
      name: 'n',
      apply() {
        applied++;
      },
    });
    const discovery = createPluginDiscovery(w.app, loaderOf([n]), w.store);
    await discovery.loadAll();
    installConfigHotReload(w.app, w.store, discovery);
    w.emit.secrets?.({ unrelated: 'x' });
    await new Promise(resolve => setTimeout(resolve, 10));
    await w.app.plugins.idle();
    expect(applied).toBe(1);
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
