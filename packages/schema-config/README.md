# @aalis/schema-config

配置表单 Schema 词汇契约包：`ConfigSchema` / `SchemaField` / `SchemaGroup` / `SchemaArray` 及 `SchemaFieldTypes` 扩展点。

`@aalis/core` 把插件的 `configSchema` 当作 opaque 数据透传、不解释任何字段；表单词汇（label / options / textarea …）属呈现层，统一住在本包。插件用它给自己的 `configSchema` 做形状检查，渲染宿主（WebUI）与宿主政策（runtime 的配置同步）用它消费 schema。

零依赖、纯类型 + 纯数据。字段类型可由其他 api 包经 declaration merging 扩展（如 `api-llm` 注入 `'llm-ref'`）。

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
