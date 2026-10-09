# 第一次运行

> 承接[脚手架上手指南](./scaffolding.md)：项目已经建好、`npm install` 已经跑完。
> 这一页讲**从 `npm start` 到第一次成功对话**之间的事：要准备什么、启动后看到什么、没起来的插件怎么看、怎么发第一条消息、怎么停。

## 你需要准备什么

**运行环境**：Node.js 24.15.0 起（与 CI 一致），`node -v` 可查看当前版本，版本不够时见下面的[升级 Node](#upgrade-node)。

**一个对话模型**：只有对话模型是必需的，其余插件都是增强。`npm create aalis` 问对话模型时三选一：

| 选项 | 要什么 |
|---|---|
| DeepSeek | 一把 DeepSeek 的 API key |
| OpenAI | 一把 OpenAI 的 API key；OpenAI 兼容的服务把 `baseUrl` 改成它的地址 |
| Ollama | 本机运行的 [Ollama](https://ollama.com)，不要 key |

脚手架探到本机的 Ollama 时默认用它，不要任何 key；语义记忆是单独一问，答「要」时没有 Ollama 就要再粘贴一把 OpenAI 的 key。探测规则与各问的默认见[脚手架的交互式提问](./scaffolding.md#交互式提问)，记忆装哪些插件见[记忆由哪些插件组成](./memory.md)。

联网搜索默认不装，要用时在 WebUI 的插件市场搜 `websearch`，装上后填它的 key。

### key 填在哪

选了要 key 的对话模型或 OpenAI Embedding 时，脚手架请你当场粘贴 key（输入不显示，回车跳过），粘贴的写进 `home/aalis.config.yaml` 里该插件的段。跳过的，脚手架结尾的「下一步」逐个点名哪个插件的哪个键还没填；启动后在 WebUI 插件区打开该插件填写，或填进配置文件：

```yaml
plugins:
  "@aalis/plugin-llm-deepseek":
    apiKey: "sk-..."
```

启动时宿主会把这类密钥字段上的值移进同目录的 `home/secrets.yaml`（0600），配置文件里换成引用 `{ $secret: "..." }`；在 WebUI 里填效果相同。移走之前的明文可能还留在编辑器的备份文件里，需要时自行删除。`home/` 在生成的 `.gitignore` 里，不入库。详见 [运行态与配置文档](../core/config.md#密钥配置)。

没填 key 的插件激活失败，**不会中断启动**：进程照常起来，日志里留下 `插件 "..." 激活失败: ConfigError: 缺少配置项 apiKey，在 WebUI 或配置文件中填入后生效` 的 ERROR，WebUI 首页写「待配置：apiKey」并给出去配置的按钮（见下文[开始使用与需要处理](#开始使用与需要处理)）。只在某些情况下才必填的（如 OpenAI 的 apiKey，只有连官方地址时才要）显示为「失败」加原因，按钮「去处理」进它的详情，在那里填。没有可用的对话模型时发消息，会收到一条「未找到任何具备 chat 能力的 LLM」的回复，点名激活失败的模型插件。

### 零 key：用本地 Ollama

建项目时本机已经在跑 Ollama 的，脚手架默认就用它，见上文。项目建好之后再改用 Ollama：

```bash
npm install @aalis/plugin-llm-ollama
```

它默认连 `http://localhost:11434`（Ollama 不在默认地址时改它的 `baseUrl`），不需要任何 key，会把本机已有的对话模型注册为可选模型（`/api/show` 只报 embedding 能力的模型不会进列表）。

嵌入（语义记忆所需）装 `@aalis/plugin-embedding-ollama`，但它和对话模型不同：**默认模型 `nomic-embed-text` 必须自己先拉下来**，否则每次向量索引都会失败。建项目时没要语义记忆的，还要装上向量记忆与一个向量库：

```bash
ollama pull nomic-embed-text
npm install @aalis/plugin-embedding-ollama
npm install @aalis/plugin-memory-vector @aalis/plugin-vectorstore-flat   # 建项目时没要语义记忆时
```

对话模型是「发现本机已有的」，嵌入模型是「用配置里指定的那一个」——机器上没有就一直 404。这种「服务在、但每次调用都失败」的状态用 `/doctor` 看（会报 `service/embedding.ollama` 不可用），`/status` 只判服务是否注册、看不出来。

换用别的嵌入模型改这一项：

```yaml
plugins:
  "@aalis/plugin-embedding-ollama":
    model: "你已经 pull 下来的嵌入模型"
```

> 在**已经运行**的实例上用 `npm install` 装的插件，重启实例或在 WebUI 插件区点「重新扫描」后才加载；经 WebUI 的插件市场安装的立即加载。

<a id="upgrade-node"></a>
### 升级 Node

当前 Node 低于 24.15.0 时，`npm create aalis` 一开头就会退出，报错指向本节。升级方法：

- macOS 与 Linux：用 nvm 管理 Node 的，执行 `nvm install 24`，再执行 `nvm alias default 24`，之后新开的终端也默认使用 Node 24；也可以从 [Node.js 官网](https://nodejs.org) 下载 24 的安装包安装。
- Windows：从 Node.js 官网下载 24 的安装包安装，或用 nvm-windows 装上 24 并切换过去。

## 启动

```bash
npm start
```

### 终端：CLI 会接管整个屏幕

`plugin-cli` 在启动完成后进入全屏界面，启动日志会被收进日志页。有插件没起来时，欢迎行下面多一行「有 N 个插件没起来，输入 /doctor 查看原因与修法」。常用按键：

| 按键 | 作用 |
|---|---|
| `Ctrl+T` | 切到聊天页 |
| `Ctrl+L` | 切到日志页（**启动日志、报错都在这里**） |
| `Ctrl+S` | 切到状态页 |
| `Ctrl+G` | 快捷键帮助 |
| `Ctrl+C` | 退出程序 |

> stdin/stdout 任一不是 TTY（日志重定向、容器、systemd）时不接管终端，日志照常打到控制台。

### 浏览器：WebUI 需要 token

WebUI 默认监听 `http://127.0.0.1:3000`，并且**需要 token 登录**。完整的一键登录链接写在文件 `home/state/webui/access.txt` 里；默认的 `tokenMode: persist` 另把 token 本身存在 `home/state/webui/token`。

启动日志出于安全**不打印 token 本身**——它只给出 `access.txt` 的绝对路径（「访问凭据已写入: …」那行，CLI 里按 `Ctrl+L` 看）。

首次启动时默认会自动用带 token 的链接打开浏览器（`autoOpen`）；之后沿用同一个 token，浏览器里的登录仍然有效；开了 `autoOpen` 的，每次启动仍会打开一次。SSH / 容器 / 远程访问时把它关掉，手工复制链接即可。

> **持有 token 的人等同 owner**。把 `host` 改成 `0.0.0.0` 对外暴露之前，先读 [plugin-webui-server 的「登录身份与权限」](../plugins/plugin-webui-server.md)。

打不开（端口被占）、找不到 token 时见[安装与启动排障](./troubleshooting.md)。

## 开始使用与需要处理

插件没起来不会让整个实例停下：激活失败的插件进入失败状态，依赖它的插件停在「缺服务」，其余照常运行。哪些没起来、为什么、怎么修，在这几处看：

- **「开始使用」**：还没有一个能对话的模型时，出现在 WebUI 首页上方（手机上在第一层顶部）。先列已装的对话模型插件与它为什么不能用，按状态给「去配置」「启用」或去处理它依赖的插件；再列插件市场里提供对话模型、还没装的包，可以直接「安装」，装好后进它的配置区。有了能对话的模型就消失。
- **「需要处理」**：首页上列最多五条，「全部」进运行状况。没起来的插件每个一行：
  - 「失败：…」：激活时出错，后面是它的报错，修法写在前面。
  - 「待配置：apiKey」：必填的配置项没填，用提醒色，按钮「去配置」进它的配置区。
  - 「缺服务：…」：它要的服务此刻没有插件提供。说明写从提供者到真正出问题的那个插件（根）的链与根的情形（根失败时只写报错的第一行，全文在根插件自己那一行），如「OpenAI Embedding（待配置：apiKey）」「Flat 向量库（已停用）」「Ollama（在运行但没有提供 llm）」（插件在运行，却撤回了它该提供的服务，例如 Ollama 里的模型全被删了），按钮直接去根插件。没有已装的插件提供时写「没有已装的插件提供 embedding，可以在插件市场按服务搜 embedding」；几个插件互相等待时写「互相等待成环」并点名它们。
  - 只是在等别的插件启动完的不算，不进这里、不计数，插件树上写「等待启动」，它启动完就好。
- **「会话服务未启用」**：WebUI 的会话靠会话服务，它没起来时桌面上主区写这一句（手机写在第一层的会话列表里），下面同样写链，如「会话服务 → SQLite 记忆（失败：…）」，按钮去 SQLite 记忆。
- **终端**：欢迎行下面的「有 N 个插件没起来」，都起来了就没有这一行。
- **`/doctor`**：「失败」逐个写报错，「未就绪」逐个写缺的服务与链，另有各插件登记的检查项，有问题的写修法。
- **启动日志**：缺服务的插件记一行 warn「插件 "…" 依赖未满足，未激活：缺少服务 …」；只是在等的记一行 info「插件 "…" 在等依赖启动：等待 … 启动」。

几处的说法出自同一个判据，写法一致。插件之间怎么依赖，以记忆为例见[记忆由哪些插件组成](./memory.md)。

## 发第一条消息

在 CLI 聊天页直接打字回车，或在 WebUI 的聊天页发送。斜杠指令由 `plugin-commands` 统一处理：

| 指令 | 作用 |
|---|---|
| `/help` | 列出你能用的顶层指令（子指令折成计数；`/help <指令名>` 或在指令后加 `-h` 看详情与选项） |
| `/status` | 系统状态（哪些服务可用、注册了多少工具/指令） |
| `/doctor` | 系统诊断：失败与缺服务的插件各写原因（缺服务的写到根），以及各插件登记的检查项，有问题的写修法 |
| `/model` | 列出可用对话模型 |
| `/session` | 查看当前会话生效的模型 / 人设 |
| `/session.set -m <模型>` | 给当前会话换模型 |

没有显式配置模型时，agent 会自动选用第一个可用模型——机器上装了多个模型时，用 `/model` 看清单、`/session.set -m ...` 指定。想固定全局默认，配 `plugin-agent` 的 `defaultLLM`。

**发图片**：默认装的多模态媒体识别把收到的图片先存下，再交给能看图的模型识别，识别出的描述随消息交给主模型。没有能看图的模型时，图照样存下，这条消息另加一行 `[附了 N 张图，当前无法查看]`，模型知道有图、但看不到内容；`/doctor` 的 `service/media.vision` 报 warn 并写明怎么修：在模型服务里加一个能看图的模型，再到「多模态媒体识别」的「图像识别 → 识别模型」里选它（留空则自动选用）。

## 停止、数据与日志

- **停止**：CLI 里 `Ctrl+C`；或在聊天里 `/shutdown`。
- **数据**：都在家目录 `home/` 里：`home/state/`（SQLite 库、向量库、会话、附件、checkpoint、WebUI 凭据等）、`home/self/`（人设与技能）、`home/stage/`（白纸成品与发布的作品）、`home/tmp/`（临时文件），`home/workspace/` 是文件工具的默认工作根。`home/` 整个在生成的 `.gitignore` 里。
- **完整日志**：`home/logs/latest.log`，即使 CLI 接管了终端也照常写。每次启动时上一轮的日志改名为 `home/logs/latest.1.log`，更早的依次后移，保留最近 5 轮（`latest.1.log` 到 `latest.5.log`），再早的删除；`/restart` 与市场更新引起的重启也各算一次启动。要跨重启持续跟随日志，用 `tail -F`：`tail -f` 跟的是文件本身，改名后停在 `latest.1.log` 上。

## 下一步

- 装不上、起不来、登录不了：[安装与启动排障](./troubleshooting.md)
- 记忆靠哪些插件、缺一环时怎么显示：[记忆由哪些插件组成](./memory.md)
- 配置项与插件清单：[脚手架上手指南](./scaffolding.md)
- 权限、owner 与工具暴露面：[安全模型](../concepts/security-model.md)
- 管理界面能做什么：[plugin-webui-server](../plugins/plugin-webui-server.md)
- 自己写一个插件：[第三方插件开发者指南](./third-party-plugin.md)
