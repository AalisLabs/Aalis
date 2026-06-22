# 脚手架上手指南（Scaffolding）

> 受众：第一次接触 Aalis、想**起一个能跑的机器人**，或**起一个能装的插件**的第三方开发者。
> 这是入门 on-ramp——从「两个脚手架各干什么」到「敲哪条命令」「生成了什么」「约定有哪些」「下一步往哪走」。
>
> 相关源码：`packages/create-aalis/src/cli.ts`（建项目）、`packages/create-aalis-plugin/src/cli.ts`（建插件）。
> 两者都是**零运行时依赖、纯 npm/node 的独立脚手架**，不属于本 monorepo 的 workspace。

---

## 两个脚手架，两件事

Aalis 提供两个互不相干的脚手架，先分清你要哪个：

| 命令 | 产出 | 何时用 | 入口源码 |
|---|---|---|---|
| `npm create aalis` | 一个**可运行的独立项目**（机器人实例） | 你要部署 / 跑一个自己的 Aalis bot | `create-aalis/src/cli.ts` |
| `create-aalis-plugin` | 一个**插件骨架包**（npm 包） | 你要给 Aalis 写并发布一个扩展插件 | `create-aalis-plugin/src/cli.ts` |

心智模型：
- **项目** = 一份 `aalis.config.yaml` + 一行 `startAalis()` + 一堆装进 `node_modules` 的 `@aalis/plugin-*`。运行时从项目 `package.json` 的依赖里发现并加载这些插件（`node-modules-loader.ts:56-87`）。
- **插件** = 一个导出 `name` + `apply(ctx, config)` 的 npm 包（`create-aalis-plugin` 生成 `src/index.ts`），被某个项目装进去后由 core 加载。

两者都做了同一件「外部友好」的事：**生成的依赖版本写 `"latest"`（或解析到的 `^<最新版>`），绝不写 `workspace:`**——脚手架产物不在本 monorepo 内，`workspace:` 协议在外部装不上（`create-aalis/cli.ts:300-321`、`create-aalis-plugin/cli.ts:178-186`）。

---

## 一、`npm create aalis` —— 起一个机器人项目

### Quickstart

```bash
# 交互式：选模板档 + 同类适配器，建好后自动 npm install
npm create aalis my-bot

# 非交互：standard 档 + 各组默认适配器（CI / 管道 / 想要快）
npm create aalis my-bot -- --yes

# 指定模板档、跳过安装
npm create aalis my-bot -- --tier minimal --no-install
```

> 注意 `--` 分隔符：`npm create` 后给脚手架的 flag 必须放在 `--` 之后，否则被 npm 自己吞掉。

跑完后：

```bash
cd my-bot
cp .env.example .env   # 若所选插件需要 API key（脚手架会在「下一步」提示是否需要）
npm start
```

### 交互式 prompts

无 `--yes` / `--tier` 且终端是 TTY 时进交互（非 TTY 环境会提前拦截并提示改用非交互模式，`cli.ts:445-452`）。依次问：

1. **项目目录名** —— 默认 `my-aalis-bot`，必须是合法 npm 包名（全小写、无空格、不以 `.`/`_` 开头等，`validateNpmName`，`cli.ts:252-271`），坏输入会重问。
2. **模板档**（默认 `standard`，`cli.ts:504-527`）：

   | 档 | 装什么 |
   |---|---|
   | `bare` | 只装 `@aalis/core` + `@aalis/runtime`（完全自定义起点） |
   | `minimal` | 最简对话闭包：网关 + 指令 + agent + 权限 + 会话 + 跨会话历史 + 本地存储/进程（`MINIMAL_BASE`，`cli.ts:30-42`） |
   | `standard` | minimal + 常用全家桶：WebUI / 人设 / 向量记忆 / 工具 / 调度 / 技能 / MCP …（`STANDARD_EXTRA`，`cli.ts:46-69`） |
   | `full` | 实时查 npm 全装所有官方插件（可能需手动取舍，`cli.ts:555-562`） |

3. **同类适配器组**（仅 `minimal` / `standard`，`cli.ts:532-546`）——避免同类全塞冲突，按组选：
   - LLM 提供者（多选，默认 DeepSeek）
   - 接入平台（多选，默认 CLI 终端）
   - 记忆后端（单选，默认 SQLite）
   - Embedding 提供者 / 向量库（仅 `standard`，向量记忆所需）

   序号输入兼容逗号或空格（`"1,2"` = `"1 2"`），回车=默认集，坏输入重问（`parseIndexSelection`，`cli.ts:227-243`）。

