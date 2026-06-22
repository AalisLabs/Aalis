# 概念层（concepts）

跨子系统的核心心智模型——**第一次写 Aalis 插件前应通读**。这一层定义了服务层、消息管线、
存储文法、安全模型等贯穿全框架的词汇；[服务契约层](../services/README.md)的每篇文档都建立在它们之上。

| 文档 | 讲什么 |
|---|---|
| [service-model](service-model.md) | DI 服务容器：按名注册、同名多 provider 的 `preference > priority > 注册序` 裁决、per-entry 粒度与 entryId 约定。**0.5.0 已移除「能力选择」**——能力现挂在实例/句柄上由各 `-api` helper 过滤。 |
| [lazy-service-access](lazy-service-access.md) | 为什么消费方**每次用都要重新 `getService()`**（provider bounce 会作废旧引用）；`whenService` 晚绑定；`createStorageGateway`/`createProcessGateway` 这类长生命周期 lazy 网关；`requiresBounceOnDepChange` 逃生舱。 |
| [manifest-metadata](manifest-metadata.md) | 两套独立元数据源——`package.json` 的 `aalis.service`（市场装前披露）vs `export const provides/inject`（运行时 DI）——必须手工对齐，否则市场披露缺项。 |
| [storage-uri-grammar](storage-uri-grammar.md) | `<root>:/path` 存储 URI 文法；保留 scheme（http/https/file）；`data:/`（storage）vs `data:<mime>;base64,`（data-URI）；权威 helper `isStorageUri`/`parseUriRoot`/`toStorageUri`；存储**不是沙箱**。 |
| [security-model](security-model.md) | 单 owner 威胁模型；authority 数字双轴（等级 + 确认）；`safeFetch` 作为 SSRF 防护出口；`code-sandbox-os` 的 OS 级边界；`readExternalFile` confused-deputy 面。插件作者的安全清单。 |
| [message-llm-pipeline](message-llm-pipeline.md) | 一条聊天消息如何流向 LLM：role × kind 正交、出口必调 `prepareLLMMessages`、attachment-ref 占位符、`<at id="X">` 提及文法。写 LLM provider 或发消息的插件必读。 |

> 其它入口：[插件作者隐式契约指南](../plugin-author-guide.md) · [服务契约层](../services/README.md) · [工具库（utils）](../utils/README.md) · [脚手架上手](../guide/scaffolding.md)
