# Aalis

一个基于大型语言模型的模块化智能助手框架，采用 **服务 IoC + 依赖注入** 架构。

> 📖 **详细技术文档**: 参见 [`docs/`](docs/) 目录

## 特性

- **模块化插件系统** — 所有功能均为可热插拔的插件（40+），核心框架零外部依赖
- **服务 IoC + 依赖注入** — 插件声明所需服务，框架按偏好 > 优先级 > 注册顺序选取最佳实现
- **多 LLM 支持** — DeepSeek / OpenAI / Ollama 及兼容接口，支持深度思考与工具调用
- **语义记忆** — 向量化长期记忆，基于语义相似度 + 时间衰减检索历史上下文
- **对话摘要** — LLM 驱动的消息摘要压缩，自动在消息积累后触发
- **多后端存储** — SQLite / MongoDB / 内存 消息历史，LanceDB / 平面文件向量存储
- **智能上下文管理** — 自动 token 计数、五阶段消息裁剪、用户消息保护、压缩后延续提示
- **子任务并行** — 会话树形结构，支持 `create_subtask` / `wait_subtasks` 并行任务协调
- **定时调度** — AI 可自主创建 cron 定时任务，绕过速率控制主动执行
- **丰富工具集** — Shell / 文件 / HTTP / 浏览器自动化 / 代码执行 / 数学计算 / Office 文档操作
- **多平台接入** — CLI 终端、Web 管理界面、OneBot v11/v12 协议
- **联网搜索** — Serper API 集成，AI 可主动搜索互联网
- **工具搜索层** — 工具数量多时自动启用搜索机制，减少 LLM token 消耗
- **Web 管理界面** — 实时对话、流式输出、插件配置、服务状态、平台监控、文件管理、待办事项
- **角色人格** — YAML 角色卡定义 AI 的性格、行为与结构化输出格式
- **技能系统** — AI 可自主学习和管理技能库，支持模板参数化
- **权限系统** — 多级权限控制、时限危险操作白名单、平台级确认处理
- **图像理解** — 多模态视觉识别，自动模型选择
- **Office 文档** — Word / Excel / PPT / PDF 创建与编辑，支持子任务协同操作

## 稳定性与契约（0.x · pre-1.0）

Aalis 处于 **0.x 阶段**——核心机制已可用、作者长期自用，但**公开 API 与插件契约仍在演进，1.0 之前可能变更**。请据此评估采用成本：

