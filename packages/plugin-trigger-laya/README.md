# @aalis/plugin-trigger-laya

Laya 触发判定：一个自成一体的[触发插件](../../docs/services/trigger.md)。经本机 HTTP 调用 laya-listener 侧车，由 Laya 模型判定一条入站消息要不要开口。

本包 `private: true`，只随仓库源码提供，不发布到 npm。从仓库源码运行时，工作区加载器按 `aalis-plugin` 关键词发现它并与其它插件一样默认启用；它的优先级高于 trigger-policy，启用即生效，本机没有侧车时判定不可用，群里只回点名（见「兜底与故障观测」）。不用时在 WebUI 插件管理里停用，或写进配置文件的 `disabledPlugins`，由 trigger-policy 接手。

## 定位

- 向 `trigger` 服务提供自己的实例（标签「Laya 模型」，默认优先级 10），并在 `inbound:trigger` 相位挂中间件。与规则触发插件 [plugin-trigger-policy](../../docs/plugins/plugin-trigger-policy.md)（优先级 0）二选一：`trigger` 服务的胜者生效，两个都启用时本插件生效，trigger-policy 对每条消息直接放行，计数与闲置都停下。本插件不是胜者时同样什么都不做。
- 没有计数：作用域内的每条消息都交给模型判定，`logit ≥ 阈值` 即开口。
- **@、叫名字、戳一戳不强制开口**：开不开口由模型决定。点名只决定开口后的类别（点名为 `immediate`，点名者即授权主体；否则为 `interval`，群聊回填无主体授权），以及判定不了时的兜底。
- 模型判定不了时兜底：**只回点名**，其余消息吞掉并归档。不回退到 trigger-policy：本插件出问题不牵连它，它也不替本插件判定。

## 依赖

- 服务：`config`、`events`（监听 `inbound:message:archived` 做运行期自检）、`hooks`、`logger`、`provide`；optional：`trigger`（判断自己是否生效）、`memory`（历史窗口，缺席时判定不可用）、`flow-control`（禁言）、`persona`（名字检测）、`message-archive`（吞掉时归档）、`media`（附件识别）、`doctor`（诊断项）。
- 侧车 laya-listener：本机 HTTP 服务，只监听 127.0.0.1，由 launchd 守护。构建、部署、换版本与回滚见本机 `models/listener-sidecar/README.md`（`models/` 在 `.gitignore` 里，不随仓库分发）。

## 判定流程

1. 本插件不是生效的触发插件 → 放行，什么都不做（不请求、不识别、不归档）。
2. 带 `source` 的内部注入（闲置触发、定时任务、workflow、跨会话委派）→ 放行，不改 `triggerType`。
3. 不在作用域（`scopes` / `overrides`，默认 `*:group`）→ 放行，不写 `triggerType`，由后面的 flow 与 agent 照常处理。私聊默认不在作用域内。
4. 会话处于禁言期 → 放行给 flow 相位吞掉；不识别禁言关键词。
5. 命中禁言关键词（`muteKeywords`；戳一戳的合成文案不算）→ 设自禁言 `muteTimeSeconds` 秒、归档后吞掉，不问模型。
6. 识别点名：戳一戳按 `triggerOnPoke`；其余消息按 `triggerOnAt`（@ 自己）与名字检测（`triggerNames` 与人设名字、昵称）。识别抛错（persona 故障）时放行、不写 `triggerType`。
7. 判定前检查：只接受 onebot 的群聊与私聊（从会话 ID `onebot:{selfId}:{group|private}:{targetId}` 取 bot 自己的账号作为 `selfId`），其它会话兜底；memory 缺席或侧车处于熔断期时兜底。
8. 取窗口：`memory.getFullHistory(sessionId, historyRows × 2)`（没有该方法时回落 `getHistory`），只留 `role` 为 `user` / `assistant` 且正文是字符串的行，取其中最后 `historyRows` 行，投影为 `{role, content, userId, nick}`：`userId` 取 `metadata.userId`，`nick` 取 `metadata.nickname`，缺失时回落 `name`。先过滤再取行，与侧车渲染回归（`replay_data.py`）的取法一致；最近 `historyRows × 2` 行里其它角色的行（tool、system、notice 等）多于 `historyRows` 条时，窗口不足 `historyRows` 行。
9. 带附件、尚无描述时启动附件识别并最多等 `mediaWaitMs`，再用 `@aalis/schema-message` 的 `buildIncomingContent` 拼当前消息 `cur`。归档用的是同一个函数，两者不一致的情况见「已知局限」。放行与吞掉都不等识别跑完，agent 预处理器与归档复用这次识别，不再识别第二遍。
10. 请求体按 UTF-8 字节数超过侧车的上限 1 MiB 时不发请求，本条兜底；否则记下 `cur` 的摘要供运行期自检（见「日志」），再 `POST {endpoint}/v1/score`，超时 `timeoutMs`（含读完响应体）。
11. `speak = logit ≥ 阈值`，阈值取作用域生效的 `threshold`，留空时用侧车随响应返回的模型阈值。开口则写 `triggerType` 放行；不开口则归档后吞掉。

