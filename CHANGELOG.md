# Changelog

本文件只记录**破坏性变更与迁移路径**。逐包的完整改动见 git 历史。

版本号语义：core 在 1.0 之前，次版本（`0.x.0`）可含破坏性变更并在此列出迁移路径；
补丁版本（`0.x.y`）只做修复与加法。1.0 之后按标准 semver，稳定性条款见
[`docs/design/core-contract.md`](docs/design/core-contract.md)。

---

## 未发布

### llm-openai / embedding-openai / llm-deepseek：baseUrl 语义改为「完整前缀」

插件不再向 baseUrl 硬拼 `/v1`，只拼端点名（`/chat/completions`、`/models`、`/embeddings`）。
与 plugin-asr-openai 的既有约定对齐；Gemini 等无 `/v1` 段的兼容端点
（`https://generativelanguage.googleapis.com/v1beta/openai`）从此可直接配置。

**迁移**（注意：config-sync 会在启动时把默认值物化进配置文件，所以不存在"未配置 baseUrl"的
存量部署——所有跑过旧版的配置文件里都已写着旧默认值）：
- llm-openai / embedding-openai：配置值恰为旧默认 `https://api.openai.com` 的，插件启动时
  **自动就地升级**为 `https://api.openai.com/v1` 并打 warn，无需手动迁移；
  自定义端点（聚合网关等）需自行在末尾补 `/v1`（如 `https://gateway.example` → `.../v1`）。
- llm-deepseek：官方端点 `https://api.deepseek.com` 无需改动（无版本段形态本就是官方文档写法，
  `/models` 此前也不带 `/v1`）；指向第三方 `/v1` 网关的需在 `baseUrl` 补 `/v1`。

### mcp-client：桥接工具默认档位不再是 public

外部 MCP 工具此前默认 `public`（等级 0 可达）。现默认改为按工具注解分档：
自称只读（`readOnlyHint`）→ `sensitive`（等级 1）；有破坏提示或未声明 → `restricted`（等级 2）。
server 配置的 `visibility` 字段新增 `auto`（新默认）与 `sensitive` 两值。

**迁移**：需要恢复旧行为（群成员直接可用）的部署，在对应 server 配置里显式设
`visibility: public`；已显式配置 `public`/`restricted` 的不受影响。

### 授权身份（actor）贯穿工具调用链：委派/子任务/工作流不再匿名执行

`ToolCallContext` 与 `ExecutionGuardContext` 新增可选 `actor` 字段（语义同
`IncomingMessage.actor`）：等级裁决与 owner 自动确认跳过按 actor 评估；`platform`/`userId`
恢复**会话/物理**语义（定时任务归属、平台档继承、记忆平台域、confirm 通道选路不再被
发起者平台覆盖）。`delegate_to_session` / `create_subtask` / `send_to_subtask` /
workflow 的 agent 与 send_message 节点现在都会透传发起者授权身份。

**行为变化**：此前这些路径的目标回合以匿名（等级 0）执行；现在以**发起者等级**执行——
依赖"子任务/委派天然低权"的部署需注意。actor 只从执行上下文 snapshot，LLM 无法经
工具入参指定（防提权）；匿名发起者的目标回合仍为匿名。

### user-relation：consolidate「落笔核实况」不变量

真合并删除的节点不再被同 pass 的派生回写（embedding hash / summary / PageRank）复活；
层级判定落边收进唯一入口（端点活性 + 实时查重 + 走门面）。无迁移动作——存量僵尸节点与
重复边会在后续 consolidate 轮次中被正常清理/去重。

## 0.10.0

契约包大改名 + 四个包的破坏性变更。这批**必须显式升级**，装到一半会同时装进新旧两份
同一契约（各带一份 `declare module`，类型一旦分叉就撞 TS2717，且被 `skipLibCheck` 静默吞掉）。

### 契约包改名（30 个旧名已 `npm deprecate`）

命名从「按插件命名契约」改成「按类型分层」：契约是 `api-*`，纯数据 schema 是 `schema-*`，
提供者实现是 `plugin-<类别>-<厂商>`。

