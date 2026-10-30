# schema-i18n — 给人看的文字对象

**包名**: `@aalis/schema-i18n`  
**源码**: `packages/schema-i18n/src/`  
**实现**: 库，没有服务

## 概述

给人看的文字一律是**文字对象**（`TextRef`）：取自所属包原文字典里的一个键，带参数与按原文渲染的整句，纯数据、可落盘。产出文字的一方只依赖本包；出口在 i18n 服务在场时按读者的语言渲染，不在场时按原文语言渲染。服务契约见 [api-i18n](./api-i18n.md)，插件里怎么组织字典、哪些文字要翻见 [多语言：给人看的文字](../guide/i18n.md)。

零运行时依赖、不用 `node:` 模块，浏览器里同样可用。本页前半是插件作者用的导出，「宿主与出口用的」一节是目录、语言包索引与语言工具。

## 文字对象

```ts
interface TextRef {
  readonly i18n: string;   // 所属包名（字典的 ns），兼作识别标记
  readonly key: string;
  readonly params?: Readonly<Record<string, TextParam>>;
  readonly source: string; // 生成时按原文渲染的整句；原文渲染失败时为原文模板原样
}
type TextParam = string | number | TextRef | readonly (string | number | TextRef)[];
```

`source` 给日志、给模型的文字与不认识这个结构的消费者用。参数里的文字对象与外层用同一条语言链渲染。文字对象拼进字符串只会得到 `[object Object]`：要拼进句子就把它作为另一条文字对象的参数，或在出口渲染之后再拼。

| 函数 | 行为 |
|---|---|
| `isTextRef(v)` | 按形状判：`i18n`、`key`、`source` 是字符串，`params` 缺省或为普通对象，没有别的键。从 JSON 读回的、另一份本包产出的都认 |
| `asText(v)` | 展示值（core 的插件显示名、服务 label 这类 `unknown` 字段）收窄成文字：字符串与文字对象原样，其余 `undefined` |
| `sameText(a, b)` | 两段文字是不是同一句：有一方是字符串时按原文（`toSource`）比；文字对象之间按所属包、键与参数比，原文的措辞变了也还是同一句。参数按结构比：参数键的先后不算，参数里的文字对象同样按包、键与参数比，数组逐个按位置比，别的值按 `===` 比 |

## 原文字典与译文

```ts
// src/texts.ts
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = { saved: '已保存 {count, number} 项', title: '回滚检查点' } as const;
export type Source = typeof SOURCE;
export const t = defineTexts({ ns: '@your-scope/plugin-x', language: 'zh-CN', source: SOURCE, locales: { en } });

t('saved', { count: 3 }); // 文字对象；参数从原文推出
t('title');               // 没有参数的键不收第二参
```

```ts
// src/locales/en.ts
import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({ saved: 'Saved {count, plural, one {# item} other {# items}}' });
```

- **`defineTexts({ ns, language, source, locales? })`**：登记字典并返回 `t()`（`TextFactory`）。`ns` 写包名；`language` 与 `locales` 的键过 `Intl.getCanonicalLocales`，非法即抛 `RangeError`（`zh_CN` 不行，写 `zh-CN`）。`source` 要写成 `as const` 的对象（或就地写字面量），漏了编译报错。`t()` 身上带着这份字典（`ns`、`language`、`source`、`locales`），可以直接交给 `checkTexts`。
- **`t(key, params?)`**：参数类型从原文模板推出，见下文「消息格式」最后一段；键是联合类型（`t(flag ? 'a' : 'b', …)`）时要交齐各键的参数。参数在生成时复制一层（数组也复制），调用方之后改自己的对象或数组不影响文字对象。原文里没有的键抛 `RangeError`。
- **`defineLocale<Source>()(entries)`**：就地写对象字面量。原文里没有的键、不是字面量的译文、与原文参数不兼容的译文编译报错，缺的键允许。兼容指译文用到的参数原文都有，且收得下原文交来的值：原文 `{count}` 收字符串，译文要用 plural 时原文也写成 `{count, number}` 或 plural。
- 字典登记进进程级目录。同一 `ns` 再次登记按键合并：已有键保留先登记的，新键补入；同键不同文、原文语言不同、协议版本不认识都记成冲突（`catalogIssues()`），库本身不打日志。目录随进程存在，测试里各用不同的 `ns`。

