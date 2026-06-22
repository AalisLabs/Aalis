# 服务契约层（services）

每个 `@aalis/plugin-*-api` 契约包对应一篇文档，面向**写 provider** 或**消费服务**的第三方作者。
每篇统一结构：一句话定位 + 服务注册名 → 契约接口签名 → 谁提供/谁消费 → 写一个 provider（最小必须 vs 可选、
`ctx.provide` 注册、双源对齐）→ 标准消费姿势（lazy `getService`）→ 能力/风险→影响 → 边界与坑 → 交叉链接。

先读[概念层](../concepts/README.md)（服务模型、惰性访问、双源 manifest），再按需查下表。

## 基础设施
| 服务 | 定位 |
|---|---|
| [storage](storage.md) | 存储后端：声明根（读/写/删权限位）、`<root>:/path` 读写删；`resolveLocalPath` 可选且**非沙箱**。参考实现 storage-local。 |
| [memory](memory.md) | 会话消息持久化 + 最近消息/区间查询。参考实现 memory-sqlite。 |
| [vectorstore](vectorstore.md) | 向量库 add/search/deleteByFilter；维度不匹配处理；flat（真余弦）vs lancedb（1−L2）跨后端分数不可比。 |
| [embedding](embedding.md) | 文本 → 向量 provider。 |
| [process](process.md) | 子进程执行 + `readExternalFile`；输出缓冲须有界；**非沙箱**。参考实现 process-local。 |
| [code-sandbox](code-sandbox.md) | OS 级沙箱（bwrap/seatbelt）、fail-closed；v1 非强隔离、不挡读。参考实现 code-sandbox-os。 |

## 消息与平台
| 服务 | 定位 |
|---|---|
| [gateway](gateway.md) | 平台消息网关：入站/出站路由；adapter 经它收发，agent 回话走 `dispatchOutbound`。 |
| [platform](platform.md) | 平台身份/self 识别 helper，供 adapter/persona 消费。 |
| [message](message.md) | 契约（Message role×kind 模型）——详见[概念层 message-llm-pipeline](../concepts/message-llm-pipeline.md)，本篇为类型速查。 |
| [message-archive](message-archive.md) | shadow 归档服务；串行归档契约。 |
| [flow-control](flow-control.md) | 消息流控（去抖/合并/触发策略）：何时让缓冲的入站消息触发一轮 agent。 |

## 智能体核心
| 服务 | 定位 |
|---|---|
| [agent](agent.md) | agent 回合编排（LLM loop）；`agent:input:before`/`agent:turn:after` hook；abort 语义。 |
| [llm](llm.md) | LLM 对话 provider：出口必调 `prepareLLMMessages`、流式 + 工具调用、model 句柄带能力元数据。参考实现 openai/deepseek/ollama。 |
| [persona](persona.md) | 人设角色卡 + `outputFormat` + 状态持久化 + skills 白名单。 |
| [commands](commands.md) | `/command` 注册与分发；authority risk 门控。 |
| [session-manager](session-manager.md) | 会话配置解析（persona/输出格式）+ 生命周期 + subtask `inputContext`。 |

## 安全与确认
| 服务 | 定位 |
|---|---|
| [authority](authority.md) | 访问控制：开放数字等级 + 双轴（等级 + 确认）；risk/visibility/deniedCapabilities；owner=∞。参考实现 authority。 |
| [session-confirm](session-confirm.md) | HITL 人确认（轴 B）；`setConfirmHandler` IoC；依赖 gateway 而非 authority。 |

## 工具与媒体
| 服务 | 定位 |
|---|---|
| [tools](tools.md) | 工具注册表：`ToolDefinition`（`{type:'function',function:{...}}`）+ handler 返回 string；执行守卫（restricted/confirm）。参考实现 tool-system。 |
| [tool-session](tool-session.md) | 按会话的工具状态 / 上传文件登记。 |
| [media](media.md) | 媒体转码/图片描述；detailLevel 档；描述缓存用 util-bounded-map。 |
| [asr](asr.md) | 语音转写 provider（音频 → 文本）。参考实现 asr-openai/whisper-cpp。 |

## 调度与运维
| 服务 | 定位 |
|---|---|
| [workflow](workflow.md) | 工作流引擎 + 触发器；event 触发 payload 作为 `{{vars.X}}` 注入。 |
| [cron-engine](cron-engine.md) | cron 调度原语（workflow/scheduler 触发器底层）。 |
| [doctor](doctor.md) | 健康检查注册与聚合。 |

## 前端
| 服务 | 定位 |
|---|---|
| [webui](webui.md) | WebUI 扩展 API：注册页面/面板、市场、配置表单（SchemaField）。AGPL 层。 |

> 其它入口：[概念层](../concepts/README.md) · [工具库（utils）](../utils/README.md) · [脚手架上手](../guide/scaffolding.md) · [插件作者隐式契约指南](../plugin-author-guide.md)
