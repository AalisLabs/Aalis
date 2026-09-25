# 插件（plugins）

Aalis「万物皆插件」：适配器、模型、存储、工具、前端全部以插件形态存在。本区收录**官方维护**的插件，按功能分组（见左侧侧边栏）。社区长尾插件请用 WebUI 内的**插件市场**搜索安装。

每篇插件文档统一：一句话定位 → 配置项（`configSchema`）→ 提供 / 消费的服务 → 注意事项。写自己的插件见[脚手架上手](../guide/scaffolding.md)与[插件作者隐式契约指南](../plugin-author-guide.md)。

## 按功能查

- **钩子与贡献点**：`hooks` 与 `contributions` 两个服务的默认提供者；gateway、agent 等多数插件依赖它们。
- **平台适配器**：接入聊天平台（onebot…）。
- **模型与嵌入**：LLM 对话与文本嵌入 provider（openai / deepseek / ollama）。
- **记忆与向量存储**：会话消息持久化与向量检索（sqlite / mongodb / inmemory / lancedb / flat…）。
- **智能体与人设**：agent 回合编排、人设、会话管理、子任务、技能、待办、用户关系。
- **工具与 MCP**：AI 可调用工具（浏览器 / 搜索 / 代码执行 / 数学 / 文件 / office…）与 MCP 互操作（client / server）。
- **存储与媒体**：本地存储、会话检查点、多模态媒体识别、绘图。
- **调度、网关与运维**：定时与工作流、消息网关与流控、命令、CLI、权限。
- **前端 WebUI**：管理界面服务端与客户端（AGPL 层）。

> 其它入口：[服务契约层](../services/README.md) · [API 契约](../api/README.md) · [脚手架上手](../guide/scaffolding.md) · [概念层](../concepts/README.md)
