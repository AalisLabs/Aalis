# plugin-i18n — 多语言

**包名**: `@aalis/plugin-i18n`  
**源码**: `packages/plugin-i18n/src/index.ts`、`packages/plugin-i18n/src/translation.ts`（「翻译」页）  
**契约**: [@aalis/api-i18n](../api/api-i18n.md)

## 概述

`i18n` 服务的默认提供者：按读者的语言链把文字对象渲染成字符串，收语言包。另给 WebUI 语言的可选项与「翻译」页，诊断语言列表里有没有插件提供不了的语言。文字对象与字典见 [schema-i18n](../api/schema-i18n.md)。

本插件需要另装：`npm create aalis` 的最小档装上它，已有部署不会自动装上。没装时各出口一律按原文显示。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-i18n',
  displayName: t('displayName'),
  subsystem: 'core',
  configSchema,
  provides: [i18n],
  uses: {
    provide,
    events: optional(events),                 // 语言诊断随会话设置、宿主配置的变化重算；缺席时只随插件的变化重算
    plugins: optional(pluginsService),        // 语言诊断随插件的变化重算（语言包与字典随插件交付与撤回）
    config,                                   // 没有宿主配置文档时 language 的全局层取这里
    contributions: optional(contributions),   // 语言包的来源，交可选项来源；缺席时没有语言包
    sessionManager: optional(sessionManager), // 子会话的读者按根会话；诊断写场所的显示名
    sessionFields: optional(sessionFields),   // 读者的语言按会话解析；缺席时只取本插件配置里的值
    document: optional(ownHostConfig),        // 按会话字段的全局层：宿主配置文档里本实例的那一段
    webui: optional(webuiServer),             // 「翻译」页，「需要处理」里的语言诊断
    doctor: optional(doctor),                 // 诊断 i18n.languages
  },
  apply(caps) { /* 见源码 */ },
});
```

## 提供与贡献

| 项 | 是什么 |
|---|---|
| 服务 `i18n` | `I18nService`（`render`、`chainOf`、`languages`），见 [api-i18n](../api/api-i18n.md) |
| 贡献点 `webui:options` 的 `i18n-languages` | 语言的可选项来源，见下文「配置」 |
| 页面 `translation` | 「翻译」页，见下文「翻译页」 |
| 诊断 `i18n.languages`（类别 `config`） | 见下文「诊断与需要处理」 |

读贡献点 `i18n:pack`（语言包）。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `language` | multiselect（有序） | `['en']` | 给人看的文字用的语言，靠前的优先，缺译文时依次用后面的。可选项来源 `i18n-languages`，可排序 |

- `language` 是可按会话覆盖的字段（[api-session-settings](../api/api-session-settings.md)），显眼程度 common，只适用于房间，1 级能改本会话这一层。全局层就是这里的插件配置（`aalis.config.yaml` 的 `plugins['@aalis/plugin-i18n'].language`），WebUI 里在设置「会话默认」全局层的「语言」一行与本插件详情里改；房间单独的设置在房间的会话设置或「会话默认」的平台档、平台类型档里改。
- 校验与读的一侧同一判据：每项是经 schema-i18n 的 `normalizeLanguages` 规范化后合法的语言标签，`zh_CN` 这类系统写法收下，读时整理成 `zh-CN`；不合法的拒收，点名是哪一项。完全相同的重复项由字段的 `ordered` 去掉，写法不同的同一语言读时规范化后去重。
- 可选项来源 `i18n-languages` 经贡献点 `webui:options` 交出：`languages()` 的语言，值是语言标签，显示自称。
- 列表里都是明确的语言标签，本插件不看系统语言（`LANG`）。`npm create aalis` 新建项目时按系统语言写定这份列表（见[脚手架的「配置约定」](../guide/scaffolding.md#配置约定)），之后在设置里改。

## 语言链

- `{ host: true }` 读者取全局层。
- 会话读者按根会话：子会话（子任务）跟根会话。根是房间的按会话设置解析房间的 `language`（全局层、平台档、平台类型档、场所与本会话，见 [plugin-session-settings](./plugin-session-settings.md#解析时取哪几层)）；根是 owner 会话（WebUI 与终端的会话）的这一项不适用，与 `{ host: true }` 一样只取全局层。会话不在会话表里时按会话 id 与入口平台解析。会话设置不在时只取本插件配置里的值。
- 整条列表经 `normalizeLanguages` 规范化、去重（只看前 32 项，至多 8 种）；规范化后一种都没有时是 `['en']`。
- 按链选哪种语言见 [schema-i18n 的「语言链与渲染」](../api/schema-i18n.md#语言链与渲染)。日期与时间一律按服务进程的时区。

## 渲染与语言包

- `render` 用读者的语言链与语言包索引调 schema-i18n 的 `resolveText`，`skip` 与 `escape` 照调用方给的。
- 语言包取贡献点 `i18n:pack` 的全部交付建索引。每次用时与贡献点的快照对照，交付变了才重建，运行中的交付与撤回立即生效；贡献点缺席时没有语言包。
- 语言包只补缺，按语言标签算：字典自带同一语言标签同键时不生效，字典没有的标签（含地区变体）由包补。选语言时同文字内地区相同者优先，所以作者只带 `en` 时，`en-GB` 的包对 `en-GB` 读者优先于作者的 `en`。`from` 与当前原文的指纹不符当作缺失；几个包给同一条时按贡献点的全局键（插件实例 id 在前）取先，指纹相符而译文不一样时「翻译」页标冲突。形状不对或读取时抛错的包跳过。
- `languages()`：目录里各字典的原文语言与译文语言、语言包的语言，按标签排序，带自称（`Intl.DisplayNames`，取不到时用标签）。

## 翻译页

插件位置的页面，一张表按字典（ns）与语言各一行，原文语言那一行不列：

| 列 | 是什么 |
|---|---|
| 已译 | 已有译文的键数 / 总键数，算上语言包里原文指纹相符的补充 |
| 缺 | 没有可用译文的键（语言包里只有过时译文的也算） |
| 过时 | 语言包里有、原文已经改过措辞的键 |
| 冲突 | 目录记下的同 ns 再登记冲突（原文语言或协议版本不同时整份字典算一条），以及几个语言包给同一条（指纹相符）、译文不一样的 |
| 坏条目 | 解析不了、参数与原文不合、引号把参数写成字面、反引号里直接写参数的译文（`checkTexts` 报的问题） |

选中一行给出具体的键，与两种待译骨架：插件自己的 `src/locales/<语言>.ts`（字典自带的译文照旧，缺的先填原文），与语言包的 `entries`（只列字典没有自带译文的键，缺的与过时的先填原文，`from` 是原文的指纹）。

## 诊断与需要处理

- 诊断 `i18n.languages`（装了 doctor 时登记）：全局层与写了语言列表的平台档、平台类型档、场所（只看收这一项的窗口场所；会话自己的设置不查），列表里有某一项没有任何字典或语言包提供时，每项一条 warn。判法与渲染相同：语言与文字相同的算提供，再看语言相同的（`en-US` 有 `en` 就算，`ja-JP` 没有任何日语就不算）。结论写明是哪一层（全局层不写）与实际用的语言（按这一层的列表、照渲染的选法在全部可用语言里选），如「语言列表里的 日本語 (日本) 没有插件提供，实际用 English」。详情写怎么办：装提供这种语言的语言包（搜索关键词 `aalis-lang-<完整标签>` 或 `aalis-lang-<基础语言>`），或调整这一层的语言列表。都有提供时一条 ok。只提示，渲染照常按列表往后找。
- 「需要处理」（装了 webui-server 时）：上面每条 warn 各一项，id 为 `i18n.languages.<序号>`，结论与详情同诊断，不必先跑诊断。会话设置变了（`session-settings:changed`）、宿主配置文档变了（`host-config:changed`）、插件变了（`plugins.watch`，字典与语言包随插件交付与撤回）时重算，都有提供时撤回；运行中不随插件变动的语言包交付与撤回，到下一次重算时才反映。

## 路由

本插件不登记路由。WebUI 的 `GET /api/i18n/languages` 与 `GET /api/i18n/messages` 由 webui-server 经本服务提供，见 [api-webui 的管理面 REST](../api/api-webui.md#可选项与模型)。

## 相关

- 契约：[api-i18n](../api/api-i18n.md)
- 文字对象与解析：[schema-i18n](../api/schema-i18n.md)
- 插件作者的做法与语言包的命名、关键词：[多语言：给人看的文字](../guide/i18n.md)
