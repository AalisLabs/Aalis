# @aalis/schema-i18n

给人看的文字对象：原文字典、ICU 消息格式（子集）与按读者语言解析。

要翻译的文字一律是**文字对象**（`TextRef`），取自所属包的原文字典，键由作者起、参数有类型。产出文字的一方只依赖本包；出口在 i18n 服务在场时按读者的语言链渲染，不在场时按原文语言渲染（`resolveSource`）。声明里写普通字符串也可以，那就是不翻译的原文。

零运行时依赖、不用 `node:` 模块，浏览器里同样可用。

## 原文字典与译文

```ts
// src/texts.ts
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = { saved: '已保存 {count, number} 项', title: '回滚检查点' } as const;
export type Source = typeof SOURCE;
export const t = defineTexts({ ns: '@your-scope/plugin-x', language: 'zh-CN', source: SOURCE, locales: { en } });

t('saved', { count: 3 }); // 文字对象；参数从原文推出
t('title'); // 没有参数的键不收第二参
```

```ts
// src/locales/en.ts
import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({ saved: 'Saved {count, plural, one {# item} other {# items}}' });
```

- **`defineTexts({ ns, language, source, locales? })`**：登记字典并返回 `t()`。`ns` 写包名（改包名时同步改）；`language` 与 `locales` 的键过 `Intl.getCanonicalLocales`，非法即抛（`zh_CN` 不行，写 `zh-CN`）。`source` 要写成 `as const` 的对象（或就地写字面量），漏了编译报错。`t()` 身上带着这份字典（`ns`、`language`、`source`、`locales`）。
- **`defineLocale<Source>()(entries)`**：就地写对象字面量。原文里没有的键、不是字面量的译文、与原文参数不兼容的译文编译报错，缺的键允许。兼容指译文用到的参数原文都有，且收得下原文交来的值：原文 `{count}` 收字符串，译文要用 plural 时原文也写成 `{count, number}` 或 plural。
- `t()` 的键是联合类型（`t(flag ? 'a' : 'b', …)`）时要交齐各键的参数。参数在生成时复制一层，调用方之后改自己的对象或数组不影响文字对象。
- 键一旦落盘就是约定：意思或参数变了换新键，删掉的键不复用；改了原文措辞要同步改译文。
- 单份字典控制在几百键以内：`defineLocale` 逐条核参数，上千键的文件在编辑器里诊断会慢。大的按区域拆成几份同一 `ns` 的 `defineTexts`（目录按键合并）。
- 第一方原文是 `zh-CN`，带 `en` 译文；推荐的语言标签与第一方一致（`en`、`zh-CN`）。

## 文字对象

```ts
interface TextRef { readonly i18n: string; readonly key: string; readonly params?: Readonly<Record<string, TextParam>>; readonly source: string }
type TextParam = string | number | TextRef | readonly (string | number | TextRef)[];
```

纯数据，可序列化、可落盘。`i18n` 是所属包名，兼作识别标记；`source` 是生成时按原文渲染的整句（原文渲染失败时为原文模板原样），日志、给模型的文字与不认识这个结构的消费者用它。

| 函数 | 说明 |
|---|---|
| `asText(v)` | 展示值（core 的插件显示名、服务 label 这类 `unknown` 字段）收窄成文字：字符串与文字对象原样，其余 `undefined` |
| `isTextRef(v)` | 按形状判：`i18n`、`key`、`source` 是字符串，`params` 缺省或为普通对象，没有别的键。从 JSON 读回的、另一份本包产出的都认 |
| `toSource(v)` / `toSourceReplacer` | 把值里的文字对象换成 source；后者给 `JSON.stringify` 用。写日志、交给模型时用（取生成时的整句） |
| `localize(v, render, skip?)` | 遍历普通对象与数组，把文字对象换成 `render(text)`；没有文字对象的子树原样返回、不复制。`skip(key, parent)` 为真的属性不进：出口用它避开原样数据（工具参数与结果、审批的逐字参数、用户消息正文），那里形如文字对象的值可能是伪造的 |
| `textLines(parts)` | 把若干段（字符串或文字对象）按行连成一个文字对象，多行报告、列表类回复用它 |
| `textClauses(parts)` | 把若干分句连成一句：原文以「；」相连，英文以「; 」。并列的几条原因、几个问题用它；两两二分着嵌套，层数随句数按对数增长，n 句约占 2n 个参数里的文字对象，每句另带文字对象参数时更多（配置校验的问题每句 3 个，约 340 句起超出渲染上限、回落成原文） |
| `TextError` | `new TextError(text, { status?, cause? })`，message 是 `text.source`，name 为 `TextError` |
| `withText(err, text)` | 给任意 Error 挂上文字对象，name 与类不变（按 name 判定的错误照旧认得）；message 不动 |
| `isTextError(e)` | 按结构判：Error 且 `e.text` 是文字对象。另一份包的 `TextError`、改了 name 的子类都认 |
| `textOf(err)` | 接住的报错作参数用：有文字对象取它，否则 message（抛出的普通对象也取），再否则 `String(err)`。不要取 `.message` 拼句 |

文字对象拼进字符串只会得到 `[object Object]`：要拼进句子就把它作为另一条文字对象的参数，或在出口渲染之后再拼。

类型工具：`Localized<T>` 把 T 里的文字对象换成 string（出口渲染的结果、前端读到的线上类型）；`LocalizeSkip` 是 skip 判定的类型。

## 消息格式

自写的 ICU 子集：

