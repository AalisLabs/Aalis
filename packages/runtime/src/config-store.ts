// ============================================================
// config-store —— 宿主配置文档（内存态 + 危险键闸 + 落盘委托）、密钥存储与 host-config 服务
//
// 运行态（实例配置、禁用态、服务偏好）在 core；本模块持「下次启动用什么」的文档：
//   - 启动：宿主从文档取每个实例的配置（解析密钥引用后）与禁用标记交给 app.pluginAll，偏好经根绑定 services.prefer 应用；
//   - 运行：改插件配置经 host-config 的 applyPluginConfig 一步完成；启停、偏好等管理动作只改运行态，
//     要跨重启保留的调用方经 host-config 自己写文档并 save()。
// 文档是文档形态：schema 里 `secret: true` 的字段只放引用 `{ $secret: '<键>' }`，值在密钥存储里（见 secrets.ts）。
// 本模块不碰文件：持久化与外部变更监听由注入的 provider 完成。
// ============================================================

import { isDeepStrictEqual } from 'node:util';
import { type CheckResult, doctor } from '@aalis/api-doctor';
import {
  type AalisConfig,
  type ApplyPluginConfigResult,
  type HostConfig,
  hostConfig,
  isConfigSaveRefused,
} from '@aalis/api-host-config';
import { type App, events, type PluginDefinition, parseInstanceId, provide, services } from '@aalis/core';
import {
  CORE_CONFIG_SCHEMA,
  type ConfigSchema,
  cloneConfigObject,
  defaultsFrom,
  isUnsafeConfigKey,
} from '@aalis/schema-config';
import { type ConfigSyncOptions, configToReload } from './config-sync.js';
import { moduleDefinitionOf } from './plugin-discovery.js';
import {
  describeDangling,
  plainSecretPaths,
  type ResolvedSecrets,
  referencedKeys,
  resolveSecrets,
  type SplitSecrets,
  splitSecrets,
} from './secrets.js';

/**
 * 配置提供者：负责持久化层。文档由宿主在构造前自己加载好传入，provider 不必提供 load()。
 */
export interface ConfigProvider {
  /**
   * 持久化当前完整文档。不提供表示宿主不持久化（内存配置 / 只读部署），save() 立即兑现、不写盘。
   * 不排队也不去重：上一次未结束时可能再次被调用，实现须可重入；传入的是活对象，
   * 跨 await 使用须自行复制；写的原子性与外部编辑的合并由实现自负。
   */
  save?(config: AalisConfig): void | Promise<void>;
  /** 订阅外部对配置源的变更；返回 dispose */
  watch?(onChange: (next: AalisConfig) => void): () => void;
}

/** 密钥存储的持久化层（Node 宿主是家目录的 secrets.yaml）。约定同 {@link ConfigProvider} */
export interface SecretProvider {
  save?(values: Record<string, unknown>): void | Promise<void>;
  watch?(onChange: (next: Record<string, unknown>) => void): () => void;
}

/**
 * 宿主持有的配置文档。读写方法与插件经 host-config 看到的相同（写方法这里不检查形态，宿主自己的同步先拆后写）；
 * 落盘、外部变更监听与密钥的换算只给宿主：
 * `persist()` 是裸落盘，不记日志，先写密钥再写文档，兑现值表示文档是否交给了 provider 落盘（provider 不提供 save
 * 时为 false），失败原样以拒绝传出。插件拿到的 `save()` 由 {@link installHostConfig} 包上日志与「拒绝已处理」，
 * 两者名字不同，本对象因此不能被误当成 HostConfig 直接交出去。
 * 裁剪政策 `trimUnknownFields` 是宿主的同步政策、不属文档，同样由 {@link installHostConfig} 填入。
 */