## 消息格式

自写的 ICU 子集：

| 写法 | 行为 |
|---|---|
| `{name}` | 参数名限 `[A-Za-z_][A-Za-z0-9_]*`。字符串原样，数原样转字符串，文字对象按读者语言渲染 |
| `{n, plural, =0 {…} one {…} other {…}}` | `=N` 精确匹配先于类别，类别取 `Intl.PluralRules`。`#` 只在直接所在的 plural 分支里替换为该数（按语言的 `NumberFormat`），嵌在 select 里的 `#` 是字面 |
| `{x, select, a {…} other {…}}` | x 是字符串 |
| `{n, number}` | `Intl.NumberFormat` |
| `{t, date\|time\|datetime, short\|medium\|long}` | t 是毫秒时间戳，样式缺省 medium；时区取渲染选项的 `timeZone`，缺省或不认识时用进程时区 |
| `{items, list}` | 罗列：按句子选中的语言取分隔符直接拼接（中文「a、b、c」，英文「a, b, c」），不加「和」「and」。分隔符是本包字典的 `listSeparator` 键，自带 zh-CN 与 en，别的语言由语言包补，没补时同语言的用它（zh-TW 用「、」），其余用 en 的「, 」 |
| `{items, list, or}` | `Intl.ListFormat` 的 disjunction（「或」） |
| `{items, lines}` | 按行连接 |
| `{ms, duration}` | 天、时、分、秒最多两级，按显示的最小一级四舍五入；负数只在第一级带负号 |
| `{n, size}` | B、kB、MB、GB（Intl 单位的 narrow 写法），按 1024 进位，B 以上至多一位小数、整数不带小数；舍入后到了 1024 就升一级 |
| `{x, code}` | 行内代码，x 是字符串或数。围栏比参数里最长的反引号串多一个，参数原样、不转义。参数要放进代码段时用它，不要在模板里写 `` `{x}` ``：Markdown 出口转义后代码段里会显出反斜杠 |

`list` 与 `lines` 的元素各自渲染。plural 与 select 必须有 other；未知类型、`list` 后面不是 `or` 的样式、花括号不配平、重复的分支键、`offset:`、嵌套超过 16 层都算解析失败。plural、number、date、time、datetime、duration、size 要求有限数，list、lines 要求数组，select 要求字符串，不符算渲染失败。

引号同 ICU 的 DOUBLE_OPTIONAL，只是 `#` 不分是否在 plural 分支里：`''` 是一个撇号；`'` 紧跟 `{`、`}`、`#` 时引用到下一个单独的 `'`，没闭合就到串尾；其余单个 `'` 是字面（`can't` 无需处理）。字面的花括号写成 `'{query}'`。英文里给参数加引号要用 ‘ ’ 或 “ ”：`'{name}'` 是字面的 `{name}`，不替换参数。

渲染与解析失败一律不抛：`t()` 的 `source` 退成原文模板原样，`resolveText` 退成 `text.source`。

类型层推参与运行时同一套文法（按花括号配平递归下降，引号先剥）：plural、number、date、time、datetime、duration、size 推为 `number`，list（含 `list, or`）、lines 推为数组，select 推为分支键的联合并上 `string`，code 推为 `string | number`，其余为 `string | number | TextRef`，同名取更具体的类型。文法错误（未知类型、花括号不配平）类型层不报，交给 `checkTexts`。

## 语言链与渲染

```ts
function normalizeLanguages(tags: readonly unknown[]): string[];
function pickLanguage(chain: readonly string[], available: readonly string[]): number | undefined;
function resolveText(text: TextRef, chain: readonly string[], options?: ResolveOptions): string;
function resolveSource(text: TextRef, options?: Pick<ResolveOptions, 'timeZone' | 'escape'>): string;

interface ResolveOptions {
  packs?: PackIndex;       // 语言包索引（indexPacks 建），补字典没有的语言
  timeZone?: string;       // date 与 time 用的时区，缺省用进程时区
  escape?: 'markdown';     // 字符串参数按 Markdown 转义
}
```

