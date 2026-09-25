# 运行态与配置文档

core 只持运行态，不持配置文档。运行态有三样：各实例的配置、禁用态、服务偏好，决定「现在怎么跑」。配置文档记的是「下次启动用什么」，由宿主持有并落盘：Node 宿主 `@aalis/runtime` 读写 `aalis.config.yaml`，并把文档作为 `host-config` 服务（契约 `@aalis/api-host-config`）提供给在 `uses` 里声明了它的插件。core 也不解释任何 schema：默认值回填与按 `configSchema` 裁剪未知字段属宿主政策。

**源码**: `packages/core/src/orchestration/plugin.ts`（运行态）、`packages/api-host-config/src/index.ts`（文档契约）、`packages/runtime/src/config-store.ts`、`packages/runtime/src/config-sync.ts`

## 运行态（core）

| 运行态 | 写入口 | 读入口 |
|---|---|---|
| 实例配置 | 登记时传入（`app.plugin` / `app.pluginAll` / `plugins.register`）；`plugins.updateConfig` / `bounce(id, { config })` 替换 | 插件经内置服务 `config`（本激活的只读视图）；管理面经 `plugins.getPlugin(id).config` |
| 禁用态 | 登记时的 `{ disabled }`；`plugins.enable` / `disable` | `plugins.getStatus()`、`plugins.getPlugin(id).state` |
| 服务偏好 | `services.prefer` / `unprefer` | `services.preferred` |

