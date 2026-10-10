# 脚手架上手指南（Scaffolding）

> 受众：第一次接触 Aalis，想**搭建一个可运行的机器人实例**，或**编写一个可安装的插件**的人。
> 本文讲两个脚手架各自的用途、运行哪条命令、问什么、生成了什么、有哪些约定、下一步往哪走。
>
> 相关源码：`packages/create-aalis/src/cli.ts`（建项目）、`packages/create-aalis-plugin/src/cli.ts`（建插件）。
> 两者都是**零运行时依赖、纯 npm/node 的独立脚手架**。

---

## 两个脚手架，两件事

Aalis 提供两个互不相干的脚手架，先确认你需要哪个：

| 命令 | 产出 | 何时用 | 入口源码 |
|---|---|---|---|
| `npm create aalis` | 一个**可运行的独立项目**（机器人实例） | 你要部署 / 跑一个自己的 Aalis bot | `create-aalis/src/cli.ts` |
| `npm create aalis-plugin` | 一个**插件骨架包**（npm 包） | 你要给 Aalis 写并发布一个扩展插件 | `create-aalis-plugin/src/cli.ts` |

心智模型：
- **项目** = 一个家目录 `home/`（主配置 `aalis.config.yaml`，密钥字段只放引用；密钥文件 `secrets.yaml`；另有数据与日志）+ 一行 `startAalis()` + 若干装进 `node_modules` 的 `@aalis/plugin-*`。运行时从项目 `package.json` 的依赖里发现并加载这些插件。
- **插件** = 一个默认导出 `definePlugin({ name, uses, apply })` 产物的 npm 包（`create-aalis-plugin` 生成 `src/index.ts`），被某个项目装进去后由 runtime 发现、交给 core 注册。