### `--yes` 与命令行 flag 的默认值

| flag | 作用 | 默认 |
|---|---|---|
| `--yes` / `-y` | 跳过所有 prompt，用默认值 | 档=`standard`，各组取默认成员（`cli.ts:436, 543`） |
| `--tier <档>` | 指定模板档（隐含跳过交互） | — |
| `--no-install` | 跳过自动 `npm install` | 默认会装 |
| `--force` | 目标目录非空时也覆盖写入 | 默认报错退出（`cli.ts:499-502`） |
| `--registry <url>` | 查插件目录/版本用的 npm 源 | `https://registry.npmjs.org`（`cli.ts:166`） |

> `--registry` 只影响脚手架查 `aalis-plugin` 目录与版本号；生成项目里 `npm install` 仍用你自己的 npm 配置（二者解耦，`cli.ts:163-165`）。

### 生成了什么（项目布局）

```
my-bot/
├── package.json        # @aalis/core + @aalis/runtime + 所选插件（版本见下）
├── index.mjs           # 一行 startAalis() 启动
├── aalis.config.yaml   # 主配置：name / logLevel / plugins / disabledPlugins
├── .env.example        # 所选插件引用的环境变量占位（如 DEEPSEEK_API_KEY=）
├── .gitignore          # node_modules/ data/ *.log .env dist/
└── README.md           # 启动/配置/装更多插件指引
```

入口 `index.mjs`（`renderEntry`，`cli.ts:351-361`）：

```js
import { startAalis } from '@aalis/runtime';

// 从 aalis.config.yaml 读配置、从 node_modules 加载已装的 @aalis 插件、启动。
startAalis().catch(err => {
  console.error('Aalis 启动失败:', err);
  process.exit(1);
});
```

`startAalis()` 是 `@aalis/runtime` 的总入口（`packages/runtime/src/start.ts:49`）：读 `aalis.config.yaml`，用 node_modules 加载器扫项目依赖、按 `keywords` 含 `aalis-plugin` 发现插件并加载。

`package.json` 依赖版本由脚手架**逐包实时解析**（`resolveDepRanges`，`cli.ts:306-321`）：能查到最新版就写 `^<最新>`（与生态约定一致——0.x caret 锁次版本），查不到的回退 `"latest"`（install 时再取最新，自我修正、不硬编码会过时的版本）。

### 自动补齐的「伴生」依赖

某些选择会自动带上必需的配套包，省得你漏装：

- 选了 **WebUI**（`@aalis/plugin-webui-server`）→ 自动加 `@aalis/plugin-webui-client`（前端静态资源，缺它 404）+ `@aalis/plugin-package-manager`（市场「安装」否则 503），`cli.ts:568-571`。
- 选了 **code_runner**（`@aalis/plugin-tool-code-runner`）→ 自动加 `@aalis/plugin-code-sandbox-os`（OS 沙箱后端，缺它 fail-closed 拒绝执行），`cli.ts:575-577`。

### 配置约定

`aalis.config.yaml`（`renderConfig`，`cli.ts:363-380`）：需要密钥/地址的已知插件会预填配置桩，用 `${ENV}` 引用环境变量；其余用空 `plugins: {}` 默认配置启动。`.env.example` 收集这些环境变量供你 `cp .env.example .env` 填值（`cli.ts:382-391`）。

> 生态约定的「更多插件不在终端铺列」：长尾插件发现交给 WebUI 的「插件市场」页（对齐 Koishi 做法，`cli.ts:509`）。装新插件只需 `npm install @aalis/plugin-<name>`，装上即被自动发现加载。

---

## 二、`create-aalis-plugin` —— 起一个插件骨架

### Quickstart

```bash
# 交互式
npx create-aalis-plugin

# 指定包名，其余走 prompt
npx create-aalis-plugin my-plugin

# 全默认值（tool 模板，无 command / webui）
npx create-aalis-plugin my-plugin --yes
```

生成后：

```bash
cd my-plugin
pnpm install
pnpm build
```

### 交互式 prompts 与默认值

非 TTY 且无 `--yes` 时同样提前拦截（`cli.ts:78-84`）。问 4 件事：

