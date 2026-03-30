# Aalis

一个基于大型语言模型的模块化智能助手框架，采用 **服务 IoC + 能力声明** 架构。

> 📖 **详细技术文档**: 参见 [`docs/`](docs/) 目录

## 特性

- **模块化插件系统** — 所有功能均为可热插拔的插件，核心框架零外部依赖
- **服务 IoC + 能力声明** — 插件声明所需能力，框架自动匹配最佳实现
- **多 LLM 支持** — DeepSeek / OpenAI 及兼容接口，支持深度思考与工具调用
- **语义记忆** — 向量化长期记忆，基于语义相似度 + 时间衰减检索历史上下文
- **多后端存储** — SQLite / MongoDB 消息历史，LanceDB / 平面文件向量存储
- **上下文管理** — 自动 token 计数、消息截断、长期记忆预算保护
- **机器交互工具** — 内置 Shell / 文件 / 系统 / HTTP 工具，AI 可操控本地环境
- **多平台接入** — CLI 终端、Web 管理界面、OneBot v11/v12 协议（QQ 等）
- **联网搜索** — Serper API 集成，AI 可主动搜索互联网
- **工具搜索层** — 工具数量多时自动启用搜索机制，减少 LLM token 消耗
- **Web 管理界面** — 实时对话、流式输出、插件配置、服务状态、平台监控
- **角色人格** — YAML 角色卡定义 AI 的性格、行为与结构化输出格式
- **权限系统** — 多级权限控制与高危操作交互式确认

## 设计理念

