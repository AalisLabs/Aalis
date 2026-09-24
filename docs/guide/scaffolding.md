# 脚手架上手指南（Scaffolding）

> 受众：第一次接触 Aalis，想**搭建一个可运行的机器人实例**，或**编写一个可安装的插件**的第三方开发者。
> 本文是入门指引——涵盖两个脚手架各自的用途、运行哪条命令、生成了什么、有哪些约定、下一步往哪走。
>
> 相关源码：`packages/create-aalis/src/cli.ts`（建项目）、`packages/create-aalis-plugin/src/cli.ts`（建插件）。
> 两者都是**零运行时依赖、纯 npm/node 的独立脚手架**，不属于本 monorepo 的 workspace。

---

## 两个脚手架，两件事

Aalis 提供两个互不相干的脚手架，先确认你需要哪个：

| 命令 | 产出 | 何时用 | 入口源码 |
|---|---|---|---|
| `npm create aalis` | 一个**可运行的独立项目**（机器人实例） | 你要部署 / 跑一个自己的 Aalis bot | `create-aalis/src/cli.ts` |
| `create-aalis-plugin` | 一个**插件骨架包**（npm 包） | 你要给 Aalis 写并发布一个扩展插件 | `create-aalis-plugin/src/cli.ts` |

心智模型：
- **项目** = 一份 `aalis.config.yaml` + 一行 `startAalis()` + 若干装进 `node_modules` 的 `@aalis/plugin-*`。运行时从项目 `package.json` 的依赖里发现并加载这些插件（`node-modules-loader.ts`）。
- **插件** = 一个默认导出 `definePlugin({ name, uses, apply })` 产物的 npm 包（`create-aalis-plugin` 生成 `src/index.ts`），被某个项目装进去后由 core 加载。

两个脚手架遵循同一条外部兼容约定：**生成的依赖版本写 `"latest"`（或解析到的 `^<最新版>`），绝不写 `workspace:`**——脚手架产物不在本 monorepo 内，`workspace:` 协议在外部装不上（`create-aalis/cli.ts`、`create-aalis-plugin/cli.ts`）。

---

## 一、`npm create aalis` —— 创建一个机器人项目

### Quickstart

> 前提：Node.js >= 22（与 CI 一致）。

```bash
# 交互式：选模板档 + 同类适配器，建好后自动 npm install
npm create aalis@latest my-bot

# 非交互：standard 档 + 各组默认适配器（适合 CI / 管道 / 快速起步）
npm create aalis@latest my-bot -- --yes

# 指定模板档、跳过安装
npm create aalis@latest my-bot -- --tier minimal --no-install
```

> 注意 `--` 分隔符：`npm create` 后给脚手架的 flag 必须放在 `--` 之后，否则会被 npm 自身解析、传不到脚手架。
>
> 显式写 `@latest`：不带版本时 `npm create` 会直接复用 `~/.npm/_npx/` 里已缓存的旧版 `create-aalis` 而不检查更新；
> 0.4 之前的版本经 `.bin` 软链调用时会静默退出（exit 0、无输出、不生成任何文件）。

运行后：

```bash
cd my-bot
# 若所选插件需要 API key：直接填进 aalis.config.yaml（该文件已在生成的 .gitignore 里）
npm start

# 一次性子命令：等价于聊天里的 /status，执行完即退出（`@aalis/runtime` 默认行为）；
# 可用命令取决于装了哪些插件，argv 非空但不是已注册命令时报错退出（exit 2），不会启动守护进程。
# 子命令在独立的一次性进程里执行：status/shutdown/restart 只作用于该临时实例；改配置文件的指令（如 auto）
# 经热重载对守护进程生效，改插件内存态的（如 level、session.*）不生效。管理运行中的实例请用聊天指令 / WebUI
npm start -- status
```

### 交互式 prompts

无 `--yes` / `--tier` 且终端是 TTY 时进交互（非 TTY 环境会提前拦截并提示改用非交互模式，`cli.ts`）。依次问：