- **`normalizeLanguages(tags)`**：整理读者给的语言列表：下划线换连字符，去掉 `.UTF-8`、`@euro` 这类后缀，过 `getCanonicalLocales`；不合法的（含不是字符串的）丢掉，去重保序。只看前 32 项，至多给出 8 种。
- **`pickLanguage(chain, available)`**：按读者的语言链在可用语言里选一种，返回 `available` 的下标：
  1. 链里逐项找语言与文字（`Intl.Locale` maximize 之后的 script）都相同的，同文字内地区相同者优先，其余按 `available` 的先后：zh、zh-CN、zh-Hans-CN、zh-SG 都命中 zh-CN；
  2. 链里逐项找语言相同、文字不同的：zh-TW 读者遇到只有简体时用简体；
  3. 找 en；
  4. 都没有时 `undefined`，由调用方用原文。
- **`resolveText(text, chain, options?)`**：纯函数。可用语言是原文语言、字典自带译文的语言与语言包补的语言（只按这个键算；语言包只补字典没有的语言标签，地区变体也算另一种，原文指纹相符才算）；解析失败、参数与原文不兼容的译文不算。按 `pickLanguage` 选，命中原文语言或选不出时用原文。`ns` 不在目录、键不存在、原文解析失败、选中的那条渲染失败时用 `text.source`。参数里的文字对象用同一条链递归：一次渲染里至多渲染 1024 个、嵌套 32 层，超出的用那一个的 `source`，伪造的重复参数不放大、环不挂死。`escape: 'markdown'` 把字符串参数按 Markdown 转义（字典里写的 Markdown 原样），Markdown 正文一类出口用；这时回落的 `text.source` 整句转义。
- **`resolveSource(text, options?)`**：只按原文语言渲染，出口在 i18n 服务缺席时用。时区与转义同 `resolveText`，参数里的文字对象同样取各自的原文，回落规则同上。
- **`localize(value, render, skip?)`**：把值里的文字对象换成 `render(text)`，其余原样。只进普通对象与数组（类实例原样）；没有文字对象的子树原样返回、不复制，有改动时只复制通往文字对象的那一路。`skip(key, parent)` 为真的属性不进：出口用它避开原样数据（工具参数与结果、审批的逐字参数、用户消息正文），那里形如文字对象的值可能是伪造的。
- **`toSource(value)`**、**`toSourceReplacer`**：把值里的文字对象换成 `source`，后者是给 `JSON.stringify` 的 replacer。只给日志与交给模型的文字用；给人看的经出口渲染。

## 报错

| 导出 | 行为 |
|---|---|
| `new TextError(text, { status?, cause? })` | `message` 是 `text.source`（日志照旧可读），`name` 是 `'TextError'`，`text` 由出口按读者语言渲染；`status` 是 HTTP 出口用的状态码 |
| `withText(error, text)` | 给任意 Error 挂上文字对象并返回它本身，`name` 与类不变（按 `name` 判定的错误照旧认得）；`message` 不动，由调用方给（通常就是 `text.source`） |
| `isTextError(e)` | 按结构判：是 Error 且 `e.text` 是文字对象。另一份本包的 `TextError`、改了 `name` 的子类都认，所以不用 `instanceof` |
| `textOf(err)` | 接住的报错作参数用：有文字对象取它，否则 `message`（抛出的普通对象也取），再否则 `String(err)`。回 `string \| TextRef` |

## 组句

| 函数 | 行为 |
|---|---|
| `textLines(parts)` | 把若干段（字符串或文字对象）按行连成一个文字对象，每段按读者语言各自渲染 |
| `linesOf(text)` | `textLines` 的逆：是 `textLines` 生成的文字对象（落盘读回的同样认）就给出各段，否则 `undefined`。段本身可能是多行的字符串或别的文字对象 |
| `textClauses(parts)` | 把若干分句连成一句：原文以「；」相连，英文以「; 」。两两二分着嵌套，层数随句数按对数增长；n 句约占 2n 个参数里的文字对象，每句另带文字对象参数时更多，超出 `resolveText` 的渲染上限的部分回落成原文。不到两句时同 `textLines` |
| `truncateParams(text, max)` | 把字符串参数（含参数里的文字对象与列表元素）逐个按码点截到 `max` 个，不从代理对中间切开，`source` 按截后的参数重新按原文渲染；所属字典不在目录里时 `source` 也截到 `max`，没有参数的也截，在目录里且没有参数的原样返回。截完参数里字符串的总字数仍超过 `max` 的 16 倍时，退为截到 `max` 的原文字符串，所以回 `string \| TextRef` |

