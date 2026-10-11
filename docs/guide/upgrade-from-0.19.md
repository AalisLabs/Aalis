# 从 0.19 升级已有项目

本页面向用 `npm create aalis` 生成、还在 core 0.19 上的独立 npm 项目（create-aalis 0.6 及以前生成的，项目目录里直接放着 `aalis.config.yaml` 与 `data/`），讲怎样升到 core 0.20。0.20 起实例的配置、密钥、数据与日志都在家目录里，确认工具调用改由会话服务请 owner 审批，几个插件的配置换了位置；旧项目要改入口文件、搬目录、改配置，并把全部 `@aalis` 包同一批换掉。

下面的步骤按顺序做，全部做完之后才第一次用新版启动。命令按 macOS 与 Linux 的 shell 写，都在项目目录里执行；Windows 在 Git Bash 里执行。`npm ls @aalis/core` 可以查看项目现在的版本：低于 0.19.1 的，先按 [配置迁移](./config-migration.md) 检查作用域等写法；还在 0.18 或更早的，先按 CHANGELOG 里对应各节升到 0.19。

::: danger 先别做这几件事
下面几种做法都会把项目升成一半新一半旧的组合，起不来或大半功能失效：

- **不要单独跑 `npm update`，也不要删掉 `node_modules` 与 `package-lock.json` 重装**。已发布的旧版插件对契约包写的依赖范围是 `>=x <1.0.0`，会取到 0.20 的新版契约包，作为嵌套副本装在各个旧插件下面；npm 对嵌套依赖的 peer 冲突只告警（几百行 `npm warn ERESOLVE overriding peer dependency`），退出码仍是 0。启动后十几个插件加载失败，另有一批激活失败，WebUI、记忆与网关都起不来：

  ```text
  ERROR aalis 加载插件 "@aalis/plugin-agent" 失败: ...
  SyntaxError: The requested module '@aalis/api-storage' does not provide an export named 'createStorageGateway'
  ```

  `@aalis/api-process` 的 `createProcessGateway` 同样报这一句；激活失败的一批报 `TypeError: Object prototype may only be an Object or null: undefined`。
- **不要只升 `@aalis/core`**。包管理器不会拦下这次安装，旧版 runtime 一启动就退出，一个插件都不加载：`Aalis 启动失败: TypeError: host.provide is not a function`。
- **不要只升 core 与 runtime、不改入口文件**。新版 runtime 不再从启动目录读配置，旧入口文件又没告诉它项目在哪，家目录落到 `~/.aalis`，提示「家目录还没有初始化」并让你加 `--init`；照做得到的是 `~/.aalis` 里一个空的新家目录，不是这个项目。
- **不要用旧版 WebUI 的插件市场更新到新版**。勾上内核与全部插件一起更新时，更新接口先回「已更新」，新进程因为旧入口文件没传 `appDir`、`defaultHome` 而起不来，几分钟后回滚到旧版，原因只在控制台里；用户主目录下恰好有初始化过的 `~/.aalis` 时，新进程会去起那个家目录。

已经这样做了的，停掉实例，从下面第 1 步开始做；第 2 步把依赖树整个换成同一批的新版本。
:::

## 要先确认的