兜底即 `speak = 是否被点名`：点名的消息记 `immediate` 放行，其余归档后吞掉。第 7 步就兜底的不等附件识别。

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

`replyTo` 在消息不是引用回复时为 `null`。成功响应为 `200 {logit, threshold, version}`。诊断项另用 `GET /health`（`{ok, version}`）探活。

| 情形 | 处理 |
|---|---|
| 200 且 `logit` 与阈值都是有限数 | 按模型判定；失败计数清零 |
| 422（`system_notice` / `empty_cur` / `bad_cur`：这条消息不适合交给模型）；413（`too_large`，发请求前已按上限判断，这里兜底） | 本条兜底，不计失败；侧车正常作答，失败计数清零 |
| 请求体超过 1 MiB（发请求前判断） | 不发请求，本条兜底，不计失败，记一条 info |
| 其它非 2xx、连不上、超时、响应不是 JSON、`logit` 或阈值不是有限数 | 本条兜底，计一次失败 |

422、413 与请求体超限是"这条消息不适合交给模型"，不是侧车故障，所以只让这一条走兜底，不计入熔断。不改为放行给 agent：请求体超限要等窗口里的大行滚出窗口才恢复，期间同一会话的每条消息都会命中，放行就等于这段时间逐条回复。

## 兜底与故障观测

连续 3 次失败后熔断 30 秒，期间不发请求，直接兜底；熔断到期后照常请求（这时并发到达的请求都会发出），再失败一次即重新熔断。熔断与 memory 缺席都算**判定不可用**：

- 由可用转为不可用时记一条 **error**：`[laya] 判定不可用（<原因>），已转为只回点名：@、叫名字、戳一戳照常回复，其余消息吞掉并归档`。一次故障只记这一条，其间的并发失败与重新熔断记 debug。
- 侧车重新正常作答时记一条 **warn**：`[laya] 判定恢复（不可用 <秒>s，最后原因: <原因>）`。
- 诊断项 `trigger.laya`（WebUI 的诊断页、`/doctor` 命令）：运行时探一次 `GET /health`（超时同 `timeoutMs`），并报 memory 是否在场、当前是否处于判定不可用、本插件是否生效。都正常为 ok；有问题时，本插件生效报 error（群里只回点名），不生效报 warn（不影响回复），并点名当前生效的触发插件。

