# Aalis

一个基于大型语言模型的模块化智能助手框架，采用 **服务 IoC + 能力声明** 架构。

## 特性

- **模块化插件系统** — 所有功能均为可热插拔的插件，核心框架零外部依赖
- **服务 IoC + 能力声明** — 插件声明所需能力，框架自动匹配最佳实现
- **多 LLM 支持** — DeepSeek / OpenAI 及兼容接口，支持深度思考与工具调用
- **语义记忆** — 向量化长期记忆，基于语义相似度检索历史上下文
- **多后端存储** — SQLite / MongoDB 消息历史，LanceDB / 平面文件向量存储
- **上下文管理** — 自动 token 计数、消息截断、长期记忆预算保护
- **机器交互工具** — 内置 Shell / 文件 / 系统 / HTTP 工具，AI 可操控本地环境
- **多平台接入** — CLI 终端、Web 管理界面、OneBot 12 协议（QQ 等）
- **联网搜索** — Serper API 集成，AI 可主动搜索互联网
- **Web 管理界面** — 实时对话、插件配置、服务状态、平台监控
- **角色人格** — YAML 角色卡定义 AI 的性格与行为

## 设计理念

Aalis 受 [internal-framework](https://internal-framework.chat) 的服务提供机制和 [internal-framework](https://internal-framework.ai) 的多平台接入启发，核心设计为：

| 模式 | 说明 |
|---|---|
| **服务 IoC 容器 + 能力声明** | 插件注册/消费服务时可声明所需能力，框架自动匹配最佳实现 |
| **类型安全事件总线** | 插件间通过事件松耦合通信 |
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
├── personas/
│   └── default.yaml               # 默认角色卡
├── packages/
│   ├── core/                      # 核心框架（EventBus, ServiceContainer, PluginManager, Config...）
│   ├── plugin-agent-default/      # 默认对话 Agent（消息编排 + 工具调用循环 + 上下文截断）
│   ├── plugin-deepseek/           # DeepSeek LLM（支持深度思考 + 工具调用）
│   ├── plugin-openai/             # OpenAI-compatible LLM
│   ├── plugin-persona/            # 角色人格管理
│   ├── plugin-memory-sqlite/      # SQLite 消息历史
│   ├── plugin-memory-mongodb/     # MongoDB 消息历史
│   ├── plugin-memory-vector/      # 向量语义记忆（自动注入相关上下文）
│   ├── plugin-embedding-ollama/   # Ollama Embedding
│   ├── plugin-embedding-openai/   # OpenAI Embedding
│   ├── plugin-vectorstore-flat/   # 平面 JSON 向量存储
│   ├── plugin-vectorstore-lancedb/# LanceDB 向量存储
│   ├── plugin-tools-basic/        # 机器交互工具（Shell / 文件 / 系统 / HTTP）
│   ├── plugin-websearch-serper/   # Serper 联网搜索
│   ├── plugin-adapter-onebot/     # OneBot 12 协议适配器
│   ├── plugin-cli/                # 终端对话界面
│   └── plugin-webui/              # Web 管理界面（Express + WebSocket + React）
│       └── client/                # 前端 SPA
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
| `tools` | AI 工具注册表 | core (内置), plugin-tools-basic |

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
persona: default

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
  "@aalis/plugin-cli":
    prompt: "You"
  "@aalis/plugin-webui":
    port: 3000

# 禁用不需要的插件
disabledPlugins:
  - "@aalis/plugin-memory-mongodb"
  - "@aalis/plugin-openai"
```

### 启动

```bash
# 开发模式
pnpm dev

# 生产模式
pnpm build && pnpm start
```

启动后可通过 CLI 终端直接对话，或访问 `http://localhost:3000` 打开 Web 管理界面。

## 编写插件

一个 Aalis 插件需要导出 `name`、可选的 `inject`/`provides`/`configSchema` 和 `apply` 函数：

```typescript
import type { Context, ConfigSchema } from '@aalis/core';

export const name = 'my-plugin';

// 依赖声明 (支持能力匹配)
export const inject = {
  required: ['llm'],
  optional: [{ service: 'memory', capabilities: ['persistence'] }],
};

// 提供的服务
export const provides = ['my-service'];

// 配置 Schema（前端自动渲染编辑表单）
export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true, description: '你的 API 密钥' },
  maxRetries: { type: 'number', label: '最大重试', default: 3, description: '请求失败时的重试次数' },
  advanced: {
    label: '高级设置',
    fields: {
      timeout: { type: 'number', label: '超时 (ms)', default: 30000 },
    },
  },
};

export const defaultConfig = {
  maxRetries: 3,
  advanced: { timeout: 30000 },
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
          properties: {
            input: { type: 'string', description: '输入参数' },
          },
          required: ['input'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args) => {
      return `处理结果: ${args.input}`;
    },
  });

  // 监听事件
  ctx.on('message:received', async (msg) => {
    ctx.logger.info(`收到消息: ${msg.content}`);
  });

  // 提供服务
  ctx.provide('my-service', myServiceInstance, {
    capabilities: ['feature-a', 'feature-b'],
  });
}
```

### 配置 Schema 类型

| 类型 | 说明 |
|---|---|
| `SchemaField` | 单个字段（string / number / boolean / select / multiselect） |
| `SchemaGroup` | 分组（嵌套对象，含 `fields`） |
| `SchemaArray` | 数组（含 `items` 定义每个元素的字段结构） |

`configSchema` 中定义的字段会被前端自动渲染为表单，`description` 显示为字段帮助文本，`secret` 标记的字段自动遮蔽。

### 工具调用格式

工具定义遵循 OpenAI function calling 格式（兼容 DeepSeek strict 模式）：

```typescript
{
  type: 'function',
  function: {
    name: 'get_weather',
    strict: true,
    description: '获取指定城市的天气',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '城市名' },
      },
      required: ['location'],
      additionalProperties: false,
    },
  },
}
```

## 角色卡

角色卡使用 YAML 格式，放在 `personas/` 目录下:

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
```

## CLI 命令

在终端或 WebUI 对话中可使用：

| 命令 | 描述 |
|---|---|
| `/help` | 显示帮助信息 |
| `/clear` | 清空当前会话历史及长期记忆 |
| `/status` | 显示系统状态 |
| `/reload` | 重新加载配置文件 |
| `/quit` | 退出程序 |

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

### 🔲 计划中

- [ ] 更多 LLM 接口（Gemini、本地模型等）
- [ ] 图像理解（多模态消息）
- [ ] 热重载支持
- [ ] npm 包发布与第三方插件生态

## 许可证

MIT