| 旧名 | 新名 |
| --- | --- |
| `@aalis/plugin-<X>-api`（25 个） | `@aalis/api-<X>` |
| `@aalis/plugin-config-api` | `@aalis/schema-config` |
| `@aalis/plugin-message-api` | `@aalis/schema-message` |
| `@aalis/plugin-{deepseek,openai,ollama}` | `@aalis/plugin-llm-{deepseek,openai,ollama}` |

**迁移**：包名整体替换即可，导出符号未变。两个例外——

- `plugin-cron-engine-api` 是**拆包不是纯改名**：`CronEngine` / `useCronEngine` /
  `CronSubscribeOptions` 去了 `api-cron-engine`，但 6 个纯函数 + 2 个类型
  （`validateCronExpr` / `normalizeCronExpr` / `matchesCron` / `parseCronField` /
  `parseEverySeconds` / `dateFieldsInTimeZone` / `CronExprKind` / `ValidateResult`）
  去了新包 `@aalis/util-cron`。用到这些的要装两个包。
- **配置里的 LLM 模型引用要一起改**。`ref.provider` 存的是插件包名，`resolveLLMModel`
  拿它拼 `${provider}/${model}` 精确匹配，改名后旧 ref 一律落空。已持久化的会话级模型
  设置（WebUI 会话、`/session set -m`）也存着这个值，配置文件改完不代表会话跟着改。
  症状是「配置指向的模型不存在：<provider>/<model>」，服务其实注册得好好的。

### 破坏性变更

- **`@aalis/core` 0.10.0** —— `ServiceTypeMap` 现在字面为空，扩展点全部靠 `-api` 包的
  declaration merging 填。影响两处：① `ctx.getService('app')` 这类裸调用退化到
  `<T = unknown>` 兜底重载，要显式写类型参数；② 第三方插件的 `getService` 返回类型
  第一次真正受检——此前 core 内部一个相对说明符的 `declare module './services.js'`
  把接口绑到了第二个符号上，所有 `-api` 包的 augmentation 静默失效。修复后原本
  「能编过」的错误用法会开始报错。**只有裸说明符 `declare module '@aalis/core'` 是安全的。**
- **`@aalis/runtime` 0.10.0** —— 删除配置文件里的 `${VAR}` 环境变量插值与 `.env` 机制。
  密钥直接写进配置（配置文件本就不入库）。**这条是本批走 minor 而非 patch 的关键**：
  按 patch 发的话存量 `^0.9.0` 会自动吃到，配置里的 `${OPENAI_API_KEY}` 会变成
  字面量字符串直接发给上游。
- **`@aalis/plugin-authority` 0.10.0** —— ① `restrictedPolicy` 白名单不再救非 owner：
  它此前在「未授权救援」路径上跨身份生效，被封禁的负等级用户也能被捞回来；
  ② 降权即撤销该用户已有的会话级授予，不再等其自然过期。
- **`@aalis/plugin-webui-client` 0.10.0** —— `Operation` 要求 `minLevel`，必须与
  `plugin-authority` 同批升级。

### 其它

- `@aalis/plugin-package-manager` 的 core peer 下界抬到 `>=0.10.0`：它调用
  `restart({ rollback })`，而 0.9.x 的 `restart()` 不收参数、静默丢弃——市场更新失败后
  不会回滚，起来的是坏版本。

---

## 0.9.1

安全收紧与遗留清理。11 个包，其中 7 个有用户可见的行为变化——**权限收紧修的是非预期
的默认值，不是功能变更**，故走 patch。

### 安全（都是「默认 public」这个坑的实例）

- **`/clear` 的保护此前完全失效**：它原先挂在配置键 `visibilityOverrides` 上，该键在权限
  重构中失效（全仓零处读它），而指令注册时无任何 risk/visibility 声明 → 按默认落到等级 0。
  结果是任意 level-0 群成员可清空会话的消息/摘要/向量/图片。现按会话归属分场景：
  私聊 `confirm` 即可（会话归用户本人，清自己的记忆是自助行为），群/频道需等级 2 或 owner。
