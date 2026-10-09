# 安装与启动排障

> 装不上、起不来、登录不了时按这一页查。脚手架与插件市场的报错里写的「安装排障」就是这一页。
> 实例起来了、某些插件没起来（「需要处理」里的失败、缺服务、待配置）怎么看，见[第一次运行](./first-run.md#开始使用与需要处理)。

## 先看哪里

| 在哪 | 有什么 |
|---|---|
| 脚手架或插件市场的报错 | `npm install` 失败时认出的原因与修法，各类见下文「`npm install` 失败」 |
| npm 的完整日志 | 脚手架报错里「npm 的完整日志：」那一行给出路径（在 npm 缓存目录的 `_logs/` 下，npm 打印了日志位置时才有这一行）；经插件市场安装时，npm 的整段输出记在 Aalis 的日志里（`npm install … 失败:` 那一行） |
| `home/logs/latest.log` | Aalis 的完整日志，CLI 接管终端时照常写。终端里按 `Ctrl+L` 看，WebUI 在「运行状况」的日志标签 |
| `/doctor` | 失败与没起来的插件逐个写原因与修法，以及各插件登记的检查项（如识图 `service/media.vision`、Ollama Embedding 的 `service/embedding.ollama`）。在 CLI 或 WebUI 的聊天里输入；也可以在项目目录执行 `npm start -- doctor`，在一次性的进程里诊断完就退出，不占 WebUI 的端口、不连聊天平台 |

## Node 版本

Aalis 要 Node.js 24.15.0 起。`npm create aalis` 一开头检查版本，不够就退出并给出升级步骤的地址；已有项目在旧 Node 上运行时，`/doctor` 的 `env.node` 报 error，Node 22.16 之前或 23.x 上 SQLite 记忆还会激活失败，报错写明当前版本。升级步骤见[第一次运行的「升级 Node」](./first-run.md#upgrade-node)。

## `npm install` 失败

`npm create aalis` 装依赖失败时，按 npm 的报错认出下面几类，写明原因、修法、重试命令与 npm 日志的位置；认不出的写「原因见上面 npm 的报错」。插件市场的安装、更新与卸载认同样几类，回执里只写原因与修法。

### 网络与源

报错含 `ENOTFOUND`、`ETIMEDOUT`、`ECONNRESET`、`ECONNREFUSED` 或 `EAI_AGAIN`：连不上 npm 源。检查网络与代理设置后重试；默认源不通时换一个能访问的源，再重新安装：

```bash
npm config set registry <源地址>
npm install
```

`npm config get registry` 查看当前用的源。脚手架查插件版本与插件市场检索默认用官方源，与 `npm install` 用的源分开：脚手架用 `--registry <源地址>` 指定，市场检索在 WebUI 服务端的 `marketplaceRegistry` 里改（不少镜像不支持检索接口，检索不到时市场只列已装的包，并在页面上写明）。

### 源上没有这个包或版本

报错含 `E404` 或 `ETARGET`：源上找不到这个包，或没有要的那个版本。核对包名与版本；用的是镜像源时，刚发布的版本可能还没同步过来，稍后重试或临时换回官方源。

### 没有写入权限

报错含 `EACCES`：npm 没有权限写项目目录、npm 缓存或全局目录。不要用 `sudo` 重试，那样装出来的文件归 root 所有，之后的每次安装都会撞上同样的错。把目录改回当前用户所有：

```bash
npm config get cache                 # npm 缓存目录
sudo chown -R "$(whoami)" <目录>      # 项目目录或上面查到的缓存目录
```

报的是全局目录时，改用 nvm 装的 Node（全局目录在用户主目录下），或执行 `npm config set prefix ~/.npm-global` 把全局目录挪到用户主目录。经插件市场安装时，「当前用户」是运行 Aalis 的那个用户。

### 磁盘空间不够

报错含 `ENOSPC`：腾出空间后重试。npm 缓存可以用 `npm cache clean --force` 清掉。

### 平台不支持

报错含 `EBADPLATFORM`：某个依赖不支持这台机器的系统或 CPU 架构，报错里写着是哪个包。`npm ls <包名>` 查是哪个插件带进来的；建项目时加 `--advanced` 重新生成，换掉那个插件。经插件市场安装时，这个插件在这台机器上装不了。

### 依赖版本冲突

报错含 `ERESOLVE`：npm 解不开依赖版本。新生成的项目里不该出现，请把 npm 的日志附进[问题报告](https://github.com/AalisLabs/Aalis/issues)。

经插件市场安装时是 peer 依赖冲突，回执逐条列出谁要哪个版本。多半是插件要的 `@aalis/core` 与实例里装的不相容：先在市场里更新内核与相关插件，或换一个支持当前内核版本的插件版本。市场安装不沿用项目 `.npmrc` 里的 `legacy-peer-deps`，冲突不会被放过去。

### 下载浏览器失败

用到浏览器的插件（浏览器工具、绘图）装的时候要下载 Chrome，下载不下来时报 `Failed to set up chrome`。设好镜像地址后重新安装：

```bash
PUPPETEER_CHROME_DOWNLOAD_BASE_URL=<镜像地址> \
PUPPETEER_CHROME_HEADLESS_SHELL_DOWNLOAD_BASE_URL=<镜像地址> \
npm install
```

也可以先不装这些插件：从 `package.json` 的 `dependencies` 删掉它们再 `npm install`（`npm ls puppeteer` 查是哪几个）。经插件市场安装时，把这两个环境变量设给运行 Aalis 的进程，重启后再装。

### 原生模块编译失败

报错含 `gyp ERR!`、`node-gyp` 或 `prebuild-install`：某个依赖没有这个平台的预编译件，要在本机编译，而本机缺 C/C++ 编译工具。装上编译工具后重试：

| 系统 | 装什么 |
|---|---|
| macOS | `xcode-select --install` |
| Linux | `build-essential` 与 `python3`（按发行版的包名） |
| Windows | Visual Studio 的「使用 C++ 的桌面开发」 |

或者建项目时加 `--advanced`，换掉用到这个依赖的插件（`npm ls <包名>` 查是哪个）。默认装的插件都不需要编译。

## Intel Mac 与 LanceDB

LanceDB 向量库只有 macOS（Apple 芯片）、Linux（x64、arm64）与 Windows（x64、arm64）的预编译件，Intel Mac 上装不上。`npm create aalis` 在这样的机器上不列 LanceDB，full 档也不装它；语义记忆用 Flat 向量库（零依赖，脚手架的默认）。已经装了 LanceDB 的项目在 Intel Mac 上换成 Flat：

```bash
npm uninstall @aalis/plugin-vectorstore-lancedb
npm install @aalis/plugin-vectorstore-flat
```

两个向量库的数据不通用，换了之后语义记忆从空开始积累。

## WebUI 打不开：端口被占

WebUI 默认监听 `127.0.0.1:3000`。端口被别的程序占着时，WebUI 起不来、其余功能照常，日志里有一行：

```text
WebUI 监听 127.0.0.1:3000 失败: listen EADDRINUSE: address already in use 127.0.0.1:3000；WebUI 不可用，其余功能照常运行
```

查是谁占着：macOS 与 Linux 执行 `lsof -nP -iTCP:3000 -sTCP:LISTEN`，Windows 执行 `netstat -ano | findstr :3000`。停掉那个程序，或给 WebUI 换一个端口，写进 `home/aalis.config.yaml`：

```yaml
plugins:
  "@aalis/plugin-webui-server":
    port: 3001
```

保存后宿主热重载配置，WebUI 按新端口监听。另一个 Aalis 实例（用另一个家目录）同样会占端口，两个实例要各用各的端口。

## 登录要的 token 在哪

WebUI 要 token 登录。一键登录的链接写在家目录的 `state/webui/access.txt`（脚手架生成的项目里是 `home/state/webui/access.txt`），启动日志里「访问凭据已写入」那一行给出它的完整路径；日志本身不打印 token。把文件里「一键登录」那一行的链接粘进浏览器，或在登录页粘贴「Token」那一行的值。

- 默认的 `tokenMode: persist` 把 token 存在 `state/webui/token`，重启沿用；要换一个新的，删掉这个文件后重启。
- `ephemeral` 每次启动换一个新的，只写在 `access.txt` 里。
- `fixed` 用配置项 `fixedToken`（至少 32 个字符）；它是密钥字段，启动后值存在家目录的 `secrets.yaml` 里（配置文件里是引用），`access.txt` 里同样写着。
- `access.txt` 写不进去时，日志写「访问凭据未能写入」：修好家目录 `state/webui/` 的写权限后重启；或改用 `fixed`，在 `fixedToken` 里填一个 token，用它登录。

持有 token 的人等同 owner。对外暴露之前先读 [plugin-webui-server 的「登录身份与权限」](../plugins/plugin-webui-server.md)。

## 卸载之后留下的配置段

`npm uninstall` 一个插件、或在插件市场里卸载（默认不勾「同时删除配置」）之后，它在 `aalis.config.yaml` 里的配置段与引用的密钥都留着，重新装上就按原来的配置启动。之后每次启动，日志对每个这样的段告警一次：

```text
配置段 "@aalis/plugin-xxx" 对应的插件未找到，已忽略；若已卸载可删除该段（其中可能含密钥）
```

不再用了就手动删掉：删 `home/aalis.config.yaml` 里 `plugins` 下的那一段；段里写成 `{ $secret: "<键>" }` 的密钥值在 `home/secrets.yaml` 里，没有别的段引用同一个键时一并删掉（手改文件不会触发宿主清理没人引用的密钥）。在插件市场卸载时勾上「同时删除配置（含 N 个密钥）」，宿主会删掉配置段与只有它用的密钥。
