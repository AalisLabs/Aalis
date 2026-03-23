# Aalis

一个基于大型语言模型的模块化智能助手框架，采用 **服务 IoC + 能力声明** 架构。

## 设计理念

Aalis 受 [internal-framework](https://internal-framework.chat) 的服务提供机制和 [internal-framework](https://internal-framework.ai) 的多平台接入启发，核心设计为：

| 模式 | 说明 |
|---|---|
| **服务 IoC 容器 + 能力声明** | 插件注册/消费服务时可声明所需能力，框架自动匹配最佳实现 |
| **类型安全事件总线** | 插件间通过事件松耦合通信 |
| **反应式插件生命周期** | 依赖的服务就绪时自动激活插件，服务移除时自动停用 |
| **权限系统** | 通过 allow/deny 配置控制 AI 可执行的工具范围 |

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
├── aalis.config.yaml          # 全局配置
├── personas/
│   └── default.yaml           # 默认角色卡
├── packages/
│   ├── core/                  # @aalis/core — 核心框架
│   ├── plugin-openai/         # @aalis/plugin-openai — OpenAI-like LLM 接口
│   ├── plugin-persona/        # @aalis/plugin-persona — 角色人格管理
│   ├── plugin-memory-mongodb/ # @aalis/plugin-memory-mongodb — MongoDB 长期记忆
│   ├── plugin-cli/            # @aalis/plugin-cli — 终端对话界面
│   └── plugin-webui/          # @aalis/plugin-webui — Web 管理界面 (React+Vite)
│       └── client/            # 前端 SPA
└── src/
    └── index.ts               # 主入口
```

## 核心服务

| 服务名 | 描述 | 实现插件 |
|---|---|---|
| `llm` | AI 模型调用（对话、工具调用） | plugin-openai |
| `memory` | 长期记忆存储与检索 | plugin-memory-mongodb |
| `persona` | 角色人格管理 | plugin-persona |
| `platform` | 聊天平台适配器 | plugin-cli / plugin-webui |
| `tools` | AI 工具注册表 | core (内置) |

## 快速开始

### 前置要求

- Node.js >= 22
- pnpm >= 9
- MongoDB (用于长期记忆)

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
  openai:
    apiKey: "${OPENAI_API_KEY}"    # 支持环境变量
    baseUrl: "https://api.deepseek.com"
    model: "deepseek-chat"
  memory-mongodb:
    uri: "mongodb://localhost:27017"
```

设置 API 密钥:

```bash
export OPENAI_API_KEY="your-api-key-here"
```

### 启动

```bash
# 开发模式
pnpm dev

# 生产模式
pnpm build && pnpm start
```

## 编写插件

一个 Aalis 插件需要导出 `name`、可选的 `inject`/`provides` 和 `apply` 函数：

```typescript
import type { Context } from '@aalis/core';

export const name = 'my-plugin';

// 依赖声明 (支持能力匹配)
export const inject = {
  required: ['llm'],
  optional: [{ service: 'memory', capabilities: ['persistence'] }],
};

// 提供的服务
export const provides = ['my-service'];

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

### 工具调用格式

工具定义遵循 DeepSeek strict 模式规范 (兼容 OpenAI):

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

在终端模式下可使用:

| 命令 | 描述 |
|---|---|
| `/help` | 显示帮助信息 |
| `/clear` | 清空当前会话历史 |
| `/status` | 显示系统状态 |
| `/quit` | 退出程序 |

## 权限控制

在 `aalis.config.yaml` 中配置 AI 可执行的工具范围:

```yaml
permissions:
  deny:
    - "system:shutdown"    # 禁止关机
    - "system:rm_*"        # 禁止所有 rm 命令
  allow:
    - "file:read"          # 允许读取文件
    - "web:*"              # 允许所有 web 操作
```

`deny` 优先于 `allow`。不设置 `allow` 表示允许所有未被 `deny` 的操作。

## 开发进度

### ✅ 已完成

- [x] 核心框架 (服务 IoC + 能力声明 + 事件总线 + 插件生命周期)
- [x] 配置管理 (YAML + 环境变量插值)
- [x] 工具注册表 (DeepSeek strict 模式格式 + 权限系统)
- [x] 会话代理 (消息编排 + 工具调用循环)
- [x] OpenAI-like LLM 插件 (兼容 DeepSeek/OpenAI/兼容接口)
- [x] 角色卡插件 (YAML 角色定义)
- [x] MongoDB 记忆插件 (对话历史存储)
- [x] CLI 插件 (终端对话 + 内置命令)
- [x] WebUI 插件 (Express + WebSocket + React 前端)

### 🔲 计划中

- [ ] 更多 LLM 接口 (Gemini, 本地模型等)
- [ ] OneBot 协议接入
- [ ] 数据 Embedding 化 (向量检索记忆)
- [ ] 电脑操控能力 (键鼠模拟、文件操作工具)
- [ ] 图像理解 (多模态消息)
- [ ] WebUI 完善 (插件管理、会话管理、配置编辑)
- [ ] 热重载支持
- [ ] npm 包发布与第三方插件生态

## 许可证

MIT
