# 第一次运行

> 承接[脚手架上手指南](./scaffolding.md)：项目已经建好、`npm install` 已经跑完。
> 这一页讲**从 `npm start` 到第一次成功对话**之间的事：要准备什么、启动后看到什么、怎么发第一条消息、怎么换模型、怎么停。

## 你需要准备什么

**运行环境**：Node.js >= 22（与 CI 一致）。

**API key**：`standard` 档（也就是 `--yes` 的默认档）会装上三个需要 key 的插件：

| 插件 | 用途 | 没有 key 会怎样 |
|---|---|---|
| `@aalis/plugin-llm-deepseek` | 对话模型 | 插件转 error 态，实例没有可用 LLM；发消息会收到一条 `[系统] …LLM 插件激活失败…` 的提示 |
| `@aalis/plugin-embedding-openai` | 向量记忆的嵌入 | 插件转 error 态，连带 `plugin-memory-vector` 一直等待依赖、向量记忆不工作 |
| `@aalis/plugin-websearch-serper` | 联网搜索 | 插件转 error 态，搜索工具不可用 |

插件激活失败**不会中断启动**——进程照常起来，日志里留下 `插件 "..." 激活失败: ...` 的 ERROR。聊天里收到 `[系统] …激活失败…` 开头的回复就是这种情况，多半是没填 key；`/doctor` 可看完整清单。

把 key 填进项目根的 `aalis.config.yaml`（该文件已在生成的 `.gitignore` 里，不入库）：

```yaml
plugins:
  "@aalis/plugin-llm-deepseek":
    apiKey: "sk-..."
```

### 零 key 起步：用本地 Ollama

不想先买 key，可以全走本地模型（需要本机已安装并运行 [Ollama](https://ollama.com)）：

```bash
npm install @aalis/plugin-llm-ollama
```

装上重启即可——它默认连 `http://localhost:11434`，不需要任何 key，会把本机已有的对话模型注册为可选模型（`/api/show` 只报 embedding 能力的模型不会进列表）。

嵌入（向量记忆所需）装 `@aalis/plugin-embedding-ollama`，但它和对话模型不同：**默认模型 `nomic-embed-text` 必须自己先拉下来**，否则每次向量索引都会失败。

```bash
ollama pull nomic-embed-text
npm install @aalis/plugin-embedding-ollama
```

对话模型是「发现本机已有的」，嵌入模型是「用配置里指定的那一个」——机器上没有就一直 404。这种「服务在、但每次调用都失败」的状态用 `/doctor` 看（会报 `service/embedding.ollama` 不可用），`/status` 只判服务是否注册、看不出来。

换用别的嵌入模型改这一项：

```yaml
plugins:
  "@aalis/plugin-embedding-ollama":
    model: "你已经 pull 下来的嵌入模型"
```

> 在**已经运行**的实例上装插件需要重启；若经 WebUI 的「插件市场」页安装，则由市场流程自动完成发现，无需手动重启。

## 启动

```bash
npm start
```

### 终端：CLI 会接管整个屏幕

`plugin-cli` 在启动完成后进入全屏界面，启动日志会被收进日志页。常用按键：

| 按键 | 作用 |
|---|---|
| `Ctrl+T` | 切到聊天页 |
| `Ctrl+L` | 切到日志页（**启动日志、报错都在这里**） |
| `Ctrl+S` | 切到状态页 |
| `Ctrl+G` | 快捷键帮助 |
| `Ctrl+C` | 退出程序 |

> stdin/stdout 任一不是 TTY（日志重定向、容器、systemd）时不接管终端，日志照常打到控制台。

### 浏览器：WebUI 需要 token

WebUI 默认监听 `http://127.0.0.1:3000`，并且**需要 token 登录**。token 只写在文件 `data/webui/access.txt`（含完整的一键登录链接）。

启动日志出于安全**不打印 token 本身**——它只给出该文件的绝对路径（「访问凭据已写入: …」那行，CLI 里按 `Ctrl+L` 看）。

本机启动时默认会自动用带 token 的链接打开浏览器（`autoOpen`）；SSH / 容器 / 远程访问时把它关掉，手工复制链接即可。

> **持有 token 的人等同 owner**。把 `host` 改成 `0.0.0.0` 对外暴露之前，先读 [plugin-webui-server 的「登录身份与权限」](../plugins/plugin-webui-server.md)。

## 发第一条消息

在 CLI 聊天页直接打字回车，或在 WebUI 的聊天页发送。斜杠指令由 `plugin-commands` 统一处理：

| 指令 | 作用 |
|---|---|
| `/help` | 列出顶层指令（子指令折成计数；`/help <指令名>` 看详情与选项） |
| `/status` | 系统状态（哪些服务可用、注册了多少工具/指令） |
| `/doctor` | 系统诊断（含插件 error / pending 清单） |
| `/model` | 列出可用对话模型 |
| `/session` | 查看当前会话生效的模型 / 人设 |
| `/session.set -m <模型>` | 给当前会话换模型 |

没有显式配置模型时，agent 会自动选用第一个可用模型——机器上装了多个模型时，用 `/model` 看清单、`/session.set -m ...` 指定。想固定全局默认，配 `plugin-agent` 的 `defaultLLM`。

## 停止、数据与日志

- **停止**：CLI 里 `Ctrl+C`；或在聊天里 `/shutdown`。
- **数据**：项目目录下的 `data/`（SQLite 库、会话、人设、技能、WebUI 凭据等），`workspace/` 是文件工具的默认工作根。`data/` 已在生成的 `.gitignore` 里；`workspace/` **不在**，需要的话自己补一行。
- **完整日志**：`data/latest.log`，即使 CLI 接管了终端也照常写。

## 下一步

- 配置项与插件清单：[脚手架上手指南](./scaffolding.md)
- 权限、owner 与工具暴露面：[安全模型](../concepts/security-model.md)
- 管理界面能做什么：[plugin-webui-server](../plugins/plugin-webui-server.md)
- 自己写一个插件：[第三方插件开发者指南](./third-party-plugin.md)
