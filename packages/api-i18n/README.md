# @aalis/api-i18n

多语言契约：`i18n` 服务描述符、服务接口 `I18nService`、读者 `Audience`、语言包贡献点 `i18n:pack` 与出口共用的 `localizeFor`。不含实现，默认提供者是 `@aalis/plugin-i18n`。文字对象、原文字典与解析在 `@aalis/schema-i18n`。

## 角色

- 产出文字的一方（插件、契约包、库）只依赖 `@aalis/schema-i18n`，交出文字对象；只有出口（把文字交给人看的地方）用到本包，以 `optional(i18n)` 声明。服务缺席时各处显示原文。
- `I18nService`：
  - `render(value, audience, { escape?, skip? })`：把值里的文字对象按读者的语言链渲染成字符串。
  - `chainOf(audience)`：读者的语言链，哪一层都没设时按 `['en']`。
  - `languages()`：有文字可用的语言（目录里各字典的原文语言与译文语言、语言包的语言），带自称，语言选择用它。
- 读者 `Audience`：
  - `{ languages, timeZone? }`：直接给语言链，如 WebUI 按 cookie 或 Accept-Language 解析出的；规范化后为空时按全局默认层。
  - `{ sessionId, platform?, timeZone? }`：取会话设置的 `language`，按继承链解析。
  - `{ host: true }`：取全局默认层的设置，宿主自己的输出用。
- 贡献点 `i18n:pack`：语言包，spec 是 `@aalis/schema-i18n` 的 `LanguagePack`。语言包只补字典没有的语言，取舍见该包 README「语言包」一节。

## 安装

```bash
pnpm add @aalis/api-i18n
```

## 出口的写法

```ts
import { i18n, localizeFor } from '@aalis/api-i18n';

// uses: { i18n: optional(i18n) }
const reply = localizeFor(caps.i18n, payload, { sessionId, platform }, { skip: key => key === 'args', escape: 'markdown' });
```

i18n 在场时调 `render`，缺席时按原文语言渲染（`resolveSource`，带读者的时区与转义），两支同一个 `skip`：工具参数与结果、审批的逐字参数、用户消息正文这类原样数据里形如文字对象的值可能是伪造的，要跳过。写日志、交给模型的文字不经出口，用 `toSource`。

出口的包同时直接依赖 `@aalis/schema-i18n`（产出文字本来就要用它）：只经本包间接拿到时，泛型包装函数推断出的返回类型 `Localized<T>` 在生成声明文件时无法命名（TS2742）；也可以给包装函数显式标注返回类型。

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
