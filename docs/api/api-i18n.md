# api-i18n — 多语言契约

**包名**: `@aalis/api-i18n`  
**源码**: `packages/api-i18n/src/index.ts`  
**实现**: [@aalis/plugin-i18n](../plugins/plugin-i18n.md)

## 概述

出口（WebUI、会话协议、网关、终端等把文字交给人看的地方）按读者的语言渲染文字对象：i18n 服务在场时交给它的 `render`，缺席时与 `render` 抛错时按原文语言渲染。本包定义服务描述符 `i18n`、读者 `Audience`、出口共用的 `localizeFor`、写进提示词的 `outputLanguageFor` 与语言包贡献点 `i18n:pack`。文字对象、原文字典与解析在 [schema-i18n](./schema-i18n.md)。

产出文字的一方（插件、契约包、库）只依赖 schema-i18n，交出文字对象；只有出口用到本包，以 `optional(i18n)` 声明。服务缺席时各处显示原文。

## 服务接口

```ts
const i18n = defineService<I18nService>('i18n');

interface I18nService {
  render<T>(value: T, audience: Audience, opts?: RenderOptions): Localized<T>;
  chainOf(audience: Audience): readonly string[];
  languages(): readonly LanguageInfo[];
}

interface RenderOptions {
  escape?: 'markdown';
  skip?: LocalizeSkip;
}

interface LanguageInfo {
  tag: string;   // 规范化的语言标签
  name: string;  // 该语言的自称（English、日本語），取不到时为 tag
}
```

- `render`：把值里的文字对象按读者的语言链渲染成字符串，其余原样，没有文字对象的子树不复制。`escape` 把字符串参数按 Markdown 转义；`skip` 为真的属性不进（原样数据，见 schema-i18n 的 `localize`）。
- `chainOf`：读者的语言链，规范化、去重，有条数上限；哪一层都没设时是 `['en']`。给人看的文字交文字对象即可，不必看它；按语言生成文字以外的东西（出图、调外部接口）时用，WebUI 页面的读者是 `{ host: true }`。
- `languages`：有文字可用的语言：目录里各字典的原文语言与译文语言、语言包的语言，按 `tag` 排序，带自称。

## 读者

```ts
type Audience = { sessionId: string; platform?: string } | { host: true };
```

| 写法 | 取哪条语言链 | 用在 |
|---|---|---|
| `{ sessionId, platform? }` | 会话设置的 `language`，按会话解析（`platform` 是入口平台）；会话种类是 owner 的（WebUI 与终端的会话）与 `{ host: true }` 相同 | 聊天平台上的读者：网关出站、指令回复 |
| `{ host: true }` | 全局层的设置 | owner 自己看的出口：WebUI 的 REST、会话协议、插件前端、终端、access.txt |

各层怎么解析、子会话按谁，见 [plugin-i18n](../plugins/plugin-i18n.md#语言链)。语言只从这里来，出口与插件不自己找语言来源（浏览器语言、`Accept-Language`、对话所用的语言）；日期与时间一律按服务进程的时区。

## 出口：localizeFor

```ts
function localizeFor<T>(
  i18n: Pick<ServiceSelection<I18nService>, 'present' | 'use'>,
  value: T,
  audience: Audience,
  options: LocalizeOptions,
): Localized<T>;

interface LocalizeOptions extends RenderOptions {
  onError(err: unknown): void;
}
```

出口的统一写法。i18n 在场时调 `render`；缺席时按原文语言渲染（schema-i18n 的 `resolveSource`，带转义）；`render` 抛错时把错交给 `onError`，这次同样按原文渲染。三支用同一个 `skip`。`onError` 必填：出口不因渲染出错丢消息、回 500 或退出，在这里告警，一个出口告警一次就够。

```ts
import { i18n, localizeFor } from '@aalis/api-i18n';

// uses: { i18n: optional(i18n) }
let warned = false;
const reply = localizeFor(caps.i18n, payload, { sessionId, platform }, {
  skip: key => key === 'args',
  escape: 'markdown',
  onError: err => {
    if (warned) return;
    warned = true;
    logger.warn('按读者语言渲染出错，按原文发出:', err);
  },
});
```

写日志、交给模型的文字不经出口，用 schema-i18n 的 `toSource`。

出口的包同时直接依赖 `@aalis/schema-i18n`：只经本包间接拿到时，泛型包装函数推出的返回类型 `Localized<T>` 在生成声明文件时无法命名（TS2742）；也可以给包装函数显式标注返回类型。

## 模型的输出语言：outputLanguageFor

```ts
function outputLanguageFor(
  i18n: Pick<ServiceSelection<I18nService>, 'present' | 'use'>,
  audience: Audience,
  source: string,
): string;
```

模型生成、给人看的文字（会话标题、合并转发摘要、档案事实）用哪种语言写，写进提示词：i18n 在场时取读者语言链的第一项，可以是没有语言包的语言，模型照样能写；缺席时用 `source`（调用方提示词原文的语言）。写成「自称（标签）」，如 `日本語 (日本)（ja-JP）`、`English（en）`。提示词里不写死语言，也不让模型跟对话所用的语言；读者按谁看这段文字定，owner 自己看的用 `{ host: true }`。

```ts
const system = `……生成一个简短的标题，用 ${outputLanguageFor(caps.i18n, { host: true }, 'zh-CN')}。`;
```

## 语言包：贡献点 i18n:pack

本包经 declaration merging 给 `@aalis/api-contributions` 的 `ContributionPointMap` 加一项，spec 是 schema-i18n 的 `LanguagePack`：

```ts
interface ContributionPointMap {
  'i18n:pack': LanguagePack;
}

interface LanguagePack {
  id: string;
  language: string;
  entries: { [ns: string]: { [key: string]: { text: string; from: string } } };
}
```

`text` 是译文模板，消息格式同原文；`from` 是翻译时原文模板的指纹（schema-i18n 的 `fingerprint`）。语言包随贡献它的插件激活生效、停用撤回；什么时候生效、几个包给同一条时取哪个，见 [plugin-i18n 的「渲染与语言包」](../plugins/plugin-i18n.md#渲染与语言包)。怎么写语言包、命名与关键词见 [多语言：给人看的文字](../guide/i18n.md#写语言包)。

## 实现者

[@aalis/plugin-i18n](../plugins/plugin-i18n.md)

## 相关

- 文字对象与解析：[schema-i18n](./schema-i18n.md)
- 插件作者的做法：[多语言：给人看的文字](../guide/i18n.md)