侧车停掉或重启时，群里的表现是只有点名的消息得到回复，直到侧车恢复。要改由规则判定，按「切换与回滚」手动切到 trigger-policy。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `scopes` | multiselect | `["*:group"]` | 作用域，格式 `platform:sessionType[:targetId]`，支持 `*`。作用域外的消息直接放行，由 flow 与 agent 照常处理。私聊默认不在内（模型只用群聊训练） |
| `threshold` | number | 留空 | 开口阈值，`logit ≥ 阈值` 即开口；留空用侧车返回的模型阈值（随模型版本给出） |
| `triggerOnAt` | boolean | `true` | @ 自己算点名 |
| `triggerOnPoke` | boolean | `true` | 戳一戳算点名 |
| `triggerNames` | string | `''` | 点名别名（逗号分隔），人设名字与昵称自动合并 |
| `muteKeywords` | string | `''` | 禁言关键词（逗号分隔） |
| `muteTimeSeconds` | number | `60` | 禁言关键词命中时长（秒） |
| `mediaWaitMs` | number | `8000` | 带附件的消息等识别写好描述的上限（毫秒），超时照常判定 |
| `endpoint` | string | `'http://127.0.0.1:17878'` | 侧车地址 |
| `timeoutMs` | number | `1000` | 单次请求的超时（毫秒），含读完响应体；超时计一次失败。诊断项探活用同一个超时 |
| `historyRows` | number | `80` | 窗口行数，只算 user / assistant 行：从 memory 取 `historyRows × 2` 行，过滤后留最后 `historyRows` 行，与侧车渲染回归的取法一致 |
| `priority` | number | `10` | 在 `trigger` 服务里的优先级；trigger-policy 为 0，配到 0 以下则由它生效 |
| `overrides` | array | `[]` | 分作用域覆盖阈值：每项 `{scope, threshold}`，`scope` 格式同上；只取命中的最具体一条，留空沿用顶层。写一条覆盖即启用该作用域 |

点名与禁言关键词的字段只看顶层，不按作用域覆盖。

## 日志

日志都不含消息正文与昵称。

- 判定（debug，每次判定一行）：

  ```
  [laya] 判定 | session=<会话> | speak=<true|false> | addressed=<true|false> | logit=<logit> | 阈值=<阈值> | 版本=<模型版本> | 耗时=<n>ms
  [laya] 判定 | session=<会话> | speak=<true|false> | addressed=<true|false> | 兜底=<原因> | 耗时=<n>ms
  ```

  耗时是整次判定：取历史、等附件识别与侧车往返。兜底原因：`会话不适用`、`memory 缺席`、`侧车熔断中`、`请求体超限`、`侧车请求失败`、`侧车 422 <错误码>` / `侧车 413 <错误码>`、`判定异常`。
- 判定不可用（error）与恢复（warn），见「兜底与故障观测」。
- 请求体超限（info，每条一行）；单次请求失败、熔断期间的重新熔断（debug）；取历史等意外异常（warn，本条兜底）；点名识别异常（warn，放行）。
- 运行期自检汇总（info，每结清 200 条记一行，计数自插件激活起累计）：

  ```
  [laya] 自检 | 一致=<n> | 不一致:缺附件描述=<n> | 不一致:含文件附件=<n> | 不一致:其它=<n> | 未归档=<n>
  ```

  向侧车发请求前，按「会话 ID + 消息 ID」记下这次 `cur` 的哈希与长度（不存原文）；这条消息归档（`inbound:message:archived`）后与归档正文比对，并从表中取出，即结清一条。训练数据与窗口里的历史行都取自归档正文，这一行反映的是模型在线上看到的当前消息与训练口径是否逐字相同。没有消息 ID 的消息，以及没有向侧车发请求的判定（请求前就兜底的、请求体超限的）都不记，归档时也不计。
  - `一致`：逐字相同。
  - `不一致:缺附件描述`：判定时有非文件附件（图片、语音、视频等）缺描述（识别超过 `mediaWaitMs` 或识别失败），且两边不一致。不核对归档时是否补上了描述：某类附件始终没有描述时（如没配对应的识别模型），这类消息的其它偏差也计入此项。对应「已知局限」的「识别超时时 `cur` 缺附件描述」。
  - `不一致:含文件附件`：消息带文件附件，文件描述在 agent 预处理阶段才写入。对应「已知局限」的「文件描述不进 `cur`」。与上一项同时成立时计入上一项。
  - `不一致:其它`：不属于上面两项的偏差，如 agent 预处理器或 `agent:input:before` 中间件改写了正文、发送者昵称等拼进 `cur` 的字段。
  - `未归档`：表最多 1000 条，超出时按记下的先后淘汰最早的一条，淘汰时仍未归档的计入此项（如 plugin-message-archive 未启用或归档失败）。条目要等被淘汰才计入，这一项比实际滞后约 1000 次判定。