两个脚手架都不写 `workspace:`（产物不在 Aalis 仓库里，外部装不上），依赖版本按生成时源上的最新版写，但写法不同：项目的根依赖写 `^<最新版>`，它是终端用户项目的锁定点，跨次版本升级走插件市场的「更新」（带预检与回滚）；插件的依赖写 `>=<最新版> <1.0.0`，它会发布出去被别人装，规则见 [第三方插件开发者指南](./third-party-plugin.md#_5-1-类型从哪里-import-依赖怎么归类)。

---

## 一、`npm create aalis` —— 创建一个机器人项目

### Quickstart

> 前提：Node.js 24.15.0 起（与 CI 一致）。版本不够时脚手架一开头就退出，写明需要的版本、当前版本，并指向 [第一次运行](./first-run.md#upgrade-node) 里的升级步骤。

```bash
# 交互式：问对话模型（可当场粘贴 key）、接入平台、要不要长期语义记忆，建好后自动 npm install
npm create aalis@latest my-bot

# 另问模板档、记忆后端、embedding 与向量库
npm create aalis@latest my-bot -- --advanced

# 非交互：上面几问全取默认（适合 CI / 管道 / 快速起步）
npm create aalis@latest my-bot -- --yes

# 按某一档的默认装、跳过安装
npm create aalis@latest my-bot -- --tier minimal --no-install
```

> 注意 `--` 分隔符：`npm create` 后给脚手架的 flag 必须放在 `--` 之后，否则会被 npm 自身解析、传不到脚手架。
>
> 显式写 `@latest`：不带版本时 `npm create` 会直接复用 `~/.npm/_npx/` 里已缓存的旧版 `create-aalis` 而不检查更新；
> 0.4 之前的版本经 `.bin` 软链调用时会静默退出（exit 0、无输出、不生成任何文件）。

运行后：

```bash
cd my-bot
npm start

# 一次性子命令：等价于聊天里的 /status，执行完即退出（`@aalis/runtime` 默认行为）；
# 可用命令取决于装了哪些插件，argv 非空但不是已注册命令时报错退出（exit 2），不会启动守护进程。
# 子命令在独立的一次性进程里执行：status/shutdown/restart 只作用于该临时实例；改配置文件的指令（如 auto）
# 经热重载对守护进程生效，改插件内存态的（如 level、session.*）不生效。管理运行中的实例请用聊天指令 / WebUI
npm start -- status
```

### 交互式提问

没有 `--yes` / `--tier` 且终端是 TTY 时逐项提问（非 TTY 环境提前退出，写明改用 `--yes` 或 `--tier` 的写法）。坏输入说明原因后重问；问的过程中按 `Ctrl+C` 退出（退出码 130），这时还没有生成任何文件。默认流程问四件事：

1. **项目目录名**：默认 `my-aalis-bot`，必须是合法 npm 包名（全小写、无空格、不以 `.`/`_` 开头等）。目录已存在且非空时退出，加 `--force` 覆盖写入。
2. **对话模型**（单选）：DeepSeek、OpenAI、Ollama（本机运行，零 key）。探到本机的 Ollama 时默认 Ollama，否则默认 DeepSeek。选了要 key 的，接着请你粘贴它的 `apiKey`：输入不显示，回车跳过。多装几个对话模型以后在插件市场装。
3. **接入平台**（多选）：CLI 终端、WebUI 管理界面、OneBot（QQ 等），默认 CLI 与 WebUI。选了 WebUI 自动带上前端与安装引擎（见下文「伴生依赖」），不选就不装。
4. **要长期语义记忆吗**（是或否）：按意思找回很久以前聊过的内容，要一个 embedding 模型。探到 Ollama 时默认「要」，否则默认「不要」。答「要」会装向量记忆、一个 embedding 提供者与 Flat 向量库：有 Ollama 可用（探到了，或对话模型选了 Ollama）时用 Ollama Embedding，否则用 OpenAI Embedding 并请你粘贴它的 `apiKey`。这一组由哪些插件组成见[记忆由哪些插件组成](./memory.md)。

选项序号用逗号或空格分隔（`1,2` 与 `1 2` 一样），回车取默认。

**`--advanced`** 在项目名之后先问**模板档**，选了 `minimal` 或 `standard` 再接着问上面的对话模型与平台，另问**记忆后端**（SQLite、内存、MongoDB，默认 SQLite）；`standard` 档答「要」语义记忆时，再问 **Embedding 提供者**（单选，默认同上）与**向量库**（Flat 或 LanceDB，默认 Flat）。没有 LanceDB 预编译件的平台（如 Intel Mac）不列 LanceDB。

| 档 | 装什么 |
|---|---|
| `bare` | 只装 `@aalis/core` + `@aalis/runtime`（完全自定义起点） |
| `minimal` | 最简对话实例：钩子、贡献点、本地存储与进程、网关、指令、流控、agent、工具、提示词预算、权限、会话管理、会话服务（会话协议与审批）、消息归档、跨会话历史（`MINIMAL_BASE`），加所选的对话模型、平台与记忆后端 |
| `standard` | 默认流程装的就是这一档：minimal 加人设系统、记忆摘要、用户事实档案、人物关系图、文件读取、系统工具、触及（给本地工具签发读写与执行的凭据）、搜索工具（工具多时按需检索）、多模态媒体识别、定时任务与 Cron 调度引擎、触发策略、任务计划、回滚检查点、技能系统、子任务、会话工具、系统诊断、MCP 客户端（`STANDARD_EXTRA`），语义记忆按那一问装。不含联网搜索，需要时在插件市场装 |
| `full` | 实时查 npm 上全部已发布的官方插件（含联网搜索）；连不上 npm 时回退到内置的离线清单。没有 LanceDB 预编译件的平台不装 LanceDB |

`minimal` 起各档都包含 `@aalis/plugin-hooks` 与 `@aalis/plugin-contributions`：钩子与贡献点由这两个插件提供，网关、agent、指令等都依赖它们，缺了会停在 pending。`bare` 档不含，在其上自行加装这类插件时要一并装上。`full` 档要下载浏览器（浏览器工具与绘图插件），装得慢，也更可能遇到下载失败，见[安装与启动排障](./troubleshooting.md#下载浏览器失败)。

### 探测本机的 Ollama

`minimal` 与 `standard` 档在问对话模型之前探一次本机的 Ollama：设了 `OLLAMA_HOST`（Ollama 自己的地址变量）时探它，否则探 `http://127.0.0.1:11434`；请求 `/api/tags`，1 秒内没有像样的回应就当没有；在同一个 1 秒里再逐个查 `/api/show` 报的模型能力。`OLLAMA_HOST` 的写法与 Ollama 一致：不写协议按 `http`、端口默认 11434，写了 `http://` 或 `https://` 的用协议的默认端口；解析不了时脚手架退出，写明怎么改。

- 探到了：打印「探到 Ollama（地址），零 key 可用」，对话模型默认 Ollama，语义记忆默认「要」并用 Ollama Embedding。
- 用到 Ollama 时，结尾的「下一步」列出启动前要拉的模型：Ollama 里还没有对话模型时提示 `ollama pull <对话模型名>`（判据与 Ollama 对话模型插件相同：`/api/show` 报的能力里没有 `completion` 的嵌入模型不算，查不到能力的算）；语义记忆用 Ollama Embedding 而里面没有 `nomic-embed-text` 时提示 `ollama pull nomic-embed-text`。
- 设了 `OLLAMA_HOST` 的，它的地址写进两个 Ollama 插件配置段的 `baseUrl`。

### `--yes` 与命令行 flag 的默认值

| flag | 作用 | 默认 |
|---|---|---|
| `--yes` / `-y` | 不提问，取默认流程的全部默认答案 | 探到 Ollama：对话模型 Ollama，语义记忆用 Ollama Embedding 与 Flat；没探到：对话模型 DeepSeek，不装语义记忆。平台都是 CLI 与 WebUI，记忆后端 SQLite，档位 `standard` |
| `--advanced` | 另问模板档、记忆后端、embedding 与向量库 | 不问 |
| `--tier <档>` | 按这一档的默认装，不提问；`bare` / `minimal` / `standard` / `full` | — |
| `--no-install` | 跳过自动 `npm install` | 默认会装 |
| `--force` | 目标目录非空时也覆盖写入 | 默认报错退出 |
| `--registry <url>` | 查插件目录与版本用的 npm 源 | `https://registry.npmjs.org` |

> `--registry` 只影响脚手架查 `aalis-plugin` 目录与版本号；生成项目里 `npm install` 仍用你自己的 npm 配置（二者解耦）。

### 安装失败时

`npm install` 的输出照常显示在终端。失败时脚手架按 npm 的报错认出是哪一类，写明原因与修法，再给出重试命令、npm 完整日志的位置与[安装与启动排障](./troubleshooting.md)的地址，各类见那一页的[「`npm install` 失败」](./troubleshooting.md#npm-install-失败)；认不出的写「原因见上面 npm 的报错」。默认装的插件都不需要在本机编译。

### 生成了什么（项目布局）

```
my-bot/
├── package.json        # @aalis/core + @aalis/runtime + 所选插件（版本见下），engines 写 Node 24.15.0 起
├── index.mjs           # 一行 startAalis() 启动
├── home/               # 家目录（**不入库**）：配置、密钥、数据与日志都在这里
│   ├── aalis.config.yaml   # 主配置：name / logLevel / plugins / sessionConfig / disabledPlugins；密钥字段只放引用
│   └── secrets.yaml        # 密钥的值（生成时为空，0600）
├── .gitignore          # node_modules/ home/ *.log dist/
└── README.md           # 启动、配置、装更多插件，以及第一次运行与安装排障的文档地址
```

首次启动后，`home/` 里还会出现 `state/`（数据库、向量库、会话、附件、checkpoint、WebUI 凭据等）、`self/`（人设与技能）、`stage/`（白纸成品与发布的作品）、`tmp/`、`cache/`、`logs/`（`latest.log`）、`run/`（实例锁）与 `workspace/`（文件工具的默认工作根）。这些子目录由用到它们的部分在启动时建出（多数是存储插件的内部根），完整布局见 [runtime 的「家目录」](../architecture/runtime.md#家目录)；其中还没有使用方的 `stage/drafts` 不会出现。

入口 `index.mjs`：

```js
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAalis } from '@aalis/runtime';

const here = dirname(fileURLToPath(import.meta.url));
startAalis({ appDir: here, defaultHome: join(here, 'home') }).catch(err => {
  console.error('Aalis 启动失败:', err);
  process.exit(1);
});
```

`startAalis()` 是 `@aalis/runtime` 的总入口（`packages/runtime/src/start.ts`）：`appDir` 是安装集（这个项目目录），`defaultHome` 是兜底的家目录（项目里的 `home/`）；设 `AALIS_HOME` 或用 `npm start -- --home <目录>` 启动可以把家目录放到别处（规则见 [runtime 的「家目录」](../architecture/runtime.md#家目录)）；新位置第一次要加 `--init` 初始化，如 `npm start -- --home <目录> --init`，它写的平台档与脚手架写的一致（见下文「配置约定」）。经 npm 启动时这些参数要放在 `--` 之后，并写在子命令之前，如 `npm start -- --home <目录> status`。它读家目录里的 `aalis.config.yaml`，用 node_modules 加载器扫项目依赖、按 `keywords` 含 `aalis-plugin` 发现插件并加载。

`package.json` 的依赖版本由脚手架逐包向源查：能查到最新版就写 `^<最新版>`，查不到的写 `"latest"`（`npm install` 时再取最新）。

结尾打印「下一步」：进目录（跳过了安装的另加 `npm install`）、用到 Ollama 时要拉的模型、`npm start`；还有没填的密钥时逐个点名哪个插件的哪个键，写明启动后在 WebUI 插件区填或填进配置文件（`full` 档另装了不少要手配的插件，点名的不是全部，另写一句其余的启动后在「需要处理」里列出）；最后是[第一次运行](./first-run.md)的地址与装更多插件的办法（`full` 档不写后者）。

### 自动补齐的「伴生」依赖

某些选择会自动带上必需的配套包，避免遗漏：

- 选了 **WebUI**（`@aalis/plugin-webui-server`）→ 自动加 `@aalis/plugin-webui-client`（前端静态资源，缺它 404）+ `@aalis/plugin-package-manager`（市场「安装」否则 503）。
- 选了 **code_runner**（`@aalis/plugin-tool-code-runner`）→ 自动加 `@aalis/plugin-code-sandbox-os`（OS 沙箱后端，缺它 fail-closed 拒绝执行）。

### 配置约定

`home/aalis.config.yaml` 只写需要的几段，其余插件用默认配置启动：

- 要密钥的插件（DeepSeek、OpenAI、OpenAI Embedding，以及 `full` 档的联网搜索）写一个 `apiKey` 段：粘贴了的写成 JSON 字符串（同时是合法的 YAML 双引号串，引号、反斜杠、冒号与 `#` 原样读回），跳过的留空 `apiKey: ""`。空串不算填了：DeepSeek、OpenAI Embedding 与联网搜索激活失败，在 WebUI 标「待配置」；OpenAI 对话模型的 apiKey 只在连官方地址时必填，显示为「失败」加原因，按钮「去处理」（见[第一次运行](./first-run.md)）。填了值的在启动时移进 `secrets.yaml`。
- 设了 `OLLAMA_HOST` 时，两个 Ollama 插件写上 `baseUrl`。

还会给两个只有 owner 进得来的平台（`cli`、`webui`）各写一个平台档，开放全部工具分组；这两项无条件写，平台没装时不起作用，之后从市场装上即生效。多人平台（如 OneBot）不代开。平台档是会话设置在会话之上的一层，写在配置文档的顶层字段 `sessionConfig` 里（见 [plugin-session-manager](../plugins/plugin-session-manager.md#会话之上的各层)）。runtime 的 `--init` 写同样的平台档：

```yaml
sessionConfig:
  platforms:
    cli:
      enabledToolGroups: ["*"]
    webui:
      enabledToolGroups: ["*"]
```

带分组的工具（`system`、`skills`、`scheduler`、`subtask` 等）默认不暴露，平台档列出该**组名**或写 `"*"` 才对模型可见。组名要写准——`plugin-tool-system` 的 shell / 文件 / 系统 / HTTP 工具全部落在 `system` 这**一个**组里（见 [plugin-tool-system](../plugins/plugin-tool-system.md)）。之后接入 OneBot 等多人平台时不会自动开组，需要在平台档里按需列出——群成员能驱动哪些 public 工具靠这道闸控制（见 [security-model](../concepts/security-model.md)）。

首次启动时 runtime 会把每个已装插件 `configSchema` 的默认值同步写回该文件（`config-sync`），几行的初始配置会展开成全量键值——这是预期行为，之后可直接在文件里改任意项；WebUI 配置页与文件双向同步。

**密钥的值存在 `home/secrets.yaml` 里**，`home/aalis.config.yaml` 只放引用。填写时直接写进 `aalis.config.yaml` 或在 WebUI 配置页填都可以：启动或热重载时，runtime 把标了 `secret` 的字段上的明文移进 `secrets.yaml`（0600），原处换成 `{ $secret: '<键>' }`，日志只写字段路径与键名。运行中把已有的引用改写成明文时写回原来那个键（数组元素里的除外），这个键被别的插件共用时，它们一起换成新值并重载；启动时会另取新键，旧值留在 `secrets.yaml` 里。只想换某一个插件的 key，把它的字段改成指向新键的引用，并在 `secrets.yaml` 里加上这个键。移走之前的明文可能还留在编辑器的备份文件里。`home/` 在生成的 `.gitignore` 内、不入库；备份家目录时连同 `secrets.yaml` 一起备份。规则见 [运行态与配置文档](../core/config.md#密钥配置)。曾经走 `.env` + `${VAR}` 插值，但它承载的东西与配置文件完全重合，唯一区别只是「哪个文件进 git」；把家目录本身 ignore 掉之后，那一层就成了多余，已随 `${VAR}` 插值一并删除。**现在写 `${VAR}` 会被原样当作字面量字符串**（不再替换），不应再这样写。

> 装更多插件：长尾插件交给 WebUI 的插件市场（可按名称、说明或提供的服务搜），装上立即加载；也可以在项目目录 `npm install @aalis/plugin-<name>`，之后重启实例或在 WebUI 插件区点「重新扫描」才加载。

---

## 二、`create-aalis-plugin` —— 创建一个插件骨架

### Quickstart

```bash
# 交互式
npm create aalis-plugin@latest

# 指定包名，其余逐项问
npm create aalis-plugin@latest my-plugin

# 全取默认（tool 模板，无 command / webui / 会话设置项）
npm create aalis-plugin@latest my-plugin -- --yes
```

生成后：

```bash
cd my-plugin
npm install
npm run build
```

生成时脚手架向 npm 源查依赖的最新版本（`{源}/{包}/latest`），默认官方源，`--registry <源地址>` 换一个；查不到就退出，写明是哪个包查不到、检查网络或用 `--registry` 指定能访问的源，不生成任何文件。目标目录已存在时同样退出，写明换一个插件名或先移走这个目录。

### 交互式提问与默认值

非 TTY 且无 `--yes` 时提前退出，写明改用 `--yes`。依次问：

| 提问 | 默认 | 说明 |
|---|---|---|
| 包名 | `aalis-plugin-sample` | 合法 npm 包名，支持 `@scope/my-plugin`；目录名取最后一段 |
| 显示名（中文标签） | 由包名推导 | 去掉 `plugin-` 前缀、连字符转空格、首字母大写 |
| 注册 AI 工具？ | **是** | 生成 `uses: { tools: optional(tools) }` 与 `tools.use.register` 示例 |
| 注册斜杠命令？ | 否 | 生成 `uses: { commands: optional(commands) }` 与 `commands.use.command` 示例 |
| 提供 WebUI 页面？ | 否 | 生成 `uses: { webui: optional(webuiServer) }` 与 `webui.use.definePage` 示例 |
| 页面用自带前端？ | 否 | 只在上一问选了「是」时问。选了就把页面写成插件前端：另生成 `webui/` 里的静态网页，见下文「页面用自带前端」 |
| 登记会话设置项？ | 否 | 生成 `uses: { sessionManager: optional(sessionManager) }` 与一项会话设置项，见下文「会话设置项」 |

`--yes` / `-y` 跳过全部，取上表默认（即只生成 tool 扩展点）。yes/no 输入兼容 `y/yes/true/1` 与 `n/no/false/0`。

### 生成了什么（插件骨架）

```
my-plugin/
├── package.json        # name / keywords:["aalis-plugin"] / peerDep core / 按选项的 *-api 依赖
├── tsconfig.json       # 自包含 compilerOptions（不 extends 任何外部配置，独立目录也能 tsc）
├── src/index.ts        # export default definePlugin({ name, displayName, uses, apply })
├── webui/              # 只在页面用自带前端时生成：index.html 与 main.js
└── README.md           # 构建、装进 Aalis 项目的办法与已选扩展点清单
```

### 生成的 `package.json` 约定

关键约定（`<最新版>` 是生成时源上各包各自的最新版）：

```jsonc
{
  "name": "my-plugin",
  "type": "module",
  "keywords": ["aalis-plugin"],          // 市场发现 + 加载硬门（见下）
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],                      // 发布包只含编译产物；页面用自带前端时另有 "webui"
  "dependencies": { "@aalis/api-tools": ">=<最新版> <1.0.0" },  // 选了对应扩展点才写入（描述符是值导入）
  "peerDependencies": { "@aalis/core": ">=0.17.0 <1.0.0" },
  "devDependencies": { "@aalis/core": ">=<最新版> <1.0.0", "typescript": "^5.7.0", "@types/node": "^22.0.0" },
  "aalis": { "service": { "required": ["logger"], "optional": ["tools"] } }  // 与 uses 对齐：logger 为 required，optional(tools) 为 optional
}
```

- **`keywords: ["aalis-plugin"]` 是加载硬门**：两个加载器都只认这个关键词来判定「这是不是可加载插件」（`isLoadablePlugin`，`node-modules-loader.ts`）。漏了它，插件永远不被发现。
- **`@aalis/core` 走 peerDependency**，区间 `>=0.17.0 <1.0.0`：`definePlugin` / 服务描述符首次成为公开面的版本，模板只用到这些。插件不必随其后的 core 次版本升级重发（别用 `^0.x` caret 把自己锁死，也别用裸 `*`）。**注意 1.0 之前 core 的公开面可能在次版本被删**，用了更新的 API 就把下限再抬；稳定性承诺自 1.0 起生效，见 `docs/design/core-contract.md`。
- **依赖写区间**：`dependencies` 里的 `@aalis/api-*` 与 `devDependencies` 里的 `@aalis/core` 写 `>=<生成时源上的最新版> <1.0.0`。区间能被包管理器去重到与宿主同一份安装，跨次版本也不断；不写 `latest`（发布出去等于不设上限），也不写 caret（0.x 下跨次版本即断）。
- **选了哪个扩展点，才把对应 `*-api` 进 `dependencies`**：tool→`@aalis/api-tools`、command→`@aalis/api-commands`、webui→`@aalis/api-webui`、会话设置项→`@aalis/api-session-manager`。描述符是值导入，不能只放 `devDependencies`。
- **`aalis.service` 与 `uses` 对齐**：`required` 固定含 `logger`；勾选的扩展点按 `optional(...)` 的服务名写进 `optional`（tool → `tools`，command → `commands`，webui → `webui-server`，会话设置项 → `session-manager`）。一旦你增加 `provides` 或把某依赖改成 required，要**同步** `package.json` 的 `aalis.service`，否则市场「装前披露」与按服务搜都会缺项——对账纪律见 [concepts/manifest-metadata.md](../concepts/manifest-metadata.md)。

### 生成的 `src/index.ts` 形状

入口必须默认导出 `definePlugin` 的产物。`--yes`（只勾选 tool）生成的形状（注释从略）：

```ts
import { tools } from '@aalis/api-tools';
import { definePlugin, logger, optional } from '@aalis/core';

export default definePlugin({
  name: 'my-plugin',
  displayName: 'My Plugin',
  uses: { logger, tools: optional(tools) },
  apply({ logger, tools }) {
    logger.use.info('插件已加载');

    tools.use.register({
      risk: 'safe',
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

`risk` 是工具的风险档位，决定谁能经自然语言驱动它、要不要确认，模板的示例工具只读、不涉隐私，写 `'safe'`。三档：

| 档 | 用在 | 谁能用 |
|---|---|---|
| `safe` | 只读、不涉隐私 | 任何人 |
| `sensitive` | 只读但涉隐私（读别人的消息、读文件） | 有权限的用户 |
| `dangerous` | 写、删、执行 | 高权限的用户，owner 用也要确认 |

什么都不声明时任何人可用、不确认，与 `safe` 相同，所以写、删、执行一定要声明。详见 [安全模型的「插件作者怎么标操作风险」](../concepts/security-model.md#插件作者怎么标操作风险-provider-侧)。耗时长、晚些拿到结果仍有用的工具（构建、下载、渲染）可以声明 `background: {}`，交给执行器转后台，要求见 [插件作者指南「长任务与取消」](../plugin-author-guide.md#长任务与取消)；模板的示例工具是即时的，不声明，只在注释里写了声明法。

选了 command 时追加 `import { commands } from '@aalis/api-commands'`、`uses` 里 `commands: optional(commands)`，以及 `commands.use.command('hello', '示例命令').action(async () => '你好')`。选了 webui 时追加 `webuiServer` 与一段 `webui.use.definePage`：一个键值组件，数据源直接写在声明里（页面与动作一次给出，不是静态字段），页面出现在插件详情里。描述符来自各自的 `*-api` 包，**不**来自 core。各扩展点一览见 [第三方插件开发者指南](./third-party-plugin.md) 第 5 节。

脚手架同时生成 README，其中写明构建命令、装进 Aalis 项目的三种办法，以及入口与 `src/index.ts` 一致的 `uses`。

### 会话设置项

「登记会话设置项？」选了「是」时，`src/index.ts` 多三样：

- 用 declaration merging 把设置项的值类型加进 `@aalis/api-session-manager` 的 `SessionConfig`，键名是 `greeting` 接上包名的驼峰写法（如 `greetingMyPlugin`），各插件的设置项共用一张表，接上包名免得撞键；
- `uses` 加 `sessionManager: optional(sessionManager)`，`apply` 里经 `sessionManager.use.registerSetting` 登记这一项：字段（类型、标签、说明与显示用的默认值）、适用的会话种类（`owner`、`room`、`task`）与显眼程度（`advanced`，收进会话设置的「高级」）。登记随这次激活撤回，会话管理晚上线时自动补上；
- 同时选了工具时，示例工具按这次调用所在的会话读这一项的生效值：先看 `sessionManager.present`，在场时读 `sessionManager.use.resolveConfig(ctx.sessionId, ctx.platform).<键>`，会话自己的、平台档与全局默认逐层叠出；会话管理不在或哪层都没设时用默认的问候语。

登记之后，这一项出现在 WebUI 的会话设置与设置里「会话默认」的各层里。契约见 [session-manager 服务的「设置项的登记与解析」](../services/session-manager.md#_2-5-设置项的登记与解析)。

### 页面用自带前端

页面默认声明式；「页面用自带前端？」选了「是」时，`webui.use.definePage` 写成插件前端的形态（契约见 [api-webui 的「插件前端」](../api/api-webui.md#插件前端)）：

```ts
const items = ['示例条目一', '示例条目二', '示例条目三'];
const page = webui.use.definePage({
  key: 'my-plugin',
  title: 'My Plugin',
  frame: { module: import.meta.url },
  sources: { items: { data: () => items } },
  actions: {
    remove: {
      label: '删除',
      effect: 'destructive',
      confirm: '从列表里删掉这一条？',
      input: { item: { type: 'string', label: '条目', required: true } },
      handler: ({ input }) => {
        // 删掉这一条，再 page.invalidate('items')：打开着的页面收到通知后重取
      },
    },
  },
});
```

另生成两份文件，都不用构建：

- `webui/index.html`：入口，引用宿主提供的样式基线 `/frames/_base/frame.css`，颜色跟随宿主的主题；
- `webui/main.js`：从 `/frames/_base/frame.js` 导入助手，`connect()` 握手后取数据源 `items` 列出条目，每条一个「删除」调动作 `remove`（宿主先弹确认框，框里列出这一条），插件 `invalidate` 之后重取。

`package.json` 的 `files` 带上 `webui`，README 多一节「插件前端」，写明框架里能做什么、不能做什么。宿主从 `frame.module`（`import.meta.url`）往上取最近一个带 `name` 的 `package.json`（只写 `type` 的跳过），它的 `name` 要等于插件名，那一层就是包根，只托管它下面的 `webui/`；不符就拒绝登记。

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
    provide.use(myService, new MyService(), { label: 'my-service' });
  },
});
```

```jsonc
// package.json —— 源 B：市场装前披露与按服务搜（webui-server 读）
"aalis": { "service": { "provides": ["my-service"], "required": ["provide", "storage"] } }
```

> 这两套元数据**不自动对账**，必须手写一致。完整规则与第一方守卫见 [concepts/manifest-metadata.md](../concepts/manifest-metadata.md)。服务的注册/选优/per-entry 见 [concepts/service-model.md](../concepts/service-model.md) 与 [concepts/lazy-service-access.md](../concepts/lazy-service-access.md)。

### 2. 加配置

需要 API key / 地址等参数时，把 `configSchema` 写在 `definePlugin` 上（WebUI 据此自动渲染表单），声明 `config` 与 `logger` 并在 apply 中解析：

```ts
import { config, definePlugin, logger } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';

const configSchema = defineConfig({
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true, onInvalid: 'error' },
});

export default definePlugin({
  name: 'my-plugin',
  configSchema,
  uses: { config, logger },
  apply({ config, logger }) {
    const cfg = parseConfig(configSchema, config.use, logger.use);
    // 使用 cfg.apiKey；必填缺失会在解析时报告
  },
});
```

`secret: true` 由 `@aalis/schema-config` 声明，表示值是凭据：宿主存进 `secrets.yaml`、WebUI 不回显，插件经 `parseConfig` 读到的仍是原值。字段属性的细节见 [第三方插件开发者指南](./third-party-plugin.md) 第 3 节。

### 3. 本地验证 → 发布

- **本地运行**：在 Aalis 项目目录里执行 `npm install --install-links ../my-plugin`，并在该项目的 `.npmrc` 写 `install-links=true`（否则下一次普通 `npm install` 会改回符号链接）；或在插件目录 `npm pack`，再在项目目录 `npm install <生成的 .tgz>`。不能装成符号链接：插件目录 devDependencies 里的 `@aalis/core` 会成为进程里的第二份，插件被拒绝加载，见 [装了两份 @aalis/core](./third-party-plugin.md#two-cores)。拷贝安装不随源码同步，改动并重新构建后需再次安装。装好后重启实例，或在 WebUI 插件区点「重新扫描」，插件才会加载。**插件默认启用**——`plugins` 段只放配置，启停看顶层 `disabledPlugins` 数组，没有 `enabled` 开关。
- **发布**：`npm publish --access public`，发布前的清单见 [插件作者指南「发布到插件市场」](../plugin-author-guide.md#发布到插件市场)。用户经 WebUI 的插件市场安装时立即加载；在终端 `npm install` 的，重启实例或点「重新扫描」后加载。

完整的「从零到发布」最短路径见 [第三方插件开发者指南](./third-party-plugin.md)。

---

## 下一步

- 启动之后怎么用（要准备什么 / 零 key 走 Ollama / CLI 与 WebUI 两个入口 / 没起来的插件怎么看）：[guide/first-run.md](./first-run.md)
- 装不上、起不来：[guide/troubleshooting.md](./troubleshooting.md)
- 插件包的完整契约与发布流程：[guide/third-party-plugin.md](./third-party-plugin.md)
- 两套元数据源（`definePlugin` 的 provides/uses vs `package.json` aalis.service）与对账纪律：[concepts/manifest-metadata.md](../concepts/manifest-metadata.md)
- 服务模型（描述符 / 选择层与业务层 / `services.prefer` / per-entry）：[concepts/service-model.md](../concepts/service-model.md)
- 业务句柄为什么能存起来、何时用 `follow`：[concepts/lazy-service-access.md](../concepts/lazy-service-access.md)
- 插件作者的安全责任边界：[concepts/security-model.md](../concepts/security-model.md)
