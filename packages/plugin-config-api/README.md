# @aalis/plugin-config-api

配置表单 Schema 词汇契约包：`ConfigSchema` / `SchemaField` / `SchemaGroup` / `SchemaArray` 及 `SchemaFieldTypes` 扩展点。

`@aalis/core` 把插件的 `configSchema` 当作 opaque 数据透传、不解释任何字段；表单词汇（label / options / textarea …）属呈现层，统一住在本包。插件用它给自己的 `configSchema` 做形状检查，渲染宿主（WebUI）与宿主政策（runtime 的配置同步）用它消费 schema。

零依赖、纯类型 + 纯数据。字段类型可由其他 api 包经 declaration merging 扩展（如 `plugin-llm-api` 注入 `'llm-ref'`）。