export interface ConfigStore extends Omit<HostConfig, 'save' | 'trimUnknownFields' | 'applyPluginConfig'> {
  persist(): Promise<boolean>;
  /**
   * 订阅外部变更（配置文件或密钥文件；新内容已过同一道闸替换进来后回调，参数是替换前的文档）；单订阅者，返回退订。
   * 密钥文件拒写之后的那次变更按文件对账，同主配置拒写：还没写成的密钥作废，文档退回配置文件上最后读入或写出的那一份
   */
  watch(onChange: (previous: Readonly<AalisConfig>) => void): () => void;
  unwatch(): void;
  /** 宿主有没有密钥存储：没有时密钥照旧以明文留在文档里，不拆 */
  readonly hasSecretStore: boolean;
  /**
   * 文档形态解析成运行态：`doc` 缺省取该实例在文档里的配置；`staged` 是还没提交的写入，优先于存储。
   * 悬空的引用原样留着并列在 dangling 里
   */
  resolvePluginConfig(
    instanceId: string,
    schema: ConfigSchema | undefined,
    doc?: Record<string, unknown>,
    staged?: ReadonlyMap<string, unknown>,
  ): ResolvedSecrets;
  /**
   * 提交的配置拆成文档形态（见 secrets.ts 的 splitSecrets）。`base` 是改动前的文档，缺省取该实例当前的文档。
   * 只暂存、不写存储；没有密钥存储时原样返回
   */
  splitPluginSecrets(
    instanceId: string,
    schema: ConfigSchema | undefined,
    submitted: Record<string, unknown>,
    base?: Record<string, unknown>,
  ): SplitSecrets;
  /** 把暂存的写入提交进密钥存储，返回撤回函数（恢复写之前的值） */
  commitSecrets(writes: ReadonlyMap<string, unknown>): () => void;
}

/**
 * 插件 id 不得当 `plugins` / 禁用名单的对象键——那三条会落到原型链。
 * 按 id 取放的入口共用这一抛错，文案给 WebUI 映射 400。
 */
function assertSafePluginId(id: string): void {
  if (isUnsafeConfigKey(id)) throw new Error(`插件 id 不合法: ${id}`);
}

export interface SecretStoreInit {
  values: Record<string, unknown>;
  provider?: SecretProvider;
}

/**
 * @param secrets 宿主的密钥存储；不给时没有密钥存储（嵌入式宿主、只在内存里的配置），密钥照旧以明文留在文档里
 */