## 自检

```ts
function checkTexts(domain: TextDomain): TextIssue[];

type TextIssue =
  | { kind: 'parse'; language: string; key: string }                       // 原文或译文解析失败
  | { kind: 'params'; language: string; key: string; params: string[] }    // 原文里同一参数的用法互不相容，或译文参数与原文不兼容
  | { kind: 'quote'; language: string; key: string }                       // 引号把原文的参数写成了字面
  | { kind: 'code'; language: string; key: string }                        // 反引号里直接写参数
  | { kind: 'missing'; language: string; keys: string[] };                 // 这种语言缺的键
```

`domain` 是 `defineTexts` 返回的 `t()`，或目录里的条目。字典没有问题时回空数组。

## 导出的类型

| 类型 | 是什么 |
|---|---|
| `TextRef`、`TextParam` | 文字对象与它的参数值，见上文 |
| `Params<模板>` | 原文模板推出的参数对象 |
| `TextArgs<模板>` | `t()` 在键之后收的参数：没有参数的键是 `[]` |
| `TextFactory<S>` | `defineTexts` 返回的 `t()`：按键产出文字对象，身上带着字典 |
| `TextDomain` | 一个字典：`ns`、`language`、`source`、`locales`；`t()` 与目录条目都是 |
| `Localized<T>` | T 里的文字对象换成 `string` 之后的类型：出口渲染的结果、前端读到的线上类型 |
| `LocalizeSkip` | `localize` 的 `skip` 判定：`(key, parent) => boolean` |
| `ResolveOptions` | `resolveText` 的选项，见上文 |

## 宿主与出口用的

| 导出 | 用途 |
|---|---|
| `registerCatalogEntry(value)` | 登记从别处交来的目录条目（前端构建时写下的、插件前端随握手收到的 JSON），形状不合本版协议时整条不登记、回 `false`；前端字典的登记见 [api-webui 的「前端提供者」](./api-webui.md#前端提供者) |
| `catalogEntries()` | 目录里本版协议的全部字典 |
| `catalogIssues()` | 目录记下的冲突（副本） |
| `CatalogEntry` | 目录里的一个字典：`{ v: 1, ns, language, source, locales }`，只放字符串表，跨副本共用（目录在 `globalThis[Symbol.for('aalis.i18n.catalog')]`） |
| `CatalogIssue` | 同一 ns 再次登记时的冲突：原文语言不同、同键原文或译文不同、协议版本不认识 |
| `StringTable` | 键到消息模板的表 |
| `LocaleTable` | 译文表，允许缺键 |
| `fingerprint(template)` | 原文模板的指纹（FNV-1a 32 位，8 位十六进制），语言包条目的 `from` 用它 |
| `indexPacks(packs)` | 建语言包索引交给 `resolveText`：同一语言按交来的先后取先，形状不对或读取时抛错的包、表与条目跳过 |
| `LanguagePack` | 语言包：`{ id, language, entries: { [ns]: { [key]: PackText } } }` |
| `PackText` | 语言包里的一条译文：`{ text, from }` |
| `PackIndex` | 语言包索引：ns 到键到各包给的译文 |
| `matchLanguage(chain, available)` | `pickLanguage` 不找 en 的那一半：判某种语言有没有字典提供 |
| `selfName(tag)` | 该语言的自称（`English`、`日本語 (日本)`），`Intl.DisplayNames` 不收的标签用标签本身 |
| `listSeparator(language, packs?)` | `{items, list}` 用的分隔符，选法同 `resolveText`；自己罗列的出口（如前端）用它，与字典里的罗列一致 |

## 相关

- 服务契约、出口的写法与语言包贡献点：[api-i18n](./api-i18n.md)
- 默认实现：[plugin-i18n](../plugins/plugin-i18n.md)
- 插件作者的做法：[多语言：给人看的文字](../guide/i18n.md)
