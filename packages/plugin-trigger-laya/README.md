# @aalis/plugin-trigger-laya

Laya 触发判定：[`trigger` 服务](../../docs/services/trigger.md)的判定模型提供者。经本机 HTTP 调用 laya-listener 侧车，由 Laya 模型判定一条入站消息要不要开口。

本包 `private: true`，只随仓库源码提供，不发布到 npm。从仓库源码运行时，工作区加载器按 `aalis-plugin` 关键词发现它并与其它插件一样默认启用；不用时在 WebUI 插件管理里停用，或写进配置文件的 `disabledPlugins`。

## 定位

- 只登记 `trigger` 提供者（标签「Laya 模型」，默认优先级 10），不挂钩子。作用域、禁言、禁言关键词、计数、开口后的类别（`immediate` / `interval`）与授权主体都由相位宿主 [plugin-trigger-policy](../../docs/plugins/plugin-trigger-policy.md) 处理。哪些会话会问到本提供者由宿主的 `scopes` / `overrides` 决定，本插件没有自己的作用域。
- 返回 `null` 即弃权，宿主转问排在后面的规则提供者（「规则（计数/评分）」，优先级 0）。`mode=off`、影子模式、会话不适用、memory 缺席、请求体超限、侧车失败或熔断时都弃权。
- 被 @、戳一戳、叫名字的消息同样交给模型判定：`live` 下判为不开口的会被吞掉并归档。宿主的 `triggerOnAt` / `triggerOnPoke` / `triggerNames` 此时只决定开口后的类别与授权主体。禁言关键词与带 `source` 的内部注入在宿主那一步处理，不经模型。

## 依赖

- 服务：`config`、`events`（监听 `inbound:message:archived` 做运行期自检）、`logger`、`provide`；`memory` 为 optional，缺席时弃权（没有历史窗口无从判定）。
- 侧车 laya-listener：本机 HTTP 服务，只监听 127.0.0.1，由 launchd 守护。构建、部署、换版本与回滚见本机 `models/listener-sidecar/README.md`（`models/` 在 `.gitignore` 里，不随仓库分发）。

## 判定流程

1. 按消息的作用域取生效配置（`overrides` 最具体者胜）；`mode=off` 弃权。
2. 只接受 onebot 的群聊与私聊：从会话 ID `onebot:{selfId}:{group|private}:{targetId}` 取 bot 自己的账号作为 `selfId`。其它平台与频道会话弃权。
3. memory 缺席或处于熔断期时弃权。
4. 取窗口：`memory.getFullHistory(sessionId, historyRows × 2)`（没有该方法时回落 `getHistory`），只留 `role` 为 `user` / `assistant` 且正文是字符串的行，取其中最后 `historyRows` 行，投影为 `{role, content, userId, nick}`：`userId` 取 `metadata.userId`，`nick` 取 `metadata.nickname`，缺失时回落 `name`。先过滤再取行，与侧车渲染回归（`replay_data.py`）的取法一致；最近 `historyRows × 2` 行里其它角色的行（tool、system、notice 等）多于 `historyRows` 条时，窗口不足 `historyRows` 行。
5. 调用宿主的 `awaitAttachmentDescriptions()` 等附件识别（上限为宿主的 `mediaWaitMs`），再用 `@aalis/schema-message` 的 `buildIncomingContent` 拼当前消息 `cur`。归档用的是同一个函数，两者不一致的情况见「已知局限」。
6. 请求体按 UTF-8 字节数超过侧车的上限 1 MiB 时不发请求，直接弃权、不计失败；否则记下 `cur` 的摘要供运行期自检（见「日志」），再 `POST {endpoint}/v1/score`，超时 `timeoutMs`（含读完响应体）。
7. `speak = logit ≥ 阈值`，阈值取配置的 `threshold`，留空时用侧车随响应返回的模型阈值。`shadow` 记一行影子判定日志后弃权；`live` 返回 `{ speak, reason: 'Laya <版本> 阈值=<阈值>', score: logit }`。

## 侧车接口

请求：`POST /v1/score`，`Content-Type: application/json`，请求体不超过 1 MiB

```json
{
  "rows": [{ "role": "user", "content": "...", "userId": "...", "nick": "..." }],
  "cur": "...",
  "curUserId": "...",
  "curNick": "...",
  "replyTo": { "userId": "...", "nickname": "..." },
  "selfId": "..."
}
```

`replyTo` 在消息不是引用回复时为 `null`。成功响应为 `200 {logit, threshold, version}`。