1. **项目目录名** —— 默认 `my-aalis-bot`，必须是合法 npm 包名（全小写、无空格、不以 `.`/`_` 开头等，`validateNpmName`，`cli.ts`），非法输入会重问。
2. **模板档**（默认 `standard`，`cli.ts`）：

   | 档 | 装什么 |
   |---|---|
   | `bare` | 只装 `@aalis/core` + `@aalis/runtime`（完全自定义起点） |
   | `minimal` | 最简对话闭包：网关 + 指令 + agent + 权限 + 确认通道 + 会话 + 消息归档 + 跨会话历史 + 本地存储/进程（`MINIMAL_BASE`，`cli.ts`） |
   | `standard` | minimal + 常用全家桶：WebUI / 人设 / 向量记忆 / 工具 / 调度 / 技能 / MCP / 联网搜索（Serper，需 key）…（`STANDARD_EXTRA`，`cli.ts`） |
   | `full` | 实时查 npm 全装所有官方插件（可能需手动取舍，`cli.ts`） |

3. **同类适配器组**（仅 `minimal` / `standard`，`cli.ts`）——避免同类插件同时装入产生冲突，按组选择：
   - LLM 提供者（多选，默认 DeepSeek —— 需 key；OpenAI 需 key；**Ollama 为本机服务、不需要 key**）
   - 接入平台（多选，默认 CLI 终端）—— `standard` 档的 WebUI 由档位本身带上，此处选不选都会装
   - 记忆后端（单选，默认 SQLite）
   - Embedding 提供者 / 向量库（仅 `standard`，向量记忆所需）—— 默认的 OpenAI Embedding **另需一把独立的 key**，不想再配就选 Ollama Embedding

   序号输入兼容逗号或空格（`"1,2"` = `"1 2"`），回车=默认集，非法输入重问（`parseIndexSelection`，`cli.ts`）。

### `--yes` 与命令行 flag 的默认值

| flag | 作用 | 默认 |
|---|---|---|
| `--yes` / `-y` | 跳过所有 prompt，用默认值 | 档=`standard`，各组取默认成员（`cli.ts`） |
| `--tier <档>` | 指定模板档（隐含跳过交互） | — |
| `--no-install` | 跳过自动 `npm install` | 默认会装 |
| `--force` | 目标目录非空时也覆盖写入 | 默认报错退出（`cli.ts`） |
| `--registry <url>` | 查插件目录/版本用的 npm 源 | `https://registry.npmjs.org`（`cli.ts`） |

> `--registry` 只影响脚手架查 `aalis-plugin` 目录与版本号；生成项目里 `npm install` 仍用你自己的 npm 配置（二者解耦，`cli.ts`）。

### 生成了什么（项目布局）

```
my-bot/
├── package.json        # @aalis/core + @aalis/runtime + 所选插件（版本见下）
├── index.mjs           # 一行 startAalis() 启动
├── aalis.config.yaml   # 主配置：name / logLevel / plugins / disabledPlugins（含密钥，**不入库**）
├── .gitignore          # node_modules/ data/ *.log aalis.config.yaml dist/
└── README.md           # 启动/配置/装更多插件指引
```

入口 `index.mjs`（`renderEntry`，`cli.ts`）：

```js
import { startAalis } from '@aalis/runtime';

// 从 aalis.config.yaml 读配置、从 node_modules 加载已装的 @aalis 插件、启动。
startAalis().catch(err => {
  console.error('Aalis 启动失败:', err);
  process.exit(1);
});
```

`startAalis()` 是 `@aalis/runtime` 的总入口（`packages/runtime/src/start.ts`）：读 `aalis.config.yaml`，用 node_modules 加载器扫项目依赖、按 `keywords` 含 `aalis-plugin` 发现插件并加载。

`package.json` 依赖版本由脚手架**逐包实时解析**（`resolveDepRanges`，`cli.ts`）：能查到最新版就写 `^<最新>`（与生态约定一致——0.x caret 锁次版本），查不到的回退 `"latest"`（install 时再取最新，自我修正、不硬编码会过时的版本）。

### 自动补齐的「伴生」依赖

某些选择会自动带上必需的配套包，避免遗漏：

