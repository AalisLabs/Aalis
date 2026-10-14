# 运行态与配置文档

core 只持运行态，不持配置文档。运行态有三样：各实例的配置、禁用态、服务偏好，决定「现在怎么跑」。配置文档记的是「下次启动用什么」，由宿主持有并落盘：Node 宿主 `@aalis/runtime` 读写家目录里的 `aalis.config.yaml`，并把文档作为 `host-config` 服务（契约 `@aalis/api-host-config`）提供给在 `uses` 里声明了它的插件。core 也不解释任何 schema：默认值回填与按 `configSchema` 裁剪未知字段属宿主政策。

**源码**: `packages/core/src/orchestration/plugin.ts`（运行态）、`packages/api-host-config/src/index.ts`（文档契约）、`packages/runtime/src/config-store.ts`、`packages/runtime/src/config-sync.ts`

## 插件配置解析

插件用 `@aalis/schema-config` 的 `defineConfig` 定义 schema，在 apply 中调用 `parseConfig(schema, config.use, logger.use)`，取得带默认值的配置；需要传递配置类型时使用 `ConfigOf<typeof schema>`。Core 的 config 服务仍提供原始只读视图，不依赖 schema-config。

缺省值（undefined / null）按字段默认值处理。普通字段的无效值回落默认并告警；标记 `onInvalid: 'error'` 的字段在显式值无效时拒绝，避免错误地址或启动参数被替换后继续运行。顶层错误使插件激活失败；数组元素里的不可恢复错误只跳过该元素。写宿主文件路径的 `string` / `textarea` 字段声明 `format: 'absolute-path'`（只收绝对路径）或 `'executable'`（绝对路径或按 PATH 查找的命令名），相对路径按无效处理；判定忽略首尾空白，交给插件的值也去掉首尾空白，空串与只有空白都表示未填（必填字段算缺失），只看写法、与宿主平台无关。URL 格式、跨字段条件等业务语义由插件在产生副作用前核对。标了 `secret: true` 的字段由宿主在交给插件之前把引用解析成原值（见[密钥配置](#密钥配置)），插件读到的就是原值；字段上仍是引用时说明键不在宿主的密钥存储里，`parseConfig` 一律拒绝激活并点名键名，不回落默认值，数组元素里的也让整次解析失败。

解析返回新对象，不改配置文档。写回配置时以 host-config 原文为底修改目标字段，避免把解析时补入的默认值、裁剪结果持久化；原文里密钥字段是引用，原样交回即保持原值，写回用 `applyPluginConfig`（见[跨重启保留](#跨重启保留)）。

## 运行态（core）

| 运行态 | 写入口 | 读入口 |
|---|---|---|
| 实例配置 | 登记时传入（`app.plugin` / `app.pluginAll` / `plugins.register`）；`plugins.updateConfig` 替换（禁用态同样替换、保持禁用，启用时按新配置激活） | 插件经内置服务 `config`（`config.use`，本激活的只读视图）；管理面经 `plugins.getPlugin(id).config` |
| 禁用态 | 登记时的 `{ disabled }`；`plugins.enable` / `disable` | `plugins.getStatus()`、`plugins.getPlugin(id).state` |
| 服务偏好 | `services.use.prefer` / `unprefer`（全局，或给 `{ for }` 按插件实例） | `services.use.preferred` |

- 登记时交入的配置原样生效：core 不合并默认值，也不读禁用名单。入参会被拷贝，危险键（`__proto__` / `constructor` / `prototype`）跳过，调用方之后改它不影响实例；拷贝失败（环状引用、读取抛错）时管理动作返回 false。
- 管理动作（`plugins.enable` / `disable` / `updateConfig` / `bounce`、`services.use.prefer` / `unprefer`）只改运行态，不写配置文档。要跨重启保留，见下文[跨重启保留](#跨重启保留)。

## 配置文档（宿主）

### AalisConfig 结构

```typescript
// @aalis/api-host-config
interface AalisConfig {
  name: string;                    // 应用名
  logLevel: string;                // 默认日志级别
  slowThresholdMs?: number;        // core 慢操作阈值（毫秒），启动时注入 AppOptions.slowThresholdMs
  plugins: Record<string, Record<string, unknown>>;   // 各实例配置，键为实例 id；指令前缀、agent 参数等都在这里
  disabledPlugins?: string[];      // 宿主登记插件时据此以禁用态登记
  servicePreferences?: Record<string, string>;        // 服务名 → 偏好的 contextId；宿主启动与热重载时应用
  pluginServicePreferences?: Record<string, Record<string, string>>;  // 插件实例 id → 它的服务偏好，只对它生效（见下文「服务偏好」）
  [key: string]: unknown;          // 未做 declaration merging 的插件也能读到自己的顶层字段（类型为 unknown）

  // ↓ authority 域业务字段，由 api-authority 经 declaration merging 注入
  owners?: UserIdentity[];                          // Owner 列表（owner = `*`，拥有一切）
  deniedCapabilities?: string[];                    // 全局硬禁用 glob：命中即拒，连 owner 都压过
  authorityOverrides?: Record<string, number>;      // 单操作最低等级覆盖（能力键 type:name → 整数等级）
  restrictedPolicy?: {                              // 免确认白名单（只免 session 档，不放宽授权）
    allow?: string[];                               // 免确认的能力 glob（['*'] 全放）
    duration?: number;                              // 生效时长（秒，0=永久）
  };
  // …其余 authority 字段见 @aalis/api-authority
}
```

> 模型说明见 [权限系统](../plugins/plugin-authority)。`owners` 等 authority 字段在 `@aalis/api-host-config` 的
> `AalisConfig` 里不显式声明（文档契约不知晓权限语义），由 `api-authority` 经
> `declare module '@aalis/api-host-config'` 注入；不装 authority 插件时这些字段无意义。

### host-config 服务

插件在 `uses` 里声明 `hostConfig`（从 `@aalis/api-host-config` 导入）后经 `hostConfig.use` 拿到文档读写面 `HostConfig`。host-config 由宿主提供，core 不保证在场；宿主可能不提供时声明为 `optional(hostConfig)` 并自行降级。

```typescript
import { hostConfig } from '@aalis/api-host-config';

// uses: { hostConfig }，apply 里：
const doc = hostConfig.use;

// 读取
doc.get('name')                        // 顶层字段
doc.getAll()                           // 完整文档
doc.getPluginConfig(instanceId)        // 插件配置（键是实例 id；密钥字段上是引用，不是原值）
doc.isPluginDisabled(instanceId)       // 是否在禁用名单
doc.getServicePreferences()            // 全局偏好；给 { for: 实例 id } 是那个插件的本插件偏好

// 改插件配置并生效（运行态、文档、密钥与落盘一步完成）
await doc.applyPluginConfig(instanceId, {...})

// 写入（只改文档，不改运行态）
doc.set('logLevel', 'debug')           // 顶层字段；plugins 不能经它整块替换
doc.setPluginConfig(instanceId, {...})  // 只收文档形态，密钥字段上的明文抛错
doc.removePluginConfig(instanceId)
doc.setPluginEnabled(instanceId, true)
doc.setServicePreference('llm', ctxId)                       // 全局偏好
doc.setServicePreference('llm', ctxId, { for: instanceId })  // 本插件偏好
doc.removeServicePreference('llm')

// 落盘
await doc.save()
```

- `save()` 先写密钥存储、再写文档，返回的 Promise 兑现时保存已完成；失败以拒绝传出，调用方应 `await`。失败时提供方已记一笔 error 并把拒绝标记为已处理，不 `await` 的调用不会变成未处理拒绝。不保证并发保存的先后，也不负责与外部编辑合并。
- 按实例 id 取放的方法遇到 `__proto__` / `constructor` / `prototype` 这类 id 抛「插件 id 不合法」。

### 跨重启保留

改插件配置用 `applyPluginConfig(instanceId, submitted)`：拆出密钥、更新运行态（没登记的后缀实例按同模块定义登记）、写文档并落盘，返回 `refused`（运行态不受理，文档与密钥都没动）或 `applied`（`saveError` 为落盘失败）。`submitted` 是文档形态，密钥字段上的引用表示保持，非空明文表示替换。写入规则见 [api-host-config](../api/api-host-config.md#改插件配置)。

启停与服务偏好仍是管理动作只改运行态，文档写方法只改文档。要让它们在重启后仍然生效，调用方两边都写：先做管理动作，成功后写文档，再 `save()`。

```typescript
import { optional, pluginsService } from '@aalis/core';
import { hostConfig } from '@aalis/api-host-config';

// uses: { plugins: pluginsService, doc: optional(hostConfig) }，apply 里：
if (await plugins.use.disable(id)) {
  if (doc.present) {
    doc.use.setPluginEnabled(id, false);
    await doc.use.save();
  }
}
```

WebUI 的启停路由按这种方式持久化；WebUI 的改配置与新建实例、mcp-client 的自服务开关用 `applyPluginConfig`。

## Node 宿主的做法（@aalis/runtime）

- `createConfigStore(initial, provider?, secrets?)`：文档的内存态、危险键闸与落盘委托。`ConfigProvider` 负责持久化（`save`）与外部变更监听（`watch`），`createFsYamlConfigProvider` 是读写 YAML 的实现。第三个参数是密钥存储 `{ values, provider? }`，`createFsSecretsProvider` 是读写 `secrets.yaml` 的实现；不给时没有密钥存储，密钥字段照旧以明文留在文档里。给了密钥存储却没给它的 `provider.save`、配置又会落盘（给了 `provider.save`）时直接抛错：否则密钥只在内存里，重启后引用落空。
- `createFsYamlConfigProvider` 保存前比对盘上内容：文件里有尚未生效的外部修改（手改尚未热重载、改坏未能解析、另一个进程写过）时拒绝本次保存、不覆盖（拒绝原因为 `@aalis/api-host-config` 的 `ConfigSaveRefusedError`，用同包的 `isConfigSaveRefused` 判定；错误只带文件路径），宿主记一条告警。写入先写临时文件再改名替换，临时文件创建时即沿用原文件的权限位，没有原文件时为 0600；写临时文件或改名失败时删掉临时文件再传出原错误。拒绝之后调用方的文档已领先于文件，下一次文件变更即使内容与上次生效的那份相同也照常热重载，按文件重新对账；监听武装后立即对账一次，武装前的手改随之生效；平台不支持文件监听时记一条告警，此后手改需重启才生效。
- `installHostConfig(app, store, opts)`：把文档以 `host-config` 服务独占登记在根激活上，并经 `services.use.prefer` 应用文档里的服务偏好（全局偏好与本插件偏好）。`opts` 与交给 `withPluginConfigSync` 的是同一份，`host-config` 的 `trimUnknownFields` 据此声明宿主是否裁剪 schema 外字段，WebUI 保存插件配置时按它行事。须在登记任何插件之前调用，偏好才先于全部提供者生效。
- 插件发现驱动 `createPluginDiscovery(app, loader, store)` 登记插件时，按实例 id 从文档取配置（解析密钥引用后）与禁用标记，交给 `app.pluginAll`（见 [App](app.md)）。冷启动时，`plugins` 下找不到对应插件的配置段（多为直接 `npm uninstall` 后的残留）逐段告警一次，提示已卸载的可删除该段（其中可能含密钥）；文档本身不改。
- `withPluginConfigSync(loader, app, store, opts)`：导入定义后、登记前，把 `configSchema` 派生的默认值深合并进文档（密钥字段的默认值不写进文档），按 schema 裁剪未知字段（`configSync.trimUnknownFields=false` 可保留），并把密钥字段上的明文移进密钥存储。首次 apply 拿到的就是规范化后的配置。
- `installConfigHotReload(app, store, discovery, opts)`：文档或 `secrets.yaml` 被外部修改后，先按改动前后的文档对账服务偏好（改了的与新加的经 `services.use.prefer` 应用，删掉的 `unprefer`，没变的不动），再卸载文件里已没有配置段的 `name:suffix` 实例（冷启动同样不会登记它们），再按同一政策同步，对解析后的配置与运行态有差异的实例调用 `updateConfig`，最后经发现驱动的 `registerConfiguredInstances()` 登记文件里新出现的后缀实例，判据与冷启动、`rescan()` 相同。在 `app:stopping` 时停止监听。

`startAalis` 的装配序为：家目录 → 实例锁（守护模式）→ 文档与密钥存储 → App → host-paths 与 host-logs → host-config → 加载政策 → 发现 → 热重载。实例锁只有 `startAalis` 取，自组装宿主不经过这一步。

自组装宿主按同一顺序接线。`host-paths` 要先于登记插件提供：`@aalis/plugin-storage-local` 与 `@aalis/plugin-package-manager` 以 required 声明它，缺了会停在 pending。

```typescript
import { hostPaths } from '@aalis/api-host-paths';
import { App, type LogLevel, provide } from '@aalis/core';
import {
  createConfigStore,
  createFsSecretsProvider,
  createFsYamlConfigProvider,
  derivePaths,
  installHostConfig,
} from '@aalis/runtime';

// 家目录与安装集，均为绝对路径
const paths = derivePaths('/srv/aalis/home', '/srv/aalis/app');
const { config, provider } = createFsYamlConfigProvider(paths.config);
const store = createConfigStore(config, provider, createFsSecretsProvider(paths.secrets)); // 不给第三个参数则没有密钥存储
const app = new App({ name: store.get('name'), logLevel: store.get('logLevel') as LogLevel });
app.bind({ provide }).provide.use(hostPaths, paths, { exclusive: true }); // 先 host-paths
installHostConfig(app, store); // 再 host-config
// 登记插件时按 store.resolvePluginConfig 解析出的配置与 { disabled } 登记（createPluginDiscovery 即如此）
```

默认值须深合并进配置（`withPluginConfigSync` 即此政策），不能顶层浅合并：只写了半块的嵌套组会把默认值整块顶掉。

## 服务偏好

同一个服务有几个提供者时，每个消费插件按「本插件偏好 > 全局偏好 > 优先级 > 注册顺序」选中一家（见 [服务模型](../concepts/service-model.md)）。两种偏好都只由用户设，插件代码只读：

- **全局偏好**：对所有插件生效。WebUI 在设置「系统」的服务偏好里改（默认模型在「会话默认」的「模型」里改），配置文件写 `servicePreferences`。
- **本插件偏好**：只对一个插件实例生效，压过全局偏好。WebUI 在这个插件的详情页「服务偏好」里改，列出它声明的、有几个提供者的服务，选「跟随全局」即清除；配置文件写 `pluginServicePreferences`，键是插件实例 id。

```yaml
servicePreferences:
  llm: "@aalis/plugin-llm-deepseek/deepseek-chat"
pluginServicePreferences:
  "@aalis/plugin-memory-summary":
    llm: "@aalis/plugin-llm-ollama/qwen3:8b"
```

偏好指向的那家不在（停用了、模型删了）时按下一级挑，回来后切回；那期间写入的数据进的是别家。WebUI 改的立即生效并写进配置文件；手改配置文件的随热重载生效，删掉的偏好同时从运行态撤回。

**不需要让某个插件改用别家、也不需要它固定用某一家的，就别设本插件偏好，只用全局偏好。** 下面两类服务按插件分开选会出错：

- 「谁生效」由当前选中者决定的服务，如 `trigger`：各插件看到的选中者不同，就会两边都以为自己生效，或都以为自己不生效。
- 多个插件共用同一份数据的服务，如 `memory`（message-archive 写、memory-history 读）、`storage`、`vectorstore`、`embedding`：两边选的不是同一家，就读不到对方写的。`embedding` 的输出是向量索引的键，同一份索引的读写两方必须用同一个模型；memory-vector 只比同一模型算出的向量，分开后表现为查不到，而不是查错。

插件一定要某一家提供某个服务时，core 不提供强制机制：插件在自己的文档里写明，由用户按插件设本插件偏好。

## 密钥配置

schema 里标了 `secret: true` 的字段是凭据（API key、token、可能带账号密码的连接串）。Node 宿主把它们的值存在家目录的 `secrets.yaml` 里（0600），`aalis.config.yaml` 里只放引用 `{ $secret: '<键>' }`：

```yaml
# aalis.config.yaml
plugins:
  "@aalis/plugin-llm-deepseek":
    apiKey: { $secret: "@aalis/plugin-llm-deepseek.apiKey" }
```

```yaml
# secrets.yaml
"@aalis/plugin-llm-deepseek.apiKey": "<你的 API key>"
```

- **填写**：在 WebUI 里填，或直接把明文写进 `aalis.config.yaml`。宿主同步插件配置时（启动、热重载、市场装载插件）把密钥字段上的非空明文移进 `secrets.yaml`，原处换成引用；这会改写配置文件，日志只写实例、字段路径与键名，不写值。运行中把已有的引用改写成明文时，热重载按改动前的文档取键，与 WebUI 替换同一规则：顶层与分组里的字段写进原处原来引用的那个键，键被别处共用时一并改到它们。数组元素里的字段，以及启动时（宿主没有改动前的文档）的全部字段，按「键名」一条取新键，原来那个键的旧值留在 `secrets.yaml` 里，不再需要时手动删掉。移走之前的明文仍可能留在编辑器的备份文件与 git 历史里。`''`、空 map、空 list 不算密钥值，原样留在配置里。经 `applyPluginConfig`（WebUI 保存）提交时，本次新引入的悬空引用（键不在 `secrets.yaml` 里、也不是这次写入的）被拒绝，WebUI 回 400，运行态与文档都不动；提交前就悬空、原样带回的不拦。
- **键名**：缺省是 `<实例 id>.<字段路径>`，数组元素里的字段路径不带下标（如 mcp-client 各 server 的 `env` 是 `@aalis/plugin-mcp-client.servers.env`）；这个键已被占用（配置里有引用指向它，或 `secrets.yaml` 里已有）时依次加 `-2`、`-3`。几处配置可以手写成指向同一个键，共用一个密钥；在 WebUI 里替换共用的键会一并影响它们。标在 map、list 上的字段整个值算一个密钥。
- **读取**：宿主把配置交给插件之前解析引用，插件经 `parseConfig` 读到的是原值，读取配置的代码不需要改。引用的键不在 `secrets.yaml` 里时，宿主记一条错误（点名实例、字段与键）。用 `parseConfig` 读取、且装的是新版 schema-config 的插件激活失败，消息点名键名，不回落默认值；不走 `parseConfig` 的插件会拿到引用对象，由诊断检查 `config.secrets` 报出（runtime 登记给 doctor，每个有悬空引用的实例报一条 error，点名字段与键）。在 WebUI 重新填写，或在 `secrets.yaml` 里补上这个键即可。
- **保存**：先写 `secrets.yaml`、再写 `aalis.config.yaml`，文档里的引用落盘时它指向的键已经在盘上。`secrets.yaml` 的临时文件一律以 0600 创建，不沿用原文件的权限位。宿主经自己的写入（WebUI 改配置、删除实例、卸载插件、同步裁剪）换掉或删掉引用后，不再被任何配置引用的键在保存时从 `secrets.yaml` 删除，宿主新建、后来又没人引用的键同样删除。删除在主配置写成之后做，这一步写 `secrets.yaml` 失败不让保存报错，键留到下次保存再删。手改配置文件不会触发删除，手加进 `secrets.yaml`、还没被引用的键也不动。
- **外部修改**：`secrets.yaml` 与主配置一样被监听，改动后只重新加载解析结果有变化的实例；有尚未生效的外部修改时保存同样拒写，之后与主配置拒写一样按文件对账：修好或改动 `secrets.yaml` 后，密钥与配置文档都以两个文件的内容为准，被拒的密钥写入与这期间没写进文件的配置改动一并作废，插件随之按文件重载；要保留那次改动，重新提交即可。写入因其它原因失败（如没有写权限）时，已提交、还没写成的密钥留在内存里，其间 `secrets.yaml` 被外部改动也并进新读到的内容，下次保存时写入。改成空文件或只剩注释时按空的密钥文件处理。两个文件写坏时，日志只给 YAML 的错误码与行列，不带原文：启动时解析失败拒绝启动，运行中解析失败沿用上一份内容。YAML 的警告（例如把 `!xxx` 当成标签）同样只记错误码与行列，不经 Node 的 process warning 打到 stderr。
- **仍是明文的情况**：没有 `configSchema` 的插件、没有标 `secret` 的字段，值照旧留在 `aalis.config.yaml` 里；自组装宿主创建配置存储时不给密钥存储的，密钥字段也照旧以明文留在文档里。没装上或加载失败的插件，宿主不处理它们的配置段，明文原样保留；这类残留段冷启动时逐段告警，要手动删掉，或装好插件后再启动一次。
- **保护**：存储插件不许经任何根读写 `secrets.yaml`（见 [plugin-storage-local 的「宿主控制文件」](../plugins/plugin-storage-local.md#宿主控制文件)）；脚手架生成的 `.gitignore` 已包含整个家目录 `home/`。备份家目录时连同 `secrets.yaml` 一起备份，只备份 `aalis.config.yaml` 的，恢复后引用落空，按上面「读取」一条处理。

> 早期版本支持 `${VAR_NAME}` 环境变量插值（配合 `.env` 使用），现已删除。该机制承载的能力
> 与配置文件完全重合，唯一区别在于哪个文件纳入 git；将配置文件本身 ignore 后，这一层不再有意义。
> **现在写 `${VAR}` 会被原样当作字面量字符串处理**，据此配置的鉴权将失败。

## 核心配置字段

> 表单描述（`CORE_CONFIG_SCHEMA`）与全部表单词汇一同存放于 `@aalis/schema-config`；core 不持有 schema。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | string | 'Aalis' | 机器人名称 |
| `logLevel` | select | 'info' | 日志等级 |
| `slowThresholdMs` | number（≥0） | 60000 | 慢操作阈值（毫秒）：插件激活超过它仍未完成时告警并转入后台，`app:*` 屏障事件的单个监听器超过它时告警并不再等待；0 表示不设限（见 [App](app.md) 的 `AppOptions.slowThresholdMs`） |

`logLevel` 与 `slowThresholdMs` 只在启动时读取，改了要重启；`startAalis` 把留空的 `slowThresholdMs`（YAML 空键）当作未配置；遇到不是非负有限数的写法记一条告警，同样按默认值处理。runtime 的重启策略等新实例报就绪（默认 30 秒）才判定接管成功，`slowThresholdMs` 低于它时，新实例会带着仍在后台激活的插件报就绪，更新失败的回滚不再兜住卡住的激活。

指令前缀不是顶层字段，写在 `plugins["@aalis/plugin-commands"].commandPrefix`（默认 `/`）；写到顶层不会生效。WebUI 的 `PUT /api/config` 只收上表三个键，请求体里有别的顶层键时回 400 并点名，什么都不写。