| prompt | 默认 | 说明 |
|---|---|---|
| 包名 | `aalis-plugin-sample` | 合法 npm 包名，支持 `@scope/my-plugin`；目录名取最后一段（`shortName`，`cli.ts:161-164`） |
| 显示名（中文标签） | 由包名推导 | 去掉 `plugin-` 前缀、连字符转空格、首字母大写（`defaultDisplayName`，`cli.ts:154-159`） |
| 注册 AI 工具？ | **是** | 生成 `useToolService` 工具示例 |
| 注册斜杠命令？ | 否 | 生成 `useCommandService` 命令示例 |
| 提供 WebUI 页面？ | 否 | 生成 `useWebuiService` 页面 + `actions` 示例 |

`--yes` / `-y` 跳过全部，取上表默认（即只生成 tool 扩展点，`cli.ts:73, 88`）。yes/no 输入兼容 `y/yes/true/1` 与 `n/no/false/0`（`parseYesNo`，`cli.ts:63-69`）。

### 生成了什么（插件骨架）

```
my-plugin/
├── package.json        # name / keywords:["aalis-plugin"] / peerDep core / 按选项的 *-api 依赖
├── tsconfig.json       # extends ../../tsconfig.base.json（约定放进 monorepo packages/）
├── src/index.ts        # PluginModule：name / displayName / inject={} / apply()
└── README.md           # 启用方式 + 已选扩展点清单
```

### 生成的 `package.json` 约定

关键约定（`renderPackageJson`，`cli.ts:175-218`）：

```jsonc
{
  "name": "my-plugin",
  "type": "module",
  "keywords": ["aalis-plugin"],          // 市场发现 + 加载硬门（见下）
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],                      // 发布包只含编译产物
  "dependencies": { "@aalis/plugin-tools-api": "latest" },  // 仅当选了对应扩展点
  "peerDependencies": { "@aalis/core": ">=0.2.0 <1.0.0" },  // 宽松区间，兼容任何 0.x 宿主
  "devDependencies": { "@aalis/core": "latest", "typescript": "^5.7.0", "@types/node": "^22.0.0" }
  // 有服务依赖/提供时在此补 aalis.service（注释占位，见下）
}
```

- **`keywords: ["aalis-plugin"]` 是加载硬门**：两个加载器都只认这个关键词来判定「这是不是可加载插件」（`isLoadablePlugin`，`node-modules-loader.ts:35-38`）。漏了它，插件永远不被发现。
- **`@aalis/core` 走 peerDependency**，区间 `>=0.2.0 <1.0.0`：core 承诺 0.x 内向后兼容、破坏性变更才升 1.0.0，所以接受任何 0.x 宿主——插件不必随 core 次版本升级重发（别用 `^0.x` caret 把自己锁死，也别用裸 `*`）。
- **选了哪个扩展点，才把对应 `*-api` 进 `dependencies`**：tool→`@aalis/plugin-tools-api`、command→`@aalis/plugin-commands-api`、webui→`@aalis/plugin-webui-api`，统一写 `"latest"`（`cli.ts:184-186`）。
- **不带 `aalis` 字段**：示例插件无服务依赖，模板只留一行注释提示往哪写（`cli.ts:214-215`）。一旦你 `ctx.provide(...)` 或在 `inject` 加依赖，要**同步**补 `aalis.service.{provides,required,optional}`，否则市场「装前披露」会缺项——这两套元数据的对账纪律见 [concepts/manifest-metadata.md](../concepts/manifest-metadata.md)。

### 生成的 `src/index.ts` 形状

入口导出一组 `PluginModule` 字段（`renderIndexTs`，`cli.ts:232-311`）。核心元数据：

```ts
export const name = 'my-plugin';
export const displayName = 'My Plugin';
export const inject = {};          // 空依赖声明；有 required/optional 服务时在此填

export function apply(ctx: Context, _config: Record<string, unknown>): void {
  const logger = ctx.logger.child('my-plugin');
  logger.info('插件已加载');
  // ...扩展点
}
```

> `export const inject = {}` 是一个**显式空依赖声明**——没有依赖也写出来，提示你「有依赖往这填」。`inject` 的语义（`required` 参与拓扑排序、`optional` 不参与）见 [concepts/manifest-metadata.md](../concepts/manifest-metadata.md) 与 [concepts/lazy-service-access.md](../concepts/lazy-service-access.md)。

选了 tool 时生成的工具模板（`cli.ts:243-257`）——注意这个**确切形状**：

