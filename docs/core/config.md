# ConfigManager — 配置管理

管理 YAML 配置文件的读写、环境变量插值和 Schema 验证。

**源码**: `packages/core/src/config.ts`

## AalisConfig 结构

```typescript
interface AalisConfig {
  name: string;                    // 机器人名称
  logLevel: 'debug'|'info'|'warn'|'error';
  agent?: {
    maxToolIterations?: number;
    temperature?: number;
    maxTokens?: number;
  };
  plugins: Record<string, Record<string, unknown>>;
  disabledPlugins?: string[];
  servicePreferences?: Record<string, string>;
  commandPrefix?: string;          // 指令前缀（默认 '/'）

  // ↓ authority 域业务字段，由 plugin-authority-api 经 declaration merging 注入
  owners?: UserIdentity[];                          // Owner 列表（owner = `*`，拥有一切）
  deniedCapabilities?: string[];                    // 全局硬禁用 glob：命中即拒，连 owner 都压过
  visibilityOverrides?: Record<string, 'public' | 'restricted'>; // 单操作可见性覆盖（操作名 → 可见性）
  restrictedPolicy?: {                              // 受限能力临时放行策略
    allow?: string[];                               // 自动放行的 restricted 能力/操作名 glob（['*'] 全放）
    duration?: number;                              // 放行时长（秒，0=永久）
  };
}
```

> 模型说明见 [权限系统](authority.md)。`owners` 等 authority 字段在 core 的
> `AalisConfig` 里不显式声明（core 不知晓权限语义），由 `plugin-authority-api`
> 经 declaration merging 注入；不装 authority 插件时这些字段无意义。

## 关键方法

### 读取

```typescript
config.get('name')                // 获取顶级配置
config.getPluginConfig('plugin')  // 获取插件配置
config.getAll()                   // 获取完整配置
config.isPluginDisabled('name')   // 检查是否被禁用
config.getServicePreferences()    // 获取服务偏好
```

### 写入

```typescript
config.set('logLevel', 'debug')           // 修改配置（不自动保存）
config.setPluginConfig('name', {...})      // 修改插件配置
config.setPluginEnabled('name', true)      // 启用/禁用插件
config.setServicePreference('llm', ctxId)  // 设置服务偏好
config.save()                              // 持久化到磁盘
config.reload()                            // 重新从磁盘加载
```

## 环境变量插值

配置文件中的 `${VAR_NAME}` 会在加载时自动展开为对应环境变量值。保存时自动恢复占位符，避免泄露实际值。

```yaml
plugins:
  "@aalis/plugin-deepseek":
    apiKey: "${DEEPSEEK_API_KEY}"  # 加载时展开，保存时恢复
```

## 核心配置 Schema (CORE_CONFIG_SCHEMA)

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | string | 'Aalis' | 机器人名称 |
| `logLevel` | select | 'info' | 日志等级 |
| `commandPrefix` | string | '/' | 指令前缀（空 = 无前缀模式） |