- **`/clear.all`** 从 `visibility:'restricted'` 改为 `risk:'dangerous'`——原写法拿到了等级 2
  但**漏了确认**，dangerous 一档同时推出两者。
- **`/authority`** 标 `risk:'sensitive'`（会披露他人权限等级）。
- **`plugin-subtask` 的 create/send_to/delete** 标 `sensitive`：每个子任务是一条独立的 LLM
  会话链，不受信任的调用方可连续调用放大 API 开销。只读的 check/wait 保持 public。
- **`plugin-tool-browser` 的 navigate/click/type/close_page** 标 `sensitive`：页面池是进程级
  共享 Map、取页时不校验会话归属，拿到 pageId 就能操作他人（含 owner）已登录的页面。
  只读的 get_text/get_links 保持 public。

新增 `test/plugins/tool-policy-guard.test.ts` 与 `clear-authorization.test.ts`：读**生效策略**
而非源码文本（防护机制异构，只有生效值可信），正反双向钉住——写类退回 public 会红、
只读被误伤也会红。

### 移除（均经对抗验证确认零消费面）

- session 配置的 legacy `model` / `llmProvider` 字段与其折叠逻辑（服务端 30 行 + 前端 13 行）
- `plugin-skills` 的 `skillsDir` → `skillsUri` 迁移分支
- `plugin-file-reader` 的 `fileRetentionMinutes` 配置项（schema 自身已标【已弃用】）
- `plugin-user-relation` 的 `MergeRejectRecord.aReinforcedAt` / `bReinforcedAt` 及孤儿方法
  `listMergeRejects`
- `plugin-webui-client` 中 `SessionConfigData` 的重复定义

### 文档

README 与脚手架模板里「core 在 0.x 内承诺向后兼容」的表述作废（0.7.0 / 0.9.0 均删过公开面）；
`core-contract.md` 增「1.0 之前的实况」一节列出删除清单与版本号语义。

## 0.9.0

本批 58 个包统一版号 `0.9.0`（未改动的包停在原版号）。**升级 core 必须同批升级
runtime 与所用插件**——兼容单位是整组。

### 破坏性变更

**`@aalis/core` 删除的公开面**

| 删除 | 替代 |
|---|---|
| `CORE_CONFIG_SCHEMA`、`ConfigSchema`、`SchemaField`、`SchemaFieldType`、`SchemaFieldTypes`、`SchemaGroup`、`SchemaArray` | 全部迁至新包 `@aalis/plugin-config-api`，import 改指该包 |
| `ctx.hasService(name)` | `ctx.getService(name) !== undefined` |
| `ctx.getServiceEntries(name)` | `ctx.getAllServices(name)`（返回项现含 `priority`） |
| `ctx.once(event, fn)` | `const off = ctx.on(e, (...a) => { off(); ... })` |
| `PluginManager.createInstance` / `removeInstance` | `register(module, config, instanceId)` + `unload(instanceId)` 组合；配置文件编排由调用方负责 |
| `ServiceContainer.has` | `get(name) !== undefined` |
| `EventBus.removeAll` | 无替代（绕过 dispose 链的所有权账本，刻意移除） |
| `ConfigManager.syncPluginDefaults`、`ConfigManager.trimUnknownFields`、`AppOptions.configSync` | 迁至 `@aalis/runtime` 的 `syncPluginDefaults` / `installConfigHotReload`；`startAalis({ configSync })` |

`PluginStatusEntry` 不再携带 `config` / `configSchema` / `defaultConfig`——它们是配置详情
不是内核状态，改由 `getPlugin(instanceId)` 从 `entry.config` / `entry.module` 读取。

**契约包删除的 helper**（均为 `ctx.getService` 的一行包装，无附加语义）：
`@aalis/plugin-asr-api` 的 `useASRService`、`@aalis/plugin-media-api` 的 `useMediaService`、
`@aalis/plugin-workflow-api` 的 `useWorkflowService`。直接用 `ctx.getService('asr' | 'media' | 'workflow')`。
（包名是当时的；这三个契约包后来分别改名为 `@aalis/api-asr` / `api-media` / `api-workflow`。）