- 登记时交入的配置原样生效：core 不合并默认值，也不读禁用名单。入参会被拷贝，危险键（`__proto__` / `constructor` / `prototype`）跳过，调用方之后改它不影响实例。
- 管理动作（`plugins.enable` / `disable` / `updateConfig` / `bounce`、`services.prefer` / `unprefer`）只改运行态，不写配置文档。要跨重启保留，见下文[跨重启保留](#跨重启保留)。

## 配置文档（宿主）

### AalisConfig 结构

```typescript
// @aalis/api-host-config
interface AalisConfig {
  name: string;                    // 应用名
  logLevel: string;                // 默认日志级别
  plugins: Record<string, Record<string, unknown>>;   // 各实例配置，键为实例 id；指令前缀、agent 参数等都在这里
  disabledPlugins?: string[];      // 宿主登记插件时据此以禁用态登记
  servicePreferences?: Record<string, string>;        // 服务名 → 偏好的 contextId；宿主启动时应用
  [key: string]: unknown;          // 未做 declaration merging 的插件也能读到自己的顶层字段（类型为 unknown）

  // ↓ authority 域业务字段，由 api-authority 经 declaration merging 注入
  owners?: UserIdentity[];                          // Owner 列表（owner = `*`，拥有一切）
  deniedCapabilities?: string[];                    // 全局硬禁用 glob：命中即拒，连 owner 都压过
  authorityOverrides?: Record<string, number>;      // 单操作最低等级覆盖（能力键 type:name → 整数等级）
  restrictedPolicy?: {                              // 受限能力临时放行策略
    allow?: string[];                               // 自动放行的 restricted 能力/操作名 glob（['*'] 全放）
    duration?: number;                              // 放行时长（秒，0=永久）
  };
  // …其余 authority 字段见 @aalis/api-authority
}
```

> 模型说明见 [权限系统](../plugins/plugin-authority)。`owners` 等 authority 字段在 `@aalis/api-host-config` 的
> `AalisConfig` 里不显式声明（文档契约不知晓权限语义），由 `api-authority` 经
> `declare module '@aalis/api-host-config'` 注入；不装 authority 插件时这些字段无意义。

### host-config 服务

插件在 `uses` 里声明 `hostConfig`（从 `@aalis/api-host-config` 导入）后拿到文档读写面 `HostConfig`。host-config 由宿主提供，core 不保证在场；宿主可能不提供时声明为 `optional(hostConfig)` 并自行降级。

```typescript
import { hostConfig } from '@aalis/api-host-config';

// uses: { hostConfig }，apply 里：
const doc = hostConfig.require();

// 读取
doc.get('name')                        // 顶层字段
doc.getAll()                           // 完整文档
doc.getPluginConfig(instanceId)        // 插件配置（键是实例 id）
doc.isPluginDisabled(instanceId)       // 是否在禁用名单
doc.getServicePreferences()            // 服务偏好

// 写入（只改文档，不改运行态）
doc.set('logLevel', 'debug')
doc.setPluginConfig(instanceId, {...})
doc.removePluginConfig(instanceId)
doc.setPluginEnabled(instanceId, true)
doc.setServicePreference('llm', ctxId)
doc.removeServicePreference('llm')

// 落盘
await doc.save()
```

- `save()` 返回的 Promise 兑现时保存已完成；失败以拒绝传出，调用方应 `await`。失败时提供方已记一笔 error 并把拒绝标记为已处理，不 `await` 的调用不会变成未处理拒绝。不保证并发保存的先后，也不负责与外部编辑合并。
- 按实例 id 取放的方法遇到 `__proto__` / `constructor` / `prototype` 这类 id 抛「插件 id 不合法」。

### 跨重启保留

管理动作只改运行态，文档写方法只改文档。要让启停、新配置在重启后仍然生效，调用方两边都写：先做管理动作，成功后写文档，再 `save()`。

```typescript
import { optional, pluginsService } from '@aalis/core';
import { hostConfig } from '@aalis/api-host-config';

// uses: { plugins: pluginsService, doc: optional(hostConfig) }，apply 里：
if (await plugins.require().disable(id)) {
  const store = doc.current;
  if (store) {
    store.setPluginEnabled(id, false);
    await store.save();
  }
}
```

WebUI 的启停与改配置路由、mcp-client 的自服务开关按这种方式持久化。

## Node 宿主的做法（@aalis/runtime）

- `createConfigStore(initial, provider)`：文档的内存态、危险键闸与落盘委托。`ConfigProvider` 负责持久化（`save`）与外部变更监听（`watch`），`createFsYamlConfigProvider` 是读写 YAML 的实现。
- `createFsYamlConfigProvider` 保存前比对盘上内容：文件里有尚未生效的外部修改（手改尚未热重载、改坏未能解析、另一个进程写过）时拒绝本次保存、不覆盖，错误只带文件路径；监听武装后立即对账一次，武装前的手改随之生效；平台不支持文件监听时记一条告警，此后手改需重启才生效。
- `installHostConfig(app, store)`：把文档以 `host-config` 服务独占登记在根激活上，并经 `services.prefer` 应用文档里的服务偏好。须在登记任何插件之前调用，偏好才先于全部提供者生效。
- 插件发现驱动 `createPluginDiscovery(app, loader, doc)` 登记插件时，按实例 id 从文档取配置与禁用标记，交给 `app.pluginAll`（见 [App](app.md)）。冷启动时，`plugins` 下找不到对应插件的配置段（多为直接 `npm uninstall` 后的残留）逐段告警一次，提示已卸载的可删除该段（其中可能含密钥）；文档本身不改。
- `withPluginConfigSync(loader, app, store, opts)`：导入定义后、登记前，把 `configSchema` 派生的默认值深合并进文档，并按 schema 裁剪未知字段（`configSync.trimUnknownFields=false` 可保留）。首次 apply 拿到的就是规范化后的配置。
- `installConfigHotReload(app, store, opts)`：文档被外部修改后，按同一政策同步，再对配置有差异的实例调用 `updateConfig`；在 `app:stopping` 时停止监听。

`startAalis` 的装配序为：文档 → App → host-config → 加载政策 → 发现 → 热重载。

自组装宿主按同一顺序接线：

```typescript
import { App, type LogLevel } from '@aalis/core';
import { createConfigStore, createFsYamlConfigProvider, installHostConfig } from '@aalis/runtime';

const { config, provider } = createFsYamlConfigProvider();
const store = createConfigStore(config, provider);
const app = new App({ name: store.get('name'), logLevel: store.get('logLevel') as LogLevel });
installHostConfig(app, store);
// 登记插件时按文档传配置与 { disabled }
```

默认值须深合并进配置（`withPluginConfigSync` 即此政策），不能顶层浅合并：只写了半块的嵌套组会把默认值整块顶掉。

## 密钥配置

密钥**直接写进 `aalis.config.yaml`**——脚手架生成的 `.gitignore` 已包含此文件，不会入库。

```yaml
plugins:
  "@aalis/plugin-llm-deepseek":
    apiKey: "sk-..."
```

> 早期版本支持 `${VAR_NAME}` 环境变量插值（配合 `.env` 使用），现已删除。该机制承载的能力
> 与配置文件完全重合，唯一区别在于哪个文件纳入 git；将配置文件本身 ignore 后，这一层不再有意义。
> **现在写 `${VAR}` 会被原样当作字面量字符串处理**，据此配置的鉴权将失败。

## 核心配置字段

> 表单描述（`CORE_CONFIG_SCHEMA`）与全部表单词汇一同存放于 `@aalis/schema-config`；core 不持有 schema。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | string | 'Aalis' | 机器人名称 |
| `logLevel` | select | 'info' | 日志等级 |

指令前缀不是顶层字段，写在 `plugins["@aalis/plugin-commands"].commandPrefix`（默认 `/`）；写到顶层不会生效，WebUI 的 `PUT /api/config` 也只应用上表两个键；请求体里其余顶层键一律不应用，其中与当前值不同的会在响应 `ignored` 里点名。