```ts
import { useToolService } from '@aalis/plugin-tools-api';

useToolService(ctx).register({
  definition: {
    type: 'function',
    function: {
      name: 'hello',
      description: '示例工具：返回问候语',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  // handler 必须返回 string（工具结果文本），不是对象
  async handler(args) {
    return `你好, ${(args as { name: string }).name}!`;
  },
});
```

两个易踩点，都已在模板里钉死：
- 工具声明用 OpenAI 函数调用协议的嵌套形状 `{ type: 'function', function: { name, description, parameters } }`（`ToolDefinition`，`plugin-tools-api/src/index.ts:40-43`），不是平铺的 `{ name, description }`。
- `handler` 的返回类型是 `Promise<string>`（`RegisteredTool.handler`，`plugin-tools-api/src/index.ts:74`）——返回**工具结果文本**，不要返回对象。

选了 command / webui 时分别追加 `useCommandService(ctx).command(...).action(...)` 与 `useWebuiService(ctx).registerPage(...)` 示例（`cli.ts:259-294`）。这些注册 helper 都来自各自的 `*-api` 包，**不**来自 core——这也是为什么对应 `*-api` 要进 `dependencies`。各扩展点的 helper 一览见 [第三方插件开发者指南](./third-party-plugin.md) 第 5 节。

---

## 从脚手架到能用的插件

`create-aalis-plugin` 生成的骨架只是「能加载、打个日志」的空壳。让它真正干活的两步：

### 1. 提供一个服务

骨架默认只**消费**（注册工具/命令）。要让别的插件能用你这个能力，在 `apply` 里 `ctx.provide(name, instance, options?)`，并**同步**把 `provides` 写进运行时导出 + `package.json` 的 `aalis.service`：

```ts
export const provides = ['my-service'];        // 源 A：运行时导出（core 读，参与拓扑）
export const inject = { required: ['storage'] };

export function apply(ctx: Context) {
  ctx.provide('my-service', new MyService(), { label: 'my-service' });
}
```

```jsonc
// package.json —— 源 B：市场装前披露（webui-server 读）
"aalis": { "service": { "provides": ["my-service"], "required": ["storage"] } }
```

> 这两套元数据**不自动对账**，必须手写一致，否则市场「装前/装后」披露漂移。完整规则、真实漂移案例、推荐的 CI 对账见 [concepts/manifest-metadata.md](../concepts/manifest-metadata.md)。服务的注册/选优/per-entry 多实例语义见 [concepts/service-model.md](../concepts/service-model.md) 与 [concepts/lazy-service-access.md](../concepts/lazy-service-access.md)。

### 2. 加配置

需要 API key / 地址等参数时，导出 `configSchema`（WebUI 据此自动渲染表单），在 `apply` 里读已校验过的 `config`：

```ts
import type { ConfigSchema } from '@aalis/core';
import type {} from '@aalis/plugin-webui-api'; // declaration merging：secret 等表单属性

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true },
};

export function apply(ctx: Context, config: Record<string, unknown>) {
  // config 已按 schema 校验 + 合并 defaultConfig
}
```

配置 schema 的字段归属（`secret` 等渲染属性来自 webui-api 而非 core）见 [第三方插件开发者指南](./third-party-plugin.md) 第 3 节。

### 3. 本地验证 → 发布

- **本地跑**：把插件目录放进一个 Aalis 项目的依赖（开发期可 `pnpm link` 或放进 monorepo `packages/`），在 `aalis.config.yaml` 的 `plugins` 段加上 `"my-plugin": {}` 启用。
- **发布**：`npm publish --access public`。用户 `npm install my-plugin` 后，因 `keywords` 含 `aalis-plugin` 即被自动发现加载（`node-modules-loader.ts:56-87`）。

完整的「从零到发布」最短路径（消费/提供服务、生命周期 disposable、类型从哪个包 import、参考实现清单）见 [第三方插件开发者指南](./third-party-plugin.md)。

---

## 下一步

- 插件包的完整契约与发布流程：[guide/third-party-plugin.md](./third-party-plugin.md)
- 两套元数据源（运行时导出 vs `package.json` aalis.service）与对账纪律：[concepts/manifest-metadata.md](../concepts/manifest-metadata.md)
- 服务模型（provide / getService / 选优 / per-entry）：[concepts/service-model.md](../concepts/service-model.md)
- 为什么不能缓存服务引用、何时用 `whenService`：[concepts/lazy-service-access.md](../concepts/lazy-service-access.md)
- 插件作者的安全责任边界：[concepts/security-model.md](../concepts/security-model.md)