- **Node 24.15.0 起**：`node -v` 查看。0.20 的 SQLite 记忆后端改用 Node 自带的 `node:sqlite`，Node 低于这一版时它激活失败。升级方法见 [升级 Node](./first-run.md#upgrade-node)。在 Node 22 上运行的项目先换 Node 再升级；换了 Node 之后旧版 SQLite 记忆后端的原生模块版本不符，随本次升级换掉即可，不用重新编译。
- **第三方插件**：`package.json` 里有不是 `@aalis/` 开头的插件的，确认它已经发布了支持 core 0.20 的版本（它的 `peerDependencies` 里 `@aalis/core` 的下限是 `0.20.0`）。还没有的先 `npm uninstall` 卸掉，等作者更新；旧版第三方插件配 core 0.20 加载或激活就失败。作者的改写方法见 [插件作者指南](../plugin-author-guide.md) 的「从 0.19 迁移」。
- **环境变量**：运行 Aalis 的环境里不要设 `AALIS_HOME` 或 `AALIS_PROFILE`，它们优先于入口文件里给的家目录。

## 1. 停止并备份

停掉实例：前台运行的在终端里按 Ctrl+C，以服务运行的停掉服务。然后整体复制项目目录，`node_modules` 与 `package-lock.json` 一起留着，回滚时原样放回即可：

```sh
cd ..
cp -a my-bot my-bot.bak-0.19
cd my-bot
```

## 2. 换包

```sh
npm uninstall @aalis/plugin-session-confirm
npm i $(node -p "Object.keys(require('./package.json').dependencies).filter(n => n.startsWith('@aalis/')).map(n => n + '@latest').join(' ')") @aalis/plugin-session-server@latest @aalis/plugin-reach@latest
```

- 第一条卸掉确认插件 session-confirm：它已经删除，确认工具调用改由会话服务的审批承担，它的旧版不能与新版权限插件共存。项目里没有它的，这一条什么都不改。
- 第二条把 `package.json` 里全部 `@aalis` 包一次升到最新，并新装两个插件：
  - `@aalis/plugin-session-server`（会话服务）：新 WebUI 的会话界面经它提供的会话协议连上服务端，没有它时 `/session` 以 1013「会话服务不在」关闭，会话界面整个不能用；需要确认的工具调用也由它请 owner 审批，没有它一律拒绝。
  - `@aalis/plugin-reach`（触及）：给本地工具按调用签发读写与执行的凭据，新生成项目的 standard 与 full 档都带它。这一版的工具还没有接入它，装上不改变现有工具的行为。项目里没有 `@aalis/plugin-tool-system` 的可以不装，从命令里去掉这一项。
- 装完核对：`npm ls @aalis/core` 退出码为 0，列出的全是同一个 0.20 版本，没有 `invalid`。
- `package.json` 里若有 `allowScripts` 放行 `better-sqlite3`，可以删掉这一项：新版 SQLite 记忆后端不再用它。

## 3. 改入口文件

把 `index.mjs` 整个换成：

```js
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAalis } from '@aalis/runtime';

const here = dirname(fileURLToPath(import.meta.url));
startAalis({ appDir: here, defaultHome: here }).catch(err => {
  console.error('Aalis 启动失败:', err);
  process.exit(1);
});
```

`appDir` 是安装集：从这个目录的 `package.json` 与 `node_modules` 找插件。`defaultHome` 是家目录：配置、密钥、数据与日志放在这里。这里把项目目录本身当家目录，`aalis.config.yaml` 与数据都留在原处，下一步只在目录里挪几处。新版脚手架生成的项目把家目录放在 `home/` 子目录里，旧项目不必照搬。

## 4. 按家目录的布局搬目录

```sh
mv data state
mkdir -p self
mv state/personas self/personas
mv state/skills self/skills
rm -rf workspace/.tmp
rm -f state/latest*.log
```

- `data/` 改名为 `state/`：存储根 `data` 现在指向家目录的 `state/`，配置与历史里 `data:/…` 的地址照常解析，数据库、检查点、WebUI 的登录 token、媒体缓存与定时任务都随之保留。
- 人设卡与技能搬到 `self/` 下，对应新的默认目录 `personas:/`、`skills:/`（见第 6 步）。`state/` 里没有 `personas` 或 `skills` 的，跳过对应那一行。
- 临时区改在家目录的 `tmp/`，`workspace/.tmp` 可以删掉；日志改写到 `logs/latest.log`，`state/latest*.log` 不再使用。
- `tmp/`、`cache/`、`logs/`、`run/`、`stage/` 在第一次启动时建出。`workspace/` 不动。

## 5. 改 .gitignore

实例数据现在分在几个目录里。在 `.gitignore` 里加上：

```text
state/
self/
stage/
tmp/
cache/
run/
logs/
secrets.yaml
```

`aalis.config.yaml` 照旧忽略。下次提交前先看一眼 `git status`，别把数据库、WebUI 的登录凭据与 `users.json` 提交进去。

## 6. 改配置文件

新版第一次启动时，配置同步按各插件的 schema 补上缺的默认值、裁掉 schema 以外的键，并整份重写 `aalis.config.yaml`，注释不保留。下面这些要在那之前改：不改的话，有的设置会丢，有的插件会读错目录。

### 必改的几处

**存储根**：`@aalis/plugin-storage-local` 的 `roots` 只留 `workspace` 与自己加的根。data、pluginData、tmp、cache、logs、personas、skills、workflows、paper、public 现在是内置根，按家目录的布局派生；配置里同名的项会被跳过并告警，它的 `path` 不再生效。脚手架生成的配置改完是：

```yaml
plugins:
  "@aalis/plugin-storage-local":
    roots:
      - name: workspace
        path: workspace
        label: Workspace
        kind: workspace
        browsable: true
        readable: true
        writable: true
        deletable: true
```

以前把 data、pluginData 或 tmp 指到别处的，先把那个目录搬到 `state/`、`state/plugins/` 或 `tmp/`；自己加的根用了上面十个名字之一的，改个名字。

**人设与技能的目录**：删掉 `@aalis/plugin-persona` 的 `personasDir`（旧值 `data/personas`）与 `@aalis/plugin-skills` 的 `skillsUri`（旧值 `data:/skills`），用新的默认值 `personas:/`、`skills:/`，即上一步搬到的 `self/personas`、`self/skills`。不删的话它们照旧去 `state/` 下找，读不到搬走的人设卡与技能。

**会话的默认配置**：`@aalis/plugin-session-manager` 不再有插件配置，平台档与全局默认改写在配置文件顶层的 `sessionConfig` 里。不搬的话旧的平台档不再生效，WebUI 与终端的会话只剩没有分组的工具，文件、命令等带分组的工具不再开放。脚手架生成的配置搬之前是：

```yaml
plugins:
  "@aalis/plugin-session-manager":
    platformProfiles:
      - platform: cli
        enabledToolGroups:
          - "*"
      - platform: webui
        enabledToolGroups:
          - "*"
    defaults: {}
```

删掉这一整段，在顶层（与 `plugins:` 同级）写：

```yaml
sessionConfig:
  platforms:
    cli:
      enabledToolGroups:
        - "*"
    webui:
      enabledToolGroups:
        - "*"
```

`platformProfiles` 的每一条写到 `sessionConfig.platforms.<平台>` 下，`persona`、`enabledToolGroups`、`disableOutputFormat`、`clientSideJsonRendering` 原样搬；`llm` 要 `provider` 与 `model` 都有才搬；`think` 删掉，按模型的默认档位，要固定档位的写那个平台所用模型的档位 id（DeepSeek 为 `off`、`high`、`auto`、`max`）。`defaults` 里的 `persona` 写到 `sessionConfig.defaults.persona`。各层的说明见 [plugin-session-manager](../plugins/plugin-session-manager.md#宿主配置里的三层)。

**已删除的确认插件**：配置里有 `@aalis/plugin-session-confirm` 一段的删掉，不删的话每次启动都告警「配置段 "@aalis/plugin-session-confirm" 对应的插件未找到，已忽略」。用过 `/auto` 的，配置文件顶层还有 `autoConfirmUntil`，它不再读取，一并删掉。

**用 MongoDB 记忆库的**：在 `@aalis/plugin-memory-mongodb` 下加 `claimFrom: unowned`。库里记着它归哪个家目录，旧库里已有数据、还没有归属记录，不写会拒绝激活；启动一次、日志里出现「记下归属」或「归属改到家目录」后删掉这一项。同时确认 `@aalis/plugin-memory-sqlite` 与 `@aalis/plugin-memory-inmemory` 在 `disabledPlugins` 里，否则认领失败时记忆会悄悄改由它们提供。

**WebUI 用固定 token 的**：`@aalis/plugin-webui-server` 的 `tokenMode` 是 `fixed` 时，`fixedToken` 去掉首尾空白后至少要 32 个字符，短了插件不启动。先换成更长的随机字符串。

### 换了位置的键

下面这些键在新版第一次启动时按 schema 裁掉并告警，值不再生效。要保留原来的效果，按右栏搬：

| 旧的键 | 搬到哪里 |
|---|---|
| plugin-agent 的 `historyLimit`（旧默认 50） | `sessionConfig.defaults.historyLimit`。它是一轮最多读进的历史条数，装了摘要插件时也是按条数压缩的线；不写时每轮读进全部活跃历史，只靠硬裁剪兜底 |
| plugin-memory-summary 的 `threshold` | 同上，写进 `historyLimit`。与 agent 的 `historyLimit` 都写过的，按想要的压缩时机取一个；`keepRecent` 没有对应 |
| plugin-memory-summary 的 `autoCompressThreshold` | 不换算。新的「自动压缩线」`compressAt` 按会话分层、在回合结束时判，默认 0.8，要改写在 `sessionConfig` 的相应层，不按用量压缩写 0 |
| plugin-agent 的 `maxToolIterations`（不是 30 时） | `sessionConfig.defaults.maxToolIterations` |
| plugin-persona 的 `persona`（不是 `default` 时） | `sessionConfig.defaults.persona`；与 session-manager 的 `defaults.persona` 都写过的，取 session-manager 的 |
| plugin-llm-deepseek 的 `thinkingMode`、`reasoningEffort` | `thinking`：`thinkingMode: disabled` 的写 `off`，其余按 `reasoningEffort` 写 `auto`、`high` 或 `max` |
| plugin-webui-server 的 `relationGraphDefaultSpacing` | plugin-user-relation 的 `graphSpacing` |
| plugin-asr-openai、plugin-asr-whisper-cpp 的 `priority` | 改过它、要让另一个转写后端优先的，写 plugin-media 的 `audio.prefer`（处理器名 `asr:<插件实例 id>`） |

另有两处不裁掉、但旧写法不再认，要改写：plugin-llm-ollama 的 `thinking: true` 改成 `on`、`false` 改成 `off`；plugin-llm-openai 的 `thinkingParam: false` 删掉，`true` 改写成 `thinking`，并在 `modelCapabilities` 里给经这个实例的思考模型加上 `thinking`。

下面这些键对应的功能已删除，不用搬，启动时同样裁掉并告警：plugin-memory-summary 的 `keepRecent`、`summaryPrompt`；plugin-user-profile 的自档案四项（`enableSelfProfile` 等）与行为指令六项（`enableInstructions` 等）；plugin-tool-session 的 `crossSessionEnabled`、`crossSessionDefaultTimeoutSec`；plugin-tool-system 的 `shell.defaultTimeout`、`shell.maxTimeout`（命令不再自带超时，等多久见 [plugin-tools](../plugins/plugin-tools.md) 的后台任务）；plugin-webui-server 的 `fileRoot`。另有几处不裁掉也不再生效，删掉：plugin-package-manager 的 `projectRoot`；`servicePreferences` 里按存储根设的 `storage` 偏好（值形如 `@aalis/plugin-storage-local/<根名>`）；平台档或会话配置的 `enabledToolGroups` 里的 `session-delegate`。

密钥不用手动搬：第一次启动时，配置文件里密钥字段上的明文自动移进家目录的 `secrets.yaml`（0600），原处换成引用 `{ $secret: "<键>" }`，见 [密钥配置](../core/config.md#密钥配置)。没装上或加载失败的插件，它的配置段不处理，明文原样留着（启动时逐段告警）：删掉这些段，或装好插件后再启动一次。

## 7. 第一次启动

```sh
npm start
```

日志第一行写 `Aalis Core 0.20.0`（补丁号以实际安装的为准），接着是「发现 N 个插件」。这一次会看到下面几类告警，都是正常的，各只在第一次启动出现：

```text
WARN  aalis 配置同步：@aalis/plugin-agent 裁掉 schema 外字段 [historyLimit, maxToolIterations]
WARN  aalis 配置同步：@aalis/plugin-llm-deepseek 裁掉 schema 外字段 [thinkingMode, reasoningEffort]
INFO  aalis 配置同步：已把 @aalis/plugin-llm-deepseek 的 apiKey 移进 secrets.yaml（键 @aalis/plugin-llm-deepseek.apiKey）
```

要填 key 而没填的插件照旧报 `ConfigError: 缺少配置项 apiKey`，与升级无关，填上即可。

### 确认升级成功

- 日志里没有 `加载插件 "…" 失败`。
- 打开 WebUI（端口与登录 token 都沿用原来的）：会话列表里有升级前的会话，点开能看到历史；新建一个会话发一条消息，能收到回复。
- 在 WebUI 或终端的会话里发 `/doctor`，或看 WebUI 的「运行状况」：失败与缺服务的插件只剩没填 key 的，以及依赖它们的（例如 embedding 插件没填 key 时，语义记忆缺 embedding 服务）；存储各根指向项目目录里的 `state/`、`self/` 等处。
- `aalis.config.yaml` 里密钥字段已换成 `$secret` 引用，`secrets.yaml` 在项目目录里，权限是 0600；`sessionConfig` 还在，插件配置里改过的值还在。

## 升级之后

**旧会话**：升级前的会话历史都在，可以接着聊。IM 的群与私聊不用处理，那个群或私聊下一条真人消息到达时补记来源；终端的会话在终端下一次说话时补记。升级前在 WebUI 里建的会话没有创建来源，按内部会话处理：在里面发起的回合不能产生审批，需要确认的工具调用一律拒绝，也不生成自动标题。要审批的事在新建的会话里做；要在某个旧会话里继续用审批，停掉实例后给它补上创建来源（会话 id 在 WebUI 地址栏 `/s/` 之后）。用 SQLite 记忆库的：

```sh
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('state/aalis.db');
const read = db.prepare(\"SELECT data FROM metadata WHERE namespace = 'sessions' AND key = ?\");
const write = db.prepare(\"UPDATE metadata SET data = ? WHERE namespace = 'sessions' AND key = ?\");
for (const id of process.argv.slice(1)) {
  const row = read.get(id);
  if (!row) { console.error('没有这个会话：' + id); continue; }
  write.run(JSON.stringify({ ...JSON.parse(row.data), createdFrom: 'webui' }), id);
}
" <会话 id> [<会话 id> ...]
```

`state/aalis.db` 是 SQLite 记忆库的默认位置，改过 `path` 的换成实际的文件。用 MongoDB 的，在库里的 `metadata` 集合找 `namespace` 为 `sessions`、`key` 为会话 id 的文档，给它的 `data` 加上 `createdFrom: "webui"`。旧记录里的 `createdBy` 不再读取，留着无妨。

**密钥与备份**：从此备份要连同 `secrets.yaml`；只恢复 `aalis.config.yaml` 时引用落空，用到这些密钥的插件激活失败，`/doctor` 的 `config.secrets` 会点名缺的键。移走之前的明文仍在第 1 步的备份、编辑器的备份文件与同步盘的历史版本里，确认升级无误后删掉；配置文件进过 git 的，历史里也有明文，应当轮换这些密钥。

**回滚**：停掉实例，把项目目录换回第 1 步的备份。换过 Node 的，旧版 SQLite 记忆后端的原生模块是按原来的 Node 编译的，在旧目录里执行 `npm rebuild better-sqlite3`。
