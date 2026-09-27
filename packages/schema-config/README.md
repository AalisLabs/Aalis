# @aalis/schema-config

配置表单 Schema 词汇契约包：`ConfigSchema` / `SchemaField` / `SchemaGroup` / `SchemaArray` 及 `SchemaFieldTypes` 扩展点；声明与读取插件配置的 `defineConfig` / `ConfigOf` / `parseConfig`；对这套词汇的中立解释函数 `defaultsFrom` / `deepMergeDefaults` / `validateConfig` / `removeExtraFields`，配置危险键闸与拷贝 `isUnsafeConfigKey` / `cloneConfigObject`，以及插件因配置问题无法激活时在 `apply` 里抛出的 `configError` / `missingConfigError`（后者用于缺必填项；name 为 `ConfigError`、不带 stack，激活失败日志只有一行，不像程序崩溃）。

`@aalis/core` 把插件的 `configSchema` 当作 opaque 数据透传、不解释任何字段；表单词汇（label / options / textarea …）属呈现层，统一住在本包。同一份 schema 既是表单描述，又是插件配置值类型的来源（`ConfigOf`）和运行时解析规则（`parseConfig`）；渲染宿主（WebUI）与宿主政策（runtime 的配置同步）也用它消费 schema。

零运行时依赖：对 `@aalis/core` 只有 type-only 锚点（以 peer 依赖声明）。字段类型可由其他 api 包经 declaration merging 扩展（如 `api-llm` 注入 `'llm-ref'`）。

## 声明与读取

```ts
import { config, definePlugin, logger } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';

const configSchema = defineConfig({
  apiKey: { type: 'string', label: 'API Key', required: true },
  port: { type: 'number', label: '端口', default: 8080, min: 1, max: 65535, integer: true },
  mode: {
    type: 'select',
    label: '模式',
    default: 'fast',
    options: [
      { label: '快', value: 'fast' },
      { label: '稳', value: 'safe' },
    ],
  },
});

export default definePlugin({
  name: '@your-scope/plugin-x',
  configSchema,
  uses: { config, logger },
  apply({ config, logger }) {
    const cfg = parseConfig(configSchema, config, logger);
    // cfg: { apiKey: string; port: number; mode: 'fast' | 'safe' }
  },
});
```

- **`defineConfig(schema)`**：运行时原样返回传入的对象（不冻结、不加任何属性，WebUI 读的就是这个活对象），类型层保留字面量，返回值可直接放进 `definePlugin({ configSchema })`。不要给变量标 `ConfigSchema` 类型注解，注解会把字面量拓宽掉，`ConfigOf` 只能推出宽类型。推出的类型里各属性只读、`options` 是字面量元组；需要在运行时改写 schema（如按已注册的服务补全选项）时，经 `ConfigSchema` 或 `SchemaField` 类型的引用改写。
- **`ConfigOf<S>`**：从 schema 推导配置值类型。字段取 `SchemaFieldTypes` 里登记的取值类型（见下表）；select / multiselect 有静态 `options`、没有 `dynamicOptions` 且 `allowCustom` 不为 `true` 时收窄为选项值的字面量联合，数字选项对应数字字面量。有 `default` 或 `required: true` 的字段必定存在，其余为可选；分组推为嵌套对象，总是存在；数组推为元素类型的数组，元素按同一规则推导。
- **`parseConfig(schema, raw, logger?)`**：按 schema 解析插件拿到的配置，返回 `ConfigOf` 类型的新对象，不改入参。之后的夹紧、跨字段约束等核对作用于返回值。

## 字段类型

本包内置的中立类型。「判定」一列是 `validateConfig` 与 `parseConfig` 共用的逐字段规则：

| type | 取值类型（`ConfigOf`） | 判定 |
|---|---|---|
| `string` / `textarea` | `string` | 字符串；有限数字按字符串收；声明了 `pattern` 时按正则匹配 |
| `number` | `number` | 有限数值；去掉首尾空白后非空、能完整解析为有限数的字符串按数字收；`min` / `max` / `integer` |
| `boolean` | `boolean` | 类型，不做转换 |
| `select` | 选项值的字面量联合，否则 `string` | 字符串或有限数字；有静态 `options`、没有 `dynamicOptions` 且 `allowCustom` 不为 `true` 时须是某个选项值 |
| `multiselect` | 选项值字面量联合的数组，否则 `string[]` | 数组；元素同 `select`；集合语义，WebUI 以勾选框编辑，不能表达重复项 |
| `list` | `string[]` | 数组，元素按字符串判定；有序，允许重复（如命令行参数） |
| `map` | `Record<string, string>` | 对象，每个值按字符串判定（如环境变量表） |