export function createConfigStore(
  initial: Partial<AalisConfig>,
  provider?: ConfigProvider,
  secrets?: SecretStoreInit,
): ConfigStore {
  // 配置会落盘、密钥却不能：引用写进文件，值只在内存里，重启后全部落空
  if (secrets && !secrets.provider?.save && provider?.save) {
    throw new Error(
      '配置文档会落盘、密钥存储却不能保存：引用会在重启后落空。给密钥存储一个能保存的 provider，或者不给密钥存储',
    );
  }
  let config = normalize(initial);
  // 配置文件上的那一份（最后读入或写出的）：密钥文件拒写之后按文件对账时，文档退回这一份
  let fileDoc = snapshot(config);
  let values = secretMap(secrets?.values ?? {});
  // 已提交、还没写进密钥文件的值：密钥文件在这期间被外部改动重新读入时并进新内容，文档里的引用可能正指着它们
  const pending = new Map<string, unknown>();
  // 密钥文件拒写过：下一次密钥文件变更按文件对账，不再并进 pending（见 watch）。refusedGen 是拒写的代数：
  // 写成的那次保存只在它写盘期间没有新的拒写时清标志，并发的另一次保存被拒时标志留着
  let secretsRefused = false;
  let refusedGen = 0;
  // 宿主经自己的写入换掉、删掉或新建的键：文档落盘之后，不再被任何配置引用的就从密钥存储里删掉。
  // 手改配置文件不经这里，不触发删除；手加进 secrets.yaml 还没被引用的键也不在其中
  const orphanCandidates = new Set<string>();
  const unwatchFns: Array<() => void> = [];
  let onChangeCallback: ((previous: Readonly<AalisConfig>) => void) | null = null;
  const markReplaced = (instanceId: string) => {
    if (Object.hasOwn(config.plugins, instanceId)) referencedKeys(config.plugins[instanceId], orphanCandidates);
  };
  const store: ConfigStore = {
    hasSecretStore: secrets !== undefined,
    get: key => config[key],
    getAll: () => config,
    set: (key, value) => {
      config[key] = value;
    },
    getPluginConfig<T extends Record<string, unknown>>(instanceId: string): T {
      assertSafePluginId(instanceId);
      return (Object.hasOwn(config.plugins, instanceId) ? config.plugins[instanceId] : {}) as T;
    },
    setPluginConfig(instanceId, next) {
      assertSafePluginId(instanceId);
      markReplaced(instanceId);
      // 值也过闸：外来对象（WebUI 请求体、工具参数）里 JSON 解出的 __proto__ 等键不进文档，调用方之后改它也写不穿
      config.plugins[instanceId] = cloneConfigObject(next);
    },
    removePluginConfig(instanceId) {
      assertSafePluginId(instanceId);
      markReplaced(instanceId);
      delete config.plugins[instanceId];
    },
    isPluginDisabled(instanceId) {
      assertSafePluginId(instanceId);
      return (config.disabledPlugins ?? []).includes(instanceId);
    },
    setPluginEnabled(instanceId, enabled) {
      assertSafePluginId(instanceId);
      config.disabledPlugins ??= [];
      const idx = config.disabledPlugins.indexOf(instanceId);
      if (enabled && idx >= 0) config.disabledPlugins.splice(idx, 1);
      else if (!enabled && idx < 0) config.disabledPlugins.push(instanceId);
    },
    getServicePreferences: () => config.servicePreferences ?? {},
    setServicePreference(name, contextId) {
      if (isUnsafeConfigKey(name)) return;
      config.servicePreferences ??= {};
      config.servicePreferences[name] = contextId;
    },
    removeServicePreference(name) {
      if (!config.servicePreferences || isUnsafeConfigKey(name)) return;
      delete config.servicePreferences[name];
    },
    resolvePluginConfig(instanceId, schema, doc, staged) {
      const source = doc ?? store.getPluginConfig(instanceId);
      return resolveSecrets(schema, source, key => {
        if (staged?.has(key)) return { value: staged.get(key) };
        return values.has(key) ? { value: values.get(key) } : undefined;
      });
    },
    splitPluginSecrets(instanceId, schema, submitted, base) {
      if (!secrets) return { doc: submitted, writes: new Map(), placed: [] };
      const inUse = referencedKeys(config.plugins);
      referencedKeys(submitted, inUse);
      return splitSecrets(schema, instanceId, submitted, base ?? store.getPluginConfig(instanceId), key => {
        return inUse.has(key) || values.has(key);
      });
    },
    commitSecrets(writes) {
      if (writes.size === 0) return () => {};
      const before = new Map<string, { stored?: { value: unknown }; pending?: { value: unknown } }>();
      for (const [key, value] of writes) {
        before.set(key, {
          stored: values.has(key) ? { value: values.get(key) } : undefined,
          pending: pending.has(key) ? { value: pending.get(key) } : undefined,
        });
        values.set(key, value);
        pending.set(key, value);
        // 新写入的键同样是候选：落盘时还有人引用就留着，没人引用了（文件对账回退、被后来的写入顶掉）就删
        orphanCandidates.add(key);
      }
      return () => {
        for (const [key, prev] of before) {
          if (prev.stored) values.set(key, prev.stored.value);
          else values.delete(key);
          if (prev.pending) pending.set(key, prev.pending.value);
          else pending.delete(key);
        }
      };
    },
    // async：同步 provider 的抛错也以拒绝传出，调用方统一经 Promise 接住。
    // 先写密钥再写文档：文档里的引用落盘时，它指向的键已经在盘上
    persist: async () => {
      const secretProvider = secrets?.provider;
      if (pending.size > 0 && secretProvider?.save) {
        // 写盘途中可能有新的提交：写成后只清掉这次写出去、之后没再改过的
        const flushing = new Map(pending);
        const gen = refusedGen;
        try {
          await secretProvider.save(Object.fromEntries(values));
        } catch (err) {
          if (isConfigSaveRefused(err)) {
            refusedGen++;
            secretsRefused = true;
          }
          throw err;
        }
        // 写成了：盘上已是内存里的内容，不必再按文件对账（文件被原样改回后保存就会走到这里）
        if (refusedGen === gen) secretsRefused = false;
        for (const [key, value] of flushing) if (pending.get(key) === value) pending.delete(key);
      }
      if (!provider?.save) return false;
      // 写出的这一份在交给 provider 时定格：落盘途中文档可能又被改过
      const written = snapshot(config);
      await provider.save(config);
      fileDoc = written;
      // 孤儿键在文档写成之后删：没写成时盘上的旧文档可能还引用着它们。主配置已经写成，这一步写密钥失败
      // 不让保存报错，删掉的键放回去，下次保存再删
      if (orphanCandidates.size > 0 && secretProvider?.save) {
        const onDisk = referencedKeys(written.plugins);
        const live = referencedKeys(config.plugins);
        const removed = new Map<string, unknown>();
        for (const key of orphanCandidates) {
          // 刚写出的文档与内存文档对它的引用不一致（落盘途中才去掉或才引用的）：留作候选，下次落盘后再判
          if (onDisk.has(key) !== live.has(key)) continue;
          orphanCandidates.delete(key);
          if (live.has(key) || !values.has(key)) continue;
          removed.set(key, values.get(key));
          values.delete(key);
        }
        if (removed.size > 0) {
          try {
            await secretProvider.save(Object.fromEntries(values));
          } catch {
            for (const [key, value] of removed) {
              values.set(key, value);
              orphanCandidates.add(key);
            }
          }
        }
      }
      return true;
    },
    watch(onChange) {
      if (onChangeCallback) throw new Error('配置变更只支持一个订阅者，先 unwatch 再订阅');
      onChangeCallback = onChange;
      const configWatch = provider?.watch?.(next => {
        const previous = config;
        config = normalize(next);
        fileDoc = snapshot(config);
        onChangeCallback?.(previous);
      });
      if (configWatch) unwatchFns.push(configWatch);
      const secretsWatch = secrets?.provider?.watch?.(next => {
        const previous = config;
        values = secretMap(next);
        if (secretsRefused) {
          // 拒写之后的这次变更按文件对账，同主配置拒写：没写成的密钥作废，与它们一起改的文档退回配置文件上那一份。
          // 配置不落盘的宿主没有那一份，文档不动
          secretsRefused = false;
          pending.clear();
          if (provider?.save) config = snapshot(fileDoc);
        } else {
          for (const [key, value] of pending) values.set(key, value);
        }
        onChangeCallback?.(previous);
      });
      if (secretsWatch) unwatchFns.push(secretsWatch);
      return () => store.unwatch();
    },
    unwatch() {
      for (const fn of unwatchFns.splice(0)) fn();
      onChangeCallback = null;
    },
  };
  return store;
}

