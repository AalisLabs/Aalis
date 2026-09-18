# Aalis

可扩展的插件化框架：极简内核 + 万物皆插件。当下的主场是 LLM Agent / Bot，但内核不认识任何业务词汇。

技术文档在 [`docs/`](docs/)（文档站按「入门 → 概念 → 核心 → 服务 → 插件 → API」组织）；写插件先读
[插件作者指南](docs/plugin-author-guide.md)。

## 内核做什么

`@aalis/core` 零运行时依赖、环境无关（不 import 任何 `node:*`），只做两件事。

第一，把插件之间的协作方式收成四个原语，每个插件经自己的 `Context` 使用：

| 原语 | 门面动词 | 语义 |
|---|---|---|
| 事件 | `ctx.on` / `ctx.emit` | 广播通知：无返回、错误隔离、不可拦截 |
| 服务 | `ctx.provide` / `ctx.getService` / `ctx.whenService` | IoC：同名多提供者并存，按「偏好 > 优先级 > 注册顺序」选胜者 |
| 中间件钩子 | `ctx.middleware` / `ctx.runHook` | 有序管道：可改数据、可短路 |
| 贡献点 | `ctx.contribute` / `ctx.collect` | 往共享产物交一块料，排布权归收集方 |

第二，把它们编排成反应式插件生命周期（`App` / `PluginManager`）：依赖的服务就绪即激活，服务下线即降级，
配置变更即热重载；所有副作用随 `Context` 拆卸自动清理。

消息、会话、LLM、工具、存储、权限……全部是插件。各 `@aalis/api-*` 契约包用 declaration merging 把服务名、
事件键、钩子键注入 core 的四个扩展点（`ServiceTypeMap` / `AalisEvents` / `HookContextMap` / `ContributionPointMap`），
core 本身不出现任何领域类型。宿主 `@aalis/runtime` 负责 core 刻意不做的事：读配置文件、发现并加载插件、重启进程。

内核 API 见 [docs/core/](docs/core/README.md)，语义契约与稳定性条款见 [core 语义契约](docs/design/core-contract.md)。

## 仓库布局

pnpm monorepo，约 100 个包：

| 目录 | 内容 |
|---|---|
| `packages/core` | 内核 |
| `packages/runtime` | Node 宿主：配置文件、插件发现、进程重启 |
| `packages/api-*` | 25 个契约包，一个服务一个（`api-llm` / `api-memory` / `api-tools` …），只含接口与 helper |
| `packages/plugin-*` | 60 余个插件：LLM 与 Embedding 提供者、记忆与向量存储、工具集、平台适配器（OneBot / CLI / WebUI）、调度、权限、技能等，清单见 [docs/plugins/](docs/plugins/README.md) |
| `packages/create-aalis` / `create-aalis-plugin` | 脚手架：建机器人项目 / 建插件骨架 |
| `docs/` | 文档站源码 |

## 快速开始

Node.js >= 22。

```bash
npm create aalis@latest my-bot
cd my-bot
# 在 aalis.config.yaml 里填大模型 API key 与平台账号
npm start
```

要哪些 key、零 key 怎么起（本地 Ollama）、CLI 与 WebUI 两个入口，见 [第一次运行](docs/guide/first-run.md)；
建项目的完整步骤见 [脚手架上手](docs/guide/scaffolding.md)。

在本仓库里开发：`pnpm install && pnpm build`，`pnpm dev` 启动，`pnpm run ci:local` 跑门禁（build + test + biome）。

## 写一个插件

插件是一个导出 `name` 与 `apply` 的模块，可选 `inject`（依赖的服务）、`provides`（提供的服务）、`configSchema`：

```typescript
import type { Context } from '@aalis/core';
import { useToolService } from '@aalis/api-tools';

export const name = 'my-plugin';
export const inject = { required: ['tools'] };

export function apply(ctx: Context) {
  useToolService(ctx).register({
    definition: {
      type: 'function',
      function: {
        name: 'echo',
        description: '原样返回输入',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    },
    handler: async args => String(args.text),
  });

  ctx.on('app:ready', () => ctx.logger.info('就绪'));
  ctx.onDispose(() => {
    // 关连接、停计时器：bounce / unload / 停机全部路径都会走到这里
  });
}
```

`npm create aalis-plugin` 生成可发布的插件骨架。从零到发布（消费与提供服务、扩展点、元数据、插件市场）见
[第三方插件开发者指南](docs/guide/third-party-plugin.md)。

## 稳定性（0.x）

- `@aalis/core` 的稳定性承诺自 1.0 起生效（条款见 [core 语义契约](docs/design/core-contract.md)）；1.0 之前次版本可含
  破坏性变更，迁移路径记在 [CHANGELOG](CHANGELOG.md)。插件把 core 写成
  `peerDependencies: { "@aalis/core": ">=x.y.z <1.0.0" }`（用了哪版的 API 就把下限写到哪版），不要用 caret 锁死。
- `@aalis/api-*` 契约包不在承诺之内：0.x 期间服务接口与类型可能改签名、增删字段。第三方开发者请跟随 CHANGELOG、
  对所依赖的 `api-*` 用宽松区间。

## 许可证

分层授权：核心与绝大多数插件宽松开源，仅「市场 / WebUI 控制台」实现层用 AGPL-3.0。

| 层 | 许可证 | 包 |
|---|---|---|
| 核心 / API / 工具 / 功能插件 | MIT | `@aalis/core`、所有 `api-*`、`util-*`、各功能插件、`@aalis/api-webui`、`@aalis/plugin-package-manager`、`create-aalis(-plugin)` |
| 市场 / WebUI 控制台实现层 | AGPL-3.0-only | `@aalis/plugin-webui-server`、`@aalis/plugin-webui-client` |

基于 MIT 层写插件、扩展功能、二次开发（含经 `@aalis/api-webui` 注册 WebUI 页面）完全自由，只需保留版权声明；
修改或分发 WebUI 控制台与插件市场本体受 AGPL-3.0 约束（含作为网络服务提供时须公开对应源码）。

版权 © 2026 Ace Nyan。各包根目录附 `LICENSE`；贡献授权见 [CONTRIBUTING.md](CONTRIBUTING.md#0-贡献授权-cla)。