## 调阈值

1. 确认侧车在跑：`curl http://127.0.0.1:17878/health`，或看诊断项 `trigger.laya`。
2. 把日志级别开到 debug，看判定行：逐条看「被点名但模型没开口」（`addressed=true` 且 `speak=false`），抽看「没点名但模型开口」，据此调阈值（顶层 `threshold`，或按作用域覆盖）。阈值越低开口越多；agent 自己可以选择不回复，频率上限另由 flow-control 的冷却与限速兜底。
3. 用自检汇总行判断线上输入是否偏离训练口径：`不一致:其它` 应接近 0，持续出现说明有未知的改写；`不一致:缺附件描述` 占结清总数的比例偏高时，考虑调大 `mediaWaitMs`（带附件消息的判定耗时随之变长）；`不一致:含文件附件` 是已知缺口，它占结清总数的比例就是受影响的判定比例；`未归档` 持续增长时先确认 plugin-message-archive 已启用。

私聊：模型只用群聊数据训练，私聊属分布外，默认不在作用域内（私聊消息放行，由 agent 照常处理）。要让某个私聊走模型，在 `scopes` 里加它（如 `onebot:private:<QQ号>`），或加一条带阈值的覆盖 `{scope: 'onebot:private:<QQ号>', threshold: <阈值>}`：覆盖条目之间不叠加，一条消息只取命中的最具体那一条。

## 切换与回滚

- **切到规则判定（即时）**：WebUI 服务页把 `trigger` 的偏好切到「规则（计数/评分）」，下一条消息起由 trigger-policy 判定，本插件什么都不做。切回同理。
- **停用本插件**：WebUI 插件管理里停用，trigger-policy 在下一条消息接手。
- **让某些会话不走模型**：把它们移出 `scopes`（作用域是白名单，要排除单个群就改为列出其余的群）。移出后这些消息直接放行、不经任何触发判定；要按规则判定，只能整体切到 trigger-policy。
- 手改 `aalis.config.yaml` 的 `servicePreferences` 只在启动时读取，需重启才生效。

## 已知局限

- **文件描述不进 `cur`**：文件附件的描述由 plugin-file-reader 在 agent 预处理阶段才写入，判定时还没有，放行的带文件消息归档里有文件描述而 `cur` 里没有。自检汇总计入 `不一致:含文件附件`。
- **识别超时时 `cur` 缺附件描述**：附件识别超过 `mediaWaitMs` 时照常判定，`cur` 里缺这些描述，归档时补上。自检汇总计入 `不一致:缺附件描述`。
- **带附件的消息可能晚于同会话后到的消息**：等识别的那段（至多 `mediaWaitMs`）在判定之内，这期间同一会话后到、不用等识别的消息可能先判定、先抵达 agent。
- **超大窗口时只回点名**：请求体超过侧车的 1 MiB 上限时本条兜底。plugin-file-reader 默认把 10 万字以内的文件全文写进附件描述并随消息归档，窗口里有几条这样的消息就可能超限，直到它们滚出窗口。插件不截断行也不丢行：侧车的发言人编号与截断都基于完整窗口，客户端改窗口会偏离训练口径。未超限的大行也会拉长侧车的渲染耗时。
- **突发会触发熔断**：侧车单线程串行处理请求。一时涌入的请求排队超过 `timeoutMs` 时，超时的请求计为失败，连续 3 次即熔断 30 秒，这期间所有作用域内的会话只回点名。这是设计内的降级。客户端超时放弃的请求，侧车仍会逐个算完。
