# ConfigManager — 配置管理

持有应用配置快照，提供分层访问器（顶层字段 / 插件配置 / 禁用名单 / 服务偏好）。core 不碰文件系统、也不解释
任何 schema：配置由宿主从任意来源加载好，作为快照传进 `AppOptions.config`；持久化经注入的 `ConfigProvider`
回交给宿主；默认值回填与按 `configSchema` 裁剪未知字段属宿主政策，在 `@aalis/runtime`。下文出现的
`aalis.config.yaml` 是 runtime 宿主的落盘形态，不是 core 的概念。

插件侧：自己的配置视图是内置能力 `config`（`uses: { config }`，只读对象）；整份配置的读写与落盘是宿主服务 `hostConfig`，须显式写进 `uses`。宿主入口是 `app.config`。

**源码**: `packages/core/src/context/config.ts`

## AalisConfig 结构

```typescript
interface AalisConfig {
  name: string;                    // 机器人名称
  logLevel: 'debug'|'info'|'warn'|'error';
  plugins: Record<string, Record<string, unknown>>;   // 各插件配置，键为插件名；指令前缀、agent 参数等都在这里
  disabledPlugins?: string[];
  servicePreferences?: Record<string, string>;

  // ↓ authority 域业务字段，由 api-authority 经 declaration merging 注入
  owners?: UserIdentity[];                          // Owner 列表（owner = `*`，拥有一切）
  deniedCapabilities?: string[];                    // 全局硬禁用 glob：命中即拒，连 owner 都压过
  authorityOverrides?: Record<string, number>;      // 单操作最低等级覆盖（能力键 type:name → 整数等级）
  restrictedPolicy?: {                              // 受限能力临时放行策略
    allow?: string[];                               // 自动放行的 restricted 能力/操作名 glob（['*'] 全放）
    duration?: number;                              // 放行时长（秒，0=永久）
  };
}
```

> 模型说明见 [权限系统](../plugins/plugin-authority)。`owners` 等 authority 字段在 core 的
> `AalisConfig` 里不显式声明（core 不知晓权限语义），由 `api-authority`
> 经 declaration merging 注入；不装 authority 插件时这些字段无意义。

## 关键方法

### 读取

```typescript
config.get('name')                     // 获取顶级配置
config.getPluginConfig(instanceId)     // 获取插件配置（键是实例 id）
config.getAll()                        // 获取完整配置
config.isPluginDisabled(instanceId)    // 检查是否被禁用
config.getServicePreferences()         // 获取服务偏好
```

### 写入

```typescript
config.set('logLevel', 'debug')                // 修改内存快照（不自动持久化）
config.setPluginConfig(instanceId, {...})      // 修改插件配置
config.setPluginEnabled(instanceId, true)      // 启用/禁用插件
config.setServicePreference('llm', ctxId)      // 设置服务偏好
config.reloadFrom(next)                        // 用外部快照覆盖内部状态（provider watch 回调用）
```

持久化走 `app.saveConfig()`（`AppService` 契约，返回 `Promise<void>`：兑现时保存已完成，provider 失败以拒绝传出）。
`ConfigManager.save()` 标 `@internal`——它是 App 转发给注入 `ConfigProvider` 的机制口，插件不要直接调用。

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
