# @aalis/plugin-i18n

`i18n` 服务的默认提供者：按读者的语言链渲染文字对象，收语言包。契约见 `@aalis/api-i18n`，文字对象与字典见 `@aalis/schema-i18n`。

- provides：`i18n`
- uses：`provide`；`contributions`、`session-manager` 可选
- 语言链：`languages` 读者给的链只看前 32 项，规范化、去重，最多 8 种；`sessionId` 读者取会话设置的 `language`（按继承链解析），`host` 读者取全局默认层。哪一层都没设、或会话管理缺席时按 `en`。
- 语言包：取贡献点 `i18n:pack` 的全部交付建索引，同一语言按全局键（包名在前）取先。用时与贡献点对照，交付变了才重建，运行中的交付与撤回立即生效；形状不对或读取时抛错的包跳过。贡献点缺席时没有语言包。
- `languages()`：目录里各字典的原文语言与译文语言、语言包的语言，按标签排序，带自称（`Intl.DisplayNames`，取不到时用标签）。

没装本插件时，各出口按原文显示。