- **标量宽容**：YAML 里不加引号的纯数字（QQ 号、口令、端口、环境变量值）在期望字符串的位置照常可用，加了引号的数字在期望数字的位置照常可用；`parseConfig` 返回换算后的值。
- **选项即取值范围**：选项按字符串比较，`parseConfig` 取选项声明的原值（WebUI 把数字选项存成字符串，读出时归位成数字）。
- **`dynamicOptions` / `allowCustom`**：两者影响取值判定，由本包声明。`dynamicOptions` 是动态选项来源的服务名（WebUI 经 webui-server 调该服务的 `listModels()` 或等价方法获取选项），声明后静态 `options` 不再是取值范围，只查取值是字符串或数字；`allowCustom` 表示接受选项之外的值，不查是否在选项内：WebUI 给 multiselect 提供手动输入；select 用它表示静态选项不全（例如由插件在运行时补全选项的字段）。只影响 WebUI 呈现的 `secret` 由 `@aalis/api-webui` 注入。
- **扩展字段类型**：api 包经 declaration merging 往 `SchemaFieldTypes` 登记类型名与取值类型（如 `'llm-ref': ModelRef`），`ConfigOf` 据此推导。本包不校验外来类型的取值：`validateConfig` 跳过，`parseConfig` 除把 `''` 当作未配置外原样透传。

## parseConfig 的处置

- **缺失**：`undefined` 与 `null`（YAML 裸键）；`required` 字段另把 `''` 当作缺失（WebUI 与脚手架用 `''` 表示未填），外来类型的 `''` 一律当作缺失（WebUI 给未选的 `llm-ref` 存 `''`）。有 `default` 用 `default` 的拷贝；无 `default` 且 `required` 不可恢复；否则省略该键。
- **无效**（不符合上表的判定）：有 `default` 回落并告警；无 `default` 且 `required` 不可恢复；否则省略并告警。
- **list / map / multiselect**：坏元素、坏值逐个丢弃并告警，其余保留。
- **分组**：值不是对象时告警，整组按空对象解析，子字段各取默认值。
- **数组**：值不是数组按无效处理；元素不是对象、或元素内有不可恢复的字段时只丢这一条元素并告警；元素字段的默认值逐元素补齐（runtime 的配置同步不补数组元素的默认值）。
- **schema 外的键**：丢弃并告警。runtime 已先裁掉顶层与分组内的，这里主要覆盖数组元素，以及不经 runtime 的宿主。
- **不可恢复**（顶层或分组内）：缺失抛 `missingConfigError`，无效抛 `configError`，插件随之进 error 态，在 WebUI 保存或配置文件热重载后重试激活。
- **告警文案**：`配置项 <路径> <原因>，改用默认值 <JSON>`、`配置项 <路径> <原因>，已忽略`、`配置项 <数组路径>[i] 已忽略：<字段> <原因>`。只写路径、类型名与约束，不写原值（可能是密钥）；默认值会写出。

`validateConfig(schema, config)` 用同一份判定做只读检查，返回问题清单（`kind` 为 `missing` 或 `invalid`），不转换、不回填、不裁剪；它只把 `undefined` / `null` 当作未配置，只在 `required` 且无 `default` 时报缺。宿主用它告警或拦截保存：runtime 的配置同步对启用中的插件打告警，WebUI 保存插件配置时拒绝本次新引入的 `invalid`。

`list` 与 `map` 的补充约定：

- **默认值**：`default` 分别写数组与对象，`defaultsFrom` 按值拷贝。`deepMergeDefaults` 合并默认值时递归合并对象（runtime 的配置同步与 WebUI 保存插件配置都用它），因此顶层或分组里的 `map` 会按键补齐：默认映射中的键总会回到用户配置里，删掉也无效。需要用户可删除的预置条目时，默认值写 `{}`，由插件代码兜底。`list` 不参与合并，用户配置了就整体采用。
- **未知字段裁剪**：`removeExtraFields` 把 `map` 当作叶子整体保留，不按键裁剪。
- **缺省 UI**（WebUI 的 SchemaForm）：两者都渲染为多行文本框。`list` 每行一项，空白行忽略；`map` 每行一条 `KEY=VALUE`，按第一个 `=` 切分，键去掉首尾空白，值原样保留，缺少 `=` 或键为空的行不保存。现有的数字、布尔项或值按字符串显示，编辑后写成字符串；其余无法按这套规则逐行表达的值（项或值本身含换行、`list` 含空白项、`null`、嵌套的数组或对象等）会让该字段只读显示，需在配置文件中编辑。旧版存下的空串按空列表 / 空映射显示，保存时写成 `[]` / `{}`。

## 消费方式：用宽区间，别用 caret

仓内五十余个包这样依赖本包（与 `@aalis/core` 的 peerDep 同一风格）：

```jsonc
"dependencies": { "@aalis/schema-config": "workspace:>=0.9.0 <1.0.0" }
```

发布时该区间**原样保留**（实测 `pnpm pack` 产物即 `>=0.9.0 <1.0.0`），本地仍照常 link 到 workspace。

**不要用 caret。** 0.x 的 caret（`^0.9.0` = `>=0.9.0 <0.10.0`）锁死 minor：本包加一个字段类型
就是一次 minor，届时所有已发布消费者的范围会拒收新版，node_modules 里出现两份副本——而
declaration merging 是按模块副本生效的，`SchemaFieldTypes` / `SchemaField` 的合并面会就此裂开
（一份合并了 `'llm-ref'`，另一份没有）。宽区间让整个 0.x 段自由流动，加词汇零级联。