- **`@aalis/core`** 在 0.x 内**承诺向后兼容**（次版本只做加法/温和改，破坏性变更才升 **1.0.0**）；插件应把 core 设为 `peerDependencies: ">=0.2.0 <1.0.0"`，**不要用 caret 锁死**。
- **但这条承诺只覆盖 `@aalis/core` 本身。** `@aalis/plugin-*-api` 等**契约包不在其内**——服务接口、类型、工具定义形状在 0.x 期间**可能改签名、增删字段、重命名导出**。**第三方开发者请勿把当前契约当成冻结的稳定面**：跟随 `CHANGELOG.md`、预期需要适配，对所依赖的 `*-api` 用宽松区间。
- 仍有少量已知功能项（见 [开发进度](#开发进度) 与 issues），欢迎 issue / PR。

> 想要冻结的稳定承诺？等 1.0。当前阶段更适合“愿意跟着迭代”的早期采用者。

## 设计理念

Aalis 采用服务提供与依赖注入机制，核心设计为：

| 模式 | 说明 |
|---|---|
| **服务 IoC 容器 + 多提供者选择** | 同名服务可多实现并存，框架按偏好 > 优先级 > 注册顺序选取胜者（owner 可经 WebUI 设偏好） |
| **类型安全事件总线** | 插件间通过事件松耦合通信 |
| **中间件钩子管道** | 插件可拦截消息处理、LLM 调用、工具调用等核心流程 |
| **反应式插件生命周期** | 依赖的服务就绪时自动激活插件，服务移除时自动停用 |
| **优雅降级** | 核心服务缺失时自动 fallback（如内存记忆），插件加载失败不影响其他功能 |

### 多提供者服务选择 (Service Selection)

插件按名字声明依赖（如"我需要 `llm` 服务"）。当同一服务有多个实现并存时，框架按
**偏好 > 优先级 > 注册顺序** 解析出唯一胜者：

```typescript
// 插件声明依赖（字符串或 { service } 对象）
export const inject = {
  required: ['llm'],
  optional: [{ service: 'memory' }],
};

// 各 LLM 插件以默认优先级注册同名 'llm' 服务
ctx.provide('llm', service); // 可选 { priority, label }
```

当有多个 `llm` 实现时，`ctx.getService('llm')` 返回当前胜者；owner 可在 WebUI 的「服务」页
或经 `ctx.preferService(name, contextId)` 指定偏好提供者。LLM 的工具调用 / 视觉等能力由模型
句柄（handle）元数据描述，存储访问由 root 权限位控制——均不再走统一的"服务能力匹配"层。

## 项目结构

```
aalis/
├── aalis.config.yaml         # 全局配置（YAML + 环境变量插值）
├── data/                     # 运行时数据（角色卡 / SQLite / LanceDB / 权限 / 插件配置覆盖）
├── docs/                     # 技术文档（architecture / core / plugins / api）
├── packages/
│   ├── core/                              # 核心框架（零外部依赖）
│   └── plugin-*/                          # 插件（60+ 个，按名称前缀分类）
│       ├── plugin-agent / plugin-agent-api    # 对话编排
│       ├── plugin-llm-* / plugin-embedding-*  # LLM / Embedding provider
│       ├── plugin-memory-* / plugin-vectorstore-*  # 记忆 / 向量存储
│       ├── plugin-tool-* / plugin-tools       # 工具集与注册表
│       ├── plugin-storage-*                   # 存储后端 + 路由
│       ├── plugin-adapter-* / plugin-platform # 平台适配 / 网关
│       ├── plugin-cli / plugin-webui-*        # 用户界面
│       └── ...                                # 详见 docs/plugins/
└── src/index.ts                # 主入口
```

> 完整插件清单与职责说明见 [`docs/plugins/`](docs/plugins/)。

## 核心服务

| 服务名 | 描述 | 实现插件 |
|---|---|---|
| `llm` | AI 模型调用（对话、工具调用、流式输出） | plugin-deepseek, plugin-openai, plugin-ollama |
| `agent` | 对话编排（消息构建、工具循环、上下文管理） | plugin-agent |
| `memory` | 消息历史存储与检索 | plugin-memory-sqlite, plugin-memory-mongodb, plugin-memory-inmemory |
| `embedding` | 文本向量化 | plugin-embedding-ollama, plugin-embedding-openai |
| `vectorstore` | 向量存储与相似度检索 | plugin-vectorstore-lancedb, plugin-vectorstore-flat |
| `persona` | 角色人格管理 | plugin-persona |
| `platform` | 聊天平台适配器 | plugin-adapter-onebot, plugin-cli, plugin-webui-server |
| `websearch` | 联网搜索 | plugin-websearch-serper |
| `tools` | AI 工具注册表 | plugin-tools（工具集生产方：plugin-tool-system / plugin-tool-* ）|
| `semantic-memory` | 语义长期记忆 | plugin-memory-vector |
| `session-manager` | 会话生命周期、平台配置、会话树 | plugin-session-manager |
| `scheduler` | 定时任务调度 | plugin-scheduler |
| `authority` | 权限等级与高危操作管理 | plugin-authority |
| `commands` | 指令注册与工具桥接 | plugin-commands |
| `gateway` | 入站/出站消息编排（`inbound:command/flow/trigger/dispatch` 相位 + `outbound:dispatch` 钩子） | plugin-gateway |
| `flow-control` | 平台无关流控（禁言/冷却/限速/闲置触发） | plugin-flow-control |
| `trigger-policy` | 平台无关触发策略（@/名字/关键词/计数/评分） | plugin-trigger-policy |

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

# 权限：owner 列表（拥有全部权限，等级 ∞）；其余外部身份默认等级 0
owners:
  - { platform: cli, userId: local }
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
  optional: [{ service: 'memory' }],
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

  // 提供服务（可选 priority / label / entryId）
  ctx.provide('my-service', myServiceInstance, { priority: 10 });
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

在终端或 WebUI 对话中可使用（"最低等级"= 触发该操作所需的数字等级，默认身份为 0，owner=∞）：

| 命令 | 描述 | 最低等级 |
|---|---|---|
| `/help` | 显示帮助信息 | 0 |
| `/clear` | 清空当前会话记忆；用 `--type` 选择消息/摘要/向量/图片等类型；`/clear all` 清空全部会话（受限） | 0 |
| `/status` | 显示系统状态 | 0 |
| `/model` | 查看或切换会话模型 | 0 |
| `/tools` | 列出所有 AI 工具 | 0 |
| `/shutdown` | 关闭应用（restricted） | 2 |
| `/restart` | 重启应用（restricted） | 2 |
| `/authority [platform:userId]` | 查看自己或指定用户的权限等级 | 0 |
| `/level <platform:userId> <整数>` | 设置用户权限等级（越大越高，0 默认，负数封禁；仅 owner 可用） | owner |
| `/auto [分钟\|on\|off]` | 自动确认模式：临时免危险操作二次确认（仅 owner 本人） | owner |

## 技术文档

详细的技术实现文档位于 [`docs/`](docs/) 目录：

### 核心模块

| 文档 | 内容 |
|---|---|
| [架构总览](docs/architecture.md) | 系统架构、消息处理流程、设计模式 |
| [应用容器](docs/core/app.md) | App 类、启动流程、内置指令 |
| [执行上下文](docs/core/context.md) | Context 类、IoC 容器、生命周期 |
| [服务容器](docs/core/service.md) | 服务注册、多提供者选择、偏好与优先级 |
| [插件管理](docs/core/plugin.md) | 插件生命周期、Soft Reload、依赖追踪 |
| [事件系统](docs/core/events.md) | EventBus、钩子管道 |
| [配置管理](docs/core/config.md) | YAML 配置、环境变量、Schema |
| [指令系统](docs/core/commands.md) | 指令注册、权限检查、工具桥接 |
| [工具注册表](docs/core/tools.md) | 工具注册、权限、执行 |
| [权限系统](docs/core/authority.md) | 权限等级、Owner、高危确认 |
| [类型定义](docs/core/types.md) | 所有核心类型参考 |

### 插件文档

按子系统分类查阅 [`docs/plugins/`](docs/plugins/)：

| 子系统 | 代表插件 |
|---|---|
| **编排 / 会话** | [plugin-agent](docs/plugins/plugin-agent.md)、[plugin-session-manager](docs/plugins/plugin-session-manager.md)、[plugin-commands](docs/plugins/plugin-commands.md) |
| **LLM / Embedding** | [plugin-openai](docs/plugins/plugin-openai.md)、[plugin-deepseek](docs/plugins/plugin-deepseek.md)、[plugin-ollama](docs/plugins/plugin-ollama.md)、[plugin-embedding-*](docs/plugins/) |
| **记忆 / 向量** | [plugin-memory-sqlite](docs/plugins/plugin-memory-sqlite.md)、[plugin-memory-mongodb](docs/plugins/plugin-memory-mongodb.md)、[plugin-memory-vector](docs/plugins/plugin-memory-vector.md)、[plugin-vectorstore-lancedb](docs/plugins/plugin-vectorstore-lancedb.md) |
| **工具集** | [plugin-tools](docs/plugins/plugin-tools.md)、[plugin-tool-system](docs/plugins/plugin-tool-system.md)、[plugin-tool-browser](docs/plugins/plugin-tool-browser.md)、[plugin-tool-code-runner](docs/plugins/plugin-tool-code-runner.md)、[plugin-tool-math](docs/plugins/plugin-tool-math.md)、[plugin-tool-search](docs/plugins/plugin-tool-search.md) |
| **平台适配** | [plugin-adapter-onebot](docs/plugins/plugin-adapter-onebot.md)、[plugin-cli](docs/plugins/plugin-cli.md)、[plugin-webui-server](docs/plugins/plugin-webui-server.md)、[plugin-webui-client](docs/plugins/plugin-webui-client.md) |
| **其他** | persona / authority / websearch-serper / office / file-reader / image-recognition / okx-trading / scheduler / todo-list / skills / mcp … 见目录 |

> API 契约（跨插件服务接口）见 [`docs/api/`](docs/api/)。

## TODO

- [ ] 数据库定时清理/压缩策略（按 TTL 或条数上限淘汰旧消息）
- [ ] 反向 WebSocket 支持（OneBot 适配器）
- [ ] 更多平台适配器（Discord、Telegram 等）
- [ ] 插件市场与远程安装
- [ ] npm 包发布与第三方插件生态

## 开发进度

### ✅ 已完成

- [x] 核心框架（服务 IoC + 多提供者选择 + 事件总线 + 响应式插件生命周期）
- [x] 配置管理（YAML + 环境变量插值 + 启动时自动同步插件默认值）
- [x] 工具注册表（OpenAI function calling 格式 + 权限系统 + 安全等级）
- [x] 默认 Agent（消息编排 + 工具循环 + 五阶段上下文裁剪 + 压缩后延续提示）
- [x] DeepSeek LLM 插件（深度思考 + 工具调用 + 流式输出）
- [x] OpenAI-compatible LLM 插件
- [x] Ollama 本地模型 LLM 插件
- [x] 角色卡插件（结构化 JSON 输出 + 强制格式校验）
- [x] SQLite / MongoDB / 内存消息记忆插件
- [x] LLM 对话摘要压缩插件（30 条触发，保留 20 条最新）
- [x] 向量语义记忆插件（自动注入语义相关历史到 system prompt）
- [x] Ollama / OpenAI Embedding 插件
- [x] LanceDB / 平面文件向量存储插件
- [x] 会话管理器（会话树、平台配置继承、会话生命周期事件）
- [x] 子任务系统（create_subtask / wait_subtasks 并行执行）
- [x] 定时调度（Cron / 固定间隔，绕过速率控制主动执行）
- [x] 待办事项管理（会话级任务跟踪）
- [x] AI 技能系统（YAML 自学习技能库 + 模板参数化）
- [x] 系统工具集（Shell / 文件 / 系统 / HTTP，含 SSRF 防护）
- [x] Puppeteer 浏览器自动化（导航 / 截图 / 点击 / 输入）
- [x] 代码执行工具（Python + JavaScript，超时与输出限制）
- [x] 数学计算工具集（10 类：表达式 / 统计 / 矩阵 / 数论 / 几何 / 金融等）
- [x] Office 文档操作（Word / Excel / PPT / PDF，支持子任务协同）
- [x] 多格式文件上传读取（MIME 检测，20MB 限制）
- [x] 图像视觉识别（自动模型选择，多模态消息）
- [x] Serper 联网搜索插件
- [x] OKX 交易所接口（行情 / 账户 / 下单，模拟/实盘模式）
- [x] OneBot v11/v12 协议适配器（WebSocket 多连接 + 自动重连）
- [x] OneBot 群管工具（禁言 / 踢人 / 昵称 / 戳一戳）
- [x] CLI 终端对话插件
- [x] Web 管理界面（实时对话 + 流式输出 + 流恢复 + 插件配置 + 文件管理 + 日志流）
- [x] 交互式 tool call 显示（对话与思考中内联展示工具调用过程）
- [x] 插件自动发现（扫描 packages/ 目录，无需手动声明依赖）
- [x] 优雅降级（Memory / Agent 缺失时自动 fallback）
- [x] 权限系统（多级权限 + 时限白名单 + 平台级确认 + 高危操作拦截）

### 🔲 计划中

- [ ] 热重载支持（部分已实现）
- [ ] 更多 LLM 接口（Gemini 等）
- [ ] npm 包发布与第三方插件生态

## 许可证

Aalis 采用 **分层授权**：核心与绝大多数插件宽松开源，仅"市场 / WebUI 控制台"实现层用 AGPL-3.0 防止被直接打包成闭源竞品。

| 层 | 许可证 | 包 |
|---|---|---|
| 核心 / API / 工具 / 功能插件 | **MIT** | `@aalis/core`、所有 `*-api`、`util-*`、各功能插件、`@aalis/plugin-webui-api`（WebUI 契约）、`@aalis/plugin-package-manager`、`create-aalis(-plugin)` |
| 市场 / WebUI 控制台实现层 | **AGPL-3.0-only** | `@aalis/plugin-webui-server`、`@aalis/plugin-webui-client` |

含义：

- **写插件、扩展功能、二次开发** —— 基于 MIT 层（含通过 `@aalis/plugin-webui-api` 注册 WebUI 页面）完全自由，只需保留版权声明。
- **修改 / 分发 WebUI 控制台或插件市场本体** —— 受 AGPL-3.0 约束（含作为网络服务提供时须公开对应源码）。

版权 © 2026 Ace Nyan。各包根目录附 `LICENSE`；贡献授权见 [CONTRIBUTING.md](CONTRIBUTING.md#0-贡献授权-cla)。