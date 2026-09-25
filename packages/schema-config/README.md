# @aalis/schema-config

配置表单 Schema 词汇契约包：`ConfigSchema` / `SchemaField` / `SchemaGroup` / `SchemaArray` 及 `SchemaFieldTypes` 扩展点，另含对这套词汇的中立解释函数 `defaultsFrom` / `validateConfig` / `removeExtraFields`，以及配置危险键闸与拷贝 `isUnsafeConfigKey` / `cloneConfigObject`。

`@aalis/core` 把插件的 `configSchema` 当作 opaque 数据透传、不解释任何字段；表单词汇（label / options / textarea …）属呈现层，统一住在本包。插件用它给自己的 `configSchema` 做形状检查，渲染宿主（WebUI）与宿主政策（runtime 的配置同步）用它消费 schema。

零运行时依赖：对 `@aalis/core` 只有 type-only 锚点（以 peer 依赖声明）。字段类型可由其他 api 包经 declaration merging 扩展（如 `api-llm` 注入 `'llm-ref'`）。

## 字段类型

本包内置的中立类型，以及 `validateConfig` 对取值的检查（`undefined` / `null` 视为未配置，只在 `required` 且无 `default` 时报缺）：

| type | 取值 | validateConfig 检查 |
|---|---|---|
| `string` / `textarea` | `string` | 类型；声明了 `pattern` 时按正则匹配 |
| `number` | 有限数值 | 类型；`min` / `max` / `integer` |
| `boolean` | `boolean` | 类型 |
| `select` | `string` 或 `number` | 类型（`options` 不是取值白名单） |
| `multiselect` | `(string \| number)[]` | 数组及元素类型；集合语义，WebUI 以勾选框编辑，不能表达重复项 |
| `list` | `string[]` | 数组及元素类型；有序，允许重复（如命令行参数） |
| `map` | `Record<string, string>` | 对象及每个值的类型（如环境变量表） |

`list` 与 `map` 的补充约定：

- **默认值**：`default` 分别写数组与对象，`defaultsFrom` 按值拷贝。runtime 的配置同步合并默认值时递归合并对象，因此顶层或分组里的 `map` 会按键补齐：默认映射中的键总会回到用户配置里，删掉也无效。需要用户可删除的预置条目时，默认值写 `{}`，由插件代码兜底。`list` 不参与合并，用户配置了就整体采用。
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