/**
 * 实例的定义：已登记的取它自己的；没登记的后缀实例取同模块在册实例的（见 moduleDefinitionOf），模块需声明 reusable
 */
function definitionOf(app: App, instanceId: string): PluginDefinition | undefined {
  const own = app.plugins.getPlugin(instanceId)?.definition;
  if (own) return own;
  const { moduleName, suffix } = parseInstanceId(instanceId);
  if (!suffix) return undefined;
  const found = moduleDefinitionOf(app, moduleName);
  return found?.reusable ? found : undefined;
}

/**
 * 文档里引用了 `keys` 中任一键的已登记实例，按解析后的新值重载（解析结果与运行态相同的不动）。
 * 改了被共用的密钥之后，共用它的实例跟着换上新值。
 */
async function reloadSecretSharers(
  app: App,
  store: ConfigStore,
  keys: ReadonlySet<string>,
  except?: string,
): Promise<void> {
  if (keys.size === 0) return;
  for (const status of app.plugins.getStatus()) {
    if (status.instanceId === except) continue;
    const refs = referencedKeys(store.getPluginConfig(status.instanceId));
    if (![...keys].some(key => refs.has(key))) continue;
    const next = configToReload(app, store, status.instanceId, '共用的密钥已更改');
    if (next) await app.plugins.updateConfig(status.instanceId, next);
  }
}

/**
 * 把文档接到 App：以 host-config 服务独占登记在根激活上，应用文档里的服务偏好，
 * 并在服务上线时记录它有无用户偏好。须在注册任何插件之前调用，偏好才先于全部提供者生效。
 * `opts` 传交给配置同步（withPluginConfigSync / installConfigHotReload）的同一份：host-config 的
 * `trimUnknownFields` 据此声明宿主的裁剪政策（缺省与配置同步一样按裁剪）。
 */