Aalis 受 [internal-framework](https://internal-framework.chat) 的服务提供机制和 [internal-framework](https://internal-framework.ai) 的多平台接入启发，核心设计为：

| 模式 | 说明 |
|---|---|
| **服务 IoC 容器 + 能力声明** | 插件注册/消费服务时可声明所需能力，框架自动匹配最佳实现 |
| **类型安全事件总线** | 插件间通过事件松耦合通信 |
| **中间件钩子管道** | 插件可拦截消息处理、LLM 调用、工具调用等核心流程 |
| **反应式插件生命周期** | 依赖的服务就绪时自动激活插件，服务移除时自动停用 |
| **优雅降级** | 核心服务缺失时自动 fallback（如内存记忆），插件加载失败不影响其他功能 |

### 能力声明 (Capability Declaration)

传统服务依赖是"我需要 `llm` 服务"，Aalis 的能力声明支持更细粒度的匹配：

```typescript
// 插件声明: 需要一个支持工具调用的 LLM 服务
export const inject = {
  required: [{ service: 'llm', capabilities: ['tool_calling'] }],
};

// LLM 插件注册时声明自己的能力
ctx.provide('llm', service, {
  capabilities: ['chat', 'tool_calling', 'streaming'],
});
```

当有多个 LLM 实现时，框架会自动匹配满足所需能力的最高优先级提供者。

## 项目结构

```
aalis/
├── aalis.config.yaml              # 全局配置（YAML + 环境变量插值）
├── data/
│   ├── personas/                  # 角色卡目录
│   ├── aalis.db                   # SQLite 数据库（运行时生成）
│   ├── lancedb/                   # LanceDB 向量数据（运行时生成）
│   └── users.json                 # 用户权限数据（运行时生成）
├── docs/                          # 技术文档
│   ├── architecture.md            # 架构总览
│   ├── core/                      # 核心模块文档
│   └── plugins/                   # 插件文档
├── packages/
│   ├── core/                      # 核心框架
│   ├── plugin-agent-default/      # 默认对话 Agent
│   ├── plugin-deepseek/           # DeepSeek LLM
│   ├── plugin-openai/             # OpenAI-compatible LLM
│   ├── plugin-persona/            # 角色人格管理
│   ├── plugin-memory-sqlite/      # SQLite 消息历史
│   ├── plugin-memory-mongodb/     # MongoDB 消息历史
│   ├── plugin-memory-vector/      # 向量语义记忆
│   ├── plugin-embedding-ollama/   # Ollama Embedding
│   ├── plugin-embedding-openai/   # OpenAI Embedding
│   ├── plugin-vectorstore-flat/   # 平面 JSON 向量存储
│   ├── plugin-vectorstore-lancedb/# LanceDB 向量存储
│   ├── plugin-tools-system/       # 系统工具集（Shell / 文件 / 系统 / HTTP）
│   ├── plugin-tool-search/        # 工具搜索层
│   ├── plugin-websearch-serper/   # Serper 联网搜索
│   ├── plugin-adapter-onebot/     # OneBot v11/v12 协议适配器
│   ├── plugin-cli/                # 终端对话界面
│   ├── plugin-webui-server/       # Web 管理后端（Express + WebSocket）
│   └── plugin-webui-client/       # Web 管理前端（React SPA）
└── src/
    └── index.ts                   # 主入口
```

## 核心服务

| 服务名 | 描述 | 实现插件 |
|---|---|---|
| `llm` | AI 模型调用（对话、工具调用、流式输出） | plugin-deepseek, plugin-openai |
| `agent` | 对话编排（消息构建、工具循环、上下文管理） | plugin-agent-default |
| `memory` | 消息历史存储与检索 | plugin-memory-sqlite, plugin-memory-mongodb |
| `embedding` | 文本向量化 | plugin-embedding-ollama, plugin-embedding-openai |
| `vectorstore` | 向量存储与相似度检索 | plugin-vectorstore-lancedb, plugin-vectorstore-flat |
| `persona` | 角色人格管理 | plugin-persona |
| `platform` | 聊天平台适配器 | plugin-adapter-onebot, plugin-cli, plugin-webui |
| `websearch` | 联网搜索 | plugin-websearch-serper |
| `tools` | AI 工具注册表 | core (内置), plugin-tools-system |
| `semantic-memory` | 语义长期记忆 | plugin-memory-vector |

## 快速开始

### 前置要求

- Node.js >= 22
- pnpm >= 9

### 安装

```bash
git clone <your-repo-url> aalis
cd aalis
pnpm install
pnpm build
```

### 配置

编辑 `aalis.config.yaml`:

```yaml
name: Aalis
logLevel: info

plugins:
  "@aalis/plugin-deepseek":
    apiKey: "${DEEPSEEK_API_KEY}"   # 支持环境变量插值
    baseUrl: "https://api.deepseek.com"
    model: "deepseek-chat"
  "@aalis/plugin-memory-sqlite":
    path: "data/aalis.db"
  "@aalis/plugin-embedding-ollama":
    baseUrl: "http://localhost:11434"
    model: "qwen3-embedding:8b"
  "@aalis/plugin-persona":
    persona: default
    personasDir: data/personas
  "@aalis/plugin-cli":
    prompt: "You"
  "@aalis/plugin-webui-server":
    port: 8080
    host: 127.0.0.1
  "@aalis/plugin-adapter-onebot":
    connections:
      - url: ws://127.0.0.1:3001
        protocol: auto              # auto | v11 | v12

# 禁用不需要的插件
disabledPlugins:
  - "@aalis/plugin-memory-mongodb"
  - "@aalis/plugin-openai"

commandPrefix: "/"
commandAsTools: true
defaultAuthority: 1
```

### 启动

```bash
# 开发模式
pnpm dev

# 生产模式
pnpm build && pnpm start
```

启动后可通过 CLI 终端直接对话，或访问 Web 管理界面。

## 编写插件

一个 Aalis 插件需要导出 `name`、可选的 `inject`/`provides`/`configSchema` 和 `apply` 函数：

```typescript
import type { Context, ConfigSchema } from '@aalis/core';

export const name = 'my-plugin';

export const inject = {
  required: ['llm'],
  optional: [{ service: 'memory', capabilities: ['persistence'] }],
};

export const provides = ['my-service'];

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true },
  maxRetries: { type: 'number', label: '最大重试', default: 3 },
};

export function apply(ctx: Context, config: Record<string, unknown>) {
  // 注册 AI 工具
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'my_tool',
        strict: true,
        description: '工具描述',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string', description: '输入' } },
          required: ['input'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => `处理结果: ${args.input}`,
  });

  // 监听事件
  ctx.on('message:received', async (msg) => {
    ctx.logger.info(`收到消息: ${msg.content}`);
  });

  // 注册中间件钩子
  ctx.middleware('response:before', async (data, next) => {
    await next();
    data.content += '\n\n— by my-plugin';
  });

  // 提供服务
  ctx.provide('my-service', myServiceInstance, {
    capabilities: ['feature-a', 'feature-b'],
  });
}
```

> 📖 更多插件开发细节参见 [docs/architecture.md](docs/architecture.md)

## 角色卡

角色卡使用 YAML 格式，放在 `data/personas/` 目录下:

```yaml
name: Aalis
description: 一个友善的 AI 助手
prompt: |
  你是 Aalis，一个运行在用户电脑上的智能助手。
  请以友好、专业的态度与用户交流。
traits:
  - 友善
  - 专业
  - 诚实
greeting: "你好！有什么我可以帮你的吗？"
# 结构化输出（可选）— 空 reply 字段可实现静默不回复
outputFormat:
  reply:
    description: 发送给用户的回复（置空则不回复）
    reply: true
  thinking:
    description: 内部推理过程（不发送）
```

## CLI 命令

在终端或 WebUI 对话中可使用：

| 命令 | 描述 | 权限 |
|---|---|---|
| `/help` | 显示帮助信息 | 0 |
| `/clear` | 清空当前会话历史及长期记忆 | 0 |
| `/status` | 显示系统状态 | 0 |
| `/shutdown` | 关闭应用 | 5 (dangerous) |
| `/restart` | 重启应用 | 5 (dangerous) |
| `/grant <platform:userId> <level>` | 设置用户权限等级 | 2 |
| `/authority [platform:userId]` | 查看权限等级 | 0 |

## 技术文档

详细的技术实现文档位于 [`docs/`](docs/) 目录：

| 文档 | 内容 |
|---|---|
| [架构总览](docs/architecture.md) | 系统架构、消息处理流程、设计模式 |
| [核心 — 应用容器](docs/core/app.md) | App 类、启动流程、内置指令 |
| [核心 — 执行上下文](docs/core/context.md) | Context 类、IoC 容器、生命周期 |
| [核心 — 服务容器](docs/core/service.md) | 服务注册、能力匹配、优先级 |
| [核心 — 插件管理](docs/core/plugin.md) | 插件生命周期、Soft Reload、依赖追踪 |
| [核心 — 事件系统](docs/core/events.md) | EventBus、钩子管道 |
| [核心 — 配置管理](docs/core/config.md) | YAML 配置、环境变量、Schema |
| [核心 — 指令系统](docs/core/commands.md) | 指令注册、权限检查、工具桥接 |
| [核心 — 工具注册表](docs/core/tools.md) | 工具注册、权限、执行 |
| [核心 — 权限系统](docs/core/authority.md) | 权限等级、Owner、高危确认 |
| [核心 — 类型定义](docs/core/types.md) | 所有核心类型参考 |
| [插件 — LLM 服务](docs/plugins/llm.md) | DeepSeek / OpenAI 实现 |
| [插件 — 对话 Agent](docs/plugins/agent.md) | 消息编排、工具循环、上下文截断 |
| [插件 — 记忆存储](docs/plugins/memory.md) | SQLite / MongoDB / 向量语义记忆 |
| [插件 — 向量与 Embedding](docs/plugins/vector.md) | Embedding 服务与向量存储 |
| [插件 — 工具集](docs/plugins/tools.md) | Shell / 文件 / 系统 / HTTP 工具 |
| [插件 — 平台适配器](docs/plugins/platform.md) | CLI / WebUI / OneBot |
| [插件 — 其他](docs/plugins/misc.md) | 角色、搜索、工具搜索层 |

## TODO

- [ ] 数据库定时清理/压缩策略（按 TTL 或条数上限淘汰旧消息）
- [ ] 向量记忆摘要压缩（批量总结旧记忆为摘要后丢弃原文）
- [ ] 反向 WebSocket 支持（OneBot 适配器）
- [ ] 更多平台适配器（Discord、Telegram 等）
- [ ] 插件市场与远程安装

## 开发进度

### ✅ 已完成

- [x] 核心框架（服务 IoC + 能力声明 + 事件总线 + 响应式插件生命周期）
- [x] 配置管理（YAML + 环境变量插值 + 启动时自动同步插件默认值）
- [x] 工具注册表（OpenAI function calling 格式 + 权限系统）
- [x] 默认 Agent（消息编排 + 工具调用循环 + 上下文截断 + 长期记忆预算保护）
- [x] DeepSeek LLM 插件（深度思考 + 工具调用 + 流式输出）
- [x] OpenAI-compatible LLM 插件
- [x] 角色卡插件
- [x] SQLite 记忆插件
- [x] MongoDB 记忆插件
- [x] 向量语义记忆插件（自动注入语义相关历史到 system prompt）
- [x] Ollama / OpenAI Embedding 插件
- [x] LanceDB / 平面文件向量存储插件
- [x] 机器交互工具插件（Shell / 文件 / 系统 / HTTP，含 SSRF 防护）
- [x] Serper 联网搜索插件
- [x] OneBot 12 协议适配器（WebSocket 多连接 + 自动重连）
- [x] CLI 终端对话插件
- [x] Web 管理界面（实时对话 + 插件配置 + 服务状态 + 平台监控 + 日志流）
- [x] 交互式 tool call 显示（对话与思考中内联展示工具调用过程）
- [x] 插件自动发现（扫描 packages/ 目录，无需手动声明依赖）
- [x] 优雅降级（Memory / Agent 缺失时自动 fallback）
- [x] 图像理解（多模态消息）

### 🔲 计划中

- [-] 热重载支持 #部分支持
- [ ] 更多 LLM 接口（Gemini、本地模型等）
- [ ] npm 包发布与第三方插件生态

## 许可证

估计会是GPL，没有确定