| 情形 | 处理 |
|---|---|
| 200 且 `logit` 与阈值都是有限数 | 判定；失败计数清零 |
| 422（`system_notice` / `empty_cur` / `bad_cur`：这条消息不适合交给模型）；413（`too_large`，发请求前已按上限判断，这里兜底） | 弃权，不计失败；侧车正常作答，失败计数清零 |
| 请求体超过 1 MiB（发请求前判断） | 不发请求，弃权，不计失败 |
| 其它非 2xx、连不上、超时、响应不是 JSON、`logit` 或阈值不是有限数 | 计一次失败并弃权 |

连续 3 次失败后熔断 30 秒，期间直接弃权、不发请求；熔断到期后照常请求（这时并发到达的请求都会发出），再失败一次即重新熔断。一次故障只记两条 warn：转入熔断时一条，侧车恢复正常作答时一条；故障期间的并发失败与到期后的重新熔断记 debug。侧车停掉或重启时，判定因此自动回落到规则提供者。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `mode` | select | `'shadow'` | `off`：弃权不判定；`shadow`：照常请求并记影子判定日志，然后弃权，由规则判定；`live`：由模型决定开不开口 |
| `threshold` | number | 留空 | 开口阈值，`logit ≥ 阈值` 即开口；留空用侧车返回的模型阈值（随模型版本给出） |
| `endpoint` | string | `'http://127.0.0.1:17878'` | 侧车地址 |
| `timeoutMs` | number | `1000` | 单次请求的超时（毫秒），超时计一次失败。宿主放弃超时的提供者后不会取消它的请求，这里应小于宿主的 `decisionTimeoutMs`（默认 2000） |
| `historyRows` | number | `80` | 窗口行数，只算 user / assistant 行：从 memory 取 `historyRows × 2` 行，过滤后留最后 `historyRows` 行，与侧车渲染回归的取法一致 |
| `priority` | number | `10` | 提供者优先级，越大越先问。规则提供者为 0 且不弃权，本提供者须排在它前面才会被问到 |
| `overrides` | array | `[]` | 分作用域覆盖：每项 `{scope, mode?, threshold?}`，`scope` 格式 `platform:sessionType[:targetId]`，支持 `*`；只取命中的最具体一条，条目之间不叠加，这一条留空的字段沿用顶层设置 |

## 日志

日志都不含消息正文与昵称。

- 影子判定（info，`mode=shadow` 时每条一行）：

  ```
  [laya] 影子判定 | session=<会话> | logit=<logit> | 阈值=<阈值> | 会开口=<true|false> | addressed=<true|false> | 耗时=<侧车往返 ms>ms | 版本=<模型版本>
  ```

- 宿主的判定日志（debug）：`live` 下由本提供者判定时为 `决定者=Laya 模型`，带 `reason` 与 `score`；弃权时出现在 `弃权=Laya 模型(弃权|超时|出错)` 里。
- 单次请求失败与请求体超限弃权（debug）；熔断与恢复（warn，一次故障各一条，其间的重新熔断记 debug）；判定异常（warn）。
- 运行期自检汇总（info，每结清 200 条记一行，计数自插件激活起累计）：

  ```
  [laya] 自检 | 一致=<n> | 不一致:缺附件描述=<n> | 不一致:含文件附件=<n> | 不一致:其它=<n> | 未归档=<n>
  ```

  向侧车发请求前，按「会话 ID + 消息 ID」记下这次 `cur` 的哈希与长度（不存原文）；这条消息归档（`inbound:message:archived`）后与归档正文比对，并从表中取出，即结清一条。训练数据与窗口里的历史行都取自归档正文，这一行反映的是模型在线上看到的当前消息与训练口径是否逐字相同。没有消息 ID 的消息、没经本提供者判定的消息，以及没有向侧车发请求的判定（`off`、在此之前弃权、请求体超限）都不记，归档时也不计。
  - `一致`：逐字相同。
  - `不一致:缺附件描述`：判定时有图片、语音或视频附件还没有描述（识别超过宿主的 `mediaWaitMs`，或宿主已放弃本次判定），归档时补上了。对应「已知局限」的「识别超时时 `cur` 缺附件描述」。
  - `不一致:含文件附件`：消息带文件附件，文件描述在 agent 预处理阶段才写入。对应「已知局限」的「文件描述不进 `cur`」。与上一项同时成立时计入上一项。
  - `不一致:其它`：不属于上面两项的偏差，如 agent 预处理器或 `agent:input:before` 中间件改写了正文、发送者昵称等拼进 `cur` 的字段。
  - `未归档`：表最多 1000 条，超出时按记下的先后淘汰最早的一条，淘汰时仍未归档的计入此项（如 plugin-message-archive 未启用或归档失败）。条目要等被淘汰才计入，这一项比实际滞后约 1000 次判定。