export function installHostConfig(app: App, store: ConfigStore, opts?: ConfigSyncOptions): void {
  const host = app.bind({ events, provide, services });
  // 失败在这里记一笔并标记已处理：不 await 的调用方不会因一次落盘失败变成未处理拒绝、被宿主当致命错误退出
  const save = (): Promise<void> => {
    const done = (async () => {
      // 宿主不持久化时没有写盘，不记「已保存」
      if (await store.persist()) app.logger.info('配置已保存');
    })();
    done.catch(err => {
      try {
        // 拒写是保护盘上外部修改的预期结果，调用方已收到拒绝：一行告警即可，不带栈
        if (isConfigSaveRefused(err)) app.logger.warn(`配置未保存：${err.message}`);
        else app.logger.error('配置保存失败:', err);
      } catch {
        /* 上报器自身失败不再外抛 */
      }
    });
    return done;
  };

  const applyPluginConfig = async (
    instanceId: string,
    submitted: Record<string, unknown>,
  ): Promise<ApplyPluginConfigResult> => {
    assertSafePluginId(instanceId);
    const entry = app.plugins.getPlugin(instanceId);
    const definition = entry?.definition ?? definitionOf(app, instanceId);
    if (!definition)
      throw new Error(`插件 ${instanceId} 不存在，也没有可用来新建它的同模块定义（模块须已登记且声明 reusable）`);
    const schema = definition.configSchema;
    const { doc, writes, placed } = store.splitPluginSecrets(instanceId, schema, submitted);
    const { config: resolved, dangling } = store.resolvePluginConfig(instanceId, schema, doc, writes);
    if (dangling.length > 0) {
      // 本次提交新引入的悬空引用（键既不在密钥存储里、也不是这次写入的）拒收，运行态与文档都不动；
      // 提交前就悬空、原样带回的照常放行（插件仍会激活失败，并记 error）
      const known = new Set(store.resolvePluginConfig(instanceId, schema).dangling.map(d => d.key));
      const introduced = dangling.filter(d => !known.has(d.key));
      if (introduced.length > 0) {
        throw new Error(
          `${instanceId} 引用的密钥不在 secrets.yaml 里：${introduced.map(d => `${d.path}（键 ${d.key}）`).join('、')}；` +
            '重新填写值，或先在 secrets.yaml 里补上这些键',
        );
      }
      app.logger.error(describeDangling(instanceId, dangling));
    }
    let reloaded = true;
    if (entry) {
      // 解析出的配置与运行态相同、实例在 active：不重建（updateConfig 即 bounce，会连带重启依赖它所提供服务的下游），
      // 只写文档与落盘。error 态的实例靠原样保存重试激活，照旧走 updateConfig
      if (entry.state === 'active' && isDeepStrictEqual(resolved, entry.config)) reloaded = false;
      else if (!(await app.plugins.updateConfig(instanceId, resolved))) return { status: 'refused' };
      store.commitSecrets(writes);
      store.setPluginConfig(instanceId, doc);
    } else {
      // 后缀实例由配置段定义：先写文档再登记，免得登记途中的热重载按还没有这一段的文件把它卸掉
      const previous = Object.hasOwn(store.getAll().plugins, instanceId)
        ? store.getPluginConfig(instanceId)
        : undefined;
      const undo = store.commitSecrets(writes);
      store.setPluginConfig(instanceId, doc);
      const registered = await app.plugins.register(definition, resolved, instanceId, {
        disabled: store.isPluginDisabled(instanceId),
      });
      if (!registered) {
        undo();
        if (previous) store.setPluginConfig(instanceId, previous);
        else store.removePluginConfig(instanceId);
        return { status: 'refused' };
      }
    }
    // 写进的若是被别处共用的已有键，共用它的实例跟着换上新值（新建的键没有别人引用）
    await reloadSecretSharers(app, store, new Set(writes.keys()), instanceId);
    try {
      await save();
    } catch (saveError) {
      return { status: 'applied', reloaded, saveError };
    }
    // 写成之后才记：落盘失败时值只在内存里
    for (const { path, key } of placed) app.logger.info(`已把 ${instanceId} 的 ${path} 写进 secrets.yaml（键 ${key}）`);
    return { status: 'applied', reloaded };
  };

  host.provide(
    hostConfig,
    {
      get: store.get,
      getAll: store.getAll,
      // plugins 整块替换会绕过下面 setPluginConfig 的形态检查与孤儿键记账
      set: (key, value) => {
        if (key === 'plugins')
          throw new Error('plugins 不能整块替换：改插件配置用 applyPluginConfig 或 setPluginConfig');
        store.set(key, value);
      },
      getPluginConfig: store.getPluginConfig,
      // 只收文档形态：查得到 schema 时，密钥字段上的明文（例如把 caps.config 原样写回）拒绝，不让原值进文档
      setPluginConfig: (instanceId, next) => {
        assertSafePluginId(instanceId);
        const schema = store.hasSecretStore ? definitionOf(app, instanceId)?.configSchema : undefined;
        const plain = plainSecretPaths(schema, next);
        if (plain.length > 0) {
          throw new Error(
            `setPluginConfig 只收文档形态：${instanceId} 的 ${plain.join('、')} 是密钥字段，不能写原值；改配置请用 applyPluginConfig`,
          );
        }
        store.setPluginConfig(instanceId, next);
      },
      applyPluginConfig,
      removePluginConfig: store.removePluginConfig,
      isPluginDisabled: store.isPluginDisabled,
      setPluginEnabled: store.setPluginEnabled,
      getServicePreferences: store.getServicePreferences,
      setServicePreference: store.setServicePreference,
      removeServicePreference: store.removeServicePreference,
      trimUnknownFields: opts?.trimUnknownFields ?? true,
      save,
    },
    { exclusive: true },
  );
  // 悬空的密钥引用除了日志，也在诊断里报出来：不走 parseConfig 的第三方插件拿到引用对象不会激活失败，
  // 只看日志的话这种情况没人发现。诊断插件没上线时登记排队，上线后生效
  app.bind({ doctor }).doctor.registerCheck({
    id: 'config.secrets',
    category: 'config',
    run: () => {
      const results: CheckResult[] = [];
      for (const status of app.plugins.getStatus()) {
        const entry = app.plugins.getPlugin(status.instanceId);
        if (!entry) continue;
        const { dangling } = store.resolvePluginConfig(status.instanceId, entry.definition.configSchema);
        if (dangling.length === 0) continue;
        results.push({
          id: `config.secrets.${status.instanceId}`,
          category: 'config',
          level: 'error',
          message: describeDangling(status.instanceId, dangling),
        });
      }
      return results.length > 0
        ? results
        : { id: 'config.secrets', category: 'config', level: 'ok', message: '配置引用的密钥都在 secrets.yaml 里' };
    },
  });
  for (const [name, contextId] of Object.entries(store.getServicePreferences())) host.services.prefer(name, contextId);
  host.events.on('service:registered', name => {
    const pref = store.getServicePreferences()[name];
    if (pref) app.logger.debug(`服务 "${name}" 注册时存在用户偏好: ${pref}`);
  });
}