**`declare module` 目标变更**：向 `SchemaField` / `SchemaFieldTypes` 做 declaration merging 的
包，目标从 `'@aalis/core'` 改为 `'@aalis/plugin-config-api'`。**merging 到旧目标不会报错，
只会静默失效**，务必检查。

### 新增

- **新包 `@aalis/plugin-config-api`**：配置表单词汇（`ConfigSchema` 全家 + `SchemaFieldTypes`
  扩展点 + `CORE_CONFIG_SCHEMA`）。零依赖纯类型包。依赖它请用宽区间
  `>=0.9.0 <1.0.0` 而非 caret——0.x 的 caret 锁死 minor，会在加词汇时强制全生态级联重发。
- **第四内核原语「贡献点」**：`ctx.contribute(point, spec)` / `ctx.collect(point)`。
  多方向同一产物各交一块，内核保证 id 幂等、`(槽, 全局键)` 确定性排布、单块错误隔离，
  且**从不执行插件代码**。首个贡献点 `agent:prompt`（提示词组装）。
- **`ctx.hooks` 摊平为 `ctx.runHook(hook, data, defaultAction?, opts?)`**：六动词对称
  （on/emit、provide/getService、middleware/runHook），不再发布可持有的对象句柄。
- **可等待的异步 dispose**：`ctx.disposeAsync(timeoutMs?)`，`onDispose` 返回的 promise
  真正被等待（逐项超时护栏防卡死停机）。已有拆卸在飞时 join 而非早退。
- **前缀缓存命中上报**：`ChatResponse.usage.cachedPromptTokens`（DeepSeek 的
  `prompt_cache_hit_tokens` / OpenAI 的 `prompt_tokens_details.cached_tokens`）。
  `undefined` = 不可知，`0` = 明确无命中，勿用 `?? 0` 抹平。

### 修复

- **自动摘要压缩静默失效**：历史探测条数曾写死 200 并兼作阈值判定样本，导致
  `threshold > 200` 的配置下压缩分支永不进入、零日志。改为由配置推导且保留原下限。
- **停机竞态**：`App.stop()` 撞上在飞的 bounce/unload 时，shutdown 请求被单飞排队后立即
  返回，拓扑逆序编排落空，下游插件的落盘可能写进已关闭的连接。现在先等状态机静置。
- **贡献点两条守卫**：已 dispose 的 Context 上 `contribute` 被拒（否则会顶掉同 id 活实例的
  条目并被连带删除）；退订时摘除登记表条目（否则动态 id 场景无界增长）。
- **流式 usage 丢失**：`if (!delta) continue` 排在 usage 提取之前，导致挂在 `choices: []`
  收尾帧上的 usage 整帧被跳过。两家适配器均已修正顺序。

### 升级须知

1. **只升 core 不升 runtime 会静默丢三项**：`aalis.config.yaml` 的 defaultConfig 回填、
   schema 外字段裁剪、配置文件热重载。不报错、不崩、插件功能正常，但配置文件不再被维护。
2. **旧插件 + 新 core 会炸**：以下已发布版本调用了被删 API，需同批升级到 0.9.0——
   `plugin-webui-server@0.5.2`（加载期失败）、`plugin-tool-system@0.5.2`、
   `plugin-session-manager@0.5.3`、`plugin-office@0.5.0`（三者激活期失败）、
   `plugin-commands@0.5.4`、`plugin-media@0.5.3`（运行期失败）。
3. **第三方插件**：core peerDep 建议写 `>=0.9.0 <1.0.0`（若用了 0.9 新 API）。
   本仓禁用 caret——`^0.x` 只匹配单个次版本，会把插件锁死。
4. **1.0 之前 core 的公开面可能在次版本被删**（0.7.0 与 0.9.0 均已发生）。宽 peerDep 区间
   只是「没用新 API 的插件不必随次版本重发」的便利，不是兼容性承诺。