- 选了 **WebUI**（`@aalis/plugin-webui-server`）→ 自动加 `@aalis/plugin-webui-client`（前端静态资源，缺它 404）+ `@aalis/plugin-package-manager`（市场「安装」否则 503），`cli.ts`。
- 选了 **code_runner**（`@aalis/plugin-tool-code-runner`）→ 自动加 `@aalis/plugin-code-sandbox-os`（OS 沙箱后端，缺它 fail-closed 拒绝执行），`cli.ts`。

### 配置约定

`aalis.config.yaml`（`renderConfig`，`cli.ts`）：需要密钥/地址的已知插件会预填一个空的配置桩（如 `apiKey: ""`），填进去即可；其余用空 `plugins: {}` 默认配置启动。

装了 `plugin-session-manager` 时，还会给已选装的 owner 专用平台（`cli`、`webui`）各写一条平台档，开放全部工具分组：

```yaml
plugins:
  "@aalis/plugin-session-manager":
    platformProfiles:
      - platform: cli
        enabledToolGroups: ["*"]
      - platform: webui
        enabledToolGroups: ["*"]
```

带分组的工具（`system`、`skills`、`scheduler`、`subtask` 等）默认不暴露，平台档列出该**组名**或写 `"*"` 才对模型可见。组名要写准——`plugin-tool-system` 的 shell / 文件 / 系统 / HTTP 工具全部落在 `system` 这**一个**组里（见 [plugin-tool-system](../plugins/plugin-tool-system.md)）。之后接入 OneBot 等多人平台时不会自动开组，需要在平台档里按需列出——群成员能驱动哪些 public 工具靠这道闸控制（见 [security-model](../concepts/security-model.md)）。

首次启动时 runtime 会把每个已装插件 `configSchema` 的默认值同步写回该文件（`config-sync`），几行的初始配置会展开成全量键值——这是预期行为，之后可直接在文件里改任意项；WebUI 配置页与文件双向同步。

**密钥直接写在 `aalis.config.yaml` 里，该文件在生成的 `.gitignore` 内、不入库。** 曾经走 `.env` + `${VAR}` 插值，但它承载的东西与配置文件完全重合，唯一区别只是「哪个文件进 git」；把配置文件本身 ignore 掉之后，那一层就成了多余，已随 `${VAR}` 插值一并删除。**现在写 `${VAR}` 会被原样当作字面量字符串**（不再替换），不应再这样写。

> 生态约定的「更多插件不在终端铺列」：长尾插件发现交给 WebUI 的「插件市场」页（`cli.ts`）。装新插件只需 `npm install @aalis/plugin-<name>`，装上即被自动发现加载。

---

## 二、`create-aalis-plugin` —— 创建一个插件骨架

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

非 TTY 且无 `--yes` 时同样提前拦截（`cli.ts`）。问 4 件事：

| prompt | 默认 | 说明 |
|---|---|---|
| 包名 | `aalis-plugin-sample` | 合法 npm 包名，支持 `@scope/my-plugin`；目录名取最后一段（`shortName`，`cli.ts`） |
| 显示名（中文标签） | 由包名推导 | 去掉 `plugin-` 前缀、连字符转空格、首字母大写（`defaultDisplayName`，`cli.ts`） |
| 注册 AI 工具？ | **是** | 生成 `uses: { tools: optional(tools) }` 与 `tools.register` 示例 |
| 注册斜杠命令？ | 否 | 生成 `uses: { commands: optional(commands) }` 与 `commands.command` 示例 |
| 提供 WebUI 页面？ | 否 | 生成 `uses: { webui: optional(webuiServer) }` 与 `registerPage` / `registerAction` 示例 |

`--yes` / `-y` 跳过全部，取上表默认（即只生成 tool 扩展点，`cli.ts`）。yes/no 输入兼容 `y/yes/true/1` 与 `n/no/false/0`（`parseYesNo`，`cli.ts`）。

### 生成了什么（插件骨架）

```
my-plugin/
├── package.json        # name / keywords:["aalis-plugin"] / peerDep core / 按选项的 *-api 依赖
├── tsconfig.json       # 自包含 compilerOptions（不 extends monorepo base，独立目录也能 tsc）
├── src/index.ts        # export default definePlugin({ name, displayName, uses, apply })
└── README.md           # 启用方式 + 已选扩展点清单
```