// ----- helpers -----

/** 文档的拷贝：之后对文档的就地修改（禁用名单、服务偏好、插件配置里的子对象）不会改到它 */
function snapshot(doc: AalisConfig): AalisConfig {
  return cloneConfigObject(doc) as AalisConfig;
}

/** 密钥文件的键值：危险键不收 */
function secretMap(input: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(input).filter(([key]) => !isUnsafeConfigKey(key)));
}

function copyOwnSafeStringDict(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of Object.keys(input)) {
    if (isUnsafeConfigKey(key)) continue;
    const val = (input as Record<string, unknown>)[key];
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

function normalize(input: Partial<AalisConfig>): AalisConfig {
  // 核心字段的缺省值取自 CORE_CONFIG_SCHEMA，与 WebUI 设置页显示、比较用的默认值同一来源
  const coreDefaults = defaultsFrom(CORE_CONFIG_SCHEMA);
  const merged: AalisConfig = {
    name: (input.name as string) ?? (coreDefaults.name as string),
    logLevel: (input.logLevel as string) ?? (coreDefaults.logLevel as string),
    // 键与值都过闸：JSON 解出的 plugins.__proto__ / 插件配置里的 __proto__ 都不能当自有键留下
    plugins: cloneConfigObject((input.plugins ?? {}) as Record<string, unknown>) as AalisConfig['plugins'],
    disabledPlugins: (input.disabledPlugins as string[]) ?? [],
  };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'name' || key === 'logLevel' || key === 'plugins' || key === 'disabledPlugins') continue;
    if (isUnsafeConfigKey(key)) continue;
    if (key === 'servicePreferences') {
      merged.servicePreferences = copyOwnSafeStringDict(value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}