## 从影子期到 live

1. 启用本插件（默认 `shadow`），确认侧车在跑：`curl http://127.0.0.1:17878/health`。
2. 影子期：各群保持 `shadow` 若干天，开口仍由规则判定。只看影子判定行（info 级，带 `addressed` 与 `会开口`）即可：逐条看「被点名但模型会吞」（`addressed=true` 且 `会开口=false`），抽看「没点名但模型会开口」，据此定阈值（顶层 `threshold`，或按作用域覆盖）。另外用自检汇总行判断线上输入是否偏离训练口径：`不一致:其它` 应接近 0，持续出现说明有未知的改写，查清之前不上 `live`；`不一致:缺附件描述` 占结清总数的比例偏高时，考虑调大宿主的 `mediaWaitMs`（带附件消息的判定耗时随之变长）；`不一致:含文件附件` 是已知缺口，它占结清总数的比例就是受影响的判定比例；`未归档` 持续增长时先确认 plugin-message-archive 已启用。
3. 单群 `live`：`overrides` 加一条 `{scope: 'onebot:group:<群号>', mode: 'live'}`。
4. 逐步扩群，最后把顶层 `mode` 改为 `live`。

私聊：模型只用群聊数据训练，私聊属分布外。私聊会话要先落在宿主的作用域里才会问到本提供者；纳入后先保持 `shadow`（顶层改 `live` 时加一条 `{scope: '*:private', mode: 'shadow'}`）。要给某个私聊单设阈值，在同一条里把 `mode` 一并写上，如 `{scope: 'onebot:private:<QQ号>', mode: 'shadow', threshold: <阈值>}`：覆盖条目之间不叠加，一条消息只取命中的最具体那一条，这条里没写的字段落回顶层，不落回较宽的 `*:private`。只写 `threshold` 的话，这个私聊的 `mode` 会落回顶层的 `live`。

## 回滚

- **切回规则判定（即时）**：WebUI 服务页把 `trigger` 的偏好切到「规则（计数/评分）」。规则提供者排到最前、不弃权，本提供者不再被问到。
- **按作用域关掉**：把该作用域的 `mode` 改回 `off`（或 `shadow`），整体关掉则改顶层 `mode`。保存后插件按新配置重新激活。
- 手改 `aalis.config.yaml` 的 `servicePreferences` 只在启动时读取，需重启才生效。

## 已知局限

- **文件描述不进 `cur`**：文件附件的描述由 plugin-file-reader 在 agent 预处理阶段才写入，判定时还没有，放行的带文件消息归档里有文件描述而 `cur` 里没有。自检汇总计入 `不一致:含文件附件`。
- **识别超时时 `cur` 缺附件描述**：附件识别超过宿主的 `mediaWaitMs` 时照常判定，`cur` 里缺这些描述，归档时补上。自检汇总计入 `不一致:缺附件描述`。
- **影子期同样等附件识别**：`shadow` 与 `live` 走同一段判定，带附件的消息要等识别（至多 `mediaWaitMs`）和侧车往返之后，规则才接着判定。放行后 agent 预处理器与归档复用这次识别，不再识别第二遍。
- **带附件的消息可能晚于同会话后到的消息**：等识别的那段（至多 `mediaWaitMs`）在判定之内，这期间同一会话后到、不用等识别的消息可能先判定、先抵达 agent。
- **超大窗口弃权**：请求体超过侧车的 1 MiB 上限时弃权，回落规则判定。plugin-file-reader 默认把 10 万字以内的文件全文写进附件描述并随消息归档，窗口里有几条这样的消息就可能超限，直到它们滚出窗口。插件不截断行也不丢行：侧车的发言人编号与截断都基于完整窗口，客户端改窗口会偏离训练口径。未超限的大行也会拉长侧车的渲染耗时。
- **突发会触发熔断**：侧车单线程串行处理请求。一时涌入的请求排队超过 `timeoutMs` 时，超时的请求计为失败，连续 3 次即熔断 30 秒，这期间所有会话回落规则判定，影子期则缺这段日志。这是设计内的降级。客户端超时放弃的请求，侧车仍会逐个算完。