### 生成的 `package.json` 约定

关键约定（`renderPackageJson`，`cli.ts`）：

```jsonc
{
  "name": "my-plugin",
  "type": "module",
  "keywords": ["aalis-plugin"],          // 市场发现 + 加载硬门（见下）
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],                      // 发布包只含编译产物
  "dependencies": { "@aalis/api-tools": "latest" },  // 选了对应扩展点才写入（描述符是值导入）
  "peerDependencies": { "@aalis/core": ">=0.17.0 <1.0.0" },
  "devDependencies": { "@aalis/core": "latest", "typescript": "^5.7.0", "@types/node": "^22.0.0" },
  "aalis": { "service": { "optional": ["tools"] } }  // 与 uses 里 optional(tools) 对齐；未勾选扩展点则整块省略
}
```

- **`keywords: ["aalis-plugin"]` 是加载硬门**：两个加载器都只认这个关键词来判定「这是不是可加载插件」（`isLoadablePlugin`，`node-modules-loader.ts`）。漏了它，插件永远不被发现。
- **`@aalis/core` 走 peerDependency**，区间 `>=0.17.0 <1.0.0`：`definePlugin` / 服务描述符首次成为公开面的版本。插件不必随其后的 core 次版本升级重发（别用 `^0.x` caret 把自己锁死，也别用裸 `*`）。**注意 1.0 之前 core 的公开面可能在次版本被删**，用了更新的 API 就把下限再抬；稳定性承诺自 1.0 起生效，见 `docs/design/core-contract.md`。
- **选了哪个扩展点，才把对应 `*-api` 进 `dependencies`**：tool→`@aalis/api-tools`、command→`@aalis/api-commands`、webui→`@aalis/api-webui`，统一写 `"latest"`（`cli.ts`）。描述符是值导入，不能只放 `devDependencies`。
- **勾选了扩展点才写 `aalis.service`**：与 `uses` 里 `optional(...)` 的服务名对齐（tool → `optional: ["tools"]`，command → `commands`，webui → `webui-server`）。一旦你增加 `provides` 或把某依赖改成 required，要**同步** `package.json` 的 `aalis.service`，否则市场「装前披露」会缺项——对账纪律见 [concepts/manifest-metadata.md](../concepts/manifest-metadata.md)。

### 生成的 `src/index.ts` 形状

入口必须默认导出 `definePlugin` 的产物（`renderIndexTs`，`cli.ts`）。`--yes`（只勾选 tool）生成的原文形状：

```ts
import { tools } from '@aalis/api-tools';
import { definePlugin, logger, optional } from '@aalis/core';

export default definePlugin({
  name: 'my-plugin',
  displayName: 'My Plugin',
  uses: { logger, tools: optional(tools) },
  apply({ logger, tools }) {
    logger.info('插件已加载');

    tools.register({
      definition: {
        type: 'function',
        function: {
          name: 'hello',
          description: '示例工具：返回问候语',
          parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      },
      async handler(args) {
        return `你好, ${(args as { name: string }).name}!`;
      },
    });
  },
});
```

没有默认注入：`uses` 写了什么，`apply` 就只能碰到什么。`optional(tools)` 缺席不拦激活，登记会在 tools 到场或换人时由描述符的 registrar 重挂。

工具声明用 OpenAI 函数调用协议的嵌套形状 `{ type: 'function', function: { name, description, parameters } }`（`ToolDefinition`，`packages/api-tools/src/index.ts`），不是平铺的 `{ name, description }`。`handler` 返回 `Promise<string | ToolExecutionResult>`——字符串即纯文本；需要把图片交给主模型时返回 `{ content, images }`。

选了 command 时追加 `import { commands } from '@aalis/api-commands'`、`uses` 里 `commands: optional(commands)`，以及 `commands.command('hello', '示例命令').action(async () => '你好')`。选了 webui 时追加 `webuiServer`、`registerPage` 与 `registerAction`（页面动作不再是静态 `actions` 字段）。描述符来自各自的 `*-api` 包，**不**来自 core。各扩展点一览见 [第三方插件开发者指南](./third-party-plugin.md) 第 5 节。

