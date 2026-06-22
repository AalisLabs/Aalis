# 工具库（utils）

`@aalis/util-*` 是**零服务、零 DI 的纯函数库**（以 `aalis-util` 关键词标识）。插件在 `package.json`
里依赖它们、直接 `import` 使用——不经 `ctx`、不经服务容器。能复用就别重抄（参见框架的「单一消费者别污染通用契约」原则）。

| 工具库 | 定位 |
|---|---|
| [bounded-map](bounded-map.md) | `createBoundedMap({max, ttlMs, onEvict})` —— 有界 LRU + 滑动 TTL Map，给无界缓存封顶。消费者：media 图片描述缓存、office 文档会话、prompt-budget。 |
| [json-repair](json-repair.md) | 从脏 LLM 输出里捞出 JSON **对象**（去代码围栏/散文/尾随噪声）：`extractJsonCandidate`/`tryParseJsonObject`/`parseLLMJsonObject`。**仅对象**——顶层数组不解析（这也是 user-relation 顶层数组场景另写解析器的原因）。 |
| [network-guard](network-guard.md) | SSRF 防护出口：`safeFetch`（逐跳重定向复核）/`assertSafeUrl`/`assertSafeHost`/`isPrivateAddress`/`setNetworkPolicy`。**任何用户/LLM 可影响的 URL 都应经它**。威胁模型见[概念层 security-model](../concepts/security-model.md)。 |
| [text-normalize](text-normalize.md) | 归一 LLM 助手输出：`fixGfmTables`/`stripLeakedSpecialTokens`/`normalizeAssistantContent`（修 GFM 表格、剥泄漏的特殊 token）。 |

> 其它入口：[概念层](../concepts/README.md) · [服务契约层](../services/README.md) · [脚手架上手](../guide/scaffolding.md) · [插件作者隐式契约指南](../plugin-author-guide.md)
