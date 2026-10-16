# @aalis/plugin-i18n

`i18n` 服务的默认提供者：按读者的语言链渲染文字对象，收语言包。契约见 `@aalis/api-i18n`，文字对象与字典见 `@aalis/schema-i18n`。

- provides：`i18n`
- uses：`provide`；`contributions`、`session-manager`、`webui-server` 可选
- 语言链：一律经 `@aalis/schema-i18n` 的 `normalizeLanguages` 规范化、去重（只看前 32 项，最多 8 种）。`languages` 读者用它给的链，规范化后一种都没有时按全局默认层；`sessionId` 读者取会话设置的 `language`（按继承链解析），`host` 读者取全局默认层。哪一层都没设、或会话管理缺席时按 `en`。
- 会话设置 `language`：本插件登记，有序多选（`ordered`），可选项来源是 `i18n-languages`，显眼程度 common，适用于全部会话。规范化之后不合法的语言标签拒收（与读的一侧同一个规范化，`zh_CN` 这类系统写法收下，读时整理成 `zh-CN`）；完全相同的重复项去掉，写法不同的同一语言读时规范化后去重；没设时界面写「按英文」。
- 语言包：取贡献点 `i18n:pack` 的全部交付建索引，同一语言按全局键（包名在前）取先。用时与贡献点对照，交付变了才重建，运行中的交付与撤回立即生效；形状不对或读取时抛错的包跳过。贡献点缺席时没有语言包。
- `languages()`：目录里各字典的原文语言与译文语言、语言包的语言，按标签排序，带自称（`Intl.DisplayNames`，取不到时用标签）。
- 可选项来源 `i18n-languages`：经贡献点 `webui:options` 交出，值是 `languages()` 的语言标签，标签是自称。
- 「翻译」页（插件位置）：按 ns 列出每种语言的已译、缺、过时（语言包里原文改过措辞的）、冲突（目录记下的再登记冲突，与几个语言包给同一条的不一样）与坏条目（`checkTexts` 报的问题）；选中一行给出具体的键与两种待译骨架：插件自己的 `src/locales/<语言>.ts`，与语言包的 `entries`（带 `from`）。

没装本插件时，各出口按原文显示。