脚手架同时生成 README，其中写明入口是 `export default definePlugin({ uses, apply })`，扩展点与 `src/index.ts` 的 `uses` 一致。

---

## 从脚手架到能用的插件

`create-aalis-plugin` 生成的骨架能加载、会打印日志，并按选项登记工具/命令/页面。让别的插件能用你这个能力需要两步。

### 1. 提供一个服务

在 `uses` 里声明 `provide` 与依赖的描述符，`provides` 写描述符数组，并同步 `package.json` 的 `aalis.service`：

```ts
import { storage } from '@aalis/api-storage';
import { definePlugin, defineService, provide } from '@aalis/core';

const myService = defineService<MyService>('my-service');

export default definePlugin({
  name: 'my-plugin',
  uses: { provide, storage },
  provides: [myService],
  apply({ provide }) {
    provide(myService, new MyService(), { label: 'my-service' });
  },
});
```

```jsonc
// package.json —— 源 B：市场装前披露（webui-server 读）
"aalis": { "service": { "provides": ["my-service"], "required": ["storage"] } }
```

> 这两套元数据**不自动对账**，必须手写一致。完整规则与第一方守卫见 [concepts/manifest-metadata.md](../concepts/manifest-metadata.md)。服务的注册/选优/per-entry 见 [concepts/service-model.md](../concepts/service-model.md) 与 [concepts/lazy-service-access.md](../concepts/lazy-service-access.md)。

### 2. 加配置

需要 API key / 地址等参数时，把 `configSchema` 写在 `definePlugin` 上（WebUI 据此自动渲染表单），并 `uses: { config }`：

```ts
import { config, definePlugin } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import type {} from '@aalis/api-webui';

const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true },
};

export default definePlugin({
  name: 'my-plugin',
  configSchema,
  uses: { config },
  apply({ config }) {
    // config 已含 schema 派生默认值
  },
});
```

配置 schema 的字段归属（`secret` 等渲染属性来自 api-webui 而非 core）见 [第三方插件开发者指南](./third-party-plugin.md) 第 3 节。

### 3. 本地验证 → 发布

- **本地运行**：在 Aalis 项目目录里执行 `npm install --install-links ../my-plugin`，并在该项目的 `.npmrc` 写 `install-links=true`（否则下一次普通 `npm install` 会改回符号链接）；pnpm 项目用 `pnpm add file:../my-plugin`。不能装成符号链接：插件目录 devDependencies 里的 `@aalis/core` 会成为进程里的第二份，插件被拒绝加载，见 [装了两份 @aalis/core](./third-party-plugin.md#two-cores)。拷贝安装不随源码同步，改动并重新构建后需再次安装。写进 `dependencies` 即被 node_modules 加载器发现。**插件默认启用**——`plugins` 段只放配置，启停看顶层 `disabledPlugins` 数组，没有 `enabled` 开关。放进 monorepo `packages/` 只对自行接了 `createFsPluginLoader` 的自托管仓库有效，脚手架生成的项目不走那条路。
- **发布**：`npm publish --access public`。用户 `npm install my-plugin` 后，因 `keywords` 含 `aalis-plugin` 即被自动发现加载（`node-modules-loader.ts`）。

完整的「从零到发布」最短路径见 [第三方插件开发者指南](./third-party-plugin.md)。

---

## 下一步

- 启动之后怎么用（要哪些 key / 零 key 走 Ollama / CLI 与 WebUI 两个入口 / 发第一条消息）：[guide/first-run.md](./first-run.md)
- 插件包的完整契约与发布流程：[guide/third-party-plugin.md](./third-party-plugin.md)
- 两套元数据源（`definePlugin` 的 provides/uses vs `package.json` aalis.service）与对账纪律：[concepts/manifest-metadata.md](../concepts/manifest-metadata.md)
- 服务模型（描述符 / `ServiceRef` / `services.prefer` / per-entry）：[concepts/service-model.md](../concepts/service-model.md)
- 为什么不能缓存 `current`、何时用 `follow`：[concepts/lazy-service-access.md](../concepts/lazy-service-access.md)
- 插件作者的安全责任边界：[concepts/security-model.md](../concepts/security-model.md)
