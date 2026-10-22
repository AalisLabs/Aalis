# @aalis/api-i18n

多语言契约：`i18n` 服务描述符、服务接口 `I18nService`、读者 `Audience`、语言包贡献点 `i18n:pack`、出口共用的 `localizeFor` 与写进提示词的 `outputLanguageFor`。不含实现，默认提供者是 `@aalis/plugin-i18n`。文字对象、原文字典与解析在 `@aalis/schema-i18n`。

## 角色

- 产出文字的一方（插件、契约包、库）只依赖 `@aalis/schema-i18n`，交出文字对象；只有出口（把文字交给人看的地方）用到本包，以 `optional(i18n)` 声明。服务缺席时各处显示原文。
- `I18nService`：
  - `render(value, audience, { escape?, skip? })`：把值里的文字对象按读者的语言链渲染成字符串。
  - `chainOf(audience)`：读者的语言链，哪一层都没设时按 `['en']`。给人看的文字交文字对象即可，不必看它；按语言生成文字以外的东西（出图、调外部接口）时用，WebUI 页面的读者是 `{ host: true }`。
  - `languages()`：有文字可用的语言（目录里各字典的原文语言与译文语言、语言包的语言），带自称，语言选择用它。
- 读者 `Audience`：
  - `{ sessionId, platform? }`：取会话设置的 `language`，按继承链解析，聊天平台上的读者用它；会话种类是 owner 的（WebUI 与终端的会话）与 `{ host: true }` 一样。
  - `{ host: true }`：取全局层的设置（plugin-i18n 的插件配置），owner 自己看的出口（WebUI、会话协议、终端、宿主自己的输出）用它。

  语言只从 i18n 服务取，出口与插件不自己找语言来源（如浏览器语言、`Accept-Language`）；日期与时间一律按服务进程的时区。
- 贡献点 `i18n:pack`：语言包，spec 是 `@aalis/schema-i18n` 的 `LanguagePack`。语言包只补字典没有的语言，取舍见该包 README「语言包」一节。

## 安装

```bash
pnpm add @aalis/api-i18n
```

## 出口的写法

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

i18n 在场时调 `render`，缺席时按原文语言渲染（`resolveSource`，带转义）；`render` 抛错时把错交给 `onError`（必填），这次同样按原文渲染，要发出的文字不丢。出口在 `onError` 里告警，一个出口告警一次就够。各支同一个 `skip`：工具参数与结果、审批的逐字参数、用户消息正文这类原样数据里形如文字对象的值可能是伪造的，要跳过。写日志、交给模型的文字不经出口，用 `toSource`。

出口的包同时直接依赖 `@aalis/schema-i18n`（产出文字本来就要用它）：只经本包间接拿到时，泛型包装函数推断出的返回类型 `Localized<T>` 在生成声明文件时无法命名（TS2742）；也可以给包装函数显式标注返回类型。

## 模型的输出语言

模型生成、给人看的文字（会话标题、合并转发摘要、档案事实）要用的语言写进提示词，统一取 `outputLanguageFor`，提示词里不写死语言，也不让模型跟对话所用的语言：

```ts
import { i18n, outputLanguageFor } from '@aalis/api-i18n';

// uses: { i18n: optional(i18n) }
const system = `……生成一个简短的标题，用 ${outputLanguageFor(caps.i18n, { host: true }, 'zh-CN')}。`;
```

i18n 在场时取读者语言链的第一项，写成「自称（标签）」，如 `日本語 (日本)（ja-JP）`、`English（en）`；第一项可以是跟随系统解析出的、没有语言包的语言，模型照样能写。缺席时用第三个参数：调用方提示词原文的语言。读者按谁看这段文字定，owner 自己看的用 `{ host: true }`。

## 语言包

```ts
import { contributions } from '@aalis/api-contributions';
import type {} from '@aalis/api-i18n'; // 带上 i18n:pack 的类型
import { fingerprint } from '@aalis/schema-i18n';

// uses: { contributions }
contributions.use.contribute('i18n:pack', {
  id: 'ja',
  language: 'ja',
  entries: { '@your-scope/plugin-x': { title: { text: 'チェックポイントを戻す', from: fingerprint('回滚检查点') } } },
});
```

`from` 是翻译时原文模板的指纹，原文改了措辞的条目当作缺失。语言包随贡献它的插件激活生效、停用撤回。

罗列（`{x, list}`）的分隔符是 `@aalis/schema-i18n` 字典的 `listSeparator` 键，自带 zh-CN 与 en；别的语言由语言包补，没补时用 en 的「, 」。日文要用「、」就在 `entries` 里加 `'@aalis/schema-i18n': { listSeparator: { text: '、', from: fingerprint('、') } }`。