- `{name}`：参数名限 `[A-Za-z_][A-Za-z0-9_]*`。字符串原样，数原样转字符串，文字对象按读者语言渲染。
- `{n, plural, =0 {…} one {…} other {…}}`：`=N` 精确匹配先于类别，类别取 `Intl.PluralRules`。`#` 只在直接所在的 plural 分支里替换为该数（按语言的 `NumberFormat`），嵌在 select 里的 `#` 是字面。
- `{x, select, a {…} other {…}}`：x 是字符串。
- `{n, number}`：`NumberFormat`。
- `{t, date|time|datetime, short|medium|long}`：t 是毫秒时间戳，样式缺省 medium，时区取渲染参数的 `timeZone`，缺省或不认识时用进程时区。
- `{items, list}`：`ListFormat` 的 conjunction；`{items, lines}`：按行连接。元素各自渲染。
- `{ms, duration}`：天、时、分、秒最多两级，按显示的最小一级四舍五入；负数只在第一级带负号。
- `{n, size}`：B、KB、MB、GB，按 1024 进位，B 以上留一位小数；舍入后到了 1024 就升一级。
- `{x, code}`：行内代码，x 是字符串或数。围栏比参数里最长的反引号串多一个，参数原样、不转义。参数要放进代码段时用它，不要在模板里写 `` `{x}` ``：Markdown 出口转义后代码段里会显出反斜杠。

plural 与 select 必须有 other；未知类型、花括号不配平、重复的分支键、`offset:`、嵌套超过 16 层都算解析失败。plural、number、date、time、datetime、duration、size 要求有限数，list、lines 要求数组，不符算渲染失败。

引号同 ICU 的 DOUBLE_OPTIONAL，只是 `#` 不分是否在 plural 分支里：`''` 是一个撇号；`'` 紧跟 `{`、`}`、`#` 时引用到下一个单独的 `'`，没闭合就到串尾；其余单个 `'` 是字面（`can't` 无需处理）。字面的花括号写成 `'{query}'`。英文里给参数加引号要用 ‘ ’ 或 “ ”：`'{name}'` 是字面的 `{name}`，不替换参数。

渲染与解析失败一律不抛：`t()` 的 source 退成原文模板原样，`resolveText` 退成 `text.source`。

类型层推参与运行时同一套文法（按花括号配平递归下降）：plural、number、date、time、datetime、duration、size 推为 number，list、lines 推为数组，select 推为分支键的联合并上 string，code 推为 `string | number`，其余为 `string | number | TextRef`，同名取更具体的类型。导出 `Params<模板>` 与 `TextArgs<模板>`。文法错误（未知类型、花括号不配平）类型层不报，交给 `checkTexts`。

## 解析与语言链

`resolveText(text, chain, { packs?, timeZone?, escape? })` 是纯函数：

1. 可用语言 = 原文语言 ∪ 字典自带译文的语言 ∪ 语言包补的语言（只按这个键算）；解析失败、参数与原文不兼容的译文不算。
2. 读者链里逐项找语言与文字（maximize 之后的 script）都相同的，同文字内地区相同者优先：zh、zh-CN、zh-Hans-CN、zh-SG 都命中 zh-CN；命中原文语言就用原文。
3. 再逐项找语言相同、文字不同的：zh-TW 读者遇到只有简体时用简体。
4. 再找 en；都没有用原文。

ns 不在目录、键不存在、原文解析失败、选中的那条渲染失败时用 `text.source`。参数里的文字对象用同一条链递归：一次渲染（一次 `resolveText` 或 `resolveSource`）里至多渲染 1024 个、嵌套 32 层，超出的用那一个的 source，伪造的重复参数不放大、环不挂死。`escape: 'markdown'` 把字符串参数按 Markdown 转义（字典里写的 Markdown 原样），Markdown 正文一类出口用；这时回落的 `text.source` 整句转义（模板自带的格式随之失效，换来参数不被当成 Markdown）。

`resolveSource(text, { timeZone?, escape? })` 只按原文语言渲染，出口在 i18n 服务缺席时用：带读者的时区与转义，参数里的文字对象同样取各自的原文，回落规则同上。

`normalizeLanguages(tags)` 整理读者给的语言列表：下划线换连字符、去掉 `.UTF-8` 这类后缀、过 `getCanonicalLocales`，不合法的丢掉，去重保序。

## 进程级目录

字典登记在 `globalThis[Symbol.for('aalis.i18n.catalog')]`，进程里装了几份本包都共用。目录与条目的形状是跨副本的协议：目录是 `{ entries: Map<ns, 条目>, issues: 冲突[] }`，条目是 `{ v: 1, ns, language, source, locales }`，只放字符串表。条目结构有破坏性改动时升 `v`，解析遇到不认识的 `v` 退回 `text.source`。

同一 ns 再次登记按键合并：已有键保留先登记的，新键补入；同键不同文、原文语言不同、版本不认识都记进冲突。`catalogEntries()` 读目录里的字典，`catalogIssues()` 读冲突，库本身不打日志。目录随进程存在，测试里各用不同的 ns。

## 语言包

语言包给字典补它没有的语言：`{ id, language, entries: { [ns]: { [key]: { text, from } } } }`，`from` 是翻译时原文模板的 `fingerprint`。`indexPacks(packs)` 建索引交给 `resolveText`，形状不对或读取时抛错的包、表与条目跳过：字典自带同语言同键时语言包不生效；`from` 与当前原文的指纹不符当作缺失；多个包给同一条时按交来的先后取先（plugin-i18n 按贡献点的全局键交来，包名在前）。

## 自检

```ts
import { checkTexts } from '@aalis/schema-i18n';
import { t } from '../src/texts.js';

expect(checkTexts(t)).toEqual([]);
```

返回问题列表：原文或译文解析失败（`parse`）；原文里同一参数的用法互不相容、或译文参数与原文不兼容（`params`）；引号把原文的参数写成了字面（`quote`）；反引号里直接写参数（`code`）；各语言缺的键（`missing`）。也收目录里的条目。
